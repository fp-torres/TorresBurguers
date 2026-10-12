import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<
      string[] | undefined
    >(ROLES_KEY, [context.getHandler(), context.getClass()]);

    // Rota sem @Roles: basta estar autenticado
    if (!requiredRoles) {
      return true;
    }

    // req.user vem da JwtStrategy com o perfil atual do banco
    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: { role?: string } | null }>();
    if (user?.role && requiredRoles.includes(user.role)) {
      return true;
    }

    throw new ForbiddenException(
      'Você não tem permissão para acessar este recurso.',
    );
  }
}
