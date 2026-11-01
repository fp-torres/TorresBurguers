import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User, UserRole } from '../../users/entities/user.entity';
import { emailEquals, normalizeEmail } from '../../users/email';
import { DEFAULT_USERS, type DefaultUser } from './default-users';

/** Usuários padrão que o seed trata nesta execução (o superadmin de demonstração só se permitido). */
export function defaultUsersFor(includeSuperadmin: boolean): DefaultUser[] {
  return DEFAULT_USERS.filter((u) => includeSuperadmin || !u.platformRole);
}

/**
 * Garante que os usuários padrão existam.
 * - resetPasswords=false (subida da API): só cria os que faltam, nunca altera contas existentes.
 * - resetPasswords=true (npm run seed): também restaura da lixeira e redefine nome, perfil, loja,
 *   papel global e senha.
 * - includeSuperadmin=false: o superadmin de demonstração (senha pública, papel global) não é criado
 *   nem redefinido — só com opção explícita (config/env.ts → demoSuperadminSeedAllowed).
 * A equipe é criada na loja informada (storeId); cliente e superadmin ficam sem loja.
 * A busca ignora maiúsculas/minúsculas e inclui contas na lixeira, como no cadastro.
 */
export async function seedDefaultUsers(
  repo: Repository<User>,
  {
    resetPasswords,
    storeId,
    includeSuperadmin,
  }: { resetPasswords: boolean; storeId: number; includeSuperadmin: boolean },
): Promise<string[]> {
  const report: string[] = [];

  for (const u of defaultUsersFor(includeSuperadmin)) {
    const email = normalizeEmail(u.email);
    const isStaff = u.role !== UserRole.CLIENT;
    const existing = await repo.findOne({
      where: { email: emailEquals(email) },
      withDeleted: true,
      order: { id: 'ASC' },
    });

    if (!existing) {
      const password_hash = await bcrypt.hash(u.password, 10);
      await repo.save(
        repo.create({
          name: u.name,
          email,
          phone: u.phone,
          role: u.role,
          store_id: isStaff ? storeId : null,
          platform_role: u.platformRole ?? null,
          password_hash,
          // Contas de demonstração (e-mails fictícios do código) nascem com o e-mail confirmado
          email_verified_at: new Date(),
        }),
      );
      report.push(`criado: ${email} (${u.platformRole ?? u.role})`);
      continue;
    }

    if (resetPasswords) {
      const password_hash = await bcrypt.hash(u.password, 10);
      if (existing.deleted_at) await repo.restore(existing.id);
      await repo.update(existing.id, {
        name: u.name,
        role: u.role,
        // Equipe continua na loja em que já estava (ou vai para a loja padrão); cliente fica sem loja
        store_id: isStaff ? (existing.store_id ?? storeId) : null,
        platform_role: u.platformRole ?? null,
        blocked_at: null,
        blocked_reason: null,
        token_version: () => '"token_version" + 1',
        password_hash,
        email_verified_at: () => 'COALESCE("email_verified_at", now())',
      });
      report.push(`redefinido: ${email} (${u.platformRole ?? u.role})`);
    }
  }

  return report;
}

/**
 * Contas que ainda têm o papel global de demonstração com a SENHA PÚBLICA do código (ex.: criadas por
 * uma versão anterior, que fazia isso em development). A subida avisa no log: troque a senha ou tire o
 * papel (npm run platform:superadmin -- --email=<e-mail> --revoke).
 */
export async function demoSuperadminsWithPublicPassword(
  repo: Repository<User>,
): Promise<string[]> {
  const found: string[] = [];
  for (const u of DEFAULT_USERS.filter((item) => item.platformRole)) {
    const email = normalizeEmail(u.email);
    const existing = await repo.findOne({
      where: { email: emailEquals(email) },
      select: {
        id: true,
        email: true,
        platform_role: true,
        password_hash: true,
      },
    });
    if (!existing || existing.platform_role !== u.platformRole) continue;
    if (
      existing.password_hash &&
      (await bcrypt.compare(u.password, existing.password_hash))
    ) {
      found.push(email);
    }
  }
  return found;
}
