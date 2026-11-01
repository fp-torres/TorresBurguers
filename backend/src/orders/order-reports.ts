/**
 * Relatório de vendas da loja (GET /orders/reports) em funções puras: agrupa os pedidos do período
 * pelo dia do calendário da loja, por status e por forma de pagamento. Coberto por order-reports.spec.ts.
 * Faturamento = pedidos PAGOS e não cancelados (mesma regra do dashboard).
 */
import { OrderStatus, PaymentStatus } from './order.enums';
import {
  dateKeyInZone,
  dateKeysBetween,
  fromCents,
  toCents,
} from './order-rules';

/** Colunas do pedido que o relatório usa. */
export interface ReportOrderRow {
  id: number;
  created_at: Date | string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  payment_method: string;
  total_price: number | string;
}

export interface ReportTopProduct {
  /** Nome do produto na época do pedido (retrato); pedidos antigos usam o nome atual. */
  name: string;
  quantity: number;
}

export interface OrdersReport {
  period: { from: string; to: string; days: number; timeZone: string };
  summary: {
    /** Pedidos feitos no período (todos os status). */
    orders: number;
    canceledOrders: number;
    /** Pagos e não cancelados. */
    paidOrders: number;
    revenue: number;
    /** revenue ÷ paidOrders (0 sem pedidos pagos). */
    averageTicket: number;
  };
  /** Um item por dia do período (dias sem pedidos aparecem zerados). */
  revenueByDay: {
    date: string;
    /** Pedidos não cancelados do dia. */
    orders: number;
    paidOrders: number;
    revenue: number;
  }[];
  /** Todos os status, inclusive os zerados. */
  ordersByStatus: { status: OrderStatus; count: number }[];
  /** Por forma de pagamento (pedidos não cancelados), do maior faturamento para o menor. */
  paymentMethods: {
    method: string;
    orders: number;
    paidOrders: number;
    revenue: number;
  }[];
  /** Até 10 produtos mais vendidos (pedidos não cancelados). */
  topProducts: ReportTopProduct[];
}

export const REPORT_TOP_PRODUCTS = 10;

const isPaid = (order: ReportOrderRow) =>
  order.status !== OrderStatus.CANCELED &&
  order.payment_status === PaymentStatus.PAID;

/**
 * Monta o relatório a partir dos pedidos do período. Pedidos cujo dia (no fuso da loja) cai fora de
 * from..to são ignorados, para que os totais e a soma dos dias sempre batam.
 */
export function buildOrdersReport(
  rows: readonly ReportOrderRow[],
  period: { from: string; to: string; days: number },
  timeZone: string,
  topProducts: readonly ReportTopProduct[] = [],
): OrdersReport {
  const days = new Map(
    dateKeysBetween(period.from, period.to).map((date) => [
      date,
      { orders: 0, paidOrders: 0, revenueCents: 0 },
    ]),
  );
  const statuses = new Map<OrderStatus, number>(
    Object.values(OrderStatus).map((status) => [status, 0]),
  );
  const methods = new Map<
    string,
    { orders: number; paidOrders: number; revenueCents: number }
  >();

  let orders = 0;
  let canceledOrders = 0;
  let paidOrders = 0;
  let revenueCents = 0;

  for (const order of rows) {
    const day = days.get(dateKeyInZone(new Date(order.created_at), timeZone));
    if (!day) continue;

    orders++;
    statuses.set(order.status, (statuses.get(order.status) ?? 0) + 1);
    if (order.status === OrderStatus.CANCELED) {
      canceledOrders++;
      continue;
    }

    const method = methods.get(order.payment_method) ?? {
      orders: 0,
      paidOrders: 0,
      revenueCents: 0,
    };
    methods.set(order.payment_method, method);
    day.orders++;
    method.orders++;

    if (isPaid(order)) {
      const cents = toCents(order.total_price);
      paidOrders++;
      revenueCents += cents;
      day.paidOrders++;
      day.revenueCents += cents;
      method.paidOrders++;
      method.revenueCents += cents;
    }
  }

  return {
    // Campos explícitos: o período pode chegar com outros (ex.: o "ok" de parseReportRange)
    period: {
      from: period.from,
      to: period.to,
      days: period.days,
      timeZone,
    },
    summary: {
      orders,
      canceledOrders,
      paidOrders,
      revenue: fromCents(revenueCents),
      averageTicket: paidOrders
        ? fromCents(Math.round(revenueCents / paidOrders))
        : 0,
    },
    revenueByDay: [...days.entries()].map(([date, day]) => ({
      date,
      orders: day.orders,
      paidOrders: day.paidOrders,
      revenue: fromCents(day.revenueCents),
    })),
    ordersByStatus: [...statuses.entries()].map(([status, count]) => ({
      status,
      count,
    })),
    paymentMethods: [...methods.entries()]
      .map(([method, data]) => ({
        method,
        orders: data.orders,
        paidOrders: data.paidOrders,
        revenue: fromCents(data.revenueCents),
      }))
      .sort(
        (a, b) =>
          b.revenue - a.revenue ||
          b.orders - a.orders ||
          a.method.localeCompare(b.method),
      ),
    topProducts: topProducts.slice(0, REPORT_TOP_PRODUCTS).map((item) => ({
      name: item.name,
      quantity: Number(item.quantity),
    })),
  };
}
