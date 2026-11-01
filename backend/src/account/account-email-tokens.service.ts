import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  type EntityManager,
  In,
  IsNull,
  MoreThan,
  Not,
  Repository,
} from 'typeorm';
import { isLinkToken } from '../auth/link-token';
import { randomToken, sha256Hex } from '../common/crypto/secret-box';
import { normalizeEmail } from '../users/email';
import {
  EMAIL_CHANGE_TTL_HOURS,
  EMAIL_REVERT_TTL_DAYS,
  EMAIL_VERIFICATION_TTL_HOURS,
  hoursFrom,
} from './account-email-links';
import {
  AccountEmailToken,
  AccountEmailTokenPurpose,
} from './entities/account-email-token.entity';

/** Validade de cada tipo de link, em horas. */
export const ACCOUNT_EMAIL_TOKEN_TTL_HOURS: Record<
  AccountEmailTokenPurpose,
  number
> = {
  [AccountEmailTokenPurpose.VERIFY]: EMAIL_VERIFICATION_TTL_HOURS,
  [AccountEmailTokenPurpose.CHANGE]: EMAIL_CHANGE_TTL_HOURS,
  [AccountEmailTokenPurpose.REVERT]: EMAIL_REVERT_TTL_DAYS * 24,
};

/** Linhas mortas (vencidas, usadas ou canceladas) ficam 1 dia no banco antes da limpeza oportunista. */
const DEAD_ROW_GRACE_MS = 24 * 60 * 60_000;
/**
 * Limpeza global (todas as contas) das linhas mortas: no máximo uma por hora por instância, em lotes,
 * disparada por uma emissão e sem esperá-la (contas que nunca mais pedem link também são limpas).
 */
const GLOBAL_PURGE_INTERVAL_MS = 60 * 60_000;
const GLOBAL_PURGE_BATCH = 1000;

export interface IssueAccountEmailToken {
  userId: number;
  purpose: AccountEmailTokenPurpose;
  /** Endereço que recebe o link (normalizado aqui). */
  email: string;
  /** CHANGE: e-mail da conta no pedido; REVERT: o e-mail que substituiu o antigo. VERIFY: nenhum. */
  previousEmail?: string | null;
  ip?: string | null;
  now?: Date;
}

/**
 * Cancela os links em aberto da conta (todos os propósitos informados). Função solta para quem já
 * está numa transação e não depende do módulo da conta (ex.: redefinição de senha).
 */
export async function revokeOpenAccountEmailTokens(
  manager: EntityManager,
  userId: number,
  purposes: readonly AccountEmailTokenPurpose[],
  now: Date = new Date(),
): Promise<number> {
  if (!purposes.length) return 0;
  const result = await manager.getRepository(AccountEmailToken).update(
    {
      user_id: userId,
      purpose: In([...purposes]),
      used_at: IsNull(),
      revoked_at: IsNull(),
    },
    { revoked_at: now },
  );
  return result.affected ?? 0;
}

/**
 * Links de uso único das ações de e-mail da conta. O código sai do randomToken (32 bytes, base64url) e
 * só existe no link; o banco guarda o SHA-256. Códigos fora do formato nem chegam ao banco
 * (isLinkToken). Nunca usa o JwtService: um link não é uma sessão.
 */
@Injectable()
export class AccountEmailTokensService {
  private readonly logger = new Logger(AccountEmailTokensService.name);
  private lastGlobalPurge = Number.NEGATIVE_INFINITY;

  constructor(
    @InjectRepository(AccountEmailToken)
    private readonly tokens: Repository<AccountEmailToken>,
  ) {}

  private repo(manager?: EntityManager): Repository<AccountEmailToken> {
    return manager ? manager.getRepository(AccountEmailToken) : this.tokens;
  }

  /**
   * Cria um link novo. VERIFY e CHANGE: só um em aberto por conta (os anteriores são cancelados; o
   * banco garante isso no CHANGE). REVERT: cada troca tem o seu (a cadeia A→B→C deixa dois abertos).
   * Aproveita para apagar as linhas mortas da conta.
   */
  async issue(
    input: IssueAccountEmailToken,
    manager?: EntityManager,
  ): Promise<{ token: string; record: AccountEmailToken }> {
    const repo = this.repo(manager);
    const now = input.now ?? new Date();
    if (input.purpose !== AccountEmailTokenPurpose.REVERT) {
      await revokeOpenAccountEmailTokens(
        repo.manager,
        input.userId,
        [input.purpose],
        now,
      );
    }
    await this.purgeDead(input.userId, repo, now);
    this.purgeDeadInBackground(now);

    const token = randomToken();
    const record = await repo.save(
      repo.create({
        user_id: input.userId,
        purpose: input.purpose,
        email: normalizeEmail(input.email),
        previous_email:
          input.purpose === AccountEmailTokenPurpose.VERIFY
            ? null
            : normalizeEmail(input.previousEmail ?? ''),
        token_hash: sha256Hex(token),
        expires_at: hoursFrom(
          now,
          ACCOUNT_EMAIL_TOKEN_TTL_HOURS[input.purpose],
        ),
        used_at: null,
        revoked_at: null,
        requested_ip: input.ip?.slice(0, 64) ?? null,
      }),
    );
    return { token, record };
  }

  /** Cancela os links em aberto da conta (ver revokeOpenAccountEmailTokens). */
  revokeOpen(
    userId: number,
    purposes: readonly AccountEmailTokenPurpose[],
    manager?: EntityManager,
    now: Date = new Date(),
  ): Promise<number> {
    return revokeOpenAccountEmailTokens(
      this.repo(manager).manager,
      userId,
      purposes,
      now,
    );
  }

  /**
   * Link em aberto e no prazo, pelo código. Formato inválido → null sem consultar o banco. Com `lock`
   * (dentro de uma transação), a linha fica travada até o fim dela: dois usos simultâneos do mesmo
   * link nunca passam os dois.
   */
  async findUsable(
    token: string,
    purpose: AccountEmailTokenPurpose,
    options: { manager?: EntityManager; lock?: boolean; now?: Date } = {},
  ): Promise<AccountEmailToken | null> {
    if (!isLinkToken(token)) return null;
    const record = await this.repo(options.manager).findOne({
      where: { token_hash: sha256Hex(token), purpose },
      ...(options.lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    const now = options.now ?? new Date();
    if (
      !record ||
      record.used_at ||
      record.revoked_at ||
      record.expires_at <= now
    ) {
      return null;
    }
    return record;
  }

  /** Pedido de troca de e-mail em aberto e no prazo da conta (no máximo um). */
  findOpenChange(
    userId: number,
    now: Date = new Date(),
  ): Promise<AccountEmailToken | null> {
    return this.tokens.findOne({
      where: {
        user_id: userId,
        purpose: AccountEmailTokenPurpose.CHANGE,
        used_at: IsNull(),
        revoked_at: IsNull(),
        expires_at: MoreThan(now),
      },
      order: { created_at: 'DESC', id: 'DESC' },
    });
  }

  /**
   * O e-mail está reservado por OUTRA conta? (endereço antigo de uma troca recente, com o "Não fui eu"
   * ainda no prazo). Vale para cadastro, convites, aceite, autoatendimento e equipe: ninguém toma o
   * endereço enquanto o dono pode desfazer a troca.
   */
  isReserved(
    email: string,
    ignoreUserId?: number,
    manager?: EntityManager,
    now: Date = new Date(),
  ): Promise<boolean> {
    return this.repo(manager).exists({
      where: {
        email: normalizeEmail(email),
        purpose: AccountEmailTokenPurpose.REVERT,
        used_at: IsNull(),
        revoked_at: IsNull(),
        expires_at: MoreThan(now),
        ...(ignoreUserId !== undefined ? { user_id: Not(ignoreUserId) } : {}),
      },
    });
  }

  /** Marca o link como usado (só se ainda estava em aberto). */
  async markUsed(
    recordId: number,
    manager?: EntityManager,
    now: Date = new Date(),
  ): Promise<boolean> {
    const result = await this.repo(manager).update(
      { id: recordId, used_at: IsNull(), revoked_at: IsNull() },
      { used_at: now },
    );
    return !!result.affected;
  }

  /**
   * Lote das linhas mortas há mais de 1 dia de todas as contas (fora da transação de quem emite e sem
   * esperar; falha só vai para o log). Usa IDX_account_email_tokens_expires no caso comum (vencidas).
   */
  private purgeDeadInBackground(now: Date): void {
    const at = now.getTime();
    if (at - this.lastGlobalPurge < GLOBAL_PURGE_INTERVAL_MS) return;
    this.lastGlobalPurge = at;
    const cutoff = new Date(at - DEAD_ROW_GRACE_MS);
    Promise.resolve()
      .then(() =>
        this.tokens.query(
          `DELETE FROM "account_email_tokens" WHERE "id" IN (
             SELECT "id" FROM "account_email_tokens"
              WHERE "expires_at" < $1 OR "used_at" < $1 OR "revoked_at" < $1
              LIMIT $2
           )`,
          [cutoff, GLOBAL_PURGE_BATCH],
        ),
      )
      .catch((error: Error) =>
        this.logger.warn(
          `Falha ao limpar os links de e-mail vencidos: ${error.message}`,
        ),
      );
  }

  /** Apaga as linhas mortas da conta há mais de 1 dia (limpeza oportunista, como em auth_sessions). */
  private async purgeDead(
    userId: number,
    repo: Repository<AccountEmailToken>,
    now: Date,
  ): Promise<void> {
    const cutoff = new Date(now.getTime() - DEAD_ROW_GRACE_MS);
    await repo
      .createQueryBuilder()
      .delete()
      .from(AccountEmailToken)
      .where('"user_id" = :userId', { userId })
      .andWhere(
        '("expires_at" < :cutoff OR "used_at" < :cutoff OR "revoked_at" < :cutoff)',
        { cutoff },
      )
      .execute();
  }
}
