import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // 1. Vê qual cargo a rota exige (ex: ['ADMIN', 'KITCHEN'])
    const requiredRoles = this.reflector.getAllAndOverride<string[]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);

    // Se a rota não exige cargo nenhum, deixa passar
    if (!requiredRoles) {
      return true;
    }

    // 2. Pega o usuário que veio do Token (já validado pelo AuthGuard)
    const { user } = context.switchToHttp().getRequest();

    // 3. Verifica se o usuário tem ALGUM dos cargos necessários
    // Ex: Se a rota pede 'ADMIN' ou 'KITCHEN', e o user é 'KITCHEN', retorna true.
    return requiredRoles.some((role) => user.role === role);
  }
}