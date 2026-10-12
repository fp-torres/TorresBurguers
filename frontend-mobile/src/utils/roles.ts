/** Perfis de acesso definidos pelo backend. */
export type UserRole = 'ADMIN' | 'EMPLOYEE' | 'KITCHEN' | 'COURIER' | 'CLIENT';

/** Perfis da equipe (acessam o painel em vez da loja). */
export type StaffRole = Exclude<UserRole, 'CLIENT'>;

export const STAFF_ROLES: StaffRole[] = ['ADMIN', 'EMPLOYEE', 'KITCHEN', 'COURIER'];

export const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'Administrador',
  EMPLOYEE: 'Atendente',
  KITCHEN: 'Cozinha',
  COURIER: 'Entregador',
  CLIENT: 'Cliente',
};

/** Ordem usada nos filtros e seletores de perfil. */
export const ALL_ROLES: UserRole[] = ['ADMIN', 'EMPLOYEE', 'KITCHEN', 'COURIER', 'CLIENT'];

export function isStaffRole(role?: string | null): role is StaffRole {
  return !!role && (STAFF_ROLES as string[]).includes(role);
}

export function roleLabel(role?: string | null): string {
  if (!role) return '';
  return ROLE_LABELS[role as UserRole] ?? role;
}
