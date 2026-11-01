import type { StatusTone } from '../../../components/ui';
import type { PlatformUser, PlatformUserSort } from '../../../services/platform/usersService';
import { ROLE_LABELS, type UserRole } from '../../../utils/roles';

/** Situação da conta: na lixeira, bloqueada ou ativa. */
export function accountStatus(user: Pick<PlatformUser, 'deleted_at' | 'blocked_at'>): { label: string; tone: StatusTone } {
  if (user.deleted_at) return { label: 'Na lixeira', tone: 'neutral' };
  if (user.blocked_at) return { label: 'Bloqueada', tone: 'danger' };
  return { label: 'Ativa', tone: 'success' };
}

/** Perfis do filtro (mesmos valores do enum UserRole do backend). */
export const ROLE_FILTER_OPTIONS: { value: UserRole; label: string }[] = (
  ['CLIENT', 'ADMIN', 'EMPLOYEE', 'KITCHEN', 'COURIER'] as const
).map((role) => ({ value: role, label: ROLE_LABELS[role] }));

export const SORT_OPTIONS: { value: PlatformUserSort; label: string }[] = [
  { value: 'created_at', label: 'Mais recentes' },
  { value: 'last_login_at', label: 'Último acesso' },
  { value: 'name', label: 'Nome (A–Z)' },
  { value: 'email', label: 'E-mail (A–Z)' },
];

/** Cores do avatar sem foto por perfil (fundo suave, letra com contraste nos dois temas). */
export const AVATAR_CLASSES: Record<string, string> = {
  ADMIN: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300',
  EMPLOYEE: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
  KITCHEN: 'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300',
  COURIER: 'bg-teal-100 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300',
  CLIENT: 'bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-200',
};

export const PLATFORM_AVATAR_CLASS = 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300';

/** Iniciais do avatar ("Maria Souza" → "MS"). */
export function initials(name: string, email = ''): string {
  const words = (name || email).trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0][0]}${words[words.length - 1][0]}` : (words[0] ?? '?').slice(0, 1);
  return letters.toUpperCase();
}
