import api from '../api';
import { asRecord, isRecord, readArray, readDate, readEnum, readId, readNullableNumber, readNullableText, readNumber, readText } from '../panelParsers';
import type { StoreAccountStatus, SubscriptionStatus } from '../../types/saas';
import {
  STORE_ACCOUNT_STATUSES, SUBSCRIPTION_STATUSES, isMonthKey, parseArr, parseGmv, parseMonthCounts, parseMrr, parseRevenue,
  parseStoreRef, readCount, readCounts, type ArrSummary, type GmvBlock, type InsightsStoreRef, type MonthCount, type MrrSummary,
  type RevenueBlock,
} from './insightsParsers';

// Superpainel › Dashboard: GET /platform/dashboard (somente SUPER_ADMIN). Contrato em
// backend/src/platform/platform-insights.service.ts → dashboard() e metrics.ts.

/** Churn de um mês: canceladas no mês ÷ pagantes no início do mês (null = sem pagantes, não se aplica). */
export interface ChurnMonth {
  month: string;
  paying_at_start: number;
  canceled: number;
  /** 0 a 1 (4 casas) ou null. */
  rate: number | null;
  /** Mês em andamento. */
  partial: boolean;
  note: string | null;
}

/** Situações das assinaturas vigentes por plano (a distribuição não conta as canceladas). */
export type CurrentSubscriptionStatus = Exclude<SubscriptionStatus, 'CANCELED'>;
export const CURRENT_SUBSCRIPTION_STATUSES: readonly CurrentSubscriptionStatus[] = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED'];

export interface PlanDistributionItem {
  plan: { id: number; code: string; name: string; price: number; billing_interval: string };
  /** Assinaturas vigentes (não canceladas) no plano. */
  subscriptions: number;
  paying_subscriptions: number;
  by_status: Record<CurrentSubscriptionStatus, number>;
  mrr: number;
  /** Fração das assinaturas vigentes da plataforma (0 a 1); null sem assinaturas. */
  share: number | null;
}

export type AlertSeverity = 'critical' | 'warning' | 'info';
export const ALERT_SEVERITIES: readonly AlertSeverity[] = ['critical', 'warning', 'info'];

export interface PlatformAlert {
  /** PAST_DUE_GRACE_ENDING, SUBSCRIPTION_SUSPENDED, REFUND_PENDING, INVOICE_FAILED, NO_ACTIVE_ADMIN... */
  type: string;
  severity: AlertSeverity;
  store: InsightsStoreRef | null;
  message: string;
  data: Record<string, unknown> | null;
}

export interface PlatformDashboard {
  generated_at: string | null;
  time_zone: string;
  currency: string;
  stores: {
    total: number;
    by_status: Record<StoreAccountStatus, number>;
    new_by_month: MonthCount[];
  };
  subscriptions: {
    by_status: Record<SubscriptionStatus, number>;
    /** Não canceladas. */
    current: number;
  };
  mrr: MrrSummary;
  arr: ArrSummary;
  churn: { months: ChurnMonth[]; methodology: string };
  /** Pedidos processados (todas as lojas, exceto cancelados), desde o início e por mês. */
  orders: { total: number; by_month: MonthCount[]; methodology: string };
  gmv: GmvBlock;
  platform_revenue: RevenueBlock;
  plans: PlanDistributionItem[];
  alerts: PlatformAlert[];
}

function parseChurnMonth(value: unknown): ChurnMonth | null {
  const raw = asRecord(value);
  if (!isMonthKey(raw.month)) return null;
  const rate = readNullableNumber(raw.rate);
  return {
    month: raw.month,
    paying_at_start: readCount(raw.paying_at_start),
    canceled: readCount(raw.canceled),
    rate: rate === null ? null : Math.max(0, rate),
    partial: raw.partial === true,
    note: readNullableText(raw.note),
  };
}

function parsePlanItem(value: unknown): PlanDistributionItem | null {
  const raw = asRecord(value);
  const plan = asRecord(raw.plan);
  const id = readId(plan.id);
  if (!id) return null;
  const share = readNullableNumber(raw.share);
  return {
    plan: {
      id,
      code: readText(plan.code),
      name: readText(plan.name) || readText(plan.code) || `Plano #${id}`,
      price: readNumber(plan.price, 0),
      billing_interval: readText(plan.billing_interval, 'MONTHLY'),
    },
    subscriptions: readCount(raw.subscriptions),
    paying_subscriptions: readCount(raw.paying_subscriptions),
    by_status: readCounts(raw.by_status, CURRENT_SUBSCRIPTION_STATUSES),
    mrr: readNumber(raw.mrr, 0),
    share: share === null ? null : Math.min(1, Math.max(0, share)),
  };
}

function parseAlert(value: unknown): PlatformAlert | null {
  const raw = asRecord(value);
  const type = readText(raw.type);
  const message = readText(raw.message);
  if (!type && !message) return null;
  return {
    type,
    severity: readEnum(raw.severity, ALERT_SEVERITIES, 'info'),
    store: parseStoreRef(raw.store),
    message,
    data: isRecord(raw.data) ? raw.data : null,
  };
}

export function parseDashboard(value: unknown): PlatformDashboard {
  const raw = asRecord(value);
  const stores = asRecord(raw.stores);
  const subscriptions = asRecord(raw.subscriptions);
  const churn = asRecord(raw.churn);
  const orders = asRecord(raw.orders);
  const byStatus = readCounts(stores.by_status, STORE_ACCOUNT_STATUSES);
  const subscriptionsByStatus = readCounts(subscriptions.by_status, SUBSCRIPTION_STATUSES);

  return {
    generated_at: readDate(raw.generated_at),
    time_zone: readText(raw.time_zone),
    currency: readText(raw.currency, 'BRL'),
    stores: {
      total: readCount(stores.total),
      by_status: byStatus,
      new_by_month: parseMonthCounts(stores.new_by_month),
    },
    subscriptions: {
      by_status: subscriptionsByStatus,
      current: readCount(subscriptions.current),
    },
    mrr: parseMrr(raw.mrr),
    arr: parseArr(raw.arr),
    churn: {
      months: readArray(churn.months).map(parseChurnMonth).filter((month): month is ChurnMonth => month !== null),
      methodology: readText(churn.methodology),
    },
    orders: {
      total: readCount(orders.total),
      by_month: parseMonthCounts(orders.by_month),
      methodology: readText(orders.methodology),
    },
    gmv: parseGmv(raw.gmv),
    platform_revenue: parseRevenue(raw.platform_revenue),
    plans: readArray(raw.plans).map(parsePlanItem).filter((item): item is PlanDistributionItem => item !== null),
    alerts: readArray(raw.alerts).map(parseAlert).filter((alert): alert is PlatformAlert => alert !== null),
  };
}

export const platformDashboardService = {
  /** GET /platform/dashboard: lojas, assinaturas, MRR/ARR, churn, pedidos, GMV, receita, planos e alertas. */
  async get(signal?: AbortSignal): Promise<PlatformDashboard> {
    const { data } = await api.get<unknown>('/platform/dashboard', { signal });
    return parseDashboard(data);
  },
};
