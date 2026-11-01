import api from './api';

export interface Addon {
  id: number;
  name: string;
  price: string | number;
}

/** Adicional como foi cobrado no pedido (nome e preço da época, com a quantidade). */
export interface OrderAddonSnapshot {
  id: number;
  name: string;
  price: number;
  quantity: number;
}

export interface OrderItem {
  id: number;
  quantity: number;
  /** Nome do produto como foi vendido (retrato do pedido; pedidos antigos não têm). */
  product_name?: string | null;
  /** Produto do catálogo (pode vir nulo se foi excluído definitivamente). */
  product: {
    id: number;
    name: string;
    price: string | number;
    image: string | null;
  } | null;
  observation?: string | null;
  /** Uma entrada por unidade: [Bacon, Bacon] = 2x Bacon. */
  addons: Addon[];
  /** Os mesmos adicionais agrupados com a quantidade (pedidos antigos podem não ter). */
  addons_snapshot?: OrderAddonSnapshot[] | null;
  /** Preço unitário cobrado (nulo em pedidos anteriores ao retrato de preços). */
  unit_price?: number | null;
  meat_point?: string | null;
  removed_ingredients?: string[] | null;
}

// Interface do Motoboy (Alinhada com o User entity do backend)
export interface Driver {
  id: number;
  name: string;
  phone: string;
  avatar?: string | null;
}

export type OrderStatus = 'PENDING' | 'PREPARING' | 'READY_FOR_PICKUP' | 'DELIVERING' | 'DONE' | 'CANCELED';

/** Todos os status, na ordem do fluxo (relatórios e filtros). */
export const ORDER_STATUSES: readonly OrderStatus[] = ['PENDING', 'PREPARING', 'READY_FOR_PICKUP', 'DELIVERING', 'DONE', 'CANCELED'];

/**
 * Situação do pagamento: PENDING (a cobrar ou aguardando), PAID (pago online ou recebido na entrega),
 * FAILED, REFUNDED (pedido cancelado e valor estornado) e REFUND_PENDING (o estorno falhou e a loja precisa concluí-lo).
 */
export type PaymentStatus = 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED' | 'REFUND_PENDING';

/** Endereço de entrega guardado no pedido (retrato do momento da compra). */
export interface OrderAddress {
  street: string;
  number: string;
  complement?: string | null;
  neighborhood: string;
  city: string;
  state?: string | null;
  zipCode?: string | null;
  nickname?: string | null;
}

export interface Order {
  /** Chave do pedido nas rotas da API (global entre as lojas: não é mostrada ao cliente). */
  id: number;
  /**
   * Número do pedido NA LOJA (1, 2, 3...): o "Pedido #N" das telas. Opcional só para respostas antigas;
   * use orderNumber()/orderLabel().
   */
  number?: number | null;
  status: OrderStatus;
  payment_status?: PaymentStatus;
  total_price: string | number;
  delivery_fee?: string | number;
  /** PIX | CREDIT_CARD | DEBIT_CARD | MONEY (pedidos antigos podem ter DINHEIRO, CARTAO_*). */
  payment_method: string;
  /** Pagamento online vinculado (sem ele, o pagamento é na entrega/retirada). */
  payment_id?: number | null;
  change_for?: string | null;
  created_at: string;
  estimated_delivery_time?: string | null;
  type: 'DELIVERY' | 'TAKEOUT';

  user: {
    id: number;
    name: string;
    email?: string;
    phone?: string | null;
  } | null;

  driver?: Driver | null; // Entregador atribuído

  /** Endereço de entrega como era na criação do pedido (nulo na retirada). Use orderAddress() de utils/orders. */
  delivery_address?: OrderAddress | null;
  /** Endereço cadastrado do cliente (pedidos antigos, sem o retrato acima). */
  address?: OrderAddress | null;
  items: OrderItem[];
}

/** Gráficos do Dashboard: faturamento dos últimos 7 dias (date = AAAA-MM-DD no fuso da loja) e produtos mais vendidos. */
export interface OrderCharts {
  revenueChart?: { date: string; total: number }[];
  productsChart?: { name: string; quantity: number }[];
}

/** Totais da loja (GET /orders/summary). */
export interface OrderSummary {
  /** Pedidos não cancelados. */
  totalOrders: number;
  /** Soma dos pedidos pagos e não cancelados. */
  revenue: number;
  pendingOrders: number;
  preparingOrders: number;
  /** Pedidos em andamento ainda sem pagamento. */
  pendingPayments: number;
}

/** Relatório de vendas do período (GET /orders/reports). Faturamento = pedidos pagos e não cancelados. */
export interface OrdersReport {
  period: { from: string; to: string; days: number; timeZone: string };
  summary: { orders: number; canceledOrders: number; paidOrders: number; revenue: number; averageTicket: number };
  /** Um item por dia do período (dias sem pedidos aparecem zerados). */
  revenueByDay: { date: string; orders: number; paidOrders: number; revenue: number }[];
  /** Todos os status, inclusive os zerados. */
  ordersByStatus: { status: string; count: number }[];
  /** Por forma de pagamento (pedidos não cancelados), do maior faturamento para o menor. */
  paymentMethods: { method: string; orders: number; paidOrders: number; revenue: number }[];
  /** Até 10 produtos mais vendidos (pedidos não cancelados). */
  topProducts: { name: string; quantity: number }[];
}

type RawRecord = Record<string, unknown>;

function toRecord(value: unknown): RawRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RawRecord) : {};
}

function toRecords(value: unknown): RawRecord[] {
  return Array.isArray(value) ? value.map(toRecord) : [];
}

function toAmount(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function toLabel(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function toOrderSummary(data: unknown): OrderSummary {
  const raw = toRecord(data);
  return {
    totalOrders: toAmount(raw.totalOrders),
    revenue: toAmount(raw.revenue),
    pendingOrders: toAmount(raw.pendingOrders),
    preparingOrders: toAmount(raw.preparingOrders),
    pendingPayments: toAmount(raw.pendingPayments),
  };
}

function toOrderCharts(data: unknown): Required<OrderCharts> {
  const raw = toRecord(data);
  return {
    revenueChart: toRecords(raw.revenueChart).map((point) => ({ date: toLabel(point.date), total: toAmount(point.total) })),
    productsChart: toRecords(raw.productsChart).map((point) => ({ name: toLabel(point.name), quantity: toAmount(point.quantity) })),
  };
}

function toOrdersReport(data: unknown): OrdersReport {
  const raw = toRecord(data);
  const period = toRecord(raw.period);
  const summary = toRecord(raw.summary);
  return {
    period: {
      from: toLabel(period.from),
      to: toLabel(period.to),
      days: toAmount(period.days),
      timeZone: toLabel(period.timeZone),
    },
    summary: {
      orders: toAmount(summary.orders),
      canceledOrders: toAmount(summary.canceledOrders),
      paidOrders: toAmount(summary.paidOrders),
      revenue: toAmount(summary.revenue),
      averageTicket: toAmount(summary.averageTicket),
    },
    revenueByDay: toRecords(raw.revenueByDay).map((day) => ({
      date: toLabel(day.date),
      orders: toAmount(day.orders),
      paidOrders: toAmount(day.paidOrders),
      revenue: toAmount(day.revenue),
    })),
    ordersByStatus: toRecords(raw.ordersByStatus).map((item) => ({ status: toLabel(item.status), count: toAmount(item.count) })),
    paymentMethods: toRecords(raw.paymentMethods).map((item) => ({
      method: toLabel(item.method),
      orders: toAmount(item.orders),
      paidOrders: toAmount(item.paidOrders),
      revenue: toAmount(item.revenue),
    })),
    topProducts: toRecords(raw.topProducts).map((item) => ({ name: toLabel(item.name), quantity: toAmount(item.quantity) })),
  };
}

/** Número do pedido na loja (respostas sem "number" caem no id, como antes). */
export function orderNumber(order: Pick<Order, 'id' | 'number'>): number {
  return typeof order.number === 'number' && order.number > 0 ? order.number : order.id;
}

/** "#12": rótulo curto do pedido nas telas (cliente, quadro, cozinha, entregador e painel). */
export function orderLabel(order: Pick<Order, 'id' | 'number'>): string {
  return `#${orderNumber(order)}`;
}

export const orderService = {
  // Listagem Geral (histórico completo da loja)
  getAll: async () => {
    const response = await api.get<Order[]>('/orders');
    return response.data;
  },

  /** Quadro da equipe: pedidos em andamento e os concluídos/cancelados nas últimas 24 h, mais novos primeiro. */
  getActive: async (signal?: AbortSignal) => {
    const response = await api.get<Order[]>('/orders', { params: { scope: 'active' }, signal });
    return Array.isArray(response.data) ? response.data : [];
  },

  getMyOrders: async () => {
    const response = await api.get<Order[]>('/orders/my-orders');
    return response.data;
  },

  /** Pedido do próprio cliente (na loja da vitrine, quando informada). 404 para pedido de outro cliente ou loja. */
  getMyOrder: async (id: number, storeSlug?: string, signal?: AbortSignal) => {
    const path = storeSlug ? `/stores/${encodeURIComponent(storeSlug)}/orders/${id}` : `/orders/${id}`;
    const response = await api.get<Order>(path, { signal });
    return response.data;
  },

  /** A API aceita apenas { status } e valida a transição para o perfil logado. */
  updateStatus: async (id: number, status: OrderStatus) => {
    await api.patch(`/orders/${id}`, { status });
  },

  /**
   * Cancelamento pelo cliente (enquanto PENDING) ou pela gestão (enquanto não finalizado).
   * Pedido pago online é estornado pela API: devolve o pedido com payment_status REFUNDED ou REFUND_PENDING.
   */
  cancel: async (id: number) => {
    const response = await api.patch<Order>(`/orders/${id}/cancel`);
    return response.data;
  },

  // --- DASHBOARD E RELATÓRIOS (Administrador; sempre a loja do usuário, no fuso da loja) ---

  /** GET /orders/summary: totais da loja (faturamento = pedidos pagos e não cancelados). */
  getSummary: async (signal?: AbortSignal) => {
    const response = await api.get<unknown>('/orders/summary', { signal });
    return toOrderSummary(response.data);
  },

  /** GET /orders/charts: últimos 7 dias. 403 quando o plano não inclui relatórios e gráficos. */
  getCharts: async (signal?: AbortSignal) => {
    const response = await api.get<unknown>('/orders/charts', { signal });
    return toOrderCharts(response.data);
  },

  /**
   * GET /orders/reports?from=AAAA-MM-DD&to=AAAA-MM-DD (datas do calendário da loja; sem datas = últimos 30 dias).
   * 403 quando o plano não inclui relatórios; 400 com período inválido (máximo de 366 dias).
   */
  getReports: async (range: { from?: string; to?: string }, signal?: AbortSignal) => {
    const response = await api.get<unknown>('/orders/reports', {
      params: { from: range.from || undefined, to: range.to || undefined },
      signal,
    });
    return toOrdersReport(response.data);
  },

  // --- FUNÇÕES DE LOGÍSTICA ---

  // 1. Buscar lista de motoboys da loja
  getDrivers: async () => {
    const response = await api.get<Driver[]>('/orders/drivers/list');
    return Array.isArray(response.data) ? response.data : [];
  },

  // 2. Atribuir um motoboy a um pedido
  assignDriver: async (orderId: number, driverId: number) => {
    const response = await api.patch(`/orders/${orderId}/assign`, { driverId });
    return response.data;
  },

  // 3. Buscar pedidos próximos (sugestão de rota)
  getNearbyOrders: async (orderId: number) => {
    const response = await api.get<Order[]>(`/orders/${orderId}/nearby`);
    return Array.isArray(response.data) ? response.data : [];
  }
};
