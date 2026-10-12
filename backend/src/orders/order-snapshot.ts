/**
 * Retrato do pedido: o que foi orçado/cobrado (itens com preço e nome da época, endereço de entrega,
 * taxa e total). O mesmo formato cria os pedidos pagos na entrega (na hora) e os pagos online
 * (guardado no pagamento e usado pelo servidor quando ele é aprovado, mesmo que o cardápio,
 * os preços ou o status da loja tenham mudado depois).
 */
import type { DeepPartial } from 'typeorm';
import type { Address } from '../addresses/entities/address.entity';
import type { Addon } from '../products/entities/addon.entity';
import type { Product } from '../products/entities/product.entity';
import type { Order } from './entities/order.entity';
import {
  OrderItem,
  type OrderItemAddonSnapshot,
} from './entities/order-item.entity';
import { OrderStatus, OrderType, PaymentStatus } from './order.enums';
import type { PricedOrder } from './order-pricing.service';

/** Endereço de entrega como estava no momento do pedido. */
export interface DeliveryAddressSnapshot {
  street: string;
  number: string;
  complement: string | null;
  neighborhood: string;
  city: string;
  state: string;
  zipCode: string;
  nickname: string | null;
}

export interface OrderItemSnapshot {
  productId: number;
  productName: string;
  quantity: number;
  unitPrice: number;
  /** Adicionais de UMA unidade do item. */
  addonsTotal: number;
  lineTotal: number;
  addons: OrderItemAddonSnapshot[];
  observation: string;
  meatPoint: string | null;
  removedIngredients: string[];
}

export interface OrderSnapshot {
  type: OrderType;
  addressId: number | null;
  deliveryAddress: DeliveryAddressSnapshot | null;
  items: OrderItemSnapshot[];
  subtotal: number;
  deliveryFee: number;
  total: number;
  estimatedDeliveryTime: string;
}

/** Dados do pedido que não vêm do orçamento. */
export interface OrderMeta {
  userId: number;
  paymentMethod: string;
  paymentStatus: PaymentStatus;
  paymentId: number | null;
  changeFor: string | null;
}

/**
 * Referências do catálogo que ainda existem no banco. Um pagamento aprovado horas depois pode
 * encontrar um produto/adicional/endereço apagado de vez: o item fica só com o retrato (nome e preço).
 */
export interface ExistingReferences {
  productIds: ReadonlySet<number>;
  addonIds: ReadonlySet<number>;
  addressExists: boolean;
}

export function addressSnapshot(
  address: Address | null | undefined,
): DeliveryAddressSnapshot | null {
  if (!address) return null;
  return {
    street: address.street,
    number: address.number,
    complement: address.complement || null,
    neighborhood: address.neighborhood,
    city: address.city,
    state: address.state,
    zipCode: address.zipCode,
    nickname: address.nickname || null,
  };
}

/** Orçamento validado → retrato serializável (vai para o pedido ou fica guardado no pagamento). */
export function toOrderSnapshot(priced: PricedOrder): OrderSnapshot {
  return {
    type: priced.type,
    addressId: priced.address?.id ?? null,
    deliveryAddress: addressSnapshot(priced.address),
    items: priced.items.map((line) => ({
      productId: line.product.id,
      productName: line.product.name,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      addonsTotal: line.addonsTotal,
      lineTotal: line.lineTotal,
      addons: line.addonsSnapshot,
      observation: line.observation,
      meatPoint: line.meatPoint,
      removedIngredients: line.removedIngredients,
    })),
    subtotal: priced.subtotal,
    deliveryFee: priced.delivery_fee,
    total: priced.total,
    estimatedDeliveryTime: priced.estimated_delivery_time,
  };
}

/** Conferência mínima do retrato lido do banco (jsonb) antes de criar o pedido com ele. */
export function isOrderSnapshot(value: unknown): value is OrderSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<OrderSnapshot>;
  return (
    (snapshot.type === OrderType.DELIVERY ||
      snapshot.type === OrderType.TAKEOUT) &&
    Array.isArray(snapshot.items) &&
    snapshot.items.length > 0 &&
    snapshot.items.every(
      (item) =>
        !!item &&
        Number.isInteger(item.productId) &&
        Number.isInteger(item.quantity) &&
        typeof item.unitPrice === 'number' &&
        Array.isArray(item.addons),
    ) &&
    typeof snapshot.total === 'number' &&
    typeof snapshot.deliveryFee === 'number'
  );
}

/** Retrato → entidade pronta para orderRepository.create()/save() (com os itens em cascata). */
export function buildOrder(
  snapshot: OrderSnapshot,
  meta: OrderMeta,
  existing?: ExistingReferences,
): DeepPartial<Order> {
  const keepAddress =
    snapshot.addressId !== null && (!existing || existing.addressExists);
  return {
    user: { id: meta.userId },
    status: OrderStatus.PENDING,
    payment_status: meta.paymentStatus,
    payment_id: meta.paymentId,
    payment_method: meta.paymentMethod,
    type: snapshot.type,
    change_for: meta.changeFor,
    address: keepAddress ? { id: snapshot.addressId as number } : null,
    delivery_address: snapshot.deliveryAddress,
    delivery_fee: snapshot.deliveryFee,
    estimated_delivery_time: snapshot.estimatedDeliveryTime,
    total_price: snapshot.total,
    items: snapshot.items.map((line) => toOrderItem(line, existing)),
  };
}

/** Item do pedido com o retrato do preço e do nome cobrados. */
function toOrderItem(
  line: OrderItemSnapshot,
  existing?: ExistingReferences,
): OrderItem {
  const item = new OrderItem();
  const productGone = !!existing && !existing.productIds.has(line.productId);
  // Produto apagado de vez (raro): o item fica só com o retrato (product_name e preços)
  item.product = (productGone ? null : { id: line.productId }) as Product;
  item.product_name = line.productName;
  item.addons = line.addons
    .filter((addon) => !existing || existing.addonIds.has(addon.id))
    .map((addon) => ({ id: addon.id }) as Addon);
  item.quantity = line.quantity;
  item.observation = line.observation;
  item.meat_point = line.meatPoint;
  item.removed_ingredients = line.removedIngredients;
  item.unit_price = line.unitPrice;
  item.addons_snapshot = line.addons;
  return item;
}
