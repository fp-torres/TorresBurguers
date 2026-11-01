import type { Order } from './entities/order.entity';
import type {
  OrderItem,
  OrderItemAddonSnapshot,
} from './entities/order-item.entity';
import type { Store } from '../store/entities/store.entity';
import type { User } from '../users/entities/user.entity';
import { OrderType } from './order.enums';
import type { StaffOrderView } from './order-rules';
import {
  addressSnapshot,
  type DeliveryAddressSnapshot,
} from './order-snapshot';

/** Loja do pedido como sai na API (nunca a entidade Store inteira: ela tem credenciais e dados internos). */
export interface OrderStoreSummary {
  id: number;
  slug: string;
  name: string;
  logo: string | null;
}

export function orderStoreSummary(
  store: Pick<Store, 'id' | 'slug' | 'name' | 'logo'>,
): OrderStoreSummary {
  return {
    id: store.id,
    slug: store.slug,
    name: store.name,
    logo: store.logo ?? null,
  };
}

export interface PresentOrderOptions {
  /** Inclui "store": { id, slug, name, logo } (ex.: Meus Pedidos, com pedidos de várias lojas). */
  store?: OrderStoreSummary | null;
  /**
   * Quem recebe o pedido (padrão "full": cliente dono e gestão da loja). A equipe recebe só o que a
   * etapa dela usa (ver staffOrderView):
   * - kitchen: cliente só com { id, name }; sem endereço, troco e id do pagamento;
   * - courier: cliente com { id, name, phone } (nunca o e-mail), endereço, total, troco e pagamento.
   * Fora da gestão, o entregador sai só com { id, name }.
   */
  view?: StaffOrderView;
}

/**
 * Formato público dos pedidos devolvidos pela API.
 * - user/driver só com dados de contato (nunca password_hash, mesmo que a relação venha completa);
 * - valores em number;
 * - delivery_address é o endereço de entrega da época do pedido (pedidos antigos usam o endereço
 *   ligado ao pedido; retiradas → null);
 * - address (o endereço VIVO do cadastro do cliente, que é global) só aparece em pedidos antigos sem
 *   retrato: com o retrato, a loja não acompanha as edições que o cliente fizer depois no cadastro;
 * - store (relação) nunca sai inteira: só o resumo { id, slug, name, logo } quando pedido em options;
 * - items[].product_name é o nome da época do pedido (pedidos antigos usam o nome atual do produto);
 * - items[].addons tem uma entrada por unidade (mesmo formato de addonIds: [Bacon, Bacon] = 2x Bacon)
 *   e items[].addons_snapshot traz o mesmo agrupado [{ id, name, price, quantity }];
 * - items[].unit_price é o preço unitário cobrado (null em pedidos anteriores ao retrato de preços).
 */
export function presentOrder(order: Order, options: PresentOrderOptions = {}) {
  const { user, driver, items, address, ...rest } = order;
  delete rest.store;
  const view = options.view ?? 'full';
  const kitchen = view === 'kitchen';
  return {
    ...rest,
    total_price: Number(order.total_price),
    delivery_fee: Number(order.delivery_fee ?? 0),
    payment_id:
      kitchen || order.payment_id === null || order.payment_id === undefined
        ? null
        : Number(order.payment_id),
    ...(kitchen ? { change_for: null } : {}),
    address: kitchen || order.delivery_address ? null : (address ?? null),
    delivery_address: kitchen ? null : orderDeliveryAddress(order),
    user: user ? customerContact(user, view) : null,
    driver: driver ? driverContact(driver, view) : null,
    ...(options.store !== undefined
      ? { store: options.store ? orderStoreSummary(options.store) : null }
      : {}),
    ...(items ? { items: items.map(presentOrderItem) } : {}),
  };
}

export type PresentedOrder = ReturnType<typeof presentOrder>;

/** Endereço de entrega do pedido: o retrato gravado; pedidos antigos caem no endereço ligado a ele. */
export function orderDeliveryAddress(
  order: Pick<Order, 'type' | 'delivery_address' | 'address'>,
): DeliveryAddressSnapshot | null {
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

/** Cliente do pedido: contato completo para o próprio cliente e a gestão; reduzido para a etapa. */
function customerContact(user: User, view: StaffOrderView) {
  if (view === 'kitchen') return { id: user.id, name: user.name };
  if (view === 'courier')
    return { id: user.id, name: user.name, phone: user.phone ?? null };
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone ?? null,
    avatar: user.avatar ?? null,
  };
}

/** Entregador do pedido (nunca o e-mail; telefone e foto só para o cliente e a gestão). */
function driverContact(driver: User, view: StaffOrderView) {
  if (view !== 'full') return { id: driver.id, name: driver.name };
  return {
    id: driver.id,
    name: driver.name,
    phone: driver.phone ?? null,
    avatar: driver.avatar ?? null,
  };
}
