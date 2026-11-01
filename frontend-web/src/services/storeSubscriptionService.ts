import api, { getApiErrorMessage, getApiErrorStatus } from './api';
import {
  asRecord, isRecord, readArray, readBoolean, readDate, readId, readNullableNumber, readNullableText, readNumber, readText,
} from './panelParsers';
import { toFeatures, toStoreAccess, type StoreAccess, type StoreFeatures } from './storeAccess';
import type { InvoiceStatus, SubscriptionStatus } from '../types/saas';

// Plano e assinatura SaaS da loja no painel do Administrador (docs/saas/arquitetura.md §5.3 e §6):
// GET /store/subscription, POST /store/subscription/checkout, /cancel e /resume.

export type BillingInterval = 'MONTHLY' | 'YEARLY';

export interface PlanInfo {
  id: number;
  code: string;
  name: string;
  description: string | null;
  /** Preço por período (0 = plano gratuito/interno). */
  price: number;
  currency: string;
  billing_interval: BillingInterval;
  /** Preço por mês (anual ÷ 12). */
  monthly_price: number;
  trial_days: number;
  features: StoreFeatures;
}

export interface StoreSubscriptionInfo {
  id: number;
  status: SubscriptionStatus;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  /** Cancelamento agendado para o fim do período. */
  cancel_at_period_end: boolean;
  /**
   * Quem agendou o cancelamento: PLATFORM (administração da plataforma; só o suporte desfaz, /resume responde 409)
   * ou STORE (a própria loja). null = sem agendamento ou API anterior ao campo.
   */
  cancel_scheduled_by: 'PLATFORM' | 'STORE' | null;
  canceled_at: string | null;
  past_due_since: string | null;
  grace_period_ends_at: string | null;
  suspended_at: string | null;
  /**
   * Quem suspendeu: PLATFORM (decisão do superadmin; pagar não reativa, só a plataforma) ou BILLING
   * (fim da tolerância de uma cobrança vencida; pagar regulariza). null = não suspensa ou causa desconhecida.
   */
  suspended_by: 'PLATFORM' | 'BILLING' | null;
  /** MANUAL (registro pela plataforma) ou MERCADO_PAGO (cobrança automática). */
  billing_provider: string;
  /** Link de pagamento/autorização da cobrança automática ainda pendente (quando houver). */
  checkout_url: string | null;
}

export interface StoreInvoice {
  id: number;
  amount: number;
  currency: string;
  status: InvoiceStatus;
  period_start: string | null;
  period_end: string | null;
  due_at: string | null;
  paid_at: string | null;
  payment_method: string | null;
  failure_reason: string | null;
}

/** Limites do plano (null = ilimitado). */
export type PlanLimitKey = 'staff_users' | 'products' | 'monthly_orders';
export const PLAN_LIMIT_KEYS: readonly PlanLimitKey[] = ['staff_users', 'products', 'monthly_orders'];

export const PLAN_LIMIT_LABELS: Record<PlanLimitKey, string> = {
  staff_users: 'Equipe',
  products: 'Produtos no cardápio',
  monthly_orders: 'Pedidos neste mês',
};

export interface PlanUsageItem {
  key: PlanLimitKey;
  /** Limite do plano (null = ilimitado). */
  limit: number | null;
  /** Uso atual (null quando a API não informou). */
  used: number | null;
}

/**
 * Armazenamento das imagens da loja × limite do plano (campo storage de GET /store/subscription,
 * GET /platform/subscriptions/:id e GET /platform/stores/:id). Conta as imagens de produtos, adicionais e o
 * logo da loja (fotos de perfil não contam). 1 MB = 1.048.576 bytes.
 */
export interface PlanStorage {
  /** Uso em bytes (null = a API não conseguiu medir agora). */
  used_bytes: number | null;
  /** Uso em MB, com 2 casas. */
  used_mb: number | null;
  /** Arquivos da loja na pasta de imagens. */
  files: number | null;
  /** Limite do plano vigente em MB (null = ilimitado ou sem plano vigente). */
  limit_mb: number | null;
  /** Quando a pasta foi lida (o valor fica guardado por alguns minutos; os envios entram na hora). */
  measured_at: string | null;
}

/** null quando a resposta não traz o armazenamento (API anterior a ele). */
export function toPlanStorage(value: unknown): PlanStorage | null {
  if (!isRecord(value)) return null;
  return {
    used_bytes: readNullableNumber(value.used_bytes),
    used_mb: readNullableNumber(value.used_mb),
    files: readNullableNumber(value.files),
    limit_mb: readNullableNumber(value.limit_mb),
    measured_at: readDate(value.measured_at),
  };
}

const MEGABYTES = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

/** "12,5 MB" ou, a partir de 1024 MB, "1,25 GB". */
export function formatMegabytes(mb: number): string {
  if (mb >= 1024) return `${MEGABYTES.format(Math.round((mb / 1024) * 100) / 100)} GB`;
  return `${MEGABYTES.format(mb)} MB`;
}

/** Como a plataforma cobra a assinatura (GET /store/subscription → billing). */
export interface BillingInfo {
  /** Provedor configurado na plataforma: MANUAL (pagamento registrado pelo suporte) ou MERCADO_PAGO. */
  configuredProvider: string;
  /** POST /store/subscription/checkout disponível (sem ele, a API responde 409). */
  onlineCheckoutAvailable: boolean;
}

/** Resposta de GET /store/subscription, já conferida. */
export interface StoreSubscriptionOverview {
  plan: PlanInfo | null;
  subscription: StoreSubscriptionInfo | null;
  usage: PlanUsageItem[];
  /** Armazenamento das imagens da loja (null quando a API não informou). */
  storage: PlanStorage | null;
  /**
   * false quando a API informa limits = null: sem assinatura vigente (cancelada ou inexistente), os limites
   * não se aplicam — limit null nos itens NÃO significa "ilimitado" nesse caso.
   */
  limitsAvailable: boolean;
  invoices: StoreInvoice[];
  access: StoreAccess | null;
  features: StoreFeatures;
  billing: BillingInfo;
}

const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELED'];
const INVOICE_STATUSES: readonly InvoiceStatus[] = ['OPEN', 'PAID', 'FAILED', 'VOID'];

/** Colunas de limite do plano (max_*) por chave. */
const LIMIT_COLUMNS: Record<PlanLimitKey, string> = {
  staff_users: 'max_staff_users',
  products: 'max_products',
  monthly_orders: 'max_monthly_orders',
};

function toPlan(value: unknown): PlanInfo | null {
  if (!isRecord(value) || (!value.id && !value.name)) return null;
  const price = readNumber(value.price, 0);
  const interval: BillingInterval = value.billing_interval === 'YEARLY' ? 'YEARLY' : 'MONTHLY';
  return {
    id: readId(value.id),
    code: readText(value.code),
    name: readText(value.name, 'Plano'),
    description: readNullableText(value.description),
    price,
    currency: readText(value.currency, 'BRL') || 'BRL',
    billing_interval: interval,
    monthly_price: readNumber(value.monthly_price, interval === 'YEARLY' ? price / 12 : price),
    trial_days: readNumber(value.trial_days, 0),
    features: toFeatures(value.features),
  };
}

function toSubscription(value: unknown): StoreSubscriptionInfo | null {
  if (!isRecord(value)) return null;
  const status = SUBSCRIPTION_STATUSES.find((item) => item === value.status);
  if (!status) return null;
  return {
    id: readId(value.id),
    status,
    trial_ends_at: readDate(value.trial_ends_at),
    current_period_start: readDate(value.current_period_start),
    current_period_end: readDate(value.current_period_end),
    cancel_at_period_end: readBoolean(value.cancel_at_period_end),
    cancel_scheduled_by: value.cancel_scheduled_by === 'PLATFORM' || value.cancel_scheduled_by === 'STORE' ? value.cancel_scheduled_by : null,
    canceled_at: readDate(value.canceled_at),
    past_due_since: readDate(value.past_due_since),
    grace_period_ends_at: readDate(value.grace_period_ends_at),
    suspended_at: readDate(value.suspended_at),
    suspended_by: value.suspended_by === 'PLATFORM' || value.suspended_by === 'BILLING' ? value.suspended_by : null,
    billing_provider: readText(value.billing_provider, 'MANUAL') || 'MANUAL',
    checkout_url: readNullableText(value.checkout_url ?? value.provider_checkout_url),
  };
}

function toInvoice(value: unknown): StoreInvoice | null {
  if (!isRecord(value)) return null;
  return {
    id: readId(value.id),
    amount: readNumber(value.amount, 0),
    currency: readText(value.currency, 'BRL') || 'BRL',
    status: INVOICE_STATUSES.find((item) => item === value.status) ?? 'OPEN',
    period_start: readDate(value.period_start),
    period_end: readDate(value.period_end),
    due_at: readDate(value.due_at),
    paid_at: readDate(value.paid_at),
    payment_method: readNullableText(value.payment_method),
    failure_reason: readNullableText(value.failure_reason),
  };
}

/**
 * Limite e uso por chave. Aceita { limits: { staff_users: 5 }, usage: { staff_users: 2 } },
 * uma lista [{ key, limit, usage|used }] ou, sem limites na resposta, as colunas max_* do plano.
 */
function toUsage(raw: Record<string, unknown>, planRaw: unknown): PlanUsageItem[] {
  const plan = asRecord(planRaw);
  const limitsRaw = raw.limits;
  const usageRaw = raw.usage;

  const fromList = (list: unknown, key: PlanLimitKey) => {
    const item = readArray(list).filter(isRecord).find((entry) => entry.key === key);
    return item ?? null;
  };

  return PLAN_LIMIT_KEYS.map((key) => {
    let limit: number | null = null;
    let used: number | null = null;

    if (Array.isArray(limitsRaw)) {
      const item = fromList(limitsRaw, key);
      limit = readNullableNumber(item?.limit);
      used = readNullableNumber(item?.usage ?? item?.used);
    } else if (isRecord(limitsRaw)) {
      const entry = limitsRaw[key];
      if (isRecord(entry)) {
        limit = readNullableNumber(entry.limit);
        used = readNullableNumber(entry.usage ?? entry.used);
      } else {
        limit = readNullableNumber(entry);
      }
    } else {
      limit = readNullableNumber(plan[LIMIT_COLUMNS[key]]);
    }

    if (used === null) {
      if (Array.isArray(usageRaw)) {
        const item = fromList(usageRaw, key);
        used = readNullableNumber(item?.usage ?? item?.used ?? item?.value);
      } else if (isRecord(usageRaw)) {
        used = readNullableNumber(usageRaw[key]);
      }
    }
    return { key, limit, used };
  });
}

/** Lê a resposta de GET /store/subscription (também devolvida por /cancel e /resume) sem confiar no formato. */
export function toSubscriptionOverview(value: unknown): StoreSubscriptionOverview {
  const raw = asRecord(value);
  const subscriptionRaw = raw.subscription;
  // O plano pode vir no topo ou dentro da assinatura
  const planRaw = raw.plan ?? asRecord(subscriptionRaw).plan;
  const plan = toPlan(planRaw);
  const invoicesRaw = Array.isArray(raw.invoices) ? raw.invoices : asRecord(raw.invoices).items;
  // limits: null = sem assinatura vigente (o plano que veio é o da última assinatura, cancelada)
  const limitsAvailable = !(Object.hasOwn(raw, 'limits') && raw.limits === null);
  const billing = asRecord(raw.billing);
  return {
    plan,
    subscription: toSubscription(subscriptionRaw),
    usage: toUsage(raw, limitsAvailable ? planRaw : null),
    storage: toPlanStorage(raw.storage),
    limitsAvailable,
    invoices: readArray(invoicesRaw).map(toInvoice).filter((invoice): invoice is StoreInvoice => invoice !== null),
    access: toStoreAccess(raw.access),
    features: isRecord(raw.features) ? toFeatures(raw.features) : plan?.features ?? toFeatures(null),
    billing: {
      configuredProvider: readText(billing.configured_provider, 'MANUAL') || 'MANUAL',
      // Sem a informação, oferece o pagamento: a API responde 409 se a cobrança online não estiver configurada
      onlineCheckoutAvailable: readBoolean(billing.online_checkout_available, true),
    },
  };
}

/** Link de pagamento devolvido pelo checkout (só http/https). */
function checkoutUrlOf(value: unknown): string | null {
  const raw = asRecord(value);
  const candidates = [raw.checkout_url, raw.url, raw.init_point, asRecord(raw.subscription).checkout_url];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate.trim())) return candidate.trim();
  }
  return null;
}

// --- LIMITES DO PLANO NAS AÇÕES ---

/**
 * Mensagem do 403 de limite/recurso do plano (ex.: "Limite do plano Essencial atingido: 5 usuários da equipe.")
 * ou null para outros erros.
 */
export function planRestrictionMessage(error: unknown): string | null {
  if (getApiErrorStatus(error) !== 403) return null;
  const message = getApiErrorMessage(error, '');
  return /plano/i.test(message) ? message : null;
}

export const storeSubscriptionService = {
  /** GET /store/subscription: plano, assinatura, limites e uso, faturas e situação da loja. */
  get: async (signal?: AbortSignal) => {
    const response = await api.get<unknown>('/store/subscription', { signal });
    return toSubscriptionOverview(response.data);
  },

  /**
   * POST /store/subscription/checkout: link de pagamento da assinatura (cobrança recorrente).
   * 409 = cobrança online ainda não configurada na plataforma.
   */
  checkout: async (payerEmail?: string) => {
    const response = await api.post<unknown>('/store/subscription/checkout', payerEmail ? { payer_email: payerEmail } : {});
    return checkoutUrlOf(response.data);
  },

  /**
   * POST /store/subscription/cancel: cancela no fim do período pago (plano sem período: na hora; motivo opcional).
   * Devolve a visão atualizada (mesmo formato do GET).
   */
  cancel: async (reason?: string) => {
    const response = await api.post<unknown>('/store/subscription/cancel', reason ? { reason } : {});
    return toSubscriptionOverview(response.data);
  },

  /** POST /store/subscription/resume: desiste do cancelamento agendado. Devolve a visão atualizada. */
  resume: async () => {
    const response = await api.post<unknown>('/store/subscription/resume');
    return toSubscriptionOverview(response.data);
  },
};
