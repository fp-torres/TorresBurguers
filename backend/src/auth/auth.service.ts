import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import {
  type RateLimitRelease,
  RateLimitService,
} from '../common/rate-limit/rate-limit.service';
import { StoreAccountStatus } from '../store/entities/store.entity';
import { accountActor, accountScope } from '../users/account-actor';
import { normalizeEmail } from '../users/email';
import { User } from '../users/entities/user.entity';
import { type SessionUser, toSessionUser } from '../users/session-user';
import { UsersService } from '../users/users.service';
import type { AuthUser } from './auth-user';
import { AuthSessionsService } from './auth-sessions.service';
import {
  BLOCKED_ACCOUNT_MESSAGE,
  INVALID_SESSION_MESSAGE,
} from './jwt.strategy';
import { clientIpKey } from './link-token';
import { LoginTiming } from './login-timing';
import { SessionTokenService } from './session-token.service';

function isTooManyRequests(error: unknown): boolean {
  return (
    error instanceof HttpException &&
    error.getStatus() === Number(HttpStatus.TOO_MANY_REQUESTS)
  );
}

export const INVALID_CREDENTIALS_MESSAGE = 'Email ou senha inválidos';
export const INACTIVE_STORE_LOGIN_MESSAGE =
  'Esta loja foi desativada na plataforma. Fale com o suporte.';

/**
 * Hash bcrypt (custo 10, o mesmo dos cadastros) de um valor descartável. Quando o e-mail não existe,
 * a senha é comparada com ele: a resposta leva o mesmo tempo de uma senha errada e não revela se
 * a conta existe.
 */
const DUMMY_PASSWORD_HASH =
  '$2b$10$OiFnndP81htOnhXKVoHHXeQwkSoCQtOlJG2vNKYq9EMZt5CBsAalG';

export interface LoginResult {
  access_token: string;
  user: SessionUser;
}

/** GET /auth/me: a sessão atual (+ a sessão de suporte, quando for uma). */
export interface MeResult extends SessionUser {
  support_session: { id: number; store_id: number; expires_at: Date } | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly sessionTokens: SessionTokenService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
    private readonly authSessions: AuthSessionsService,
  ) {}

  /** Tempo típico de uma conferência de senha: as recusas 429 anteriores a ela esperam o mesmo. */
  private readonly loginTiming = new LoginTiming(() =>
    bcrypt.compare('calibracao-do-login', DUMMY_PASSWORD_HASH),
  );

  /**
   * Confere e-mail (sem diferenciar maiúsculas) e senha. Retorna a conta (ainda com o hash: use só
   * no servidor) ou null. Sem nenhuma conta com o e-mail, compara com um hash fictício (tempo constante).
   */
  async validateUser(email: string, password: string): Promise<User | null> {
    const candidates = await this.usersService.findForLogin(email);
    if (candidates.length === 0) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      return null;
    }

    for (const user of candidates) {
      if (
        user.password_hash &&
        (await bcrypt.compare(password, user.password_hash))
      ) {
        return user;
      }
    }
    return null;
  }

  /**
   * POST /auth/login. Limites: falhas por IP + e-mail, por IP (IPv6 pela rede /64) e por conta
   * (todos os IPs somados), e logins corretos por IP + e-mail. Cada tentativa reserva as vagas de
   * falha ANTES de conferir a senha (atômico: uma rajada simultânea não passa do limite) e as devolve
   * quando a senha está certa; o sucesso zera o contador da conta naquele IP. Com o teto por conta
   * atingido, só origens conhecidas (IP de uma sessão ativa da conta) continuam tentando: a força
   * bruta distribuída para, e a pessoa não fica trancada fora da própria conta. A situação da conta
   * (bloqueada, loja desativada) só é revelada depois da senha correta.
   * Sem oráculo de sessão ativa: com o teto por conta atingido, a senha errada de uma origem conhecida
   * recebe o MESMO 429 das outras origens (só a senha certa muda a resposta), e toda recusa 429 anterior
   * à conferência espera o tempo típico de uma conferência (LoginTiming) antes de responder.
   */
  async login(
    credentials: { email: string; password: string },
    request?: Request | null,
  ): Promise<LoginResult> {
    const email = normalizeEmail(credentials.email);
    const ip = clientIpKey(request);
    const accountKey = `${ip}|${email}`;
    const releases: RateLimitRelease[] = [];
    const releaseAll = () => releases.splice(0).forEach((release) => release());
    let accountCap: HttpException | null = null;
    try {
      this.rateLimit.assertNotLimited('LOGIN_SUCCESS', accountKey);
      releases.push(this.rateLimit.take('LOGIN_FAILURES_IP', ip));
      releases.push(this.rateLimit.take('LOGIN_FAILURES', accountKey));
      const account = await this.takeAccountAttempt(email, ip);
      releases.push(account.release);
      accountCap = account.capReached;
    } catch (error) {
      releaseAll();
      if (isTooManyRequests(error)) await this.loginTiming.pad();
      throw error;
    }

    let user: User | null;
    const started = performance.now();
    try {
      user = await this.validateUser(email, credentials.password);
    } catch (error) {
      // Falha inesperada (ex.: banco fora do ar) não é uma senha errada
      releaseAll();
      throw error;
    }
    this.loginTiming.record(performance.now() - started);
    if (!user) {
      // As vagas reservadas ficam: a tentativa errada já está contada
      await this.audit.record({
        action: 'auth.login.failure',
        actorEmail: email,
        result: 'FAILURE',
        metadata: {
          reason: 'invalid_credentials',
          locked: this.rateLimit.isLimited('LOGIN_FAILURES', accountKey),
        },
        request,
      });
      // Teto por conta atingido (origem conhecida): a mesma recusa de qualquer outra origem
      if (accountCap) throw accountCap;
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }
    // Senha certa: não é uma falha (devolve as vagas reservadas), mas conta no teto de logins corretos
    releaseAll();
    this.rateLimit.hit('LOGIN_SUCCESS', accountKey);

    if (user.blocked_at) {
      await this.denied(user, 'blocked', request);
      throw new ForbiddenException(BLOCKED_ACCOUNT_MESSAGE);
    }
    // Equipe de loja desativada não entra (os clientes e o superadmin não têm loja)
    const store = await this.usersService.storeSummary(user.store_id);
    if (
      (user.store_id ?? null) !== null &&
      (!store || store.account_status === StoreAccountStatus.INACTIVE)
    ) {
      await this.denied(user, 'store_inactive', request);
      throw new ForbiddenException(INACTIVE_STORE_LOGIN_MESSAGE);
    }

    this.rateLimit.reset('LOGIN_FAILURES', accountKey);
    await this.usersService.recordLogin(user.id);
    await this.audit.record({
      actor: accountActor(user),
      scope: accountScope(user),
      storeId: user.store_id,
      action: 'auth.login.success',
      targetType: 'user',
      targetId: user.id,
      request,
    });

    return {
      access_token: this.sessionTokens.issue(user),
      user: toSessionUser(user, store),
    };
  }

  /** GET /auth/me: a conta atual com o perfil e a loja efetivos da sessão. */
  async me(session: AuthUser): Promise<MeResult> {
    const user = await this.usersService.findActiveById(session.id);
    if (!user) throw new UnauthorizedException(INVALID_SESSION_MESSAGE);

    const view = await this.usersService.presentAs(user, session);
    const support = session.supportSession;
    return {
      ...view,
      support_session: support
        ? {
            id: support.id,
            store_id: support.storeId,
            expires_at: support.expiresAt,
          }
        : null,
    };
  }

  /**
   * POST /auth/logout-all: encerra todas as sessões da própria conta (inclusive a atual). Primeiro as
   * sessões registradas, depois a versão das sessões da conta (que derruba também os tokens antigos, sem
   * "jti"): um login que aconteça entre os dois passos nasce com a versão antiga e cai junto.
   */
  async logoutAll(session: AuthUser, request?: Request | null): Promise<void> {
    await this.authSessions.revokeAll(session.id);
    await this.usersService.revokeSessions(session.id, session, request);
  }

  /**
   * Vaga no teto de falhas da conta (todos os IPs). Teto atingido: só uma origem conhecida (IP com
   * sessão ativa da conta) segue tentando, ainda limitada pelos tetos do próprio IP; as demais → 429
   * antes do bcrypt. A reserva é síncrona (atômica numa rajada); só a conferência da origem espera o banco.
   * capReached: o 429 do teto, para a origem conhecida responder com ele se a senha estiver errada.
   */
  private async takeAccountAttempt(
    email: string,
    ip: string,
  ): Promise<{ release: RateLimitRelease; capReached: HttpException | null }> {
    try {
      return {
        release: this.rateLimit.take('LOGIN_FAILURES_ACCOUNT', email),
        capReached: null,
      };
    } catch (error) {
      if (
        error instanceof HttpException &&
        (await this.authSessions.isKnownOrigin(email, ip))
      ) {
        return { release: () => undefined, capReached: error };
      }
      throw error;
    }
  }

  private denied(
    user: User,
    reason: 'blocked' | 'store_inactive',
    request?: Request | null,
  ): Promise<void> {
    return this.audit.record({
      action: 'auth.login.failure',
      actor: accountActor(user),
      scope: accountScope(user),
      storeId: user.store_id,
      targetType: 'user',
      targetId: user.id,
      result: 'DENIED',
      metadata: { reason },
      request,
    });
  }
}
