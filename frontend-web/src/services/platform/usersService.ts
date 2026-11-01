import api, { normalizePaginated, toQuery, type Paginated } from '../api';
import { asRecord, readDate, readEnum, readId, readNullableText, readText } from '../panelParsers';
import type { StoreAccountStatus } from '../../types/saas';
import type { UserRole } from '../../utils/roles';
import { parseAuditLogs, type AuditLogEntry } from './auditService';
import { STORE_ACCOUNT_STATUSES } from './insightsParsers';

// Superpainel › Usuários e acessos (somente SUPER_ADMIN; toda alteração é auditada):
// GET /platform/users, GET /platform/users/:id e POST /platform/users/:id/{block,unblock,revoke-sessions,password-reset}.
// Contrato: backend/src/platform/platform-users.controller.ts, platform-users.service.ts e
// platform-presenter.ts → presentPlatformUser (nunca o hash da senha nem a versão das sessões).

export interface PlatformUserStore {
  id: number;
  slug: string;
  name: string;
  account_status: StoreAccountStatus;
}

export interface PlatformUser {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  avatar: string | null;
  /** CLIENT, ADMIN, EMPLOYEE, KITCHEN ou COURIER. */
  role: string;
  /** 'SUPER_ADMIN' ou null. */
  platform_role: string | null;
  store_id: number | null;
  store: PlatformUserStore | null;
  blocked_at: string | null;
  blocked_reason: string | null;
  last_login_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** Na lixeira desde (null = conta ativa). */
  deleted_at: string | null;
}

export interface PlatformUserDetail extends PlatformUser {
  /** Responsável principal (stores.owner_user_id) da loja à qual pertence. */
  is_owner: boolean;
  /** Eventos de autenticação recentes (até 20): como autora, alvo ou pelo e-mail usado na tentativa. */
  recent_auth_events: AuditLogEntry[];
}

export type PlatformUserSort = 'created_at' | 'name' | 'email' | 'last_login_at';
export type PlatformRoleFilter = 'SUPER_ADMIN' | 'NONE';

/** Filtros de GET /platform/users (a API recusa parâmetros fora desta lista). */
export type PlatformUserFilters = {
  role: UserRole | '';
  store_id: number | null;
  platform_role: PlatformRoleFilter | '';
  /** true = só bloqueadas; false = só livres; null = todas. */
  blocked: boolean | null;
  include_deleted: boolean;
  sort: PlatformUserSort;
};

export const DEFAULT_USER_FILTERS: PlatformUserFilters = {
  role: '',
  store_id: null,
  platform_role: '',
  blocked: null,
  include_deleted: false,
  sort: 'created_at',
};

export interface PlatformUserListParams extends Partial<PlatformUserFilters> {
  page: number;
  pageSize: number;
  /** Nome, e-mail ou telefone. */
  search?: string;
}

export interface PasswordResetLink {
  /**
   * Link de uso único: aparece só nesta resposta, e só quando a API não o enviou por e-mail
   * (delivered=false: driver de log ou sem SMTP). Com o SMTP configurado, vem null.
   */
  url: string | null;
  /** true = o link foi só para o e-mail da conta (a mensagem traz o e-mail mascarado) e não aparece aqui. */
  delivered: boolean;
  expires_at: string | null;
  message: string;
}

function parseUserStore(value: unknown): PlatformUserStore | null {
  const raw = asRecord(value);
  const id = readId(raw.id);
  if (!id) return null;
  return {
    id,
    slug: readText(raw.slug),
    name: readText(raw.name) || `Loja #${id}`,
    account_status: readEnum(raw.account_status, STORE_ACCOUNT_STATUSES, 'ACTIVE'),
  };
}

export function parsePlatformUser(value: unknown): PlatformUser | null {
  const raw = asRecord(value);
  const id = readId(raw.id);
  if (!id) return null;
  return {
    id,
    name: readText(raw.name),
    email: readText(raw.email),
    phone: readNullableText(raw.phone),
    avatar: readNullableText(raw.avatar),
    role: readText(raw.role),
    platform_role: readNullableText(raw.platform_role),
    store_id: readId(raw.store_id) || null,
    store: parseUserStore(raw.store),
    blocked_at: readDate(raw.blocked_at),
    blocked_reason: readNullableText(raw.blocked_reason),
    last_login_at: readDate(raw.last_login_at),
    created_at: readDate(raw.created_at),
    updated_at: readDate(raw.updated_at),
    deleted_at: readDate(raw.deleted_at),
  };
}

export function parsePlatformUserDetail(value: unknown): PlatformUserDetail {
  const raw = asRecord(value);
  const user = parsePlatformUser(raw);
  if (!user) throw new Error('Resposta inválida da API: conta sem id.');
  return {
    ...user,
    is_owner: raw.is_owner === true,
    recent_auth_events: parseAuditLogs(raw.recent_auth_events),
  };
}

/**
 * Resposta do link de redefinição. Aceita também a forma antiga ({ url, expires_at, message }, sem delivered):
 * com url, o link é mostrado; sem url, a resposta só vale se a API disse que o enviou por e-mail.
 */
export function parsePasswordResetLink(value: unknown): PasswordResetLink {
  const raw = asRecord(value);
  const url = readText(raw.url) || null;
  const delivered = !url && raw.delivered === true;
  if (!url && !delivered) throw new Error('A API não devolveu o link de redefinição.');
  return { url, delivered, expires_at: readDate(raw.expires_at), message: readText(raw.message) };
}

function userPath(id: number, action?: string): string {
  return `/platform/users/${encodeURIComponent(String(id))}${action ? `/${action}` : ''}`;
}

export const platformUsersService = {
  /** GET /platform/users?search&role&store_id&platform_role&blocked&include_deleted&sort&page&pageSize */
  async list(params: PlatformUserListParams, signal?: AbortSignal): Promise<Paginated<PlatformUser>> {
    const query = toQuery({
      page: params.page,
      pageSize: params.pageSize,
      search: params.search,
      role: params.role,
      store_id: params.store_id,
      platform_role: params.platform_role,
      blocked: params.blocked,
      // Padrão da API: sem a lixeira (só envia quando incluir)
      include_deleted: params.include_deleted ? true : undefined,
      sort: params.sort && params.sort !== 'created_at' ? params.sort : undefined,
    });
    const { data } = await api.get<unknown>(`/platform/users${query}`, { signal });
    const page = normalizePaginated<unknown>(data, params.page, params.pageSize);
    return { ...page, items: page.items.map(parsePlatformUser).filter((user): user is PlatformUser => user !== null) };
  },

  /** GET /platform/users/:id: a conta (inclusive na lixeira) + eventos de autenticação recentes. */
  async detail(id: number, signal?: AbortSignal): Promise<PlatformUserDetail> {
    const { data } = await api.get<unknown>(userPath(id), { signal });
    return parsePlatformUserDetail(data);
  },

  /** POST /platform/users/:id/block { reason }: login recusado e sessões encerradas na hora. */
  async block(id: number, reason: string): Promise<PlatformUserDetail> {
    const { data } = await api.post<unknown>(userPath(id, 'block'), { reason: reason.trim() });
    return parsePlatformUserDetail(data);
  },

  /** POST /platform/users/:id/unblock */
  async unblock(id: number): Promise<PlatformUserDetail> {
    const { data } = await api.post<unknown>(userPath(id, 'unblock'));
    return parsePlatformUserDetail(data);
  },

  /** POST /platform/users/:id/revoke-sessions → { message, user }: todos os tokens da conta deixam de valer. */
  async revokeSessions(id: number): Promise<{ message: string; user: PlatformUserDetail | null }> {
    const { data } = await api.post<unknown>(userPath(id, 'revoke-sessions'));
    const raw = asRecord(data);
    const user = parsePlatformUser(raw.user) ? parsePlatformUserDetail(raw.user) : null;
    return {
      message: readText(raw.message, 'Todas as sessões da conta foram encerradas.'),
      user,
    };
  },

  /**
   * POST /platform/users/:id/password-reset → { url, delivered, expires_at, message }. delivered=true: o link
   * foi só para o e-mail da conta (url null); delivered=false: a url aparece uma única vez nesta resposta.
   * Erros: 403 para contas da plataforma e 503 quando o SMTP falha (nenhum link é gerado).
   */
  async passwordResetLink(id: number): Promise<PasswordResetLink> {
    const { data } = await api.post<unknown>(userPath(id, 'password-reset'));
    return parsePasswordResetLink(data);
  },
};
