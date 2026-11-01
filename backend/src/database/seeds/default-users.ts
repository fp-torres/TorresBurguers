import { PlatformRole, UserRole } from '../../users/entities/user.entity';
import { BRAND } from '../../config/brand';

export interface DefaultUser {
  name: string;
  email: string;
  password: string;
  phone: string;
  role: UserRole;
  /** Papel global na plataforma (só o superadmin de demonstração). */
  platformRole?: PlatformRole;
}

/**
 * Um usuário de demonstração para cada perfil do sistema (somente development/test).
 * A equipe (ADMIN, cozinha, entregador, atendente) pertence à loja padrão; o cliente é global;
 * o superadmin administra a plataforma inteira.
 * Documentados no README (seção "Usuários padrão") — mantenha os dois em sincronia.
 */
export const DEFAULT_USERS: DefaultUser[] = [
  {
    name: 'Administrador',
    email: `admin@${BRAND.domain}`,
    password: 'Admin@123',
    phone: '21900000001',
    role: UserRole.ADMIN,
  },
  {
    name: 'Cozinha',
    email: `cozinha@${BRAND.domain}`,
    password: 'Cozinha@123',
    phone: '21900000002',
    role: UserRole.KITCHEN,
  },
  {
    name: 'Entregador',
    email: `entregador@${BRAND.domain}`,
    password: 'Entregador@123',
    phone: '21900000003',
    role: UserRole.COURIER,
  },
  {
    name: 'Atendente',
    email: `atendente@${BRAND.domain}`,
    password: 'Atendente@123',
    phone: '21900000004',
    role: UserRole.EMPLOYEE,
  },
  {
    name: 'Cliente Demo',
    email: `cliente@${BRAND.domain}`,
    password: 'Cliente@123',
    phone: '21900000005',
    role: UserRole.CLIENT,
  },
  {
    name: 'Superadmin',
    email: `superadmin@${BRAND.domain}`,
    password: 'Superadmin@123',
    phone: '21900000006',
    role: UserRole.CLIENT,
    platformRole: PlatformRole.SUPER_ADMIN,
  },
];
