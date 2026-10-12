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
  id: number;
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

export const orderService = {
  // Listagem Geral (histórico completo)
  getAll: async () => {
    const response = await api.get<Order[]>('/orders');
    return response.data;
  },

  /** Quadro da equipe: pedidos em andamento e os concluídos/cancelados nas últimas 24 h, mais novos primeiro. */
  getActive: async () => {
    const response = await api.get<Order[]>('/orders', { params: { scope: 'active' } });
    return response.data;
  },

  getMyOrders: async () => {
    const response = await api.get<Order[]>('/orders/my-orders');
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

  getDashboard: async () => {
    const response = await api.get('/orders/summary');
    return response.data;
  },

  getCharts: async () => {
    const response = await api.get<OrderCharts>('/orders/charts');
    return response.data;
  },

  // --- FUNÇÕES DE LOGÍSTICA ---

  // 1. Buscar lista de motoboys
  getDrivers: async () => {
    const response = await api.get<Driver[]>('/orders/drivers/list');
    return response.data;
  },

  // 2. Atribuir um motoboy a um pedido
  assignDriver: async (orderId: number, driverId: number) => {
    const response = await api.patch(`/orders/${orderId}/assign`, { driverId });
    return response.data;
  },

  // 3. Buscar pedidos próximos (sugestão de rota)
  getNearbyOrders: async (orderId: number) => {
    const response = await api.get<Order[]>(`/orders/${orderId}/nearby`);
    return response.data;
  }
};

/** Gráficos do Dashboard: faturamento dos últimos 7 dias e produtos mais vendidos. */
export interface OrderCharts {
  revenueChart?: { date: string; total: number }[];
  productsChart?: { name: string; quantity: number }[];
}
