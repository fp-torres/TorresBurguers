import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { IsNull, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import type { AuditActorScope } from '../audit/entities/audit-log.entity';
import { ipRateLimitKey } from '../common/rate-limit/ip-key';
import { requestMeta } from '../common/request-meta';
import { SupportSession } from '../platform/entities/support-session.entity';
import {
  endSupportSessionByOperator,
  type SupportSessionEndVia,
} from '../platform/support-sessions.service';
import { pageRequest } from '../store/dto/store-list-query.dto';
import type { Paginated } from '../store/store-presenter';
import { accountActor, accountScope } from '../users/account-actor';
import type { AuthUser } from './auth-user';
import type { SessionListQueryDto } from './dto/session-list-query.dto';
import {
  AuthSession,
  AuthSessionKind,
  AuthSessionTransport,
} from './entities/auth-session.entity';
import { compareHash, parseRefreshToken, refreshHash } from './refresh-token';
import type { IssuedSession, SessionScope } from './session-scope';
import { summarizeUserAgent } from './user-agent';

export const AUTH_SESSION_NOT_FOUND_MESSAGE = 'Sessão não encontrada.';

/** Tamanho máximo do navegador gravado (auth_sessions.user_agent). */
const USER_AGENT_MAX_LENGTH = 255;
/** Limpeza geral das sessões vencidas: no máximo uma vez por hora em cada instância, em lotes. */
const EXPIRED_PURGE_INTERVAL_MS = 60 * 60 * 1000;
const EXPIRED_PURGE_BATCH = 5000;
/**
 * Sessões de acesso (USER) ativas por conta. Cada login correto cria uma; acima disso, as mais antigas
 * são encerradas. Folgado para vários aparelhos e navegadores da mesma pessoa.
 */
export const MAX_ACTIVE_SESSIONS_PER_ACCOUNT = 100;

/** Sessão na lista "Sessões ativas" (GET /auth/sessions). Nunca traz o jti nem o User-Agent completo. */
export interface AuthSessionView {
  id: number;
  kind: AuthSessionKind;
  /** A sessão do token desta requisição. */
  current: boolean;
  created_at: Date;
  expires_at: Date;
  ip: string | null;
  /** Resumo do navegador: "Chrome no Windows", "Aplicativo no Android"... */
  browser: string;
  /** Sessão de suporte do token (kind SUPPORT). */
  support_session_id: number | null;
}

/** Escopo da auditoria da própria conta (o mesmo do login): plataforma, equipe ou cliente. */
function accountAuditScope(user: AuthUser): AuditActorScope {
  if (user.platformRole || user.supportSession) return 'PLATFORM';
  return user.storeId !== null && user.storeId !== undefined
    ? 'STORE'
    : 'ANONYMOUS';
}

/**
 * Sessões de acesso (auth_sessions): gravação das sessões dos tokens emitidos, conferência de cada
 * requisição (JwtStrategy), lista e encerramento pela própria conta.
 *
 * O repositório vem do EntityManager da conexão (o mesmo do SupportSession), sem registrar mais uma
 * entidade no TypeOrmModule.forFeature do AuthModule: os módulos que importam o AuthModule continuam
 * montando nos testes que substituem os repositórios um a um.
 */
@Injectable()
export class AuthSessionsService {
  private readonly logger = new Logger(AuthSessionsService.name);
  private lastExpiredPurge = 0;

  constructor(
    @InjectRepository(SupportSession)
    private readonly supportSessions: Repository<SupportSession>,
    private readonly audit: AuditService,
  ) {}

  private repository(): Repository<AuthSession> {
    return this.supportSessions.manager.getRepository(AuthSession);
  }

  /**
   * Grava as sessões dos tokens assinados nesta requisição (SessionIssuanceInterceptor, ANTES de a resposta
   * com o token sair: quando o token chega a quem pediu, a sessão já existe). Depois, limpeza barata: as
   * sessões mortas (vencidas, revogadas ou de uma versão antiga) das mesmas contas e, no máximo uma vez
   * por hora, um lote das vencidas de todas as contas. Uma falha na limpeza não derruba a resposta.
   */
  async persistIssued(scope: SessionScope): Promise<IssuedSession[]> {
    if (scope.issued.length === 0) return [];
    const issued = scope.issued.splice(0);
    const { ip, userAgent } = requestMeta(scope.request);

    await this.repository().insert(
      issued.map((session) => ({
        jti: session.jti,
        user_id: session.userId,
        kind: session.kind,
        support_session_id: session.supportSessionId,
        token_version: session.tokenVersion,
        expires_at: session.expiresAt,
        revoked_at: null,
        ip,
        user_agent: userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
        transport: session.transport ?? AuthSessionTransport.BEARER,
        refresh_selector: session.refresh?.selector ?? null,
        refresh_hash: session.refresh?.hash ?? null,
        parent_session_id: session.parentSessionId ?? null,
      })),
    );

    for (const userId of new Set(issued.map((session) => session.userId))) {
      try {
        await this.purgeDeadSessions(userId);
        await this.capActiveSessions(userId);
      } catch (error) {
        this.logger.warn(
          `Falha ao limpar as sessões antigas da conta ${userId}: ${(error as Error).message}`,
        );
      }
    }
    this.purgeExpiredInBackground();
    return issued;
  }

  // --- Sessão do site em cookie (refresh) -------------------------------------------------

  /** Família de refresh pelo seletor (índice único parcial), com a conta (para auditoria e conferência). */
  findBySelector(selector: string): Promise<AuthSession | null> {
    return this.repository().findOne({
      where: {
        refresh_selector: selector,
        transport: AuthSessionTransport.COOKIE,
      },
      relations: { user: true },
    });
  }

  /**
   * Rotação do refresh por UPDATE condicional: só troca se o hash apresentado ainda for o atual e a sessão
   * estiver aberta e no prazo. Devolve false quando outra renovação chegou antes (ou a sessão caiu).
   */
  async rotateRefresh(
    sessionId: number,
    presentedHash: string,
    nextHash: string,
  ): Promise<boolean> {
    const rows: unknown = await this.repository().query(
      `UPDATE "auth_sessions"
          SET "refresh_prev_hash" = "refresh_hash",
              "refresh_hash" = $3,
              "refresh_rotated_at" = now(),
              "refresh_generation" = "refresh_generation" + 1
        WHERE "id" = $1
          AND "transport" = 'COOKIE'
          AND "refresh_hash" = $2
          AND "revoked_at" IS NULL
          AND "expires_at" > now()
        RETURNING "id"`,
      [sessionId, presentedHash, nextHash],
    );
    return rowCount(rows) > 0;
  }

  /** Encerra uma sessão (revoked_at), se ainda aberta. Devolve true se encerrou agora. */
  async revokeSession(
    sessionId: number,
    now: Date = new Date(),
  ): Promise<boolean> {
    const result = await this.repository().update(
      { id: sessionId, revoked_at: IsNull() },
      { revoked_at: now },
    );
    return (result.affected ?? 0) > 0;
  }

  /**
   * Reuso de um refresh antigo (fora da tolerância) ou desconhecido: a família inteira é encerrada (o token
   * de acesso dela também cai na hora, pelo jti) e o evento vai para a auditoria (auth.refresh.reuse).
   */
  async revokeForReuse(
    session: AuthSession,
    request?: Request | null,
  ): Promise<void> {
    await this.revokeSession(session.id);
    await this.audit.record({
      ...ownerAudit(session),
      action: 'auth.refresh.reuse',
      targetType: 'auth_session',
      targetId: session.id,
      result: 'DENIED',
      metadata: { generation: session.refresh_generation },
      request,
    });
  }

  /**
   * Há uma sessão de suporte aberta a partir desta sessão do superadmin? (o refresh da sessão do
   * superpainel fica suspenso enquanto isso: um script na aba de suporte não obtém o acesso pleno)
   */
  async hasOpenSupportFrom(sessionId: number): Promise<boolean> {
    const rows: unknown = await this.repository().query(
      `SELECT 1 FROM "auth_sessions" c
          JOIN "support_sessions" ss ON ss."id" = c."support_session_id"
         WHERE c."parent_session_id" = $1
           AND c."kind" = 'SUPPORT'
           AND c."revoked_at" IS NULL
           AND c."expires_at" > now()
           AND ss."ended_at" IS NULL
           AND ss."expires_at" > now()
         LIMIT 1`,
      [sessionId],
    );
    return rowCount(rows) > 0;
  }

  /**
   * Uma emissão de sessão em cookie substitui a sessão do cookie que o navegador já tinha (login com a
   * mesma ou com outra conta): ela é encerrada (melhor esforço) e registrada como auth.session.revoke com
   * reason 'replaced'. Só com o refresh certo (o atual ou o anterior) de uma sessão ainda aberta e da
   * versão atual da conta (depois de trocar a senha, a sessão antiga já caiu pela versão).
   */
  async revokeReplacedCookieSession(
    cookieValue: string | null,
    keep: IssuedSession[],
    request?: Request | null,
  ): Promise<void> {
    const parsed = parseRefreshToken(cookieValue);
    if (!parsed) return;
    const session = await this.findBySelector(parsed.selector);
    if (
      !session ||
      session.revoked_at ||
      new Date(session.expires_at).getTime() <= Date.now() ||
      keep.some((issued) => issued.jti === session.jti)
    ) {
      return;
    }
    const hash = refreshHash(parsed.validator);
    if (
      !compareHash(hash, session.refresh_hash) &&
      !compareHash(hash, session.refresh_prev_hash)
    ) {
      return;
    }
    const owner = session.user;
    if (owner && (owner.token_version ?? 0) !== session.token_version) return;
    if (!(await this.revokeSession(session.id))) return;
    await this.audit.record({
      ...ownerAudit(session),
      action: 'auth.session.revoke',
      targetType: 'auth_session',
      targetId: session.id,
      metadata: { kind: session.kind, current: false, reason: 'replaced' },
      request,
    });
  }

  /**
   * Sessão de um token (pelo jti, índice único) com a sessão de suporte dele: UMA consulta, sem LIMIT
   * (o jti é único), feita pela JwtStrategy a cada requisição autenticada.
   */
  findForToken(jti: string): Promise<AuthSession | null> {
    return this.repository()
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.support_session', 'ss')
      .where('s.jti = :jti', { jti })
      .getOne();
  }

  /**
   * O IP (chave dos limites: IPv6 pela rede /64) é de uma sessão ATIVA de acesso da conta com este
   * e-mail? Usado só quando a conta atingiu o teto de falhas de login (LOGIN_FAILURES_ACCOUNT): quem
   * já entrou daquele lugar continua conseguindo entrar. Sessões encerradas (inclusive a de um
   * aparelho que a pessoa derrubou) não contam. Consulta limitada às sessões mais recentes da conta.
   */
  async isKnownOrigin(email: string, ipKey: string): Promise<boolean> {
    const rows = await this.repository()
      .createQueryBuilder('s')
      .select('s.ip', 'ip')
      .innerJoin('s.user', 'u', 'u.token_version = s.token_version')
      .where('LOWER(u.email) = :email', { email: email.trim().toLowerCase() })
      .andWhere('s.kind = :kind', { kind: AuthSessionKind.USER })
      .andWhere('s.revoked_at IS NULL')
      .andWhere('s.expires_at > now()')
      .andWhere('s.ip IS NOT NULL')
      .orderBy('s.created_at', 'DESC')
      .limit(MAX_ACTIVE_SESSIONS_PER_ACCOUNT)
      .getRawMany<{ ip: string | null }>();
    return rows.some((row) => !!row.ip && ipRateLimitKey(row.ip) === ipKey);
  }

  /**
   * GET /auth/sessions: as sessões ATIVAS da própria conta (não revogadas, no prazo, da versão atual das
   * sessões da conta e, nas de suporte, com a sessão de suporte aberta). A sessão desta requisição vem
   * primeiro; depois, as mais recentes.
   */
  async list(
    user: AuthUser,
    query: SessionListQueryDto = {},
    now: Date = new Date(),
  ): Promise<Paginated<AuthSessionView>> {
    const { page, pageSize, offset } = pageRequest(query);
    const current = user.authSessionId ?? 0;
    const [rows, total] = await this.repository()
      .createQueryBuilder('s')
      .innerJoin('s.user', 'u', 'u.token_version = s.token_version')
      .leftJoin('s.support_session', 'ss')
      .where('s.user_id = :userId', { userId: user.id })
      .andWhere('s.revoked_at IS NULL')
      .andWhere('s.expires_at > :now', { now })
      .andWhere(
        '(s.support_session_id IS NULL OR (ss.ended_at IS NULL AND ss.expires_at > :now))',
      )
      .orderBy('CASE WHEN s.id = :current THEN 0 ELSE 1 END', 'ASC')
      .addOrderBy('s.created_at', 'DESC')
      .addOrderBy('s.id', 'DESC')
      .setParameter('current', current)
      .offset(offset)
      .limit(pageSize)
      .getManyAndCount();

    return {
      items: rows.map((session) => ({
        id: session.id,
        kind: session.kind,
        current: session.id === current,
        created_at: session.created_at,
        expires_at: session.expires_at,
        ip: session.ip,
        browser: summarizeUserAgent(session.user_agent),
        support_session_id: session.support_session_id,
      })),
      total,
      page,
      pageSize,
    };
  }

  /**
   * POST /auth/logout: encerra a sessão do token desta requisição. Com o token de uma sessão de suporte,
   * também encerra a sessão de suporte (auditado), sem precisar do token do superpainel. Tokens antigos
   * (sem "jti") não têm sessão registrada: continuam valendo até expirar ("sair de todos os aparelhos"
   * os derruba).
   */
  async logout(user: AuthUser, request?: Request | null): Promise<void> {
    const now = new Date();
    if (user.authSessionId) {
      await this.repository().update(
        { id: user.authSessionId, user_id: user.id, revoked_at: IsNull() },
        { revoked_at: now },
      );
    }

    if (user.supportSession) {
      await this.endSupportSession(
        user,
        user.supportSession.id,
        'logout',
        request,
        now,
      );
      return;
    }

    await this.audit.record({
      actor: user,
      scope: accountAuditScope(user),
      storeId: user.storeId,
      action: 'auth.logout',
      targetType: 'auth_session',
      targetId: user.authSessionId ?? null,
      metadata: user.authSessionId ? null : { legacy_token: true },
      request,
    });
  }

  /**
   * DELETE /auth/sessions/:id: encerra uma sessão da própria conta (inclusive a atual). Sessão de outra
   * conta ou inexistente → 404. Já encerrada ou vencida → nada muda (idempotente). A sessão de acesso de
   * uma sessão de suporte também encerra a sessão de suporte.
   */
  async revoke(
    user: AuthUser,
    id: number,
    request?: Request | null,
  ): Promise<void> {
    const session = await this.repository().findOne({
      where: { id, user_id: user.id },
    });
    if (!session) throw new NotFoundException(AUTH_SESSION_NOT_FOUND_MESSAGE);

    const now = new Date();
    const result = session.revoked_at
      ? { affected: 0 }
      : await this.repository().update(
          { id, user_id: user.id, revoked_at: IsNull() },
          { revoked_at: now },
        );
    if (
      session.support_session_id !== null &&
      session.support_session_id !== undefined
    ) {
      await this.endSupportSession(
        user,
        session.support_session_id,
        'session_revoke',
        request,
        now,
      );
    }
    if (!result.affected) return;

    await this.audit.record({
      actor: user,
      scope: accountAuditScope(user),
      storeId: user.storeId,
      action: 'auth.session.revoke',
      targetType: 'auth_session',
      targetId: id,
      metadata: { kind: session.kind, current: id === user.authSessionId },
      request,
    });
  }

  /**
   * POST /auth/logout-all: marca TODAS as sessões registradas da conta como encerradas (o AuthService
   * também muda a versão das sessões da conta, o que derruba os tokens antigos sem "jti").
   */
  async revokeAll(userId: number, now: Date = new Date()): Promise<number> {
    const result = await this.repository().update(
      { user_id: userId, revoked_at: IsNull() },
      { revoked_at: now },
    );
    return result.affected ?? 0;
  }

  // ---------------------------------------------------------------------------

  private async endSupportSession(
    user: AuthUser,
    supportSessionId: number,
    via: SupportSessionEndVia,
    request: Request | null | undefined,
    now: Date,
  ): Promise<void> {
    await endSupportSessionByOperator(this.supportSessions, this.audit, {
      sessionId: supportSessionId,
      operatorId: user.id,
      via,
      actor: user,
      request,
      now,
    });
  }

  /** Sessões mortas de uma conta: vencidas, revogadas, de uma versão antiga ou de um suporte encerrado. */
  private async purgeDeadSessions(userId: number): Promise<void> {
    await this.repository().query(
      `DELETE FROM "auth_sessions" s
        WHERE s."user_id" = $1
          AND (
            s."expires_at" <= now()
            OR s."revoked_at" IS NOT NULL
            OR s."token_version" <> (SELECT u."token_version" FROM "users" u WHERE u."id" = $1)
            OR EXISTS (
              SELECT 1 FROM "support_sessions" ss
               WHERE ss."id" = s."support_session_id"
                 AND (ss."ended_at" IS NOT NULL OR ss."expires_at" <= now())
            )
          )`,
      [userId],
    );
  }

  /**
   * Teto de sessões de acesso (USER) por conta: as mais antigas além de MAX_ACTIVE_SESSIONS_PER_ACCOUNT
   * são apagadas (os tokens delas passam a responder 401). Sem isso, logins corretos repetidos
   * inflariam auth_sessions e deixariam a limpeza da conta e GET /auth/sessions cada vez mais caros.
   * Roda depois da limpeza das mortas, então só sobram sessões ativas para contar.
   */
  private async capActiveSessions(userId: number): Promise<void> {
    await this.repository().query(
      `DELETE FROM "auth_sessions" WHERE "id" IN (
         SELECT "id" FROM "auth_sessions"
          WHERE "user_id" = $1 AND "kind" = $2
          ORDER BY "created_at" DESC, "id" DESC
          OFFSET $3
       )`,
      [userId, AuthSessionKind.USER, MAX_ACTIVE_SESSIONS_PER_ACCOUNT],
    );
  }

  /** Lote das sessões vencidas de todas as contas (sem esperar: não atrasa o login). */
  private purgeExpiredInBackground(): void {
    const now = Date.now();
    if (now - this.lastExpiredPurge < EXPIRED_PURGE_INTERVAL_MS) return;
    this.lastExpiredPurge = now;
    this.repository()
      .query(
        `DELETE FROM "auth_sessions" WHERE "id" IN (
           SELECT "id" FROM "auth_sessions" WHERE "expires_at" <= now() ORDER BY "expires_at" LIMIT $1
         )`,
        [EXPIRED_PURGE_BATCH],
      )
      .catch((error: Error) =>
        this.logger.warn(
          `Falha ao limpar as sessões vencidas: ${error.message}`,
        ),
      );
  }
}

/** Ator da auditoria de uma sessão sem token na requisição (refresh, reuso, substituição): a dona dela. */
function ownerAudit(session: AuthSession) {
  const owner = session.user;
  return owner
    ? {
        actor: accountActor(owner),
        scope: accountScope(owner),
        storeId: owner.store_id,
      }
    : {};
}

/** Linhas de um UPDATE ... RETURNING ou SELECT cru pelo TypeORM (pg: [linhas, total] no UPDATE). */
function rowCount(result: unknown): number {
  if (!Array.isArray(result)) return 0;
  if (
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[1];
  }
  return result.length;
}
