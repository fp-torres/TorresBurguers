import type { FeatherIconName } from './catalog';
import type { UserRole } from './roles';
import { parseMoney } from './format';

export type OrderStatus = 'PENDING' | 'PREPARING' | 'READY_FOR_PICKUP' | 'DELIVERING' | 'DONE' | 'CANCELED';
export type OrderType = 'DELIVERY' | 'TAKEOUT';
export type PaymentStatus = 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED' | 'REFUND_PENDING';

export interface OrderPerson {
  id: number;
  name: string;
  phone?: string | null;
}

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

/** Adicional como vem do backend: relação antiga (sem quantity) ou snapshot {id, name, price, quantity}. */
export interface OrderAddon {
  id?: number;
  name: string;
  price?: number | string;
  quantity?: number;
}

export interface OrderItem {
  id: number;
  quantity: number;
  unit_price?: number | string | null;
  product?: { id: number; name: string; image?: string | null } | null;
  product_name?: string | null;
  addons?: OrderAddon[] | null;
  addons_snapshot?: OrderAddon[] | null;
  observation?: string | null;
  meat_point?: string | null;
  removed_ingredients?: string[] | string | null;
}

export interface Order {
  id: number;
  status: OrderStatus | string;
  type: OrderType | string;
  total_price: number | string;
  delivery_fee?: number | string | null;
  payment_method?: string | null;
  payment_status?: string | null;
  payment_id?: number | string | null;
  change_for?: string | number | null;
  estimated_delivery_time?: string | null;
  created_at: string;
  /** Muda a cada alteração do pedido (status, pagamento, entregador): usado para comparar listas. */
  updated_at?: string | null;
  user?: OrderPerson | null;
  driver?: OrderPerson | null;
  /** Retrato do endereço gravado na criação do pedido (null na retirada). */
  delivery_address?: OrderAddress | null;
  /** Endereço cadastrado (relação): só para pedidos antigos, sem retrato. */
  address?: OrderAddress | null;
  items?: OrderItem[] | null;
}

export const ACTIVE_STATUSES: OrderStatus[] = ['PENDING', 'PREPARING', 'READY_FOR_PICKUP', 'DELIVERING'];

export function isTerminalStatus(status: string): boolean {
  return status === 'DONE' || status === 'CANCELED';
}

// ----------------------------------------------------------------------------
// Status
// ----------------------------------------------------------------------------

interface StatusBadge {
  label: string;
  bg: string;
  text: string;
}

/** Rótulo e cores do status para o cliente (Meus Pedidos / Detalhes). */
export function orderStatusBadge(status: string, type?: string): StatusBadge {
  switch (status) {
    case 'PENDING':
      return { label: 'Aguardando confirmação', bg: 'bg-orange-100 dark:bg-orange-900/30', text: 'text-orange-600 dark:text-orange-400' };
    case 'PREPARING':
      return { label: 'Em preparo', bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-600 dark:text-blue-400' };
    case 'READY_FOR_PICKUP':
      return {
        label: type === 'TAKEOUT' ? 'Pronto para retirada' : 'Aguardando entregador',
        bg: 'bg-purple-100 dark:bg-purple-900/30',
        text: 'text-purple-600 dark:text-purple-400',
      };
    case 'DELIVERING':
      return { label: 'Saiu para entrega', bg: 'bg-indigo-100 dark:bg-indigo-900/30', text: 'text-indigo-600 dark:text-indigo-400' };
    case 'DONE':
      return { label: 'Concluído', bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-600 dark:text-green-400' };
    case 'CANCELED':
      return { label: 'Cancelado', bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-600 dark:text-red-400' };
    default:
      return { label: status, bg: 'bg-gray-100 dark:bg-slate-700', text: 'text-gray-600 dark:text-slate-300' };
  }
}

/** Rótulo curto do status para o painel da equipe. */
export function staffStatusLabel(status: string, type?: string): string {
  switch (status) {
    case 'PENDING': return 'Novo';
    case 'PREPARING': return 'Em preparo';
    case 'READY_FOR_PICKUP': return type === 'TAKEOUT' ? 'Pronto para retirada' : 'Aguardando entregador';
    case 'DELIVERING': return 'Em entrega';
    case 'DONE': return 'Concluído';
    case 'CANCELED': return 'Cancelado';
    default: return status;
  }
}

// ----------------------------------------------------------------------------
// Pagamento
// ----------------------------------------------------------------------------

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  PIX: 'PIX',
  CREDIT_CARD: 'Cartão de crédito',
  DEBIT_CARD: 'Cartão de débito',
  MONEY: 'Dinheiro',
  // Valores antigos que já podem estar gravados em pedidos
  DINHEIRO: 'Dinheiro',
  CARTAO: 'Cartão',
  CARTAO_CREDITO: 'Cartão de crédito',
  CARTAO_DEBITO: 'Cartão de débito',
};

export function paymentMethodLabel(code?: string | null): string {
  if (!code) return 'Não informado';
  const normalized = code.trim().toUpperCase();
  return PAYMENT_METHOD_LABELS[normalized] ?? code.replace(/_/g, ' ');
}

export function isCashPayment(code?: string | null): boolean {
  const normalized = (code ?? '').trim().toUpperCase();
  return normalized === 'MONEY' || normalized === 'DINHEIRO';
}

function isCardPayment(code?: string | null): boolean {
  const normalized = (code ?? '').trim().toUpperCase();
  return normalized.includes('CARD') || normalized.startsWith('CARTAO');
}

/** Pedido pago pelo app (PIX/cartão online) — os demais são pagos na entrega/retirada. */
export function isPaidOnline(order: Pick<Order, 'payment_id'>): boolean {
  return order.payment_id !== null && order.payment_id !== undefined && order.payment_id !== '';
}

/** Ex.: "PIX • pago pelo app", "Cartão de crédito • maquininha na entrega". */
export function paymentDescription(order: Pick<Order, 'payment_method' | 'payment_id' | 'type'>): string {
  const method = paymentMethodLabel(order.payment_method);
  if (isPaidOnline(order)) return `${method} • pago pelo app`;
  const moment = order.type === 'TAKEOUT' ? 'na retirada' : 'na entrega';
  return isCardPayment(order.payment_method) ? `${method} • maquininha ${moment}` : `${method} • ${moment}`;
}

/**
 * Rótulo do status do pagamento do pedido (o mesmo do painel web). PENDING depende do pedido:
 * - cancelado: "Não cobrado" (nada será cobrado);
 * - pago pelo app: "Aguardando pagamento";
 * - pago na entrega/retirada: "A pagar na entrega" ou "A pagar na retirada".
 */
export function orderPaymentStatusLabel(order: Pick<Order, 'payment_status' | 'payment_id' | 'status' | 'type'>): string {
  switch (order.payment_status) {
    case 'PENDING':
      if (order.status === 'CANCELED') return 'Não cobrado';
      if (isPaidOnline(order)) return 'Aguardando pagamento';
      return order.type === 'TAKEOUT' ? 'A pagar na retirada' : 'A pagar na entrega';
    case 'PAID': return 'Pago';
    case 'REFUNDED': return 'Estornado';
    case 'REFUND_PENDING': return 'Estorno pendente';
    case 'FAILED': return 'Falhou';
    default: return order.payment_status ?? '';
  }
}

/** Cor do texto do status do pagamento. */
export function paymentStatusTextClass(status?: string | null): string {
  switch (status) {
    case 'PAID': return 'text-green-600 dark:text-green-400';
    case 'REFUNDED': return 'text-blue-600 dark:text-blue-400';
    case 'REFUND_PENDING': return 'text-amber-600 dark:text-amber-400';
    case 'FAILED': return 'text-red-600 dark:text-red-400';
    default: return 'text-slate-500 dark:text-slate-400';
  }
}

/** Pedido já pago pelo app: cancelar devolve o valor (estorno pelo Mercado Pago). */
export function isRefundableOnCancel(order: Pick<Order, 'payment_id' | 'payment_status'>): boolean {
  return isPaidOnline(order) && order.payment_status === 'PAID';
}

/** Troco: valor informado pelo cliente e quanto o entregador deve levar (nada em pedido cancelado). */
export function changeInfo(order: Pick<Order, 'payment_method' | 'change_for' | 'total_price' | 'status'>) {
  if (order.status === 'CANCELED' || !isCashPayment(order.payment_method)) return null;
  const paidWith = parseMoney(order.change_for);
  const total = Number(order.total_price) || 0;
  if (paidWith <= total) return null;
  return { paidWith, change: paidWith - total };
}

// ----------------------------------------------------------------------------
// Itens
// ----------------------------------------------------------------------------

/** Adicionais agrupados com quantidade (snapshot novo ou relação antiga com ids repetidos). */
export function itemAddons(item: OrderItem): { name: string; quantity: number }[] {
  const source = item.addons_snapshot ?? item.addons ?? [];
  const grouped = new Map<string, { name: string; quantity: number }>();
  for (const addon of source) {
    if (!addon?.name) continue;
    const key = addon.id !== undefined ? String(addon.id) : addon.name;
    const current = grouped.get(key);
    const quantity = Number(addon.quantity) > 0 ? Number(addon.quantity) : 1;
    if (current) current.quantity += quantity;
    else grouped.set(key, { name: addon.name, quantity });
  }
  return Array.from(grouped.values());
}

/** Nome gravado no pedido (product_name); em pedidos antigos, o nome atual do produto. */
export function itemName(item: OrderItem): string {
  return item.product_name?.trim() || item.product?.name || 'Produto removido';
}

/** Unidades do pedido, no singular ou plural. Ex.: "1 item", "3 itens". */
export function itemCountLabel(order: Pick<Order, 'items'>): string {
  const units = (order.items ?? []).reduce((acc, item) => acc + (Number(item.quantity) || 0), 0);
  return `${units} ${units === 1 ? 'item' : 'itens'}`;
}

/** Resumo dos itens para listas. Ex.: "2x X-Bacon, 1x Refrigerante". */
export function itemsSummary(order: Pick<Order, 'items'>): string {
  return (order.items ?? []).map((item) => `${item.quantity}x ${itemName(item)}`).join(', ');
}

// ----------------------------------------------------------------------------
// Endereço
// ----------------------------------------------------------------------------

/** Endereço da entrega: o retrato gravado no pedido; em pedidos antigos, o endereço cadastrado. */
export function orderAddress(order: Pick<Order, 'delivery_address' | 'address'>): OrderAddress | null {
  return order.delivery_address ?? order.address ?? null;
}

/** Ex.: ["Rua das Acácias, 45 - Apto 2", "Centro, Niterói - RJ"]. */
export function addressLines(address: OrderAddress): [string, string] {
  const street = `${address.street}, ${address.number}${address.complement ? ` - ${address.complement}` : ''}`;
  const place = [address.neighborhood, address.city].filter(Boolean).join(', ');
  return [street, `${place}${address.state ? ` - ${address.state}` : ''}`];
}

export function removedIngredients(item: OrderItem): string[] {
  if (!item.removed_ingredients) return [];
  const list = Array.isArray(item.removed_ingredients)
    ? item.removed_ingredients
    : item.removed_ingredients.split(',');
  return list.map((ingredient) => ingredient.trim()).filter(Boolean);
}

// ----------------------------------------------------------------------------
// Ações da equipe (espelham a tabela de transições do backend)
// ----------------------------------------------------------------------------

export type OrderActionKind = 'status' | 'assign' | 'cancel';

export interface OrderAction {
  key: string;
  kind: OrderActionKind;
  label: string;
  icon: FeatherIconName;
  /** Classe de cor do botão principal. */
  color: string;
  to?: OrderStatus;
}

/**
 * Ações disponíveis para o perfil logado:
 * - Cozinha: PENDING → PREPARING → READY_FOR_PICKUP;
 * - Entregador: READY_FOR_PICKUP → DELIVERING (só delivery, livre ou já dele) e DELIVERING → DONE (só as próprias);
 * - Administrador/Atendente: todo o fluxo, atribuição de entregador e cancelamento.
 * Pedidos de retirada nunca passam por DELIVERING.
 */
export function staffActions(order: Order, role: UserRole | string | undefined, userId?: number): OrderAction[] {
  if (isTerminalStatus(order.status)) return [];
  const isDelivery = order.type === 'DELIVERY';

  if (role === 'KITCHEN') {
    if (order.status === 'PENDING') return [ACCEPT];
    if (order.status === 'PREPARING') return [readyAction(isDelivery)];
    return [];
  }

  if (role === 'COURIER') {
    const mine = order.driver?.id !== undefined && order.driver?.id === userId;
    if (order.status === 'READY_FOR_PICKUP' && isDelivery && (!order.driver || mine)) {
      return [{ key: 'pickup', kind: 'status', label: 'Pegar para Entrega', icon: 'navigation', color: 'bg-indigo-600', to: 'DELIVERING' }];
    }
    if (order.status === 'DELIVERING' && mine) return [DELIVERED];
    return [];
  }

  if (role === 'ADMIN' || role === 'EMPLOYEE') {
    const actions: OrderAction[] = [];
    if (order.status === 'PENDING') actions.push(ACCEPT);
    if (order.status === 'PREPARING') actions.push(readyAction(isDelivery));
    if (order.status === 'READY_FOR_PICKUP') {
      actions.push(isDelivery
        ? { key: 'assign', kind: 'assign', label: 'Atribuir Entregador', icon: 'user-check', color: 'bg-indigo-600' }
        : { key: 'handover', kind: 'status', label: 'Entregue ao Cliente', icon: 'check', color: 'bg-teal-600', to: 'DONE' });
    }
    if (order.status === 'DELIVERING') {
      actions.push(DELIVERED);
      actions.push({ key: 'reassign', kind: 'assign', label: 'Trocar Entregador', icon: 'repeat', color: 'bg-slate-600' });
    }
    actions.push({ key: 'cancel', kind: 'cancel', label: 'Cancelar Pedido', icon: 'x-circle', color: 'bg-red-600' });
    return actions;
  }

  return [];
}

const ACCEPT: OrderAction = { key: 'accept', kind: 'status', label: 'Aceitar e Preparar', icon: 'play', color: 'bg-blue-600', to: 'PREPARING' };
const DELIVERED: OrderAction = { key: 'delivered', kind: 'status', label: 'Confirmar Entrega', icon: 'check-circle', color: 'bg-green-600', to: 'DONE' };

function readyAction(isDelivery: boolean): OrderAction {
  return {
    key: 'ready',
    kind: 'status',
    label: isDelivery ? 'Pronto (Chamar Entregador)' : 'Pronto (Balcão)',
    icon: isDelivery ? 'bell' : 'check-circle',
    color: 'bg-orange-600',
    to: 'READY_FOR_PICKUP',
  };
}
