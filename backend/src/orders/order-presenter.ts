import type { Order } from './entities/order.entity';
import type {
  OrderItem,
  OrderItemAddonSnapshot,
} from './entities/order-item.entity';
import type { User } from '../users/entities/user.entity';
import { OrderType } from './order.enums';
import {
  addressSnapshot,
  type DeliveryAddressSnapshot,
} from './order-snapshot';

/**
 * Formato público dos pedidos devolvidos pela API.
 * - user/driver só com dados de contato (nunca password_hash, mesmo que a relação venha completa);
 * - valores em number;
 * - delivery_address é o endereço de entrega da época do pedido (pedidos antigos usam o endereço
 *   ligado ao pedido; retiradas → null);
 * - items[].product_name é o nome da época do pedido (pedidos antigos usam o nome atual do produto);
 * - items[].addons tem uma entrada por unidade (mesmo formato de addonIds: [Bacon, Bacon] = 2x Bacon)
 *   e items[].addons_snapshot traz o mesmo agrupado [{ id, name, price, quantity }];
 * - items[].unit_price é o preço unitário cobrado (null em pedidos anteriores ao retrato de preços).
 */
export function presentOrder(order: Order) {
  const { user, driver, items, ...rest } = order;
  return {
    ...rest,
    total_price: Number(order.total_price),
    delivery_fee: Number(order.delivery_fee ?? 0),
    payment_id:
      order.payment_id === null || order.payment_id === undefined
        ? null
        : Number(order.payment_id),
    delivery_address: deliveryAddressOf(order),
    user: user ? publicUser(user, true) : null,
    driver: driver ? publicUser(driver, false) : null,
    ...(items ? { items: items.map(presentOrderItem) } : {}),
  };
}

export type PresentedOrder = ReturnType<typeof presentOrder>;

/** Retrato gravado no pedido; pedidos antigos caem no endereço ligado a ele. */
function deliveryAddressOf(order: Order): DeliveryAddressSnapshot | null {
  if (order.type !== OrderType.DELIVERY) return null;
  return order.delivery_address ?? addressSnapshot(order.address);
}

export function presentOrderItem(item: OrderItem) {
  const { addons, addons_snapshot: snapshot, ...rest } = item;

  // Pedidos antigos não têm retrato: usa a relação com o catálogo (1 unidade de cada)
  const grouped: OrderItemAddonSnapshot[] = Array.isArray(snapshot)
    ? snapshot
    : (addons ?? []).map((addon) => ({
        id: addon.id,
        name: addon.name,
        price: Number(addon.price),
        quantity: 1,
      }));

  return {
    ...rest,
    product_name: item.product_name ?? item.product?.name ?? null,
    unit_price:
      item.unit_price === null || item.unit_price === undefined
        ? null
        : Number(item.unit_price),
    addons: grouped.flatMap((addon) =>
      Array.from({ length: Math.max(1, addon.quantity) }, () => ({
        id: addon.id,
        name: addon.name,
        price: addon.price,
      })),
    ),
    addons_snapshot: grouped,
  };
}

function publicUser(user: User, includeEmail: boolean) {
  return {
    id: user.id,
    name: user.name,
    ...(includeEmail ? { email: user.email } : {}),
    phone: user.phone ?? null,
    avatar: user.avatar ?? null,
  };
}
