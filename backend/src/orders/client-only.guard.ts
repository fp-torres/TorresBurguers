import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

/**
 * Pedidos e pagamentos são feitos só por clientes (use depois do AuthGuard('jwt')).
 * Roda antes da validação do corpo, então a equipe recebe 403 com a mensagem certa.
 * Contas da plataforma (superadmin, que tem role CLIENT sem loja) também não compram: o papel global
 * é administrativo e fica separado da operação das lojas.
 */
@Injectable()
export class ClientOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest<{
      user?: { role?: string; platformRole?: string | null } | null;
    }>();
    if (user?.platformRole) {
      throw new ForbiddenException(
        'Contas da administração da plataforma não fazem pedidos. Use uma conta de cliente.',
      );
    }
    if (user?.role === 'CLIENT') return true;
    throw new ForbiddenException(
      'Somente clientes fazem pedidos e pagamentos. Contas da equipe não compram pelo sistema.',
    );
  }
}
