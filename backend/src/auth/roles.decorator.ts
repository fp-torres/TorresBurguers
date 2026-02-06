import { SetMetadata } from '@nestjs/common';

// Cria a chave 'roles' para guardarmos quem pode acessar o quê
export const Roles = (...roles: string[]) => SetMetadata('roles', roles);