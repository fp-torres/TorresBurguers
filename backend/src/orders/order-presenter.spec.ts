import type { Order } from './entities/order.entity';
import { presentOrder } from './order-presenter';
import { OrderStatus, OrderType, PaymentStatus } from './order.enums';

const order = (): Order =>
  ({
    id: 4321,
    number: 17,
    store_id: 3,
    status: OrderStatus.PENDING,
    payment_status: PaymentStatus.PENDING,
    type: OrderType.TAKEOUT,
    total_price: '30.50' as unknown as number,
    delivery_fee: '0' as unknown as number,
    payment_method: 'MONEY',
    change_for: null,
    payment_id: null,
    estimated_delivery_time: null,
    created_at: new Date('2026-10-25T12:00:00Z'),
    updated_at: new Date('2026-10-25T12:00:00Z'),
    user: { id: 9, name: 'Maria', email: 'maria@email.com', phone: null },
    driver: null,
    address: null,
    delivery_address: null,
    items: [],
  }) as unknown as Order;

describe('presentOrder: número do pedido na loja', () => {
  it.each(['full', 'kitchen', 'courier'] as const)(
    'visão %s: traz o número da loja (number) e mantém o id global das rotas',
    (view) => {
      const presented = presentOrder(order(), { view });
      expect(presented).toMatchObject({ id: 4321, number: 17, store_id: 3 });
    },
  );

  it('Meus Pedidos (com a loja): número da loja junto do resumo da loja', () => {
    const presented = presentOrder(order(), {
      store: { id: 3, slug: 'loja-x', name: 'Loja X', logo: null },
    });
    expect(presented).toMatchObject({
      id: 4321,
      number: 17,
      store: { id: 3, slug: 'loja-x', name: 'Loja X', logo: null },
    });
  });
});
