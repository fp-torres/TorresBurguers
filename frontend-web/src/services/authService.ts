import type { AxiosRequestConfig } from 'axios';
import api, {
  cookieAuthConfig, getApiErrorStatus, normalizePaginated, refreshSession, sessionEmissionConfig, toQuery, webLogout,
  type Paginated, type SessionTransport,
} from './api';

// Rotas de autenticação e conta (docs/saas/arquitetura.md §5.1).

/**
 * Resposta das rotas que autenticam: login, aceite de convite e cadastro de loja ({ access_token, user }).
 * A troca da própria senha (PATCH /users/:id) devolve o usuário com um access_token novo, aplicado no mesmo
 * formato. O AuthContext guarda só os campos permitidos do usuário.
 */
export interface AuthResponse {
  access_token: string;
  user: unknown;
  /**
   * Só quando o site pediu a sessão em cookie (X-Auth-Transport): 'cookie' (token de acesso curto, só em memória;
   * o refresh vai num cookie HttpOnly) ou 'bearer' (a API não pôde usar o cookie: o token de sempre).
   */
  session_transport?: SessionTransport;
  /** Validade do token de acesso em segundos (sessão em cookie). */
  expires_in?: number;
}

export function isAuthResponse(value: unknown): value is AuthResponse {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return typeof data.access_token === 'string' && data.access_token !== '' && !!data.user && typeof data.user === 'object';
}

/** Link de redefinição de senha válido (GET /auth/reset-password/:token). */
export interface ResetTokenInfo {
  email_masked: string;
  expires_at: string | null;
}

/** Sessão aberta da conta (GET /auth/sessions): um aparelho/navegador conectado. */
export interface AuthSessionInfo {
  id: number;
  /** USER: login comum; SUPPORT: sessão de suporte aberta pelo superpainel. */
  kind: 'USER' | 'SUPPORT';
  /** A sessão deste navegador. */
  current: boolean;
  created_at: string;
  expires_at: string;
  ip: string | null;
  /** Resumo do navegador ("Chrome no Windows", "Aplicativo no Android"...). */
  browser: string;
}

/** Tempo máximo do logout no servidor: sair nunca fica preso esperando a API. */
const LOGOUT_TIMEOUT_MS = 5_000;

function toSessionInfo(value: unknown): AuthSessionInfo | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = Number(raw.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  return {
    id,
    kind: raw.kind === 'SUPPORT' ? 'SUPPORT' : 'USER',
    current: raw.current === true,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
    expires_at: typeof raw.expires_at === 'string' ? raw.expires_at : '',
    ip: typeof raw.ip === 'string' && raw.ip ? raw.ip : null,
    browser: typeof raw.browser === 'string' && raw.browser ? raw.browser : 'Navegador desconhecido',
  };
}

export const authService = {
  /** POST /auth/login → { access_token, user }. */
  login: async (email: string, password: string) => {
    const response = await api.post<unknown>('/auth/login', { email, password }, cookieAuthConfig());
    return response.data;
  },

  /** POST /auth/web/refresh: renova a sessão em cookie desta aba (promessa única por aba, Web Lock entre abas). */
  refresh: () => refreshSession(),

  /** POST /auth/web/logout (5 s, melhor esforço): encerra a sessão do cookie deste navegador; true = 204. */
  webLogout: () => webLogout(LOGOUT_TIMEOUT_MS),

  /** GET /auth/me → SessionUser atual (+ support_session). */
  me: async (config?: AxiosRequestConfig) => {
    const response = await api.get<unknown>('/auth/me', config);
    return response.data;
  },

  /** POST /auth/logout-all: encerra todas as sessões da conta (inclusive esta). */
  logoutAll: async () => {
    // Na sessão em cookie, a resposta também apaga o cookie deste navegador
    await api.post('/auth/logout-all', undefined, sessionEmissionConfig());
  },

  /**
   * POST /auth/logout com o token informado (o da sessão que está saindo, mesmo que esta aba já tenha trocado
   * de sessão): o token deixa de valer no servidor; o de uma sessão de suporte também encerra o suporte.
   * Devolve true quando a sessão terminou (204) ou já não valia (401); false se a API não confirmou (sem
   * conexão, erro ou API sem a rota), para quem chama tentar outro caminho.
   */
  logout: async (token: string): Promise<boolean> => {
    try {
      await api.post('/auth/logout', undefined, {
        headers: { Authorization: `Bearer ${token}` },
        keepSessionOn401: true,
        timeout: LOGOUT_TIMEOUT_MS,
      });
      return true;
    } catch (error) {
      return getApiErrorStatus(error) === 401;
    }
  },

  /** GET /auth/sessions: sessões ativas da conta (a deste navegador primeiro), paginadas. */
  listSessions: async (page = 1, pageSize = 20, config?: AxiosRequestConfig): Promise<Paginated<AuthSessionInfo>> => {
    const { data } = await api.get<unknown>(`/auth/sessions${toQuery({ page, pageSize })}`, config);
    const result = normalizePaginated<unknown>(data, page, pageSize);
    return { ...result, items: result.items.map(toSessionInfo).filter((item): item is AuthSessionInfo => item !== null) };
  },

  /** DELETE /auth/sessions/:id: encerra uma sessão da conta (o aparelho dela precisa entrar de novo). */
  revokeSession: async (id: number) => {
    await api.delete(`/auth/sessions/${id}`);
  },

  /**
   * POST /auth/forgot-password → 202 { message }: sempre a mesma mensagem genérica (não revela se o e-mail
   * tem conta). Devolve essa mensagem ('' se a API não mandar).
   */
  forgotPassword: async (email: string): Promise<string> => {
    const { data } = await api.post<{ message?: unknown } | undefined>('/auth/forgot-password', { email });
    return typeof data?.message === 'string' ? data.message : '';
  },

  /** GET /auth/reset-password/:token: confere o link (404 se inválido, usado ou expirado). */
  checkResetToken: async (token: string): Promise<ResetTokenInfo> => {
    const { data } = await api.get<Partial<Record<keyof ResetTokenInfo, unknown>>>(`/auth/reset-password/${encodeURIComponent(token)}`);
    return {
      email_masked: typeof data?.email_masked === 'string' ? data.email_masked : '',
      expires_at: typeof data?.expires_at === 'string' ? data.expires_at : null,
    };
  },

  /**
   * POST /auth/reset-password → { message }: grava a nova senha e encerra TODAS as sessões da conta (não abre
   * uma nova: a pessoa entra de novo). Devolve a mensagem da API ('' se ela não mandar).
   */
  resetPassword: async (token: string, password: string): Promise<string> => {
    const { data } = await api.post<{ message?: unknown } | undefined>('/auth/reset-password', { token, password });
    return typeof data?.message === 'string' ? data.message : '';
  },
};
