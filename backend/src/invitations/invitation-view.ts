import type { Invitation } from './entities/invitation.entity';

export const INVITATION_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'REVOKED',
  'EXPIRED',
] as const;

export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/** Convite como sai na API (lista de campos permitidos: nunca o hash do token). */
export interface InvitationView {
  id: number;
  store_id: number;
  email: string;
  role: string;
  make_owner: boolean;
  status: InvitationStatus;
  expires_at: Date;
  accepted_at: Date | null;
  accepted_user_id: number | null;
  revoked_at: Date | null;
  invited_by_user_id: number | null;
  created_at: Date;
}

export function invitationStatus(
  invitation: Pick<Invitation, 'accepted_at' | 'revoked_at' | 'expires_at'>,
  now: Date = new Date(),
): InvitationStatus {
  if (invitation.accepted_at) return 'ACCEPTED';
  if (invitation.revoked_at) return 'REVOKED';
  return new Date(invitation.expires_at).getTime() <= now.getTime()
    ? 'EXPIRED'
    : 'PENDING';
}

export function toInvitationView(
  invitation: Invitation,
  now: Date = new Date(),
): InvitationView {
  return {
    id: invitation.id,
    store_id: invitation.store_id,
    email: invitation.email,
    role: invitation.role,
    make_owner: invitation.make_owner,
    status: invitationStatus(invitation, now),
    expires_at: invitation.expires_at,
    accepted_at: invitation.accepted_at ?? null,
    accepted_user_id: invitation.accepted_user_id ?? null,
    revoked_at: invitation.revoked_at ?? null,
    invited_by_user_id: invitation.invited_by_user_id ?? null,
    created_at: invitation.created_at,
  };
}

/** Lista paginada (formato das rotas novas). */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
