import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { FindOperator, type Repository } from 'typeorm';
import type { AuthUser } from '../auth/auth-user';
import type { AuditService } from '../audit/audit.service';
import type { PlanLimitsService } from '../billing/plan-limits.service';
import { StoreAccountStatus, type Store } from '../store/entities/store.entity';
import type { TenantContext } from '../tenancy/tenant-context';
import type { TenantService } from '../tenancy/tenant.service';
import {
  PlatformRole,
  UserRole,
  type User,
} from '../users/entities/user.entity';
import type { PaymentService } from '../payment/payment.service';
import type { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { OrdersService } from './orders.service';
import { OrderStatus, OrderType, PaymentStatus } from './order.enums';
import type { Order } from './entities/order.entity';
import type { OrderPricingService, PricedOrder } from './order-pricing.service';
import type { CreateOrderDto } from './dto/create-order.dto';
import { MONTHLY_ORDERS_LIMIT_MESSAGE } from './order-rules';

const STORE_A = 1;
const STORE_B = 2;

function user(
  id: number,
  role: UserRole,
  extra: Partial<AuthUser> = {},
): AuthUser {
  return {
    id,
    role,
    email: `usuario${id}@exemplo.com`,
    name: `Usuário ${id}`,
    storeId: null,
    platformRole: null,
    supportSession: null,
    ...extra,
  };
}

const client = user(7, UserRole.CLIENT, {
  email: 'cliente@exemplo.com',
  name: 'Maria Silva',
});
const otherClient = user(99, UserRole.CLIENT);
const admin = user(1, UserRole.ADMIN, { storeId: STORE_A });
const employee = user(2, UserRole.EMPLOYEE, { storeId: STORE_A });
const kitchen = user(3, UserRole.KITCHEN, { storeId: STORE_A });
const courier = user(30, UserRole.COURIER, { storeId: STORE_A });
const adminB = user(50, UserRole.ADMIN, { storeId: STORE_B });

function storeRow(id: number, extra: Partial<Store> = {}): Store {
  return {
    id,
    slug: `loja-${id}`,
    name: `Loja ${id}`,
    logo: `s${id}-logo.webp`,
    time_zone: 'America/Sao_Paulo',
    is_open: true,
    delivery_enabled: true,
    takeout_enabled: true,
    // Segredos e dados internos que nunca podem sair nas respostas de pedidos
    mp_access_token_encrypted: 'v1:iv:tag:segredo-da-loja',
    document: '12345678000199',
    ...extra,
  } as Store;
}

function tenantFor(store: Store): TenantContext {
  return {
    storeId: store.id,
    store,
    subscription: null,
    access: {
      availability: 'OPERATIONAL',
      canSell: true,
      canRead: true,
      canOperate: true,
      canManage: true,
      canManageBilling: true,
      publicVisible: true,
      message: null,
    },
  };
}

function pricedOrder(overrides: Partial<PricedOrder> = {}): PricedOrder {
  return {
    storeId: STORE_A,
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
    store_id: STORE_A,
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
    delivery_address: null,
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

/** Igualdade simples, objetos aninhados (user: { id }) e IsNull do TypeORM. */
function matches(row: Record<string, unknown>, where: object): boolean {
  return Object.entries(where as Record<string, unknown>).every(
    ([key, expected]) => {
      const value = row[key];
      if (expected instanceof FindOperator) {
        if (expected.type === 'isNull')
          return value === null || value === undefined;
        if (expected.type === 'in')
          return (expected.value as unknown as unknown[]).includes(value);
        throw new Error(`operador não suportado no teste: ${expected.type}`);
      }
      if (
        expected &&
        typeof expected === 'object' &&
        !(expected instanceof Date)
      )
        return matches((value ?? {}) as Record<string, unknown>, expected);
      return value === expected;
    },
  );
}

const asRecord = (value: unknown) => value as Record<string, unknown>;

/** Primeiro argumento da chamada N de um mock (tipado aqui: os mocks sem tipo devolvem any). */
function callArg<T>(mock: jest.Mock, call = 0): T {
  const [first] = mock.mock.calls[call] as [T];
  return first;
}

function setup(orders: Order[] = [storedOrder()]) {
  const rows = orders;
  const query = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
    getCount: jest.fn().mockResolvedValue(2),
    getRawOne: jest.fn().mockResolvedValue({ total: '150.50' }),
    addSelect: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
  };
  const itemsQuery = {
    withDeleted: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
  };
  const orderRepository = {
    rows,
    create: jest.fn((data: Partial<Order>) => ({ ...data })),
    save: jest.fn((data: Partial<Order>) => {
      const saved = { ...storedOrder(), ...data, id: 101 };
      rows.push(saved);
      return Promise.resolve(saved);
    }),
    findOne: jest.fn(({ where }: { where: object }) => {
      const row = rows.find((item) => matches(asRecord(item), where));
      return Promise.resolve(row ? structuredClone(row) : null);
    }),
    find: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(3),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    createQueryBuilder: jest.fn(() => query),
    manager: { createQueryBuilder: jest.fn(() => itemsQuery) },
  };
  const userRepository = {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
  };
  const stores = new Map([
    [STORE_A, storeRow(STORE_A)],
    [STORE_B, storeRow(STORE_B)],
  ]);
  const storeRepository = {
    find: jest.fn(({ where }: { where: { id: FindOperator<number[]> } }) =>
      Promise.resolve(
        where.id.value.map((id) => stores.get(id)).filter(Boolean),
      ),
    ),
    findOne: jest.fn(({ where }: { where: { id: number } }) =>
      Promise.resolve(stores.get(where.id) ?? null),
    ),
  };
  const pricing = {
    price: jest.fn((_dto: unknown, _userId: number, tenant: TenantContext) =>
      Promise.resolve(pricedOrder({ storeId: tenant.storeId })),
    ),
  };
  const payments = {
    orderIdForPayment: jest.fn().mockResolvedValue(101),
    reservedOrderSlots: jest.fn().mockResolvedValue(0),
    refund: jest.fn().mockResolvedValue(true),
  };
  const planLimits = {
    assertWithinLimit: jest.fn().mockResolvedValue(undefined),
    assertFeature: jest.fn().mockResolvedValue(undefined),
  };
  const tenants = {
    staffContext: jest.fn((actor: AuthUser) => {
      if (!actor.storeId)
        return Promise.reject(
          new ForbiddenException(
            'Esta área é exclusiva da equipe de uma loja.',
          ),
        );
      return Promise.resolve(tenantFor(stores.get(actor.storeId) as Store));
    }),
    findStoreBySlug: jest.fn((slug: string) =>
      Promise.resolve(
        [...stores.values()].find((store) => store.slug === slug) ?? null,
      ),
    ),
    // Como TenantService.publicContext: inexistente ou desativada → o mesmo 404
    publicContext: jest.fn((slug: string) => {
      const store = [...stores.values()].find((item) => item.slug === slug);
      if (!store || store.account_status === StoreAccountStatus.INACTIVE)
        return Promise.reject(new NotFoundException('Loja não encontrada.'));
      return Promise.resolve(tenantFor(store));
    }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const rateLimit = { consume: jest.fn() };

  const service = new OrdersService(
    orderRepository as unknown as Repository<Order>,
    userRepository as unknown as Repository<User>,
    storeRepository as unknown as Repository<Store>,
    pricing as unknown as OrderPricingService,
    payments as unknown as PaymentService,
    planLimits as unknown as PlanLimitsService,
    tenants as unknown as TenantService,
    audit as unknown as AuditService,
    rateLimit as unknown as RateLimitService,
  );
  return {
    service,
    rateLimit,
    orderRepository,
    userRepository,
    storeRepository,
    stores,
    pricing,
    payments,
    planLimits,
    tenants,
    audit,
    query,
    itemsQuery,
    tenantA: tenantFor(stores.get(STORE_A) as Store),
    tenantB: tenantFor(stores.get(STORE_B) as Store),
  };
}

const baseDto: Pick<CreateOrderDto, 'items' | 'type'> = {
  items: [{ productId: 1, quantity: 1, addonIds: [3, 3] }],
  type: OrderType.TAKEOUT,
};

const notFound = new NotFoundException('Pedido não encontrado.');

describe('OrdersService', () => {
  describe('create (cliente, na loja da vitrine)', () => {
    it('pago na entrega: PENDING, gravado na loja da vitrine, com retrato do preço nos itens', async () => {
      const {
        service,
        orderRepository,
        payments,
        pricing,
        planLimits,
        tenantA,
      } = setup();
      const dto = {
        ...baseDto,
        paymentMethod: 'MONEY',
        changeFor: 'R$ 50,00',
      } as CreateOrderDto;

      const response = await service.create(dto, client, tenantA);

      expect(pricing.price).toHaveBeenCalledWith(dto, client.id, tenantA);
      expect(planLimits.assertWithinLimit).toHaveBeenCalledWith(
        STORE_A,
        'monthly_orders',
        1,
      );
      const saved = orderRepository.save.mock.calls[0][0];
      expect(saved).toMatchObject({
        store_id: STORE_A,
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
      // O cliente vê em que loja comprou (só o resumo)
      expect(response.store).toEqual({
        id: STORE_A,
        slug: 'loja-1',
        name: 'Loja 1',
        logo: 's1-logo.webp',
      });
    });

    it('entrega: guarda o retrato do endereço no pedido', async () => {
      const { service, orderRepository, pricing, tenantA } = setup();
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
        },
        client,
        tenantA,
      );
      expect(orderRepository.save.mock.calls[0][0]).toMatchObject({
        store_id: STORE_A,
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

    it('pago online: devolve o pedido criado pelo servidor (sem recalcular, salvar ou contar no limite)', async () => {
      const {
        service,
        orderRepository,
        payments,
        pricing,
        planLimits,
        tenantA,
      } = setup([
        storedOrder({
          id: 555,
          payment_status: PaymentStatus.PAID,
          payment_id: 987 as unknown as number,
          payment_method: 'PIX',
        }),
      ]);
      const dto = {
        ...baseDto,
        paymentMethod: 'PIX',
        paymentId: 987,
      } as CreateOrderDto;

      payments.orderIdForPayment.mockResolvedValue(555);
      const first = await service.create(dto, client, tenantA);
      // Repetição (resposta perdida): o mesmo pedido, nada novo é criado
      const retry = await service.create(dto, client, tenantA);

      expect(payments.orderIdForPayment).toHaveBeenCalledWith(
        dto,
        client,
        tenantA,
      );
      expect(first).toMatchObject({
        id: 555,
        payment_status: PaymentStatus.PAID,
        payment_id: 987,
      });
      expect(retry.id).toBe(first.id);
      expect(pricing.price).not.toHaveBeenCalled();
      expect(orderRepository.save).not.toHaveBeenCalled();
      expect(planLimits.assertWithinLimit).not.toHaveBeenCalled();
    });

    it('pagamento recusado na conferência → nada é salvo', async () => {
      const { service, orderRepository, payments, tenantA } = setup();
      payments.orderIdForPayment.mockRejectedValueOnce(
        new BadRequestException('O pagamento ainda não foi aprovado'),
      );

      await expect(
        service.create(
          {
            ...baseDto,
            paymentMethod: 'CREDIT_CARD',
            paymentId: 1,
          },
          client,
          tenantA,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(orderRepository.save).not.toHaveBeenCalled();
    });

    it('loja fechada → 400 sem salvar (pedido pago na entrega)', async () => {
      const { service, orderRepository, pricing, tenantA } = setup();
      pricing.price.mockResolvedValueOnce(pricedOrder({ store_open: false }));

      await expect(
        service.create({ ...baseDto, paymentMethod: 'MONEY' }, client, tenantA),
      ).rejects.toThrow('A loja está fechada no momento.');
      expect(orderRepository.save).not.toHaveBeenCalled();
    });

    it('troco menor que o total → 400', async () => {
      const { service, orderRepository, tenantA } = setup();
      await expect(
        service.create(
          {
            ...baseDto,
            paymentMethod: 'MONEY',
            changeFor: '20',
          },
          client,
          tenantA,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(orderRepository.save).not.toHaveBeenCalled();
    });

    it('limite de pedidos do mês do plano → 403 com mensagem para o cliente (sem o nome do plano); nada é salvo', async () => {
      const { service, orderRepository, planLimits, tenantA } = setup();
      planLimits.assertWithinLimit.mockRejectedValueOnce(
        new ForbiddenException(
          'Limite do plano Essencial atingido: 100 pedidos neste mês.',
        ),
      );
      await expect(
        service.create({ ...baseDto, paymentMethod: 'MONEY' }, client, tenantA),
      ).rejects.toThrow(new ForbiddenException(MONTHLY_ORDERS_LIMIT_MESSAGE));
      expect(orderRepository.save).not.toHaveBeenCalled();
    });

    it('limite do mês: os pagamentos online em andamento da loja contam junto com o pedido pago na entrega', async () => {
      const { service, orderRepository, payments, planLimits, tenantA } =
        setup();
      payments.reservedOrderSlots.mockResolvedValueOnce(3);
      await service.create(
        { ...baseDto, paymentMethod: 'MONEY' },
        client,
        tenantA,
      );
      expect(payments.reservedOrderSlots).toHaveBeenCalledWith(
        STORE_A,
        client.id,
      );
      expect(planLimits.assertWithinLimit).toHaveBeenCalledWith(
        STORE_A,
        'monthly_orders',
        4,
      );
      expect(orderRepository.save).toHaveBeenCalledTimes(1);

      // Sem vaga para o pedido novo com as reservas → 403 neutro, nada é salvo
      orderRepository.save.mockClear();
      payments.reservedOrderSlots.mockResolvedValueOnce(5);
      planLimits.assertWithinLimit.mockRejectedValueOnce(
        new ForbiddenException(
          'Limite do plano Essencial atingido: 100 pedidos neste mês.',
        ),
      );
      await expect(
        service.create({ ...baseDto, paymentMethod: 'MONEY' }, client, tenantA),
      ).rejects.toThrow(new ForbiddenException(MONTHLY_ORDERS_LIMIT_MESSAGE));
      expect(orderRepository.save).not.toHaveBeenCalled();
    });

    it('pago na entrega: limite de tentativas por cliente na loja e por IP antes de calcular (429 não grava)', async () => {
      const { service, rateLimit, pricing, orderRepository, tenantA } = setup();
      const dto = { ...baseDto, paymentMethod: 'MONEY' } as CreateOrderDto;
      const request = { ip: '203.0.113.9', headers: {} } as never;
      await service.create(dto, client, tenantA, request);
      expect(rateLimit.consume.mock.calls).toEqual([
        ['ORDER_CREATE', `${STORE_A}:${client.id}`],
        ['ORDER_CREATE_IP', '203.0.113.9'],
      ]);

      rateLimit.consume.mockImplementationOnce(() => {
        throw new HttpException('Muitas tentativas', 429);
      });
      pricing.price.mockClear();
      orderRepository.save.mockClear();
      await expect(
        service.create(dto, client, tenantA, request),
      ).rejects.toMatchObject({ status: 429 });
      expect(pricing.price).not.toHaveBeenCalled();
      expect(orderRepository.save).not.toHaveBeenCalled();
    });

    it('limite por IP com a mesma chave dos outros limites: IPv6 pela rede /64 e IPv4 escrito como IPv6 como IPv4', async () => {
      const { service, rateLimit, tenantA } = setup();
      const dto = { ...baseDto, paymentMethod: 'MONEY' } as CreateOrderDto;
      for (const ip of [
        '2001:db8:aa:bb:1::1',
        '2001:db8:aa:bb:ffff::2',
        '::ffff:203.0.113.9',
      ])
        await service.create(dto, client, tenantA, {
          ip,
          headers: {},
        } as never);
      const ipKeys = (rateLimit.consume.mock.calls as [string, string][])
        .filter(([name]) => name === 'ORDER_CREATE_IP')
        .map(([, key]) => key);
      // Dois endereços da mesma rede /64 caem no mesmo balde (trocar de endereço não fura o limite)
      expect(ipKeys[0]).toBe(ipKeys[1]);
      expect(ipKeys[0]).not.toContain('::1');
      expect(ipKeys[2]).toBe('203.0.113.9');
    });

    it('pago online (paymentId): só o limite por IP (ORDER_CREATE_IP), antes de consultar o pagamento', async () => {
      const { service, rateLimit, payments, tenantA } = setup();
      const request = { ip: '203.0.113.9', headers: {} } as never;
      await service.create(
        { ...baseDto, paymentMethod: 'PIX', paymentId: 55 },
        client,
        tenantA,
        request,
      );
      expect(rateLimit.consume.mock.calls).toEqual([
        ['ORDER_CREATE_IP', '203.0.113.9'],
      ]);

      // No limite → 429 sem consultar o pagamento (nem o Mercado Pago)
      payments.orderIdForPayment.mockClear();
      rateLimit.consume.mockImplementationOnce(() => {
        throw new HttpException('Muitas tentativas', 429);
      });
      await expect(
        service.create(
          { ...baseDto, paymentMethod: 'PIX', paymentId: 55 },
          client,
          tenantA,
          request,
        ),
      ).rejects.toMatchObject({ status: 429 });
      expect(payments.orderIdForPayment).not.toHaveBeenCalled();
    });

    describe('teto de pedidos pendentes pagos na entrega (por cliente e loja)', () => {
      const saved = { ...process.env };
      afterEach(() => {
        process.env = { ...saved };
      });

      it('no teto (RATE_LIMIT_ORDER_CREATE) → 429 com mensagem clara, sem gravar nem contar no plano', async () => {
        process.env.RATE_LIMIT_ENABLED = 'true';
        process.env.RATE_LIMIT_ORDER_CREATE = '3/600';
        const { service, orderRepository, planLimits, tenantA } = setup();
        orderRepository.count.mockResolvedValueOnce(3);
        const failure = service.create(
          { ...baseDto, paymentMethod: 'MONEY' },
          client,
          tenantA,
        );
        await expect(failure).rejects.toMatchObject({ status: 429 });
        await expect(failure).rejects.toThrow(
          'Você já tem 3 pedidos aguardando a confirmação desta loja.',
        );
        expect(
          callArg<{ where: Record<string, unknown> }>(orderRepository.count)
            .where,
        ).toMatchObject({
          store_id: STORE_A,
          user: { id: client.id },
          status: OrderStatus.PENDING,
        });
        expect(
          callArg<{ where: Record<string, FindOperator<unknown>> }>(
            orderRepository.count,
          ).where.payment_id.type,
        ).toBe('isNull');
        expect(orderRepository.save).not.toHaveBeenCalled();
        expect(planLimits.assertWithinLimit).not.toHaveBeenCalled();

        orderRepository.count.mockResolvedValueOnce(2);
        await expect(
          service.create(
            { ...baseDto, paymentMethod: 'MONEY' },
            client,
            tenantA,
          ),
        ).resolves.toMatchObject({ id: 101 });
      });

      it('RATE_LIMIT_ENABLED=false desliga o teto', async () => {
        process.env.RATE_LIMIT_ENABLED = 'false';
        const { service, orderRepository, tenantA } = setup();
        orderRepository.count.mockResolvedValue(1000);
        await expect(
          service.create(
            { ...baseDto, paymentMethod: 'MONEY' },
            client,
            tenantA,
          ),
        ).resolves.toMatchObject({ id: 101 });
        expect(orderRepository.count).not.toHaveBeenCalled();
      });
    });

    it('orçamento usa a loja da vitrine e não conta no limite do plano', async () => {
      const { service, pricing, planLimits, tenantB } = setup();
      const quote = await service.quote(baseDto, client, tenantB);
      expect(pricing.price).toHaveBeenCalledWith(baseDto, client.id, tenantB);
      expect(quote).toMatchObject({ total: 37.9, store_open: true });
      expect(planLimits.assertWithinLimit).not.toHaveBeenCalled();
    });

    it('a resposta nunca traz password_hash nem a loja inteira (credenciais); adicionais por unidade', async () => {
      const { service, orderRepository, tenantA } = setup();
      // Mesmo que a relação "store" venha carregada inteira, ela não sai
      orderRepository.rows[0].store = storeRow(STORE_A);
      const order = await service.create(
        { ...baseDto, paymentMethod: 'MONEY' },
        client,
        tenantA,
      );

      expect(order.user).toEqual({
        id: client.id,
        name: client.name,
        email: client.email,
        phone: null,
        avatar: null,
      });
      const json = JSON.stringify(order);
      expect(json).not.toContain('password_hash');
      expect(json).not.toContain('mp_access_token');
      expect(json).not.toContain('segredo-da-loja');
      expect(json).not.toContain('12345678000199');
      expect(order.total_price).toBe(37.9);
      expect(order.items?.[0].unit_price).toBe(29.9);
      expect(order.items?.[0].addons).toEqual([
        { id: 3, name: 'Bacon Extra', price: 4 },
        { id: 3, name: 'Bacon Extra', price: 4 },
      ]);
    });
  });

  describe('leitura e isolamento entre lojas', () => {
    it('gestão (ADMIN/EMPLOYEE) vê qualquer pedido da PRÓPRIA loja; equipe de outra loja → 404 uniforme', async () => {
      const { service, tenants } = setup();
      for (const actor of [admin, employee]) {
        await expect(service.findOneFor(101, actor)).resolves.toMatchObject({
          id: 101,
          store_id: STORE_A,
          user: { email: client.email },
        });
      }
      expect(tenants.staffContext).toHaveBeenCalledWith(admin, 'read');
      await expect(service.findOneFor(101, adminB)).rejects.toThrow(notFound);
    });

    it('cozinha e entregador: só os pedidos da própria etapa (fora dela → 404 uniforme) e só os dados que usam', async () => {
      const snapshot = {
        street: 'Rua do Cliente',
        number: '10',
        complement: null,
        neighborhood: 'Centro',
        city: 'Rio de Janeiro',
        state: 'RJ',
        zipCode: '20040002',
        nickname: null,
      };
      const contact = {
        id: client.id,
        name: client.name,
        email: client.email,
        phone: '21999990000',
        avatar: 'avatar.webp',
        password_hash: 'segredo',
      } as unknown as User;
      const otherCourier = { id: 31, name: 'Outro', phone: '21988887777' };
      const me = { id: courier.id, name: 'Eu', phone: '21977776666' };
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const order = (id: number, extra: Partial<Order>) =>
        storedOrder({
          id,
          user: contact,
          delivery_address: snapshot,
          change_for: 'R$ 50,00',
          payment_id: 777,
          ...extra,
        });
      const { service } = setup([
        order(101, {}), // PENDING, entrega
        order(102, { status: OrderStatus.PREPARING, type: OrderType.TAKEOUT }),
        order(103, { status: OrderStatus.READY_FOR_PICKUP }), // pronta, sem entregador
        order(104, {
          status: OrderStatus.READY_FOR_PICKUP,
          type: OrderType.TAKEOUT,
        }),
        order(105, { status: OrderStatus.DELIVERING, driver: me as User }),
        order(106, {
          status: OrderStatus.DELIVERING,
          driver: otherCourier as User,
        }),
        order(107, { status: OrderStatus.DONE, driver: me as User }),
        order(108, {
          status: OrderStatus.DONE,
          driver: me as User,
          updated_at: twoDaysAgo,
        }),
        order(109, { status: OrderStatus.CANCELED }),
      ]);
      const visible = async (actor: AuthUser) => {
        const ids: number[] = [];
        for (const id of [101, 102, 103, 104, 105, 106, 107, 108, 109]) {
          const found = await service.findOneFor(id, actor).then(
            () => true,
            (error: unknown) => {
              expect(error).toEqual(notFound);
              return false;
            },
          );
          if (found) ids.push(id);
        }
        return ids;
      };
      expect(await visible(kitchen)).toEqual([101, 102]);
      expect(await visible(courier)).toEqual([103, 105, 107]);
      expect(await visible(admin)).toHaveLength(9);

      // Cozinha: só o nome do cliente; sem endereço, troco e pagamento
      const forKitchen = await service.findOneFor(101, kitchen);
      expect(forKitchen.user).toEqual({ id: client.id, name: client.name });
      expect(forKitchen).toMatchObject({
        delivery_address: null,
        address: null,
        change_for: null,
        payment_id: null,
      });
      expect(JSON.stringify(forKitchen)).not.toMatch(
        /21999990000|Rua do Cliente|cliente@/,
      );
      expect(forKitchen.items?.[0].product_name).toBe('X-Bacon da Casa');

      // Entregador: nome, telefone, endereço, total e troco (nunca o e-mail); entregador sem telefone
      const forCourier = await service.findOneFor(105, courier);
      expect(forCourier.user).toEqual({
        id: client.id,
        name: client.name,
        phone: '21999990000',
      });
      expect(forCourier).toMatchObject({
        delivery_address: snapshot,
        change_for: 'R$ 50,00',
        total_price: 37.9,
        payment_id: 777,
      });
      expect(forCourier.driver).toEqual({ id: courier.id, name: 'Eu' });
      expect(JSON.stringify(forCourier)).not.toMatch(
        /cliente@|password_hash|avatar|21977776666/,
      );

      // Gestão: completo
      const forAdmin = await service.findOneFor(106, admin);
      expect(forAdmin.user).toMatchObject({
        email: client.email,
        phone: '21999990000',
      });
      expect(forAdmin.driver).toEqual({ ...otherCourier, avatar: null });
    });

    it('cliente vê só os próprios pedidos (de qualquer loja); pedido de outro cliente → 404, nunca 403', async () => {
      const { service } = setup([
        storedOrder(),
        storedOrder({ id: 202, store_id: STORE_B }),
      ]);
      await expect(service.findOneFor(101, client)).resolves.toMatchObject({
        id: 101,
        store: { id: STORE_A, slug: 'loja-1' },
      });
      await expect(service.findOneFor(202, client)).resolves.toMatchObject({
        id: 202,
        store: { id: STORE_B, slug: 'loja-2' },
      });
      await expect(service.findOneFor(101, otherClient)).rejects.toThrow(
        notFound,
      );
    });

    it('inexistente → 404 com a mesma mensagem', async () => {
      const { service } = setup();
      await expect(service.findOneFor(5, client)).rejects.toThrow(notFound);
      await expect(service.findOneFor(5, admin)).rejects.toThrow(notFound);
    });

    it('rotas /stores/:storeSlug: equipe com slug de outra loja → 403; cliente só vê o pedido daquela loja', async () => {
      const { service } = setup();
      await expect(service.findOneFor(101, admin, 'loja-2')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        service.findOneFor(101, admin, 'loja-1'),
      ).resolves.toMatchObject({ id: 101 });
      await expect(service.findOneFor(101, client, 'loja-2')).rejects.toThrow(
        notFound,
      );
      await expect(
        service.findOneFor(101, client, 'nao-existe'),
      ).rejects.toThrow(notFound);
      await expect(
        service.findOneFor(101, client, 'loja-1'),
      ).resolves.toMatchObject({ id: 101 });
    });

    it('cliente sem loja que tenta a visão da equipe não ganha acesso (perfil decide, não o token)', async () => {
      const { service, tenants } = setup();
      // Superadmin fora de sessão de suporte é CLIENT na loja: vê só os próprios pedidos
      const superadmin = user(500, UserRole.CLIENT, {
        platformRole: PlatformRole.SUPER_ADMIN,
      });
      await expect(service.findOneFor(101, superadmin)).rejects.toThrow(
        notFound,
      );
      expect(tenants.staffContext).not.toHaveBeenCalled();
    });

    it('pedido antigo (sem retrato) usa os adicionais da relação', async () => {
      const legacy = storedOrder();
      legacy.items[0].addons_snapshot = null;
      legacy.items[0].unit_price = null;
      const { service } = setup([legacy]);

      const order = await service.findOneFor(101, client);
      expect(order.items?.[0].unit_price).toBeNull();
      expect(order.items?.[0].addons_snapshot).toEqual([
        { id: 3, name: 'Bacon Extra', price: 4, quantity: 1 },
      ]);
    });

    it('nome e endereço da época do pedido; o endereço vivo do cadastro só aparece em pedidos antigos', async () => {
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
        delivery_address: snapshot,
      });
      current.items[0].product_name = 'X-Bacon (nome antigo)';
      const legacy = storedOrder({ id: 102, address: address as never });
      const takeout = storedOrder({ id: 103, type: OrderType.TAKEOUT });
      const { service } = setup([current, legacy, takeout]);

      const fresh = await service.findOneFor(101, admin);
      expect(fresh.delivery_address).toEqual(snapshot);
      // Privacidade: o cadastro do cliente (global) não vaza para a loja depois do pedido
      expect(fresh.address).toBeNull();
      expect(JSON.stringify(fresh)).not.toContain('Rua Nova');
      expect(fresh.items?.[0].product_name).toBe('X-Bacon (nome antigo)');

      const old = await service.findOneFor(102, admin);
      expect(old.delivery_address).toMatchObject({
        street: 'Rua Nova',
        neighborhood: 'Botafogo',
      });
      expect(old.address).toMatchObject({ id: 9 });
      expect(old.items?.[0].product_name).toBe('X-Bacon da Casa');

      expect(
        (await service.findOneFor(103, admin)).delivery_address,
      ).toBeNull();
    });

    it('my-orders: pedidos do cliente em TODAS as lojas, cada um com a loja resumida (lista de campos permitidos)', async () => {
      const { service, orderRepository, storeRepository } = setup();
      // Duas etapas (ids da página, depois as relações): o mock responde as duas
      orderRepository.find.mockResolvedValue([
        storedOrder({ id: 300, store_id: STORE_B }),
        storedOrder({ id: 301, store_id: STORE_A }),
        storedOrder({ id: 302, store_id: STORE_B }),
      ]);

      const mine = await service.findMyOrders(client.id);
      const options = callArg<{ where: Record<string, unknown> }>(
        orderRepository.find,
      );
      expect(options.where).toEqual({ user: { id: client.id } });
      expect(mine.map((order) => [order.id, order.store?.slug])).toEqual([
        [300, 'loja-2'],
        [301, 'loja-1'],
        [302, 'loja-2'],
      ]);
      expect(mine[0].store).toEqual({
        id: STORE_B,
        slug: 'loja-2',
        name: 'Loja 2',
        logo: 's2-logo.webp',
      });
      // Uma consulta para as lojas, só com os campos públicos
      expect(storeRepository.find).toHaveBeenCalledTimes(1);
      expect(storeRepository.find.mock.calls[0][0]).toMatchObject({
        select: { id: true, slug: true, name: true, logo: true },
      });
      expect(JSON.stringify(mine)).not.toContain('segredo-da-loja');
    });

    it('my-orders na rota da loja: só os pedidos daquela loja; loja inexistente → 404', async () => {
      const { service, orderRepository } = setup();
      await service.findMyOrders(client.id, 'loja-2');
      expect(callArg<{ where: unknown }>(orderRepository.find).where).toEqual({
        user: { id: client.id },
        store_id: STORE_B,
      });
      await expect(
        service.findMyOrders(client.id, 'nao-existe'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('my-orders na rota de uma loja desativada → o mesmo 404 da inexistente (não revela lojas inativas)', async () => {
      const { service, stores, orderRepository } = setup();
      stores.set(
        3,
        storeRow(3, { account_status: StoreAccountStatus.INACTIVE }),
      );
      const unknown = await service
        .findMyOrders(client.id, 'nao-existe')
        .catch((error: unknown) => error);
      const inactive = await service
        .findMyOrders(client.id, 'loja-3')
        .catch((error: unknown) => error);
      expect(inactive).toBeInstanceOf(NotFoundException);
      expect((inactive as NotFoundException).getResponse()).toEqual(
        (unknown as NotFoundException).getResponse(),
      );
      expect(orderRepository.find).not.toHaveBeenCalled();
    });

    it('GET /orders: sempre só a loja da equipe (inclusive em cada condição do scope=active)', async () => {
      const { service, orderRepository } = setup();
      const findCalls = orderRepository.find.mock.calls as [
        { where?: unknown; order?: unknown; skip?: number; take?: number },
      ][];
      await service.findAll(STORE_A, admin);
      expect(findCalls[0][0]).toMatchObject({
        where: { store_id: STORE_A },
        skip: 0,
        take: 100,
      });

      const before = Date.now();
      await service.findAll(STORE_B, adminB, { scope: 'active' });
      expect(findCalls[1][0]).toMatchObject({ skip: 0, take: 500 });
      const where = findCalls[1][0].where as Record<
        string,
        FindOperator<unknown>
      >[];
      expect(where).toHaveLength(3);
      for (const condition of where)
        expect(condition).toMatchObject({ store_id: STORE_B });
      expect(where[2]).toEqual({
        store_id: STORE_B,
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

  describe('listas em páginas e por perfil', () => {
    it('histórico da gestão e my-orders: uma página por vez (skip/take), mais novos primeiro, itens em ordem', async () => {
      const { service, orderRepository } = setup();
      const unordered = storedOrder();
      unordered.items = [
        { ...unordered.items[0], id: 9 },
        { ...unordered.items[0], id: 2 },
      ];
      orderRepository.find.mockResolvedValue([unordered]);
      const [first] = await service.findAll(STORE_A, employee, {
        page: { skip: 40, take: 20 },
      });
      expect(first.items?.map((item) => item.id)).toEqual([2, 9]);
      const options = callArg<Record<string, unknown>>(orderRepository.find);
      expect(options).toMatchObject({
        skip: 40,
        take: 20,
        order: { created_at: 'DESC', id: 'DESC' },
        withDeleted: true,
      });
      // Ordenar pelos itens no ORDER BY faria o LIMIT contar itens, não pedidos
      expect(options.order).not.toHaveProperty('items');

      await service.findMyOrders(client.id, undefined, { skip: 0, take: 5 });
      expect(
        callArg<Record<string, unknown>>(orderRepository.find, 2),
      ).toMatchObject({ where: { user: { id: client.id } }, skip: 0, take: 5 });
      await service.findMyOrders(client.id);
      expect(
        callArg<Record<string, unknown>>(orderRepository.find, 4),
      ).toMatchObject({ skip: 0, take: 100 });
    });

    it('página em duas etapas: os ids no filtro (sem relações) e depois as relações só desses pedidos, na mesma ordem', async () => {
      const { service, orderRepository } = setup();
      const newer = storedOrder({ id: 205 });
      const older = storedOrder({ id: 201 });
      orderRepository.find
        .mockResolvedValueOnce([
          { id: 205, created_at: newer.created_at },
          { id: 201, created_at: older.created_at },
        ])
        // O banco devolve as relações em qualquer ordem
        .mockResolvedValueOnce([older, newer]);

      const list = await service.findAll(STORE_A, admin, {
        page: { skip: 9_900, take: 100 },
      });

      expect(list.map((order) => order.id)).toEqual([205, 201]);
      const heads = callArg<Record<string, unknown>>(orderRepository.find, 0);
      expect(heads).toMatchObject({
        where: { store_id: STORE_A },
        skip: 9_900,
        take: 100,
        order: { created_at: 'DESC', id: 'DESC' },
      });
      // Sem relações (nada de juntar itens de todos os pedidos antes do LIMIT)
      expect(heads).not.toHaveProperty('relations');
      expect(heads.select).toMatchObject({ id: true });
      const load = callArg<{
        where: { id: FindOperator<number[]> };
        relations: Record<string, unknown>;
        skip?: number;
      }>(orderRepository.find, 1);
      expect(load.where.id.type).toBe('in');
      expect(load.where.id.value).toEqual([205, 201]);
      expect(load.relations).toMatchObject({ items: { product: true } });
      expect(load.skip).toBeUndefined();

      // Página vazia: uma consulta só
      orderRepository.find.mockClear();
      orderRepository.find.mockResolvedValueOnce([]);
      expect(
        await service.findAll(STORE_A, admin, {
          page: { skip: 0, take: 100 },
        }),
      ).toEqual([]);
      expect(orderRepository.find).toHaveBeenCalledTimes(1);
    });

    it('quadro (polling de 5 s): a mesma lista reaproveita a resposta montada; mudou um pedido ou passou o prazo → monta de novo', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z') });
      try {
        const { service, orderRepository } = setup();
        const order = storedOrder({
          id: 120,
          updated_at: new Date('2026-10-31T11:59:00Z'),
        });
        const heads = (current: Order) => [
          {
            id: current.id,
            created_at: current.created_at,
            updated_at: current.updated_at,
            status: current.status,
            payment_status: current.payment_status,
          },
        ];
        orderRepository.find.mockImplementation(
          (options: { relations?: unknown }) =>
            Promise.resolve(
              options.relations ? [structuredClone(order)] : heads(order),
            ),
        );
        const loads = () =>
          (orderRepository.find.mock.calls as [{ relations?: unknown }][])
            .length -
          (
            orderRepository.find.mock.calls as [{ relations?: unknown }][]
          ).filter(([options]) => !options.relations).length;

        const first = await service.findAll(STORE_A, admin, {
          scope: 'active',
        });
        const second = await service.findAll(STORE_A, admin, {
          scope: 'active',
        });
        expect(second).toEqual(first);
        expect(loads()).toBe(1);

        // Outro perfil (cozinha) tem outra resposta: não usa a da gestão
        const kitchenList = await service.findAll(STORE_A, kitchen, {
          scope: 'active',
        });
        expect(kitchenList[0].user).toEqual({
          id: client.id,
          name: client.name,
        });
        expect(loads()).toBe(2);

        // O pedido mudou (updated_at/status): monta de novo
        order.status = OrderStatus.PREPARING;
        order.updated_at = new Date('2026-10-31T12:00:01Z');
        const changed = await service.findAll(STORE_A, admin, {
          scope: 'active',
        });
        expect(changed[0].status).toBe(OrderStatus.PREPARING);
        expect(loads()).toBe(3);

        // Prazo do cache vencido (ex.: o cliente mudou o nome): monta de novo mesmo sem mudança
        jest.advanceTimersByTime(30_001);
        await service.findAll(STORE_A, admin, { scope: 'active' });
        expect(loads()).toBe(4);

        // O histórico (sem scope) nunca usa o cache
        await service.findAll(STORE_A, admin);
        await service.findAll(STORE_A, admin);
        expect(loads()).toBe(6);
      } finally {
        jest.useRealTimers();
      }
    });

    it('quadro do entregador: cada entregador tem o próprio (a chave inclui a conta)', async () => {
      const { service, orderRepository } = setup();
      orderRepository.find.mockResolvedValue([storedOrder()]);
      const otherCourier = { ...courier, id: 31 };
      await service.findAll(STORE_A, courier, { scope: 'active' });
      await service.findAll(STORE_A, otherCourier, { scope: 'active' });
      const calls = orderRepository.find.mock.calls as [
        { relations?: unknown },
      ][];
      expect(calls.filter(([options]) => options.relations)).toHaveLength(2);
    });

    it('cozinha e entregador: com ou sem scope, só a própria etapa (na consulta), até 500, no formato do perfil', async () => {
      const { service, orderRepository } = setup();
      orderRepository.find.mockResolvedValue([storedOrder()]);
      const before = Date.now();
      for (const scope of ['all', 'active'] as const) {
        const [order] = await service.findAll(STORE_A, kitchen, { scope });
        expect(order.user).toEqual({ id: client.id, name: client.name });
      }
      type Where = Record<string, FindOperator<unknown>>;
      const kitchenCall = callArg<{ where: Where[]; take: number }>(
        orderRepository.find,
      );
      expect(kitchenCall.take).toBe(500);
      expect(kitchenCall.where).toHaveLength(1);
      expect(kitchenCall.where[0].store_id).toBe(STORE_A);
      expect(kitchenCall.where[0].status.value).toEqual([
        OrderStatus.PENDING,
        OrderStatus.PREPARING,
      ]);

      await service.findAll(STORE_A, courier);
      // Cozinha: ids + relações, depois só os ids (o quadro igual sai do cache); o entregador vem depois
      const courierWhere = callArg<{ where: Where[] }>(
        orderRepository.find,
        3,
      ).where;
      expect(courierWhere).toHaveLength(3);
      for (const condition of courierWhere)
        expect(condition).toMatchObject({ store_id: STORE_A });
      const [ready, mine, recent] = courierWhere;
      expect(ready.status.value).toEqual([OrderStatus.READY_FOR_PICKUP]);
      expect(ready.type).toBe(OrderType.DELIVERY);
      expect(ready.driver.type).toBe('isNull');
      expect(mine.status.value).toEqual([
        OrderStatus.READY_FOR_PICKUP,
        OrderStatus.DELIVERING,
      ]);
      expect(mine.driver).toEqual({ id: courier.id });
      expect([...(recent.status.value as OrderStatus[])].sort()).toEqual([
        OrderStatus.CANCELED,
        OrderStatus.DONE,
      ]);
      expect(recent.driver).toEqual({ id: courier.id });
      const since = (recent.updated_at.value as Date).getTime();
      expect(before - since).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
      expect(before - since).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
    });

    it('PATCH de status pela cozinha devolve o pedido no formato da cozinha', async () => {
      const { service } = setup([
        storedOrder({ change_for: 'R$ 50,00', payment_id: 5 }),
      ]);
      const order = await service.updateStatus(
        101,
        OrderStatus.PREPARING,
        kitchen,
        STORE_A,
      );
      expect(order.user).toEqual({ id: client.id, name: client.name });
      expect(order).toMatchObject({ change_for: null, payment_id: null });
    });
  });

  describe('updateStatus', () => {
    it('entregador assume a entrega: grava driver e exige que ainda esteja sem entregador (na loja)', async () => {
      const { service, query } = setup([
        storedOrder({ status: OrderStatus.READY_FOR_PICKUP }),
      ]);

      await service.updateStatus(101, OrderStatus.DELIVERING, courier, STORE_A);

      expect(query.set).toHaveBeenCalledWith({
        status: OrderStatus.DELIVERING,
        driver: { id: courier.id },
      });
      expect(query.andWhere).toHaveBeenCalledWith('store_id = :storeId', {
        storeId: STORE_A,
      });
      expect(query.andWhere).toHaveBeenCalledWith('status = :current', {
        current: OrderStatus.READY_FOR_PICKUP,
      });
      expect(query.andWhere).toHaveBeenCalledWith('driver_id IS NULL');
    });

    it('concluir pedido pago na entrega marca o pagamento como PAID', async () => {
      const { service, query } = setup([
        storedOrder({
          status: OrderStatus.READY_FOR_PICKUP,
          type: OrderType.TAKEOUT,
        }),
      ]);

      await service.updateStatus(101, OrderStatus.DONE, employee, STORE_A);
      expect(query.set).toHaveBeenCalledWith({
        status: OrderStatus.DONE,
        payment_status: PaymentStatus.PAID,
      });
    });

    it('regras: 400 para transição inválida e 403 para perfil sem permissão', async () => {
      const { service, orderRepository, query } = setup([
        storedOrder({ status: OrderStatus.DONE }),
      ]);
      await expect(
        service.updateStatus(101, OrderStatus.PREPARING, admin, STORE_A),
      ).rejects.toThrow('Transição inválida: DONE → PREPARING');

      orderRepository.rows[0].status = OrderStatus.PREPARING;
      await expect(
        service.updateStatus(101, OrderStatus.DONE, kitchen, STORE_A),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(query.execute).not.toHaveBeenCalled();
    });

    it('alteração concorrente (nenhuma linha atualizada) → 409', async () => {
      const { service, query } = setup();
      query.execute.mockResolvedValueOnce({ affected: 0 });
      await expect(
        service.updateStatus(101, OrderStatus.PREPARING, kitchen, STORE_A),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('pedido de outra loja → 404 e nada é alterado', async () => {
      const { service, query } = setup();
      await expect(
        service.updateStatus(101, OrderStatus.PREPARING, adminB, STORE_B),
      ).rejects.toThrow(notFound);
      expect(query.execute).not.toHaveBeenCalled();
    });

    it('cozinha e entregador: pedido fora da própria etapa → 404 uniforme (a mensagem não revela status, tipo nem entregador)', async () => {
      const otherCourier = user(31, UserRole.COURIER, { storeId: STORE_A });
      const outOfStage: Array<[Partial<Order>, OrderStatus, AuthUser]> = [
        [{ status: OrderStatus.DONE }, OrderStatus.DONE, kitchen],
        [{ status: OrderStatus.CANCELED }, OrderStatus.DONE, kitchen],
        [
          { status: OrderStatus.READY_FOR_PICKUP, type: OrderType.TAKEOUT },
          OrderStatus.DELIVERING,
          kitchen,
        ],
        [{ status: OrderStatus.PENDING }, OrderStatus.PREPARING, courier],
        [
          { status: OrderStatus.READY_FOR_PICKUP, type: OrderType.TAKEOUT },
          OrderStatus.DELIVERING,
          courier,
        ],
        [
          {
            status: OrderStatus.READY_FOR_PICKUP,
            driver: { id: otherCourier.id } as User,
          },
          OrderStatus.DELIVERING,
          courier,
        ],
        [
          {
            status: OrderStatus.DELIVERING,
            driver: { id: otherCourier.id } as User,
          },
          OrderStatus.DONE,
          courier,
        ],
      ];
      for (const [order, status, actor] of outOfStage) {
        const { service, query } = setup([storedOrder(order)]);
        await expect(
          service.updateStatus(101, status, actor, STORE_A),
        ).rejects.toThrow(notFound);
        expect(query.execute).not.toHaveBeenCalled();
      }

      // Dentro da etapa: as regras do perfil continuam (403/400 com a mensagem da regra)
      const { service, orderRepository } = setup([
        storedOrder({ status: OrderStatus.PREPARING }),
      ]);
      await expect(
        service.updateStatus(101, OrderStatus.DONE, kitchen, STORE_A),
      ).rejects.toBeInstanceOf(ForbiddenException);
      orderRepository.rows[0].status = OrderStatus.READY_FOR_PICKUP;
      await expect(
        service.updateStatus(101, OrderStatus.DONE, courier, STORE_A),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Gestão continua vendo a regra (400 com o status atual)
      orderRepository.rows[0].status = OrderStatus.DONE;
      await expect(
        service.updateStatus(101, OrderStatus.DONE, admin, STORE_A),
      ).rejects.toThrow('Transição inválida: DONE → DONE');
    });
  });

  describe('cancel e assign', () => {
    it('outro cliente → 404 (não revela o pedido); o dono cancela enquanto PENDING', async () => {
      const { service, query, payments } = setup();
      await expect(service.cancel(101, otherClient)).rejects.toThrow(notFound);
      const canceled = await service.cancel(101, client);
      expect(query.set).toHaveBeenCalledWith({ status: OrderStatus.CANCELED });
      expect(query.andWhere).toHaveBeenCalledWith('store_id = :storeId', {
        storeId: STORE_A,
      });
      expect(canceled.store).toMatchObject({ id: STORE_A });
      // Pago na entrega: nada a estornar
      expect(payments.refund).not.toHaveBeenCalled();
    });

    it('equipe de outra loja → 404; cozinha da própria loja → 403 (regra do perfil)', async () => {
      const { service, query, tenants } = setup();
      await expect(service.cancel(101, adminB)).rejects.toThrow(notFound);
      await expect(service.cancel(101, kitchen)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(tenants.staffContext).toHaveBeenCalledWith(kitchen, 'operate');
      expect(query.execute).not.toHaveBeenCalled();
    });

    it('cozinha e entregador: cancelar pedido fora da própria etapa → 404 uniforme (não confirma que existe)', async () => {
      const { service, query, orderRepository } = setup();
      // Pendente: fora da etapa do entregador
      await expect(service.cancel(101, courier)).rejects.toThrow(notFound);
      // Pronto para retirada: fora da etapa da cozinha
      orderRepository.rows[0].status = OrderStatus.READY_FOR_PICKUP;
      await expect(service.cancel(101, kitchen)).rejects.toThrow(notFound);
      // Concluído: fora das duas
      orderRepository.rows[0].status = OrderStatus.DONE;
      await expect(service.cancel(101, kitchen)).rejects.toThrow(notFound);
      await expect(service.cancel(101, courier)).rejects.toThrow(notFound);
      expect(query.execute).not.toHaveBeenCalled();
    });

    it('sessão de suporte é somente leitura (403), mesmo sendo ADMIN da loja', async () => {
      const { service, query } = setup();
      const support = user(900, UserRole.ADMIN, {
        storeId: STORE_A,
        supportSession: { id: 4, storeId: STORE_A, expiresAt: new Date() },
      });
      await expect(service.cancel(101, support)).rejects.toThrow(
        /somente leitura/,
      );
      expect(query.execute).not.toHaveBeenCalled();
    });

    it('cancelar pedido pago online estorna com a credencial da loja do pedido: REFUNDED', async () => {
      const { service, orderRepository, query, payments } = setup([
        storedOrder({
          store_id: STORE_B,
          payment_status: PaymentStatus.PAID,
          payment_id: '987' as unknown as number,
          payment_method: 'PIX',
        }),
      ]);

      await service.cancel(101, client);
      expect(query.set).toHaveBeenCalledWith({
        status: OrderStatus.CANCELED,
        payment_status: PaymentStatus.REFUND_PENDING,
      });
      expect(payments.refund).toHaveBeenCalledWith(987, STORE_B, {
        actor: client,
        reason: 'order_canceled',
        orderId: 101,
      });
      expect(orderRepository.update).toHaveBeenCalledWith(
        {
          id: 101,
          store_id: STORE_B,
          payment_status: PaymentStatus.REFUND_PENDING,
        },
        { payment_status: PaymentStatus.REFUNDED },
      );
    });

    it('estorno que falha deixa REFUND_PENDING (visível para a equipe)', async () => {
      const { service, orderRepository, payments } = setup([
        storedOrder({
          payment_status: PaymentStatus.PAID,
          payment_id: 987 as unknown as number,
        }),
      ]);
      payments.refund.mockResolvedValueOnce(false);

      await service.cancel(101, employee);
      expect(payments.refund).toHaveBeenCalledWith(
        987,
        STORE_A,
        expect.objectContaining({ reason: 'order_canceled' }),
      );
      expect(orderRepository.update).not.toHaveBeenCalled();
    });

    it('cancelar pelo quadro (PATCH status CANCELED) também estorna e audita', async () => {
      const { service, orderRepository, query, payments, audit } = setup([
        storedOrder({
          status: OrderStatus.PREPARING,
          payment_status: PaymentStatus.PAID,
          payment_id: 654 as unknown as number,
        }),
      ]);

      await service.updateStatus(101, OrderStatus.CANCELED, admin, STORE_A);
      expect(query.set).toHaveBeenCalledWith({
        status: OrderStatus.CANCELED,
        payment_status: PaymentStatus.REFUND_PENDING,
      });
      expect(payments.refund).toHaveBeenCalledWith(
        654,
        STORE_A,
        expect.objectContaining({ actor: admin, orderId: 101 }),
      );
      expect(orderRepository.update).toHaveBeenCalledWith(
        {
          id: 101,
          store_id: STORE_A,
          payment_status: PaymentStatus.REFUND_PENDING,
        },
        { payment_status: PaymentStatus.REFUNDED },
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: admin,
          storeId: STORE_A,
          action: 'order.cancel',
          targetId: 101,
          metadata: expect.objectContaining({
            via: 'status',
            from_status: OrderStatus.PREPARING,
            refund: PaymentStatus.REFUNDED,
          }) as unknown,
        }),
      );
    });

    it('cancelamento pela equipe é auditado; pelo cliente, não (o estorno é auditado nos pagamentos)', async () => {
      const { service, audit } = setup([
        storedOrder(),
        storedOrder({ id: 102 }),
      ]);
      const request = { ip: '10.0.0.1', headers: {} } as never;
      await service.cancel(101, employee, { request });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'order.cancel',
          storeId: STORE_A,
          request,
          metadata: expect.objectContaining({
            via: 'cancel',
            refund: null,
          }) as unknown,
        }),
      );
      audit.record.mockClear();
      await service.cancel(102, client);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('pedido já estornado ou pago na entrega não estorna de novo', async () => {
      const { service, payments } = setup([
        storedOrder({
          payment_status: PaymentStatus.REFUNDED,
          payment_id: 987 as unknown as number,
          status: OrderStatus.PREPARING,
        }),
      ]);
      await service.cancel(101, admin);
      expect(payments.refund).not.toHaveBeenCalled();
    });

    it('atribui apenas entregador ativo DA MESMA LOJA (outra loja, cliente, lixeira ou bloqueado → 404)', async () => {
      const { service, userRepository, query, orderRepository } = setup([
        storedOrder({ status: OrderStatus.READY_FOR_PICKUP }),
      ]);

      userRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.assignDriver(101, 31, STORE_A)).rejects.toThrow(
        new NotFoundException('Entregador não encontrado ou inativo.'),
      );
      const { where } = callArg<{ where: Record<string, unknown> }>(
        userRepository.findOne,
      );
      expect(where).toMatchObject({ id: 31, store_id: STORE_A });
      expect((where.blocked_at as FindOperator<unknown>).type).toBe('isNull');

      // Equipe da mesma loja que não é entregador: 400 (não revela nada de outra loja)
      userRepository.findOne.mockResolvedValueOnce({ id: 3, role: 'KITCHEN' });
      await expect(
        service.assignDriver(101, 3, STORE_A),
      ).rejects.toBeInstanceOf(BadRequestException);

      userRepository.findOne.mockResolvedValueOnce({ id: 30, role: 'COURIER' });
      await service.assignDriver(101, 30, STORE_A);
      expect(query.set).toHaveBeenCalledWith({
        status: OrderStatus.DELIVERING,
        driver: { id: 30 },
      });

      orderRepository.rows[0].status = OrderStatus.CANCELED;
      await expect(
        service.assignDriver(101, 30, STORE_A),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('pedido de outra loja não recebe entregador (404 antes de olhar o entregador)', async () => {
      const { service, userRepository } = setup([
        storedOrder({ status: OrderStatus.READY_FOR_PICKUP }),
      ]);
      await expect(service.assignDriver(101, 30, STORE_B)).rejects.toThrow(
        notFound,
      );
      expect(userRepository.findOne).not.toHaveBeenCalled();
    });

    it('lista de entregadores: só da loja e sem bloqueados', async () => {
      const { service, userRepository } = setup();
      await service.getAvailableDrivers(STORE_B);
      const options = callArg<{
        where: Record<string, unknown>;
        select: Record<string, boolean>;
      }>(userRepository.find);
      expect(options.where).toMatchObject({
        role: UserRole.COURIER,
        store_id: STORE_B,
      });
      expect((options.where.blocked_at as FindOperator<unknown>).type).toBe(
        'isNull',
      );
      expect(options.select).toEqual({
        id: true,
        name: true,
        phone: true,
        avatar: true,
      });
    });
  });

  describe('pedidos próximos', () => {
    const area = (neighborhood: string, city = 'Rio de Janeiro') => ({
      street: 'Rua X',
      number: '1',
      complement: null,
      neighborhood,
      city,
      state: 'RJ',
      zipCode: '20000000',
      nickname: null,
    });

    it('mesma loja e mesmo bairro do retrato de entrega (pedidos antigos: endereço ligado)', async () => {
      const { service, orderRepository } = setup([
        storedOrder({
          status: OrderStatus.READY_FOR_PICKUP,
          // O cliente mudou o cadastro para Botafogo depois do pedido: vale o retrato (Centro)
          address: { id: 9, ...area('Botafogo') } as never,
          delivery_address: area('Centro'),
        }),
      ]);
      orderRepository.find.mockResolvedValueOnce([
        storedOrder({ id: 110, delivery_address: area('centro') }),
        storedOrder({ id: 111, delivery_address: area('Botafogo') }),
        storedOrder({
          id: 112,
          address: { id: 3, ...area('Centro') } as never,
        }),
        storedOrder({
          id: 113,
          delivery_address: area('Centro', 'Niterói'),
        }),
      ]);

      const nearby = await service.getNearbyOrders(101, STORE_A);
      expect(nearby.map((order) => order.id)).toEqual([110, 112]);
      const { where } = callArg<{ where: Record<string, unknown> }>(
        orderRepository.find,
      );
      expect(where).toMatchObject({
        store_id: STORE_A,
        status: OrderStatus.READY_FOR_PICKUP,
        type: OrderType.DELIVERY,
      });
    });

    it('pedido de outra loja → 404; retirada → lista vazia', async () => {
      const { service, orderRepository } = setup([
        storedOrder(),
        storedOrder({ id: 120, type: OrderType.TAKEOUT }),
      ]);
      await expect(service.getNearbyOrders(101, STORE_B)).rejects.toThrow(
        notFound,
      );
      await expect(service.getNearbyOrders(120, STORE_A)).resolves.toEqual([]);
      expect(orderRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('dashboard e relatórios', () => {
    it('resumo só da loja (store_id em todas as consultas)', async () => {
      const { service, orderRepository, query } = setup();
      const summary = await service.getDashboardSummary(STORE_B);
      expect(summary).toEqual({
        totalOrders: 3,
        revenue: 150.5,
        pendingOrders: 3,
        preparingOrders: 3,
        pendingPayments: 2,
      });
      for (const [options] of orderRepository.count.mock.calls as [
        { where: Record<string, unknown> },
      ][]) {
        expect(options.where).toMatchObject({ store_id: STORE_B });
      }
      const storeFilters = query.where.mock.calls.filter(
        ([sql]) => sql === 'o.store_id = :storeId',
      );
      expect(storeFilters).toEqual([
        ['o.store_id = :storeId', { storeId: STORE_B }],
        ['o.store_id = :storeId', { storeId: STORE_B }],
      ]);
    });

    it('gráficos: faturamento pelo dia no fuso da loja (stores.time_zone), não do servidor', async () => {
      const { service, orderRepository, query, itemsQuery, planLimits } =
        setup();
      // Só os pagos (e não cancelados) chegam, crus: total_price como texto (numeric)
      query.getRawMany.mockResolvedValueOnce([
        // 23:30 de 10/10 em São Paulo (já é 11/10 em UTC)
        { created_at: new Date('2026-10-11T02:30:00Z'), total_price: '30.00' },
        // 00:30 de 11/10 em São Paulo
        { created_at: new Date('2026-10-11T03:30:00Z'), total_price: '20.00' },
      ]);
      // Mais vendidos somados no banco (pagos ou não, sem os cancelados)
      itemsQuery.getRawMany.mockResolvedValueOnce([
        { name: 'X-Bacon', quantity: '3' },
        { name: 'Batata', quantity: '1' },
      ]);

      const { revenueChart, productsChart } = await service.getChartData(
        STORE_A,
        new Date('2026-10-11T12:00:00Z'),
      );
      expect(planLimits.assertFeature).toHaveBeenCalledWith(
        STORE_A,
        'advanced_reports',
      );
      // Sem montar entidades: nenhuma busca com relações
      expect(orderRepository.find).not.toHaveBeenCalled();
      expect(query.where).toHaveBeenCalledWith('o.store_id = :storeId', {
        storeId: STORE_A,
      });
      expect(query.andWhere).toHaveBeenCalledWith('o.payment_status = :paid', {
        paid: PaymentStatus.PAID,
      });
      expect(query.andWhere).toHaveBeenCalledWith('o.status != :canceled', {
        canceled: OrderStatus.CANCELED,
      });
      // Do dia 05/10 00:00 até o fim de 11/10 em São Paulo (UTC−3), nas duas consultas
      for (const builder of [query, itemsQuery]) {
        const calls = builder.andWhere.mock.calls as [
          string,
          Record<string, Date>,
        ][];
        const start = calls.find(([sql]) => sql === 'o.created_at >= :start');
        const end = calls.find(([sql]) => sql === 'o.created_at < :end');
        expect(start?.[1].start.toISOString()).toBe('2026-10-05T03:00:00.000Z');
        expect(end?.[1].end.toISOString()).toBe('2026-10-12T03:00:00.000Z');
      }
      expect(itemsQuery.where).toHaveBeenCalledWith('o.store_id = :storeId', {
        storeId: STORE_A,
      });
      expect(itemsQuery.limit).toHaveBeenCalledWith(5);
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

    it('gráficos: outra loja, outro fuso (Asia/Tokyo) — o dia é o do calendário daquela loja', async () => {
      const { service, query, stores } = setup();
      (stores.get(STORE_B) as Store).time_zone = 'Asia/Tokyo';
      query.getRawMany.mockResolvedValueOnce([
        // 01:00 de 11/10 em Tóquio (ainda 10/10 em UTC e em São Paulo)
        { created_at: new Date('2026-10-10T16:00:00Z'), total_price: '40.00' },
      ]);
      const { revenueChart } = await service.getChartData(
        STORE_B,
        new Date('2026-10-11T03:00:00Z'),
      );
      expect(revenueChart[6]).toEqual({ date: '11/10', total: 40 });
      // 05/10 00:00 em Tóquio (UTC+9)
      const [, { start }] = (
        query.andWhere.mock.calls as [string, Record<string, Date>][]
      ).find(([sql]) => sql === 'o.created_at >= :start') as [
        string,
        Record<string, Date>,
      ];
      expect(start.toISOString()).toBe('2026-10-04T15:00:00.000Z');
    });

    it('gráficos e relatórios exigem o recurso advanced_reports do plano (403, sem consultar pedidos)', async () => {
      const { service, orderRepository, planLimits } = setup();
      planLimits.assertFeature.mockRejectedValue(
        new ForbiddenException(
          'O plano Básico não inclui relatórios e gráficos.',
        ),
      );
      await expect(service.getChartData(STORE_A)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        service.getReport(STORE_A, { from: '2026-10-01', to: '2026-10-02' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(orderRepository.find).not.toHaveBeenCalled();
      expect(orderRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('relatório: período no fuso da loja com faturamento por dia, status, formas de pagamento, ticket médio e top produtos', async () => {
      const { service, orderRepository, query, itemsQuery } = setup();
      // Linhas cruas do banco (getRawMany): total_price chega como texto (numeric)
      query.getRawMany.mockResolvedValueOnce([
        // 00:30 de 01/10 em São Paulo
        {
          id: 1,
          created_at: new Date('2026-10-01T03:30:00Z'),
          status: OrderStatus.DONE,
          payment_status: PaymentStatus.PAID,
          payment_method: 'PIX',
          total_price: '30.00',
        },
        // 23:59 de 01/10 em São Paulo (02/10 em UTC)
        {
          id: 2,
          created_at: new Date('2026-10-02T02:59:00Z'),
          status: OrderStatus.DONE,
          payment_status: PaymentStatus.PAID,
          payment_method: 'MONEY',
          total_price: '20.00',
        },
        {
          id: 3,
          created_at: new Date('2026-10-02T15:00:00Z'),
          status: OrderStatus.CANCELED,
          payment_status: PaymentStatus.REFUNDED,
          payment_method: 'CREDIT_CARD',
          total_price: '50.00',
        },
        {
          id: 4,
          created_at: new Date('2026-10-03T12:00:00Z'),
          status: OrderStatus.PENDING,
          payment_status: PaymentStatus.PENDING,
          payment_method: 'MONEY',
          total_price: '15.50',
        },
      ]);
      itemsQuery.getRawMany.mockResolvedValueOnce([
        { name: 'X-Bacon', quantity: '5' },
        { name: 'Batata', quantity: '2' },
      ]);

      const report = await service.getReport(
        STORE_A,
        { from: '2026-10-01', to: '2026-10-03' },
        new Date('2026-10-11T12:00:00Z'),
      );

      // Consulta da loja, de 01/10 00:00 até 04/10 00:00 em São Paulo (UTC−3), sem montar entidades
      expect(orderRepository.find).not.toHaveBeenCalled();
      expect(query.where).toHaveBeenCalledWith('o.store_id = :storeId', {
        storeId: STORE_A,
      });
      const [, { start }] = query.andWhere.mock.calls.find(
        ([sql]) => sql === 'o.created_at >= :start',
      ) as [string, { start: Date }];
      const [, { end }] = query.andWhere.mock.calls.find(
        ([sql]) => sql === 'o.created_at < :end',
      ) as [string, { end: Date }];
      expect(start.toISOString()).toBe('2026-10-01T03:00:00.000Z');
      expect(end.toISOString()).toBe('2026-10-04T03:00:00.000Z');
      expect(query.getRawMany).toHaveBeenCalledTimes(1);
      expect(itemsQuery.where).toHaveBeenCalledWith('o.store_id = :storeId', {
        storeId: STORE_A,
      });

      expect(report.period).toEqual({
        from: '2026-10-01',
        to: '2026-10-03',
        days: 3,
        timeZone: 'America/Sao_Paulo',
      });
      expect(report.summary).toEqual({
        orders: 4,
        canceledOrders: 1,
        paidOrders: 2,
        revenue: 50,
        averageTicket: 25,
      });
      expect(report.revenueByDay).toEqual([
        { date: '2026-10-01', orders: 2, paidOrders: 2, revenue: 50 },
        { date: '2026-10-02', orders: 0, paidOrders: 0, revenue: 0 },
        { date: '2026-10-03', orders: 1, paidOrders: 0, revenue: 0 },
      ]);
      expect(report.ordersByStatus).toEqual(
        expect.arrayContaining([
          { status: OrderStatus.DONE, count: 2 },
          { status: OrderStatus.CANCELED, count: 1 },
          { status: OrderStatus.PENDING, count: 1 },
          { status: OrderStatus.PREPARING, count: 0 },
        ]),
      );
      expect(report.paymentMethods).toEqual([
        { method: 'PIX', orders: 1, paidOrders: 1, revenue: 30 },
        { method: 'MONEY', orders: 2, paidOrders: 1, revenue: 20 },
      ]);
      expect(report.topProducts).toEqual([
        { name: 'X-Bacon', quantity: 5 },
        { name: 'Batata', quantity: 2 },
      ]);
    });

    it('relatório: período inválido ou maior que 366 dias → 400 (sem consultar pedidos)', async () => {
      const { service, orderRepository, query: rawQuery } = setup();
      for (const query of [
        { from: '2026-13-01', to: '2026-10-02' },
        { from: '2026-10-05', to: '2026-10-01' },
        { from: '2025-01-01', to: '2026-10-01' },
        { from: ['2026-10-01'], to: '2026-10-02' },
      ]) {
        await expect(service.getReport(STORE_A, query)).rejects.toBeInstanceOf(
          BadRequestException,
        );
      }
      expect(orderRepository.find).not.toHaveBeenCalled();
      expect(rawQuery.getRawMany).not.toHaveBeenCalled();
    });
  });
});
