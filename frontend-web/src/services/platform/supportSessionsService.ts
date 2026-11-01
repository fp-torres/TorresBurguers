import api, { normalizePaginated, toQuery, type Paginated } from '../api';
import { asRecord, isRecord, readBoolean, readDate, readId, readNullableText, readText } from '../panelParsers';
import { readCode, readOptionalId } from './billingParsers';

// Superpainel › Sessões de suporte (backend: platform/platform-support-sessions.controller.ts e
// support-sessions.service.ts): acesso assistido, temporário, SOMENTE LEITURA e auditado ao painel de uma loja.
// O token devolvido ao abrir a sessão vale só para o painel da loja e aparece uma única vez.

export const SUPPORT_REASON_MIN_LENGTH = 10;
export const SUPPORT_REASON_MAX_LENGTH = 300;

export type SupportSessionStatus = 'ACTIVE' | 'ENDED' | 'EXPIRED';

export interface PlatformSupportSession {
  id: number;
  store_id: number;
  store: { id: number; slug: string; name: string } | null;
  platform_user_id: number | null;
  /** Superadministrador que abriu a sessão. */
  platform_user: { id: number; name: string; email: string } | null;
  reason: string;
  started_at: string | null;
  expires_at: string | null;
  ended_at: string | null;
  ip: string | null;
  status: SupportSessionStatus;
  /** Aberta e dentro do prazo. */
  active: boolean;
}

export interface SupportSessionListParams {
  page: number;
  pageSize: number;
  store_id?: number;
  platform_user_id?: number;
  /** true = abertas e no prazo; false = encerradas ou expiradas. */
  active?: boolean;
}

export interface StartedSupportSession {
  /** Token da sessão de suporte (somente leitura, desta loja). Nunca é exibido nem guardado fora da sessão. */
  access_token: string;
  expires_at: string | null;
  session: PlatformSupportSession;
}

export function toSupportSession(value: unknown): PlatformSupportSession {
  const raw = asRecord(value);
  const store = isRecord(raw.store) ? raw.store : null;
  const user = isRecord(raw.platform_user) ? raw.platform_user : null;
  return {
    id: readId(raw.id),
    store_id: readId(raw.store_id),
    store: store ? { id: readId(store.id), slug: readText(store.slug), name: readText(store.name) } : null,
    platform_user_id: readOptionalId(raw.platform_user_id),
    platform_user: user ? { id: readId(user.id), name: readText(user.name), email: readText(user.email) } : null,
    reason: readText(raw.reason),
    started_at: readDate(raw.started_at),
    expires_at: readDate(raw.expires_at),
    ended_at: readDate(raw.ended_at),
    ip: readNullableText(raw.ip),
    status: readCode<SupportSessionStatus>(raw.status),
    active: readBoolean(raw.active, false),
  };
}

export const platformSupportSessionsService = {
  /** GET /platform/support-sessions?store_id&platform_user_id&active&page&pageSize (mais recentes primeiro). */
  list: async (params: SupportSessionListParams, signal?: AbortSignal): Promise<Paginated<PlatformSupportSession>> => {
    const response = await api.get<unknown>(`/platform/support-sessions${toQuery({ ...params })}`, { signal });
    const page = normalizePaginated<unknown>(response.data, params.page, params.pageSize);
    return { ...page, items: page.items.map(toSupportSession) };
  },

  /**
   * POST /platform/stores/:id/support-sessions { reason } → { access_token, expires_at, session }.
   * 400 = loja desativada ou motivo curto/longo demais (a API explica).
   */
  start: async (storeId: number, reason: string): Promise<StartedSupportSession> => {
    const response = await api.post<unknown>(`/platform/stores/${storeId}/support-sessions`, { reason });
    const raw = asRecord(response.data);
    return {
      access_token: readText(raw.access_token),
      expires_at: readDate(raw.expires_at),
      session: toSupportSession(raw.session),
    };
  },

  /** POST /platform/support-sessions/:id/end: o token da sessão deixa de valer na hora (idempotente). */
  end: async (sessionId: number): Promise<PlatformSupportSession> => {
    const response = await api.post<unknown>(`/platform/support-sessions/${sessionId}/end`);
    return toSupportSession(response.data);
  },
};
