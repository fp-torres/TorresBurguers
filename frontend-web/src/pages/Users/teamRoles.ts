import type { UserRole } from '../../utils/roles';

/** Perfis da equipe de uma loja (clientes têm conta global e não entram na equipe). */
export type TeamRole = Exclude<UserRole, 'CLIENT'>;

export const TEAM_ROLES: readonly TeamRole[] = ['ADMIN', 'EMPLOYEE', 'KITCHEN', 'COURIER'];

export function isTeamRole(role: unknown): role is TeamRole {
  return typeof role === 'string' && (TEAM_ROLES as readonly string[]).includes(role);
}

/** Opções do seletor de perfil, com o que cada um acessa. */
export const TEAM_ROLE_OPTIONS: { value: TeamRole; label: string }[] = [
  { value: 'ADMIN', label: 'Administrador (Acesso Total)' },
  { value: 'EMPLOYEE', label: 'Atendente (Gestão de Pedidos)' },
  { value: 'KITCHEN', label: 'Cozinha (Ver Pedidos)' },
  { value: 'COURIER', label: 'Entregador (Ver Entregas)' },
];

/** Plural de cada perfil (abas de filtro). */
export const TEAM_ROLE_PLURALS: Record<TeamRole, string> = {
  ADMIN: 'Administradores',
  EMPLOYEE: 'Atendentes',
  KITCHEN: 'Cozinha',
  COURIER: 'Entregadores',
};

// Cores por perfil: selo da coluna "Cargo" e avatar sem foto
export const ROLE_BADGE_CLASSES: Record<string, string> = {
  ADMIN: 'bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 border-purple-100 dark:border-purple-800',
  EMPLOYEE: 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border-emerald-100 dark:border-emerald-800',
  KITCHEN: 'bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300 border-orange-100 dark:border-orange-800',
  COURIER: 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-blue-100 dark:border-blue-800',
};
export const DEFAULT_BADGE_CLASSES = 'bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-100 dark:border-gray-700';

export const ROLE_AVATAR_CLASSES: Record<string, string> = {
  ADMIN: 'bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800',
  EMPLOYEE: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800',
  KITCHEN: 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 border-orange-200 dark:border-orange-800',
  COURIER: 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800',
};
export const DEFAULT_AVATAR_CLASSES = 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700';
