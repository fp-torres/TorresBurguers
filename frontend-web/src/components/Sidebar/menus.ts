import { STAFF_ROLES, type UserRole } from '../../utils/roles';

/** Item do menu lateral. */
export interface SidebarItem {
  name: string;
  /** Ícone Iconify (coleção Solar, variante bold-duotone, como o resto do painel). */
  icon: string;
  path: string;
  /** true: ativo só no endereço exato (ex.: a página inicial de uma área com subpáginas). */
  end?: boolean;
}

interface StaffMenuItem extends SidebarItem {
  roles: UserRole[];
}

// Painel da loja, por perfil (as rotas também são protegidas em routes/index.tsx)
const STAFF_MENU: StaffMenuItem[] = [
  { name: 'Dashboard', icon: 'solar:widget-5-bold-duotone', path: '/dashboard', roles: ['ADMIN'] },
  { name: 'Pedidos', icon: 'solar:bag-check-bold-duotone', path: '/orders', roles: STAFF_ROLES },
  { name: 'Clientes', icon: 'solar:user-heart-bold-duotone', path: '/customers', roles: ['ADMIN', 'EMPLOYEE'] },
  { name: 'Cardápio', icon: 'solar:chef-hat-bold-duotone', path: '/products', roles: ['ADMIN'] },
  { name: 'Equipe', icon: 'solar:users-group-rounded-bold-duotone', path: '/users', roles: ['ADMIN'] },
  { name: 'Lixeira', icon: 'solar:trash-bin-trash-bold-duotone', path: '/trash', roles: ['ADMIN'] },
  { name: 'Configurações', icon: 'solar:settings-bold-duotone', path: '/settings', roles: ['ADMIN'] },
  { name: 'Assinatura', icon: 'solar:card-bold-duotone', path: '/subscription', roles: ['ADMIN'] },
];

/** Itens do painel da loja visíveis para o perfil. */
export function staffMenuFor(role?: string | null): SidebarItem[] {
  return STAFF_MENU
    .filter((item) => !!role && item.roles.includes(role as UserRole))
    .map(({ name, icon, path, end }) => ({ name, icon, path, end }));
}

/** Superpainel (somente superadministrador). */
export const PLATFORM_MENU: SidebarItem[] = [
  { name: 'Dashboard', icon: 'solar:widget-5-bold-duotone', path: '/platform', end: true },
  { name: 'Estabelecimentos', icon: 'solar:shop-bold-duotone', path: '/platform/stores' },
  { name: 'Planos', icon: 'solar:layers-bold-duotone', path: '/platform/plans' },
  { name: 'Assinaturas', icon: 'solar:card-recive-bold-duotone', path: '/platform/subscriptions' },
  { name: 'Usuários e acessos', icon: 'solar:shield-user-bold-duotone', path: '/platform/users' },
  { name: 'Financeiro', icon: 'solar:wallet-money-bold-duotone', path: '/platform/finance' },
  { name: 'Auditoria', icon: 'solar:history-bold-duotone', path: '/platform/audit' },
  { name: 'Configurações', icon: 'solar:tuning-2-bold-duotone', path: '/platform/settings' },
];
