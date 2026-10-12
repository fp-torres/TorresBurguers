import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * Pedidos e pagamentos são feitos só por clientes (use depois do AuthGuard('jwt')).
 * Roda antes da validação do corpo, então a equipe recebe 403 com a mensagem certa.
 */
@Injectable()
export class ClientOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: { role?: string } | null }>();
    if (user?.role === 'CLIENT') return true;
    throw new ForbiddenException(
      'Somente clientes fazem pedidos e pagamentos. Contas da equipe não compram pelo sistema.',
    );
  }
}
