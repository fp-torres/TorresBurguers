import api, { normalizePaginated, toQuery, type Paginated } from '../api';
import { asRecord, isRecord, readArray, readDate, readId, readNullableText, readText } from '../panelParsers';
import { parseStoreRef, type InsightsStoreRef } from './insightsParsers';

// Superpainel › Auditoria: GET /platform/audit e GET /platform/stores/:id/audit (paginadas, mais recentes
// primeiro). Também é o formato dos eventos de autenticação (GET /platform/auth-events e recent_auth_events do
// detalhe da conta). Contrato: backend/src/platform/platform-presenter.ts → presentAuditLog; filtros em
// dto/platform-audit.dto.ts e platform-audit.service.ts. Os metadados já chegam sem senhas, tokens ou segredos
// (sanitizeForAudit no backend).

export type AuditResult = 'SUCCESS' | 'FAILURE' | 'DENIED';
export type AuditActorScope = 'PLATFORM' | 'STORE' | 'SYSTEM' | 'ANONYMOUS';

export const AUDIT_RESULTS: readonly AuditResult[] = ['SUCCESS', 'FAILURE', 'DENIED'];
export const AUDIT_ACTOR_SCOPES: readonly AuditActorScope[] = ['PLATFORM', 'STORE', 'SYSTEM', 'ANONYMOUS'];

/** Nome de uma ação ou de um grupo de ações aceito pela API: minúsculas, números, "_" e "." (até 80). */
export const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9_.]{0,79}$/;
/** Tipo do alvo de uma ação (ex.: user, plan, subscription_invoice): minúsculas, números e "_" (até 40). */
export const AUDIT_TARGET_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
/** Identificador do alvo (ids numéricos ou chaves): letras, números, ".", ":", "-" e "_" (até 64). */
export const AUDIT_TARGET_ID_PATTERN = /^[\w.:-]{1,64}$/;

/** Tipos de alvo gravados pelo backend (AuditService.record → targetType). */
export type AuditTargetType =
  | 'user' | 'store' | 'plan' | 'subscription' | 'subscription_invoice' | 'invitation' | 'support_session'
  | 'order' | 'payment' | 'product' | 'platform_settings' | 'uploads';

export interface AuditActor {
  id: number | null;
  name: string | null;
  email: string | null;
}

export interface AuditLogEntry {
  id: number;
  created_at: string | null;
  /** Ex.: platform.store.suspend, user.block, auth.login.failure. */
  action: string;
  /** SUCCESS, FAILURE ou DENIED (valores desconhecidos chegam como vieram). */
  result: string;
  /** PLATFORM, STORE, SYSTEM ou ANONYMOUS. */
  actor_scope: string;
  actor: AuditActor | null;
  store_id: number | null;
  store: InsightsStoreRef | null;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Filtros de GET /platform/audit (a API recusa parâmetros fora desta lista).
 * from/to: AAAA-MM-DD (dia inteiro no fuso da plataforma) ou data e hora ISO com fuso.
 */
export type AuditFilters = {
  store_id: number | null;
  actor_id: number | null;
  /**
   * Ação ou grupo, respeitando os segmentos do nome: "plan" traz plan e plan.* (nunca platform.*);
   * "auth.login" traz auth.login.success e auth.login.failure; terminado em ponto ("plan."), só o grupo.
   */
  action: string;
  /** Tipo do alvo (ex.: user, plan, subscription). */
  target_type: string;
  /** Identificador do alvo: só vale junto com target_type (sem o tipo, a API responde 400). */
  target_id: string;
  result: AuditResult | '';
  actor_scope: AuditActorScope | '';
  from: string;
  to: string;
};

export const EMPTY_AUDIT_FILTERS: AuditFilters = {
  store_id: null,
  actor_id: null,
  action: '',
  target_type: '',
  target_id: '',
  result: '',
  actor_scope: '',
  from: '',
  to: '',
};

/** Filtros de GET /platform/stores/:id/audit: os mesmos, com a loja fixa (vem da rota). */
export type StoreAuditFilters = Omit<AuditFilters, 'store_id'>;

export const EMPTY_STORE_AUDIT_FILTERS: StoreAuditFilters = {
  actor_id: null,
  action: '',
  target_type: '',
  target_id: '',
  result: '',
  actor_scope: '',
  from: '',
  to: '',
};

export function parseAuditLog(value: unknown): AuditLogEntry | null {
  const raw = asRecord(value);
  const id = readId(raw.id);
  if (!id) return null;
  const actor = isRecord(raw.actor) ? raw.actor : null;
  const actorId = actor ? readId(actor.id) : 0;
  return {
    id,
    created_at: readDate(raw.created_at),
    action: readText(raw.action),
    result: readText(raw.result),
    actor_scope: readText(raw.actor_scope),
    actor: actor
      ? { id: actorId || null, name: readNullableText(actor.name), email: readNullableText(actor.email) }
      : null,
    store_id: readId(raw.store_id) || null,
    store: parseStoreRef(raw.store),
    target_type: readNullableText(raw.target_type),
    target_id: raw.target_id === null || raw.target_id === undefined ? null : String(raw.target_id),
    ip: readNullableText(raw.ip),
    user_agent: readNullableText(raw.user_agent),
    metadata: isRecord(raw.metadata) ? raw.metadata : null,
  };
}

export function parseAuditLogs(value: unknown): AuditLogEntry[] {
  return readArray(value).map(parseAuditLog).filter((entry): entry is AuditLogEntry => entry !== null);
}

/** Página da API com os registros conferidos. */
export function parseAuditPage(value: unknown, page: number, pageSize: number): Paginated<AuditLogEntry> {
  const result = normalizePaginated<unknown>(value, page, pageSize);
  return { ...result, items: parseAuditLogs(result.items) };
}

export interface AuditListParams extends Partial<AuditFilters> {
  page: number;
  pageSize: number;
}

export interface StoreAuditListParams extends Partial<StoreAuditFilters> {
  page: number;
  pageSize: number;
}

/** Parâmetros comuns às duas rotas (a ação e o tipo do alvo vão em minúsculas; o id do alvo só com o tipo). */
function commonQuery(params: StoreAuditListParams) {
  const targetType = params.target_type?.trim().toLowerCase() ?? '';
  return {
    page: params.page,
    pageSize: params.pageSize,
    actor_id: params.actor_id,
    action: params.action?.trim().toLowerCase(),
    target_type: targetType,
    target_id: targetType ? params.target_id?.trim() : undefined,
    result: params.result,
    actor_scope: params.actor_scope,
    from: params.from,
    to: params.to,
  };
}

export const platformAuditService = {
  /** GET /platform/audit?store_id&actor_id&action&target_type&target_id&result&actor_scope&from&to&page&pageSize */
  async list(params: AuditListParams, signal?: AbortSignal): Promise<Paginated<AuditLogEntry>> {
    const query = toQuery({ ...commonQuery(params), store_id: params.store_id });
    const { data } = await api.get<unknown>(`/platform/audit${query}`, { signal });
    return parseAuditPage(data, params.page, params.pageSize);
  },

  /** GET /platform/stores/:id/audit: a mesma trilha, só da loja da rota (mesmos filtros, sem store_id). */
  async listForStore(storeId: number, params: StoreAuditListParams, signal?: AbortSignal): Promise<Paginated<AuditLogEntry>> {
    const { data } = await api.get<unknown>(`/platform/stores/${storeId}/audit${toQuery(commonQuery(params))}`, { signal });
    return parseAuditPage(data, params.page, params.pageSize);
  },
};
