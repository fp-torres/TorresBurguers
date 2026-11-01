import { BRAND } from './env';

/**
 * Usuários padrão criados pelo seed do backend (um por perfil + superadmin de demonstração).
 * A equipe pertence à loja demo (E2E.demoStoreSlug); cliente e superadmin são globais (sem loja).
 * Mantenha em sincronia com backend/src/database/seeds/default-users.ts e com a tabela do README.
 */
export const DEFAULT_USERS = {
  admin: { name: 'Administrador', email: `admin@${BRAND.domain}`, password: 'Admin@123', role: 'ADMIN' },
  kitchen: { name: 'Cozinha', email: `cozinha@${BRAND.domain}`, password: 'Cozinha@123', role: 'KITCHEN' },
  courier: { name: 'Entregador', email: `entregador@${BRAND.domain}`, password: 'Entregador@123', role: 'COURIER' },
  employee: { name: 'Atendente', email: `atendente@${BRAND.domain}`, password: 'Atendente@123', role: 'EMPLOYEE' },
  client: { name: 'Cliente Demo', email: `cliente@${BRAND.domain}`, password: 'Cliente@123', role: 'CLIENT' },
  // role CLIENT + platform_role SUPER_ADMIN: papéis da plataforma e da loja são separados
  superadmin: { name: 'Superadmin', email: `superadmin@${BRAND.domain}`, password: 'Superadmin@123', role: 'CLIENT' },
} as const;

export type DefaultUserKey = keyof typeof DEFAULT_USERS;
