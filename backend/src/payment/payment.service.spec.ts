import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { FindOperator, QueryFailedError, type Repository } from 'typeorm';
import type { AuthUser } from '../auth/auth-user';
import type { AuditService } from '../audit/audit.service';
import type { PlanLimitsService } from '../billing/plan-limits.service';
import { encryptSecret, encryptStoreSecret } from '../common/crypto/secret-box';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import type { Order } from '../orders/entities/order.entity';
import type {
  OrderPricingService,
  PricedOrder,
} from '../orders/order-pricing.service';
import { OrderStatus, OrderType, PaymentStatus } from '../orders/order.enums';
import { MONTHLY_ORDERS_LIMIT_MESSAGE } from '../orders/order-rules';
import type { CreateOrderDto } from '../orders/dto/create-order.dto';
import type { Store } from '../store/entities/store.entity';
import type { StoreAccessState } from '../tenancy/store-access';
import type { TenantContext } from '../tenancy/tenant-context';
import type { TenantService } from '../tenancy/tenant.service';
import { UserRole } from '../users/entities/user.entity';
import type {
  CreateCardPaymentDto,
  CreatePixPaymentDto,
} from './dto/create-payment.dto';
import type { Payment } from './entities/payment.entity';
import type { PaymentGateway } from './mercado-pago.gateway';
import {
  ONLINE_PAYMENT_NOT_IN_PLAN_MESSAGE,
  ONLINE_PAYMENT_UNAVAILABLE_MESSAGE,
  TOO_MANY_PENDING_CHARGES_MESSAGE,
  mercadoPagoIdempotencyKey,
} from './payment-rules';
import {
  FINALIZE_CONCURRENCY,
  NOTIFICATION_CONCURRENCY,
  NOTIFICATION_QUEUE_LIMIT,
  NOTIFICATION_RECHECK_MS,
  PaymentService,
  RECONCILE_BATCH,
  RECONCILE_PER_STORE,
  STATUS_POLL_RECHECK_MS,
} from './payment.service';

/** Loja padrão (sem credencial própria usa o MP_ACCESS_TOKEN do ambiente). */
const STORE_A = 1;
/** Outra loja da plataforma. */
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
const otherClient = user(8, UserRole.CLIENT, { name: 'João' });
const staffA = user(1, UserRole.EMPLOYEE, { storeId: STORE_A });
const staffB = user(2, UserRole.ADMIN, { storeId: STORE_B });
const kitchenA = user(3, UserRole.KITCHEN, { storeId: STORE_A });
const courierA = user(4, UserRole.COURIER, { storeId: STORE_A });

const order = {
  items: [{ productId: 1, quantity: 2 }],
  type: OrderType.TAKEOUT,
};

const pixDto = { order } as CreatePixPaymentDto;
const cardDto = {
  order,
  token: 'tok_123',
  paymentMethodId: 'master',
  docNumber: '12345678909',
  amount: 0.01, // ignorado: o valor sempre vem do servidor
} as unknown as CreateCardPaymentDto;

const withKey = <T extends object>(dto: T, idempotencyKey: string): T => ({
  ...dto,
  idempotencyKey,
});

function orderDto(
  paymentId: number,
  paymentMethod = 'CREDIT_CARD',
): CreateOrderDto {
  return { ...order, paymentMethod, paymentId } as CreateOrderDto;
}

function priced(
  total: number,
  storeOpen = true,
  storeId = STORE_A,
): PricedOrder {
  return {
    storeId,
    type: OrderType.TAKEOUT,
    items: [
      {
        product: { id: 1, name: 'X-Bacon da Casa' } as never,
        addons: [],
        addonsSnapshot: [],
        quantity: 2,
        observation: '',
        meatPoint: null,
        removedIngredients: [],
        unitPrice: total / 2,
        addonsTotal: 0,
        lineTotal: total,
      },
    ],
    address: null,
    subtotal: total,
    delivery_fee: 0,
    total,
    totalCents: Math.round(total * 100),
    estimated_delivery_time: '15-20 min',
    store_open: storeOpen,
  };
}

function operational(
  overrides: Partial<StoreAccessState> = {},
): StoreAccessState {
  return {
    availability: 'OPERATIONAL',
    canSell: true,
    canRead: true,
    canOperate: true,
    canManage: true,
    canManageBilling: true,
    publicVisible: true,
    message: null,
    ...overrides,
  };
}

function storeRow(id: number, extra: Partial<Store> = {}): Store {
  return {
    id,
    slug: `loja-${id}`,
    name: `Loja ${id}`,
    mp_access_token_encrypted: null,
    ...extra,
  } as Store;
}

function uniqueViolation() {
  return new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error('duplicate key'), { code: '23505' }),
  );
}

function checkViolation() {
  return new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error('O produto 1 não pertence à loja do pedido 9.'), {
      code: '23514',
    }),
  );
}

/** Igualdade simples + IsNull/In/MoreThan do TypeORM (o suficiente para estes testes). */
function matches(row: Record<string, unknown>, where: object): boolean {
  return Object.entries(where as Record<string, unknown>).every(
    ([key, expected]) => {
      const value = row[key];
      if (expected instanceof FindOperator) {
        const operator = expected as FindOperator<unknown>;
        if (operator.type === 'isNull')
          return value === null || value === undefined;
        if (operator.type === 'in')
          return (operator.value as unknown[]).includes(value);
        // Como no SQL: NULL > x não vale
        if (operator.type === 'moreThan')
          return (
            value !== null &&
            value !== undefined &&
            (value as number) > (operator.value as number)
          );
        throw new Error(`operador não suportado no teste: ${operator.type}`);
      }
      if (
        expected &&
        typeof expected === 'object' &&
        !(expected instanceof Date)
      ) {
        return matches((value ?? {}) as Record<string, unknown>, expected);
      }
      return value === expected;
    },
  );
}

/** Linhas que atendem a um where do TypeORM (objeto ou lista de alternativas). */
function whereMatches(row: Payment, where: object | object[]): boolean {
  const options: object[] = Array.isArray(where)
    ? (where as object[])
    : [where];
  return options.some((condition: object) =>
    matches(row as unknown as Record<string, unknown>, condition),
  );
}

/**
 * Seleção da conciliação (RECONCILE_CANDIDATES_SQL) em memória: aprovados primeiro, no máximo
 * `perStore` por loja intercalando as lojas, nunca conferidos e depois os conferidos há mais tempo.
 */
function reconcileSelection(
  rows: Iterable<Payment>,
  [since, pending, perStore, limit]: [Date, string[], number, number],
): Array<{ id: string }> {
  const open = [...rows].filter(
    (row) =>
      (row.order_id === null || row.order_id === undefined) &&
      row.created_at > since &&
      ((row.status === 'approved' && !row.finalize_error) ||
        pending.includes(row.status)),
  );
  const rank = (row: Payment) => [
    row.status === 'approved' ? 0 : 1,
    row.updated_at > row.created_at ? 1 : 0,
    row.updated_at.getTime(),
    row.id,
  ];
  const compare = (a: number[], b: number[]) =>
    a.reduce((result, value, i) => result || value - b[i], 0);
  const positions = new Map<Payment, number>();
  for (const storeId of new Set(open.map((row) => row.store_id))) {
    open
      .filter((row) => row.store_id === storeId)
      .sort((a, b) => compare(rank(a), rank(b)))
      .forEach((row, index) => positions.set(row, index + 1));
  }
  const key = (row: Payment) => {
    const [approved, ...rest] = rank(row);
    return [approved, positions.get(row) as number, ...rest];
  };
  return open
    .filter((row) => (positions.get(row) as number) <= perStore)
    .sort((a, b) => compare(key(a), key(b)))
    .slice(0, limit)
    .map((row) => ({ id: String(row.id) }));
}

/**
 * Tabela "payments" em memória (INSERT nunca sobrescreve; chave única por loja + cliente).
 * Como no banco: created_at = updated_at no INSERT e todo UPDATE renova updated_at.
 */
function fakePaymentRepository() {
  const rows = new Map<number, Payment>();
  /** pg_advisory_xact_lock em memória: a trava vale até o fim da transação (entre "instâncias"). */
  const locks = new Map<string, Promise<void>>();
  const lockCalls: string[] = [];
  /** Transações abertas agora e o máximo visto (cada uma ocupa uma conexão do pool). */
  const transactions = { open: 0, max: 0 };
  const transaction = jest.fn(
    async <T>(work: (manager: { query: jest.Mock }) => Promise<T>) => {
      transactions.open++;
      transactions.max = Math.max(transactions.max, transactions.open);
      const held: Array<() => void> = [];
      const query = jest.fn(async (sql: string, params: unknown[] = []) => {
        if (!sql.includes('pg_advisory_xact_lock'))
          throw new Error(`SQL inesperado na transação do teste: ${sql}`);
        const key = String(params[0]);
        lockCalls.push(key);
        while (locks.has(key)) await locks.get(key);
        let release = () => {};
        locks.set(
          key,
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        );
        held.push(() => {
          locks.delete(key);
          release();
        });
        return [];
      });
      try {
        return await work({ query });
      } finally {
        for (const release of held) release();
        transactions.open--;
      }
    },
  );
  const repo = {
    rows,
    lockCalls,
    transactions,
    manager: { transaction },
    create: jest.fn((data: Partial<Payment>) => ({ ...data }) as Payment),
    insert: jest.fn((entity: Payment) => {
      const duplicateKey =
        !!entity.idempotency_key &&
        [...rows.values()].some(
          (row) =>
            row.store_id === entity.store_id &&
            row.user_id === entity.user_id &&
            row.idempotency_key === entity.idempotency_key,
        );
      if (rows.has(entity.id) || duplicateKey)
        return Promise.reject(uniqueViolation());
      const now = new Date();
      rows.set(entity.id, {
        ...entity,
        created_at: now,
        updated_at: now,
      });
      return Promise.resolve({});
    }),
    findOne: jest.fn(({ where }: { where: object }) => {
      const row = [...rows.values()].find((item) => whereMatches(item, where));
      return Promise.resolve(row ? { ...row } : null);
    }),
    find: jest.fn(({ where }: { where: object | object[] }) =>
      Promise.resolve(
        [...rows.values()]
          .filter((row) => whereMatches(row, where))
          .map((row) => ({ ...row })),
      ),
    ),
    count: jest.fn(({ where }: { where: object | object[] }) =>
      Promise.resolve(
        [...rows.values()].filter((row) => whereMatches(row, where)).length,
      ),
    ),
    query: jest.fn((_sql: string, params: [Date, string[], number, number]) =>
      Promise.resolve(reconcileSelection(rows.values(), params)),
    ),
    update: jest.fn((criteria: object, changes: Record<string, unknown>) => {
      let affected = 0;
      // Um pouco depois do INSERT (o relógio do teste pode estar parado)
      const touched = new Date(Date.now() + 1);
      for (const row of rows.values()) {
        if (matches(row as unknown as Record<string, unknown>, criteria)) {
          const values = Object.fromEntries(
            Object.entries(changes).map(([key, value]) => [
              key,
              typeof value === 'function' ? touched : value,
            ]),
          );
          Object.assign(row, { updated_at: touched }, values);
          affected++;
        }
      }
      return Promise.resolve({ affected });
    }),
  };
  return repo;
}

/** Tabela "orders" em memória com o índice único de payment_id. */
function fakeOrderRepository() {
  const rows = new Map<number, Record<string, unknown>>();
  let nextId = 500;
  return {
    rows,
    create: jest.fn((data: object) => ({ ...data })),
    save: jest.fn((data: Record<string, unknown>) => {
      const taken = [...rows.values()].some(
        (row) => data.payment_id !== null && row.payment_id === data.payment_id,
      );
      if (taken) return Promise.reject(uniqueViolation());
      const saved = { ...data, id: nextId++ };
      rows.set(saved.id, saved);
      return Promise.resolve(saved);
    }),
    findOne: jest.fn(({ where }: { where: object }) => {
      const row = [...rows.values()].find((item) => matches(item, where));
      return Promise.resolve(row ? { ...row } : null);
    }),
    update: jest.fn((criteria: object, changes: Record<string, unknown>) => {
      let affected = 0;
      for (const row of rows.values()) {
        if (matches(row, criteria)) {
          Object.assign(row, changes);
          affected++;
        }
      }
      return Promise.resolve({ affected });
    }),
    manager: {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: client.id, name: client.name }),
      exists: jest.fn().mockResolvedValue(true),
    },
  };
}

/** Tabela "stores" em memória: a credencial cifrada do Mercado Pago de cada loja. */
function fakeStoreRepository(stores: Store[]) {
  const rows = new Map(stores.map((store) => [store.id, store]));
  return {
    rows,
    findOne: jest.fn(({ where }: { where: { id: number } }) => {
      const row = rows.get(where.id);
      return Promise.resolve(row ? { ...row } : null);
    }),
  };
}

interface SetupOptions {
  total?: number;
  storeOpen?: boolean;
  stores?: Store[];
}

function setup(
  env: Record<string, string | undefined> = {},
  options: SetupOptions = {},
) {
  const total = options.total ?? 45.9;
  const storeOpen = options.storeOpen ?? true;
  const pricing = {
    price: jest.fn(
      (_dto: unknown, _userId: number, tenant: TenantContext | Store) =>
        Promise.resolve(
          priced(
            total,
            storeOpen,
            'storeId' in tenant ? tenant.storeId : tenant.id,
          ),
        ),
    ),
    existingReferences: jest.fn().mockResolvedValue({
      productIds: new Set([1]),
      addonIds: new Set<number>(),
      addressExists: false,
    }),
  };
  const payments = fakePaymentRepository();
  const orders = fakeOrderRepository();
  const stores = fakeStoreRepository(
    options.stores ?? [storeRow(STORE_A), storeRow(STORE_B)],
  );
  /** Situação atual de cada loja (padrão: vendendo); os testes trocam para simular o bloqueio. */
  const access = new Map<number, StoreAccessState>();
  const tenantOf = (storeId: number): TenantContext => ({
    storeId,
    store: stores.rows.get(storeId) as Store,
    subscription: null,
    access: access.get(storeId) ?? operational(),
  });
  const tenants = {
    contextForStoreId: jest.fn((storeId: number) =>
      Promise.resolve(tenantOf(storeId)),
    ),
    defaultStore: jest.fn(() =>
      Promise.resolve(stores.rows.get(STORE_A) ?? null),
    ),
    findStoreBySlug: jest.fn((slug: string) =>
      Promise.resolve(
        [...stores.rows.values()].find((store) => store.slug === slug) ?? null,
      ),
    ),
    staffContext: jest.fn((actor: AuthUser) => {
      if (!actor.storeId)
        return Promise.reject(
          new ForbiddenException(
            'Esta área é exclusiva da equipe de uma loja.',
          ),
        );
      return Promise.resolve(tenantOf(actor.storeId));
    }),
    assertCanSell: jest.fn((context: TenantContext) => {
      if (!context.access.canSell)
        throw new ForbiddenException(
          context.access.message ?? 'Loja indisponível.',
        );
    }),
  };
  const planLimits = {
    hasFeature: jest.fn().mockResolvedValue(true),
    assertWithinLimit: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const config = {
    get: (key: string) => ({ NODE_ENV: 'test', ...env })[key],
  };
  // Limites de verdade (em memória, um por teste): os padrões de produção valem aqui
  const rateLimit = new RateLimitService();
  /** Outra instância da API (memória própria) sobre as mesmas tabelas. */
  const newInstance = () =>
    new PaymentService(
      pricing as unknown as OrderPricingService,
      payments as unknown as Repository<Payment>,
      orders as unknown as Repository<Order>,
      stores as unknown as Repository<Store>,
      tenants as unknown as TenantService,
      planLimits as unknown as PlanLimitsService,
      audit as unknown as AuditService,
      config as unknown as ConfigService,
      rateLimit,
    );
  const service = newInstance();
  return {
    service,
    newInstance,
    pricing,
    payments,
    orders,
    stores,
    tenants,
    planLimits,
    audit,
    rateLimit,
    access,
    tenantA: tenantOf(STORE_A),
    tenantB: tenantOf(STORE_B),
    tenantOf,
  };
}

type FakeGateway = Record<keyof PaymentGateway, jest.Mock>;

function gatewayDouble(
  impl: Partial<Record<keyof PaymentGateway, jest.Mock>> = {},
): FakeGateway {
  return {
    createPayment: impl.createPayment ?? jest.fn(),
    getPayment: impl.getPayment ?? jest.fn(),
    cancelPayment: impl.cancelPayment ?? jest.fn(),
    refundPayment: impl.refundPayment ?? jest.fn(),
  };
}

/** Substitui o Mercado Pago por um dublê (nenhuma chamada de rede nos testes), qualquer credencial. */
function fakeMercadoPago(
  service: PaymentService,
  impl: Partial<Record<keyof PaymentGateway, jest.Mock>>,
) {
  const fake = gatewayDouble(impl);
  service.gatewayFactory = () => fake;
  return fake;
}

/** Um dublê por Access Token (para conferir qual credencial cada loja usou). */
function fakeMercadoPagoByToken(
  service: PaymentService,
  byToken: Record<string, FakeGateway>,
) {
  const factory = jest.fn((token: string) => {
    const fake = byToken[token];
    if (!fake) throw new Error(`token inesperado no teste: ${token}`);
    return fake;
  });
  service.gatewayFactory = factory;
  return factory;
}

/** Corpo e chave de idempotência enviados ao Mercado Pago na chamada N de createPayment. */
type SentBody = {
  transaction_amount: number;
  description: string;
  external_reference?: string;
  date_of_expiration?: string;
  payer: { email?: string; identification?: unknown };
};
function sent(create: jest.Mock, call = 0): { body: SentBody; key: string } {
  const [body, key] = create.mock.calls[call] as [SentBody, string];
  return { body, key };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Relógio falso só para Date (setImmediate continua real para esperar as notificações). */
function fakeClock(iso: string) {
  jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
  });
}

const production = {
  NODE_ENV: 'production',
  MP_ACCESS_TOKEN: 'APP_USR-abc',
};

const approvedCard = (id: number, extra: object = {}) =>
  jest.fn().mockResolvedValue({
    id,
    status: 'approved',
    status_detail: 'accredited',
    transaction_amount: 45.9,
    ...extra,
  });

const pendingPix = (id: number) =>
  jest.fn().mockResolvedValue({
    id,
    status: 'pending',
    point_of_interaction: { transaction_data: { qr_code: '000201' } },
  });

describe('PaymentService', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });
  afterEach(() => jest.useRealTimers());

  describe('sandbox sem credenciais', () => {
    it('cartão: aprova por simulação, cobra o total do servidor e o pedido já nasce (orderId) na loja', async () => {
      const { service, pricing, orders, payments, tenantA } = setup();
      const result = await service.createCardPayment(cardDto, client, tenantA);

      expect(pricing.price).toHaveBeenCalledWith(order, client.id, tenantA);
      expect(result).toMatchObject({
        status: 'approved',
        amount: 45.9,
        simulation: true,
      });
      expect(result.orderId).toEqual(expect.any(Number));

      expect(orders.save).toHaveBeenCalledTimes(1);
      expect(orders.save.mock.calls[0][0]).toMatchObject({
        store_id: STORE_A,
        user: { id: client.id },
        status: OrderStatus.PENDING,
        payment_status: PaymentStatus.PAID,
        payment_id: result.id,
        payment_method: 'CREDIT_CARD',
        type: OrderType.TAKEOUT,
        total_price: 45.9,
        change_for: null,
        delivery_address: null,
      });
      const items = orders.save.mock.calls[0][0].items as Record<
        string,
        unknown
      >[];
      expect(items[0]).toMatchObject({
        product: { id: 1 },
        product_name: 'X-Bacon da Casa',
        quantity: 2,
        unit_price: 22.95,
      });
      expect(payments.rows.get(result.id)).toMatchObject({
        store_id: STORE_A,
        order_id: result.orderId,
        status: 'approved',
        simulated: true,
      });
    });

    it('não cobra quando a loja está fechada (400 antes de qualquer pagamento)', async () => {
      const { service, payments, tenantA } = setup({}, { storeOpen: false });
      await expect(
        service.createCardPayment(cardDto, client, tenantA),
      ).rejects.toThrow('A loja está fechada no momento.');
      await expect(
        service.createPixPayment(pixDto, client, tenantA),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(payments.insert).not.toHaveBeenCalled();
    });

    it('PIX: vence em PIX_EXPIRATION_MINUTES e é aprovado depois de PIX_SANDBOX_APPROVAL_SECONDS (o status traz orderId)', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, orders, tenantA } = setup({
        PIX_SANDBOX_APPROVAL_SECONDS: '5',
      });

      const pix = await service.createPixPayment(pixDto, client, tenantA);
      expect(pix).toMatchObject({
        status: 'pending',
        amount: 45.9,
        simulation: true,
        qr_code_base64: null,
        expires_at: '2026-10-11T12:30:00.000Z',
      });
      expect(pix.qr_code).toContain('SANDBOX');

      expect(await service.getStatusFor(pix.id, client)).toEqual({
        id: pix.id,
        status: 'pending',
        status_detail: 'pending_waiting_transfer',
      });
      expect(orders.save).not.toHaveBeenCalled();

      jest.setSystemTime(new Date('2026-10-11T12:00:06Z'));
      const approved = await service.getStatusFor(pix.id, client);
      expect(approved).toMatchObject({ id: pix.id, status: 'approved' });
      expect(approved.orderId).toEqual(expect.any(Number));
      expect(orders.save.mock.calls[0][0]).toMatchObject({
        store_id: STORE_A,
        payment_method: 'PIX',
        payment_id: pix.id,
        payment_status: PaymentStatus.PAID,
      });
    });

    it('PIX cancelado pelo cliente nunca vira pedido (nem pela conciliação)', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, orders, tenantA } = setup();
      const pix = await service.createPixPayment(pixDto, client, tenantA);

      await expect(service.cancelFor(pix.id, client)).resolves.toEqual({
        id: pix.id,
        status: 'cancelled',
      });
      // Cancelar de novo não muda nada
      await expect(service.cancelFor(pix.id, client)).resolves.toEqual({
        id: pix.id,
        status: 'cancelled',
      });

      jest.setSystemTime(new Date('2026-10-11T12:01:00Z'));
      expect((await service.getStatusFor(pix.id, client)).status).toBe(
        'cancelled',
      );
      await service.reconcile();
      expect(orders.save).not.toHaveBeenCalled();
    });

    it('cancelar um PIX já aprovado → 409 e o pedido existe', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, orders, tenantA } = setup();
      const pix = await service.createPixPayment(pixDto, client, tenantA);

      jest.setSystemTime(new Date('2026-10-11T12:00:10Z'));
      await expect(service.cancelFor(pix.id, client)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(orders.save).toHaveBeenCalledTimes(1);
    });

    it('somente o pagador cancela: outro cliente e equipe → 404 uniforme (como inexistente)', async () => {
      const { service, tenantA } = setup();
      const pix = await service.createPixPayment(pixDto, client, tenantA);
      for (const actor of [otherClient, staffA, staffB]) {
        await expect(service.cancelFor(pix.id, actor)).rejects.toThrow(
          new NotFoundException('Pagamento não encontrado.'),
        );
      }
      await expect(service.cancelFor(42, client)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // Rota de outra loja (/stores/loja-2/payment/:id/cancel) também não encontra
      await expect(
        service.cancelFor(pix.id, client, 'loja-2'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.cancelFor(pix.id, client, 'loja-1'),
      ).resolves.toMatchObject({ status: 'cancelled' });
    });
  });

  describe('criação do pedido pelo servidor (finalize)', () => {
    it('status, webhook e conciliação ao mesmo tempo criam um único pedido', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, orders, tenantA } = setup();
      const pix = await service.createPixPayment(pixDto, client, tenantA);
      jest.setSystemTime(new Date('2026-10-11T12:00:10Z'));

      const [first, second] = await Promise.all([
        service.getStatusFor(pix.id, client),
        service.getStatusFor(pix.id, client),
        service.reconcile(),
      ]);
      service.handleNotification(
        { type: 'payment', data: { id: String(pix.id) } },
        {},
      );
      await flush();

      expect(orders.save).toHaveBeenCalledTimes(1);
      expect(first.orderId).toEqual(expect.any(Number));
      expect(second.orderId).toBe(first.orderId);
      expect((await service.getStatusFor(pix.id, client)).orderId).toBe(
        first.orderId,
      );
    });

    it('duas instâncias finalizando ao mesmo tempo enquanto a loja deixa de vender: nunca pedido PAGO com o valor estornado', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, newInstance, orders, payments, access, tenantA } =
        setup(production);
      const mp = fakeMercadoPago(service, {
        createPayment: pendingPix(6101),
        getPayment: jest.fn().mockResolvedValue({
          id: 6101,
          status: 'approved',
          transaction_amount: 45.9,
        }),
        refundPayment: jest.fn().mockResolvedValue({ status: 'refunded' }),
      });
      const other = newInstance();
      other.gatewayFactory = service.gatewayFactory;
      await service.createPixPayment(pixDto, client, tenantA);

      // Instância A decide criar o pedido (loja vendendo) e fica no INSERT...
      let resumeInsert = () => {};
      const realSave = orders.save.getMockImplementation() as (
        data: Record<string, unknown>,
      ) => Promise<unknown>;
      orders.save.mockImplementationOnce(
        (data: Record<string, unknown>) =>
          new Promise((resolve, reject) => {
            resumeInsert = () => {
              realSave(data).then(resolve, reject);
            };
          }),
      );
      const first = service.getStatusFor(6101, client);
      for (let i = 0; i < 10; i++) await flush();
      expect(orders.save).toHaveBeenCalledTimes(1);

      // ...a loja é suspensa nesse instante e a instância B confere o mesmo pagamento
      access.set(
        STORE_A,
        operational({ availability: 'SUSPENDED', canSell: false }),
      );
      const second = other.getStatusFor(6101, client);
      for (let i = 0; i < 10; i++) await flush();
      resumeInsert();
      const [a, b] = await Promise.all([first, second]);

      const row = payments.rows.get(6101) as Payment;
      const order = [...orders.rows.values()].find(
        (item) => item.payment_id === 6101,
      );
      // Uma decisão só: o pedido de A vale e B não estorna
      expect(order).toBeDefined();
      expect(row.order_id).toBe(order?.id);
      expect(row.finalize_error).toBeNull();
      expect(mp.refundPayment).not.toHaveBeenCalled();
      expect(row.status).toBe('approved');
      expect(a.orderId).toBe(order?.id);
      expect(b.orderId).toBe(order?.id);
      expect(payments.lockCalls).toEqual(['6101', '6101']);
    });

    it('finalizações simultâneas de pagamentos diferentes: no máximo FINALIZE_CONCURRENCY travas abertas por instância (o pool de conexões não esgota)', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, orders, payments, tenantA } = setup();
      const buyers = Array.from({ length: 10 }, (_, i) =>
        user(200 + i, UserRole.CLIENT),
      );
      const ids: number[] = [];
      for (const buyer of buyers)
        ids.push((await service.createPixPayment(pixDto, buyer, tenantA)).id);
      jest.setSystemTime(new Date('2026-10-11T12:00:10Z'));

      // Os INSERTs dos pedidos esperam: as travas ficam abertas ao mesmo tempo
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const realSave = orders.save.getMockImplementation() as (
        data: Record<string, unknown>,
      ) => Promise<{ id: number }>;
      orders.save.mockImplementation((data: Record<string, unknown>) =>
        gate.then(() => realSave(data)),
      );
      const statuses = Promise.all(
        ids.map((id, i) => service.getStatusFor(id, buyers[i])),
      );
      for (let i = 0; i < 20; i++) await flush();
      expect(payments.transactions.open).toBe(FINALIZE_CONCURRENCY);

      release();
      const results = await statuses;
      expect(new Set(results.map((result) => result.orderId)).size).toBe(10);
      expect(
        results.every((result) => typeof result.orderId === 'number'),
      ).toBe(true);
      expect(payments.transactions.max).toBe(FINALIZE_CONCURRENCY);
      expect(payments.transactions.open).toBe(0);
    });

    it('pedido criado por outra instância (índice único em payment_id) é reaproveitado', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, orders, tenantA } = setup();
      const pix = await service.createPixPayment(pixDto, client, tenantA);
      jest.setSystemTime(new Date('2026-10-11T12:00:10Z'));

      // Outra instância grava o pedido entre a nossa leitura e o nosso INSERT
      orders.save.mockImplementationOnce(() => {
        orders.rows.set(900, {
          id: 900,
          payment_id: pix.id,
          store_id: STORE_A,
        });
        return Promise.reject(uniqueViolation());
      });
      const status = await service.getStatusFor(pix.id, client);
      expect(status.orderId).toBe(900);
    });

    it('usa o retrato da hora do pagamento mesmo se a loja fechou e os preços mudaram', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, pricing, orders, tenantA } = setup();
      const pix = await service.createPixPayment(pixDto, client, tenantA);

      pricing.price.mockResolvedValue(priced(99, false));
      jest.setSystemTime(new Date('2026-10-11T12:00:10Z'));
      await service.reconcile();

      expect(pricing.price).toHaveBeenCalledTimes(1);
      expect(orders.save).toHaveBeenCalledTimes(1);
      expect(orders.save.mock.calls[0][0]).toMatchObject({
        total_price: 45.9,
        payment_id: pix.id,
      });
    });

    it('valor pago diferente do total do pedido → nenhum pedido e o valor é estornado', async () => {
      const { service, orders, payments, tenantA } = setup({
        MP_ACCESS_TOKEN: 'TEST-abc',
      });
      fakeMercadoPago(service, {
        createPayment: approvedCard(4321, { transaction_amount: 75 }), // pedido de 45,90
      });

      const result = await service.createCardPayment(cardDto, client, tenantA);
      expect(result.orderId).toBeUndefined();
      expect(orders.save).not.toHaveBeenCalled();
      expect(payments.rows.get(4321)).toMatchObject({
        status: 'refunded',
        order_id: null,
      });
      expect(payments.rows.get(4321)?.finalize_error).toContain('estornado');

      await expect(
        service.orderIdForPayment(orderDto(4321), client, tenantA),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('falha passageira ao gravar o pedido: o pagamento continua aprovado e a conciliação cria depois', async () => {
      const { service, orders, payments, tenantA } = setup();
      orders.save.mockRejectedValueOnce(new Error('conexão perdida'));

      const result = await service.createCardPayment(cardDto, client, tenantA);
      expect(result).toMatchObject({ status: 'approved' });
      expect(result.orderId).toBeUndefined();

      await service.reconcile();
      expect(orders.save).toHaveBeenCalledTimes(2);
      expect(payments.rows.get(result.id)?.order_id).toEqual(
        expect.any(Number),
      );
    });

    it('gatilho de loja do banco (23514) ao criar o pedido → falha definitiva: estorno e motivo gravado', async () => {
      const { service, orders, payments, audit, tenantA } = setup();
      orders.save.mockRejectedValueOnce(checkViolation());

      const result = await service.createCardPayment(cardDto, client, tenantA);
      expect(result.orderId).toBeUndefined();
      expect(payments.rows.get(result.id)).toMatchObject({
        status: 'refunded',
        order_id: null,
      });
      expect(payments.rows.get(result.id)?.finalize_error).toContain(
        'não pertencem à loja',
      );

      // A conciliação não tenta de novo (finalize_error preenchido)
      await service.reconcile();
      expect(orders.save).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'payment.order_not_created',
          storeId: STORE_A,
          result: 'FAILURE',
        }),
      );
    });

    it('retrato de outra loja guardado no pagamento → falha definitiva (nenhum pedido)', async () => {
      const { service, orders, payments, tenantA } = setup();
      const result = await service.createCardPayment(
        withKey(cardDto, 'tentativa-0900'),
        client,
        tenantA,
      );
      const row = payments.rows.get(result.id) as Payment;
      // Simula um registro inconsistente: aprovado, sem pedido e com o retrato de outra loja
      orders.rows.clear();
      orders.save.mockClear();
      row.order_id = null;
      row.price_snapshot = { ...row.price_snapshot, storeId: STORE_B };

      expect(await service.finalize({ ...row })).toBeNull();
      expect(orders.save).not.toHaveBeenCalled();
      expect(payments.rows.get(result.id)?.finalize_error).toContain(
        'outra loja',
      );
    });

    it('pagamento antigo (retrato sem storeId): o pedido nasce na loja do pagamento', async () => {
      const { service, orders, payments, pricing } = setup();
      payments.rows.set(777_001, {
        id: 777_001,
        store_id: STORE_B,
        user_id: client.id,
        method: 'CARD',
        order_payment_method: 'CREDIT_CARD',
        payment_method_id: 'master',
        amount: 45.9,
        status: 'approved',
        status_detail: 'accredited',
        simulated: true,
        order_payload: {
          items: [{ productId: 1, quantity: 2 }],
          type: OrderType.TAKEOUT,
        },
        price_snapshot: {
          type: OrderType.TAKEOUT,
          addressId: null,
          deliveryAddress: null,
          items: [
            {
              productId: 1,
              productName: 'X-Bacon',
              quantity: 2,
              unitPrice: 22.95,
              addonsTotal: 0,
              lineTotal: 45.9,
              addons: [],
              observation: '',
              meatPoint: null,
              removedIngredients: [],
            },
          ],
          subtotal: 45.9,
          deliveryFee: 0,
          total: 45.9,
          estimatedDeliveryTime: '15-20 min',
        },
        pix_data: null,
        expires_at: null,
        auto_approve_at: null,
        order_id: null,
        idempotency_key: null,
        external_reference: 'comestra-cliente-7-1700000000000',
        finalize_error: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const orderId = await service.finalize({
        ...(payments.rows.get(777_001) as Payment),
      });
      expect(orderId).toEqual(expect.any(Number));
      expect(orders.save.mock.calls[0][0]).toMatchObject({
        store_id: STORE_B,
        payment_id: 777_001,
      });
      // Referências conferidas na loja do pagamento
      expect(pricing.existingReferences).toHaveBeenCalledWith(
        expect.objectContaining({ storeId: STORE_B, userId: client.id }),
      );
    });
  });

  describe('idempotencyKey', () => {
    it('a mesma chave do mesmo cliente devolve o mesmo pagamento, cobra uma vez e o Mercado Pago recebe a chave derivada da loja', async () => {
      const { service, tenantA } = setup(production);
      const mp = fakeMercadoPago(service, {
        createPayment: approvedCard(777),
      });

      const dto = withKey(cardDto, 'tentativa-0001');
      const first = await service.createCardPayment(dto, client, tenantA);
      const retry = await service.createCardPayment(dto, client, tenantA);

      expect(mp.createPayment).toHaveBeenCalledTimes(1);
      expect(sent(mp.createPayment).key).toBe(
        mercadoPagoIdempotencyKey(STORE_A, client.id, 'tentativa-0001'),
      );
      expect(retry).toEqual(first);
      expect(first.orderId).toEqual(expect.any(Number));
    });

    it('requisições simultâneas com a mesma chave cobram uma vez só', async () => {
      const { service, tenantA } = setup(production);
      let resolveCharge: (value: unknown) => void = () => undefined;
      const mp = fakeMercadoPago(service, {
        createPayment: jest.fn(
          () => new Promise((resolve) => (resolveCharge = resolve)),
        ),
      });

      const dto = withKey(cardDto, 'tentativa-0002');
      const both = Promise.all([
        service.createCardPayment(dto, client, tenantA),
        service.createCardPayment(dto, client, tenantA),
      ]);
      await flush();
      resolveCharge({ id: 778, status: 'approved', transaction_amount: 45.9 });
      const [a, b] = await both;

      expect(mp.createPayment).toHaveBeenCalledTimes(1);
      expect(a.id).toBe(778);
      expect(b.id).toBe(778);
    });

    it('a mesma chave em clientes diferentes são pagamentos diferentes; sem chave, cada chamada cobra', async () => {
      const { service, tenantA } = setup();
      const dto = withKey(cardDto, 'tentativa-0003');
      const mine = await service.createCardPayment(dto, client, tenantA);
      const theirs = await service.createCardPayment(dto, otherClient, tenantA);
      expect(theirs.id).not.toBe(mine.id);

      const a = await service.createCardPayment(cardDto, client, tenantA);
      const b = await service.createCardPayment(cardDto, client, tenantA);
      expect(a.id).not.toBe(b.id);
    });

    it('a mesma chave do mesmo cliente em OUTRA loja é outro pagamento (idempotência por loja)', async () => {
      const { service, payments, tenantA, tenantB } = setup();
      const dto = withKey(pixDto, 'tentativa-0005');
      const inA = await service.createPixPayment(dto, client, tenantA);
      const inB = await service.createPixPayment(dto, client, tenantB);
      const againInB = await service.createPixPayment(dto, client, tenantB);

      expect(inB.id).not.toBe(inA.id);
      expect(againInB).toEqual(inB);
      expect(payments.insert).toHaveBeenCalledTimes(2);
      expect(payments.rows.get(inA.id)?.store_id).toBe(STORE_A);
      expect(payments.rows.get(inB.id)?.store_id).toBe(STORE_B);
      // A busca da chave sempre filtra pela loja
      expect(payments.findOne).toHaveBeenCalledWith({
        where: {
          store_id: STORE_B,
          user_id: client.id,
          idempotency_key: 'tentativa-0005',
        },
      });
    });

    it('PIX repetido com a mesma chave devolve o mesmo QR; chave de PIX não serve para cartão (400)', async () => {
      const { service, payments, tenantA } = setup();
      const dto = withKey(pixDto, 'tentativa-0004');
      const first = await service.createPixPayment(dto, client, tenantA);
      const again = await service.createPixPayment(dto, client, tenantA);
      expect(again).toEqual(first);
      expect(payments.insert).toHaveBeenCalledTimes(1);

      await expect(
        service.createCardPayment(
          withKey(cardDto, 'tentativa-0004'),
          client,
          tenantA,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('POST /orders com paymentId (orderIdForPayment)', () => {
    it('devolve o pedido já criado para o mesmo cliente (idempotente)', async () => {
      const { service, orders, tenantA } = setup();
      const payment = await service.createCardPayment(cardDto, client, tenantA);

      await expect(
        service.orderIdForPayment(orderDto(payment.id), client, tenantA),
      ).resolves.toBe(payment.orderId);
      await expect(
        service.orderIdForPayment(
          orderDto(payment.id, 'DEBIT_CARD'),
          client,
          tenantA,
        ),
      ).resolves.toBe(payment.orderId);
      expect(orders.save).toHaveBeenCalledTimes(1);
    });

    it('recusa pagamento desconhecido, de outro cliente ou de outra forma (400)', async () => {
      const { service, tenantA } = setup();
      const payment = await service.createCardPayment(cardDto, client, tenantA);

      await expect(
        service.orderIdForPayment(orderDto(123), client, tenantA),
      ).rejects.toThrow('não encontrado');
      // De outro cliente: a mesma resposta de inexistente (não confirma que o pagamento existe)
      await expect(
        service.orderIdForPayment(orderDto(payment.id), otherClient, tenantA),
      ).rejects.toThrow(
        new BadRequestException(
          'Pagamento não encontrado ou expirado. Faça o pagamento novamente.',
        ),
      );
      await expect(
        service.orderIdForPayment(orderDto(payment.id, 'PIX'), client, tenantA),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.orderIdForPayment(
          orderDto(payment.id, 'MONEY'),
          client,
          tenantA,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('pagamento de OUTRA loja → 400 "não encontrado ou expirado" (não revela o pagamento)', async () => {
      const { service, tenantA, tenantB } = setup();
      const payment = await service.createCardPayment(cardDto, client, tenantA);

      await expect(
        service.orderIdForPayment(orderDto(payment.id), client, tenantB),
      ).rejects.toThrow(
        new BadRequestException(
          'Pagamento não encontrado ou expirado. Faça o pagamento novamente.',
        ),
      );
    });

    it('PIX pendente → 400 "ainda não foi aprovado"; depois de aprovado devolve o pedido', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, orders, tenantA } = setup();
      const pix = await service.createPixPayment(pixDto, client, tenantA);

      await expect(
        service.orderIdForPayment(orderDto(pix.id, 'PIX'), client, tenantA),
      ).rejects.toThrow('ainda não foi aprovado');
      expect(orders.save).not.toHaveBeenCalled();

      jest.setSystemTime(new Date('2026-10-11T12:00:10Z'));
      const orderId = await service.orderIdForPayment(
        orderDto(pix.id, 'PIX'),
        client,
        tenantA,
      );
      expect(orders.rows.get(orderId)).toMatchObject({
        payment_id: pix.id,
        store_id: STORE_A,
      });
    });

    it('pagamento de pedido cancelado não é reaproveitado (400)', async () => {
      const { service, orders, tenantA } = setup();
      const payment = await service.createCardPayment(cardDto, client, tenantA);
      orders.rows.get(payment.orderId as number)!.status = OrderStatus.CANCELED;

      await expect(
        service.orderIdForPayment(orderDto(payment.id), client, tenantA),
      ).rejects.toThrow('cancelado');
    });

    it('recuperação no Mercado Pago (pagamento fora da tabela) confere loja e cliente da referência externa', async () => {
      const { service, payments, tenantA } = setup(production);
      const remote = (id: number, reference: string) => ({
        id,
        status: 'approved',
        payment_method_id: 'master',
        payment_type_id: 'credit_card',
        transaction_amount: 45.9,
        external_reference: reference,
      });
      const mp = fakeMercadoPago(service, {
        getPayment: jest.fn((id: number) =>
          Promise.resolve(
            {
              5001: remote(5001, 'comestra-loja-2-cliente-7-1791732193705'),
              5002: remote(5002, 'comestra-loja-1-cliente-8-1791732193705'),
              5003: remote(5003, 'comestra-loja-1-cliente-7-1791732193705'),
              5004: remote(5004, 'comestra-cliente-7-1791732193705'),
            }[id],
          ),
        ),
      });

      // Outra loja ou outro cliente na referência → não encontrado
      for (const id of [5001, 5002]) {
        await expect(
          service.orderIdForPayment(orderDto(id), client, tenantA),
        ).rejects.toThrow('não encontrado ou expirado');
      }
      // Esta loja e este cliente (formato novo e o antigo, sem loja) → recuperado nesta loja
      for (const id of [5003, 5004]) {
        await expect(
          service.orderIdForPayment(orderDto(id), client, tenantA),
        ).resolves.toEqual(expect.any(Number));
        expect(payments.rows.get(id)).toMatchObject({
          store_id: STORE_A,
          user_id: client.id,
        });
      }
      expect(mp.getPayment).toHaveBeenCalledTimes(4 + 2);
    });
  });

  describe('estorno', () => {
    it('sandbox: estorno simulado (sem Mercado Pago) e o pagamento fica "refunded"', async () => {
      const { service, payments, tenantA } = setup({
        MP_ACCESS_TOKEN: 'TEST-abc',
      });
      const mp = fakeMercadoPago(service, {
        createPayment: jest.fn().mockRejectedValue(new Error('offline')),
      });
      const payment = await service.createCardPayment(cardDto, client, tenantA);

      await expect(service.refund(payment.id, STORE_A)).resolves.toBe(true);
      expect(mp.refundPayment).not.toHaveBeenCalled();
      expect(payments.rows.get(payment.id)?.status).toBe('refunded');
    });

    it('produção: estorna no Mercado Pago (chave refund-<id>); falha → false (estorno pendente)', async () => {
      const { service } = setup(production);
      const mp = fakeMercadoPago(service, {
        refundPayment: jest
          .fn()
          .mockResolvedValueOnce({ id: 1, status: 'approved' })
          .mockRejectedValueOnce({ status: 400, message: 'refund_failed' })
          .mockRejectedValueOnce({ status: 400, message: 'already_refunded' }),
        getPayment: jest
          .fn()
          .mockResolvedValueOnce({ id: 222, status: 'approved' })
          .mockResolvedValueOnce({ id: 333, status: 'refunded' }),
      });

      await expect(service.refund(111, STORE_A)).resolves.toBe(true);
      expect(mp.refundPayment).toHaveBeenCalledWith(111, 'refund-111');
      await expect(service.refund(222, STORE_A)).resolves.toBe(false);
      // Já estornado pelo painel do Mercado Pago
      await expect(service.refund(333, STORE_A)).resolves.toBe(true);
    });

    it('produção sem credenciais: estorno fica pendente; pagamento simulado é estornado por simulação', async () => {
      const { service } = setup({ NODE_ENV: 'production' });
      await expect(service.refund(123456, STORE_A)).resolves.toBe(false);
      await expect(service.refund(900_000_000_000_123, STORE_A)).resolves.toBe(
        true,
      );
    });

    it('confere a loja do pagamento: estorno pedido por outra loja é recusado (nada é estornado)', async () => {
      const { service, payments, audit, tenantA } = setup(production);
      const mp = fakeMercadoPago(service, {
        createPayment: approvedCard(4400),
        refundPayment: jest.fn().mockResolvedValue({}),
      });
      await service.createCardPayment(cardDto, client, tenantA);

      await expect(service.refund(4400, STORE_B)).resolves.toBe(false);
      expect(mp.refundPayment).not.toHaveBeenCalled();
      expect(payments.rows.get(4400)?.status).toBe('approved');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'payment.refund',
          storeId: STORE_B,
          targetId: 4400,
          result: 'FAILURE',
        }),
      );
    });

    it('estorna com a credencial da loja do pagamento e audita sem segredos', async () => {
      const tokenB = 'APP_USR-loja-b-segredo';
      const { service, audit, tenantB } = setup(production, {
        stores: [
          storeRow(STORE_A),
          storeRow(STORE_B, {
            mp_access_token_encrypted: encryptSecret(tokenB),
          }),
        ],
      });
      const envGateway = gatewayDouble();
      const storeGateway = gatewayDouble({
        createPayment: approvedCard(4500),
        refundPayment: jest.fn().mockResolvedValue({}),
      });
      fakeMercadoPagoByToken(service, {
        'APP_USR-abc': envGateway,
        [tokenB]: storeGateway,
      });
      await service.createCardPayment(cardDto, client, tenantB);

      await expect(
        service.refund(4500, STORE_B, {
          actor: staffB,
          reason: 'order_canceled',
          orderId: 9,
        }),
      ).resolves.toBe(true);
      expect(storeGateway.refundPayment).toHaveBeenCalledWith(
        4500,
        'refund-4500',
      );
      expect(envGateway.refundPayment).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'payment.refund',
          scope: 'STORE',
          storeId: STORE_B,
          result: 'SUCCESS',
          metadata: expect.objectContaining({
            reason: 'order_canceled',
            order_id: 9,
          }) as unknown,
        }),
      );
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(tokenB);
    });
  });

  describe('GET /payment/status/:id', () => {
    it('somente o pagador ou ADMIN/EMPLOYEE DA LOJA do pagamento; os demais (cozinha, entregador, id desconhecido) → 404', async () => {
      const { service, tenantA } = setup();
      const pix = await service.createPixPayment(pixDto, client, tenantA);

      await expect(service.getStatusFor(pix.id, staffA)).resolves.toMatchObject(
        { id: pix.id },
      );
      for (const actor of [otherClient, staffB, kitchenA, courierA]) {
        await expect(service.getStatusFor(pix.id, actor)).rejects.toThrow(
          new NotFoundException('Pagamento não encontrado.'),
        );
      }
      await expect(service.getStatusFor(42, client)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rota /stores/:storeSlug/payment/status/:id: pagamento de outra loja → 404', async () => {
      const { service, tenantB } = setup();
      const pix = await service.createPixPayment(pixDto, client, tenantB);
      await expect(
        service.getStatusFor(pix.id, client, 'loja-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.getStatusFor(pix.id, client, 'loja-2'),
      ).resolves.toMatchObject({ id: pix.id });
    });
  });

  describe('lojas: credencial do Mercado Pago, plano e situação', () => {
    it('registra o pagamento na loja da vitrine, com a referência externa nova e o retrato da loja', async () => {
      const { service, payments, tenantB } = setup();
      const pix = await service.createPixPayment(pixDto, client, tenantB);
      const row = payments.rows.get(pix.id) as Payment;
      expect(row.store_id).toBe(STORE_B);
      expect(row.external_reference).toMatch(/^comestra-loja-2-cliente-7-\d+$/);
      expect(row.price_snapshot.storeId).toBe(STORE_B);
    });

    it('cada loja recebe na própria conta: credencial da loja; a loja padrão sem credencial usa MP_ACCESS_TOKEN; outra loja sem credencial → 503', async () => {
      const tokenB = 'APP_USR-loja-b';
      const { service, tenantA, tenantB, tenantOf, stores } = setup(
        production,
        {
          stores: [
            storeRow(STORE_A),
            storeRow(STORE_B, {
              mp_access_token_encrypted: encryptSecret(tokenB),
            }),
            storeRow(3),
          ],
        },
      );
      const envGateway = gatewayDouble({ createPayment: approvedCard(601) });
      const storeGateway = gatewayDouble({ createPayment: approvedCard(602) });
      const factory = fakeMercadoPagoByToken(service, {
        'APP_USR-abc': envGateway,
        [tokenB]: storeGateway,
      });

      await service.createCardPayment(cardDto, client, tenantB);
      expect(storeGateway.createPayment).toHaveBeenCalledTimes(1);
      expect(sent(storeGateway.createPayment).body.description).toBe(
        'Pedido Loja 2',
      );
      await service.createCardPayment(cardDto, client, tenantA);
      expect(envGateway.createPayment).toHaveBeenCalledTimes(1);

      await expect(
        service.createCardPayment(cardDto, client, tenantOf(3)),
      ).rejects.toThrow(
        new ServiceUnavailableException(ONLINE_PAYMENT_UNAVAILABLE_MESSAGE),
      );
      expect(factory.mock.calls.map(([token]) => token)).toEqual([
        tokenB,
        'APP_USR-abc',
      ]);
      // O token cifrado é pedido explicitamente (a coluna é select:false)
      expect(stores.findOne).toHaveBeenCalledWith({
        where: { id: STORE_B },
        select: { id: true, mp_access_token_encrypted: true },
      });
    });

    it('credencial presa à loja (v2): a própria loja usa; o valor copiado para outra loja não decifra (503, sem chamar o MP)', async () => {
      const tokenB = 'APP_USR-loja-b-v2';
      const sealedB = encryptStoreSecret(STORE_B, tokenB);
      const { service, tenantB, tenantOf } = setup(production, {
        stores: [
          storeRow(STORE_A),
          storeRow(STORE_B, { mp_access_token_encrypted: sealedB }),
          // O mesmo valor cifrado gravado em outra loja (ex.: cópia manual no banco)
          storeRow(3, { mp_access_token_encrypted: sealedB }),
        ],
      });
      const storeGateway = gatewayDouble({ createPayment: approvedCard(611) });
      const factory = fakeMercadoPagoByToken(service, {
        [tokenB]: storeGateway,
      });

      await service.createCardPayment(cardDto, client, tenantB);
      expect(storeGateway.createPayment).toHaveBeenCalledTimes(1);

      await expect(
        service.createCardPayment(cardDto, client, tenantOf(3)),
      ).rejects.toThrow(
        new ServiceUnavailableException(ONLINE_PAYMENT_UNAVAILABLE_MESSAGE),
      );
      expect(factory.mock.calls.map(([token]) => token)).toEqual([tokenB]);
    });

    it('a loja que não é a padrão nunca usa o MP_ACCESS_TOKEN do ambiente', async () => {
      const { service, tenantB, tenants } = setup(production);
      const factory = jest.fn();
      service.gatewayFactory = factory;
      tenants.defaultStore.mockResolvedValue(storeRow(STORE_A));

      await expect(
        service.createPixPayment(pixDto, client, tenantB),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(factory).not.toHaveBeenCalled();
    });

    it('perfil público (online_enabled): plano com o recurso e credencial utilizável; sandbox sempre simula', async () => {
      const tokenB = 'APP_USR-loja-b';
      const prod = setup(production, {
        stores: [
          storeRow(STORE_A),
          storeRow(STORE_B, {
            mp_access_token_encrypted: encryptSecret(tokenB),
          }),
          storeRow(3),
        ],
      });
      prod.service.gatewayFactory = () => gatewayDouble();
      await expect(prod.service.onlinePaymentsAvailable(STORE_A)).resolves.toBe(
        true,
      );
      await expect(prod.service.onlinePaymentsAvailable(STORE_B)).resolves.toBe(
        true,
      );
      await expect(prod.service.onlinePaymentsAvailable(3)).resolves.toBe(
        false,
      );
      prod.planLimits.hasFeature.mockResolvedValue(false);
      await expect(prod.service.onlinePaymentsAvailable(STORE_B)).resolves.toBe(
        false,
      );

      const sandbox = setup();
      await expect(sandbox.service.onlinePaymentsAvailable(3)).resolves.toBe(
        true,
      );
    });

    it('em produção, credencial de TESTE (TEST-) da loja é recusada', async () => {
      const { service, tenantB } = setup(
        { NODE_ENV: 'production' },
        {
          stores: [
            storeRow(STORE_A),
            storeRow(STORE_B, {
              mp_access_token_encrypted: encryptSecret('TEST-123'),
            }),
          ],
        },
      );
      const factory = jest.fn();
      service.gatewayFactory = factory;
      await expect(
        service.createCardPayment(cardDto, client, tenantB),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(factory).not.toHaveBeenCalled();
    });

    it('credencial ilegível (adulterada ou de outra chave) deixa só aquela loja sem pagamento online', async () => {
      const { service, tenantA, tenantB } = setup(production, {
        stores: [
          storeRow(STORE_A),
          storeRow(STORE_B, { mp_access_token_encrypted: 'v1:abc:def:ghi' }),
        ],
      });
      fakeMercadoPago(service, { createPayment: approvedCard(610) });
      await expect(
        service.createCardPayment(cardDto, client, tenantB),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(
        service.createCardPayment(cardDto, client, tenantA),
      ).resolves.toMatchObject({ id: 610 });
    });

    it('cache de gateway por (loja, credencial): a mesma credencial reaproveita; trocada, cria outro', async () => {
      const first = 'APP_USR-primeira';
      const second = 'APP_USR-segunda';
      const { service, stores, tenantB } = setup(production, {
        stores: [
          storeRow(STORE_A),
          storeRow(STORE_B, {
            mp_access_token_encrypted: encryptSecret(first),
          }),
        ],
      });
      const gatewayOne = gatewayDouble({ createPayment: approvedCard(701) });
      const gatewayTwo = gatewayDouble({ createPayment: approvedCard(702) });
      const factory = fakeMercadoPagoByToken(service, {
        [first]: gatewayOne,
        [second]: gatewayTwo,
      });

      await service.createCardPayment(cardDto, client, tenantB);
      gatewayOne.createPayment.mockResolvedValue({
        id: 703,
        status: 'approved',
        transaction_amount: 45.9,
      });
      await service.createCardPayment(cardDto, client, tenantB);
      expect(factory).toHaveBeenCalledTimes(1);

      (stores.rows.get(STORE_B) as Store).mp_access_token_encrypted =
        encryptSecret(second);
      await service.createCardPayment(cardDto, client, tenantB);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(factory).toHaveBeenLastCalledWith(second);
      expect(gatewayTwo.createPayment).toHaveBeenCalledTimes(1);
    });

    it('a chave enviada ao Mercado Pago é derivada da loja: a mesma chave em lojas diferentes não colide', async () => {
      const tokenB = 'APP_USR-loja-b';
      const { service, tenantA, tenantB } = setup(production, {
        stores: [
          storeRow(STORE_A),
          storeRow(STORE_B, {
            mp_access_token_encrypted: encryptSecret(tokenB),
          }),
        ],
      });
      const envGateway = gatewayDouble({ createPayment: approvedCard(801) });
      const storeGateway = gatewayDouble({ createPayment: approvedCard(802) });
      fakeMercadoPagoByToken(service, {
        'APP_USR-abc': envGateway,
        [tokenB]: storeGateway,
      });

      const dto = withKey(cardDto, 'tentativa-0100');
      await service.createCardPayment(dto, client, tenantA);
      await service.createCardPayment(dto, client, tenantB);
      const keyA = sent(envGateway.createPayment).key;
      const keyB = sent(storeGateway.createPayment).key;
      expect(keyA).not.toBe(keyB);
      expect(keyA).toBe(
        mercadoPagoIdempotencyKey(STORE_A, client.id, 'tentativa-0100'),
      );
      expect(keyB).toBe(
        mercadoPagoIdempotencyKey(STORE_B, client.id, 'tentativa-0100'),
      );
      expect(sent(storeGateway.createPayment).body.external_reference).toMatch(
        /^comestra-loja-2-cliente-7-\d+$/,
      );
    });

    it('plano sem pagamento online → 403 antes de calcular ou cobrar', async () => {
      const { service, planLimits, pricing, payments, tenantA } = setup();
      planLimits.hasFeature.mockResolvedValue(false);
      for (const attempt of [
        () => service.createCardPayment(cardDto, client, tenantA),
        () => service.createPixPayment(pixDto, client, tenantA),
      ]) {
        await expect(attempt()).rejects.toThrow(
          new ForbiddenException(ONLINE_PAYMENT_NOT_IN_PLAN_MESSAGE),
        );
      }
      expect(planLimits.hasFeature).toHaveBeenCalledWith(
        STORE_A,
        'online_payments',
      );
      expect(pricing.price).not.toHaveBeenCalled();
      expect(payments.insert).not.toHaveBeenCalled();
    });

    it('limite de pedidos do mês do plano → 403 com mensagem para o cliente (sem nome do plano); nada é cobrado', async () => {
      const { service, planLimits, payments, tenantA } = setup();
      planLimits.assertWithinLimit.mockRejectedValue(
        new ForbiddenException(
          'Limite do plano Essencial atingido: 100 pedidos neste mês.',
        ),
      );
      const failure = service.createPixPayment(pixDto, client, tenantA);
      await expect(failure).rejects.toThrow(
        new ForbiddenException(MONTHLY_ORDERS_LIMIT_MESSAGE),
      );
      // Nenhum pagamento online em andamento na loja: só a vaga do novo pedido
      expect(planLimits.assertWithinLimit).toHaveBeenCalledWith(
        STORE_A,
        'monthly_orders',
        1,
      );
      expect(payments.insert).not.toHaveBeenCalled();
    });

    it('loja que não pode vender (suspensa/assinatura) → 403 antes de cobrar', async () => {
      const { service, payments, tenantA } = setup();
      const suspended: TenantContext = {
        ...tenantA,
        access: operational({
          availability: 'SUSPENDED',
          canSell: false,
          message: 'Loja suspensa pela plataforma.',
        }),
      };
      await expect(
        service.createPixPayment(pixDto, client, suspended),
      ).rejects.toThrow('Loja suspensa pela plataforma.');
      expect(payments.insert).not.toHaveBeenCalled();
    });

    it('webhook e polling reconsultam com a credencial da loja do pagamento', async () => {
      const tokenB = 'APP_USR-loja-b';
      const { service, orders, tenantB } = setup(production, {
        stores: [
          storeRow(STORE_A),
          storeRow(STORE_B, {
            mp_access_token_encrypted: encryptSecret(tokenB),
          }),
        ],
      });
      const envGateway = gatewayDouble();
      const storeGateway = gatewayDouble({
        createPayment: pendingPix(990),
        getPayment: jest.fn().mockResolvedValue({ id: 990, status: 'pending' }),
      });
      fakeMercadoPagoByToken(service, {
        'APP_USR-abc': envGateway,
        [tokenB]: storeGateway,
      });
      await service.createPixPayment(pixDto, client, tenantB);

      storeGateway.getPayment.mockResolvedValue({
        id: 990,
        status: 'approved',
        transaction_amount: 45.9,
      });
      service.handleNotification({ type: 'payment', data: { id: '990' } }, {});
      for (let i = 0; i < 5; i++) await flush();

      expect(storeGateway.getPayment).toHaveBeenCalledWith(990);
      expect(envGateway.getPayment).not.toHaveBeenCalled();
      expect(orders.save).toHaveBeenCalledTimes(1);
      expect(orders.save.mock.calls[0][0]).toMatchObject({ store_id: STORE_B });
    });

    it('conciliação: credencial ilegível ou erro de uma loja não trava as outras', async () => {
      const tokenB = 'APP_USR-loja-b';
      const { service, stores, orders, tenantA, tenantB } = setup(production, {
        stores: [
          storeRow(STORE_A),
          storeRow(STORE_B, {
            mp_access_token_encrypted: encryptSecret(tokenB),
          }),
        ],
      });
      const envGateway = gatewayDouble({
        createPayment: pendingPix(1101),
        getPayment: jest
          .fn()
          .mockResolvedValue({ id: 1101, status: 'pending' }),
      });
      const storeGateway = gatewayDouble({
        createPayment: pendingPix(1102),
        getPayment: jest
          .fn()
          .mockResolvedValue({ id: 1102, status: 'pending' }),
      });
      fakeMercadoPagoByToken(service, {
        'APP_USR-abc': envGateway,
        [tokenB]: storeGateway,
      });
      await service.createPixPayment(pixDto, client, tenantB);
      await service.createPixPayment(pixDto, client, tenantA);

      // A credencial da loja B fica ilegível; a loja A teve o PIX pago
      (stores.rows.get(STORE_B) as Store).mp_access_token_encrypted =
        'v1:corrompido:x:y';
      envGateway.getPayment.mockResolvedValue({
        id: 1101,
        status: 'approved',
        transaction_amount: 45.9,
      });
      storeGateway.getPayment.mockClear();

      await expect(service.reconcile()).resolves.toEqual({ finalized: 1 });
      expect(storeGateway.getPayment).not.toHaveBeenCalled();
      expect(orders.save.mock.calls[0][0]).toMatchObject({
        store_id: STORE_A,
        payment_id: 1101,
      });

      // Erro inesperado ao ler a loja B (ex.: banco): a loja A continua sendo conciliada
      envGateway.createPayment = pendingPix(1103);
      envGateway.getPayment.mockResolvedValue({ id: 1103, status: 'pending' });
      await service.createPixPayment(pixDto, client, tenantA);
      envGateway.getPayment.mockResolvedValue({
        id: 1103,
        status: 'approved',
        transaction_amount: 45.9,
      });
      stores.findOne.mockImplementation(
        ({ where }: { where: { id: number } }) =>
          where.id === STORE_B
            ? Promise.reject(new Error('conexão perdida'))
            : Promise.resolve({ ...(stores.rows.get(where.id) as Store) }),
      );
      await expect(service.reconcile()).resolves.toEqual({ finalized: 1 });
      expect(orders.save.mock.calls[1][0]).toMatchObject({
        store_id: STORE_A,
        payment_id: 1103,
      });
    });
  });

  describe('sandbox com Mercado Pago', () => {
    it('cartão recusado pelo sandbox vira aprovação simulada', async () => {
      const { service, tenantA } = setup({ MP_ACCESS_TOKEN: 'TEST-abc' });
      fakeMercadoPago(service, {
        createPayment: jest.fn().mockResolvedValue({
          id: 555,
          status: 'rejected',
          status_detail: 'cc_rejected_other_reason',
        }),
      });
      const result = await service.createCardPayment(cardDto, client, tenantA);
      expect(result).toMatchObject({
        status: 'approved',
        simulation: true,
        amount: 45.9,
      });
      expect(result.id).not.toBe(555);
    });

    it('envia o valor do servidor, a descrição com a loja e uma chave de idempotência', async () => {
      const { service, tenantA } = setup({ MP_ACCESS_TOKEN: 'TEST-abc' });
      const mp = fakeMercadoPago(service, { createPayment: approvedCard(777) });

      const result = await service.createCardPayment(cardDto, client, tenantA);
      expect(result).toMatchObject({
        id: 777,
        status: 'approved',
        status_detail: 'accredited',
        amount: 45.9,
      });
      // Pagamento real (não simulado): sem "simulation"; aprovado → pedido criado (orderId)
      expect(Object.keys(result).sort()).toEqual([
        'amount',
        'id',
        'orderId',
        'status',
        'status_detail',
      ]);
      expect(typeof result.orderId).toBe('number');

      const { body, key } = sent(mp.createPayment);
      expect(body.transaction_amount).toBe(45.9);
      expect(body.description).toBe('Pedido Loja 1');
      expect(body.payer.identification).toEqual({
        type: 'CPF',
        number: '12345678909',
      });
      // Sem chave do app: o servidor gera uma por tentativa (nunca reaproveita a anterior)
      expect(key).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('PIX usa o nome do usuário logado como pagador e vence em 30 minutos', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, tenantA } = setup({ MP_ACCESS_TOKEN: 'TEST-abc' });
      const mp = fakeMercadoPago(service, {
        createPayment: jest.fn().mockResolvedValue({
          id: 888,
          status: 'pending',
          point_of_interaction: {
            transaction_data: {
              qr_code: '000201...',
              qr_code_base64: 'iVBOR',
              ticket_url: 'https://mp',
            },
          },
        }),
      });
      const pix = await service.createPixPayment(pixDto, client, tenantA);
      expect(pix).toMatchObject({
        id: 888,
        qr_code: '000201...',
        simulation: true,
        expires_at: '2026-10-11T12:30:00.000Z',
      });
      const { body } = sent(mp.createPayment);
      expect(body.payer).toEqual({
        email: client.email,
        first_name: 'Maria',
        last_name: 'Silva',
      });
      expect(body.date_of_expiration).toBe('2026-10-11T12:30:00.000+00:00');
    });

    it('PIX real com prazo configurado abaixo de 30 min usa o mínimo do Mercado Pago (credencial da loja)', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const tokenB = 'TEST-loja-b';
      const { service, tenantB } = setup(
        { PIX_EXPIRATION_MINUTES: '5' },
        {
          stores: [
            storeRow(STORE_A),
            storeRow(STORE_B, {
              mp_access_token_encrypted: encryptSecret(tokenB),
            }),
          ],
        },
      );
      const storeGateway = gatewayDouble({ createPayment: pendingPix(889) });
      fakeMercadoPagoByToken(service, { [tokenB]: storeGateway });
      await service.createPixPayment(pixDto, client, tenantB);
      expect(sent(storeGateway.createPayment).body.date_of_expiration).toBe(
        '2026-10-11T12:30:00.000+00:00',
      );
    });
  });

  describe('produção', () => {
    it('sem credenciais: pagamento online indisponível (503), nunca aprova', async () => {
      const { service, tenantA } = setup({ NODE_ENV: 'production' });
      await expect(
        service.createCardPayment(cardDto, client, tenantA),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(
        service.createPixPayment(pixDto, client, tenantA),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('PAYMENT_SANDBOX=true é ignorado fora de development/test', async () => {
      const { service, tenantA } = setup({
        NODE_ENV: 'production',
        PAYMENT_SANDBOX: 'true',
      });
      await expect(
        service.createCardPayment(cardDto, client, tenantA),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('cartão recusado continua recusado e não cria pedido', async () => {
      const { service, orders, tenantA } = setup(production);
      fakeMercadoPago(service, {
        createPayment: jest.fn().mockResolvedValue({
          id: 321,
          status: 'rejected',
          status_detail: 'cc_rejected_insufficient_amount',
        }),
        getPayment: jest
          .fn()
          .mockResolvedValue({ id: 321, status: 'rejected' }),
      });
      const result = await service.createCardPayment(cardDto, client, tenantA);
      expect(result).toEqual({
        id: 321,
        status: 'rejected',
        status_detail: 'cc_rejected_insufficient_amount',
        amount: 45.9,
      });
      await expect(
        service.orderIdForPayment(orderDto(321), client, tenantA),
      ).rejects.toThrow('ainda não foi aprovado');
      expect(orders.save).not.toHaveBeenCalled();
    });

    it('cartão de débito aprovado: o pedido nasce com a forma informada pelo Mercado Pago', async () => {
      const { service, orders, tenantA } = setup(production);
      fakeMercadoPago(service, {
        createPayment: approvedCard(654, { payment_type_id: 'debit_card' }),
      });
      const result = await service.createCardPayment(
        { ...cardDto, paymentMethodId: 'debelo' },
        client,
        tenantA,
      );
      expect(result.orderId).toEqual(expect.any(Number));
      expect(orders.save.mock.calls[0][0]).toMatchObject({
        payment_method: 'DEBIT_CARD',
        payment_status: PaymentStatus.PAID,
      });
    });

    it('erro do Mercado Pago vira 400 (dados inválidos) ou 502 (indisponível), nunca aprovação', async () => {
      const { service, tenantA } = setup(production);
      fakeMercadoPago(service, {
        createPayment: jest
          .fn()
          .mockRejectedValueOnce({
            status: 400,
            message: 'bad_request',
            cause: [{ description: 'Invalid card token' }],
          })
          .mockRejectedValueOnce(
            new Error('getaddrinfo ENOTFOUND api.mercadopago.com'),
          ),
      });
      await expect(
        service.createCardPayment(cardDto, client, tenantA),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.createCardPayment(cardDto, client, tenantA),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });

    it('PIX que o Mercado Pago informa como estornado/recusado não vira pedido', async () => {
      const { service, orders, tenantA } = setup(production);
      fakeMercadoPago(service, {
        createPayment: pendingPix(999),
        getPayment: jest
          .fn()
          .mockResolvedValue({ id: 999, status: 'refunded' }),
      });
      await service.createPixPayment(pixDto, client, tenantA);

      expect((await service.getStatusFor(999, client)).status).toBe('refunded');
      await expect(
        service.orderIdForPayment(orderDto(999, 'PIX'), client, tenantA),
      ).rejects.toThrow('refunded');
      expect(orders.save).not.toHaveBeenCalled();
    });

    it('sem resposta do Mercado Pago na conferência → 502 (não confirma às cegas)', async () => {
      const { service, tenantA } = setup(production);
      fakeMercadoPago(service, {
        createPayment: pendingPix(655),
        getPayment: jest.fn().mockRejectedValue(new Error('timeout')),
      });
      await service.createPixPayment(pixDto, client, tenantA);
      await expect(
        service.orderIdForPayment(orderDto(655, 'PIX'), client, tenantA),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });

    it('PIX não é aprovado sozinho em produção; o webhook reconsulta e cria o pedido quando pago', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, orders, tenantA } = setup(production);
      const mp = fakeMercadoPago(service, {
        createPayment: jest.fn().mockResolvedValue({
          id: 999,
          status: 'pending',
          point_of_interaction: {
            transaction_data: { qr_code: '000201', qr_code_base64: 'iVBOR' },
          },
        }),
        getPayment: jest.fn().mockResolvedValue({ id: 999, status: 'pending' }),
      });
      const pix = await service.createPixPayment(pixDto, client, tenantA);
      expect(pix.simulation).toBeUndefined();

      jest.setSystemTime(new Date('2026-10-11T12:20:00Z'));
      expect((await service.getStatusFor(999, client)).status).toBe('pending');

      mp.getPayment.mockResolvedValue({
        id: 999,
        status: 'approved',
        transaction_amount: 45.9,
      });
      service.handleNotification(
        { action: 'payment.updated', data: { id: '999' } },
        {},
      );
      for (let i = 0; i < 5; i++) await flush();
      expect(orders.save).toHaveBeenCalledTimes(1);
      expect((await service.getStatusFor(999, client)).orderId).toEqual(
        expect.any(Number),
      );
    });

    it('cancelamento do PIX vai para o Mercado Pago (cancelled) e nunca vira pedido', async () => {
      const { service, orders, tenantA } = setup(production);
      const mp = fakeMercadoPago(service, {
        createPayment: pendingPix(1001),
        getPayment: jest
          .fn()
          .mockResolvedValue({ id: 1001, status: 'pending' }),
        cancelPayment: jest
          .fn()
          .mockResolvedValue({ id: 1001, status: 'cancelled' }),
      });
      await service.createPixPayment(pixDto, client, tenantA);

      await expect(service.cancelFor(1001, client)).resolves.toEqual({
        id: 1001,
        status: 'cancelled',
      });
      expect(mp.cancelPayment).toHaveBeenCalledWith(1001, 'cancel-1001');
      await service.reconcile();
      expect(orders.save).not.toHaveBeenCalled();
    });

    it('PIX real de loja que perdeu a credencial: cancelar não marca só aqui (502) e a conferência estrita falha', async () => {
      const tokenB = 'APP_USR-loja-b';
      const { service, stores, tenantB } = setup(production, {
        stores: [
          storeRow(STORE_A),
          storeRow(STORE_B, {
            mp_access_token_encrypted: encryptSecret(tokenB),
          }),
        ],
      });
      fakeMercadoPagoByToken(service, {
        [tokenB]: gatewayDouble({
          createPayment: pendingPix(1201),
          getPayment: jest
            .fn()
            .mockResolvedValue({ id: 1201, status: 'pending' }),
        }),
      });
      await service.createPixPayment(pixDto, client, tenantB);
      (stores.rows.get(STORE_B) as Store).mp_access_token_encrypted = null;

      await expect(service.cancelFor(1201, client)).rejects.toBeInstanceOf(
        BadGatewayException,
      );
      await expect(
        service.orderIdForPayment(orderDto(1201, 'PIX'), client, tenantB),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });

    it('aprovado já confirmado de loja que perdeu a credencial: o pedido ainda nasce (como na conciliação)', async () => {
      const tokenB = 'APP_USR-loja-b';
      const { service, stores, orders, tenantB } = setup(production, {
        stores: [
          storeRow(STORE_A),
          storeRow(STORE_B, {
            mp_access_token_encrypted: encryptSecret(tokenB),
          }),
        ],
      });
      fakeMercadoPagoByToken(service, {
        [tokenB]: gatewayDouble({ createPayment: approvedCard(1301) }),
      });
      // Falha passageira ao gravar o pedido: fica aprovado e sem pedido
      orders.save.mockRejectedValueOnce(new Error('conexão perdida'));
      const result = await service.createCardPayment(cardDto, client, tenantB);
      expect(result.orderId).toBeUndefined();

      (stores.rows.get(STORE_B) as Store).mp_access_token_encrypted = null;
      const orderId = await service.orderIdForPayment(
        orderDto(1301),
        client,
        tenantB,
      );
      expect(orders.rows.get(orderId)).toMatchObject({
        store_id: STORE_B,
        payment_id: 1301,
      });
    });
  });

  describe('segurança: loja que deixou de vender, limites, webhook e conciliação justa', () => {
    const blocked = (
      availability: StoreAccessState['availability'],
    ): StoreAccessState =>
      operational({
        availability,
        canSell: false,
        canManage: false,
        canRead: availability !== 'INACTIVE',
        canOperate: availability !== 'INACTIVE',
        message: 'Loja suspensa pela plataforma: fraude em análise.',
      });

    /** PIX pendentes reais com ids em sequência (o Mercado Pago é um dublê). */
    const pixSequence = (start: number) => {
      let next = start;
      return jest.fn(() => {
        const id = next++;
        return Promise.resolve({
          id,
          status: 'pending',
          point_of_interaction: { transaction_data: { qr_code: `0002-${id}` } },
        });
      });
    };
    /** Carrinhos diferentes (a quantidade muda o pedido; o dublê de preço devolve o mesmo total). */
    const pixOf = (quantity: number, idempotencyKey?: string) =>
      ({
        order: { items: [{ productId: 1, quantity }], type: OrderType.TAKEOUT },
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }) as CreatePixPaymentDto;

    /** Pagamento pendente gravado direto na tabela (ex.: de uma loja sem credencial). */
    const stuckPayment = (
      id: number,
      storeId: number,
      createdAt: Date,
    ): Payment =>
      ({
        id,
        store_id: storeId,
        user_id: 100,
        method: 'PIX',
        order_payment_method: 'PIX',
        payment_method_id: 'pix',
        amount: 10,
        status: 'pending',
        status_detail: null,
        simulated: false,
        order_payload: { items: [], type: OrderType.TAKEOUT },
        price_snapshot: {},
        pix_data: null,
        expires_at: null,
        auto_approve_at: null,
        order_id: null,
        idempotency_key: null,
        external_reference: null,
        finalize_error: null,
        created_at: createdAt,
        updated_at: createdAt,
      }) as unknown as Payment;

    const rateLimitEnv = [
      'RATE_LIMIT_PAYMENT_CREATE',
      'RATE_LIMIT_PAYMENT_CREATE_IP',
      'RATE_LIMIT_PAYMENT_WEBHOOK',
    ];
    afterEach(() => {
      for (const key of rateLimitEnv) delete process.env[key];
    });

    it.each([
      ['SUSPENDED'],
      ['INACTIVE'],
      ['SUBSCRIPTION_SUSPENDED'],
      ['SUBSCRIPTION_CANCELED'],
    ] as const)(
      'PIX aprovado depois que a loja passou a %s não vira pedido: estorna com a credencial da loja e audita',
      async (availability) => {
        const tokenB = 'APP_USR-loja-b';
        const { service, orders, payments, access, audit, tenantB } = setup(
          production,
          {
            stores: [
              storeRow(STORE_A),
              storeRow(STORE_B, {
                mp_access_token_encrypted: encryptSecret(tokenB),
              }),
            ],
          },
        );
        const envGateway = gatewayDouble();
        const storeGateway = gatewayDouble({
          createPayment: pendingPix(2101),
          getPayment: jest
            .fn()
            .mockResolvedValue({ id: 2101, status: 'pending' }),
          refundPayment: jest.fn().mockResolvedValue({ status: 'refunded' }),
        });
        fakeMercadoPagoByToken(service, {
          'APP_USR-abc': envGateway,
          [tokenB]: storeGateway,
        });
        await service.createPixPayment(pixDto, client, tenantB);

        // A plataforma bloqueia a loja; depois o cliente paga o QR que já tinha
        access.set(STORE_B, blocked(availability));
        storeGateway.getPayment.mockResolvedValue({
          id: 2101,
          status: 'approved',
          transaction_amount: 45.9,
        });
        const status = await service.getStatusFor(2101, client);

        expect(status).toEqual({
          id: 2101,
          status: 'refunded',
          status_detail: 'refunded',
        });
        expect(orders.save).not.toHaveBeenCalled();
        expect(storeGateway.refundPayment).toHaveBeenCalledWith(
          2101,
          'refund-2101',
        );
        expect(envGateway.refundPayment).not.toHaveBeenCalled();
        const row = payments.rows.get(2101) as Payment;
        expect(row.order_id).toBeNull();
        expect(row.finalize_error).toBe(
          'a loja não está aceitando pedidos no momento (valor estornado)',
        );
        const entries = audit.record.mock.calls.map(
          ([item]) => item as Record<string, unknown>,
        );
        const entry = entries.find(
          (item) => item.action === 'payment.order_not_created',
        );
        expect(entry).toMatchObject({
          scope: 'SYSTEM',
          storeId: STORE_B,
          targetId: 2101,
          metadata: { refunded: true, availability },
        });
        // O motivo interno do bloqueio nunca vai para o pagamento nem para a auditoria dele
        expect(JSON.stringify([row, entry])).not.toContain('fraude');

        // Notificação, consulta e conciliação repetidas não refazem o estorno nem a auditoria
        const audits = audit.record.mock.calls.length;
        service.handleNotification({ data: { id: '2101' } }, {});
        for (let i = 0; i < 5; i++) await flush();
        await service.getStatusFor(2101, client);
        await service.reconcile();
        expect(storeGateway.refundPayment).toHaveBeenCalledTimes(1);
        expect(audit.record).toHaveBeenCalledTimes(audits);
      },
    );

    it('falha definitiva já registrada (estorno pendente): webhook, status e conciliação não tentam de novo', async () => {
      const { service, payments, audit, access, tenantA } = setup(production);
      const mp = fakeMercadoPago(service, {
        createPayment: pendingPix(2201),
        getPayment: jest.fn().mockResolvedValue({
          id: 2201,
          status: 'approved',
          transaction_amount: 45.9,
        }),
        refundPayment: jest.fn().mockRejectedValue(new Error('MP fora do ar')),
      });
      await service.createPixPayment(pixDto, client, tenantA);
      access.set(STORE_A, blocked('SUSPENDED'));
      await service.getStatusFor(2201, client);
      expect(payments.rows.get(2201)?.finalize_error).toContain(
        'estorno pendente',
      );
      expect(mp.refundPayment).toHaveBeenCalledTimes(1);
      const audits = audit.record.mock.calls.length;

      for (let i = 0; i < 3; i++) {
        service.handleNotification({ data: { id: '2201' } }, {});
        await service.getStatusFor(2201, client);
      }
      await service.reconcile();
      for (let i = 0; i < 5; i++) await flush();
      expect(mp.refundPayment).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledTimes(audits);
      service.onModuleDestroy();
    });

    it('conciliação cancela no Mercado Pago os PIX pendentes da loja que não pode vender (e audita); os das outras lojas seguem', async () => {
      const tokenB = 'APP_USR-loja-b';
      const { service, payments, access, audit, tenantA, tenantB } = setup(
        production,
        {
          stores: [
            storeRow(STORE_A),
            storeRow(STORE_B, {
              mp_access_token_encrypted: encryptSecret(tokenB),
            }),
          ],
        },
      );
      const envGateway = gatewayDouble({
        createPayment: pendingPix(2301),
        getPayment: jest
          .fn()
          .mockResolvedValue({ id: 2301, status: 'pending' }),
      });
      const storeGateway = gatewayDouble({
        createPayment: pendingPix(2302),
        getPayment: jest
          .fn()
          .mockResolvedValue({ id: 2302, status: 'pending' }),
        cancelPayment: jest.fn().mockResolvedValue({
          id: 2302,
          status: 'cancelled',
          status_detail: 'by_collector',
        }),
      });
      fakeMercadoPagoByToken(service, {
        'APP_USR-abc': envGateway,
        [tokenB]: storeGateway,
      });
      await service.createPixPayment(pixDto, client, tenantA);
      await service.createPixPayment(pixDto, client, tenantB);
      access.set(STORE_B, blocked('SUBSCRIPTION_SUSPENDED'));

      await service.reconcile();

      expect(storeGateway.cancelPayment).toHaveBeenCalledWith(
        2302,
        'cancel-2302',
      );
      expect(payments.rows.get(2302)).toMatchObject({
        status: 'cancelled',
        status_detail: 'by_collector',
      });
      expect(envGateway.cancelPayment).not.toHaveBeenCalled();
      expect(payments.rows.get(2301)?.status).toBe('pending');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'payment.cancel',
          storeId: STORE_B,
          targetId: 2302,
          metadata: expect.objectContaining({
            reason: 'store_cannot_sell',
            availability: 'SUBSCRIPTION_SUSPENDED',
          }) as unknown,
        }),
      );
    });

    it('conciliação: pendente pago no instante do bloqueio é estornado; cancelamento recusado tenta de novo na próxima rodada', async () => {
      const { service, payments, orders, access, tenantA } = setup(production);
      const mp = fakeMercadoPago(service, {
        createPayment: pixSequence(2401),
        getPayment: jest.fn((id: number) =>
          Promise.resolve({
            id,
            status: id === 2401 ? 'approved' : 'pending',
            transaction_amount: 45.9,
          }),
        ),
        cancelPayment: jest.fn().mockRejectedValue(new Error('indisponível')),
        refundPayment: jest.fn().mockResolvedValue({ status: 'refunded' }),
      });
      await service.createPixPayment(pixOf(1), client, tenantA);
      await service.createPixPayment(pixOf(2), client, tenantA);
      access.set(STORE_A, blocked('INACTIVE'));

      await service.reconcile();
      expect(orders.save).not.toHaveBeenCalled();
      expect(mp.refundPayment).toHaveBeenCalledWith(2401, 'refund-2401');
      expect(payments.rows.get(2401)?.status).toBe('refunded');
      // O cancelamento falhou: continua pendente e a próxima rodada tenta de novo
      expect(payments.rows.get(2402)?.status).toBe('pending');
      mp.cancelPayment.mockResolvedValue({ id: 2402, status: 'cancelled' });
      await service.reconcile();
      expect(payments.rows.get(2402)?.status).toBe('cancelled');
    });

    it('sandbox: PIX simulado ainda pendente de loja que não pode vender é cancelado pela conciliação', async () => {
      const { service, payments, access, tenantA } = setup();
      const pix = await service.createPixPayment(pixDto, client, tenantA);
      access.set(STORE_A, blocked('SUSPENDED'));
      await service.reconcile();
      expect(payments.rows.get(pix.id)).toMatchObject({
        status: 'cancelled',
        status_detail: 'by_collector',
      });
      // Nem o prazo de aprovação do sandbox o transforma em pedido depois
      fakeClock(new Date(Date.now() + 60_000).toISOString());
      expect((await service.getStatusFor(pix.id, client)).status).toBe(
        'cancelled',
      );
    });

    it('conciliação justa: pendentes que não podem ser reconsultados numa loja não seguram os das outras', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, payments, orders, tenantA } = setup(production);
      fakeMercadoPago(service, {
        createPayment: pendingPix(3999),
        getPayment: jest.fn((id: number) =>
          Promise.resolve({
            id,
            status: id === 3999 ? 'approved' : 'pending',
            transaction_amount: 45.9,
          }),
        ),
      });
      // 60 pagamentos pendentes mais antigos da loja B: sem credencial em produção, ninguém
      // consegue reconsultá-los (o mesmo que credencial revogada ou o Mercado Pago recusando)
      for (let i = 0; i < 60; i++)
        payments.rows.set(
          800_000 + i,
          stuckPayment(
            800_000 + i,
            STORE_B,
            new Date(Date.parse('2026-10-11T08:00:00Z') + i * 1000),
          ),
        );
      // Depois, um PIX da loja A é pago e ninguém consulta o status
      await service.createPixPayment(pixDto, client, tenantA);

      await expect(service.reconcile()).resolves.toEqual({ finalized: 1 });
      expect(orders.save.mock.calls[0][0]).toMatchObject({
        store_id: STORE_A,
        payment_id: 3999,
      });

      // A loja B usa no máximo 10 vagas por rodada e os conferidos vão para o fim da fila
      const picked = async (round: number) =>
        (
          await (payments.query.mock.results[round].value as Promise<
            Array<{ id: string }>
          >)
        )
          .map((row) => Number(row.id))
          .filter((id) => id >= 800_000);
      const first = await picked(0);
      expect(first).toHaveLength(RECONCILE_PER_STORE);
      jest.setSystemTime(new Date('2026-10-11T12:01:00Z'));
      await service.reconcile();
      const second = await picked(1);
      expect(second).toHaveLength(RECONCILE_PER_STORE);
      expect(second.filter((id) => first.includes(id))).toEqual([]);
    });

    it('conciliação: aprovado sem pedido entra na rodada antes dos pendentes, mesmo com a fila cheia de outras lojas', async () => {
      const { service, payments, orders, tenantA } = setup();
      // Falha passageira ao gravar o pedido: aprovado e sem pedido (o mais novo de todos)
      orders.save.mockRejectedValueOnce(new Error('conexão perdida'));
      const card = await service.createCardPayment(cardDto, client, tenantA);
      expect(card.orderId).toBeUndefined();
      // 6 lojas com 10 pendentes antigos cada (60 > 50 da rodada)
      const old = Date.now() - 3_600_000;
      for (let store = 0; store < 6; store++)
        for (let i = 0; i < 10; i++) {
          const id = 810_000 + store * 100 + i;
          payments.rows.set(
            id,
            stuckPayment(id, 11 + store, new Date(old + i * 1000)),
          );
        }

      await expect(service.reconcile()).resolves.toEqual({ finalized: 1 });
      expect(orders.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ payment_id: card.id, store_id: STORE_A }),
      );
      const selected = (await (payments.query.mock.results[0].value as Promise<
        Array<{ id: string }>
      >)) as Array<{ id: string }>;
      expect(selected[0]).toEqual({ id: String(card.id) });
      expect(selected).toHaveLength(RECONCILE_BATCH);
    });

    it('limite de cobranças por cliente na loja (PAYMENT_CREATE) e por IP (PAYMENT_CREATE_IP) → 429; repetir a mesma chave não conta', async () => {
      process.env.RATE_LIMIT_PAYMENT_CREATE = '2/600';
      process.env.RATE_LIMIT_PAYMENT_CREATE_IP = '4/600';
      const { service, payments, tenantA, tenantB } = setup();
      const ip = '203.0.113.1';

      await service.createPixPayment(
        pixOf(1, 'chave-0001'),
        client,
        tenantA,
        ip,
      );
      // A mesma tentativa repetida devolve o mesmo pagamento e não gasta a cota
      await service.createPixPayment(
        pixOf(1, 'chave-0001'),
        client,
        tenantA,
        ip,
      );
      await service.createPixPayment(pixOf(2), client, tenantA, ip);
      for (const attempt of [
        () => service.createPixPayment(pixOf(3), client, tenantA, ip),
        () => service.createCardPayment(cardDto, client, tenantA, ip),
      ]) {
        await expect(attempt()).rejects.toMatchObject({ status: 429 });
      }
      expect(payments.insert).toHaveBeenCalledTimes(2);

      // Por cliente E loja: o mesmo cliente compra em outra loja
      await service.createPixPayment(pixOf(3), client, tenantB, ip);
      // Por IP (todas as lojas e clientes): a 4ª cobrança do IP passa, a 5ª não
      await service.createPixPayment(pixOf(4), otherClient, tenantA, ip);
      await expect(
        service.createPixPayment(
          pixOf(5),
          user(9, UserRole.CLIENT),
          tenantA,
          ip,
        ),
      ).rejects.toMatchObject({ status: 429 });
      // Outro IP, outro cliente: liberado
      await service.createPixPayment(
        pixOf(5),
        user(9, UserRole.CLIENT),
        tenantA,
        '203.0.113.2',
      );
      expect(payments.insert).toHaveBeenCalledTimes(5);
    });

    it('teto de cobranças pendentes por cliente na loja → 429 (canceladas e vencidas não contam)', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, payments, tenantA } = setup(production);
      const mp = fakeMercadoPago(service, {
        createPayment: pixSequence(4101),
        getPayment: jest.fn((id: number) =>
          Promise.resolve({ id, status: 'pending' }),
        ),
        cancelPayment: jest.fn((id: number) =>
          Promise.resolve({ id, status: 'cancelled' }),
        ),
      });
      for (let quantity = 1; quantity <= 5; quantity++)
        await service.createPixPayment(pixOf(quantity), client, tenantA);
      await expect(
        service.createPixPayment(pixOf(6), client, tenantA),
      ).rejects.toMatchObject({
        status: 429,
        response: expect.objectContaining({
          message: TOO_MANY_PENDING_CHARGES_MESSAGE,
        }) as unknown,
      });
      expect(mp.createPayment).toHaveBeenCalledTimes(5);

      // Outro cliente na mesma loja não é afetado
      await service.createPixPayment(pixOf(6), otherClient, tenantA);
      // Desistir de um libera a vaga
      await service.cancelFor(4101, client);
      await service.createPixPayment(pixOf(6), client, tenantA);
      await expect(
        service.createPixPayment(pixOf(7), client, tenantA),
      ).rejects.toMatchObject({ status: 429 });
      // PIX vencido não segura vaga
      jest.setSystemTime(new Date('2026-10-11T12:31:00Z'));
      await service.createPixPayment(pixOf(7), client, tenantA);
      expect(payments.rows.size).toBe(8);
    });

    it('o mesmo carrinho com PIX pendente devolve o mesmo PIX; outro carrinho, outro cliente, outro valor ou prazo curto geram outro', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, pricing, tenantA } = setup(production);
      const mp = fakeMercadoPago(service, {
        createPayment: pixSequence(4201),
      });
      const first = await service.createPixPayment(
        pixOf(2, 'chave-aaa1'),
        client,
        tenantA,
      );
      const again = await service.createPixPayment(
        pixOf(2, 'chave-aaa2'),
        client,
        tenantA,
      );
      expect(again).toEqual(first);
      expect(mp.createPayment).toHaveBeenCalledTimes(1);

      const create = async (dto: CreatePixPaymentDto, actor = client) =>
        (await service.createPixPayment(dto, actor, tenantA)).id;
      expect(await create(pixOf(3))).not.toBe(first.id);
      expect(await create(pixOf(2), otherClient)).not.toBe(first.id);
      // O preço mudou: o valor do PIX pendente não é mais o do carrinho
      pricing.price.mockResolvedValueOnce(priced(50));
      const repriced = await service.createPixPayment(
        pixOf(2),
        client,
        tenantA,
      );
      expect(repriced.id).not.toBe(first.id);
      expect(repriced.amount).toBe(50);
      // Faltando menos de 5 minutos para vencer, gera outro
      jest.setSystemTime(new Date('2026-10-11T12:26:00Z'));
      expect(await create(pixOf(2))).not.toBe(first.id);
      expect(mp.createPayment).toHaveBeenCalledTimes(5);
    });

    it('sandbox: PIX simulado já no prazo da aprovação automática não é reaproveitado (conta como pago)', async () => {
      const { service, tenantA } = setup();
      const first = await service.createPixPayment(pixDto, client, tenantA);
      expect((await service.createPixPayment(pixDto, client, tenantA)).id).toBe(
        first.id,
      );
      fakeClock(new Date(Date.now() + 6_000).toISOString());
      expect(
        (await service.createPixPayment(pixDto, client, tenantA)).id,
      ).not.toBe(first.id);
    });

    it('limite do mês conta os pagamentos online em andamento (aprovados sem pedido da loja e PIX pendentes do próprio cliente)', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, planLimits, payments, tenantA } = setup(production);
      fakeMercadoPago(service, { createPayment: pixSequence(4301) });
      await service.createPixPayment(pixOf(1), client, tenantA);
      await service.createPixPayment(pixOf(2), otherClient, tenantA);
      await service.createPixPayment(
        pixOf(3),
        user(9, UserRole.CLIENT),
        tenantA,
      );
      (payments.rows.get(4302) as Payment).status = 'approved'; // pedido ainda não criado
      (payments.rows.get(4303) as Payment).status = 'cancelled';
      // Da loja: só o aprovado sem pedido; do cliente: + o PIX pendente dele
      expect(await service.reservedOrderSlots(STORE_A)).toBe(1);
      expect(await service.reservedOrderSlots(STORE_A, client.id)).toBe(2);

      planLimits.assertWithinLimit.mockClear();
      await service.createPixPayment(pixOf(4), client, tenantA);
      expect(planLimits.assertWithinLimit).toHaveBeenCalledWith(
        STORE_A,
        'monthly_orders',
        3,
      );
      // No limite: a cobrança é recusada antes do Mercado Pago (mensagem para o cliente)
      planLimits.assertWithinLimit.mockRejectedValueOnce(
        new ForbiddenException('Limite do plano Essencial atingido.'),
      );
      await expect(
        service.createPixPayment(pixOf(5), client, tenantA),
      ).rejects.toThrow(new ForbiddenException(MONTHLY_ORDERS_LIMIT_MESSAGE));
      // Vencidos não reservam vaga
      jest.setSystemTime(new Date('2026-10-11T12:31:00Z'));
      expect(await service.reservedOrderSlots(STORE_A, client.id)).toBe(1);
    });

    it('PIX pendentes de outros clientes não reservam vaga: contas descartáveis não bloqueiam as vendas da loja', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, planLimits, payments, tenantA } = setup(production);
      fakeMercadoPago(service, { createPayment: pixSequence(4401) });
      // "Atacante": várias contas, cada uma com o teto de PIX pendentes na loja (nunca pagos)
      for (const id of [21, 22, 23]) {
        for (let quantity = 1; quantity <= 5; quantity++) {
          await service.createPixPayment(
            pixOf(quantity),
            user(id, UserRole.CLIENT),
            tenantA,
          );
        }
      }
      expect(await service.reservedOrderSlots(STORE_A)).toBe(0);
      expect(await service.reservedOrderSlots(STORE_A, client.id)).toBe(0);

      // O cliente legítimo cobra com a vaga de 1 pedido (nenhuma reserva dos outros)
      planLimits.assertWithinLimit.mockClear();
      const mine = await service.createPixPayment(pixOf(1), client, tenantA);
      expect(planLimits.assertWithinLimit).toHaveBeenCalledWith(
        STORE_A,
        'monthly_orders',
        1,
      );

      // Continuam reservando: os PIX do próprio cliente, os cartões em análise e os aprovados sem pedido
      expect(await service.reservedOrderSlots(STORE_A, client.id)).toBe(1);
      Object.assign(payments.rows.get(4401) as Payment, {
        method: 'CARD',
        status: 'in_process',
        expires_at: null,
      });
      Object.assign(payments.rows.get(4402) as Payment, { status: 'approved' });
      expect(await service.reservedOrderSlots(STORE_A)).toBe(2);
      expect(await service.reservedOrderSlots(STORE_A, client.id)).toBe(3);
      expect(mine.id).toBe(4416);
    });

    it('polling (GET /payment/status): no máximo uma consulta ao Mercado Pago por pagamento a cada STATUS_POLL_RECHECK_MS', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, tenantA } = setup(production);
      const mp = fakeMercadoPago(service, {
        createPayment: pendingPix(4501),
        getPayment: jest
          .fn()
          .mockResolvedValue({ id: 4501, status: 'pending' }),
      });
      await service.createPixPayment(pixDto, client, tenantA);
      for (let i = 0; i < 20; i++) {
        expect((await service.getStatusFor(4501, client)).status).toBe(
          'pending',
        );
      }
      expect(mp.getPayment).toHaveBeenCalledTimes(1);

      // Depois do intervalo, consulta de novo (e o resultado novo vale)
      jest.setSystemTime(Date.now() + STATUS_POLL_RECHECK_MS);
      mp.getPayment.mockResolvedValue({
        id: 4501,
        status: 'approved',
        transaction_amount: 45.9,
      });
      const approved = await service.getStatusFor(4501, client);
      expect(approved.status).toBe('approved');
      expect(approved.orderId).toEqual(expect.any(Number));
      expect(mp.getPayment).toHaveBeenCalledTimes(2);
    });

    it('polling não atrasa o webhook: a notificação reconsulta mesmo logo depois de uma consulta do cliente', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, orders, tenantA } = setup(production);
      const mp = fakeMercadoPago(service, {
        createPayment: pendingPix(4511),
        getPayment: jest
          .fn()
          .mockResolvedValue({ id: 4511, status: 'pending' }),
      });
      await service.createPixPayment(pixDto, client, tenantA);
      await service.getStatusFor(4511, client);
      mp.getPayment.mockResolvedValue({
        id: 4511,
        status: 'approved',
        transaction_amount: 45.9,
      });
      service.handleNotification({ data: { id: '4511' } }, {});
      for (let i = 0; i < 5; i++) await flush();
      expect(mp.getPayment).toHaveBeenCalledTimes(2);
      expect(orders.save).toHaveBeenCalledTimes(1);
      // O cliente vê o pedido na consulta seguinte (do banco, sem nova consulta ao Mercado Pago)
      expect((await service.getStatusFor(4511, client)).orderId).toEqual(
        expect.any(Number),
      );
      expect(mp.getPayment).toHaveBeenCalledTimes(2);
      service.onModuleDestroy();
    });

    it.each(['refunded', 'charged_back', 'cancelled'])(
      'aprovado com pedido e depois %s no Mercado Pago: o webhook reconsulta, o pedido vira REFUNDED e a auditoria registra',
      async (reversal) => {
        fakeClock('2026-10-11T12:00:00Z');
        const { service, orders, payments, audit, tenantA } = setup(production);
        const mp = fakeMercadoPago(service, {
          createPayment: approvedCard(4521),
          getPayment: jest.fn(),
        });
        const card = await service.createCardPayment(cardDto, client, tenantA);
        const orderId = payments.rows.get(4521)?.order_id as number;
        expect(card.orderId).toBe(orderId);
        expect(orders.rows.get(orderId)?.payment_status).toBe(
          PaymentStatus.PAID,
        );

        // Estorno feito no painel do Mercado Pago (ou contestação): a notificação chega
        mp.getPayment.mockResolvedValue({
          id: 4521,
          status: reversal,
          status_detail: reversal,
          transaction_amount: 45.9,
        });
        service.handleNotification({ data: { id: '4521' } }, {});
        for (let i = 0; i < 5; i++) await flush();

        expect(mp.getPayment).toHaveBeenCalledWith(4521);
        expect(payments.rows.get(4521)?.status).toBe(reversal);
        expect(orders.rows.get(orderId)?.payment_status).toBe(
          PaymentStatus.REFUNDED,
        );
        const entry = audit.record.mock.calls
          .map(([item]) => item as Record<string, unknown>)
          .find((item) => item.action === 'payment.reversed');
        expect(entry).toMatchObject({
          scope: 'SYSTEM',
          storeId: STORE_A,
          targetType: 'payment',
          targetId: 4521,
          metadata: { status: reversal, order_id: orderId },
        });
        // O polling do aprovado continua sem consultar (status final no banco)
        mp.getPayment.mockClear();
        await service.getStatusFor(4521, client);
        expect(mp.getPayment).not.toHaveBeenCalled();
        service.onModuleDestroy();
      },
    );

    it('webhook de um aprovado que continua aprovado: nada muda no pedido nem na auditoria', async () => {
      const { service, orders, payments, audit, tenantA } = setup(production);
      const mp = fakeMercadoPago(service, {
        createPayment: approvedCard(4531),
        getPayment: approvedCard(4531),
      });
      await service.createCardPayment(cardDto, client, tenantA);
      const orderId = payments.rows.get(4531)?.order_id as number;
      const audits = audit.record.mock.calls.length;
      service.handleNotification({ data: { id: '4531' } }, {});
      for (let i = 0; i < 5; i++) await flush();
      expect(mp.getPayment).toHaveBeenCalledTimes(1);
      expect(orders.rows.get(orderId)?.payment_status).toBe(PaymentStatus.PAID);
      expect(orders.save).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledTimes(audits);
      service.onModuleDestroy();
    });

    it('PIX com prazo maior que a janela padrão (PIX_EXPIRATION_MINUTES=7 dias) pago no 5º dia ainda vira pedido pela conciliação', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, orders, payments, tenantA } = setup({
        ...production,
        PIX_EXPIRATION_MINUTES: String(7 * 24 * 60),
      });
      const mp = fakeMercadoPago(service, {
        createPayment: pendingPix(4541),
        getPayment: jest
          .fn()
          .mockResolvedValue({ id: 4541, status: 'pending' }),
      });
      await service.createPixPayment(pixDto, client, tenantA);

      jest.setSystemTime(new Date('2026-10-16T12:00:00Z'));
      mp.getPayment.mockResolvedValue({
        id: 4541,
        status: 'approved',
        transaction_amount: 45.9,
      });
      expect(await service.reconcile()).toEqual({ finalized: 1 });
      expect(orders.save).toHaveBeenCalledTimes(1);
      expect(payments.rows.get(4541)?.order_id).toEqual(expect.any(Number));
    });

    it('POST /orders com paymentId desconhecido: cada consulta ao Mercado Pago conta no limite do cliente na loja', async () => {
      process.env.RATE_LIMIT_PAYMENT_CREATE = '2/600';
      const { service, tenantA } = setup(production);
      const mp = fakeMercadoPago(service, {
        getPayment: jest.fn().mockRejectedValue(new Error('not found')),
      });
      for (const id of [7001, 7002]) {
        await expect(
          service.orderIdForPayment(orderDto(id), client, tenantA),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      await expect(
        service.orderIdForPayment(orderDto(7003), client, tenantA),
      ).rejects.toMatchObject({ status: 429 });
      expect(mp.getPayment).toHaveBeenCalledTimes(2);
      // Outro cliente tem a própria cota
      await expect(
        service.orderIdForPayment(orderDto(7004), otherClient, tenantA),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('webhook: limite por IP (PAYMENT_WEBHOOK → 429) antes de qualquer acesso ao banco', async () => {
      process.env.RATE_LIMIT_PAYMENT_WEBHOOK = '3/60';
      const { service, payments } = setup(production);
      const notify = (id: number, ip: string) =>
        service.handleNotification({ data: { id: String(id) } }, {}, ip);
      for (let i = 0; i < 3; i++) notify(9000 + i, '198.51.100.1');
      let refused: unknown = null;
      try {
        notify(9100, '198.51.100.1');
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(HttpException);
      expect((refused as HttpException).getStatus()).toBe(429);
      // Outro IP continua sendo atendido
      notify(9101, '198.51.100.2');
      for (let i = 0; i < 5; i++) await flush();
      expect(payments.findOne).toHaveBeenCalledTimes(4);
    });

    it('webhook: notificações repetidas do mesmo pagamento viram uma reconsulta por intervalo (e uma adiada no fim dele)', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, orders, tenantA } = setup(production);
      const mp = fakeMercadoPago(service, {
        createPayment: pendingPix(9201),
        getPayment: jest
          .fn()
          .mockResolvedValue({ id: 9201, status: 'pending' }),
      });
      await service.createPixPayment(pixDto, client, tenantA);

      for (let i = 0; i < 50; i++)
        service.handleNotification({ data: { id: '9201' } }, {}, `10.0.0.${i}`);
      for (let i = 0; i < 5; i++) await flush();
      expect(mp.getPayment).toHaveBeenCalledTimes(1);

      // Pago: a reconsulta adiada (no fim do intervalo) cria o pedido — nenhuma notificação se perde
      mp.getPayment.mockResolvedValue({
        id: 9201,
        status: 'approved',
        transaction_amount: 45.9,
      });
      await jest.advanceTimersByTimeAsync(NOTIFICATION_RECHECK_MS);
      for (let i = 0; i < 5; i++) await flush();
      expect(mp.getPayment).toHaveBeenCalledTimes(2);
      expect(orders.save).toHaveBeenCalledTimes(1);
      service.onModuleDestroy();
    });

    it('webhook: notificações processadas com concorrência limitada; com a fila cheia são descartadas (a conciliação cobre)', async () => {
      const { service, payments } = setup(production);
      const waiting: Array<() => void> = [];
      payments.findOne.mockImplementation(
        () => new Promise((resolve) => waiting.push(() => resolve(null))),
      );
      const total = NOTIFICATION_CONCURRENCY + NOTIFICATION_QUEUE_LIMIT + 5;
      for (let i = 0; i < total; i++)
        service.handleNotification({ data: { id: String(10_000 + i) } }, {});
      expect(payments.findOne).toHaveBeenCalledTimes(NOTIFICATION_CONCURRENCY);

      while (waiting.length) {
        (waiting.shift() as () => void)();
        await flush();
      }
      expect(payments.findOne).toHaveBeenCalledTimes(
        NOTIFICATION_CONCURRENCY + NOTIFICATION_QUEUE_LIMIT,
      );
    });

    it('consultas simultâneas do mesmo pagamento (status, webhook e conciliação) dividem uma consulta ao Mercado Pago', async () => {
      const { service, tenantA } = setup(production);
      let answer: (value: unknown) => void = () => undefined;
      const mp = fakeMercadoPago(service, {
        createPayment: pendingPix(9301),
        getPayment: jest.fn(() => new Promise((resolve) => (answer = resolve))),
      });
      await service.createPixPayment(pixDto, client, tenantA);
      const status = service.getStatusFor(9301, client);
      service.handleNotification({ data: { id: '9301' } }, {});
      const round = service.reconcile();
      for (let i = 0; i < 5; i++) await flush();
      answer({ id: 9301, status: 'pending' });
      await Promise.all([status, round]);
      for (let i = 0; i < 5; i++) await flush();
      expect(mp.getPayment).toHaveBeenCalledTimes(1);
    });
  });
});
