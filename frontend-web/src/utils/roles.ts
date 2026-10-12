/** Perfis de acesso do sistema (mesmos valores do enum UserRole do backend). */
export type UserRole = 'ADMIN' | 'EMPLOYEE' | 'KITCHEN' | 'COURIER' | 'CLIENT';

/** Nome de cada perfil exibido na interface. */
export const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'Administrador',
  EMPLOYEE: 'Atendente',
  KITCHEN: 'Cozinha',
  COURIER: 'Entregador',
  CLIENT: 'Cliente',
};

/** Perfis da equipe: entram por /login e usam o painel interno. */
export const STAFF_ROLES: UserRole[] = ['ADMIN', 'EMPLOYEE', 'KITCHEN', 'COURIER'];

/** Perfis que conduzem o fluxo completo de pedidos (todas as colunas, despacho e cancelamento). */
export const ORDER_MANAGER_ROLES: UserRole[] = ['ADMIN', 'EMPLOYEE'];

export function roleLabel(role?: string | null): string {
  if (!role) return '';
  return Object.hasOwn(ROLE_LABELS, role) ? ROLE_LABELS[role as UserRole] : role;
}

export function isStaffRole(role?: string | null): boolean {
  return !!role && STAFF_ROLES.includes(role as UserRole);
}

export function isOrderManager(role?: string | null): boolean {
  return !!role && ORDER_MANAGER_ROLES.includes(role as UserRole);
}

/** Página inicial de cada perfil após o login: Administrador no Dashboard, demais da equipe nos Pedidos. */
export function homePathForRole(role?: string | null): string {
  if (role === 'ADMIN') return '/dashboard';
  if (isStaffRole(role)) return '/orders';
  return '/';
}
