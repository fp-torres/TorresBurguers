import { isDateKey } from '../../../utils/dates';
import {
  AUDIT_ACTION_PATTERN, AUDIT_ACTOR_SCOPES, AUDIT_RESULTS, AUDIT_TARGET_ID_PATTERN, AUDIT_TARGET_TYPE_PATTERN, EMPTY_AUDIT_FILTERS,
  type AuditActorScope, type AuditFilters, type AuditResult, type AuditTargetType,
} from '../../../services/platform/auditService';

// Filtros das listas do superpainel no endereço da página (compartilháveis e preservados ao recarregar).
// Nomes em português; os nomes da API (store_id, actor_id...) também são aceitos na leitura.

/** Id positivo do primeiro parâmetro presente (ex.: readIdParam(params, 'loja', 'store_id')). */
export function readIdParam(params: URLSearchParams, ...names: string[]): number | null {
  for (const name of names) {
    const raw = params.get(name);
    if (raw && /^\d{1,9}$/.test(raw)) {
      const id = Number(raw);
      if (id > 0) return id;
    }
  }
  return null;
}

function readParam(params: URLSearchParams, ...names: string[]): string {
  for (const name of names) {
    const raw = params.get(name);
    if (raw) return raw.trim();
  }
  return '';
}

function readChoice<T extends string>(params: URLSearchParams, allowed: readonly T[], ...names: string[]): T | '' {
  const value = readParam(params, ...names).toUpperCase();
  return allowed.find((item) => item === value) ?? '';
}

function readDateParam(params: URLSearchParams, ...names: string[]): string {
  const value = readParam(params, ...names);
  return isDateKey(value) ? value : '';
}

/**
 * Filtros da auditoria a partir de ?loja&autor&acao&alvo_tipo&alvo&resultado&origem&de&ate (valores inválidos
 * são ignorados). O alvo só vale com o tipo (?alvo_tipo=user&alvo=12): sozinho, a API recusaria (400).
 */
export function auditFiltersFromParams(params: URLSearchParams): AuditFilters {
  const action = readParam(params, 'acao', 'action').toLowerCase();
  const targetType = readParam(params, 'alvo_tipo', 'target_type').toLowerCase();
  const validType = AUDIT_TARGET_TYPE_PATTERN.test(targetType) ? targetType : '';
  const targetId = readParam(params, 'alvo', 'target_id');
  return {
    ...EMPTY_AUDIT_FILTERS,
    store_id: readIdParam(params, 'loja', 'store_id'),
    actor_id: readIdParam(params, 'autor', 'actor_id'),
    action: AUDIT_ACTION_PATTERN.test(action) ? action : '',
    target_type: validType,
    target_id: validType && AUDIT_TARGET_ID_PATTERN.test(targetId) ? targetId : '',
    result: readChoice<AuditResult>(params, AUDIT_RESULTS, 'resultado', 'result'),
    actor_scope: readChoice<AuditActorScope>(params, AUDIT_ACTOR_SCOPES, 'origem', 'actor_scope'),
    from: readDateParam(params, 'de', 'from'),
    to: readDateParam(params, 'ate', 'to'),
  };
}

const AUDIT_PARAM_NAMES = [
  'loja', 'store_id', 'autor', 'actor_id', 'acao', 'action', 'alvo_tipo', 'target_type', 'alvo', 'target_id',
  'resultado', 'result', 'origem', 'actor_scope', 'de', 'from', 'ate', 'to',
];

/** Endereço com os filtros da auditoria (os outros parâmetros da página são mantidos). */
export function auditFiltersToParams(filters: AuditFilters, current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  AUDIT_PARAM_NAMES.forEach((name) => next.delete(name));
  const entries: [string, string | number | null][] = [
    ['loja', filters.store_id],
    ['autor', filters.actor_id],
    ['acao', filters.action],
    ['alvo_tipo', filters.target_type],
    ['alvo', filters.target_type ? filters.target_id : ''],
    ['resultado', filters.result],
    ['origem', filters.actor_scope],
    ['de', filters.from],
    ['ate', filters.to],
  ];
  for (const [name, value] of entries) {
    if (value !== null && value !== '') next.set(name, String(value));
  }
  return next;
}

/** Algum filtro diferente do padrão. */
export function hasAuditFilters(filters: AuditFilters): boolean {
  return (Object.keys(EMPTY_AUDIT_FILTERS) as (keyof AuditFilters)[]).some((key) => filters[key] !== EMPTY_AUDIT_FILTERS[key]);
}

/**
 * Link para a auditoria geral já filtrada. Ex.: auditUrl({ target_type: 'plan', target_id: 3 }) →
 * "/platform/audit?alvo_tipo=plan&alvo=3"; auditUrl({ actor_id: 12 }) → "/platform/audit?autor=12".
 */
export function auditUrl(filters: Partial<Omit<AuditFilters, 'target_type' | 'target_id'>> & {
  /** Um dos tipos gravados pelo backend ou '' (sem filtro de alvo). */
  target_type?: AuditTargetType | '';
  target_id?: string | number | null;
}): string {
  const params = auditFiltersToParams({
    ...EMPTY_AUDIT_FILTERS,
    ...filters,
    target_type: filters.target_type ?? '',
    target_id: filters.target_id === null || filters.target_id === undefined ? '' : String(filters.target_id),
  }, new URLSearchParams());
  const query = params.toString();
  return query ? `/platform/audit?${query}` : '/platform/audit';
}
