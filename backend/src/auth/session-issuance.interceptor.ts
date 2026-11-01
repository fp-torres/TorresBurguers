import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, concatMap } from 'rxjs';
import { AuthSessionsService } from './auth-sessions.service';
import { AuthSessionTransport } from './entities/auth-session.entity';
import {
  runInSessionScope,
  type IssuedSession,
  type SessionScope,
} from './session-scope';
import {
  emissionTransport,
  readRefreshCookie,
  setRefreshCookie,
} from './web-session-cookie';

/** Campos aditivos do corpo de uma emissão pedida com X-Auth-Transport: cookie. */
export type SessionTransportName = 'cookie' | 'bearer';

/**
 * Global (registrado no AuthModule): cada rota HTTP roda num escopo próprio; os tokens de sessão assinados
 * nela (SessionJwtService) ganham a sessão em auth_sessions ANTES de a resposta sair. Assim, um token só
 * chega a quem pediu depois que a sessão dele existe (a JwtStrategy exige a sessão dos tokens com "jti").
 * Se a rota falhar depois de assinar um token, nada é gravado (o token não sai). Se a gravação falhar,
 * a resposta vira erro: o token não seria aceito.
 *
 * Sessão do site em cookie (só quando a requisição traz X-Auth-Transport: cookie, ver
 * web-session-cookie.ts): antes do handler, decide o transporte, sem nunca recusar a emissão (na dúvida,
 * bearer). Depois da gravação: (1) Set-Cookie do refresh; (2) encerra a sessão do cookie anterior deste
 * navegador (melhor esforço); (3) acrescenta session_transport e expires_in ao corpo que traz o
 * access_token emitido. Se o handler ou a gravação falharem, nenhum cookie sai. Sem o cabeçalho, nada muda.
 */
@Injectable()
export class SessionIssuanceInterceptor implements NestInterceptor {
  private readonly logger = new Logger(SessionIssuanceInterceptor.name);

  constructor(private readonly sessions: AuthSessionsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request>() ?? null;
    const scope: SessionScope = {
      request,
      issued: [],
      transport: emissionTransport(request),
    };
    return new Observable<unknown>((subscriber) =>
      runInSessionScope(scope, () =>
        next
          .handle()
          .pipe(
            concatMap(async (value: unknown) => {
              const issued = await this.sessions.persistIssued(scope);
              if (scope.transport === null || scope.transport === undefined) {
                return value;
              }
              return this.finishTransport(
                value,
                issued,
                request,
                http.getResponse<Response>(),
              );
            }),
          )
          .subscribe(subscriber),
      ),
    );
  }

  /** Cookie, sessão substituída e campos aditivos de uma emissão que pediu o transporte. */
  private async finishTransport(
    value: unknown,
    issued: IssuedSession[],
    request: Request | null,
    response: Response | undefined,
  ): Promise<unknown> {
    if (issued.length === 0) return value;
    const cookie = issued.find(
      (session) => session.transport === AuthSessionTransport.COOKIE,
    );
    if (cookie?.refresh && response) {
      setRefreshCookie(
        response,
        request,
        cookie.refresh.token,
        cookie.expiresAt,
      );
      const previous = readRefreshCookie(request);
      if (previous.present) {
        await this.sessions
          .revokeReplacedCookieSession(previous.value, issued, request)
          .catch((error: Error) =>
            this.logger.warn(
              `Falha ao encerrar a sessão substituída: ${error.message}`,
            ),
          );
      }
    }
    return withTransportFields(value, issued, cookie);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Corpo com access_token emitido nesta requisição: + session_transport ('cookie' com expires_in, ou
 * 'bearer'). Outros corpos (ex.: a sessão de suporte, sempre bearer, não traz o campo) ficam iguais.
 */
function withTransportFields(
  value: unknown,
  issued: IssuedSession[],
  cookie: IssuedSession | undefined,
): unknown {
  if (!isPlainObject(value) || typeof value.access_token !== 'string') {
    return value;
  }
  const token = value.access_token;
  const session = issued.find((item) => item.accessToken === token);
  if (!session || session.supportSessionId !== null) return value;
  if (cookie && session === cookie) {
    return {
      ...value,
      session_transport: 'cookie' satisfies SessionTransportName,
      expires_in: cookie.accessTtlSeconds,
    };
  }
  return {
    ...value,
    session_transport: 'bearer' satisfies SessionTransportName,
  };
}
