import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { OptionalAuthRequest } from '../auth/auth-user';
import { clientIpKey } from '../auth/link-token';
import {
  RateLimitService,
  teamWriteKey,
} from '../common/rate-limit/rate-limit.service';
import { isStoreAdmin } from './users.policy';

/**
 * POST /users (use depois do OptionalJwtAuthGuard): o limite de tentativas é conferido num guard,
 * ANTES de o corpo (inclusive o multipart com a foto) ser lido.
 * - ADMIN de loja (conta da equipe): TEAM_WRITE por loja;
 * - demais (cadastro público de cliente): SIGNUP por IP — toda tentativa conta, inclusive e-mail
 *   repetido ou corpo inválido.
 * Sessão de suporte não conta aqui: o interceptor global de somente leitura a recusa em seguida.
 */
@Injectable()
export class AccountCreationLimitGuard implements CanActivate {
  constructor(private readonly rateLimit: RateLimitService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<OptionalAuthRequest>();
    const actor = request.user ?? null;
    if (actor?.supportSession) return true;
    if (isStoreAdmin(actor)) {
      this.rateLimit.consume('TEAM_WRITE', teamWriteKey(actor.storeId));
    } else {
      this.rateLimit.consume('SIGNUP', clientIpKey(request));
    }
    return true;
  }
}
