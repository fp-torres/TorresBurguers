import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import type { DataSource, EntityManager } from 'typeorm';
import { AuditLog } from '../../audit/entities/audit-log.entity';
import { PlatformRole, User, UserRole } from '../../users/entities/user.entity';
import { emailEquals, normalizeEmail } from '../../users/email';

/**
 * Lógica do comando platform:superadmin (cli/superadmin.ts), separada para teste.
 *
 * - Conta inexistente: criada com senha forte aleatória (exibida UMA vez) ou a de SUPERADMIN_PASSWORD.
 * - Conta de cliente já existente: só com --promote-existing. O cadastro de clientes é público, então
 *   qualquer pessoa pode "plantar" antes a conta do e-mail que a operação vai promover; por isso a
 *   promoção mostra os dados da conta, TROCA a senha (a plantada deixa de valer), encerra as sessões
 *   abertas (token_version + 1) e invalida os links de redefinição pendentes.
 * - Superadmin existente: nada muda; com --reset-password, nova senha + sessões encerradas (recuperação
 *   de acesso no servidor, no lugar do antigo "npm run seed -- --force").
 * - Conta da equipe de uma loja nunca vira superadmin (papéis separados): use outro e-mail.
 * - --revoke: remove o papel e encerra as sessões.
 * Toda concessão/revogação/troca fica na auditoria (escopo SYSTEM).
 */
export interface SuperadminCommandOptions {
  email?: string;
  name?: string;
  revoke?: boolean;
  promoteExisting?: boolean;
  resetPassword?: boolean;
  /** SUPERADMIN_PASSWORD (senha escolhida pela operação, no lugar da aleatória). */
  password?: string;
}

export interface CommandOutput {
  log(message: string): void;
  error(message: string): void;
}

type Db = Pick<DataSource, 'getRepository' | 'query' | 'transaction'>;

export const USAGE =
  'Informe o e-mail: npm run platform:superadmin -- --email=ops@empresa.com [--name="Nome"] [--promote-existing] [--reset-password] [--revoke]';

export const WEAK_PASSWORD_MESSAGE =
  'SUPERADMIN_PASSWORD fraca: use pelo menos 12 caracteres com maiúscula, minúscula e número ou símbolo.';

/** 18 caracteres com maiúscula, minúscula, número e símbolo garantidos. */
export function strongPassword(): string {
  const base = randomBytes(12).toString('base64url');
  return `Aa1!${base}`;
}

export function validPassword(password: string): boolean {
  return (
    password.length >= 12 &&
    Buffer.byteLength(password, 'utf8') <= 72 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /(\d|\W)/.test(password)
  );
}

/** Caractere de controle (C0, DEL ou C1): começo das sequências de escape do terminal. */
function isControlCharacter(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** Texto vindo do banco (nome escolhido no cadastro público) sem caracteres de controle do terminal. */
function printable(value: string | null | undefined, max = 80): string {
  return Array.from(value ?? '', (char) =>
    isControlCharacter(char) ? ' ' : char,
  )
    .join('')
    .slice(0, max);
}

function when(value: Date | string | null | undefined): string {
  if (!value) return 'nunca';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 'desconhecido' : date.toISOString();
}

/** Nova credencial: senha nova, sessões encerradas e links de redefinição pendentes invalidados. */
async function rotateCredential(
  manager: EntityManager,
  userId: number,
  password: string,
  changes: Partial<Pick<User, 'platform_role'>> = {},
): Promise<void> {
  await manager.getRepository(User).update(userId, {
    ...changes,
    password_hash: await bcrypt.hash(password, 10),
    token_version: () => '"token_version" + 1',
  });
  await manager.query(
    `UPDATE "password_reset_tokens" SET "used_at" = now() WHERE "user_id" = $1 AND "used_at" IS NULL`,
    [userId],
  );
}

export async function runSuperadminCommand(
  db: Db,
  options: SuperadminCommandOptions,
  out: CommandOutput,
): Promise<number> {
  const rawEmail = options.email?.trim();
  if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
    out.error(USAGE);
    return 1;
  }
  const email = normalizeEmail(rawEmail);
  const users = db.getRepository(User);
  const existing = await users.findOne({
    where: { email: emailEquals(email) },
    withDeleted: true,
  });

  if (options.revoke) {
    if (!existing || existing.platform_role !== PlatformRole.SUPER_ADMIN) {
      out.log(`Nada a fazer: ${email} não é superadmin.`);
      return 0;
    }
    await db.transaction(async (manager) => {
      await manager.getRepository(User).update(existing.id, {
        platform_role: null,
        token_version: () => '"token_version" + 1',
      });
      await manager.getRepository(AuditLog).insert({
        actor_scope: 'SYSTEM',
        action: 'platform.superadmin.revoke',
        target_type: 'user',
        target_id: String(existing.id),
        result: 'SUCCESS',
        metadata: { email, via: 'cli' },
      });
    });
    out.log(
      `✔ Papel de superadmin removido de ${email}. As sessões abertas dessa conta foram encerradas.`,
    );
    return 0;
  }

  const provided = options.password?.trim() || undefined;
  if (provided && !validPassword(provided)) {
    out.error(WEAK_PASSWORD_MESSAGE);
    return 1;
  }
  const password = provided ?? strongPassword();
  const showPassword = () => {
    if (!provided) {
      out.log(
        `  Senha inicial (exibida só agora; troque no primeiro acesso): ${password}`,
      );
    }
  };

  if (existing) {
    if (existing.deleted_at || existing.blocked_at) {
      out.error(
        `A conta ${email} está na lixeira ou bloqueada. Restaure/desbloqueie antes de promovê-la.`,
      );
      return 1;
    }
    if (existing.role !== UserRole.CLIENT || existing.store_id !== null) {
      out.error(
        `A conta ${email} pertence à equipe de uma loja. Use outro e-mail para o superadmin (papéis da plataforma e da loja são separados).`,
      );
      return 1;
    }

    if (existing.platform_role === PlatformRole.SUPER_ADMIN) {
      if (!options.resetPassword) {
        out.log(
          `${email} já é superadmin. Para trocar a senha e encerrar as sessões: --reset-password`,
        );
        return 0;
      }
      await db.transaction(async (manager) => {
        await rotateCredential(manager, existing.id, password);
        await manager.getRepository(AuditLog).insert({
          actor_scope: 'SYSTEM',
          action: 'platform.superadmin.reset_password',
          target_type: 'user',
          target_id: String(existing.id),
          result: 'SUCCESS',
          metadata: { email, via: 'cli' },
        });
      });
      out.log(
        `✔ Senha do superadmin ${email} trocada. As sessões abertas dessa conta foram encerradas.`,
      );
      showPassword();
      return 0;
    }

    // Cliente existente: pode ter sido criado por qualquer pessoa (cadastro público)
    const [{ orders }] = await db.query<{ orders: number }[]>(
      `SELECT COUNT(*)::int AS "orders" FROM "orders" WHERE "user_id" = $1`,
      [existing.id],
    );
    const details = [
      `Conta #${existing.id} (${email})`,
      `  nome: ${printable(existing.name)}`,
      `  criada em: ${when(existing.created_at)}`,
      `  último acesso: ${when(existing.last_login_at)}`,
      `  pedidos: ${Number(orders) || 0}`,
    ];
    if (!options.promoteExisting) {
      out.error(
        [
          `Já existe uma conta de cliente com o e-mail ${email}:`,
          ...details,
          'O cadastro de clientes é público: essa conta pode ter sido criada por outra pessoa para tomar o papel de superadmin.',
          'Confira os dados acima. Para promovê-la mesmo assim, rode de novo com --promote-existing: a senha atual',
          'deixa de valer (uma nova é gerada), as sessões abertas são encerradas e os links de redefinição pendentes',
          'são invalidados. Na dúvida, use um e-mail que ainda não tenha conta.',
        ].join('\n'),
      );
      return 1;
    }

    await db.transaction(async (manager) => {
      await rotateCredential(manager, existing.id, password, {
        platform_role: PlatformRole.SUPER_ADMIN,
      });
      await manager.getRepository(AuditLog).insert({
        actor_scope: 'SYSTEM',
        action: 'platform.superadmin.grant',
        target_type: 'user',
        target_id: String(existing.id),
        result: 'SUCCESS',
        metadata: {
          email,
          via: 'cli',
          created: false,
          credential_reset: true,
          account_created_at: when(existing.created_at),
          last_login_at: when(existing.last_login_at),
          orders: Number(orders) || 0,
        },
      });
    });
    out.log(details.join('\n'));
    out.log(
      `✔ ${email} agora é superadmin. A senha anterior deixou de valer e as sessões abertas foram encerradas.`,
    );
    showPassword();
    return 0;
  }

  const name =
    printable(options.name || 'Superadmin', 50).trim() || 'Superadmin';
  const created = await db.transaction(async (manager) => {
    const repo = manager.getRepository(User);
    const user = await repo.save(
      repo.create({
        name,
        email,
        role: UserRole.CLIENT,
        store_id: null,
        platform_role: PlatformRole.SUPER_ADMIN,
        password_hash: await bcrypt.hash(password, 10),
        // Conta criada pela operação no servidor (raiz de confiança): nasce com o e-mail confirmado.
        // A promoção de uma conta existente (--promote-existing) mantém a situação que ela já tinha
        email_verified_at: new Date(),
      }),
    );
    await manager.getRepository(AuditLog).insert({
      actor_scope: 'SYSTEM',
      action: 'platform.superadmin.grant',
      target_type: 'user',
      target_id: String(user.id),
      result: 'SUCCESS',
      metadata: { email, via: 'cli', created: true },
    });
    return user;
  });
  out.log(`✔ Superadmin criado: ${email} (conta #${created.id})`);
  showPassword();
  return 0;
}
