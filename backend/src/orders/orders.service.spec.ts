import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FindOperator, type Repository } from 'typeorm';
import { OrdersService } from './orders.service';
import { OrderStatus, OrderType, PaymentStatus } from './order.enums';
import type { Order } from './entities/order.entity';
import type { User } from '../users/entities/user.entity';
import type { OrderPricingService, PricedOrder } from './order-pricing.service';
import type { PaymentService } from '../payment/payment.service';
import type { CreateOrderDto } from './dto/create-order.dto';

const client = {
  id: 7,
  role: 'CLIENT',
  email: 'cliente@exemplo.com',
  name: 'Maria Silva',
};

function pricedOrder(overrides: Partial<PricedOrder> = {}): PricedOrder {
  return {
    type: OrderType.TAKEOUT,
    items: [
      {
        product: { id: 1, name: 'X-Bacon da Casa' } as never,
        addons: [{ id: 3, name: 'Bacon Extra', price: '4.00' } as never],
        addonsSnapshot: [{ id: 3, name: 'Bacon Extra', price: 4, quantity: 2 }],
        quantity: 1,
        observation: '',
        meatPoint: null,
        removedIngredients: [],
        unitPrice: 29.9,
        addonsTotal: 8,
        lineTotal: 37.9,
      },
    ],
    address: null,
    subtotal: 37.9,
    delivery_fee: 0,
    total: 37.9,
    totalCents: 3790,
    estimated_delivery_time: '15-20 min',
    store_open: true,
    ...overrides,
  };
}

/** Pedido como o TypeORM devolve (decimais em string, usuário com hash se a coluna vier). */
function storedOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 101,
    status: OrderStatus.PENDING,
    payment_status: PaymentStatus.PENDING,
    type: OrderType.DELIVERY,
    total_price: '37.90' as unknown as number,
    delivery_fee: '0.00' as unknown as number,
    payment_method: 'MONEY',
    change_for: null,
    payment_id: null,
    estimated_delivery_time: '15-20 min',
    created_at: new Date(),
    updated_at: new Date(),
    user: {
      id: client.id,
      name: client.name,
      email: client.email,
      password_hash: 'segredo',
    } as User,
    driver: null,
    address: null,
    items: [
      {
        id: 1,
        quantity: 1,
        observation: '',
        meat_point: null,
        removed_ingredients: [],
        unit_price: '29.90' as unknown as number,
        addons_snapshot: [
          { id: 3, name: 'Bacon Extra', price: 4, quantity: 2 },
        ],
        addons: [{ id: 3, name: 'Bacon Extra', price: '4.00' }],
        product: { id: 1, name: 'X-Bacon da Casa' },
      },
    ],
    ...overrides,
  } as unknown as Order;
}

function setup() {
  const query = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const orderRepository = {
    create: jest.fn((data: Partial<Order>) => ({ ...data })),
    save: jest.fn((data: Partial<Order>) =>
      Promise.resolve({ ...data, id: 101 }),
    ),
    findOne: jest.fn().mockResolvedValue(storedOrder()),
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(() => query),
  };
  const userRepository = { findOne: jest.fn() };
  const pricing = { price: jest.fn().mockResolvedValue(pricedOrder()) };
  const payments = {
    orderIdForPayment: jest.fn().mockResolvedValue(101),
    refund: jest.fn().mockResolvedValue(true),
  };

  const service = new OrdersService(
    orderRepository as unknown as Repository<Order>,
    userRepository as unknown as Repository<User>,
    pricing as unknown as OrderPricingService,
    payments as unknown as PaymentService,
  );
  return { service, orderRepository, userRepository, pricing, payments, query };
}

const baseDto: Pick<CreateOrderDto, 'items' | 'type'> = {
  items: [{ productId: 1, quantity: 1, addonIds: [3, 3] }],
  type: OrderType.TAKEOUT,
};

describe('OrdersService', () => {
  describe('create', () => {
    it('pago na entrega: PENDING, sem conferir pagamento, com retrato do preço nos itens', async () => {
      const { service, orderRepository, payments } = setup();
      const dto = {
        ...baseDto,
        paymentMethod: 'MONEY',
        changeFor: 'R$ 50,00',
      } as CreateOrderDto;

      await service.create(dto, client);

      const saved = orderRepository.save.mock.calls[0][0];
      expect(saved).toMatchObject({
        payment_status: PaymentStatus.PENDING,
        payment_id: null,
        payment_method: 'MONEY',
        change_for: 'R$ 50,00',
        total_price: 37.9,
        user: { id: client.id },
      });
      expect(saved.items?.[0]).toMatchObject({
        unit_price: 29.9,
        product_name: 'X-Bacon da Casa',
        addons_snapshot: [
          { id: 3, name: 'Bacon Extra', price: 4, quantity: 2 },
        ],
        product: { id: 1 },
        addons: [{ id: 3 }],
      });
      expect(payments.orderIdForPayment).not.toHaveBeenCalled();
    });

    it('entrega: guarda o retrato do endereço no pedido', async () => {
      const { service, orderRepository, pricing } = setup();
      pricing.price.mockResolvedValueOnce(
        pricedOrder({
          type: OrderType.DELIVERY,
          address: {
            id: 9,
            street: 'Rua do Rosário',
            number: '99',
            complement: '',
            neighborhood: 'Centro',
            city: 'Rio de Janeiro',
            state: 'RJ',
            zipCode: '20041004',
            nickname: 'Casa',
          } as never,
          delivery_fee: 5,
          total: 42.9,
          totalCents: 4290,
        }),
      );

      await service.create(
        {
          ...baseDto,
          type: OrderType.DELIVERY,
          addressId: 9,
          paymentMethod: 'MONEY',
        } as CreateOrderDto,
        client,
      );
      expect(orderRepository.save.mock.calls[0][0]).toMatchObject({
        type: OrderType.DELIVERY,
        address: { id: 9 },
        delivery_fee: 5,
        delivery_address: {
          street: 'Rua do Rosário',
          number: '99',
          complement: null,
          neighborhood: 'Centro',
          city: 'Rio de Janeiro',
          state: 'RJ',
          zipCode: '20041004',
          nickname: 'Casa',
        },
      });
    });

    it('pago online: devolve o pedido criado pelo servidor com o pagamento (sem recalcular nem salvar aqui)', async () => {
      const { service, orderRepository, payments, pricing } = setup();
      orderRepository.findOne.mockResolvedValue(
        storedOrder({
          id: 555,
          payment_status: PaymentStatus.PAID,
          payment_id: 987 as unknown as number,
          payment_method: 'PIX',
        }),
      );
      const dto = {
        ...baseDto,
        paymentMethod: 'PIX',
        paymentId: 987,
      } as CreateOrderDto;

      payments.orderIdForPayment.mockResolvedValue(555);
      const first = await service.create(dto, client);
      // Repetição (resposta perdida): o mesmo pedido, nada novo é criado
      const retry = await service.create(dto, client);

      expect(payments.orderIdForPayment).toHaveBeenCalledWith(dto, client);
      expect(first).toMatchObject({
        id: 555,
        payment_status: PaymentStatus.PAID,
        payment_id: 987,
      });
      expect(retry.id).toBe(first.id);
      expect(pricing.price).not.toHaveBeenCalled();
      expect(orderRepository.save).not.toHaveBeenCalled();
    });

    it('pagamento recusado na conferência → nada é salvo', async () => {
      const { service, orderRepository, payments } = setup();
      payments.orderIdForPayment.mockRejectedValueOnce(
        new BadRequestException('O pagamento ainda não foi aprovado'),
      );

      await expect(
        service.create(
          {
            ...baseDto,
            paymentMethod: 'CREDIT_CARD',
            paymentId: 1,
          } as CreateOrderDto,
          client,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(orderRepository.save).not.toHaveBeenCalled();
    });

    it('loja fechada → 400 sem salvar (pedido pago na entrega)', async () => {
      const { service, orderRepository, pricing } = setup();
      pricing.price.mockResolvedValueOnce(pricedOrder({ store_open: false }));

      await expect(
        service.create(
          { ...baseDto, paymentMethod: 'MONEY' } as CreateOrderDto,
          client,
        ),
      ).rejects.toThrow('A loja está fechada no momento.');
      expect(orderRepository.save).not.toHaveBeenCalled();
    });

    it('troco menor que o total → 400', async () => {
      const { service, orderRepository } = setup();
      await expect(
        service.create(
          {
            ...baseDto,
            paymentMethod: 'MONEY',
            changeFor: '20',
          } as CreateOrderDto,
          client,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(orderRepository.save).not.toHaveBeenCalled();
    });

    it('a resposta nunca traz password_hash e mostra os adicionais por unidade', async () => {
      const { service } = setup();
      const order = await service.create(
        { ...baseDto, paymentMethod: 'MONEY' } as CreateOrderDto,
        client,
      );

      expect(order.user).toEqual({
        id: client.id,
        name: client.name,
        email: client.email,
        phone: null,
        avatar: null,
      });
      expect(JSON.stringify(order)).not.toContain('password_hash');
      expect(order.total_price).toBe(37.9);
      expect(order.items?.[0].unit_price).toBe(29.9);
      expect(order.items?.[0].addons).toEqual([
        { id: 3, name: 'Bacon Extra', price: 4 },
        { id: 3, name: 'Bacon Extra', price: 4 },
      ]);
    });
  });

  describe('leitura', () => {
    it('pedido de outro cliente → 403; equipe pode ver; inexistente → 404', async () => {
      const { service, orderRepository } = setup();
      await expect(
        service.findOneFor(101, { id: 99, role: 'CLIENT' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.findOneFor(101, { id: 2, role: 'KITCHEN' }),
      ).resolves.toMatchObject({ id: 101 });
      await expect(service.findOneFor(101, client)).resolves.toMatchObject({
        id: 101,
      });

      orderRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.findOneFor(5, client)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('pedido antigo (sem retrato) usa os adicionais da relação', async () => {
      const { service, orderRepository } = setup();
      const legacy = storedOrder();
      legacy.items[0].addons_snapshot = null;
      legacy.items[0].unit_price = null;
      orderRepository.findOne.mockResolvedValueOnce(legacy);

      const order = await service.findOneFor(101, client);
      expect(order.items?.[0].unit_price).toBeNull();
      expect(order.items?.[0].addons_snapshot).toEqual([
        { id: 3, name: 'Bacon Extra', price: 4, quantity: 1 },
      ]);
    });

    it('nome e endereço da época do pedido; pedidos antigos usam o produto e o endereço atuais', async () => {
      const { service, orderRepository } = setup();
      const address = {
        id: 9,
        street: 'Rua Nova',
        number: '10',
        complement: null,
        neighborhood: 'Botafogo',
        city: 'Rio de Janeiro',
        state: 'RJ',
        zipCode: '22250040',
        nickname: null,
      };
      const snapshot = {
        ...address,
        street: 'Rua Antiga',
        neighborhood: 'Centro',
      };
      delete (snapshot as { id?: number }).id;

      const current = storedOrder({
        address: address as never,
        delivery_address: snapshot as never,
      });
      current.items[0].product_name = 'X-Bacon (nome antigo)';
      orderRepository.findOne.mockResolvedValueOnce(current);
      const fresh = await service.findOneFor(101, client);
      expect(fresh.delivery_address).toEqual(snapshot);
      expect(fresh.items?.[0].product_name).toBe('X-Bacon (nome antigo)');

      const legacy = storedOrder({ address: address as never });
      orderRepository.findOne.mockResolvedValueOnce(legacy);
      const old = await service.findOneFor(101, client);
      expect(old.delivery_address).toMatchObject({
        street: 'Rua Nova',
        neighborhood: 'Botafogo',
      });
      expect(old.items?.[0].product_name).toBe('X-Bacon da Casa');

      orderRepository.findOne.mockResolvedValueOnce(
        storedOrder({ type: OrderType.TAKEOUT }),
      );
      expect(
        (await service.findOneFor(101, client)).delivery_address,
      ).toBeNull();
    });

    it('GET /orders?scope=active: em andamento, finalizados nas últimas 24 h ou com estorno pendente; sem scope, todos', async () => {
      const { service, orderRepository } = setup();
      const findCalls = orderRepository.find.mock.calls as [
        { where?: unknown; order?: unknown },
      ][];
      await service.findAll();
      expect(findCalls[0][0].where).toBeUndefined();

      const before = Date.now();
      await service.findAll('active');
      const where = findCalls[1][0].where as Record<
        string,
        FindOperator<unknown>
      >[];
      expect(where).toHaveLength(3);
      expect(where[2]).toEqual({
        payment_status: PaymentStatus.REFUND_PENDING,
      });
      const statusFilter = where[0].status;
      expect(statusFilter.type).toBe('not');
      const terminal = statusFilter.child?.value as OrderStatus[];
      expect([...terminal].sort()).toEqual([
        OrderStatus.CANCELED,
        OrderStatus.DONE,
      ]);
      const since = (where[1].updated_at.value as Date).getTime();
      expect(before - since).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
      expect(before - since).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
      expect(findCalls[1][0].order).toMatchObject({
        created_at: 'DESC',
      });
    });
  });

  describe('updateStatus', () => {
    it('entregador assume a entrega: grava driver e exige que ainda esteja sem entregador', async () => {
      const { service, orderRepository, query } = setup();
      orderRepository.findOne.mockResolvedValue(
        storedOrder({ status: OrderStatus.READY_FOR_PICKUP }),
      );

      await service.updateStatus(101, OrderStatus.DELIVERING, {
        id: 30,
        role: 'COURIER',
      });

      expect(query.set).toHaveBeenCalledWith({
        status: OrderStatus.DELIVERING,
        driver: { id: 30 },
      });
      expect(query.andWhere).toHaveBeenCalledWith('status = :current', {
        current: OrderStatus.READY_FOR_PICKUP,
      });
      expect(query.andWhere).toHaveBeenCalledWith('driver_id IS NULL');
    });

    it('concluir pedido pago na entrega marca o pagamento como PAID', async () => {
      const { service, orderRepository, query } = setup();
      orderRepository.findOne.mockResolvedValue(
        storedOrder({
          status: OrderStatus.READY_FOR_PICKUP,
          type: OrderType.TAKEOUT,
        }),
      );

      await service.updateStatus(101, OrderStatus.DONE, {
        id: 1,
        role: 'EMPLOYEE',
      });
      expect(query.set).toHaveBeenCalledWith({
        status: OrderStatus.DONE,
        payment_status: PaymentStatus.PAID,
      });
    });

    it('regras: 400 para transição inválida e 403 para perfil sem permissão', async () => {
      const { service, orderRepository, query } = setup();
      orderRepository.findOne.mockResolvedValue(
        storedOrder({ status: OrderStatus.DONE }),
      );
      await expect(
        service.updateStatus(101, OrderStatus.PREPARING, {
          id: 1,
          role: 'ADMIN',
        }),
      ).rejects.toThrow('Transição inválida: DONE → PREPARING');

      orderRepository.findOne.mockResolvedValue(
        storedOrder({ status: OrderStatus.PREPARING }),
      );
      await expect(
        service.updateStatus(101, OrderStatus.DONE, { id: 2, role: 'KITCHEN' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(query.execute).not.toHaveBeenCalled();
    });

    it('alteração concorrente (nenhuma linha atualizada) → 409', async () => {
      const { service, query } = setup();
      query.execute.mockResolvedValueOnce({ affected: 0 });
      await expect(
        service.updateStatus(101, OrderStatus.PREPARING, {
          id: 2,
          role: 'KITCHEN',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('cancel e assign', () => {
    it('outro cliente não cancela (403); o dono cancela enquanto PENDING', async () => {
      const { service, query, payments } = setup();
      await expect(
        service.cancel(101, { id: 99, role: 'CLIENT' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await service.cancel(101, client);
      expect(query.set).toHaveBeenCalledWith({ status: OrderStatus.CANCELED });
      // Pago na entrega: nada a estornar
      expect(payments.refund).not.toHaveBeenCalled();
    });

    it('cancelar pedido pago online estorna: REFUNDED (o estorno fica pendente durante a tentativa)', async () => {
      const { service, orderRepository, query, payments } = setup();
      orderRepository.findOne.mockResolvedValue(
        storedOrder({
          payment_status: PaymentStatus.PAID,
          payment_id: '987' as unknown as number,
          payment_method: 'PIX',
        }),
      );

      await service.cancel(101, client);
      expect(query.set).toHaveBeenCalledWith({
        status: OrderStatus.CANCELED,
        payment_status: PaymentStatus.REFUND_PENDING,
      });
      expect(payments.refund).toHaveBeenCalledWith(987);
      expect(orderRepository.update).toHaveBeenCalledWith(
        { id: 101, payment_status: PaymentStatus.REFUND_PENDING },
        { payment_status: PaymentStatus.REFUNDED },
      );
    });

    it('estorno que falha deixa REFUND_PENDING (visível para a equipe)', async () => {
      const { service, orderRepository, payments } = setup();
      orderRepository.findOne.mockResolvedValue(
        storedOrder({
          payment_status: PaymentStatus.PAID,
          payment_id: 987 as unknown as number,
        }),
      );
      payments.refund.mockResolvedValueOnce(false);

      await service.cancel(101, { id: 1, role: 'EMPLOYEE' });
      expect(payments.refund).toHaveBeenCalledWith(987);
      expect(orderRepository.update).not.toHaveBeenCalled();
    });

    it('cancelar pelo quadro (PATCH status CANCELED) também estorna o pagamento online', async () => {
      const { service, orderRepository, query, payments } = setup();
      orderRepository.findOne.mockResolvedValue(
        storedOrder({
          status: OrderStatus.PREPARING,
          payment_status: PaymentStatus.PAID,
          payment_id: 654 as unknown as number,
        }),
      );

      await service.updateStatus(101, OrderStatus.CANCELED, {
        id: 1,
        role: 'ADMIN',
      });
      expect(query.set).toHaveBeenCalledWith({
        status: OrderStatus.CANCELED,
        payment_status: PaymentStatus.REFUND_PENDING,
      });
      expect(payments.refund).toHaveBeenCalledWith(654);
      expect(orderRepository.update).toHaveBeenCalledWith(
        { id: 101, payment_status: PaymentStatus.REFUND_PENDING },
        { payment_status: PaymentStatus.REFUNDED },
      );
    });

    it('pedido já estornado ou pago na entrega não estorna de novo', async () => {
      const { service, orderRepository, payments } = setup();
      orderRepository.findOne.mockResolvedValue(
        storedOrder({
          payment_status: PaymentStatus.REFUNDED,
          payment_id: 987 as unknown as number,
          status: OrderStatus.PREPARING,
        }),
      );
      await service.cancel(101, { id: 1, role: 'ADMIN' });
      expect(payments.refund).not.toHaveBeenCalled();
    });

    it('atribui apenas entregador ativo a pedido de entrega em andamento', async () => {
      const { service, orderRepository, userRepository, query } = setup();
      orderRepository.findOne.mockResolvedValue(
        storedOrder({ status: OrderStatus.READY_FOR_PICKUP }),
      );

      userRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.assignDriver(101, 30)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      userRepository.findOne.mockResolvedValueOnce({ id: 31, role: 'KITCHEN' });
      await expect(service.assignDriver(101, 31)).rejects.toBeInstanceOf(
        BadRequestException,
      );

      userRepository.findOne.mockResolvedValueOnce({ id: 30, role: 'COURIER' });
      await service.assignDriver(101, 30);
      expect(query.set).toHaveBeenCalledWith({
        status: OrderStatus.DELIVERING,
        driver: { id: 30 },
      });

      orderRepository.findOne.mockResolvedValue(
        storedOrder({ status: OrderStatus.CANCELED }),
      );
      await expect(service.assignDriver(101, 30)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('gráficos', () => {
    it('agrupa o faturamento pelo dia no fuso da loja (America/Sao_Paulo), não do servidor', async () => {
      const { service, orderRepository } = setup();
      const item = (name: string, quantity: number) => ({
        quantity,
        product_name: name,
        product: { id: 1, name: 'Nome atual' },
      });
      orderRepository.find.mockResolvedValueOnce([
        // 23:30 de 10/10 em São Paulo (já é 11/10 em UTC)
        {
          created_at: new Date('2026-10-11T02:30:00Z'),
          payment_status: PaymentStatus.PAID,
          total_price: '30.00',
          items: [item('X-Bacon', 2)],
        },
        // 00:30 de 11/10 em São Paulo
        {
          created_at: new Date('2026-10-11T03:30:00Z'),
          payment_status: PaymentStatus.PAID,
          total_price: '20.00',
          items: [item('Batata', 1)],
        },
        // Ainda não pago: entra nos mais vendidos, não no faturamento
        {
          created_at: new Date('2026-10-11T11:00:00Z'),
          payment_status: PaymentStatus.PENDING,
          total_price: '99.00',
          items: [item('X-Bacon', 1)],
        },
        // Fora dos 7 dias (04/10 em São Paulo)
        {
          created_at: new Date('2026-10-04T12:00:00Z'),
          payment_status: PaymentStatus.PAID,
          total_price: '500.00',
          items: [item('Antigo', 9)],
        },
      ]);

      const { revenueChart, productsChart } = await service.getChartData(
        new Date('2026-10-11T12:00:00Z'),
      );
      expect(revenueChart.map((day) => day.date)).toEqual([
        '05/10',
        '06/10',
        '07/10',
        '08/10',
        '09/10',
        '10/10',
        '11/10',
      ]);
      expect(revenueChart[5]).toEqual({ date: '10/10', total: 30 });
      expect(revenueChart[6]).toEqual({ date: '11/10', total: 20 });
      expect(productsChart).toEqual([
        { name: 'X-Bacon', quantity: 3 },
        { name: 'Batata', quantity: 1 },
      ]);
    });
  });
});
