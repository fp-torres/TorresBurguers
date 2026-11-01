import { Logger } from '@nestjs/common';
import { InvoiceStatus } from './entities/subscription-invoice.entity';
import {
  Subscription,
  SubscriptionStatus,
} from './entities/subscription.entity';
import { SubscriptionInvoice } from './entities/subscription-invoice.entity';
import {
  DEFAULT_LIFECYCLE_INTERVAL_MS,
  LIFECYCLE_BATCH_SIZE,
  lifecycleIntervalMs,
  MIN_LIFECYCLE_INTERVAL_MS,
  SubscriptionLifecycleService,
} from './subscription-lifecycle.service';
import type { SubscriptionsService } from './subscriptions.service';
import {
  at,
  createBillingDb,
  createSubscriptionsService,
  days,
  eventTypes,
  NOW,
  rowsWhere,
  seedInvoice,
  seedPlan,
  seedSettings,
  seedStore,
  seedSubscription,
} from './testing/billing-fixtures.helper-spec';
import type { FakeDb } from './testing/fake-db.helper-spec';

const { TRIALING, ACTIVE, PAST_DUE, SUSPENDED, CANCELED } = SubscriptionStatus;

function setup(graceDays = 7) {
  const db = createBillingDb();
  seedSettings(db, graceDays);
  seedStore(db, { id: 7 });
  const services = createSubscriptionsService(db);
  const lifecycle = new SubscriptionLifecycleService(
    db.repository(Subscription) as never,
    db.repository(SubscriptionInvoice) as never,
    services.service,
  );
  return { db, lifecycle, ...services };
}

function subscriptionRow(db: FakeDb, id: number) {
  return rowsWhere(db, 'subscriptions', (row) => row.id === id)[0];
}

function invoicesOf(db: FakeDb, subscriptionId: number) {
  return rowsWhere(
    db,
    'subscription_invoices',
    (row) => row.subscription_id === subscriptionId,
  );
}

describe('SubscriptionLifecycleService', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });
  afterEach(() => jest.useRealTimers());

  describe('fim do teste grátis', () => {
    it('plano pago: fatura do 1º período (vence no fim do teste) e ACTIVE; a mesma rodada já marca o atraso', async () => {
      const { db, lifecycle, audit } = setup(7);
      const plan = seedPlan(db, { trial_days: 14 });
      const trialEnd = days(NOW, -1);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        status: TRIALING,
        trial_ends_at: trialEnd,
        current_period_start: days(NOW, -15),
        current_period_end: trialEnd,
      });

      const summary = await lifecycle.runOnce(NOW);

      expect(summary).toMatchObject({ activated: 1, past_due: 1, errors: 0 });
      const invoices = invoicesOf(db, subscription.id);
      expect(invoices).toEqual([
        expect.objectContaining({
          status: InvoiceStatus.OPEN,
          period_start: trialEnd,
          period_end: at('2026-11-10T12:00:00.000Z'),
          due_at: trialEnd,
          amount: 99.9,
        }),
      ]);
      // Vencida desde o fim do teste: PAST_DUE com tolerância = vencimento + 7 dias
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: PAST_DUE,
        current_period_start: trialEnd,
        current_period_end: at('2026-11-10T12:00:00.000Z'),
        past_due_since: trialEnd,
        grace_period_ends_at: days(trialEnd, 7),
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'subscription.lifecycle.activated',
          scope: 'SYSTEM',
        }),
      );

      // Idempotente: rodar de novo não cria outra fatura nem eventos
      const events = eventTypes(db, subscription.id).length;
      await expect(lifecycle.runOnce(NOW)).resolves.toMatchObject({
        activated: 0,
        past_due: 0,
      });
      expect(invoicesOf(db, subscription.id)).toHaveLength(1);
      expect(eventTypes(db, subscription.id)).toHaveLength(events);
    });

    it('plano gratuito: ACTIVE sem vencimento e sem fatura', async () => {
      const { db, lifecycle } = setup();
      const free = seedPlan(db, { price: 0, trial_days: 7 });
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: free.id,
        status: TRIALING,
        trial_ends_at: days(NOW, -1),
        current_period_end: days(NOW, -1),
      });

      await lifecycle.runOnce(NOW);

      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: ACTIVE,
        current_period_end: null,
      });
      expect(invoicesOf(db, subscription.id)).toHaveLength(0);
    });

    it('teste com cancelamento agendado termina CANCELED; teste ainda em curso não muda', async () => {
      const { db, lifecycle } = setup();
      const plan = seedPlan(db, { trial_days: 7 });
      seedStore(db, { id: 8 });
      const canceling = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        status: TRIALING,
        trial_ends_at: days(NOW, -1),
        current_period_end: days(NOW, -1),
        cancel_at_period_end: true,
      });
      const running = seedSubscription(db, {
        store_id: 8,
        plan_id: plan.id,
        status: TRIALING,
        trial_ends_at: days(NOW, 3),
        current_period_end: days(NOW, 3),
      });

      await lifecycle.runOnce(NOW);

      expect(subscriptionRow(db, canceling.id)).toMatchObject({
        status: CANCELED,
        canceled_at: days(NOW, -1),
      });
      expect(subscriptionRow(db, running.id).status).toBe(TRIALING);
    });

    it('fatura do 1º período já paga antes do fim do teste é reaproveitada', async () => {
      const { db, lifecycle } = setup();
      const plan = seedPlan(db, { trial_days: 7 });
      const trialEnd = days(NOW, -1);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        status: TRIALING,
        trial_ends_at: trialEnd,
        current_period_end: trialEnd,
      });
      seedInvoice(db, {
        subscription_id: subscription.id,
        store_id: 7,
        plan_id: plan.id,
        status: InvoiceStatus.PAID,
        paid_at: days(NOW, -3),
        period_start: trialEnd,
        period_end: at('2026-11-10T12:00:00.000Z'),
        due_at: trialEnd,
      });

      await lifecycle.runOnce(NOW);

      expect(invoicesOf(db, subscription.id)).toHaveLength(1);
      expect(subscriptionRow(db, subscription.id).status).toBe(ACTIVE);
    });
  });

  describe('inadimplência', () => {
    it('fatura vencida → PAST_DUE com a tolerância da plataforma; fim da tolerância → SUSPENDED', async () => {
      const { db, lifecycle } = setup(5);
      const plan = seedPlan(db);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
      });
      const due = days(NOW, -2);
      seedInvoice(db, {
        subscription_id: subscription.id,
        store_id: 7,
        plan_id: plan.id,
        due_at: due,
      });

      await lifecycle.runOnce(NOW);
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: PAST_DUE,
        past_due_since: due,
        grace_period_ends_at: days(due, 5),
      });

      // Ainda na tolerância: nada muda
      await expect(lifecycle.runOnce(days(NOW, 2))).resolves.toMatchObject({
        suspended: 0,
      });
      const later = days(NOW, 4);
      await expect(lifecycle.runOnce(later)).resolves.toMatchObject({
        suspended: 1,
      });
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: SUSPENDED,
        suspended_at: later,
      });
      expect(eventTypes(db, subscription.id)).toEqual([
        'STATUS_CHANGED',
        'STATUS_CHANGED',
      ]);
    });

    it('fatura que ainda não venceu não muda nada; fatura de assinatura cancelada é ignorada', async () => {
      const { db, lifecycle } = setup();
      const plan = seedPlan(db);
      seedStore(db, { id: 8 });
      const active = seedSubscription(db, { store_id: 7, plan_id: plan.id });
      seedInvoice(db, {
        subscription_id: active.id,
        store_id: 7,
        plan_id: plan.id,
        due_at: days(NOW, 3),
      });
      const canceled = seedSubscription(db, {
        store_id: 8,
        plan_id: plan.id,
        status: CANCELED,
        canceled_at: days(NOW, -5),
      });
      seedInvoice(db, {
        subscription_id: canceled.id,
        store_id: 8,
        plan_id: plan.id,
        due_at: days(NOW, -30),
      });

      await expect(lifecycle.runOnce(NOW)).resolves.toMatchObject({
        past_due: 0,
        suspended: 0,
      });
      expect(subscriptionRow(db, active.id).status).toBe(ACTIVE);
      expect(subscriptionRow(db, canceled.id).status).toBe(CANCELED);
    });

    it('tolerância vencida sem fatura vencida em aberto (paga por fora) volta a ACTIVE', async () => {
      const { db, lifecycle } = setup();
      const plan = seedPlan(db);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        status: PAST_DUE,
        past_due_since: days(NOW, -10),
        grace_period_ends_at: days(NOW, -3),
      });
      seedInvoice(db, {
        subscription_id: subscription.id,
        store_id: 7,
        plan_id: plan.id,
        status: InvoiceStatus.PAID,
        due_at: days(NOW, -10),
      });

      await expect(lifecycle.runOnce(NOW)).resolves.toMatchObject({
        restored: 1,
        suspended: 0,
      });
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: ACTIVE,
        past_due_since: null,
        grace_period_ends_at: null,
      });
    });
  });

  describe('fim do período', () => {
    it('renova: fatura OPEN do próximo período (vence no início dele) e o período avança — uma vez só', async () => {
      const { db, lifecycle } = setup();
      const plan = seedPlan(db);
      const end = days(NOW, -1);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        current_period_start: at('2026-09-10T12:00:00.000Z'),
        current_period_end: end,
      });
      seedInvoice(db, {
        subscription_id: subscription.id,
        store_id: 7,
        plan_id: plan.id,
        status: InvoiceStatus.PAID,
        period_start: at('2026-09-10T12:00:00.000Z'),
        period_end: end,
        due_at: at('2026-09-10T12:00:00.000Z'),
      });

      const summary = await lifecycle.runOnce(NOW);

      expect(summary).toMatchObject({ renewed: 1 });
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        current_period_start: end,
        current_period_end: at('2026-11-10T12:00:00.000Z'),
      });
      const open = invoicesOf(db, subscription.id).filter(
        (row) => row.status === InvoiceStatus.OPEN,
      );
      expect(open).toEqual([
        expect.objectContaining({
          period_start: end,
          period_end: at('2026-11-10T12:00:00.000Z'),
          due_at: end,
        }),
      ]);

      // Segunda rodada no mesmo instante: o período já avançou, nenhuma fatura nova
      await lifecycle.runOnce(NOW);
      expect(invoicesOf(db, subscription.id)).toHaveLength(2);
    });

    it('fatura do próximo período já existente (paga antes) não é duplicada', async () => {
      const { db, lifecycle } = setup();
      const plan = seedPlan(db);
      const end = days(NOW, -1);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        current_period_end: end,
      });
      seedInvoice(db, {
        subscription_id: subscription.id,
        store_id: 7,
        plan_id: plan.id,
        status: InvoiceStatus.PAID,
        period_start: end,
        period_end: at('2026-11-10T12:00:00.000Z'),
        due_at: end,
      });

      await lifecycle.runOnce(NOW);

      expect(invoicesOf(db, subscription.id)).toHaveLength(1);
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: ACTIVE,
        current_period_end: at('2026-11-10T12:00:00.000Z'),
      });
    });

    it('cancelamento agendado → CANCELED no fim do período (a loja usou até lá)', async () => {
      const { db, lifecycle, audit } = setup();
      const plan = seedPlan(db);
      const end = days(NOW, -1);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        current_period_end: end,
        cancel_at_period_end: true,
      });

      await expect(lifecycle.runOnce(NOW)).resolves.toMatchObject({
        canceled: 1,
        renewed: 0,
      });
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: CANCELED,
        canceled_at: end,
      });
      expect(invoicesOf(db, subscription.id)).toHaveLength(0);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'subscription.lifecycle.canceled' }),
      );
    });

    it('cancelada com a cobrança ainda ativa no provedor (o cancelamento lá falhou): a rotina tenta de novo', async () => {
      const { db, lifecycle, providers, audit } = setup();
      const plan = seedPlan(db);
      const stuck = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        status: CANCELED,
        canceled_at: days(NOW, -3),
        billing_provider: 'MERCADO_PAGO',
        provider_subscription_id: 'pre-1',
        provider_status: 'authorized',
      });
      seedStore(db, { id: 8 });
      seedSubscription(db, {
        store_id: 8,
        plan_id: plan.id,
        status: CANCELED,
        canceled_at: days(NOW, -3),
        billing_provider: 'MERCADO_PAGO',
        provider_subscription_id: 'pre-2',
        provider_status: 'cancelled',
      });
      const cancelSubscription = jest.fn().mockResolvedValue(undefined);
      providers.forCode.mockReturnValue({ online: true, cancelSubscription });

      await expect(lifecycle.runOnce(NOW)).resolves.toMatchObject({
        provider_canceled: 1,
        errors: 0,
      });
      expect(cancelSubscription).toHaveBeenCalledTimes(1);
      expect(cancelSubscription).toHaveBeenCalledWith('pre-1');
      expect(subscriptionRow(db, stuck.id).provider_status).toBe('cancelled');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'subscription.lifecycle.provider_canceled',
        }),
      );
      // Próxima rodada: nada mais a fazer
      await expect(lifecycle.runOnce(NOW)).resolves.toMatchObject({
        provider_canceled: 0,
      });
      expect(cancelSubscription).toHaveBeenCalledTimes(1);
    });

    it('suspensa não renova (fica congelada); com cancelamento agendado, termina CANCELED', async () => {
      const { db, lifecycle } = setup();
      const plan = seedPlan(db);
      seedStore(db, { id: 8 });
      const frozen = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        status: SUSPENDED,
        current_period_end: days(NOW, -1),
      });
      const leaving = seedSubscription(db, {
        store_id: 8,
        plan_id: plan.id,
        status: SUSPENDED,
        current_period_end: days(NOW, -1),
        cancel_at_period_end: true,
      });

      await lifecycle.runOnce(NOW);

      expect(subscriptionRow(db, frozen.id)).toMatchObject({
        status: SUSPENDED,
        current_period_end: days(NOW, -1),
      });
      expect(invoicesOf(db, frozen.id)).toHaveLength(0);
      expect(subscriptionRow(db, leaving.id).status).toBe(CANCELED);
    });

    it('plano gratuito com período (veio de um plano pago) deixa de ter vencimento', async () => {
      const { db, lifecycle } = setup();
      const free = seedPlan(db, { price: 0 });
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: free.id,
        current_period_end: days(NOW, -1),
      });

      await lifecycle.runOnce(NOW);

      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: ACTIVE,
        current_period_end: null,
      });
      expect(invoicesOf(db, subscription.id)).toHaveLength(0);
    });
  });

  it('ciclo completo: teste → fatura → atraso → suspensão → pagamento → ativa com período novo', async () => {
    const { db, lifecycle, service } = setup(3);
    const plan = seedPlan(db, { trial_days: 7 });
    const subscription = await service.createForStore(7, plan.id, {
      now: NOW,
    });
    expect(subscription.status).toBe(TRIALING);

    const trialEnd = days(NOW, 7);
    await lifecycle.runOnce(days(trialEnd, 0.01));
    expect(subscriptionRow(db, subscription.id).status).toBe(PAST_DUE);

    await lifecycle.runOnce(days(trialEnd, 3.5));
    expect(subscriptionRow(db, subscription.id).status).toBe(SUSPENDED);

    const [invoice] = invoicesOf(db, subscription.id);
    const paidAt = days(trialEnd, 4);
    await service.markInvoicePaid(
      invoice.id as number,
      {},
      {
        user: null,
        now: paidAt,
      },
    );
    expect(subscriptionRow(db, subscription.id)).toMatchObject({
      status: ACTIVE,
      suspended_at: null,
      // O período pago (fim do teste + 1 mês) ainda está em curso: continua o mesmo
      current_period_start: trialEnd,
    });
    expect(eventTypes(db, subscription.id)).toEqual([
      'CREATED',
      'STATUS_CHANGED',
      'INVOICE_CREATED',
      'STATUS_CHANGED',
      'STATUS_CHANGED',
      'PAYMENT_SUCCEEDED',
      'STATUS_CHANGED',
    ]);
  });

  it('um erro numa assinatura não impede as outras (e nada dela fica pela metade)', async () => {
    const { db, lifecycle } = setup();
    const plan = seedPlan(db);
    seedStore(db, { id: 8 });
    // Plano inexistente: a renovação desta assinatura falha
    const broken = seedSubscription(db, {
      store_id: 7,
      plan_id: 999,
      current_period_end: days(NOW, -1),
    });
    const fine = seedSubscription(db, {
      store_id: 8,
      plan_id: plan.id,
      current_period_end: days(NOW, -1),
    });

    await expect(lifecycle.runOnce(NOW)).resolves.toMatchObject({
      renewed: 1,
      errors: 1,
    });
    expect(subscriptionRow(db, fine.id).current_period_start).toEqual(
      days(NOW, -1),
    );
    expect(subscriptionRow(db, broken.id).current_period_end).toEqual(
      days(NOW, -1),
    );
    expect(invoicesOf(db, broken.id)).toHaveLength(0);
  });

  describe('agendamento', () => {
    function stubbed() {
      const billing = {
        graceDays: jest.fn().mockResolvedValue(7),
        processTrialEnd: jest.fn(),
        processPeriodEnd: jest.fn(),
        processOverdue: jest.fn(),
        processGraceEnd: jest.fn(),
      };
      const repo = { find: jest.fn().mockResolvedValue([]) };
      const lifecycle = new SubscriptionLifecycleService(
        repo as never,
        repo as never,
        billing as unknown as SubscriptionsService,
      );
      return { lifecycle, billing, repo };
    }

    it('roda no intervalo configurado e para quando a aplicação fecha', async () => {
      jest.useFakeTimers();
      const saved = process.env.SAAS_BILLING_INTERVAL_MS;
      process.env.SAAS_BILLING_INTERVAL_MS = '60000';
      try {
        const { lifecycle, billing } = stubbed();
        lifecycle.onApplicationBootstrap();
        expect(billing.graceDays).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(60_000);
        expect(billing.graceDays).toHaveBeenCalledTimes(1);

        lifecycle.onModuleDestroy();
        await jest.advanceTimersByTimeAsync(180_000);
        expect(billing.graceDays).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);

        lifecycle.onApplicationBootstrap();
        lifecycle.onApplicationShutdown();
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        if (saved === undefined) delete process.env.SAAS_BILLING_INTERVAL_MS;
        else process.env.SAAS_BILLING_INTERVAL_MS = saved;
      }
    });

    it('uma rodada por vez; erro geral não derruba o timer', async () => {
      const { lifecycle, billing } = stubbed();
      let release: (value: number) => void = () => undefined;
      billing.graceDays.mockImplementationOnce(
        () => new Promise<number>((resolve) => (release = resolve)),
      );

      const first = lifecycle.runOnce(NOW);
      await expect(lifecycle.runOnce(NOW)).resolves.toBeNull();
      release(7);
      await expect(first).resolves.toMatchObject({ errors: 0 });

      billing.graceDays.mockRejectedValueOnce(new Error('banco fora do ar'));
      await expect(lifecycle.tick()).resolves.toBeUndefined();
      await expect(lifecycle.runOnce(NOW)).resolves.not.toBeNull();
    });

    it('cancelamento no provedor: rodízio entre as rodadas, então 200+ falhas permanentes não deixam uma nova de fora', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db);
      // 201 canceladas cuja cobrança no provedor falha sempre (ex.: conta antiga do Mercado Pago)...
      for (let i = 1; i <= LIFECYCLE_BATCH_SIZE + 1; i++) {
        seedSubscription(db, {
          store_id: 7,
          plan_id: plan.id,
          status: CANCELED,
          billing_provider: 'MERCADO_PAGO',
          provider_subscription_id: `pre-antiga-${i}`,
          provider_status: i % 2 ? 'authorized' : null,
        });
      }
      // ...e uma cancelada agora, ainda cobrando
      const fresh = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        status: CANCELED,
        billing_provider: 'MERCADO_PAGO',
        provider_subscription_id: 'pre-nova',
        provider_status: 'authorized',
      });
      // Já cancelada no provedor ou sem autorização: nunca é candidata
      seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        status: CANCELED,
        billing_provider: 'MERCADO_PAGO',
        provider_subscription_id: 'pre-ok',
        provider_status: 'cancelled',
      });
      const billing = {
        graceDays: jest.fn().mockResolvedValue(7),
        retryProviderCancellation: jest.fn().mockResolvedValue(null),
      };
      const lifecycle = new SubscriptionLifecycleService(
        db.repository(Subscription) as never,
        db.repository(SubscriptionInvoice) as never,
        billing as unknown as SubscriptionsService,
      );
      const visited = () =>
        billing.retryProviderCancellation.mock.calls.map(
          ([id]) => id as number,
        );

      await lifecycle.runOnce(NOW);
      expect(visited()).toHaveLength(LIFECYCLE_BATCH_SIZE);
      expect(visited()).not.toContain(fresh.id);

      // Rodada seguinte: continua de onde parou (a nova entra) e completa o lote pelo começo da lista
      billing.retryProviderCancellation.mockClear();
      await lifecycle.runOnce(NOW);
      expect(visited()).toContain(fresh.id);
      expect(visited()).toHaveLength(LIFECYCLE_BATCH_SIZE);
      expect(new Set(visited()).size).toBe(LIFECYCLE_BATCH_SIZE);
      const all = rowsWhere(
        db,
        'subscriptions',
        (row) => row.provider_status !== 'cancelled',
      ).map((row) => row.id as number);
      expect(visited().every((id) => all.includes(id))).toBe(true);
    });

    it('SAAS_BILLING_INTERVAL_MS: padrão 300000, mínimo 10000, inválido → padrão', () => {
      expect(lifecycleIntervalMs({})).toBe(DEFAULT_LIFECYCLE_INTERVAL_MS);
      expect(lifecycleIntervalMs({ SAAS_BILLING_INTERVAL_MS: '120000' })).toBe(
        120_000,
      );
      expect(lifecycleIntervalMs({ SAAS_BILLING_INTERVAL_MS: '5' })).toBe(
        MIN_LIFECYCLE_INTERVAL_MS,
      );
      expect(lifecycleIntervalMs({ SAAS_BILLING_INTERVAL_MS: 'abc' })).toBe(
        DEFAULT_LIFECYCLE_INTERVAL_MS,
      );
      expect(lifecycleIntervalMs({ SAAS_BILLING_INTERVAL_MS: '-1' })).toBe(
        DEFAULT_LIFECYCLE_INTERVAL_MS,
      );
    });
  });
});
