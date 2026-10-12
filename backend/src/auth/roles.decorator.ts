import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

// Define quais perfis podem acessar a rota (conferido pelo RolesGuard, sempre depois do AuthGuard('jwt'))
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
