import api, { normalizePaginated, toQuery, type Paginated } from '../api';
import { asRecord, readBoolean, readDate, readId, readText, readTextList } from '../panelParsers';
import { readCode, readOptionalId } from './billingParsers';

// Superpainel › Convites da equipe de uma loja (backend: platform/platform-stores.controller.ts e
// invitations/invitations.service.ts): GET/POST /platform/stores/:id/invitations e DELETE /platform/invitations/:id.
// O link de aceite aparece uma única vez, na resposta da criação (o banco guarda só o hash do token).

export type PlatformInvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
export const PLATFORM_INVITATION_STATUSES: readonly PlatformInvitationStatus[] = ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'];

/** Perfis da equipe que podem ser convidados (clientes têm conta global e não são convidados). */
export type InvitableRole = 'ADMIN' | 'EMPLOYEE' | 'KITCHEN' | 'COURIER';
export const INVITABLE_ROLES: readonly InvitableRole[] = ['ADMIN', 'EMPLOYEE', 'KITCHEN', 'COURIER'];

export interface PlatformInvitation {
  id: number;
  store_id: number;
  email: string;
  role: string;
  /** Torna o convidado o responsável principal da loja ao aceitar. */
  make_owner: boolean;
  status: PlatformInvitationStatus;
  expires_at: string | null;
  accepted_at: string | null;
  accepted_user_id: number | null;
  revoked_at: string | null;
  invited_by_user_id: number | null;
  created_at: string | null;
}

export interface InvitationListParams {
  page: number;
  pageSize: number;
  status?: PlatformInvitationStatus;
}

export interface CreateInvitationPayload {
  email: string;
  role: InvitableRole;
  /** Só com o perfil ADMIN (outro perfil → 400). */
  make_owner?: boolean;
}

export interface CreatedPlatformInvitation {
  invitation: PlatformInvitation;
  /**
   * Link de uso único: exibido só agora, e só quando a API não o enviou por e-mail. Com o SMTP configurado, a API
   * manda o link só ao convidado e devolve url null com delivered true.
   */
  url: string | null;
  /** true = o convite foi enviado ao e-mail do convidado (o link não aparece para o operador). */
  delivered: boolean;
  /** Aviso da API sobre o envio (ex.: e-mail mascarado do convidado); vazio se não houver. */
  message: string;
  /** Ex.: loja sem assinatura vigente ou equipe do plano no limite (o convite é criado mesmo assim). */
  warnings: string[];
}

/** Resposta da criação: { invitation, url, warnings } e, a partir da leva 9, { url: null, delivered: true }. */
export function parseCreatedPlatformInvitation(value: unknown): CreatedPlatformInvitation {
  const raw = asRecord(value);
  const url = readText(raw.url) || null;
  return {
    invitation: toPlatformInvitation(raw.invitation),
    url,
    delivered: !url && raw.delivered === true,
    message: readText(raw.message),
    warnings: readTextList(raw.warnings),
  };
}

export function toPlatformInvitation(value: unknown): PlatformInvitation {
  const raw = asRecord(value);
  return {
    id: readId(raw.id),
    store_id: readId(raw.store_id),
    email: readText(raw.email),
    role: readText(raw.role),
    make_owner: readBoolean(raw.make_owner, false),
    status: readCode<PlatformInvitationStatus>(raw.status),
    expires_at: readDate(raw.expires_at),
    accepted_at: readDate(raw.accepted_at),
    accepted_user_id: readOptionalId(raw.accepted_user_id),
    revoked_at: readDate(raw.revoked_at),
    invited_by_user_id: readOptionalId(raw.invited_by_user_id),
    created_at: readDate(raw.created_at),
  };
}

export const platformInvitationsService = {
  /** GET /platform/stores/:id/invitations?status&page&pageSize (mais novos primeiro). */
  list: async (storeId: number, params: InvitationListParams, signal?: AbortSignal): Promise<Paginated<PlatformInvitation>> => {
    const response = await api.get<unknown>(`/platform/stores/${storeId}/invitations${toQuery({ ...params })}`, { signal });
    const page = normalizePaginated<unknown>(response.data, params.page, params.pageSize);
    return { ...page, items: page.items.map(toPlatformInvitation) };
  },

  /**
   * POST /platform/stores/:id/invitations → { invitation, url, delivered, warnings }. Substitui um convite pendente
   * para o mesmo e-mail. 409 = o e-mail já tem conta; 400 = loja desativada ou responsável sem o perfil ADMIN.
   */
  create: async (storeId: number, payload: CreateInvitationPayload): Promise<CreatedPlatformInvitation> => {
    const response = await api.post<unknown>(`/platform/stores/${storeId}/invitations`, payload);
    return parseCreatedPlatformInvitation(response.data);
  },

  /** DELETE /platform/invitations/:id: o link deixa de funcionar (409 se já foi aceito). */
  revoke: async (invitationId: number): Promise<PlatformInvitation> => {
    const response = await api.delete<unknown>(`/platform/invitations/${invitationId}`);
    return toPlatformInvitation(response.data);
  },
};
