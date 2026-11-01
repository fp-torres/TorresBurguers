import {
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import type { AuthUser } from '../auth/auth-user';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { setupApp } from '../config/app-setup';
import { Store, StoreAccountStatus } from '../store/entities/store.entity';
import { TenantService } from '../tenancy/tenant.service';
import { UserRole } from '../users/entities/user.entity';
import { BillingQueriesService } from './billing-queries.service';
import { BillingWebhookController } from './billing-webhook.controller';
import { BillingWebhookService } from './billing-webhook.service';
import { InvoiceStatus } from './entities/subscription-invoice.entity';
import { SubscriptionStatus } from './entities/subscription.entity';
import { PlansService } from './plans.service';
import { PlatformBillingController } from './platform-billing.controller';
import {
  PublicPlansController,
  StoreSubscriptionController,
} from './store-subscription.controller';
import { SubscriptionsService } from './subscriptions.service';
import {
  storeAdmin,
  SUPER_ADMIN,
} from './testing/billing-fixtures.helper-spec';

const STORES = [
  { id: 7, slug: 'loja-7', account_status: StoreAccountStatus.ACTIVE },
  {
    id: 9,
    slug: 'loja-suspensa',
    account_status: StoreAccountStatus.SUSPENDED,
    status_reason: 'Inadimplência',
  },
  {
    id: 10,
    slug: 'loja-desativada',
    account_status: StoreAccountStatus.INACTIVE,
  },
] as Store[];

const user = (role: UserRole, storeId: number | null): AuthUser => ({
  id: 200 + (storeId ?? 0),
  email: `${role.toLowerCase()}@loja.com`,
  role,
  name: role,
  storeId,
  platformRole: null,
  supportSession: null,
});

const ADMIN_7 = storeAdmin(7);
const EMPLOYEE_7 = user(UserRole.EMPLOYEE, 7);
const CLIENT = user(UserRole.CLIENT, null);
const SUPPORT_7: AuthUser = {
  ...SUPER_ADMIN,
  role: UserRole.ADMIN,
  storeId: 7,
  platformRole: null,
  supportSession: { id: 3, storeId: 7, expiresAt: new Date('2030-01-01') },
};

function userFrom(context: ExecutionContext): AuthUser | null {
  const req = context
    .switchToHttp()
    .getRequest<{ headers: Record<string, string>; user?: unknown }>();
  const header = req.headers['x-test-user'];
  const parsed = header ? (JSON.parse(header) as AuthUser) : null;
  req.user = parsed;
  return parsed;
}

const as = (who: AuthUser) => ({ 'x-test-user': JSON.stringify(who) });

const messageOf = (res: request.Response) =>
  JSON.stringify((res.body as { message?: unknown }).message ?? '');

const INVOICE = {
  id: 31,
  subscription_id: 3,
  store_id: 7,
  plan_id: 2,
  amount: 99.9,
  currency: 'BRL',
  status: InvoiceStatus.PAID,
  period_start: new Date('2026-10-11T12:00:00.000Z'),
  period_end: new Date('2026-11-11T12:00:00.000Z'),
  due_at: new Date('2026-10-11T12:00:00.000Z'),
  paid_at: new Date('2026-10-11T13:00:00.000Z'),
  billing_provider: 'MANUAL',
  provider_payment_id: null,
  payment_method: 'PIX',
  notes: null,
  failure_reason: null,
  attempts: 0,
  created_at: new Date('2026-10-11T12:00:00.000Z'),
  updated_at: new Date('2026-10-11T13:00:00.000Z'),
  // Relação carregada por engano nunca vaza
  store: { mp_access_token_encrypted: 'v1:segredo' },
};

describe('Cobrança (HTTP): /plans, /store/subscription, /platform/*, webhook', () => {
  let app: INestApplication<App>;
  let server: App;

  const plans = {
    listPublic: jest.fn().mockResolvedValue([{ id: 1, code: 'essencial' }]),
    list: jest
      .fn()
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    detail: jest.fn((id: number) => Promise.resolve({ id })),
    create: jest.fn((dto: object) => Promise.resolve({ id: 5, ...dto })),
    update: jest.fn((id: number) => Promise.resolve({ id })),
  };
  const subscriptions = {
    checkoutForStore: jest.fn().mockResolvedValue({
      checkout_url: 'https://www.mercadopago.com.br/checkout',
      provider: 'MERCADO_PAGO',
      provider_status: 'pending',
    }),
    cancelForStore: jest.fn().mockResolvedValue({}),
    resumeForStore: jest.fn().mockResolvedValue({}),
    createForStore: jest.fn().mockResolvedValue({ id: 3 }),
    changePlan: jest.fn().mockResolvedValue({}),
    cancel: jest.fn().mockResolvedValue({}),
    resume: jest.fn().mockResolvedValue({}),
    reactivate: jest.fn().mockResolvedValue({}),
    suspend: jest.fn().mockResolvedValue({}),
    createInvoice: jest.fn().mockResolvedValue(INVOICE),
    markInvoicePaid: jest.fn().mockResolvedValue(INVOICE),
    markInvoiceFailed: jest.fn().mockResolvedValue(INVOICE),
    voidInvoice: jest.fn().mockResolvedValue(INVOICE),
  };
  const queries = {
    storeOverview: jest.fn((tenant: { storeId: number }) =>
      Promise.resolve({ store_id: tenant.storeId }),
    ),
    listSubscriptions: jest
      .fn()
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    subscriptionDetail: jest.fn((id: number) => Promise.resolve({ id })),
    listInvoices: jest
      .fn()
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
  };
  const webhooks = {
    handleMercadoPago: jest.fn().mockResolvedValue('processed'),
  };

  // TenantService REAL sobre repositórios falsos: os guards resolvem a loja como em produção
  const tenants = new TenantService(
    {
      findOne: ({ where }: { where: { id?: number; slug?: string } }) =>
        Promise.resolve(
          STORES.find((store) =>
            where.id !== undefined
              ? store.id === where.id
              : store.slug === where.slug,
          ) ?? null,
        ),
    } as never,
    {
      findOne: ({ where }: { where: { store_id: number } }) =>
        Promise.resolve({
          id: where.store_id,
          store_id: where.store_id,
          status: SubscriptionStatus.ACTIVE,
          plan: { features: {} },
        }),
    } as never,
    { findOne: () => Promise.resolve({ id: 1, default_store_id: 7 }) } as never,
  );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        PublicPlansController,
        StoreSubscriptionController,
        PlatformBillingController,
        BillingWebhookController,
      ],
      providers: [
        { provide: PlansService, useValue: plans },
        { provide: SubscriptionsService, useValue: subscriptions },
        { provide: BillingQueriesService, useValue: queries },
        { provide: BillingWebhookService, useValue: webhooks },
        { provide: TenantService, useValue: tenants },
        RateLimitService,
      ],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          if (!userFrom(ctx)) {
            throw new UnauthorizedException(
              'Sessão inválida ou expirada. Faça login novamente.',
            );
          }
          return true;
        },
      })
      .compile();

    app = setupApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  it('GET /plans é público', async () => {
    const res = await request(server).get('/plans').expect(200);
    expect(res.body).toEqual([{ id: 1, code: 'essencial' }]);
  });

  describe('/store/subscription (ADMIN da própria loja)', () => {
    it('anônimo 401; cliente, atendente e superadmin fora de sessão de suporte 403', async () => {
      await request(server).get('/store/subscription').expect(401);
      for (const who of [CLIENT, EMPLOYEE_7, SUPER_ADMIN]) {
        await request(server)
          .get('/store/subscription')
          .set(as(who))
          .expect(403);
      }
      expect(queries.storeOverview).not.toHaveBeenCalled();
    });

    it('ADMIN vê a assinatura da PRÓPRIA loja (do token, nunca da requisição)', async () => {
      const res = await request(server)
        .get('/store/subscription?storeId=9')
        .set(as(ADMIN_7))
        .expect(200);
      expect(res.body).toEqual({ store_id: 7 });
      expect(queries.storeOverview.mock.calls[0][0]).toMatchObject({
        storeId: 7,
      });
    });

    it('loja suspensa ainda regulariza a cobrança; loja desativada não', async () => {
      await request(server)
        .get('/store/subscription')
        .set(as(storeAdmin(9)))
        .expect(200);
      await request(server)
        .post('/store/subscription/cancel')
        .set(as(storeAdmin(9)))
        .send({})
        .expect(200);
      await request(server)
        .get('/store/subscription')
        .set(as(storeAdmin(10)))
        .expect(403);
    });

    it('cancel/resume/checkout atuam na loja do contexto; store_id no corpo é recusado', async () => {
      await request(server)
        .post('/store/subscription/cancel')
        .set(as(ADMIN_7))
        .send({ reason: 'Vou fechar' })
        .expect(200);
      expect(subscriptions.cancelForStore).toHaveBeenCalledWith(
        expect.objectContaining({ storeId: 7 }),
        'Vou fechar',
        expect.objectContaining({
          user: expect.objectContaining({ id: ADMIN_7.id }) as unknown,
        }),
      );

      const extra = await request(server)
        .post('/store/subscription/cancel')
        .set(as(ADMIN_7))
        .send({ store_id: 9 })
        .expect(400);
      expect(messageOf(extra)).toContain('property store_id should not exist');

      await request(server)
        .post('/store/subscription/resume')
        .set(as(ADMIN_7))
        .expect(200);
      expect(subscriptions.resumeForStore).toHaveBeenCalledWith(
        expect.objectContaining({ storeId: 7 }),
        expect.anything(),
      );

      const checkout = await request(server)
        .post('/store/subscription/checkout')
        .set(as(ADMIN_7))
        .send({ payer_email: ' Financeiro@Loja.com ' })
        .expect(200);
      expect(checkout.body).toMatchObject({ provider: 'MERCADO_PAGO' });
      expect(subscriptions.checkoutForStore).toHaveBeenCalledWith(
        expect.objectContaining({ storeId: 7 }),
        expect.anything(),
        'financeiro@loja.com',
      );
      const invalid = await request(server)
        .post('/store/subscription/checkout')
        .set(as(ADMIN_7))
        .send({ payer_email: 'nao-e-email' })
        .expect(400);
      expect(messageOf(invalid)).toContain('Informe um e-mail válido');
    });

    it('checkout: limite por loja (SUBSCRIPTION_CHECKOUT) → 429; outra loja segue', async () => {
      const saved = process.env.RATE_LIMIT_SUBSCRIPTION_CHECKOUT;
      process.env.RATE_LIMIT_SUBSCRIPTION_CHECKOUT = '2/600';
      try {
        const admin9 = storeAdmin(9);
        for (let i = 0; i < 2; i++) {
          await request(server)
            .post('/store/subscription/checkout')
            .set(as(admin9))
            .send({})
            .expect(200);
        }
        await request(server)
          .post('/store/subscription/checkout')
          .set(as(admin9))
          .send({})
          .expect(429);
        expect(subscriptions.checkoutForStore).toHaveBeenCalledTimes(2);
        await request(server)
          .post('/store/subscription/checkout')
          .set(as(ADMIN_7))
          .send({})
          .expect(200);
      } finally {
        if (saved === undefined)
          delete process.env.RATE_LIMIT_SUBSCRIPTION_CHECKOUT;
        else process.env.RATE_LIMIT_SUBSCRIPTION_CHECKOUT = saved;
      }
    });

    it('sessão de suporte: só leitura', async () => {
      await request(server)
        .get('/store/subscription')
        .set(as(SUPPORT_7))
        .expect(200);
      const res = await request(server)
        .post('/store/subscription/cancel')
        .set(as(SUPPORT_7))
        .send({})
        .expect(403);
      expect(messageOf(res)).toContain('somente leitura');
      expect(subscriptions.cancelForStore).not.toHaveBeenCalled();
    });
  });

  describe('/platform (somente SUPER_ADMIN)', () => {
    it('equipe de loja e clientes → 403; anônimo → 401', async () => {
      await request(server).get('/platform/plans').expect(401);
      for (const who of [ADMIN_7, CLIENT, SUPPORT_7]) {
        const res = await request(server)
          .get('/platform/subscriptions')
          .set(as(who))
          .expect(403);
        expect(messageOf(res)).toContain(
          'Área exclusiva da administração da plataforma',
        );
      }
      expect(queries.listSubscriptions).not.toHaveBeenCalled();
    });

    it('planos: lista, cria (201, validado) e edita', async () => {
      await request(server)
        .get('/platform/plans?status=active&search=pro')
        .set(as(SUPER_ADMIN))
        .expect(200);
      expect(plans.list).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'ACTIVE', search: 'pro' }),
      );

      const invalid = await request(server)
        .post('/platform/plans')
        .set(as(SUPER_ADMIN))
        .send({ code: 'X Y', name: 'Pro', price: -5 })
        .expect(400);
      expect(messageOf(invalid)).toContain('Código do plano inválido');
      expect(messageOf(invalid)).toContain('O preço não pode ser negativo.');

      await request(server)
        .post('/platform/plans')
        .set(as(SUPER_ADMIN))
        .send({ code: 'pro', name: 'Pro', price: 199.9 })
        .expect(201);
      expect(plans.create).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'pro', price: 199.9 }),
        expect.objectContaining({
          user: expect.objectContaining({ id: 1 }) as unknown,
        }),
      );

      await request(server)
        .patch('/platform/plans/5')
        .set(as(SUPER_ADMIN))
        .send({ status: 'INACTIVE' })
        .expect(200);
      await request(server)
        .patch('/platform/plans/abc')
        .set(as(SUPER_ADMIN))
        .send({})
        .expect(400);
    });

    it('assinaturas: filtros, detalhe e ações (devolvem o detalhe atualizado)', async () => {
      await request(server)
        .get('/platform/subscriptions?status=past_due&plan_id=2&search=lanch')
        .set(as(SUPER_ADMIN))
        .expect(200);
      expect(queries.listSubscriptions).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'PAST_DUE',
          plan_id: 2,
          search: 'lanch',
        }),
      );

      const changed = await request(server)
        .post('/platform/subscriptions/3/change-plan')
        .set(as(SUPER_ADMIN))
        .send({ plan_id: 4, reason: 'Upgrade' })
        .expect(200);
      expect(changed.body).toEqual({ id: 3 });
      expect(subscriptions.changePlan).toHaveBeenCalledWith(
        3,
        4,
        expect.objectContaining({ reason: 'Upgrade' }),
      );

      await request(server)
        .post('/platform/subscriptions/3/cancel')
        .set(as(SUPER_ADMIN))
        .send({ at_period_end: true })
        .expect(200);
      expect(subscriptions.cancel).toHaveBeenCalledWith(
        3,
        expect.objectContaining({ atPeriodEnd: true }),
      );

      // Desfaz o cancelamento agendado pelo superpainel e devolve o detalhe
      const resumed = await request(server)
        .post('/platform/subscriptions/3/resume')
        .set(as(SUPER_ADMIN))
        .expect(200);
      expect(resumed.body).toEqual({ id: 3 });
      expect(subscriptions.resume).toHaveBeenCalledWith(
        3,
        expect.objectContaining({
          user: expect.objectContaining({ id: 1 }) as unknown,
        }),
      );
      for (const who of [ADMIN_7, CLIENT, SUPPORT_7]) {
        await request(server)
          .post('/platform/subscriptions/3/resume')
          .set(as(who))
          .expect(403);
      }
      expect(subscriptions.resume).toHaveBeenCalledTimes(1);

      const noReason = await request(server)
        .post('/platform/subscriptions/3/suspend')
        .set(as(SUPER_ADMIN))
        .send({})
        .expect(400);
      expect(messageOf(noReason)).toContain('Informe o motivo da suspensão.');

      await request(server)
        .post('/platform/subscriptions/3/reactivate')
        .set(as(SUPER_ADMIN))
        .send({ force: true, reason: 'Acordo' })
        .expect(200);
      expect(subscriptions.reactivate).toHaveBeenCalledWith(
        3,
        expect.objectContaining({ force: true, reason: 'Acordo' }),
      );
    });

    it('cria assinatura para a loja (201) e faturas devolvem só os campos permitidos', async () => {
      await request(server)
        .post('/platform/stores/7/subscription')
        .set(as(SUPER_ADMIN))
        .send({ plan_id: 2, allow_inactive_plan: true })
        .expect(201);
      expect(subscriptions.createForStore).toHaveBeenCalledWith(
        7,
        2,
        expect.objectContaining({ allowInactivePlan: true }),
      );

      const invoice = await request(server)
        .post('/platform/subscriptions/3/invoices')
        .set(as(SUPER_ADMIN))
        .send({
          amount: 99.9,
          period_start: '2026-10-11',
          period_end: '2026-11-11',
        })
        .expect(201);
      expect((invoice.body as Record<string, unknown>).store).toBeUndefined();
      expect(subscriptions.createInvoice).toHaveBeenCalledWith(
        3,
        expect.objectContaining({
          amount: 99.9,
          period_start: new Date('2026-10-11T00:00:00.000Z'),
        }),
        expect.anything(),
      );

      const badDate = await request(server)
        .post('/platform/subscriptions/3/invoices')
        .set(as(SUPER_ADMIN))
        .send({ due_at: '11/10/2026' })
        .expect(400);
      expect(messageOf(badDate)).toContain('due_at deve ser uma data ISO 8601');

      const paid = await request(server)
        .post('/platform/invoices/31/mark-paid')
        .set(as(SUPER_ADMIN))
        .send({ payment_method: 'PIX', provider_payment_id: 'E123' })
        .expect(200);
      expect(paid.body).toMatchObject({ id: 31, status: 'PAID' });
      expect(JSON.stringify(paid.body)).not.toContain('segredo');
      expect(subscriptions.markInvoicePaid).toHaveBeenCalledWith(
        31,
        expect.objectContaining({ providerPaymentId: 'E123' }),
        expect.anything(),
      );

      await request(server)
        .post('/platform/invoices/31/mark-failed')
        .set(as(SUPER_ADMIN))
        .send({ reason: 'Recusado' })
        .expect(200);
      // Ações com impacto financeiro exigem o motivo (auditoria com o porquê)
      for (const [action, message] of [
        ['mark-failed', 'Informe o motivo da recusa do pagamento.'],
        ['void', 'Informe o motivo da anulação.'],
      ]) {
        for (const body of [{}, { reason: '   ' }, { reason: null }]) {
          const refused = await request(server)
            .post(`/platform/invoices/31/${action}`)
            .set(as(SUPER_ADMIN))
            .send(body)
            .expect(400);
          expect(messageOf(refused)).toContain(message);
        }
      }
      expect(subscriptions.voidInvoice).not.toHaveBeenCalled();
      await request(server)
        .post('/platform/invoices/31/void')
        .set(as(SUPER_ADMIN))
        .send({ reason: 'Lançada em duplicidade' })
        .expect(200);
      expect(subscriptions.voidInvoice).toHaveBeenCalledWith(
        31,
        { reason: 'Lançada em duplicidade' },
        expect.anything(),
      );

      // Cancelar agora exige motivo; agendar no fim do período, não
      for (const body of [{}, { at_period_end: false }, { reason: '' }]) {
        const refused = await request(server)
          .post('/platform/subscriptions/5/cancel')
          .set(as(SUPER_ADMIN))
          .send(body)
          .expect(400);
        expect(messageOf(refused)).toContain(
          'Informe o motivo do cancelamento imediato.',
        );
      }
      expect(subscriptions.cancel).not.toHaveBeenCalled();
      await request(server)
        .post('/platform/subscriptions/5/cancel')
        .set(as(SUPER_ADMIN))
        .send({ at_period_end: true })
        .expect(200);
      await request(server)
        .post('/platform/subscriptions/5/cancel')
        .set(as(SUPER_ADMIN))
        .send({ reason: 'Encerramento do contrato' })
        .expect(200);
      expect(subscriptions.cancel).toHaveBeenLastCalledWith(
        5,
        expect.objectContaining({
          atPeriodEnd: false,
          reason: 'Encerramento do contrato',
        }),
      );
      await request(server)
        .get('/platform/invoices?status=open')
        .set(as(SUPER_ADMIN))
        .expect(200);
      expect(queries.listInvoices).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'OPEN' }),
      );
    });
  });

  it('POST /billing/webhook/mercadopago é público e repassa cabeçalhos, query e corpo', async () => {
    const res = await request(server)
      .post('/billing/webhook/mercadopago?data.id=123&type=payment')
      .set('x-signature', 'ts=1,v1=abc')
      .set('x-request-id', 'req-9')
      .send({ id: 1, type: 'payment', data: { id: '123' } })
      .expect(200);
    expect(res.body).toEqual({ status: 'ok', result: 'processed' });
    const [input] = webhooks.handleMercadoPago.mock.calls[0] as [
      {
        headers: Record<string, string>;
        query: Record<string, string>;
        body: unknown;
      },
    ];
    expect(input.headers['x-signature']).toBe('ts=1,v1=abc');
    expect(input.headers['x-request-id']).toBe('req-9');
    expect(input.query['data.id']).toBe('123');
    expect(input.body).toEqual({ id: 1, type: 'payment', data: { id: '123' } });
  });
});
