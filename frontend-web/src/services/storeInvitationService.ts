import api, { normalizePaginated, toQuery } from './api';
import { asRecord, readBoolean, readDate, readEnum, readId, readText } from './panelParsers';
import type { UserRole } from '../utils/roles';

// Convites para a equipe da PRÓPRIA loja (Administrador; docs/saas/arquitetura.md §5.1 e §5.2).
// A loja vem do token: nenhuma chamada envia store_id.

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
const INVITATION_STATUSES: readonly InvitationStatus[] = ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'];

/** Perfis que podem ser convidados (clientes não são convidados). */
export type InvitableRole = Exclude<UserRole, 'CLIENT'>;
const INVITABLE_ROLES: readonly InvitableRole[] = ['ADMIN', 'EMPLOYEE', 'KITCHEN', 'COURIER'];

export interface StoreInvitation {
  id: number;
  email: string;
  role: InvitableRole;
  status: InvitationStatus;
  /**
   * Convite de troca do responsável pela loja, criado pela administração da plataforma: a loja não pode
   * cancelá-lo (DELETE responde 403) nem convidar o mesmo e-mail de novo (409).
   */
  make_owner: boolean;
  expires_at: string | null;
  created_at: string | null;
}

export interface CreatedInvitation {
  invitation: StoreInvitation;
  /** Link de aceite: aparece só nesta resposta (também vai por e-mail quando houver provedor). null = só por e-mail. */
  url: string | null;
  /** true = a API enviou o convite só ao e-mail da pessoa e não devolveu o link (url null). */
  delivered: boolean;
  /** Aviso da API sobre o envio (ex.: e-mail mascarado); vazio se não houver. */
  message: string;
}

export interface InvitationListParams {
  page: number;
  pageSize: number;
  status?: InvitationStatus;
}

export function toInvitation(value: unknown): StoreInvitation {
  const raw = asRecord(value);
  return {
    id: readId(raw.id),
    email: readText(raw.email),
    role: readEnum(raw.role, INVITABLE_ROLES, 'EMPLOYEE'),
    status: readEnum(raw.status, INVITATION_STATUSES, 'PENDING'),
    make_owner: readBoolean(raw.make_owner, false),
    expires_at: readDate(raw.expires_at),
    created_at: readDate(raw.created_at),
  };
}

/** Convite que a loja pode cancelar: o de troca do responsável (make_owner) pendente é da plataforma (403). */
export function canStoreRevokeInvitation(invitation: Pick<StoreInvitation, 'make_owner' | 'status'>): boolean {
  return !(invitation.make_owner && invitation.status === 'PENDING');
}

/** Resposta da criação: { invitation, url } e, com o envio por e-mail, { url: null, delivered: true }. */
export function toCreatedInvitation(value: unknown): CreatedInvitation {
  const raw = asRecord(value);
  const url = readText(raw.url) || null;
  return {
    invitation: toInvitation(raw.invitation),
    url,
    delivered: !url && raw.delivered === true,
    message: readText(raw.message),
  };
}

export const storeInvitationService = {
  /** GET /store/invitations?page&pageSize&status → { items, total, page, pageSize }. */
  list: async (params: InvitationListParams, signal?: AbortSignal) => {
    const response = await api.get<unknown>(`/store/invitations${toQuery({ ...params })}`, { signal });
    const page = normalizePaginated<unknown>(response.data, params.page, params.pageSize);
    return { ...page, items: page.items.map(toInvitation) };
  },

  /**
   * POST /store/invitations { email, role } → { invitation, url }. 403 = sem vaga na equipe do plano;
   * 409 = e-mail com conta ou com convite de troca do responsável pendente; 429 = limite diário de convites
   * (por e-mail ou da loja), com a mensagem da API.
   */
  create: async (email: string, role: InvitableRole): Promise<CreatedInvitation> => {
    const response = await api.post<unknown>('/store/invitations', { email, role });
    return toCreatedInvitation(response.data);
  },

  /** DELETE /store/invitations/:id: revoga o convite (409 se já foi aceito; 403 no de troca do responsável). */
  revoke: async (id: number) => {
    const response = await api.delete<unknown>(`/store/invitations/${id}`);
    return toInvitation(response.data);
  },
};
