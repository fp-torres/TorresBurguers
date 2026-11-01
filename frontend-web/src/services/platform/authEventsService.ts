import api, { toQuery, type Paginated } from '../api';
import { parseAuditPage, type AuditLogEntry, type AuditResult } from './auditService';

// Superpainel › Eventos de autenticação: GET /platform/auth-events (auditoria das ações auth.*: login,
// falhas de login, logout geral e redefinição de senha), paginada e mais recentes primeiro.
// Contrato: backend/src/platform/platform-users.controller.ts → authEvents e dto/platform-users.dto.ts.

/** Filtros aceitos pela API (?user_id&email&result&from&to); outros parâmetros são recusados. */
export type AuthEventFilters = {
  /** Eventos da conta (como autora ou alvo). */
  user_id: number | null;
  /** E-mail usado na tentativa (inclusive de contas inexistentes). */
  email: string;
  result: AuditResult | '';
  /** AAAA-MM-DD (dia inteiro no fuso da plataforma) ou data e hora ISO com fuso. */
  from: string;
  to: string;
};

export const EMPTY_AUTH_EVENT_FILTERS: AuthEventFilters = {
  user_id: null,
  email: '',
  result: '',
  from: '',
  to: '',
};

export interface AuthEventListParams extends Partial<AuthEventFilters> {
  page: number;
  pageSize: number;
}

export const platformAuthEventsService = {
  /** GET /platform/auth-events?user_id&email&result&from&to&page&pageSize */
  async list(params: AuthEventListParams, signal?: AbortSignal): Promise<Paginated<AuditLogEntry>> {
    const query = toQuery({
      page: params.page,
      pageSize: params.pageSize,
      user_id: params.user_id,
      email: params.email?.trim().toLowerCase(),
      result: params.result,
      from: params.from,
      to: params.to,
    });
    const { data } = await api.get<unknown>(`/platform/auth-events${query}`, { signal });
    return parseAuditPage(data, params.page, params.pageSize);
  },
};
