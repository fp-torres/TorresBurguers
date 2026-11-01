import type { StatusTone } from '../components/ui/StatusBadge';
import type { InvoiceStatus, StoreAccountStatus, SubscriptionStatus } from '../types/saas';

// Rótulos e tons (StatusBadge) das situações do modelo SaaS, iguais no painel da loja e no superpainel.

export interface StatusMeta {
  label: string;
  tone: StatusTone;
}

/** Situação cadastral do estabelecimento. */
export const STORE_ACCOUNT_STATUS: Record<StoreAccountStatus, StatusMeta> = {
  ACTIVE: { label: 'Ativo', tone: 'success' },
  SUSPENDED: { label: 'Suspenso', tone: 'warning' },
  INACTIVE: { label: 'Desativado', tone: 'neutral' },
};

/** Situação da assinatura SaaS. */
export const SUBSCRIPTION_STATUS: Record<SubscriptionStatus, StatusMeta> = {
  TRIALING: { label: 'Em teste', tone: 'info' },
  ACTIVE: { label: 'Ativa', tone: 'success' },
  PAST_DUE: { label: 'Inadimplente', tone: 'warning' },
  SUSPENDED: { label: 'Suspensa', tone: 'danger' },
  CANCELED: { label: 'Cancelada', tone: 'neutral' },
};

/** Situação de uma fatura SaaS. */
export const INVOICE_STATUS: Record<InvoiceStatus, StatusMeta> = {
  OPEN: { label: 'Em aberto', tone: 'warning' },
  PAID: { label: 'Paga', tone: 'success' },
  FAILED: { label: 'Falhou', tone: 'danger' },
  VOID: { label: 'Anulada', tone: 'neutral' },
};

/** Rótulo e tom de um valor da API; valores desconhecidos aparecem como vieram, em tom neutro. */
export function statusMeta<K extends string>(map: Record<K, StatusMeta>, value?: string | null): StatusMeta {
  if (value && Object.hasOwn(map, value)) return map[value as K];
  return { label: value || '—', tone: 'neutral' };
}
