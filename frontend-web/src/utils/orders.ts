import type { Order, OrderAddress, OrderItem } from '../services/orderService';

// --- FORMAS DE PAGAMENTO ---
// Códigos da API: PIX | CREDIT_CARD | DEBIT_CARD | MONEY. Pedidos antigos podem ter DINHEIRO e CARTAO_*.

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  PIX: 'PIX',
  CREDIT_CARD: 'Cartão de crédito',
  DEBIT_CARD: 'Cartão de débito',
  MONEY: 'Dinheiro',
  // Valores legados
  DINHEIRO: 'Dinheiro',
  CARTAO_CREDITO: 'Cartão de crédito',
  CARTAO_DEBITO: 'Cartão de débito',
};

export function paymentMethodLabel(code?: string | null): string {
  if (!code) return 'Não informado';
  const normalized = code.trim().toUpperCase();
  if (PAYMENT_METHOD_LABELS[normalized]) return PAYMENT_METHOD_LABELS[normalized];
  if (normalized.startsWith('CARTAO')) {
    if (normalized.includes('DEB')) return 'Cartão de débito';
    if (normalized.includes('CRED')) return 'Cartão de crédito';
    return 'Cartão';
  }
  return code;
}

/** Pagamento em dinheiro (com possível troco). */
export function isCashPayment(code?: string | null): boolean {
  const normalized = code?.trim().toUpperCase();
  return normalized === 'MONEY' || normalized === 'DINHEIRO';
}

/** Pagamento online (PIX ou cartão pelo Mercado Pago): o pedido tem um pagamento vinculado. */
export function isOnlinePayment(order: Pick<Order, 'payment_id'>): boolean {
  return order.payment_id !== null && order.payment_id !== undefined;
}

type PaymentInfo = Pick<Order, 'payment_status' | 'payment_id' | 'type'> & { status?: string };

/** Rótulos comuns à equipe e ao cliente (pago, estornos e falha); null quando depende de quem lê. */
function settledPaymentLabel(order: PaymentInfo): string | null {
  switch (order.payment_status) {
    case 'PAID':
      return isOnlinePayment(order) ? 'Pago online' : 'Pago';
    case 'REFUNDED':
      return 'Estornado';
    case 'REFUND_PENDING':
      return 'Estorno pendente';
    case 'FAILED':
      return 'Falhou';
    default:
      return null;
  }
}

/**
 * Situação do pagamento para a equipe (quadro de pedidos), inclusive nos cancelados:
 * pago, estornado, estorno pendente, não cobrado ou a cobrar na entrega/retirada.
 */
export function paymentStatusLabel(order: PaymentInfo): string {
  const settled = settledPaymentLabel(order);
  if (settled) return settled;
  if (order.status === 'CANCELED') return 'Não cobrado';
  if (isOnlinePayment(order)) return 'Aguardando pagamento';
  return order.type === 'TAKEOUT' ? 'Cobrar na retirada' : 'Cobrar na entrega';
}

/** Situação do pagamento para o cliente (Meus Pedidos). */
export function customerPaymentStatusLabel(order: PaymentInfo): string {
  const settled = settledPaymentLabel(order);
  if (settled) return settled;
  if (order.status === 'CANCELED') return 'Não cobrado';
  if (isOnlinePayment(order)) return 'Aguardando pagamento';
  return order.type === 'TAKEOUT' ? 'Pagar na retirada' : 'Pagar na entrega';
}

/** Cor da situação do pagamento: pago, estornado, atenção (estorno pendente ou falha), a cobrar ou sem cobrança. */
export type PaymentTone = 'paid' | 'refunded' | 'alert' | 'pending' | 'none';

export function paymentStatusTone(order: PaymentInfo): PaymentTone {
  switch (order.payment_status) {
    case 'PAID':
      return 'paid';
    case 'REFUNDED':
      return 'refunded';
    case 'REFUND_PENDING':
    case 'FAILED':
      return 'alert';
    default:
      return order.status === 'CANCELED' ? 'none' : 'pending';
  }
}

export function isOrderPaid(order: Pick<Order, 'payment_status'>): boolean {
  return order.payment_status === 'PAID';
}

/** Pedido pago online e ainda não estornado: cancelar devolve o valor ao cliente. */
export function isRefundableOnCancel(order: Pick<Order, 'payment_status' | 'payment_id'>): boolean {
  return isOrderPaid(order) && isOnlinePayment(order);
}

// --- STATUS ---

const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Novo',
  PREPARING: 'Em preparo',
  READY_FOR_PICKUP: 'Pronto',
  DELIVERING: 'Em entrega',
  DONE: 'Concluído',
  CANCELED: 'Cancelado',
};

/** Nome do status para a equipe. O pronto diferencia balcão ("Pronto no Balcão") e entrega ("Aguardando entregador"). */
export function orderStatusLabel(status: string, type?: Order['type']): string {
  if (status === 'READY_FOR_PICKUP') return type === 'TAKEOUT' ? 'Pronto no Balcão' : 'Aguardando entregador';
  return ORDER_STATUS_LABELS[status] ?? status;
}

const CUSTOMER_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Aguardando Confirmação',
  PREPARING: 'Preparando',
  DELIVERING: 'Em Rota',
  DONE: 'Entregue',
  FINISHED: 'Entregue', // valor legado
  CANCELED: 'Cancelado',
};

/** Nome do status para o cliente (Meus Pedidos). Pronto e concluído diferenciam retirada e entrega. */
export function customerStatusLabel(status: string, type?: Order['type']): string {
  if (status === 'READY_FOR_PICKUP') return type === 'TAKEOUT' ? 'Pronto para retirada' : 'Aguardando entregador';
  if (status === 'DONE' && type === 'TAKEOUT') return 'Retirado';
  return CUSTOMER_STATUS_LABELS[status] ?? status;
}

export function isTerminalStatus(status: string): boolean {
  return status === 'DONE' || status === 'CANCELED';
}

// --- ENDEREÇO ---

/** Endereço de entrega do pedido: o retrato salvo no pedido; pedidos antigos usam o endereço cadastrado. */
export function orderAddress(order: Pick<Order, 'delivery_address' | 'address'>): OrderAddress | null {
  return order.delivery_address ?? order.address ?? null;
}

/** "Rua do Ouvidor, 50" */
export function addressStreetLine(address: OrderAddress): string {
  return [address.street, address.number].filter(Boolean).join(', ');
}

/** "Centro - Rio de Janeiro/RJ" */
export function addressAreaLine(address: OrderAddress): string {
  const city = address.state ? `${address.city}/${address.state}` : address.city;
  return [address.neighborhood, city].filter(Boolean).join(' - ');
}

/** Busca do endereço no Google Maps (rota do entregador). */
export function mapsSearchUrl(address: OrderAddress): string {
  const query = `${addressStreetLine(address)} - ${address.neighborhood}, ${address.city}${address.state ? ` - ${address.state}` : ''}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

// --- ITENS ---

/** Nome do item como foi vendido (retrato do pedido); pedidos antigos usam o nome atual do catálogo. */
export function orderItemName(item: Pick<OrderItem, 'product_name' | 'product'>): string {
  return item.product_name?.trim() || item.product?.name || 'Item removido';
}

/** Adicionais do item agrupados: [Bacon, Bacon, Ovo] → ["2x Bacon", "Ovo"]. */
export function addonSummary(item: Pick<OrderItem, 'addons' | 'addons_snapshot'>): string[] {
  const grouped = new Map<string, { name: string; quantity: number }>();

  if (Array.isArray(item.addons_snapshot) && item.addons_snapshot.length > 0) {
    item.addons_snapshot.forEach((addon) => {
      grouped.set(String(addon.id), { name: addon.name, quantity: Math.max(1, addon.quantity) });
    });
  } else {
    (item.addons ?? []).forEach((addon) => {
      const key = String(addon.id ?? addon.name);
      const current = grouped.get(key);
      grouped.set(key, { name: addon.name, quantity: (current?.quantity ?? 0) + 1 });
    });
  }

  return [...grouped.values()].map(({ name, quantity }) => (quantity > 1 ? `${quantity}x ${name}` : name));
}
