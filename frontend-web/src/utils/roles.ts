/** Perfis de acesso do sistema (mesmos valores do enum UserRole do backend). */
export type UserRole = 'ADMIN' | 'EMPLOYEE' | 'KITCHEN' | 'COURIER' | 'CLIENT';

/**
 * Papel global na plataforma (users.platform_role), separado do perfil da loja.
 * O superadministrador tem role CLIENT, nenhuma loja e platform_role SUPER_ADMIN.
 */
export type PlatformRole = 'SUPER_ADMIN';

/** Nome de cada perfil exibido na interface. */
export const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'Administrador',
  EMPLOYEE: 'Atendente',
  KITCHEN: 'Cozinha',
  COURIER: 'Entregador',
  CLIENT: 'Cliente',
};

/** Nome de cada papel global exibido na interface. */
export const PLATFORM_ROLE_LABELS: Record<PlatformRole, string> = {
  SUPER_ADMIN: 'Superadministrador',
};

/** Perfis da equipe: entram por /login e usam o painel interno. */
export const STAFF_ROLES: UserRole[] = ['ADMIN', 'EMPLOYEE', 'KITCHEN', 'COURIER'];

/** Perfis que conduzem o fluxo completo de pedidos (todas as colunas, despacho e cancelamento). */
export const ORDER_MANAGER_ROLES: UserRole[] = ['ADMIN', 'EMPLOYEE'];

/**
 * Campos da sessão usados nas regras de acesso (o User do AuthContext tem todos).
 * Estrutural para que estas funções sirvam para qualquer objeto com esse formato.
 */
export interface AccessSubject {
  role?: string | null;
  platform_role?: string | null;
  store_id?: number | null;
  support_session?: unknown;
}

export function roleLabel(role?: string | null): string {
  if (!role) return '';
  return Object.hasOwn(ROLE_LABELS, role) ? ROLE_LABELS[role as UserRole] : role;
}

export function platformRoleLabel(role?: string | null): string {
  if (!role) return '';
  return Object.hasOwn(PLATFORM_ROLE_LABELS, role) ? PLATFORM_ROLE_LABELS[role as PlatformRole] : role;
}

export function isStaffRole(role?: string | null): boolean {
  return !!role && STAFF_ROLES.includes(role as UserRole);
}

export function isOrderManager(role?: string | null): boolean {
  return !!role && ORDER_MANAGER_ROLES.includes(role as UserRole);
}

/**
 * Superadministrador operando o superpainel. Em uma sessão de suporte ele age como Administrador
 * da loja (somente leitura) e NÃO tem acesso ao superpainel — mesma regra do backend (isSuperAdmin).
 */
export function isPlatformAdmin(user?: AccessSubject | null): boolean {
  return user?.platform_role === 'SUPER_ADMIN' && !user.support_session;
}

/** Equipe de uma loja: perfil da equipe com loja vinculada (inclui o superadmin em sessão de suporte). */
export function isStoreStaff(user?: AccessSubject | null): boolean {
  return !!user && isStaffRole(user.role) && user.store_id !== null && user.store_id !== undefined;
}

/** Tem alguma área interna: o painel da loja (equipe) ou o superpainel (superadministrador). */
export function hasInternalAccess(user?: AccessSubject | null): boolean {
  return isPlatformAdmin(user) || isStaffRole(user?.role);
}

/** Página inicial de cada perfil após o login: Administrador no Dashboard, demais da equipe nos Pedidos. */
export function homePathForRole(role?: string | null): string {
  if (role === 'ADMIN') return '/dashboard';
  if (isStaffRole(role)) return '/orders';
  return '/';
}

/**
 * Página inicial do usuário: superadministrador no superpainel (/platform), Administrador no Dashboard,
 * demais da equipe nos Pedidos e cliente (ou visitante) no início do site.
 */
export function homePathForUser(user?: AccessSubject | null): string {
  if (isPlatformAdmin(user)) return '/platform';
  return homePathForRole(user?.role);
}
