import {
  asRecord, isRecord, readArray, readBoolean, readDate, readId, readNullableNumber, readNullableText, readNumber, readText,
} from '../panelParsers';
import { toFeatures, toStoreAccess, type StoreAccess, type StoreFeatures } from '../storeAccess';
import { toPlanStorage, type PlanStorage } from '../storeSubscriptionService';
import type { InvoiceStatus, StoreAccountStatus, SubscriptionStatus } from '../../types/saas';

// Leitura defensiva das respostas da cobrança SaaS no superpainel (backend: billing/billing-presenter.ts e
// billing-queries.service.ts). Campos ausentes viram valores seguros; situações desconhecidas são mantidas
// como vieram (a tela mostra o código, em tom neutro, em vez de inventar uma situação).

export type BillingInterval = 'MONTHLY' | 'YEARLY';
export type PlanStatus = 'ACTIVE' | 'INACTIVE';

export const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELED'];
export const INVOICE_STATUSES: readonly InvoiceStatus[] = ['OPEN', 'PAID', 'FAILED', 'VOID'];
export const STORE_ACCOUNT_STATUSES: readonly StoreAccountStatus[] = ['ACTIVE', 'SUSPENDED', 'INACTIVE'];

/** Texto de uma lista fechada mantido como veio (valor desconhecido continua visível); não texto → ''. */
export function readCode<T extends string>(value: unknown): T {
  return (typeof value === 'string' ? value : '') as T;
}

/** Inteiro positivo ou null (ids opcionais). */
export function readOptionalId(value: unknown): number | null {
  const id = readId(value);
  return id > 0 ? id : null;
}

// --- PLANOS ---

export interface PlatformPlan {
  id: number;
  code: string;
  name: string;
  description: string | null;
  /** Preço por período (0 = gratuito/interno). */
  price: number;
  currency: string;
  billing_interval: BillingInterval;
  /** Preço por mês (anual ÷ 12), calculado pela API. */
  monthly_price: number;
  trial_days: number;
  /** Limites (null = ilimitado). */
  max_staff_users: number | null;
  max_products: number | null;
  max_monthly_orders: number | null;
  /** Armazenamento das imagens da loja em MB (1 MB = 1.048.576 bytes; fotos de perfil não contam). */
  max_storage_mb: number | null;
  features: StoreFeatures;
  /** ACTIVE = disponível para novas contratações. */
  status: PlanStatus;
  /** Aparece na página pública de planos e no autoatendimento. */
  is_public: boolean;
  sort_order: number;
  created_at: string | null;
  updated_at: string | null;
  /** Assinaturas não canceladas no plano (null quando a API não informou). */
  active_subscriptions: number | null;
}

function readInterval(value: unknown): BillingInterval {
  return value === 'YEARLY' ? 'YEARLY' : 'MONTHLY';
}

export function toPlatformPlan(value: unknown): PlatformPlan {
  const raw = asRecord(value);
  const price = readNumber(raw.price, 0);
  const interval = readInterval(raw.billing_interval);
  return {
    id: readId(raw.id),
    code: readText(raw.code),
    name: readText(raw.name, 'Plano'),
    description: readNullableText(raw.description),
    price,
    currency: readText(raw.currency, 'BRL'),
    billing_interval: interval,
    monthly_price: readNumber(raw.monthly_price, interval === 'YEARLY' ? price / 12 : price),
    trial_days: readNumber(raw.trial_days, 0),
    max_staff_users: readNullableNumber(raw.max_staff_users),
    max_products: readNullableNumber(raw.max_products),
    max_monthly_orders: readNullableNumber(raw.max_monthly_orders),
    max_storage_mb: readNullableNumber(raw.max_storage_mb),
    features: toFeatures(raw.features),
    status: raw.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
    is_public: readBoolean(raw.is_public, false),
    sort_order: readNumber(raw.sort_order, 0),
    created_at: readDate(raw.created_at),
    updated_at: readDate(raw.updated_at),
    active_subscriptions: readNullableNumber(raw.active_subscriptions),
  };
}

/** Plano resumido das listas de assinaturas. */
export interface PlanSummary {
  id: number;
  code: string;
  name: string;
  price: number | null;
  billing_interval: BillingInterval | null;
  status: PlanStatus | null;
}

export function toPlanSummary(value: unknown): PlanSummary | null {
  if (!isRecord(value)) return null;
  return {
    id: readId(value.id),
    code: readText(value.code),
    name: readText(value.name, 'Plano'),
    price: readNullableNumber(value.price),
    billing_interval: value.billing_interval === undefined ? null : readInterval(value.billing_interval),
    status: value.status === 'INACTIVE' ? 'INACTIVE' : value.status === 'ACTIVE' ? 'ACTIVE' : null,
  };
}

// --- LOJA RESUMIDA ---

export interface BillingStoreSummary {
  id: number;
  slug: string;
  name: string;
  logo: string | null;
  account_status: StoreAccountStatus;
}

export function toBillingStore(value: unknown): BillingStoreSummary | null {
  if (!isRecord(value)) return null;
  return {
    id: readId(value.id),
    slug: readText(value.slug),
    name: readText(value.name, 'Estabelecimento'),
    logo: readNullableText(value.logo),
    account_status: readCode<StoreAccountStatus>(value.account_status),
  };
}

// --- ASSINATURAS ---

export interface PlatformSubscription {
  id: number;
  store_id: number;
  plan_id: number;
  status: SubscriptionStatus;
  trial_ends_at: string | null;
  current_period_start: string | null;
  /** Fim do período pago (null = sem vencimento: planos gratuitos/internos). */
  current_period_end: string | null;
  /** Cancelamento agendado para o fim do período. */
  cancel_at_period_end: boolean;
  /** Quem agendou o cancelamento: PLATFORM (superpainel; a loja não desfaz) ou STORE (a própria loja). null = sem agendamento. */
  cancel_scheduled_by: 'PLATFORM' | 'STORE' | null;
  canceled_at: string | null;
  past_due_since: string | null;
  grace_period_ends_at: string | null;
  suspended_at: string | null;
  /**
   * Quem suspendeu: PLATFORM (superadmin — só a reativação pelo superpainel desfaz; pagamento não) ou
   * BILLING (fim da tolerância — pagar as faturas vencidas reativa). null fora da suspensão.
   */
  suspended_by: 'PLATFORM' | 'BILLING' | null;
  /** MANUAL (registro pelo superadmin) ou MERCADO_PAGO. */
  billing_provider: string;
  provider_subscription_id: string | null;
  provider_status: string | null;
  provider_checkout_url: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export function toPlatformSubscription(value: unknown): PlatformSubscription {
  const raw = asRecord(value);
  return {
    id: readId(raw.id),
    store_id: readId(raw.store_id),
    plan_id: readId(raw.plan_id),
    status: readCode<SubscriptionStatus>(raw.status),
    trial_ends_at: readDate(raw.trial_ends_at),
    current_period_start: readDate(raw.current_period_start),
    current_period_end: readDate(raw.current_period_end),
    cancel_at_period_end: readBoolean(raw.cancel_at_period_end, false),
    cancel_scheduled_by: raw.cancel_scheduled_by === 'PLATFORM' || raw.cancel_scheduled_by === 'STORE' ? raw.cancel_scheduled_by : null,
    canceled_at: readDate(raw.canceled_at),
    past_due_since: readDate(raw.past_due_since),
    grace_period_ends_at: readDate(raw.grace_period_ends_at),
    suspended_at: readDate(raw.suspended_at),
    suspended_by: raw.suspended_by === 'PLATFORM' || raw.suspended_by === 'BILLING' ? raw.suspended_by : null,
    billing_provider: readText(raw.billing_provider, 'MANUAL'),
    provider_subscription_id: readNullableText(raw.provider_subscription_id),
    provider_status: readNullableText(raw.provider_status),
    provider_checkout_url: readNullableText(raw.provider_checkout_url),
    created_at: readDate(raw.created_at),
    updated_at: readDate(raw.updated_at),
  };
}

/** Item de GET /platform/subscriptions: assinatura + loja + plano resumidos. */
export interface PlatformSubscriptionItem extends PlatformSubscription {
  store: BillingStoreSummary | null;
  plan: PlanSummary | null;
}

export function toSubscriptionItem(value: unknown): PlatformSubscriptionItem {
  const raw = asRecord(value);
  return { ...toPlatformSubscription(raw), store: toBillingStore(raw.store), plan: toPlanSummary(raw.plan) };
}

// --- USO E LIMITES DO PLANO ---

// Armazenamento das imagens (campo storage das respostas): o mesmo formato no painel da loja e no superpainel
export { toPlanStorage, type PlanStorage };

export type PlanLimitKey = 'staff_users' | 'products' | 'monthly_orders';
export const PLAN_LIMIT_KEYS: readonly PlanLimitKey[] = ['staff_users', 'products', 'monthly_orders'];

/** Uso atual da loja (null quando a API não informou o item). */
export type PlanUsage = Record<PlanLimitKey, number | null>;
/** Limites do plano (null = ilimitado). */
export type PlanLimits = Record<PlanLimitKey, number | null>;

export function toPlanUsage(value: unknown): PlanUsage {
  const raw = asRecord(value);
  return {
    staff_users: readNullableNumber(raw.staff_users),
    products: readNullableNumber(raw.products),
    monthly_orders: readNullableNumber(raw.monthly_orders),
  };
}

/** null = sem assinatura vigente (a API não devolve limites). */
export function toPlanLimits(value: unknown): PlanLimits | null {
  if (!isRecord(value)) return null;
  return {
    staff_users: readNullableNumber(value.staff_users),
    products: readNullableNumber(value.products),
    monthly_orders: readNullableNumber(value.monthly_orders),
  };
}

// --- FATURAS ---

export interface PlatformInvoice {
  id: number;
  subscription_id: number;
  store_id: number;
  plan_id: number;
  amount: number;
  currency: string;
  status: InvoiceStatus;
  period_start: string | null;
  period_end: string | null;
  due_at: string | null;
  paid_at: string | null;
  billing_provider: string;
  provider_payment_id: string | null;
  payment_method: string | null;
  /** Observações internas do operador. */
  notes: string | null;
  failure_reason: string | null;
  attempts: number;
  created_at: string | null;
  updated_at: string | null;
}

export function toPlatformInvoice(value: unknown): PlatformInvoice {
  const raw = asRecord(value);
  return {
    id: readId(raw.id),
    subscription_id: readId(raw.subscription_id),
    store_id: readId(raw.store_id),
    plan_id: readId(raw.plan_id),
    amount: readNumber(raw.amount, 0),
    currency: readText(raw.currency, 'BRL'),
    status: readCode<InvoiceStatus>(raw.status),
    period_start: readDate(raw.period_start),
    period_end: readDate(raw.period_end),
    due_at: readDate(raw.due_at),
    paid_at: readDate(raw.paid_at),
    billing_provider: readText(raw.billing_provider, 'MANUAL'),
    provider_payment_id: readNullableText(raw.provider_payment_id),
    payment_method: readNullableText(raw.payment_method),
    notes: readNullableText(raw.notes),
    failure_reason: readNullableText(raw.failure_reason),
    attempts: readNumber(raw.attempts, 0),
    created_at: readDate(raw.created_at),
    updated_at: readDate(raw.updated_at),
  };
}

/** Item de GET /platform/invoices: fatura + loja resumida. */
export interface PlatformInvoiceItem extends PlatformInvoice {
  store: BillingStoreSummary | null;
}

export function toInvoiceItem(value: unknown): PlatformInvoiceItem {
  const raw = asRecord(value);
  return { ...toPlatformInvoice(raw), store: toBillingStore(raw.store) };
}

// --- HISTÓRICO DA ASSINATURA ---

export interface ActorRef {
  id: number | null;
  name: string | null;
  email: string | null;
}

export function toActorRef(value: unknown): ActorRef | null {
  if (!isRecord(value)) return null;
  return { id: readOptionalId(value.id), name: readNullableText(value.name), email: readNullableText(value.email) };
}

export interface SubscriptionEvent {
  id: number;
  type: string;
  from_status: string | null;
  to_status: string | null;
  from_plan_id: number | null;
  to_plan_id: number | null;
  actor_user_id: number | null;
  /** Quem causou o evento (null = sistema: rotina automática ou webhook). */
  actor: ActorRef | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
}

export function toSubscriptionEvent(value: unknown): SubscriptionEvent {
  const raw = asRecord(value);
  return {
    id: readId(raw.id),
    type: readText(raw.type),
    from_status: readNullableText(raw.from_status),
    to_status: readNullableText(raw.to_status),
    from_plan_id: readOptionalId(raw.from_plan_id),
    to_plan_id: readOptionalId(raw.to_plan_id),
    actor_user_id: readOptionalId(raw.actor_user_id),
    actor: toActorRef(raw.actor),
    reason: readNullableText(raw.reason),
    metadata: isRecord(raw.metadata) ? raw.metadata : null,
    created_at: readDate(raw.created_at),
  };
}

/** GET /platform/subscriptions/:id (e a resposta das ações sobre a assinatura). */
export interface PlatformSubscriptionDetail extends PlatformSubscription {
  store: BillingStoreSummary | null;
  plan: PlatformPlan | null;
  usage: PlanUsage;
  /** Limites do plano da assinatura (null = sem plano). */
  limits: PlanLimits | null;
  /** Armazenamento das imagens × limite do plano da assinatura (null quando a API não informou). */
  storage: PlanStorage | null;
  /** Situação efetiva da loja (null = loja não carregada). */
  access: StoreAccess | null;
  /** Mais recentes primeiro (até 100). */
  events: SubscriptionEvent[];
  /** Períodos mais recentes primeiro (até 100). */
  invoices: PlatformInvoice[];
}

export function toSubscriptionDetail(value: unknown): PlatformSubscriptionDetail {
  const raw = asRecord(value);
  return {
    ...toPlatformSubscription(raw),
    store: toBillingStore(raw.store),
    plan: isRecord(raw.plan) ? toPlatformPlan(raw.plan) : null,
    usage: toPlanUsage(raw.usage),
    limits: toPlanLimits(raw.limits),
    storage: toPlanStorage(raw.storage),
    access: toStoreAccess(raw.access),
    events: readArray(raw.events).map(toSubscriptionEvent),
    invoices: readArray(raw.invoices).map(toPlatformInvoice),
  };
}
