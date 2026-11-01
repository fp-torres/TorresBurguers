/**
 * Indicadores do superpainel em funções puras (sem banco, sem Nest): meses do calendário, séries
 * mensais, MRR/ARR, churn, distribuição por plano, a SEPARAÇÃO entre o volume das lojas (GMV) e a
 * receita da plataforma, período do financeiro, inadimplência e alertas. Cobertas por metrics.spec.ts.
 *
 * Metodologia (docs/saas/arquitetura.md, seção 6) vai junto de cada número na resposta. Sem dados, os
 * números saem zerados com uma explicação (note) — nunca estimados.
 */
import { InvoiceStatus } from '../billing/entities/subscription-invoice.entity';
import { SubscriptionStatus } from '../billing/entities/subscription.entity';
import { BillingInterval } from '../billing/entities/plan.entity';
import {
  isPaidPlan,
  monthlyPrice,
  roundMoney,
} from '../billing/subscription-rules';
import {
  addDaysToKey,
  dateKeyInZone,
  formatBRL,
  fromCents,
  startOfDayInZone,
  toCents,
} from '../orders/order-rules';

export const PLATFORM_CURRENCY = 'BRL';
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Contagem vinda do banco (COUNT chega como texto no PostgreSQL). */
export function toCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) ? Math.trunc(count) : 0;
}

/** Valor em reais com 2 casas (roundMoney, com proteção para notação científica). */
export function money(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = roundMoney(value);
  return Number.isFinite(rounded) ? rounded : Math.round(value * 100) / 100;
}

/** Soma vinda do banco (numeric chega como texto) → reais com 2 casas. */
export function toMoney(value: unknown): number {
  return fromCents(toCents(value ?? 0));
}

// ---------------------------------------------------------------------------
// Meses do calendário ("AAAA-MM") no fuso da plataforma
// ---------------------------------------------------------------------------

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "AAAA-MM-DD" que existe no calendário (2026-02-30 não existe). */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_KEY.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** "AAAA-MM" do mês em que o instante cai no fuso informado. */
export function monthKeyInZone(date: Date, timeZone: string): string {
  return dateKeyInZone(date, timeZone).slice(0, 7);
}

/** Soma (ou subtrai) meses de um "AAAA-MM". */
export function addMonthsToKey(month: string, count: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const index = year * 12 + (monthNumber - 1) + count;
  const nextYear = Math.floor(index / 12);
  const nextMonth = index - nextYear * 12 + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}`;
}

/** Todos os meses de from até to (inclusive), em ordem. */
export function monthKeysBetween(from: string, to: string): string[] {
  const keys: string[] = [];
  for (let key = from; key <= to; key = addMonthsToKey(key, 1)) keys.push(key);
  return keys;
}

export interface MonthBucket {
  month: string;
  /** Primeiro instante do mês no fuso. */
  start: Date;
  /** Primeiro instante do mês seguinte (exclusivo). */
  end: Date;
}

export function monthStartInZone(month: string, timeZone: string): Date {
  return startOfDayInZone(`${month}-01`, timeZone);
}

export function monthBucket(month: string, timeZone: string): MonthBucket {
  return {
    month,
    start: monthStartInZone(month, timeZone),
    end: monthStartInZone(addMonthsToKey(month, 1), timeZone),
  };
}

/** Os últimos `count` meses do calendário (inclui o mês atual), do mais antigo ao atual. */
export function lastMonthBuckets(
  now: Date,
  timeZone: string,
  count: number,
): MonthBucket[] {
  const current = monthKeyInZone(now, timeZone);
  return Array.from({ length: count }, (_, index) =>
    monthBucket(addMonthsToKey(current, index - (count - 1)), timeZone),
  );
}

export interface MonthCountRow {
  month: string;
  count: number | string | null;
}

/** Série mensal de contagens: um item por mês pedido (meses sem dados = 0; fora da lista = ignorado). */
export function monthlyCounts(
  months: readonly string[],
  rows: readonly MonthCountRow[],
): { month: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.month, (counts.get(row.month) ?? 0) + toCount(row.count));
  }
  return months.map((month) => ({ month, count: counts.get(month) ?? 0 }));
}

/** Contagem por chave com todas as chaves conhecidas (as que não vieram ficam 0). */
export function countByKey<K extends string>(
  keys: readonly K[],
  rows: readonly { key: string | null; count: number | string | null }[],
): Record<K, number> {
  const result = Object.fromEntries(keys.map((key) => [key, 0])) as Record<
    K,
    number
  >;
  for (const row of rows) {
    if (row.key !== null && (keys as readonly string[]).includes(row.key)) {
      result[row.key as K] += toCount(row.count);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pedidos, volume das lojas (GMV) e receita da plataforma — NUNCA somados
// ---------------------------------------------------------------------------

export const ORDERS_METHODOLOGY =
  'Pedidos processados: pedidos de todas as lojas, exceto os cancelados, pela data de criação (meses no fuso da plataforma).';
export const GMV_METHODOLOGY =
  'Volume das lojas (GMV): soma dos pedidos PAGOS e não cancelados de todas as lojas, pela data do pedido. É dinheiro do consumidor para a loja — não é receita da plataforma e nunca é somado a ela.';
export const PLATFORM_REVENUE_METHODOLOGY =
  'Receita da plataforma: faturas da assinatura SaaS (loja → plataforma) com situação PAGA, pela data do pagamento. Faturas em aberto, recusadas ou anuladas não entram, e o GMV das lojas nunca entra.';

export interface OrdersTotalsRow {
  /** Pedidos não cancelados. */
  orders?: number | string | null;
  /** Pedidos pagos e não cancelados. */
  paid_orders?: number | string | null;
  /** Soma dos pedidos pagos e não cancelados. */
  gmv?: number | string | null;
}

export interface OrdersMonthRow extends OrdersTotalsRow {
  month: string;
}

export interface RevenueTotalsRow {
  /** Faturas pagas. */
  invoices?: number | string | null;
  /** Soma das faturas pagas. */
  revenue?: number | string | null;
}

export interface RevenueMonthRow extends RevenueTotalsRow {
  month: string;
}

export interface PlatformMoneyInput {
  months: readonly string[];
  /** Linhas de orders (pedidos das lojas). */
  orders: {
    totals?: OrdersTotalsRow | null;
    byMonth: readonly OrdersMonthRow[];
  };
  /** Linhas de subscription_invoices (cobrança da plataforma). */
  invoices: {
    totals?: RevenueTotalsRow | null;
    byMonth: readonly RevenueMonthRow[];
  };
  /** true: os totais são de um período (financeiro); false: desde o início (dashboard). */
  period?: boolean;
}

export interface PlatformMoney {
  orders: {
    total: number;
    by_month: { month: string; count: number }[];
    methodology: string;
  };
  gmv: {
    total: number;
    paid_orders: number;
    currency: string;
    by_month: { month: string; amount: number; paid_orders: number }[];
    methodology: string;
    note: string | null;
  };
  platform_revenue: {
    total: number;
    paid_invoices: number;
    currency: string;
    by_month: { month: string; amount: number; invoices: number }[];
    methodology: string;
    note: string | null;
  };
}

function byMonth<T extends { month: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows)
    map.set(row.month, [...(map.get(row.month) ?? []), row]);
  return map;
}

/**
 * Pedidos, GMV e receita da plataforma em blocos separados: o GMV vem SÓ dos pedidos das lojas e a
 * receita SÓ das faturas pagas da assinatura. Nenhum campo soma os dois.
 */
export function buildPlatformMoney(input: PlatformMoneyInput): PlatformMoney {
  const orderMonths = byMonth(input.orders.byMonth);
  const invoiceMonths = byMonth(input.invoices.byMonth);
  const where = input.period ? ' no período' : '';

  const gmvTotal = toMoney(input.orders.totals?.gmv);
  const paidOrders = toCount(input.orders.totals?.paid_orders);
  const revenueTotal = toMoney(input.invoices.totals?.revenue);
  const paidInvoices = toCount(input.invoices.totals?.invoices);

  return {
    orders: {
      total: toCount(input.orders.totals?.orders),
      by_month: input.months.map((month) => ({
        month,
        count: (orderMonths.get(month) ?? []).reduce(
          (sum, row) => sum + toCount(row.orders),
          0,
        ),
      })),
      methodology: ORDERS_METHODOLOGY,
    },
    gmv: {
      total: gmvTotal,
      paid_orders: paidOrders,
      currency: PLATFORM_CURRENCY,
      by_month: input.months.map((month) => {
        const rows = orderMonths.get(month) ?? [];
        return {
          month,
          amount: fromCents(
            rows.reduce((sum, row) => sum + toCents(row.gmv ?? 0), 0),
          ),
          paid_orders: rows.reduce(
            (sum, row) => sum + toCount(row.paid_orders),
            0,
          ),
        };
      }),
      methodology: GMV_METHODOLOGY,
      note:
        paidOrders === 0 && gmvTotal === 0
          ? `Nenhum pedido pago registrado${where}: o volume das lojas é zero.`
          : null,
    },
    platform_revenue: {
      total: revenueTotal,
      paid_invoices: paidInvoices,
      currency: PLATFORM_CURRENCY,
      by_month: input.months.map((month) => {
        const rows = invoiceMonths.get(month) ?? [];
        return {
          month,
          amount: fromCents(
            rows.reduce((sum, row) => sum + toCents(row.revenue ?? 0), 0),
          ),
          invoices: rows.reduce((sum, row) => sum + toCount(row.invoices), 0),
        };
      }),
      methodology: PLATFORM_REVENUE_METHODOLOGY,
      note:
        paidInvoices === 0 && revenueTotal === 0
          ? `Nenhuma fatura de assinatura paga${where}: a receita da plataforma é zero (na cobrança manual, os pagamentos são registrados pelo superpainel).`
          : null,
    },
  };
}

// ---------------------------------------------------------------------------
// MRR, ARR e distribuição por plano
// ---------------------------------------------------------------------------

/** Situações que contam como pagantes (MRR e base do churn). */
export const PAYING_STATUSES: readonly string[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
];

export const MRR_METHODOLOGY =
  'MRR: soma do preço mensal (planos anuais ÷ 12) das assinaturas ATIVAS e EM ATRASO (PAST_DUE) de planos pagos (preço > 0), com o preço atual de cada plano. Assinaturas em teste grátis, suspensas, canceladas e de planos gratuitos ou internos não entram.';
export const MRR_EMPTY_NOTE =
  'Nenhuma assinatura de plano pago está ativa ou em atraso: o MRR é zero (não é estimado).';
export const ARR_METHODOLOGY =
  'ARR: MRR × 12. É uma PROJEÇÃO (quanto a plataforma faturaria em um ano se o MRR atual se mantivesse), não receita realizada.';

/** Assinaturas não canceladas agrupadas por plano e situação. */
export interface PlanStatusRow {
  plan_id: number | string;
  code: string;
  name: string;
  price: number | string;
  /** MONTHLY | YEARLY (texto vindo do banco). */
  billing_interval: string;
  /** Situação da assinatura (texto vindo do banco). */
  status: string;
  count: number | string;
}

export interface MrrSummary {
  value: number;
  currency: string;
  paying_subscriptions: number;
  has_paid_subscriptions: boolean;
  methodology: string;
  note: string | null;
}

const YEARLY: string = BillingInterval.YEARLY;
const CANCELED: string = SubscriptionStatus.CANCELED;

function planOf(row: PlanStatusRow) {
  return {
    price: Number(row.price) || 0,
    billing_interval:
      row.billing_interval === YEARLY
        ? BillingInterval.YEARLY
        : BillingInterval.MONTHLY,
  };
}

export function computeMrr(rows: readonly PlanStatusRow[]): MrrSummary {
  let total = 0; // soma sem arredondar; arredonda só o total
  let paying = 0;
  for (const row of rows) {
    const plan = planOf(row);
    if (!PAYING_STATUSES.includes(row.status) || !isPaidPlan(plan)) continue;
    const count = toCount(row.count);
    paying += count;
    total += monthlyPrice(plan) * count;
  }
  return {
    value: money(total),
    currency: PLATFORM_CURRENCY,
    paying_subscriptions: paying,
    has_paid_subscriptions: paying > 0,
    methodology: MRR_METHODOLOGY,
    note: paying > 0 ? null : MRR_EMPTY_NOTE,
  };
}

export interface ArrSummary {
  value: number;
  currency: string;
  projection: true;
  label: string;
  methodology: string;
}

export function computeArr(mrr: Pick<MrrSummary, 'value'>): ArrSummary {
  return {
    value: money(mrr.value * 12),
    currency: PLATFORM_CURRENCY,
    projection: true,
    label: 'Projeção anual (MRR × 12)',
    methodology: ARR_METHODOLOGY,
  };
}

const CURRENT_STATUSES = [
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.SUSPENDED,
] as const;

export interface PlanDistributionItem {
  plan: {
    id: number;
    code: string;
    name: string;
    price: number;
    billing_interval: string;
  };
  /** Assinaturas vigentes (não canceladas) no plano. */
  subscriptions: number;
  paying_subscriptions: number;
  by_status: Record<(typeof CURRENT_STATUSES)[number], number>;
  mrr: number;
  /** Fração das assinaturas vigentes da plataforma (0 a 1); null sem assinaturas. */
  share: number | null;
}

/** Assinaturas vigentes por plano, com o MRR de cada um (mesma regra do computeMrr). */
export function planDistribution(
  rows: readonly PlanStatusRow[],
): PlanDistributionItem[] {
  const plans = new Map<number, PlanDistributionItem & { mrrRaw: number }>();
  for (const row of rows) {
    if (row.status === CANCELED) continue;
    const id = Number(row.plan_id);
    const plan = planOf(row);
    const item = plans.get(id) ?? {
      plan: {
        id,
        code: row.code,
        name: row.name,
        price: money(plan.price),
        billing_interval: plan.billing_interval,
      },
      subscriptions: 0,
      paying_subscriptions: 0,
      by_status: Object.fromEntries(
        CURRENT_STATUSES.map((status) => [status, 0]),
      ) as PlanDistributionItem['by_status'],
      mrr: 0,
      mrrRaw: 0,
      share: null,
    };
    const count = toCount(row.count);
    item.subscriptions += count;
    if (row.status in item.by_status) {
      item.by_status[row.status as (typeof CURRENT_STATUSES)[number]] += count;
    }
    if (PAYING_STATUSES.includes(row.status) && isPaidPlan(plan)) {
      item.paying_subscriptions += count;
      item.mrrRaw += monthlyPrice(plan) * count;
    }
    plans.set(id, item);
  }

  const total = [...plans.values()].reduce(
    (sum, item) => sum + item.subscriptions,
    0,
  );
  return [...plans.values()]
    .map(({ mrrRaw, ...item }) => ({
      ...item,
      mrr: money(mrrRaw),
      share: total
        ? Math.round((item.subscriptions / total) * 10_000) / 10_000
        : null,
    }))
    .sort(
      (a, b) =>
        b.subscriptions - a.subscriptions ||
        a.plan.name.localeCompare(b.plan.name, 'pt-BR'),
    );
}

// ---------------------------------------------------------------------------
// Churn mensal (lojas), reconstruído pelo histórico subscription_events
// ---------------------------------------------------------------------------

/** Situação anterior de um cancelamento que conta como perda de cliente pagante. */
export const CHURN_CANCELED_FROM: readonly string[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.SUSPENDED,
];

export const CHURN_METHODOLOGY =
  'Churn mensal de lojas = assinaturas pagantes canceladas no mês ÷ assinaturas pagantes no início do mês. ' +
  '"Pagante no início do mês": situação ATIVA ou EM ATRASO e plano pago (preço atual > 0) no primeiro instante do mês (fuso da plataforma), reconstruídas pelo histórico de cada assinatura (subscription_events). ' +
  '"Cancelada no mês": mudança para CANCELADA dentro do mês vinda de ATIVA, EM ATRASO ou SUSPENSA, num plano pago (cancelamentos durante o teste grátis não contam). ' +
  'Sem assinaturas pagantes no início do mês a taxa fica indefinida (null). O mês atual é parcial.';

export interface SubscriptionHistoryEvent {
  id: number;
  subscription_id: number;
  type: string;
  from_status: string | null;
  to_status: string | null;
  to_plan_id: number | null;
  created_at: Date | string;
}

export interface ChurnMonth {
  month: string;
  paying_at_start: number;
  canceled: number;
  /** canceled ÷ paying_at_start (0 a 1, 4 casas); null sem pagantes no início do mês. */
  rate: number | null;
  /** Mês ainda em andamento. */
  partial: boolean;
  note: string | null;
}

interface TimelineItem {
  at: number;
  event: SubscriptionHistoryEvent;
}

export function computeMonthlyChurn(
  events: readonly SubscriptionHistoryEvent[],
  planPrices: ReadonlyMap<number, number>,
  buckets: readonly MonthBucket[],
  now: Date,
): ChurnMonth[] {
  const timelines = new Map<number, TimelineItem[]>();
  for (const event of events) {
    const at = new Date(event.created_at).getTime();
    if (Number.isNaN(at)) continue;
    const id = Number(event.subscription_id);
    timelines.set(id, [...(timelines.get(id) ?? []), { at, event }]);
  }
  for (const timeline of timelines.values()) {
    timeline.sort((a, b) => a.at - b.at || a.event.id - b.event.id);
  }
  const paidPlan = (planId: number | null) =>
    planId !== null && (planPrices.get(planId) ?? 0) > 0;

  return buckets.map((bucket) => {
    const start = bucket.start.getTime();
    const end = bucket.end.getTime();
    let paying = 0;
    let canceled = 0;

    for (const timeline of timelines.values()) {
      // Situação e plano no primeiro instante do mês
      let { status, planId } = stateAt(timeline, start);
      if (
        status !== null &&
        PAYING_STATUSES.includes(status) &&
        paidPlan(planId)
      ) {
        paying++;
      }

      // Cancelamentos dentro do mês: o plano vigente no momento decide se era pagante
      for (const { at, event } of timeline) {
        if (at < start) continue;
        if (at >= end) break;
        if (event.to_plan_id !== null && event.to_plan_id !== undefined) {
          planId = Number(event.to_plan_id);
        }
        if (
          event.to_status === SubscriptionStatus.CANCELED &&
          CHURN_CANCELED_FROM.includes(event.from_status ?? status ?? '') &&
          paidPlan(planId)
        ) {
          canceled++;
        }
        if (event.to_status) status = event.to_status;
      }
    }

    return {
      month: bucket.month,
      paying_at_start: paying,
      canceled,
      rate: paying ? Math.round((canceled / paying) * 10_000) / 10_000 : null,
      partial: end > now.getTime(),
      note: paying
        ? null
        : 'Sem assinaturas pagantes no início do mês: a taxa não se aplica.',
    };
  });
}

/** Situação e plano de uma assinatura imediatamente antes do instante informado. */
function stateAt(
  timeline: readonly TimelineItem[],
  instant: number,
): { status: string | null; planId: number | null } {
  let status: string | null = null;
  let planId: number | null = null;
  for (const { at, event } of timeline) {
    if (at >= instant) break;
    if (event.to_status) status = event.to_status;
    if (event.to_plan_id !== null && event.to_plan_id !== undefined) {
      planId = Number(event.to_plan_id);
    }
  }
  return { status, planId };
}

// ---------------------------------------------------------------------------
// Financeiro: período, faturas por situação, inadimplência e ranking de GMV
// ---------------------------------------------------------------------------

export const FINANCE_DEFAULT_MONTHS = 12;
/** Maior período do financeiro: 3 anos. */
export const FINANCE_MAX_DAYS = 1096;

export type FinancePeriod =
  | {
      ok: true;
      from: string;
      to: string;
      days: number;
      /** Primeiro instante de "from" no fuso. */
      start: Date;
      /** Primeiro instante do dia seguinte a "to" (exclusivo). */
      end: Date;
      months: string[];
    }
  | { ok: false; message: string };

/**
 * ?from=AAAA-MM-DD&to=AAAA-MM-DD (datas do calendário da plataforma). Sem datas: do dia 1º do mês de
 * 11 meses atrás até hoje (12 meses do calendário); só "to": os 12 meses até ele; só "from": até hoje.
 */
export function parseFinancePeriod(
  rawFrom: unknown,
  rawTo: unknown,
  now: Date,
  timeZone: string,
): FinancePeriod {
  const given = (value: unknown) =>
    value !== undefined && value !== null && value !== '';
  for (const value of [rawFrom, rawTo]) {
    if (given(value) && !isDateKey(value)) {
      return {
        ok: false,
        message:
          'Período inválido: informe from e to no formato AAAA-MM-DD (ex.: from=2026-01-01&to=2026-10-31).',
      };
    }
  }

  const to = given(rawTo) ? (rawTo as string) : dateKeyInZone(now, timeZone);
  const from = given(rawFrom)
    ? (rawFrom as string)
    : `${addMonthsToKey(to.slice(0, 7), -(FINANCE_DEFAULT_MONTHS - 1))}-01`;
  if (from > to) {
    return {
      ok: false,
      message: 'A data inicial (from) não pode ser depois da data final (to).',
    };
  }
  const utc = (key: string) => {
    const [year, month, day] = key.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  const days = Math.round((utc(to) - utc(from)) / DAY_MS) + 1;
  if (days > FINANCE_MAX_DAYS) {
    return {
      ok: false,
      message: `O período pode ter no máximo ${FINANCE_MAX_DAYS} dias (3 anos).`,
    };
  }
  return {
    ok: true,
    from,
    to,
    days,
    start: startOfDayInZone(from, timeZone),
    end: startOfDayInZone(addDaysToKey(to, 1), timeZone),
    months: monthKeysBetween(from.slice(0, 7), to.slice(0, 7)),
  };
}

export const INVOICE_STATUS_ORDER: readonly InvoiceStatus[] = [
  InvoiceStatus.OPEN,
  InvoiceStatus.PAID,
  InvoiceStatus.FAILED,
  InvoiceStatus.VOID,
];

/** Faturas por situação (todas as situações, inclusive as zeradas). */
export function invoicesByStatus(
  rows: readonly {
    status: string;
    count: number | string | null;
    amount: number | string | null;
  }[],
): { status: InvoiceStatus; count: number; amount: number }[] {
  return INVOICE_STATUS_ORDER.map((status) => {
    const key: string = status;
    const matching = rows.filter((row) => row.status === key);
    return {
      status,
      count: matching.reduce((sum, row) => sum + toCount(row.count), 0),
      amount: fromCents(
        matching.reduce((sum, row) => sum + toCents(row.amount ?? 0), 0),
      ),
    };
  });
}

export interface StoreRefRow {
  store_id: number | string;
  slug: string;
  name: string;
}

export interface AlertStoreRef {
  id: number;
  slug: string;
  name: string;
}

export function storeRefOf(row: StoreRefRow): AlertStoreRef {
  return { id: Number(row.store_id), slug: row.slug, name: row.name };
}

export interface DelinquentStoreRow extends StoreRefRow {
  invoices: number | string;
  amount: number | string | null;
  oldest_due_at: Date | string | null;
}

export const DELINQUENCY_METHODOLOGY =
  'Inadimplência: faturas da assinatura em aberto ou recusadas (OPEN/FAILED) com vencimento já passado, de todas as lojas. Faturas anuladas ou pagas não entram.';

export function summarizeDelinquency(
  rows: readonly DelinquentStoreRow[],
  limit = 10,
) {
  const stores = rows
    .map((row) => ({
      store: storeRefOf(row),
      amount: toMoney(row.amount),
      invoices: toCount(row.invoices),
      oldest_due_at: row.oldest_due_at ? new Date(row.oldest_due_at) : null,
    }))
    .filter((row) => row.invoices > 0)
    .sort((a, b) => b.amount - a.amount || a.store.id - b.store.id);
  const amountCents = stores.reduce((sum, row) => sum + toCents(row.amount), 0);
  const invoices = stores.reduce((sum, row) => sum + row.invoices, 0);
  return {
    amount: fromCents(amountCents),
    invoices,
    stores: stores.length,
    currency: PLATFORM_CURRENCY,
    top_stores: stores.slice(0, limit),
    methodology: DELINQUENCY_METHODOLOGY,
    note: invoices
      ? null
      : 'Nenhuma fatura vencida em aberto: não há inadimplência.',
  };
}

export interface StoreGmvRow extends StoreRefRow {
  gmv: number | string | null;
  paid_orders: number | string | null;
}

/** Ranking das lojas por GMV (já ordenado e limitado pela consulta). */
export function topStoresByGmv(rows: readonly StoreGmvRow[]) {
  return rows.map((row) => ({
    store: storeRefOf(row),
    gmv: toMoney(row.gmv),
    paid_orders: toCount(row.paid_orders),
  }));
}

// ---------------------------------------------------------------------------
// Alertas do dashboard
// ---------------------------------------------------------------------------

export type AlertSeverity = 'critical' | 'warning' | 'info';

export const PLATFORM_ALERT_TYPES = [
  'PAST_DUE_GRACE_ENDING',
  'SUBSCRIPTION_SUSPENDED',
  'REFUND_PENDING',
  'CANCELED_STILL_BILLED',
  'INVOICE_FAILED',
  'NO_ACTIVE_ADMIN',
  'STORE_SUSPENDED',
  'INACTIVE_STORE_BILLED',
  'TRIAL_ENDING',
  'ONLINE_PAYMENTS_WITHOUT_CREDENTIALS',
] as const;

export type PlatformAlertType = (typeof PLATFORM_ALERT_TYPES)[number];

export const ALERT_SEVERITY: Readonly<
  Record<PlatformAlertType, AlertSeverity>
> = {
  PAST_DUE_GRACE_ENDING: 'critical',
  SUBSCRIPTION_SUSPENDED: 'critical',
  REFUND_PENDING: 'critical',
  CANCELED_STILL_BILLED: 'critical',
  INVOICE_FAILED: 'warning',
  NO_ACTIVE_ADMIN: 'warning',
  STORE_SUSPENDED: 'warning',
  INACTIVE_STORE_BILLED: 'warning',
  TRIAL_ENDING: 'info',
  ONLINE_PAYMENTS_WITHOUT_CREDENTIALS: 'info',
};

/** Janelas dos alertas: tolerância terminando em até 3 dias; teste grátis terminando em até 7. */
export const ALERT_WINDOWS = { graceEndingDays: 3, trialEndingDays: 7 };

export interface PlatformAlert {
  type: PlatformAlertType;
  severity: AlertSeverity;
  store?: AlertStoreRef;
  message: string;
  data?: Record<string, unknown>;
}

export interface AlertSourceRows {
  /** PAST_DUE com fim da tolerância em até 3 dias (ou já vencido). */
  graceEnding: readonly (StoreRefRow & {
    grace_period_ends_at: Date | string;
  })[];
  suspendedStores: readonly (StoreRefRow & { status_reason: string | null })[];
  suspendedSubscriptions: readonly (StoreRefRow & {
    suspended_at: Date | string | null;
    /** PLATFORM (superadmin) ou BILLING (inadimplência); ausente/null = inadimplência (antigo). */
    suspended_by?: string | null;
  })[];
  /**
   * Loja DESATIVADA com assinatura vigente (não cancelada) de plano pago: a rotina continua cobrando
   * e ela segue nos indicadores (assinaturas vigentes e, se ativa/em atraso, MRR).
   */
  inactiveStoresBilled?: readonly (StoreRefRow & {
    subscription_status: string;
    plan_name: string | null;
  })[];
  refundPending: readonly (StoreRefRow & { orders: number | string })[];
  /**
   * Assinatura CANCELADA que ainda gera cobrança: a autorização no Mercado Pago não foi cancelada (a
   * tentativa falhou; a rotina tenta de novo) e/ou cobranças chegaram depois do cancelamento (devolver).
   */
  canceledStillBilled?: readonly (StoreRefRow & {
    subscription_id: number | string;
    provider_active: boolean | string | null;
    payments: number | string | null;
    amount: number | string | null;
  })[];
  failedInvoices: readonly (StoreRefRow & {
    invoices: number | string;
    amount: number | string | null;
  })[];
  storesWithoutAdmin: readonly (StoreRefRow & {
    pending_invitation: boolean | string | null;
  })[];
  trialsEnding: readonly (StoreRefRow & { trial_ends_at: Date | string })[];
  /** Plano com pagamentos online e loja sem credencial própria do Mercado Pago. */
  onlinePaymentsWithoutCredentials: readonly StoreRefRow[];
  /** Loja padrão das rotas antigas (usa o MP_ACCESS_TOKEN do ambiente quando não tem credencial). */
  defaultStoreId: number | null;
  /** MP_ACCESS_TOKEN do ambiente configurado. */
  platformCredentialsConfigured: boolean;
}

function formatDate(value: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(value));
}

const plural = (count: number, singular: string, many: string) =>
  `${count} ${count === 1 ? singular : many}`;

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/** Monta os alertas a partir das consultas (ordem: gravidade, tipo e nome da loja). */
export function buildAlerts(
  rows: AlertSourceRows,
  now: Date,
  timeZone: string,
): PlatformAlert[] {
  const alerts: PlatformAlert[] = [];
  const add = (
    type: PlatformAlertType,
    row: StoreRefRow,
    message: string,
    data?: Record<string, unknown>,
  ) =>
    alerts.push({
      type,
      severity: ALERT_SEVERITY[type],
      store: storeRefOf(row),
      message,
      ...(data ? { data } : {}),
    });

  for (const row of rows.graceEnding) {
    const ends = new Date(row.grace_period_ends_at);
    const days = Math.ceil((ends.getTime() - now.getTime()) / DAY_MS);
    add(
      'PAST_DUE_GRACE_ENDING',
      row,
      days <= 0
        ? `Inadimplência: a tolerância terminou em ${formatDate(ends, timeZone)}; a assinatura será suspensa na próxima rotina de cobrança.`
        : `Inadimplência: a tolerância termina em ${formatDate(ends, timeZone)} (${plural(days, 'dia', 'dias')}). Depois disso a loja deixa de vender.`,
      { grace_period_ends_at: ends.toISOString() },
    );
  }
  for (const row of rows.suspendedSubscriptions) {
    const byPlatform = row.suspended_by === 'PLATFORM';
    const cause = byPlatform ? 'pela plataforma' : 'por falta de pagamento';
    const since = row.suspended_at
      ? ` desde ${formatDate(row.suspended_at, timeZone)}`
      : '';
    add(
      'SUBSCRIPTION_SUSPENDED',
      row,
      byPlatform
        ? `Assinatura suspensa ${cause}${since}: a loja não aceita pedidos até a reativação pelo superpainel.`
        : `Assinatura suspensa ${cause}${since}: a loja não aceita pedidos.`,
      {
        ...(row.suspended_at
          ? { suspended_at: new Date(row.suspended_at).toISOString() }
          : {}),
        suspended_by: byPlatform ? 'PLATFORM' : 'BILLING',
      },
    );
  }
  for (const row of rows.inactiveStoresBilled ?? []) {
    add(
      'INACTIVE_STORE_BILLED',
      row,
      `Loja desativada com assinatura vigente${row.plan_name ? ` (plano ${row.plan_name})` : ''}: a cobrança continua e a assinatura segue nos indicadores (MRR e assinaturas vigentes). Cancele a assinatura ou restaure a loja.`,
      { subscription_status: row.subscription_status },
    );
  }
  for (const row of rows.refundPending) {
    const orders = toCount(row.orders);
    add(
      'REFUND_PENDING',
      row,
      `${plural(orders, 'pedido cancelado', 'pedidos cancelados')} com estorno pendente: o dinheiro do cliente precisa ser devolvido.`,
      { orders },
    );
  }
  for (const row of rows.canceledStillBilled ?? []) {
    const active =
      row.provider_active === true || row.provider_active === 'true';
    const payments = toCount(row.payments);
    const amount = toMoney(row.amount);
    const parts: string[] = [];
    if (active) {
      parts.push(
        'Assinatura cancelada com a cobrança recorrente ainda ativa no Mercado Pago (o cancelamento lá falhou; a rotina tenta de novo): confira a autorização no Mercado Pago.',
      );
    } else {
      parts.push('Assinatura cancelada que continuou sendo cobrada.');
    }
    if (payments > 0) {
      parts.push(
        `${plural(payments, 'cobrança recebida', 'cobranças recebidas')} depois do cancelamento, somando ${formatBRL(amount)}: devolva à loja.`,
      );
    }
    add('CANCELED_STILL_BILLED', row, parts.join(' '), {
      subscription_id: Number(row.subscription_id),
      provider_active: active,
      payments,
      amount,
    });
  }
  for (const row of rows.failedInvoices) {
    const invoices = toCount(row.invoices);
    const amount = toMoney(row.amount);
    add(
      'INVOICE_FAILED',
      row,
      `${plural(invoices, 'fatura da assinatura recusada', 'faturas da assinatura recusadas')}, somando ${formatBRL(amount)}.`,
      { invoices, amount },
    );
  }
  for (const row of rows.storesWithoutAdmin) {
    const pending =
      row.pending_invitation === true || row.pending_invitation === 'true';
    add(
      'NO_ACTIVE_ADMIN',
      row,
      pending
        ? 'Nenhum administrador ativo (há um convite pendente): ninguém consegue gerenciar a loja ainda.'
        : 'Nenhum administrador ativo: ninguém consegue gerenciar a loja. Envie um convite de administrador.',
      { pending_invitation: pending },
    );
  }
  for (const row of rows.suspendedStores) {
    const reason = row.status_reason?.trim();
    add(
      'STORE_SUSPENDED',
      row,
      `Loja suspensa pela plataforma${reason ? `: ${reason}` : ''}.`,
    );
  }
  for (const row of rows.trialsEnding) {
    const ends = new Date(row.trial_ends_at);
    add(
      'TRIAL_ENDING',
      row,
      `O teste grátis termina em ${formatDate(ends, timeZone)}.`,
      { trial_ends_at: ends.toISOString() },
    );
  }
  for (const row of rows.onlinePaymentsWithoutCredentials) {
    const isDefault =
      rows.defaultStoreId !== null &&
      Number(row.store_id) === rows.defaultStoreId;
    // A loja padrão usa a credencial do ambiente (MP_ACCESS_TOKEN) quando não tem a própria
    if (isDefault && rows.platformCredentialsConfigured) continue;
    add(
      'ONLINE_PAYMENTS_WITHOUT_CREDENTIALS',
      row,
      'O plano inclui pagamentos online, mas a loja não configurou a conta do Mercado Pago: a vitrine aceita só pagamento na entrega ou na retirada.',
    );
  }

  const typeRank = (type: PlatformAlertType) =>
    PLATFORM_ALERT_TYPES.indexOf(type);
  return alerts.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      typeRank(a.type) - typeRank(b.type) ||
      (a.store?.name ?? '').localeCompare(b.store?.name ?? '', 'pt-BR'),
  );
}
