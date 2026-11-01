import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { SUPPORT_READ_ONLY_MESSAGE } from '../users/users.policy';
import type { OptionalAuthRequest } from './auth-user';

/** Métodos que só leem (a sessão de suporte pode usá-los). */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const ALLOWED_IN_SUPPORT_SESSION = 'auth:allowedInSupportSession';

/**
 * Rota que altera dados mas vale com o token de suporte. Só para encerrar a própria sessão
 * (POST /auth/logout): sair nunca altera dados da loja nem da conta.
 */
export const AllowedInSupportSession = () =>
  SetMetadata(ALLOWED_IN_SUPPORT_SESSION, true);

/**
 * Sessão de suporte é SOMENTE LEITURA em toda a API (registrado como interceptor global no
 * AuthModule): qualquer método que altera dados com um token de suporte → 403, inclusive fora do
 * painel da loja (endereços, conta do próprio operador, "encerrar sessões"...). Exceção: rotas com
 * @AllowedInSupportSession() (o logout da própria sessão).
 *
 * Roda depois dos guards (req.user já preenchido pela JwtStrategy, nas rotas autenticadas e nas de
 * autenticação opcional) e ANTES dos interceptors da rota (o upload nem chega a ser lido). Os guards
 * que já recusam com a própria mensagem (painel da loja, superpainel, compras) continuam valendo.
 */
@Injectable()
export class SupportSessionReadOnlyInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const request = context.switchToHttp().getRequest<OptionalAuthRequest>();
      const method = (request.method ?? 'GET').toUpperCase();
      if (
        request.user?.supportSession &&
        !READ_METHODS.has(method) &&
        !this.reflector.getAllAndOverride<boolean>(ALLOWED_IN_SUPPORT_SESSION, [
          context.getHandler(),
          context.getClass(),
        ])
      ) {
        throw new ForbiddenException(SUPPORT_READ_ONLY_MESSAGE);
      }
    }
    return next.handle();
  }
}
