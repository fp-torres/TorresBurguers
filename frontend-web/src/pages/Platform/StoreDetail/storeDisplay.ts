import type { StatusTone } from '../../../components/ui';
import type { PlatformInvitationStatus } from '../../../services/platform/invitationsService';
import type { SupportSessionStatus } from '../../../services/platform/supportSessionsService';
import type { PlatformStoreDetail, PlatformStoreMember } from '../../../services/platform/storesService';
import { maskCEP, maskPhone } from '../../../utils/masks';
import { maskDocument } from '../../../utils/validation';

// Rótulos e formatos do detalhe do estabelecimento no superpainel.

export interface Meta {
  label: string;
  tone: StatusTone;
}

function metaOf<K extends string>(map: Record<K, Meta>, value: string | null | undefined): Meta {
  if (value && Object.hasOwn(map, value)) return map[value as K];
  return { label: value || '—', tone: 'neutral' };
}

// --- CADASTRO ---

export function formatDocument(value: string | null): string {
  if (!value) return '—';
  return maskDocument(value);
}

export function formatPhone(value: string | null): string {
  return value ? maskPhone(value) : '—';
}

/** "Av. Rio Branco, 156 – Loja B · Centro · Rio de Janeiro/RJ · CEP 20040-003" (null sem endereço). */
export function addressLine(store: PlatformStoreDetail): string | null {
  const street = [store.address_street, store.address_number].filter(Boolean).join(', ');
  const first = [street, store.address_complement].filter(Boolean).join(' – ');
  const city = [store.address_city, store.address_state].filter(Boolean).join('/');
  const parts = [first, store.address_neighborhood, city, store.address_zip_code ? `CEP ${maskCEP(store.address_zip_code)}` : null]
    .filter((part): part is string => !!part && part.trim() !== '');
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Administrador ativo desta loja (fora da lixeira e não bloqueado): pode ser o responsável. */
export function isOwnerCandidate(member: PlatformStoreMember): boolean {
  return member.role === 'ADMIN' && !member.blocked_at && !member.deleted_at;
}

/** Chave pública do Mercado Pago abreviada (é pública, mas não precisa aparecer inteira). */
export function shortKey(value: string | null): string {
  if (!value) return '—';
  return value.length > 16 ? `${value.slice(0, 12)}…${value.slice(-4)}` : value;
}

// --- CONVITES ---

const INVITATION_META: Record<PlatformInvitationStatus, Meta> = {
  PENDING: { label: 'Pendente', tone: 'info' },
  ACCEPTED: { label: 'Aceito', tone: 'success' },
  EXPIRED: { label: 'Expirado', tone: 'warning' },
  REVOKED: { label: 'Revogado', tone: 'neutral' },
};

export function invitationMeta(status: string): Meta {
  return metaOf(INVITATION_META, status);
}

// --- SESSÕES DE SUPORTE ---

const SUPPORT_META: Record<SupportSessionStatus, Meta> = {
  ACTIVE: { label: 'Ativa', tone: 'info' },
  ENDED: { label: 'Encerrada', tone: 'neutral' },
  EXPIRED: { label: 'Expirada', tone: 'neutral' },
};

export function supportSessionMeta(status: string): Meta {
  return metaOf(SUPPORT_META, status);
}
