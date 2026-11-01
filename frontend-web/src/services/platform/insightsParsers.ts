import type { InvoiceStatus, StoreAccountStatus, SubscriptionStatus } from '../../types/saas';
import { asRecord, readArray, readBoolean, readId, readNullableText, readNumber, readText } from '../panelParsers';

// Leitura defensiva dos indicadores do superpainel (GET /platform/dashboard e GET /platform/finance).
// Contratos: backend/src/platform/metrics.ts e platform-insights.service.ts (docs/saas/arquitetura.md §6).
// Os números vêm sempre da API: campo ausente vira 0/null, nunca uma estimativa.

/** Loja resumida nos indicadores e alertas: { id, slug, name }. */
export interface InsightsStoreRef {
  id: number;
  slug: string;
  name: string;
}

export interface MonthCount {
  /** Mês "AAAA-MM" no fuso da plataforma. */
  month: string;
  count: number;
}

export interface RevenueMonth {
  month: string;
  amount: number;
  /** Faturas pagas no mês. */
  invoices: number;
}

export interface GmvMonth {
  month: string;
  amount: number;
  /** Pedidos pagos (e não cancelados) no mês. */
  paid_orders: number;
}

/** MRR: soma mensalizada das assinaturas ATIVAS e EM ATRASO de planos pagos (sem dados: 0 + note). */
export interface MrrSummary {
  value: number;
  currency: string;
  paying_subscriptions: number;
  has_paid_subscriptions: boolean;
  methodology: string;
  /** Explicação quando o valor é zero (ex.: nenhuma assinatura de plano pago). */
  note: string | null;
}

/** ARR = MRR × 12: PROJEÇÃO, não receita realizada. */
export interface ArrSummary {
  value: number;
  currency: string;
  projection: boolean;
  label: string;
  methodology: string;
}

/** Receita da Comestra: faturas da assinatura SaaS PAGAS (nunca somada ao GMV). */
export interface RevenueBlock {
  total: number;
  paid_invoices: number;
  currency: string;
  by_month: RevenueMonth[];
  methodology: string;
  note: string | null;
}

/** Volume das lojas (GMV): pedidos pagos e não cancelados — dinheiro do consumidor para a loja. */
export interface GmvBlock {
  total: number;
  paid_orders: number;
  currency: string;
  by_month: GmvMonth[];
  methodology: string;
  note: string | null;
}

export const STORE_ACCOUNT_STATUSES: readonly StoreAccountStatus[] = ['ACTIVE', 'SUSPENDED', 'INACTIVE'];
export const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELED'];
export const INVOICE_STATUSES: readonly InvoiceStatus[] = ['OPEN', 'PAID', 'FAILED', 'VOID'];

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonthKey(value: unknown): value is string {
  return typeof value === 'string' && MONTH_KEY.test(value);
}

/** Contagem inteira e não negativa. */
export function readCount(value: unknown): number {
  const count = readNumber(value, 0);
  return count > 0 ? Math.trunc(count) : 0;
}

/** Contagem por chave com todas as chaves conhecidas (as ausentes ficam 0). */
export function readCounts<K extends string>(value: unknown, keys: readonly K[]): Record<K, number> {
  const raw = asRecord(value);
  return Object.fromEntries(keys.map((key) => [key, readCount(raw[key])])) as Record<K, number>;
}

export function parseStoreRef(value: unknown): InsightsStoreRef | null {
  const raw = asRecord(value);
  const id = readId(raw.id);
  if (!id) return null;
  return { id, slug: readText(raw.slug), name: readText(raw.name) || `Loja #${id}` };
}

export function parseMonthCounts(value: unknown): MonthCount[] {
  return readArray(value)
    .map(asRecord)
    .filter((row) => isMonthKey(row.month))
    .map((row) => ({ month: row.month as string, count: readCount(row.count) }));
}

export function parseMrr(value: unknown): MrrSummary {
  const raw = asRecord(value);
  const paying = readCount(raw.paying_subscriptions);
  return {
    value: readNumber(raw.value, 0),
    currency: readText(raw.currency, 'BRL'),
    paying_subscriptions: paying,
    has_paid_subscriptions: readBoolean(raw.has_paid_subscriptions, paying > 0),
    methodology: readText(raw.methodology),
    note: readNullableText(raw.note),
  };
}

export function parseArr(value: unknown): ArrSummary {
  const raw = asRecord(value);
  return {
    value: readNumber(raw.value, 0),
    currency: readText(raw.currency, 'BRL'),
    // O ARR é sempre uma projeção (MRR × 12), mesmo que o campo não venha
    projection: readBoolean(raw.projection, true),
    label: readText(raw.label, 'Projeção anual (MRR × 12)'),
    methodology: readText(raw.methodology),
  };
}

export function parseRevenue(value: unknown): RevenueBlock {
  const raw = asRecord(value);
  return {
    total: readNumber(raw.total, 0),
    paid_invoices: readCount(raw.paid_invoices),
    currency: readText(raw.currency, 'BRL'),
    by_month: readArray(raw.by_month)
      .map(asRecord)
      .filter((row) => isMonthKey(row.month))
      .map((row) => ({ month: row.month as string, amount: readNumber(row.amount, 0), invoices: readCount(row.invoices) })),
    methodology: readText(raw.methodology),
    note: readNullableText(raw.note),
  };
}

export function parseGmv(value: unknown): GmvBlock {
  const raw = asRecord(value);
  return {
    total: readNumber(raw.total, 0),
    paid_orders: readCount(raw.paid_orders),
    currency: readText(raw.currency, 'BRL'),
    by_month: readArray(raw.by_month)
      .map(asRecord)
      .filter((row) => isMonthKey(row.month))
      .map((row) => ({ month: row.month as string, amount: readNumber(row.amount, 0), paid_orders: readCount(row.paid_orders) })),
    methodology: readText(raw.methodology),
    note: readNullableText(raw.note),
  };
}
