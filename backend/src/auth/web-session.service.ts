import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import {
  accessTokenTtlSeconds,
  refreshGraceSeconds,
} from '../config/auth-session';
import { StoreAccountStatus } from '../store/entities/store.entity';
import { accountActor, accountScope } from '../users/account-actor';
import { PlatformRole, type User } from '../users/entities/user.entity';
import {
  type SessionStore,
  type SessionUser,
  toSessionUser,
} from '../users/session-user';
import { UsersService } from '../users/users.service';
import { AuthSessionsService } from './auth-sessions.service';
import {
  type AuthSession,
  AuthSessionKind,
} from './entities/auth-session.entity';
import { INVALID_SESSION_MESSAGE } from './jwt.strategy';
import { clientIpKey } from './link-token';
import {
  compareHash,
  createRefreshToken,
  parseRefreshToken,
  refreshHash,
} from './refresh-token';
import { SessionJwtService } from './session-token.service';
import { readRefreshCookie } from './web-session-cookie';

export const SUPPORT_SESSION_OPEN_MESSAGE =
  'Há uma sessão de suporte aberta a partir desta sessão. Encerre-a para voltar ao superpainel.';

/** POST /auth/web/refresh → 200. */
export interface WebRefreshResult {
  access_token: string;
  /** Validade do token de acesso em segundos (relativa: o navegador agenda a renovação por ela). */
  expires_in: number;
  user: SessionUser;
  session_transport: 'cookie';
}

/** Resultado interno: a resposta e o refresh novo (só quando houve rotação: vai no Set-Cookie). */
export interface WebRefreshOutcome {
  body: WebRefreshResult;
  rotated: { token: string; expiresAt: Date } | null;
}

/** 401 do refresh: o controller apaga o cookie antes de responder. */
export class RefreshRejectedException extends UnauthorizedException {
  constructor() {
    super(INVALID_SESSION_MESSAGE);
  }
}

/**
 * Sessão do site em cookie: renovação e saída pelo cookie HttpOnly (ver web-session-cookie.ts).
 *
 * Renovação (POST /auth/web/refresh), nesta ordem: (1) formato do cookie (inválido → 401 sem consultar o
 * banco); (2) família pelo seletor (desconhecida → 401, sem auditoria); (3) prazo, revogação, versão das
 * sessões da conta e situação da conta; (4) validador: o atual → rotaciona (UPDATE condicional); o
 * anterior, dentro da tolerância → só emite o token de acesso (sem Set-Cookie); qualquer outro → reuso:
 * a família é encerrada, auditada (auth.refresh.reuse) e responde 401. Numa rotação concorrente (o
 * UPDATE não achou o hash), relê a linha e decide de novo. O token de acesso leva o MESMO jti da
 * família. Superadmin com uma sessão de suporte aberta a partir desta sessão → 409 (o cookie fica).
 */
@Injectable()
export class WebSessionService {
  constructor(
    private readonly sessions: AuthSessionsService,
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  async refresh(request: Request): Promise<WebRefreshOutcome> {
    this.rateLimit.consume('REFRESH', clientIpKey(request));

    const cookie = readRefreshCookie(request);
    const parsed = parseRefreshToken(cookie.present ? cookie.value : null);
    if (!parsed) throw new RefreshRejectedException();

    let session = await this.sessions.findBySelector(parsed.selector);
    if (!session) throw new RefreshRejectedException();
    const { user, store } = await this.activeOwner(session);

    const presented = refreshHash(parsed.validator);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (compareHash(presented, session.refresh_hash)) {
        await this.assertNoOpenSupport(session, user);
        const next = createRefreshToken(parsed.selector);
        if (
          await this.sessions.rotateRefresh(session.id, presented, next.hash)
        ) {
          return {
            body: this.respond(session, user, store),
            rotated: { token: next.token, expiresAt: session.expires_at },
          };
        }
        // Outra renovação chegou antes (outra aba): relê e decide pela tolerância. O mesmo hash ainda atual
        // depois de uma rotação recusada não é reuso: só 401
        const fresh = await this.sessions.findBySelector(parsed.selector);
        if (!fresh || attempt > 0) throw new RefreshRejectedException();
        session = fresh;
        this.assertOpen(session);
        continue;
      }
      if (this.withinGrace(session, presented)) {
        await this.assertNoOpenSupport(session, user);
        return { body: this.respond(session, user, store), rotated: null };
      }
      break;
    }

    await this.sessions.revokeForReuse(session, request);
    throw new RefreshRejectedException();
  }

  /**
   * POST /auth/web/logout: encerra a família do cookie (se houver). Sempre termina sem erro: o controller
   * responde 204 e apaga o cookie. Validador que não é o atual nem o anterior → também auth.refresh.reuse.
   */
  async logout(request: Request): Promise<void> {
    const cookie = readRefreshCookie(request);
    const parsed = parseRefreshToken(cookie.present ? cookie.value : null);
    if (!parsed) return;
    const session = await this.sessions.findBySelector(parsed.selector);
    if (!session || session.revoked_at) return;

    const presented = refreshHash(parsed.validator);
    const known =
      compareHash(presented, session.refresh_hash) ||
      compareHash(presented, session.refresh_prev_hash);
    if (!known) {
      await this.sessions.revokeForReuse(session, request);
      return;
    }
    if (!(await this.sessions.revokeSession(session.id))) return;
    const owner = session.user;
    await this.audit.record({
      ...(owner
        ? {
            actor: accountActor(owner),
            scope: accountScope(owner),
            storeId: owner.store_id,
          }
        : {}),
      action: 'auth.logout',
      targetType: 'auth_session',
      targetId: session.id,
      metadata: { via: 'cookie' },
      request,
    });
  }

  // ---------------------------------------------------------------------------

  /** Sessão aberta e no prazo; senão 401. */
  private assertOpen(session: AuthSession): void {
    if (
      session.revoked_at ||
      session.kind !== AuthSessionKind.USER ||
      new Date(session.expires_at).getTime() <= Date.now()
    ) {
      throw new RefreshRejectedException();
    }
  }

  /**
   * A conta da família: ativa, desbloqueada, na mesma versão das sessões e, na equipe, com a loja ativa
   * (o login também recusa a equipe de uma loja desativada); senão 401.
   */
  private async activeOwner(
    session: AuthSession,
  ): Promise<{ user: User; store: SessionStore | null }> {
    this.assertOpen(session);
    const user = await this.users.findActiveById(session.user_id);
    if (
      !user ||
      user.blocked_at ||
      (user.token_version ?? 0) !== session.token_version
    ) {
      throw new RefreshRejectedException();
    }
    const store = await this.users.storeSummary(user.store_id);
    if (
      (user.store_id ?? null) !== null &&
      (!store || store.account_status === StoreAccountStatus.INACTIVE)
    ) {
      throw new RefreshRejectedException();
    }
    return { user, store };
  }

  /** Validador anterior, apresentado dentro de AUTH_REFRESH_GRACE_SECONDS depois da última renovação. */
  private withinGrace(session: AuthSession, presented: string): boolean {
    if (!compareHash(presented, session.refresh_prev_hash)) return false;
    if (!session.refresh_rotated_at) return false;
    const elapsed = Date.now() - new Date(session.refresh_rotated_at).getTime();
    return elapsed <= refreshGraceSeconds() * 1000;
  }

  /** Superadmin com uma sessão de suporte aberta a partir desta sessão → 409 (o cookie fica). */
  private async assertNoOpenSupport(
    session: AuthSession,
    user: User,
  ): Promise<void> {
    if (user.platform_role !== PlatformRole.SUPER_ADMIN) return;
    if (await this.sessions.hasOpenSupportFrom(session.id)) {
      throw new ConflictException(SUPPORT_SESSION_OPEN_MESSAGE);
    }
  }

  private respond(
    session: AuthSession,
    user: User,
    store: SessionStore | null,
  ): WebRefreshResult {
    const remaining = Math.floor(
      (new Date(session.expires_at).getTime() - Date.now()) / 1000,
    );
    const expiresIn = Math.max(1, Math.min(accessTokenTtlSeconds(), remaining));
    const signer = this.jwt as SessionJwtService;
    return {
      access_token: signer.signForSession(user, session.jti, expiresIn),
      expires_in: expiresIn,
      user: toSessionUser(user, store),
      session_transport: 'cookie',
    };
  }
}
