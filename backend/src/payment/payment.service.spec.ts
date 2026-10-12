import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { FindOperator, QueryFailedError, type Repository } from 'typeorm';
import type { Order } from '../orders/entities/order.entity';
import type {
  OrderPricingService,
  PricedOrder,
} from '../orders/order-pricing.service';
import { OrderStatus, OrderType, PaymentStatus } from '../orders/order.enums';
import type { CreateOrderDto } from '../orders/dto/create-order.dto';
import type {
  CreateCardPaymentDto,
  CreatePixPaymentDto,
} from './dto/create-payment.dto';
import type { Payment } from './entities/payment.entity';
import type { PaymentGateway } from './mercado-pago.gateway';
import { PaymentService } from './payment.service';

const client = {
  id: 7,
  role: 'CLIENT',
  email: 'cliente@exemplo.com',
  name: 'Maria Silva',
};
const otherClient = {
  id: 8,
  role: 'CLIENT',
  email: 'outro@exemplo.com',
  name: 'João',
};
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

function priced(total: number, storeOpen = true): PricedOrder {
  return {
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

function uniqueViolation() {
  return new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error('duplicate key'), { code: '23505' }),
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
        if (operator.type === 'moreThan') return true;
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

/** Tabela "payments" em memória (INSERT nunca sobrescreve; chave única por cliente). */
function fakePaymentRepository() {
  const rows = new Map<number, Payment>();
  const repo = {
    rows,
    create: jest.fn((data: Partial<Payment>) => ({ ...data }) as Payment),
    insert: jest.fn((entity: Payment) => {
      const duplicateKey =
        !!entity.idempotency_key &&
        [...rows.values()].some(
          (row) =>
            row.user_id === entity.user_id &&
            row.idempotency_key === entity.idempotency_key,
        );
      if (rows.has(entity.id) || duplicateKey)
        return Promise.reject(uniqueViolation());
      rows.set(entity.id, { ...entity, created_at: new Date() } as Payment);
      return Promise.resolve({});
    }),
    findOne: jest.fn(({ where }: { where: object }) => {
      const row = [...rows.values()].find((item) =>
        matches(item as unknown as Record<string, unknown>, where),
      );
      return Promise.resolve(row ? { ...row } : null);
    }),
    find: jest.fn(({ where }: { where: object[] }) =>
      Promise.resolve(
        [...rows.values()]
          .filter((row) =>
            where.some((condition) =>
              matches(row as unknown as Record<string, unknown>, condition),
            ),
          )
          .map((row) => ({ ...row })),
      ),
    ),
    update: jest.fn((criteria: object, changes: Partial<Payment>) => {
      for (const row of rows.values()) {
        if (matches(row as unknown as Record<string, unknown>, criteria))
          Object.assign(row, changes);
      }
      return Promise.resolve({ affected: 1 });
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
    manager: {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: client.id, name: client.name }),
      exists: jest.fn().mockResolvedValue(true),
    },
  };
}

function setup(
  env: Record<string, string | undefined> = {},
  total = 45.9,
  storeOpen = true,
) {
  const pricing = {
    price: jest.fn().mockResolvedValue(priced(total, storeOpen)),
    existingReferences: jest.fn().mockResolvedValue({
      productIds: new Set([1]),
      addonIds: new Set<number>(),
      addressExists: false,
    }),
  };
  const payments = fakePaymentRepository();
  const orders = fakeOrderRepository();
  const config = {
    get: (key: string) => ({ NODE_ENV: 'test', ...env })[key],
  };
  const service = new PaymentService(
    pricing as unknown as OrderPricingService,
    payments as unknown as Repository<Payment>,
    orders as unknown as Repository<Order>,
    config as unknown as ConfigService,
  );
  return { service, pricing, payments, orders };
}

/** Substitui o Mercado Pago por um dublê (nenhuma chamada de rede nos testes). */
function fakeMercadoPago(
  service: PaymentService,
  impl: Partial<Record<keyof PaymentGateway, jest.Mock>>,
) {
  const fake = {
    createPayment: impl.createPayment ?? jest.fn(),
    getPayment: impl.getPayment ?? jest.fn(),
    cancelPayment: impl.cancelPayment ?? jest.fn(),
    refundPayment: impl.refundPayment ?? jest.fn(),
  };
  (service as unknown as { gateway: unknown }).gateway = fake;
  return fake;
}

/** Corpo e chave de idempotência enviados ao Mercado Pago na chamada N de createPayment. */
type SentBody = {
  transaction_amount: number;
  description: string;
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

describe('PaymentService', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });
  afterEach(() => jest.useRealTimers());

  describe('sandbox sem credenciais', () => {
    it('cartão: aprova por simulação, cobra o total do servidor e o pedido já nasce (orderId)', async () => {
      const { service, pricing, orders, payments } = setup();
      const result = await service.createCardPayment(cardDto, client);

      expect(pricing.price).toHaveBeenCalledWith(order, client.id);
      expect(result).toMatchObject({
        status: 'approved',
        amount: 45.9,
        simulation: true,
      });
      expect(result.orderId).toEqual(expect.any(Number));

      expect(orders.save).toHaveBeenCalledTimes(1);
      expect(orders.save.mock.calls[0][0]).toMatchObject({
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
        order_id: result.orderId,
        status: 'approved',
        simulated: true,
      });
    });

    it('não cobra quando a loja está fechada (400 antes de qualquer pagamento)', async () => {
      const { service, payments } = setup({}, 45.9, false);
      await expect(service.createCardPayment(cardDto, client)).rejects.toThrow(
        'A loja está fechada no momento.',
      );
      await expect(
        service.createPixPayment(pixDto, client),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(payments.insert).not.toHaveBeenCalled();
    });

    it('PIX: vence em PIX_EXPIRATION_MINUTES e é aprovado depois de PIX_SANDBOX_APPROVAL_SECONDS (o status traz orderId)', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, orders } = setup({ PIX_SANDBOX_APPROVAL_SECONDS: '5' });

      const pix = await service.createPixPayment(pixDto, client);
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
        payment_method: 'PIX',
        payment_id: pix.id,
        payment_status: PaymentStatus.PAID,
      });
    });

    it('PIX cancelado pelo cliente nunca vira pedido (nem pela conciliação)', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, orders } = setup();
      const pix = await service.createPixPayment(pixDto, client);

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
      const { service, orders } = setup();
      const pix = await service.createPixPayment(pixDto, client);

      jest.setSystemTime(new Date('2026-10-11T12:00:10Z'));
      await expect(service.cancelFor(pix.id, client)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(orders.save).toHaveBeenCalledTimes(1);
    });

    it('somente o pagador cancela (outro cliente e equipe → 403); inexistente → 404', async () => {
      const { service } = setup();
      const pix = await service.createPixPayment(pixDto, client);
      await expect(
        service.cancelFor(pix.id, otherClient),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.cancelFor(pix.id, { id: 1, role: 'ADMIN' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.cancelFor(42, client)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('criação do pedido pelo servidor (finalize)', () => {
    it('status, webhook e conciliação ao mesmo tempo criam um único pedido', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, orders } = setup();
      const pix = await service.createPixPayment(pixDto, client);
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

    it('pedido criado por outra instância (índice único em payment_id) é reaproveitado', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, orders } = setup();
      const pix = await service.createPixPayment(pixDto, client);
      jest.setSystemTime(new Date('2026-10-11T12:00:10Z'));

      // Outra instância grava o pedido entre a nossa leitura e o nosso INSERT
      orders.save.mockImplementationOnce(() => {
        orders.rows.set(900, { id: 900, payment_id: pix.id });
        return Promise.reject(uniqueViolation());
      });
      const status = await service.getStatusFor(pix.id, client);
      expect(status.orderId).toBe(900);
    });

    it('usa o retrato da hora do pagamento mesmo se a loja fechou e os preços mudaram', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, pricing, orders } = setup();
      const pix = await service.createPixPayment(pixDto, client);

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
      const { service, orders, payments } = setup({
        MP_ACCESS_TOKEN: 'TEST-abc',
      });
      fakeMercadoPago(service, {
        createPayment: jest.fn().mockResolvedValue({
          id: 4321,
          status: 'approved',
          status_detail: 'accredited',
          transaction_amount: 75, // pedido de 45,90
        }),
      });

      const result = await service.createCardPayment(cardDto, client);
      expect(result.orderId).toBeUndefined();
      expect(orders.save).not.toHaveBeenCalled();
      expect(payments.rows.get(4321)).toMatchObject({
        status: 'refunded',
        order_id: null,
      });
      expect(payments.rows.get(4321)?.finalize_error).toContain('estornado');

      await expect(
        service.orderIdForPayment(orderDto(4321), client),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('falha passageira ao gravar o pedido: o pagamento continua aprovado e a conciliação cria depois', async () => {
      const { service, orders, payments } = setup();
      orders.save.mockRejectedValueOnce(new Error('conexão perdida'));

      const result = await service.createCardPayment(cardDto, client);
      expect(result).toMatchObject({ status: 'approved' });
      expect(result.orderId).toBeUndefined();

      await service.reconcile();
      expect(orders.save).toHaveBeenCalledTimes(2);
      expect(payments.rows.get(result.id)?.order_id).toEqual(
        expect.any(Number),
      );
    });
  });

  describe('idempotencyKey', () => {
    it('a mesma chave do mesmo cliente devolve o mesmo pagamento, cobra uma vez e é repassada ao Mercado Pago', async () => {
      const { service } = setup(production);
      const mp = fakeMercadoPago(service, {
        createPayment: jest.fn().mockResolvedValue({
          id: 777,
          status: 'approved',
          status_detail: 'accredited',
          transaction_amount: 45.9,
        }),
      });

      const dto = withKey(cardDto, 'tentativa-0001');
      const first = await service.createCardPayment(dto, client);
      const retry = await service.createCardPayment(dto, client);

      expect(mp.createPayment).toHaveBeenCalledTimes(1);
      expect(sent(mp.createPayment).key).toBe('tentativa-0001');
      expect(retry).toEqual(first);
      expect(first.orderId).toEqual(expect.any(Number));
    });

    it('requisições simultâneas com a mesma chave cobram uma vez só', async () => {
      const { service } = setup(production);
      let resolveCharge: (value: unknown) => void = () => undefined;
      const mp = fakeMercadoPago(service, {
        createPayment: jest.fn(
          () => new Promise((resolve) => (resolveCharge = resolve)),
        ),
      });

      const dto = withKey(cardDto, 'tentativa-0002');
      const both = Promise.all([
        service.createCardPayment(dto, client),
        service.createCardPayment(dto, client),
      ]);
      await flush();
      resolveCharge({ id: 778, status: 'approved', transaction_amount: 45.9 });
      const [a, b] = await both;

      expect(mp.createPayment).toHaveBeenCalledTimes(1);
      expect(a.id).toBe(778);
      expect(b.id).toBe(778);
    });

    it('a mesma chave em clientes diferentes são pagamentos diferentes; sem chave, cada chamada cobra', async () => {
      const { service } = setup();
      const dto = withKey(cardDto, 'tentativa-0003');
      const mine = await service.createCardPayment(dto, client);
      const theirs = await service.createCardPayment(dto, otherClient);
      expect(theirs.id).not.toBe(mine.id);

      const a = await service.createCardPayment(cardDto, client);
      const b = await service.createCardPayment(cardDto, client);
      expect(a.id).not.toBe(b.id);
    });

    it('PIX repetido com a mesma chave devolve o mesmo QR; chave de PIX não serve para cartão (400)', async () => {
      const { service, payments } = setup();
      const dto = withKey(pixDto, 'tentativa-0004');
      const first = await service.createPixPayment(dto, client);
      const again = await service.createPixPayment(dto, client);
      expect(again).toEqual(first);
      expect(payments.insert).toHaveBeenCalledTimes(1);

      await expect(
        service.createCardPayment(withKey(cardDto, 'tentativa-0004'), client),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('POST /orders com paymentId (orderIdForPayment)', () => {
    it('devolve o pedido já criado para o mesmo cliente (idempotente)', async () => {
      const { service, orders } = setup();
      const payment = await service.createCardPayment(cardDto, client);

      await expect(
        service.orderIdForPayment(orderDto(payment.id), client),
      ).resolves.toBe(payment.orderId);
      await expect(
        service.orderIdForPayment(orderDto(payment.id, 'DEBIT_CARD'), client),
      ).resolves.toBe(payment.orderId);
      expect(orders.save).toHaveBeenCalledTimes(1);
    });

    it('recusa pagamento desconhecido, de outro cliente ou de outra forma (400)', async () => {
      const { service } = setup();
      const payment = await service.createCardPayment(cardDto, client);

      await expect(
        service.orderIdForPayment(orderDto(123), client),
      ).rejects.toThrow('não encontrado');
      await expect(
        service.orderIdForPayment(orderDto(payment.id), otherClient),
      ).rejects.toThrow('outro usuário');
      await expect(
        service.orderIdForPayment(orderDto(payment.id, 'PIX'), client),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.orderIdForPayment(orderDto(payment.id, 'MONEY'), client),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('PIX pendente → 400 "ainda não foi aprovado"; depois de aprovado devolve o pedido', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, orders } = setup();
      const pix = await service.createPixPayment(pixDto, client);

      await expect(
        service.orderIdForPayment(orderDto(pix.id, 'PIX'), client),
      ).rejects.toThrow('ainda não foi aprovado');
      expect(orders.save).not.toHaveBeenCalled();

      jest.setSystemTime(new Date('2026-10-11T12:00:10Z'));
      const orderId = await service.orderIdForPayment(
        orderDto(pix.id, 'PIX'),
        client,
      );
      expect(orders.rows.get(orderId)).toMatchObject({ payment_id: pix.id });
    });

    it('pagamento de pedido cancelado não é reaproveitado (400)', async () => {
      const { service, orders } = setup();
      const payment = await service.createCardPayment(cardDto, client);
      orders.rows.get(payment.orderId as number)!.status = OrderStatus.CANCELED;

      await expect(
        service.orderIdForPayment(orderDto(payment.id), client),
      ).rejects.toThrow('cancelado');
    });
  });

  describe('estorno', () => {
    it('sandbox: estorno simulado (sem Mercado Pago) e o pagamento fica "refunded"', async () => {
      const { service, payments } = setup({ MP_ACCESS_TOKEN: 'TEST-abc' });
      const mp = fakeMercadoPago(service, {
        createPayment: jest.fn().mockRejectedValue(new Error('offline')),
      });
      const payment = await service.createCardPayment(cardDto, client);

      await expect(service.refund(payment.id)).resolves.toBe(true);
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

      await expect(service.refund(111)).resolves.toBe(true);
      expect(mp.refundPayment).toHaveBeenCalledWith(111, 'refund-111');
      await expect(service.refund(222)).resolves.toBe(false);
      // Já estornado pelo painel do Mercado Pago
      await expect(service.refund(333)).resolves.toBe(true);
    });

    it('produção sem credenciais: estorno fica pendente; pagamento simulado é estornado por simulação', async () => {
      const { service } = setup({ NODE_ENV: 'production' });
      await expect(service.refund(123456)).resolves.toBe(false);
      await expect(service.refund(900_000_000_000_123)).resolves.toBe(true);
    });
  });

  describe('GET /payment/status/:id', () => {
    it('somente o pagador ou a equipe; id desconhecido → 404', async () => {
      const { service } = setup();
      const pix = await service.createPixPayment(pixDto, client);

      await expect(
        service.getStatusFor(pix.id, otherClient),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.getStatusFor(pix.id, { id: 1, role: 'EMPLOYEE' }),
      ).resolves.toMatchObject({ id: pix.id });
      await expect(service.getStatusFor(42, client)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('sandbox com Mercado Pago', () => {
    it('cartão recusado pelo sandbox vira aprovação simulada', async () => {
      const { service } = setup({ MP_ACCESS_TOKEN: 'TEST-abc' });
      fakeMercadoPago(service, {
        createPayment: jest.fn().mockResolvedValue({
          id: 555,
          status: 'rejected',
          status_detail: 'cc_rejected_other_reason',
        }),
      });
      const result = await service.createCardPayment(cardDto, client);
      expect(result).toMatchObject({
        status: 'approved',
        simulation: true,
        amount: 45.9,
      });
      expect(result.id).not.toBe(555);
    });

    it('envia o valor do servidor, a descrição com a marca e uma chave de idempotência', async () => {
      const { service } = setup({ MP_ACCESS_TOKEN: 'TEST-abc' });
      const mp = fakeMercadoPago(service, {
        createPayment: jest.fn().mockResolvedValue({
          id: 777,
          status: 'approved',
          status_detail: 'accredited',
          transaction_amount: 45.9,
        }),
      });

      const result = await service.createCardPayment(cardDto, client);
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
      expect(body.description).toMatch(/^Pedido /);
      expect(body.payer.identification).toEqual({
        type: 'CPF',
        number: '12345678909',
      });
      // Sem chave do app: o servidor gera uma por tentativa (nunca reaproveita a anterior)
      expect(key).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('PIX usa o nome do usuário logado como pagador e vence em 30 minutos', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service } = setup({ MP_ACCESS_TOKEN: 'TEST-abc' });
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
      const pix = await service.createPixPayment(pixDto, client);
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
  });

  describe('produção', () => {
    it('sem credenciais: pagamento online indisponível (503), nunca aprova', async () => {
      const { service } = setup({ NODE_ENV: 'production' });
      await expect(
        service.createCardPayment(cardDto, client),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(
        service.createPixPayment(pixDto, client),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('PAYMENT_SANDBOX=true é ignorado fora de development/test', async () => {
      const { service } = setup({
        NODE_ENV: 'production',
        PAYMENT_SANDBOX: 'true',
      });
      await expect(
        service.createCardPayment(cardDto, client),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('cartão recusado continua recusado e não cria pedido', async () => {
      const { service, orders } = setup(production);
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
      const result = await service.createCardPayment(cardDto, client);
      expect(result).toEqual({
        id: 321,
        status: 'rejected',
        status_detail: 'cc_rejected_insufficient_amount',
        amount: 45.9,
      });
      await expect(
        service.orderIdForPayment(orderDto(321), client),
      ).rejects.toThrow('ainda não foi aprovado');
      expect(orders.save).not.toHaveBeenCalled();
    });

    it('cartão de débito aprovado: o pedido nasce com a forma informada pelo Mercado Pago', async () => {
      const { service, orders } = setup(production);
      fakeMercadoPago(service, {
        createPayment: jest.fn().mockResolvedValue({
          id: 654,
          status: 'approved',
          payment_type_id: 'debit_card',
          transaction_amount: 45.9,
        }),
      });
      const result = await service.createCardPayment(
        { ...cardDto, paymentMethodId: 'debelo' },
        client,
      );
      expect(result.orderId).toEqual(expect.any(Number));
      expect(orders.save.mock.calls[0][0]).toMatchObject({
        payment_method: 'DEBIT_CARD',
        payment_status: PaymentStatus.PAID,
      });
    });

    it('erro do Mercado Pago vira 400 (dados inválidos) ou 502 (indisponível), nunca aprovação', async () => {
      const { service } = setup(production);
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
        service.createCardPayment(cardDto, client),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.createCardPayment(cardDto, client),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });

    it('PIX que o Mercado Pago informa como estornado/recusado não vira pedido', async () => {
      const { service, orders } = setup(production);
      fakeMercadoPago(service, {
        createPayment: jest.fn().mockResolvedValue({
          id: 999,
          status: 'pending',
          point_of_interaction: { transaction_data: { qr_code: '000201' } },
        }),
        getPayment: jest
          .fn()
          .mockResolvedValue({ id: 999, status: 'refunded' }),
      });
      await service.createPixPayment(pixDto, client);

      expect((await service.getStatusFor(999, client)).status).toBe('refunded');
      await expect(
        service.orderIdForPayment(orderDto(999, 'PIX'), client),
      ).rejects.toThrow('refunded');
      expect(orders.save).not.toHaveBeenCalled();
    });

    it('sem resposta do Mercado Pago na conferência → 502 (não confirma às cegas)', async () => {
      const { service } = setup(production);
      fakeMercadoPago(service, {
        createPayment: jest.fn().mockResolvedValue({
          id: 655,
          status: 'pending',
          point_of_interaction: { transaction_data: { qr_code: '000201' } },
        }),
        getPayment: jest.fn().mockRejectedValue(new Error('timeout')),
      });
      await service.createPixPayment(pixDto, client);
      await expect(
        service.orderIdForPayment(orderDto(655, 'PIX'), client),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });

    it('PIX não é aprovado sozinho em produção; o webhook reconsulta e cria o pedido quando pago', async () => {
      fakeClock('2026-10-11T12:00:00Z');
      const { service, orders } = setup(production);
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
      const pix = await service.createPixPayment(pixDto, client);
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
      const { service, orders } = setup(production);
      const mp = fakeMercadoPago(service, {
        createPayment: jest.fn().mockResolvedValue({
          id: 1001,
          status: 'pending',
          point_of_interaction: { transaction_data: { qr_code: '000201' } },
        }),
        getPayment: jest
          .fn()
          .mockResolvedValue({ id: 1001, status: 'pending' }),
        cancelPayment: jest
          .fn()
          .mockResolvedValue({ id: 1001, status: 'cancelled' }),
      });
      await service.createPixPayment(pixDto, client);

      await expect(service.cancelFor(1001, client)).resolves.toEqual({
        id: 1001,
        status: 'cancelled',
      });
      expect(mp.cancelPayment).toHaveBeenCalledWith(1001, 'cancel-1001');
      await service.reconcile();
      expect(orders.save).not.toHaveBeenCalled();
    });
  });
});
