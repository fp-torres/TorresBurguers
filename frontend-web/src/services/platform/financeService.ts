import api, { toQuery } from '../api';
import { asRecord, readArray, readDate, readNullableText, readNumber, readText } from '../panelParsers';
import type { InvoiceStatus } from '../../types/saas';
import {
  INVOICE_STATUSES, parseArr, parseGmv, parseMrr, parseRevenue, parseStoreRef, readCount, type ArrSummary, type GmvBlock,
  type InsightsStoreRef, type MrrSummary, type RevenueBlock,
} from './insightsParsers';

// Superpainel › Financeiro: GET /platform/finance?from=AAAA-MM-DD&to=AAAA-MM-DD (somente SUPER_ADMIN).
// Padrão da API: os últimos 12 meses do calendário; máximo de 3 anos. Contrato em
// backend/src/platform/platform-insights.service.ts → finance() e metrics.ts.
// A receita da Comestra (faturas SaaS) e o volume das lojas (GMV) vêm em blocos separados e nunca são somados.

export interface FinanceInvoiceStatusItem {
  status: InvoiceStatus;
  count: number;
  amount: number;
}

export interface FinanceTopStore {
  store: InsightsStoreRef;
  gmv: number;
  paid_orders: number;
}

export interface DelinquentStore {
  store: InsightsStoreRef;
  amount: number;
  invoices: number;
  /** Vencimento da fatura em aberto mais antiga. */
  oldest_due_at: string | null;
}

/** Inadimplência ATUAL (faturas OPEN/FAILED já vencidas), independente do período escolhido. */
export interface Delinquency {
  amount: number;
  invoices: number;
  stores: number;
  currency: string;
  top_stores: DelinquentStore[];
  methodology: string;
  note: string | null;
}

export interface PlatformFinance {
  generated_at: string | null;
  time_zone: string;
  currency: string;
  /** Período efetivamente usado pela API (datas do calendário da plataforma). */
  period: { from: string; to: string; days: number };
  platform_revenue: RevenueBlock;
  invoices_by_status: { items: FinanceInvoiceStatusItem[]; methodology: string };
  mrr: MrrSummary;
  arr: ArrSummary;
  gmv: GmvBlock;
  top_stores_by_gmv: FinanceTopStore[];
  delinquency: Delinquency;
}

export interface FinancePeriodParams {
  /** AAAA-MM-DD; vazio = padrão da API. */
  from?: string;
  to?: string;
}

function parseInvoiceStatusItems(value: unknown): FinanceInvoiceStatusItem[] {
  const rows = readArray(value).map(asRecord);
  // Sempre as quatro situações, na ordem da API (OPEN, PAID, FAILED, VOID); ausente = zero
  return INVOICE_STATUSES.map((status) => {
    const row = rows.find((item) => item.status === status);
    return { status, count: readCount(row?.count), amount: readNumber(row?.amount, 0) };
  });
}

function parseTopStore(value: unknown): FinanceTopStore | null {
  const raw = asRecord(value);
  const store = parseStoreRef(raw.store);
  if (!store) return null;
  return { store, gmv: readNumber(raw.gmv, 0), paid_orders: readCount(raw.paid_orders) };
}

function parseDelinquentStore(value: unknown): DelinquentStore | null {
  const raw = asRecord(value);
  const store = parseStoreRef(raw.store);
  if (!store) return null;
  return {
    store,
    amount: readNumber(raw.amount, 0),
    invoices: readCount(raw.invoices),
    oldest_due_at: readDate(raw.oldest_due_at),
  };
}

export function parseFinance(value: unknown): PlatformFinance {
  const raw = asRecord(value);
  const period = asRecord(raw.period);
  const invoices = asRecord(raw.invoices_by_status);
  const delinquency = asRecord(raw.delinquency);

  return {
    generated_at: readDate(raw.generated_at),
    time_zone: readText(raw.time_zone),
    currency: readText(raw.currency, 'BRL'),
    period: { from: readText(period.from), to: readText(period.to), days: readCount(period.days) },
    platform_revenue: parseRevenue(raw.platform_revenue),
    invoices_by_status: {
      items: parseInvoiceStatusItems(invoices.items),
      methodology: readText(invoices.methodology),
    },
    mrr: parseMrr(raw.mrr),
    arr: parseArr(raw.arr),
    gmv: parseGmv(raw.gmv),
    top_stores_by_gmv: readArray(raw.top_stores_by_gmv).map(parseTopStore).filter((row): row is FinanceTopStore => row !== null),
    delinquency: {
      amount: readNumber(delinquency.amount, 0),
      invoices: readCount(delinquency.invoices),
      stores: readCount(delinquency.stores),
      currency: readText(delinquency.currency, 'BRL'),
      top_stores: readArray(delinquency.top_stores)
        .map(parseDelinquentStore)
        .filter((row): row is DelinquentStore => row !== null),
      methodology: readText(delinquency.methodology),
      note: readNullableText(delinquency.note),
    },
  };
}

export const platformFinanceService = {
  /** GET /platform/finance?from&to: receita da Comestra, faturas por situação, MRR/ARR, GMV, ranking e inadimplência. */
  async get(params: FinancePeriodParams = {}, signal?: AbortSignal): Promise<PlatformFinance> {
    const { data } = await api.get<unknown>(`/platform/finance${toQuery({ from: params.from, to: params.to })}`, { signal });
    return parseFinance(data);
  },
};
