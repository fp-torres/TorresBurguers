import { isDateKey } from '../../../utils/dates';
import { isValidEmail } from '../../../utils/validation';
import { AUDIT_RESULTS, type AuditResult } from '../../../services/platform/auditService';
import { EMPTY_AUTH_EVENT_FILTERS, type AuthEventFilters } from '../../../services/platform/authEventsService';
import { DEFAULT_USER_FILTERS, type PlatformUserFilters, type PlatformUserSort } from '../../../services/platform/usersService';
import type { UserRole } from '../../../utils/roles';
import { readIdParam } from '../Audit/urlFilters';
import { ROLE_FILTER_OPTIONS, SORT_OPTIONS } from './userLabels';

// Filtros da tela Usuários e acessos no endereço da página:
// contas: ?busca&perfil&loja&papel&situacao&lixeira&ordem · eventos: ?aba=eventos&conta&email&resultado&de&ate
// · detalhe: ?usuario=<id>.

export type UsersTab = 'contas' | 'eventos';

export function tabFromParams(params: URLSearchParams): UsersTab {
  return params.get('aba') === 'eventos' ? 'eventos' : 'contas';
}

/** Conta aberta no detalhe (?usuario=12). */
export function detailIdFromParams(params: URLSearchParams): number | null {
  return readIdParam(params, 'usuario');
}

export function userFiltersFromParams(params: URLSearchParams): { filters: PlatformUserFilters; search: string } {
  const role = (params.get('perfil') ?? '').toUpperCase();
  const platformRole = (params.get('papel') ?? '').toUpperCase();
  const status = params.get('situacao');
  const sort = (params.get('ordem') ?? '').toLowerCase();
  return {
    search: (params.get('busca') ?? '').slice(0, 100),
    filters: {
      ...DEFAULT_USER_FILTERS,
      role: ROLE_FILTER_OPTIONS.some((option) => option.value === role) ? (role as UserRole) : '',
      store_id: readIdParam(params, 'loja', 'store_id'),
      platform_role: platformRole === 'SUPER_ADMIN' || platformRole === 'NONE' ? platformRole : '',
      blocked: status === 'bloqueadas' ? true : status === 'livres' ? false : null,
      include_deleted: params.get('lixeira') === '1',
      sort: SORT_OPTIONS.some((option) => option.value === sort) ? (sort as PlatformUserSort) : 'created_at',
    },
  };
}

const USER_PARAM_NAMES = ['busca', 'perfil', 'loja', 'store_id', 'papel', 'situacao', 'lixeira', 'ordem'];

export function userFiltersToParams(filters: PlatformUserFilters, search: string, current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  USER_PARAM_NAMES.forEach((name) => next.delete(name));
  if (search.trim()) next.set('busca', search.trim());
  if (filters.role) next.set('perfil', filters.role);
  if (filters.store_id) next.set('loja', String(filters.store_id));
  if (filters.platform_role) next.set('papel', filters.platform_role);
  if (filters.blocked !== null) next.set('situacao', filters.blocked ? 'bloqueadas' : 'livres');
  if (filters.include_deleted) next.set('lixeira', '1');
  if (filters.sort !== 'created_at') next.set('ordem', filters.sort);
  return next;
}

export function hasUserFilters(filters: PlatformUserFilters, search: string): boolean {
  return search.trim() !== ''
    || (Object.keys(DEFAULT_USER_FILTERS) as (keyof PlatformUserFilters)[]).some((key) => filters[key] !== DEFAULT_USER_FILTERS[key]);
}

export function authEventFiltersFromParams(params: URLSearchParams): AuthEventFilters {
  const email = (params.get('email') ?? '').trim().toLowerCase();
  const result = (params.get('resultado') ?? '').toUpperCase();
  const from = params.get('de') ?? '';
  const to = params.get('ate') ?? '';
  return {
    ...EMPTY_AUTH_EVENT_FILTERS,
    user_id: readIdParam(params, 'conta', 'user_id'),
    email: isValidEmail(email) ? email : '',
    result: AUDIT_RESULTS.some((item) => item === result) ? (result as AuditResult) : '',
    from: isDateKey(from) ? from : '',
    to: isDateKey(to) ? to : '',
  };
}

const EVENT_PARAM_NAMES = ['conta', 'user_id', 'email', 'resultado', 'de', 'ate'];

export function authEventFiltersToParams(filters: AuthEventFilters, current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  EVENT_PARAM_NAMES.forEach((name) => next.delete(name));
  if (filters.user_id) next.set('conta', String(filters.user_id));
  if (filters.email) next.set('email', filters.email);
  if (filters.result) next.set('resultado', filters.result);
  if (filters.from) next.set('de', filters.from);
  if (filters.to) next.set('ate', filters.to);
  return next;
}

export function hasAuthEventFilters(filters: AuthEventFilters): boolean {
  return (Object.keys(EMPTY_AUTH_EVENT_FILTERS) as (keyof AuthEventFilters)[]).some((key) => filters[key] !== EMPTY_AUTH_EVENT_FILTERS[key]);
}
