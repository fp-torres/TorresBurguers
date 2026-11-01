import api, { cookieAuthConfig } from './api';
import type { UserRole } from '../utils/roles';

// Convites para a equipe de uma loja (docs/saas/arquitetura.md §5.1).

/** Convite válido (GET /invitations/:token). */
export interface InvitationInfo {
  store: { name: string; slug: string; logo: string | null };
  /** E-mail convidado, mascarado pela API (ex.: "jo***@email.com"). */
  email_masked: string;
  role: UserRole;
  expires_at: string | null;
}

/** Dados para criar a conta da equipe ao aceitar o convite. */
export interface AcceptInvitationPayload {
  name: string;
  password: string;
  phone?: string;
}

function toInvitationInfo(data: unknown): InvitationInfo {
  const raw = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const store = (raw.store && typeof raw.store === 'object' ? raw.store : {}) as Record<string, unknown>;
  return {
    store: {
      name: typeof store.name === 'string' ? store.name : '',
      slug: typeof store.slug === 'string' ? store.slug : '',
      logo: typeof store.logo === 'string' && store.logo ? store.logo : null,
    },
    email_masked: typeof raw.email_masked === 'string' ? raw.email_masked : '',
    role: (typeof raw.role === 'string' ? raw.role : 'EMPLOYEE') as UserRole,
    expires_at: typeof raw.expires_at === 'string' ? raw.expires_at : null,
  };
}

export const invitationService = {
  /** GET /invitations/:token: dados do convite (404 se inválido, usado, revogado ou expirado). */
  get: async (token: string) => {
    const response = await api.get<unknown>(`/invitations/${encodeURIComponent(token)}`);
    return toInvitationInfo(response.data);
  },

  /** POST /invitations/:token/accept: cria a conta da equipe e faz login → { access_token, user }. */
  accept: async (token: string, payload: AcceptInvitationPayload) => {
    // Abre a sessão como o login: em cookie quando a API permite (ver cookieAuthConfig)
    const response = await api.post<unknown>(`/invitations/${encodeURIComponent(token)}/accept`, payload, cookieAuthConfig());
    return response.data;
  },
};
