import type { StatusTone } from '../../../components/ui';
import type { PlanFeatureKey, StoreAvailability } from '../../../services/storeAccess';
import type {
  BillingInterval, PlanLimitKey, PlatformInvoice, PlatformSubscription,
} from '../../../services/platform/billingParsers';
import { formatMegabytes } from '../../../services/storeSubscriptionService';
import { formatCurrency } from '../../../utils/format';
import { timeOf } from '../../../utils/dates';

// Rótulos e formatos da cobrança SaaS no superpainel (assinaturas, faturas, planos e situação da loja).
// Usados pela tela de Assinaturas, pela aba Assinatura do estabelecimento e pela tela de Planos.

// --- PLANOS ---

export const INTERVAL_LABELS: Record<BillingInterval, string> = { MONTHLY: 'Mensal', YEARLY: 'Anual' };
const INTERVAL_UNITS: Record<BillingInterval, string> = { MONTHLY: 'mês', YEARLY: 'ano' };

/** "R$ 99,90 / mês", "R$ 990,00 / ano" ou "Gratuito". */
export function planPriceLabel(price: number | null | undefined, interval: BillingInterval | null | undefined): string {
  if (price === null || price === undefined) return '—';
  if (!(price > 0)) return 'Gratuito';
  return `${formatCurrency(price)} / ${INTERVAL_UNITS[interval ?? 'MONTHLY']}`;
}

export const PLAN_LIMIT_LABELS: Record<PlanLimitKey, string> = {
  staff_users: 'Equipe ativa',
  products: 'Produtos no cardápio',
  monthly_orders: 'Pedidos no mês',
};

/** Limite de armazenamento (plans.max_storage_mb): fora de PLAN_LIMIT_LABELS, o uso é medido em MB. */
export const STORAGE_LIMIT_LABEL = 'Armazenamento';

/** Limite de armazenamento: "500 MB", "2 GB" ou "Ilimitado" (null). */
export function storageLimitLabel(mb: number | null): string {
  return mb === null ? 'Ilimitado' : formatMegabytes(mb);
}

/** Limite do plano: número ou "Ilimitado" (null). */
export function limitLabel(limit: number | null): string {
  return limit === null ? 'Ilimitado' : new Intl.NumberFormat('pt-BR').format(limit);
}

export const FEATURE_SHORT_LABELS: Record<PlanFeatureKey, string> = {
  online_payments: 'Pagamentos online',
  advanced_reports: 'Relatórios',
  custom_branding: 'Identidade visual',
};

// --- ASSINATURAS ---

export const PROVIDER_LABELS: Record<string, string> = {
  MANUAL: 'Manual (registrado no superpainel)',
  MERCADO_PAGO: 'Mercado Pago (cobrança automática)',
};

export function providerLabel(provider: string | null | undefined): string {
  if (!provider) return '—';
  return PROVIDER_LABELS[provider] ?? provider;
}

const PROVIDER_SHORT_LABELS: Record<string, string> = { MANUAL: 'Manual', MERCADO_PAGO: 'Mercado Pago' };

/** Rótulo curto (tabelas). */
export function providerShortLabel(provider: string | null | undefined): string {
  if (!provider) return '—';
  return PROVIDER_SHORT_LABELS[provider] ?? provider;
}

/** Tipos gravados em subscription_events.type (billing/subscription-rules.ts). */
export const SUBSCRIPTION_EVENT_LABELS: Record<string, string> = {
  CREATED: 'Assinatura criada',
  STATUS_CHANGED: 'Situação alterada',
  PLAN_CHANGED: 'Plano alterado',
  CANCEL_SCHEDULED: 'Cancelamento agendado',
  CANCEL_REVERTED: 'Cancelamento desfeito',
  PERIOD_RENEWED: 'Período renovado',
  INVOICE_CREATED: 'Fatura gerada',
  INVOICE_VOIDED: 'Fatura anulada',
  INVOICE_RESCHEDULED: 'Vencimento remarcado',
  PAYMENT_SUCCEEDED: 'Pagamento confirmado',
  PAYMENT_FAILED: 'Pagamento recusado',
  PAYMENT_AMOUNT_MISMATCH: 'Pagamento com valor diferente da fatura',
  PAYMENT_AFTER_CANCEL: 'Pagamento recebido após o cancelamento',
  CHECKOUT_CREATED: 'Link de pagamento criado',
  PROVIDER_STATUS_CHANGED: 'Situação no provedor alterada',
  PROVIDER_SYNC_FAILED: 'Falha ao sincronizar com o provedor',
};

export function eventLabel(type: string): string {
  return SUBSCRIPTION_EVENT_LABELS[type] ?? type;
}

export interface SubscriptionActions {
  changePlan: boolean;
  cancel: boolean;
  /** Cancelar no fim do período (há período pago a vencer e nada agendado). */
  cancelAtPeriodEnd: boolean;
  /** Desfazer o cancelamento agendado (POST /platform/subscriptions/:id/resume). */
  resume: boolean;
  reactivate: boolean;
  suspend: boolean;
  createInvoice: boolean;
}

/**
 * Ações possíveis pela situação (transições de billing/subscription-rules.ts): CANCELED é final; só
 * ACTIVE/PAST_DUE podem ser suspensas; só SUSPENDED/PAST_DUE podem ser reativadas. O cancelamento agendado
 * pode ser desfeito enquanto o período não terminou (mesma regra da API, que responde 409 fora dela).
 */
export function subscriptionActions(subscription: PlatformSubscription, now: number): SubscriptionActions {
  const { status } = subscription;
  const known = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED'].includes(status);
  const periodEnd = timeOf(subscription.current_period_end);
  return {
    changePlan: known,
    cancel: known,
    cancelAtPeriodEnd: known && !subscription.cancel_at_period_end && periodEnd !== null && periodEnd > now,
    resume: known && subscription.cancel_at_period_end && (periodEnd === null || periodEnd > now),
    reactivate: status === 'SUSPENDED' || status === 'PAST_DUE',
    suspend: status === 'ACTIVE' || status === 'PAST_DUE',
    createInvoice: known,
  };
}

// --- FATURAS ---

const INVOICE_METHOD_LABELS: Record<string, string> = {
  PIX: 'PIX',
  BOLETO: 'Boleto',
  TICKET: 'Boleto',
  CREDIT_CARD: 'Cartão de crédito',
  DEBIT_CARD: 'Cartão de débito',
  TRANSFER: 'Transferência',
  BANK_TRANSFER: 'Transferência',
  CASH: 'Dinheiro',
  ACCOUNT_MONEY: 'Saldo Mercado Pago',
};

/** Formas de pagamento sugeridas no registro manual (texto livre aceito pela API, até 40 caracteres). */
export const MANUAL_PAYMENT_METHODS: { value: string; label: string }[] = [
  { value: 'PIX', label: 'PIX' },
  { value: 'BOLETO', label: 'Boleto' },
  { value: 'TRANSFER', label: 'Transferência' },
  { value: 'CREDIT_CARD', label: 'Cartão de crédito' },
  { value: 'DEBIT_CARD', label: 'Cartão de débito' },
  { value: 'CASH', label: 'Dinheiro' },
];

export function invoiceMethodLabel(method: string | null | undefined): string {
  if (!method) return '—';
  return INVOICE_METHOD_LABELS[method.trim().toUpperCase()] ?? method;
}

/** Fatura em aberto (ou recusada) com o vencimento já passado. */
export function isInvoiceOverdue(invoice: Pick<PlatformInvoice, 'status' | 'due_at'>, now: number): boolean {
  const due = timeOf(invoice.due_at);
  return (invoice.status === 'OPEN' || invoice.status === 'FAILED') && due !== null && due < now;
}

/** Ainda pode ser paga, recusada ou anulada. */
export function isInvoiceUnpaid(invoice: Pick<PlatformInvoice, 'status'>): boolean {
  return invoice.status === 'OPEN' || invoice.status === 'FAILED';
}

// --- SITUAÇÃO EFETIVA DA LOJA (storeAccessState) ---

export const AVAILABILITY_META: Record<StoreAvailability, { label: string; tone: StatusTone }> = {
  OPERATIONAL: { label: 'Operando', tone: 'success' },
  PAST_DUE: { label: 'Vendendo com cobrança em atraso', tone: 'warning' },
  SUSPENDED: { label: 'Suspensa pela plataforma', tone: 'warning' },
  SUBSCRIPTION_SUSPENDED: { label: 'Assinatura suspensa', tone: 'danger' },
  SUBSCRIPTION_CANCELED: { label: 'Assinatura cancelada', tone: 'danger' },
  NO_SUBSCRIPTION: { label: 'Sem assinatura', tone: 'danger' },
  INACTIVE: { label: 'Desativada', tone: 'neutral' },
};
