import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  JwtService,
  type JwtModuleOptions,
  type JwtSignOptions,
} from '@nestjs/jwt';
import type { SignOptions } from 'jsonwebtoken';
import {
  accessTokenTtlSeconds,
  sessionMaxAgeSeconds,
} from '../config/auth-session';
import { jwtExpiresIn, jwtSecret } from '../config/jwt';
import type { User } from '../users/entities/user.entity';
import type { AuthUser, JwtPayload } from './auth-user';
import {
  AuthSessionKind,
  AuthSessionTransport,
} from './entities/auth-session.entity';
import { createRefreshToken } from './refresh-token';
import { currentSessionScope, type SessionScope } from './session-scope';

/**
 * Opções de assinatura/verificação dos tokens — fonte única (config/jwt.ts), a mesma da JwtStrategy.
 * Algoritmo fixo: tokens com outro "alg" (inclusive "none") são recusados.
 */
export function jwtModuleOptions(): JwtModuleOptions {
  return {
    secret: jwtSecret(),
    signOptions: { expiresIn: jwtExpiresIn(), algorithm: 'HS256' },
    verifyOptions: { algorithms: ['HS256'] },
  };
}

/** Validade de reserva da sessão de um token sem "exp" (configuração inválida): a padrão, 7 dias. */
const FALLBACK_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

/** Token de sessão: payload com a conta em "sub" (os demais usos do JwtService não ganham sessão). */
function isSessionPayload(
  payload: unknown,
): payload is JwtPayload & Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Buffer.isBuffer(payload)) {
    return false;
  }
  const sub = (payload as { sub?: unknown }).sub;
  return typeof sub === 'number' && Number.isInteger(sub) && sub > 0;
}

/**
 * JwtService da API (exportado pelo SessionModule; é o único): todo token de sessão assinado durante uma
 * requisição HTTP recebe um "jti" novo e fica anotado no escopo da requisição, e o
 * SessionIssuanceInterceptor grava a sessão (auth_sessions) ANTES de a resposta com o token sair. Assim
 * login, cadastro de loja, aceite de convite, troca da própria senha/e-mail (SessionTokenService) e sessão
 * de suporte (superpainel, com "sid") criam a sessão sem que cada emissão precise lembrar disso.
 * Fora de uma requisição (comandos, testes unitários) o token sai como antes, sem "jti".
 */
export class SessionJwtService extends JwtService {
  override sign(
    payload: string,
    options?: Omit<JwtSignOptions, keyof SignOptions>,
  ): string;
  override sign(payload: Buffer, options?: JwtSignOptions): string;
  override sign<T extends object = object>(
    payload: T,
    options?: JwtSignOptions,
  ): string;
  override sign(
    payload: string | Buffer | object,
    options?: JwtSignOptions,
  ): string {
    const scope = currentSessionScope();
    if (typeof payload === 'string') {
      return super.sign(payload, options);
    }
    if (!scope || !isSessionPayload(payload)) {
      return super.sign(payload, options);
    }

    const jti = randomUUID();
    const sid = payload.sid;
    const support = sid !== undefined && sid !== null;
    const tokenVersion = typeof payload.tv === 'number' ? payload.tv : 0;

    // Sessão do site em cookie: só para sessões comuns (nunca a de suporte), uma por requisição
    if (!support && cookieSessionWanted(scope)) {
      const accessTtlSeconds = accessTokenTtlSeconds();
      const token = super.sign(
        { ...payload, jti },
        { ...options, expiresIn: accessTtlSeconds },
      );
      const refresh = createRefreshToken();
      scope.issued.push({
        jti,
        userId: payload.sub,
        kind: AuthSessionKind.USER,
        supportSessionId: null,
        tokenVersion,
        expiresAt: new Date(Date.now() + sessionMaxAgeSeconds() * 1000),
        transport: AuthSessionTransport.COOKIE,
        refresh: {
          selector: refresh.selector,
          hash: refresh.hash,
          token: refresh.token,
        },
        parentSessionId: null,
        accessToken: token,
        accessTtlSeconds,
      });
      return token;
    }

    const token = super.sign({ ...payload, jti }, options);
    const exp = this.decode<{ exp?: unknown } | null>(token)?.exp;
    scope.issued.push({
      jti,
      userId: payload.sub,
      kind: support ? AuthSessionKind.SUPPORT : AuthSessionKind.USER,
      supportSessionId: sid ?? null,
      tokenVersion,
      expiresAt:
        typeof exp === 'number'
          ? new Date(exp * 1000)
          : new Date(Date.now() + FALLBACK_SESSION_MS),
      transport: AuthSessionTransport.BEARER,
      // A sessão de suporte guarda a sessão do superadmin que a abriu (o refresh dela fica suspenso)
      parentSessionId: support ? requesterSessionId(scope) : null,
      accessToken: token,
    });
    return token;
  }

  /**
   * Token de acesso de uma sessão em cookie que já existe (renovação): o MESMO jti da família, validade
   * curta (JWT_ACCESS_EXPIRES_IN, nunca além do fim da sessão) e nenhuma linha nova em auth_sessions.
   */
  signForSession(
    subject: SessionSubject,
    jti: string,
    expiresInSeconds: number,
  ): string {
    return super.sign(sessionPayload(subject, { jti }), {
      expiresIn: Math.max(1, Math.floor(expiresInSeconds)),
    });
  }

  override signAsync(
    payload: string,
    options?: Omit<JwtSignOptions, keyof SignOptions>,
  ): Promise<string>;
  override signAsync(
    payload: Buffer,
    options?: JwtSignOptions,
  ): Promise<string>;
  override signAsync<T extends object = object>(
    payload: T,
    options?: JwtSignOptions,
  ): Promise<string>;
  /** Mesmo registro do sign() (o segredo é fixo: não há provedor assíncrono de chave). */
  override signAsync(
    payload: string | Buffer | object,
    options?: JwtSignOptions,
  ): Promise<string> {
    try {
      return Promise.resolve(this.sign(payload as object, options));
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}

/** Dados da conta que vão no token. */
export type SessionSubject = Pick<
  User,
  'id' | 'email' | 'role' | 'name' | 'token_version'
>;

/** Claims de sessão (sub, email, role, name, tv e, quando houver, sid e jti). */
function sessionPayload(
  user: SessionSubject,
  extra: Pick<JwtPayload, 'sid' | 'jti'> = {},
): JwtPayload {
  return {
    sub: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    tv: user.token_version ?? 0,
    ...(extra.sid !== undefined ? { sid: extra.sid } : {}),
    ...(extra.jti !== undefined ? { jti: extra.jti } : {}),
  };
}

/** A requisição pediu (e pode abrir) a sessão em cookie, e nenhuma foi assinada nela ainda? */
function cookieSessionWanted(scope: SessionScope): boolean {
  return (
    scope.transport === 'COOKIE' &&
    !scope.issued.some(
      (session) => session.transport === AuthSessionTransport.COOKIE,
    )
  );
}

/** Sessão (auth_sessions.id) do token de quem fez a requisição, se houver. */
function requesterSessionId(scope: SessionScope): number | null {
  const user = (scope.request as { user?: Partial<AuthUser> } | null)?.user;
  const id = user?.authSessionId;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Emissão dos tokens de sessão (login, troca da própria senha/e-mail, aceite de convite e cadastro de
 * loja). A claim "tv" leva a versão ATUAL das sessões da conta: incrementar users.token_version invalida
 * todos os tokens já emitidos. O "jti" e a sessão (auth_sessions) vêm do SessionJwtService.
 */
@Injectable()
export class SessionTokenService {
  constructor(private readonly jwt: JwtService) {}

  issue(user: SessionSubject, extra: Pick<JwtPayload, 'sid'> = {}): string {
    return this.jwt.sign(sessionPayload(user, { sid: extra.sid }));
  }
}
