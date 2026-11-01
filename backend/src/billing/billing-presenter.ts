/**
 * Formatos das respostas da cobrança SaaS, montados por LISTA DE CAMPOS PERMITIDOS: entidades e
 * relações nunca são devolvidas inteiras (loja com credenciais, usuário com dados internos...).
 */
import {
  bytesToMb,
  type StoreStorageUsage,
} from '../common/uploads/storage-usage';
import type { Store } from '../store/entities/store.entity';
import type { Plan } from './entities/plan.entity';
import type { SubscriptionEvent } from './entities/subscription-event.entity';
import type { SubscriptionInvoice } from './entities/subscription-invoice.entity';
import type { Subscription } from './entities/subscription.entity';
import { normalizeFeatures } from './plan-rules';
import { monthlyPrice, roundMoney } from './subscription-rules';

/** Campos comerciais do plano (página pública de planos e painel da loja). */
export function presentPublicPlan(plan: Plan) {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    description: plan.description ?? null,
    price: Number(plan.price),
    currency: plan.currency,
    billing_interval: plan.billing_interval,
    /**
     * Preço por mês (anual ÷ 12), para comparar planos, arredondado em centavos (1199.88 ÷ 12 = 99.99,
     * nunca 99.99000000000001). O MRR soma o valor sem arredondar e arredonda o total.
     */
    monthly_price: roundMoney(monthlyPrice(plan)),
    trial_days: plan.trial_days,
    max_staff_users: plan.max_staff_users ?? null,
    max_products: plan.max_products ?? null,
    max_monthly_orders: plan.max_monthly_orders ?? null,
    features: normalizeFeatures(plan.features),
  };
}

export type PublicPlanView = ReturnType<typeof presentPublicPlan>;

/** Plano completo para o superpainel. */
export function presentPlan(
  plan: Plan,
  extras: { active_subscriptions?: number } = {},
) {
  return {
    ...presentPublicPlan(plan),
    /** Armazenamento das imagens da loja em MB (null = ilimitado). Por ora só no superpainel. */
    max_storage_mb: plan.max_storage_mb ?? null,
    status: plan.status,
    is_public: plan.is_public,
    sort_order: plan.sort_order,
    created_at: plan.created_at,
    updated_at: plan.updated_at,
    ...(extras.active_subscriptions !== undefined
      ? { active_subscriptions: extras.active_subscriptions }
      : {}),
  };
}

export type PlanView = ReturnType<typeof presentPlan>;

/**
 * Uso de armazenamento × limite do plano (campo `storage` de GET /store/subscription,
 * GET /platform/subscriptions/:id e GET /platform/stores/:id).
 * - used_*: arquivos da loja (prefixo s<id>-) na pasta de uploads; null se a pasta não pôde ser lida;
 * - limit_mb: limite do plano em vigor (null = ilimitado, ou sem plano em vigor: nesse caso `limits` é null);
 * - measured_at: quando a pasta foi lida (o valor fica guardado por alguns minutos; os envios e exclusões
 *   feitos pela API já entram na hora).
 */
export function presentStorageUsage(
  usage: StoreStorageUsage | null,
  limitMb: number | null,
) {
  return {
    used_bytes: usage ? usage.bytes : null,
    used_mb: usage ? bytesToMb(usage.bytes) : null,
    files: usage ? usage.files : null,
    limit_mb: limitMb,
    measured_at: usage ? usage.measuredAt : null,
  };
}

export type StorageUsageView = ReturnType<typeof presentStorageUsage>;

/** Loja resumida (nunca a entidade: ela tem credenciais e dados internos). */
export function presentStoreSummary(
  store: Pick<Store, 'id' | 'slug' | 'name' | 'logo' | 'account_status'>,
) {
  return {
    id: store.id,
    slug: store.slug,
    name: store.name,
    logo: store.logo ?? null,
    account_status: store.account_status,
  };
}

export type StoreSummaryView = ReturnType<typeof presentStoreSummary>;

/** Assinatura no superpainel. */
export function presentSubscription(subscription: Subscription) {
  return {
    id: subscription.id,
    store_id: subscription.store_id,
    plan_id: subscription.plan_id,
    status: subscription.status,
    trial_ends_at: subscription.trial_ends_at ?? null,
    current_period_start: subscription.current_period_start ?? null,
    current_period_end: subscription.current_period_end ?? null,
    cancel_at_period_end: subscription.cancel_at_period_end,
    /** Quem agendou o cancelamento: PLATFORM (só o superpainel desfaz) ou STORE; null sem agendamento. */
    cancel_scheduled_by: subscription.cancel_scheduled_by ?? null,
    canceled_at: subscription.canceled_at ?? null,
    past_due_since: subscription.past_due_since ?? null,
    grace_period_ends_at: subscription.grace_period_ends_at ?? null,
    suspended_at: subscription.suspended_at ?? null,
    /** PLATFORM (decisão do superadmin) ou BILLING (inadimplência); null fora da suspensão. */
    suspended_by: subscription.suspended_by ?? null,
    billing_provider: subscription.billing_provider,
    provider_subscription_id: subscription.provider_subscription_id ?? null,
    provider_status: subscription.provider_status ?? null,
    provider_checkout_url: subscription.provider_checkout_url ?? null,
    created_at: subscription.created_at,
    updated_at: subscription.updated_at,
  };
}

export type SubscriptionView = ReturnType<typeof presentSubscription>;

/** Assinatura no painel da loja (sem os identificadores internos do provedor). */
export function presentStoreSubscription(subscription: Subscription) {
  return {
    id: subscription.id,
    plan_id: subscription.plan_id,
    status: subscription.status,
    trial_ends_at: subscription.trial_ends_at ?? null,
    current_period_start: subscription.current_period_start ?? null,
    current_period_end: subscription.current_period_end ?? null,
    cancel_at_period_end: subscription.cancel_at_period_end,
    /**
     * Quem agendou o cancelamento: PLATFORM (a loja não desfaz: POST /store/subscription/resume → 409)
     * ou STORE; null sem agendamento.
     */
    cancel_scheduled_by: subscription.cancel_scheduled_by ?? null,
    canceled_at: subscription.canceled_at ?? null,
    past_due_since: subscription.past_due_since ?? null,
    grace_period_ends_at: subscription.grace_period_ends_at ?? null,
    suspended_at: subscription.suspended_at ?? null,
    /** PLATFORM (decisão do superadmin) ou BILLING (inadimplência); null fora da suspensão. */
    suspended_by: subscription.suspended_by ?? null,
    billing_provider: subscription.billing_provider,
    provider_status: subscription.provider_status ?? null,
    /** Link de pagamento/autorização da cobrança automática (quando houver). */
    checkout_url: subscription.provider_checkout_url ?? null,
    created_at: subscription.created_at,
  };
}

export type StoreSubscriptionView = ReturnType<typeof presentStoreSubscription>;

/** Fatura no superpainel. */
export function presentInvoice(invoice: SubscriptionInvoice) {
  return {
    id: invoice.id,
    subscription_id: invoice.subscription_id,
    store_id: invoice.store_id,
    plan_id: invoice.plan_id,
    amount: Number(invoice.amount),
    currency: invoice.currency,
    status: invoice.status,
    period_start: invoice.period_start,
    period_end: invoice.period_end,
    due_at: invoice.due_at,
    paid_at: invoice.paid_at ?? null,
    billing_provider: invoice.billing_provider,
    provider_payment_id: invoice.provider_payment_id ?? null,
    payment_method: invoice.payment_method ?? null,
    notes: invoice.notes ?? null,
    failure_reason: invoice.failure_reason ?? null,
    attempts: invoice.attempts,
    created_at: invoice.created_at,
    updated_at: invoice.updated_at,
  };
}

export type InvoiceView = ReturnType<typeof presentInvoice>;

/** Fatura no painel da loja (sem as observações internas do operador). */
export function presentStoreInvoice(invoice: SubscriptionInvoice) {
  return {
    id: invoice.id,
    plan_id: invoice.plan_id,
    amount: Number(invoice.amount),
    currency: invoice.currency,
    status: invoice.status,
    period_start: invoice.period_start,
    period_end: invoice.period_end,
    due_at: invoice.due_at,
    paid_at: invoice.paid_at ?? null,
    billing_provider: invoice.billing_provider,
    payment_method: invoice.payment_method ?? null,
    failure_reason: invoice.failure_reason ?? null,
    attempts: invoice.attempts,
    created_at: invoice.created_at,
  };
}

export type StoreInvoiceView = ReturnType<typeof presentStoreInvoice>;

/** Evento do histórico; o ator aparece só com id, nome e e-mail. */
export function presentEvent(event: SubscriptionEvent) {
  const actor = event.actor
    ? { id: event.actor.id, name: event.actor.name, email: event.actor.email }
    : null;
  return {
    id: event.id,
    subscription_id: event.subscription_id,
    type: event.type,
    from_status: event.from_status ?? null,
    to_status: event.to_status ?? null,
    from_plan_id: event.from_plan_id ?? null,
    to_plan_id: event.to_plan_id ?? null,
    actor_user_id: event.actor_user_id ?? null,
    actor,
    reason: event.reason ?? null,
    metadata: event.metadata ?? null,
    created_at: event.created_at,
  };
}

export type SubscriptionEventView = ReturnType<typeof presentEvent>;
