import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { StoreAccountStatus } from '../store/entities/store.entity';
import { storeAccessState } from '../tenancy/store-access';
import type { TenantContext } from '../tenancy/tenant-context';
import { STORE_NOT_FOUND_MESSAGE } from '../tenancy/tenant.service';
import { BillingInterval, PlanStatus } from './entities/plan.entity';
import { InvoiceStatus } from './entities/subscription-invoice.entity';
import {
  SubscriptionStatus,
  type Subscription,
} from './entities/subscription.entity';
import { ONLINE_BILLING_UNAVAILABLE_MESSAGE } from './providers/billing-provider';
import {
  CANCEL_REASON_REQUIRED_MESSAGE,
  CANCEL_SCHEDULED_BY_PLATFORM_MESSAGE,
  CHECKOUT_ALREADY_AUTHORIZED_MESSAGE,
  CHECKOUT_IN_PROGRESS_MESSAGE,
  CHECKOUT_LOCK_ATTEMPTS,
  CHECKOUT_LOCK_RETRY_MS,
  IMMEDIATE_CANCEL_OWNER_ONLY_MESSAGE,
  FORCE_REASON_REQUIRED_MESSAGE,
  FREE_PLAN_CHECKOUT_MESSAGE,
  FREE_PLAN_INVOICE_MESSAGE,
  INVOICE_PAID_VOID_MESSAGE,
  INVOICE_PERIOD_EXISTS_MESSAGE,
  INVOICE_PERIOD_REQUIRED_MESSAGE,
  INVOICE_VOID_MESSAGE,
  NO_CURRENT_SUBSCRIPTION_MESSAGE,
  NOTHING_TO_RESUME_MESSAGE,
  OVERDUE_INVOICES_MESSAGE,
  PAID_AT_CLOCK_SKEW_MS,
  PAID_AT_IN_FUTURE_MESSAGE,
  PERIOD_ALREADY_ENDED_MESSAGE,
  PLATFORM_ONLY_MESSAGE,
  PLATFORM_SUSPENSION_CHECKOUT_MESSAGE,
  PLAN_UNAVAILABLE_MESSAGE,
  PROVIDER_PAYMENT_USED_MESSAGE,
  REACTIVATE_ONLY_BLOCKED_MESSAGE,
  SAME_PLAN_MESSAGE,
  SUBSCRIPTION_CANCELED_MESSAGE,
  SUBSCRIPTION_EXISTS_MESSAGE,
  SUBSCRIPTION_NOT_FOUND_MESSAGE,
} from './subscriptions.service';
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
  storeAdmin,
  SUPER_ADMIN,
} from './testing/billing-fixtures.helper-spec';
import type { FakeDb } from './testing/fake-db.helper-spec';

const { TRIALING, ACTIVE, PAST_DUE, SUSPENDED, CANCELED } = SubscriptionStatus;
const platform = { user: SUPER_ADMIN, now: NOW };

function subscriptionRow(db: FakeDb, id: number) {
  return rowsWhere(db, 'subscriptions', (row) => row.id === id)[0];
}

function invoiceRow(db: FakeDb, id: number) {
  return rowsWhere(db, 'subscription_invoices', (row) => row.id === id)[0];
}

function tenantOf(db: FakeDb, storeId: number): TenantContext {
  const store = rowsWhere(db, 'stores', (row) => row.id === storeId)[0];
  return {
    storeId,
    store: store as never,
    subscription: null,
    access: storeAccessState(store as never, null),
  };
}

/** Toda consulta/escrita em tabelas por loja carregou store_id = storeId. */
function expectScopedTo(db: FakeDb, storeId: number, fromIndex = 0) {
  const scoped = db.queries
    .slice(fromIndex)
    .filter((query) =>
      [
        'subscriptions',
        'subscription_invoices',
        'subscription_events',
      ].includes(query.table),
    );
  expect(scoped.length).toBeGreaterThan(0);
  for (const query of scoped) {
    const conditions = Array.isArray(query.where) ? query.where : [query.where];
    for (const condition of conditions) {
      // Consultas por provider_payment_id (único global) não precisam da loja
      if ((condition as Record<string, unknown>)?.provider_payment_id) continue;
      expect(condition).toEqual(expect.objectContaining({ store_id: storeId }));
    }
  }
}

describe('SubscriptionsService', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  describe('createForStore', () => {
    it('plano pago: ACTIVE com o período atual e fatura OPEN do período (vence no início)', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db, { price: 99.9 });
      const { service, audit } = createSubscriptionsService(db);

      const created = await service.createForStore(7, plan.id, {
        actor: SUPER_ADMIN,
        now: NOW,
      });

      expect(created).toMatchObject({
        store_id: 7,
        plan_id: plan.id,
        status: ACTIVE,
        current_period_start: NOW,
        current_period_end: at('2026-11-11T12:00:00.000Z'),
        billing_provider: 'MANUAL',
      });
      const invoices = rowsWhere(db, 'subscription_invoices');
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({
        subscription_id: created.id,
        store_id: 7,
        amount: 99.9,
        status: InvoiceStatus.OPEN,
        period_start: NOW,
        period_end: at('2026-11-11T12:00:00.000Z'),
        due_at: NOW,
      });
      expect(eventTypes(db, created.id)).toEqual([
        'CREATED',
        'INVOICE_CREATED',
      ]);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'subscription.create',
          storeId: 7,
          targetId: created.id,
        }),
      );
    });

    it('teste grátis: TRIALING até o fim do teste, sem fatura', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db, { trial_days: 14 });
      const { service } = createSubscriptionsService(db);

      const created = await service.createForStore(7, plan.id, { now: NOW });

      expect(created).toMatchObject({
        status: TRIALING,
        trial_ends_at: days(NOW, 14),
        current_period_start: NOW,
        current_period_end: days(NOW, 14),
      });
      expect(rowsWhere(db, 'subscription_invoices')).toHaveLength(0);
    });

    it('plano gratuito: ACTIVE sem vencimento e sem fatura', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db, { price: 0 });
      const { service } = createSubscriptionsService(db);

      const created = await service.createForStore(7, plan.id, { now: NOW });

      expect(created).toMatchObject({
        status: ACTIVE,
        current_period_end: null,
      });
      expect(rowsWhere(db, 'subscription_invoices')).toHaveLength(0);
    });

    it('recusa (409) loja que já tem assinatura não cancelada; cancelada não impede', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      seedStore(db, { id: 8 });
      const plan = seedPlan(db);
      seedSubscription(db, { store_id: 7, plan_id: plan.id });
      seedSubscription(db, {
        store_id: 8,
        plan_id: plan.id,
        status: CANCELED,
        canceled_at: days(NOW, -1),
      });
      const { service } = createSubscriptionsService(db);

      await expect(
        service.createForStore(7, plan.id, { now: NOW }),
      ).rejects.toThrow(new ConflictException(SUBSCRIPTION_EXISTS_MESSAGE));
      await expect(
        service.createForStore(8, plan.id, { now: NOW }),
      ).resolves.toMatchObject({ store_id: 8, status: ACTIVE });
    });

    it('plano INACTIVE só com permissão explícita do superadmin', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const internal = seedPlan(db, { status: PlanStatus.INACTIVE, price: 0 });
      const { service } = createSubscriptionsService(db);

      await expect(
        service.createForStore(7, internal.id, { now: NOW }),
      ).rejects.toThrow(new BadRequestException(PLAN_UNAVAILABLE_MESSAGE));
      // A loja não é superadmin: a permissão é ignorada
      await expect(
        service.createForStore(7, internal.id, {
          actor: storeAdmin(7),
          allowInactivePlan: true,
          now: NOW,
        }),
      ).rejects.toThrow(PLAN_UNAVAILABLE_MESSAGE);
      await expect(
        service.createForStore(7, internal.id, {
          actor: SUPER_ADMIN,
          allowInactivePlan: true,
          now: NOW,
        }),
      ).resolves.toMatchObject({ plan_id: internal.id });
    });

    it('loja inexistente → 404; erro desfaz tudo (transação)', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db);
      const { service } = createSubscriptionsService(db);

      await expect(
        service.createForStore(99, plan.id, { now: NOW }),
      ).rejects.toThrow(new NotFoundException(STORE_NOT_FOUND_MESSAGE));
      await expect(
        service.createForStore(7, 999, { now: NOW }),
      ).rejects.toThrow(NotFoundException);
      expect(rowsWhere(db, 'subscriptions')).toHaveLength(0);
      expect(rowsWhere(db, 'subscription_events')).toHaveLength(0);
    });

    it('dentro da transação de quem chama: usa o manager recebido e não audita', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db);
      const { service, audit } = createSubscriptionsService(db);

      await db.manager.transaction(async (manager) => {
        await service.createForStore(7, plan.id, {
          manager: manager as never,
          now: NOW,
        });
      });

      expect(rowsWhere(db, 'subscriptions')).toHaveLength(1);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('changePlan', () => {
    function setup() {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const pro = seedPlan(db, { name: 'Pro', price: 199.9 });
      const basic = seedPlan(db, {
        name: 'Básico',
        price: 49.9,
        max_products: 50,
        max_staff_users: 3,
      });
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: pro.id,
      });
      return {
        db,
        pro,
        basic,
        subscription,
        ...createSubscriptionsService(db),
      };
    }

    it('downgrade bloqueado (409) listando o que excede; nada muda', async () => {
      const { db, basic, pro, subscription, service, planLimits } = setup();
      planLimits.usage.mockResolvedValue({
        staff_users: 3,
        products: 80,
        monthly_orders: 10,
      });

      const error = (await service
        .changePlan(subscription.id, basic.id, platform)
        .catch((caught: unknown) => caught)) as HttpException;

      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({
        statusCode: 409,
        message:
          'O uso atual da loja não cabe no plano Básico: produtos no cardápio: 80 em uso (limite 50). Reduza o uso antes de mudar de plano.',
        violations: [
          {
            key: 'products',
            label: 'produtos no cardápio',
            limit: 50,
            usage: 80,
          },
        ],
      });
      expect(planLimits.usage).toHaveBeenCalledWith(7, NOW);
      expect(subscriptionRow(db, subscription.id).plan_id).toBe(pro.id);
      expect(eventTypes(db, subscription.id)).toEqual([]);
    });

    it('downgrade bloqueado pelo armazenamento (arquivos da loja acima do max_storage_mb do plano novo)', async () => {
      const { db, basic, pro, subscription, service, planLimits } = setup();
      db.table('plans').find((row) => row.id === basic.id)!.max_storage_mb =
        100;
      planLimits.storageUsage.mockResolvedValue({
        bytes: 150.5 * 1024 * 1024,
        files: 40,
        measuredAt: NOW,
      });

      const error = (await service
        .changePlan(subscription.id, basic.id, platform)
        .catch((caught: unknown) => caught)) as HttpException;

      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({
        message:
          'O uso atual da loja não cabe no plano Básico: MB de armazenamento: 150,5 em uso (limite 100). Reduza o uso antes de mudar de plano.',
        violations: [
          {
            key: 'storage_mb',
            label: 'MB de armazenamento',
            limit: 100,
            usage: 150.5,
          },
        ],
      });
      expect(planLimits.storageUsage).toHaveBeenCalledWith(7);
      expect(subscriptionRow(db, subscription.id).plan_id).toBe(pro.id);

      // Cabe (ou não foi possível medir): a troca segue
      planLimits.storageUsage.mockResolvedValue(null);
      await expect(
        service.changePlan(subscription.id, basic.id, platform),
      ).resolves.toMatchObject({ plan_id: basic.id });
    });

    it('troca imediata sem proporcionalidade: mantém o período e registra o evento', async () => {
      const { db, basic, pro, subscription, service, audit } = setup();

      const changed = await service.changePlan(subscription.id, basic.id, {
        ...platform,
        reason: 'Pedido da loja',
      });

      expect(changed.plan_id).toBe(basic.id);
      const row = subscriptionRow(db, subscription.id);
      expect(row).toMatchObject({
        plan_id: basic.id,
        current_period_start: subscription.current_period_start,
        current_period_end: subscription.current_period_end,
      });
      const [event] = rowsWhere(db, 'subscription_events');
      expect(event).toMatchObject({
        type: 'PLAN_CHANGED',
        from_plan_id: pro.id,
        to_plan_id: basic.id,
        actor_user_id: SUPER_ADMIN.id,
        reason: 'Pedido da loja',
      });
      expect(event.metadata).toMatchObject({ proration: false });
      expect(rowsWhere(db, 'subscription_invoices')).toHaveLength(0);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'subscription.change_plan' }),
      );
    });

    it('gratuito (sem período) → pago: começa um período agora, com fatura', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const free = seedPlan(db, { price: 0 });
      const paid = seedPlan(db, {
        price: 1200,
        billing_interval: BillingInterval.YEARLY,
      });
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: free.id,
        current_period_end: null,
      });
      const { service } = createSubscriptionsService(db);

      await service.changePlan(subscription.id, paid.id, platform);

      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        current_period_start: NOW,
        current_period_end: at('2027-10-11T12:00:00.000Z'),
      });
      expect(rowsWhere(db, 'subscription_invoices')).toEqual([
        expect.objectContaining({ amount: 1200, due_at: NOW }),
      ]);
      expect(eventTypes(db, subscription.id)).toEqual([
        'PLAN_CHANGED',
        'INVOICE_CREATED',
      ]);
    });

    it('mesmo plano → 400; assinatura cancelada → 409; plano indisponível → 400', async () => {
      const { db, pro, basic, subscription, service } = setup();
      await expect(
        service.changePlan(subscription.id, pro.id, platform),
      ).rejects.toThrow(new BadRequestException(SAME_PLAN_MESSAGE));

      const inactive = seedPlan(db, { status: PlanStatus.INACTIVE });
      await expect(
        service.changePlan(subscription.id, inactive.id, platform),
      ).rejects.toThrow(PLAN_UNAVAILABLE_MESSAGE);

      await service.cancel(subscription.id, {
        ...platform,
        atPeriodEnd: false,
        reason: 'Encerramento do contrato',
      });
      await expect(
        service.changePlan(subscription.id, basic.id, platform),
      ).rejects.toThrow(new ConflictException(SUBSCRIPTION_CANCELED_MESSAGE));
    });
  });

  describe('cancelamento', () => {
    function setup() {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      seedStore(db, { id: 8 });
      const plan = seedPlan(db);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
      });
      const other = seedSubscription(db, { store_id: 8, plan_id: plan.id });
      return {
        db,
        plan,
        subscription,
        other,
        ...createSubscriptionsService(db),
      };
    }

    it('loja: agenda para o fim do período (idempotente) e desfaz com resume', async () => {
      const { db, subscription, service, audit } = setup();
      const tenant = tenantOf(db, 7);
      const ctx = { user: storeAdmin(7), now: NOW };

      const first = await service.cancelForStore(tenant, 'Vou fechar', ctx);
      expect(first.scheduled).toBe(true);
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: ACTIVE,
        cancel_at_period_end: true,
      });
      await service.cancelForStore(tenant, 'De novo', ctx);
      expect(eventTypes(db, subscription.id)).toEqual(['CANCEL_SCHEDULED']);
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'subscription.cancel_scheduled',
          storeId: 7,
        }),
      );

      await service.resumeForStore(tenant, ctx);
      expect(subscriptionRow(db, subscription.id).cancel_at_period_end).toBe(
        false,
      );
      expect(eventTypes(db, subscription.id)).toEqual([
        'CANCEL_SCHEDULED',
        'CANCEL_REVERTED',
      ]);
      await expect(service.resumeForStore(tenant, ctx)).rejects.toThrow(
        new ConflictException(NOTHING_TO_RESUME_MESSAGE),
      );
    });

    it('isolamento: a loja só alcança a própria assinatura (404 uniforme para as outras)', async () => {
      const { db, other, service } = setup();
      const from = db.queries.length;

      await expect(
        service.cancel(other.id, {
          user: storeAdmin(7),
          now: NOW,
          atPeriodEnd: true,
          storeId: 7,
        }),
      ).rejects.toThrow(new NotFoundException(SUBSCRIPTION_NOT_FOUND_MESSAGE));
      await expect(
        service.resume(999, { user: storeAdmin(7), now: NOW, storeId: 7 }),
      ).rejects.toThrow(new NotFoundException(SUBSCRIPTION_NOT_FOUND_MESSAGE));
      expect(subscriptionRow(db, other.id).cancel_at_period_end).toBe(false);

      // Pela rota da loja, toda consulta e escrita carrega a loja do contexto
      const scopedFrom = db.queries.length;
      await service.cancelForStore(tenantOf(db, 7), null, {
        user: storeAdmin(7),
        now: NOW,
      });
      expectScopedTo(db, 7, scopedFrom);
      expect(db.queries.length).toBeGreaterThan(from);
    });

    it('loja sem assinatura vigente → 409', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 9 });
      const { service } = createSubscriptionsService(db);
      await expect(
        service.cancelForStore(tenantOf(db, 9), null, {
          user: storeAdmin(9),
          now: NOW,
        }),
      ).rejects.toThrow(new ConflictException(NO_CURRENT_SUBSCRIPTION_MESSAGE));
    });

    it('plano sem período (gratuito) cancela na hora, mesmo pedindo fim do período', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const free = seedPlan(db, { price: 0 });
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: free.id,
        current_period_end: null,
      });
      const { service } = createSubscriptionsService(db);

      const result = await service.cancelForStore(tenantOf(db, 7), null, {
        user: storeAdmin(7),
        now: NOW,
      });

      expect(result.scheduled).toBe(false);
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: CANCELED,
        canceled_at: NOW,
      });
    });

    it('cancelamento IMEDIATO pela loja (sem período a vencer, irreversível): só o responsável; outro ADMIN → 403 e nada muda', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7, owner_user_id: 107 });
      const free = seedPlan(db, { price: 0 });
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: free.id,
        current_period_end: null,
      });
      const { service, audit } = createSubscriptionsService(db);
      const tenant = tenantOf(db, 7);

      await expect(
        service.cancelForStore(tenant, 'Fechando', {
          user: storeAdmin(7, 200),
          now: NOW,
        }),
      ).rejects.toThrow(
        new ForbiddenException(IMMEDIATE_CANCEL_OWNER_ONLY_MESSAGE),
      );
      expect(subscriptionRow(db, subscription.id).status).toBe(ACTIVE);
      expect(audit.record).not.toHaveBeenCalled();

      // O responsável cancela
      await expect(
        service.cancelForStore(tenant, 'Fechando', {
          user: storeAdmin(7, 107),
          now: NOW,
        }),
      ).resolves.toMatchObject({ scheduled: false });
      expect(subscriptionRow(db, subscription.id).status).toBe(CANCELED);
    });

    it('agendamento (reversível) continua valendo para qualquer ADMIN da loja', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7, owner_user_id: 107 });
      const plan = seedPlan(db);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
      });
      const { service } = createSubscriptionsService(db);
      await expect(
        service.cancelForStore(tenantOf(db, 7), null, {
          user: storeAdmin(7, 200),
          now: NOW,
        }),
      ).resolves.toMatchObject({ scheduled: true });
      expect(subscriptionRow(db, subscription.id).cancel_at_period_end).toBe(
        true,
      );
    });

    it('superadmin cancela agora: faturas de períodos futuros são anuladas; a do período atual fica', async () => {
      const { db, plan, subscription, service } = setup();
      const current = seedInvoice(db, {
        subscription_id: subscription.id,
        store_id: 7,
        plan_id: plan.id,
        status: InvoiceStatus.PAID,
        paid_at: days(NOW, -9),
      });
      const future = seedInvoice(db, {
        subscription_id: subscription.id,
        store_id: 7,
        plan_id: plan.id,
        period_start: days(NOW, 20),
        period_end: days(NOW, 50),
        due_at: days(NOW, 20),
      });

      await service.cancel(subscription.id, {
        ...platform,
        atPeriodEnd: false,
        reason: 'Fraude',
      });

      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: CANCELED,
        canceled_at: NOW,
      });
      expect(invoiceRow(db, current.id).status).toBe(InvoiceStatus.PAID);
      expect(invoiceRow(db, future.id).status).toBe(InvoiceStatus.VOID);
      expect(eventTypes(db, subscription.id)).toEqual([
        'STATUS_CHANGED',
        'INVOICE_VOIDED',
      ]);
      await expect(
        service.cancel(subscription.id, { ...platform, atPeriodEnd: false }),
      ).rejects.toThrow(new ConflictException(SUBSCRIPTION_CANCELED_MESSAGE));
      await expect(service.resume(subscription.id, platform)).rejects.toThrow(
        SUBSCRIPTION_CANCELED_MESSAGE,
      );
    });

    it('cancelamento imediato pela plataforma exige motivo (também sem período a vencer); nada é gravado', async () => {
      const { db, plan, subscription, service } = setup();
      const future = seedInvoice(db, {
        subscription_id: subscription.id,
        store_id: 7,
        plan_id: plan.id,
        period_start: days(NOW, 20),
        period_end: days(NOW, 50),
        due_at: days(NOW, 20),
      });
      for (const reason of [undefined, null, '   ']) {
        await expect(
          service.cancel(subscription.id, {
            ...platform,
            atPeriodEnd: false,
            reason,
          }),
        ).rejects.toThrow(
          new BadRequestException(CANCEL_REASON_REQUIRED_MESSAGE),
        );
      }
      // "No fim do período" com o período já encerrado também cancela na hora
      await expect(
        service.cancel(subscription.id, {
          ...platform,
          atPeriodEnd: true,
          now: days(NOW, 60),
        }),
      ).rejects.toThrow(
        new BadRequestException(CANCEL_REASON_REQUIRED_MESSAGE),
      );
      expect(subscriptionRow(db, subscription.id).status).toBe(ACTIVE);
      expect(invoiceRow(db, future.id).status).toBe(InvoiceStatus.OPEN);
      expect(eventTypes(db, subscription.id)).toEqual([]);

      // Agendado com período a vencer: o motivo continua opcional
      await service.cancel(subscription.id, { ...platform, atPeriodEnd: true });
      expect(subscriptionRow(db, subscription.id).cancel_at_period_end).toBe(
        true,
      );
    });

    it('cancelamento agendado pela plataforma: a loja não desfaz (409); só o superpainel desfaz', async () => {
      const { db, subscription, service, audit } = setup();
      const tenant = tenantOf(db, 7);
      const ctx = { user: storeAdmin(7), now: NOW };

      await service.cancel(subscription.id, {
        ...platform,
        atPeriodEnd: true,
        reason: 'Encerramento contratual',
      });
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        cancel_at_period_end: true,
        cancel_scheduled_by: 'PLATFORM',
      });

      await expect(service.resumeForStore(tenant, ctx)).rejects.toThrow(
        new ConflictException(CANCEL_SCHEDULED_BY_PLATFORM_MESSAGE),
      );
      // A loja também não "assume" o agendamento pedindo o cancelamento de novo
      await service.cancelForStore(tenant, null, ctx);
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        cancel_at_period_end: true,
        cancel_scheduled_by: 'PLATFORM',
      });
      expect(eventTypes(db, subscription.id)).toEqual(['CANCEL_SCHEDULED']);

      await service.resume(subscription.id, platform);
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        cancel_at_period_end: false,
        cancel_scheduled_by: null,
      });
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'subscription.resume' }),
      );
    });

    it('agendado pela loja: fica com a origem STORE; a plataforma confirma o agendamento e passa a ser dona dele', async () => {
      const { db, subscription, service } = setup();
      const tenant = tenantOf(db, 7);
      const ctx = { user: storeAdmin(7), now: NOW };

      await service.cancelForStore(tenant, 'Vou fechar', ctx);
      expect(subscriptionRow(db, subscription.id).cancel_scheduled_by).toBe(
        'STORE',
      );
      await service.cancel(subscription.id, {
        ...platform,
        atPeriodEnd: true,
        reason: 'Encerramento confirmado pela plataforma',
      });
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        cancel_at_period_end: true,
        cancel_scheduled_by: 'PLATFORM',
      });
      expect(eventTypes(db, subscription.id)).toEqual([
        'CANCEL_SCHEDULED',
        'CANCEL_SCHEDULED',
      ]);
      await expect(service.resumeForStore(tenant, ctx)).rejects.toThrow(
        new ConflictException(CANCEL_SCHEDULED_BY_PLATFORM_MESSAGE),
      );
    });

    it('resume depois do fim do período → 409', async () => {
      const { db, subscription, service } = setup();
      await service.cancel(subscription.id, { ...platform, atPeriodEnd: true });
      await expect(
        service.resume(subscription.id, { ...platform, now: days(NOW, 21) }),
      ).rejects.toThrow(new ConflictException(PERIOD_ALREADY_ENDED_MESSAGE));
      expect(subscriptionRow(db, subscription.id).cancel_at_period_end).toBe(
        true,
      );
    });
  });

  describe('suspensão e reativação', () => {
    it('transições inválidas → 409 com mensagem (teste grátis não é suspenso)', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db);
      const trial = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        status: TRIALING,
        trial_ends_at: days(NOW, 5),
      });
      const { service } = createSubscriptionsService(db);

      await expect(
        service.suspend(trial.id, { ...platform, reason: 'Teste' }),
      ).rejects.toThrow(
        new ConflictException(
          'A assinatura não pode passar de "Em teste grátis" para "Suspensa".',
        ),
      );
      await expect(
        service.suspend(trial.id, { ...platform, reason: 'Teste' }),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(service.reactivate(trial.id, platform)).rejects.toThrow(
        new ConflictException(REACTIVATE_ONLY_BLOCKED_MESSAGE),
      );
      await expect(
        service.reactivate(trial.id, platform),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(eventTypes(db, trial.id)).toEqual([]);
    });

    it('suspensa por inadimplência (BILLING): o superadmin converte em suspensão da plataforma; pagamento e checkout não a desfazem', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        status: SUSPENDED,
        suspended_at: days(NOW, -2),
        suspended_by: 'BILLING',
      });
      const overdue = seedInvoice(db, {
        subscription_id: subscription.id,
        store_id: 7,
        plan_id: plan.id,
        due_at: days(NOW, -12),
      });
      const { service, audit } = createSubscriptionsService(db);

      await service.suspend(subscription.id, { ...platform, reason: 'Fraude' });
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: SUSPENDED,
        suspended_by: 'PLATFORM',
        suspended_at: days(NOW, -2),
      });
      const [event] = rowsWhere(db, 'subscription_events');
      expect(event).toMatchObject({
        type: 'STATUS_CHANGED',
        from_status: SUSPENDED,
        to_status: SUSPENDED,
        reason: 'Fraude',
        metadata: expect.objectContaining({
          trigger: 'platform.suspend',
          from_suspended_by: 'BILLING',
        }) as unknown,
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'subscription.suspend',
          metadata: expect.objectContaining({
            from: SUSPENDED,
            to: SUSPENDED,
            from_suspended_by: 'BILLING',
            reason: 'Fraude',
          }) as unknown,
        }),
      );

      // Pagamento posterior quita a fatura, mas não reativa
      await service.markInvoicePaid(
        overdue.id,
        { paymentMethod: 'PIX' },
        platform,
      );
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: SUSPENDED,
        suspended_by: 'PLATFORM',
      });
      // Já suspensa pela plataforma: repetir continua 409
      await expect(
        service.suspend(subscription.id, { ...platform, reason: 'De novo' }),
      ).rejects.toThrow('A assinatura já está na situação "Suspensa".');
    });

    it('suspende (motivo no histórico) e reativa quando não há fatura vencida', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
      });
      const { service, audit } = createSubscriptionsService(db);

      await service.suspend(subscription.id, {
        ...platform,
        reason: 'Uso indevido',
      });
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: SUSPENDED,
        suspended_at: NOW,
      });
      const [event] = rowsWhere(db, 'subscription_events');
      expect(event).toMatchObject({
        type: 'STATUS_CHANGED',
        from_status: ACTIVE,
        to_status: SUSPENDED,
        reason: 'Uso indevido',
      });
      await expect(
        service.suspend(subscription.id, { ...platform, reason: 'De novo' }),
      ).rejects.toThrow('A assinatura já está na situação "Suspensa".');

      await service.reactivate(subscription.id, platform);
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: ACTIVE,
        suspended_at: null,
        suspended_by: null,
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'subscription.reactivate' }),
      );
    });

    it('suspensão pela plataforma: pagamento aprovado quita a fatura mas não reativa; checkout da loja → 409', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
      });
      const open = seedInvoice(db, {
        subscription_id: subscription.id,
        store_id: 7,
        plan_id: plan.id,
        due_at: days(NOW, 3),
      });
      const { service, providers } = createSubscriptionsService(db);

      await service.suspend(subscription.id, {
        ...platform,
        reason: 'Bloqueio administrativo',
      });
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: SUSPENDED,
        suspended_by: 'PLATFORM',
      });

      // Pagamento registrado (ou cobrança automática): a fatura é quitada, a suspensão continua
      await service.markInvoicePaid(
        open.id,
        { paymentMethod: 'PIX' },
        platform,
      );
      expect(invoiceRow(db, open.id).status).toBe(InvoiceStatus.PAID);
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: SUSPENDED,
        suspended_by: 'PLATFORM',
      });
      await expect(
        service.applyProviderPayment(
          subscription.id,
          { providerPaymentId: 'mp-77', amount: Number(plan.price) },
          NOW,
        ),
      ).resolves.toMatchObject({ result: expect.any(String) as unknown });
      expect(subscriptionRow(db, subscription.id).status).toBe(SUSPENDED);

      // A loja não abre cobrança nova enquanto a plataforma mantiver a suspensão
      providers.checkoutProvider.mockReturnValue({
        code: 'MERCADO_PAGO',
        online: true,
        createCheckout: jest.fn(),
      });
      await expect(
        service.checkoutForStore(tenantOf(db, 7), {
          user: storeAdmin(7),
          now: NOW,
        }),
      ).rejects.toThrow(
        new ConflictException(PLATFORM_SUSPENSION_CHECKOUT_MESSAGE),
      );

      // Só o superadmin desfaz
      await service.reactivate(subscription.id, platform);
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: ACTIVE,
        suspended_by: null,
      });
    });

    it('suspensão por inadimplência (rotina): pagar as faturas vencidas reativa sozinho', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      seedSettings(db);
      const plan = seedPlan(db);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        status: PAST_DUE,
        past_due_since: days(NOW, -10),
        grace_period_ends_at: days(NOW, -1),
      });
      const overdue = seedInvoice(db, {
        subscription_id: subscription.id,
        store_id: 7,
        plan_id: plan.id,
        due_at: days(NOW, -10),
      });
      const { service } = createSubscriptionsService(db);

      await expect(service.processGraceEnd(subscription.id, NOW)).resolves.toBe(
        'suspended',
      );
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: SUSPENDED,
        suspended_by: 'BILLING',
      });
      await service.markInvoicePaid(
        overdue.id,
        { paymentMethod: 'PIX' },
        platform,
      );
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: ACTIVE,
        suspended_at: null,
        suspended_by: null,
      });
    });

    it('fatura vencida em aberto: 409 sem force; force exige motivo e renegocia o vencimento', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        status: SUSPENDED,
        past_due_since: days(NOW, -10),
        grace_period_ends_at: days(NOW, -3),
        suspended_at: days(NOW, -3),
      });
      const overdue = seedInvoice(db, {
        subscription_id: subscription.id,
        store_id: 7,
        plan_id: plan.id,
        due_at: days(NOW, -10),
      });
      const { service } = createSubscriptionsService(db);

      const error = (await service
        .reactivate(subscription.id, platform)
        .catch((caught: unknown) => caught)) as HttpException;
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({
        message: OVERDUE_INVOICES_MESSAGE,
        overdue_invoices: [overdue.id],
      });
      await expect(
        service.reactivate(subscription.id, { ...platform, force: true }),
      ).rejects.toThrow(new BadRequestException(FORCE_REASON_REQUIRED_MESSAGE));

      await service.reactivate(subscription.id, {
        ...platform,
        force: true,
        reason: 'Acordo de pagamento',
      });
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: ACTIVE,
        past_due_since: null,
        grace_period_ends_at: null,
        suspended_at: null,
      });
      // Continua devida, com vencimento novo: a tolerância volta a contar de agora
      expect(invoiceRow(db, overdue.id)).toMatchObject({
        status: InvoiceStatus.OPEN,
        due_at: NOW,
      });
      expect(eventTypes(db, subscription.id)).toEqual([
        'INVOICE_RESCHEDULED',
        'STATUS_CHANGED',
      ]);
    });
  });

  describe('faturas', () => {
    function pastDue() {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        status: PAST_DUE,
        past_due_since: days(NOW, -10),
        grace_period_ends_at: days(NOW, -3),
      });
      const invoice = seedInvoice(db, {
        subscription_id: subscription.id,
        store_id: 7,
        plan_id: plan.id,
        due_at: days(NOW, -10),
      });
      return {
        db,
        plan,
        subscription,
        invoice,
        ...createSubscriptionsService(db),
      };
    }

    it('mark-paid: PAST_DUE → ACTIVE limpando atraso e tolerância; idempotente', async () => {
      const { db, subscription, invoice, service, audit } = pastDue();

      const paid = await service.markInvoicePaid(
        invoice.id,
        { paymentMethod: 'PIX', providerPaymentId: 'E123' },
        platform,
      );
      expect(paid).toMatchObject({
        status: InvoiceStatus.PAID,
        paid_at: NOW,
        payment_method: 'PIX',
        provider_payment_id: 'E123',
      });
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: ACTIVE,
        past_due_since: null,
        grace_period_ends_at: null,
      });
      expect(eventTypes(db, subscription.id)).toEqual([
        'PAYMENT_SUCCEEDED',
        'STATUS_CHANGED',
      ]);
      expect(audit.record).toHaveBeenCalledTimes(1);

      // Repetido (mesmo pagamento ou sem identificador): nada muda
      await expect(
        service.markInvoicePaid(
          invoice.id,
          { providerPaymentId: 'E123' },
          platform,
        ),
      ).resolves.toMatchObject({ status: InvoiceStatus.PAID });
      await service.markInvoicePaid(invoice.id, {}, platform);
      expect(eventTypes(db, subscription.id)).toHaveLength(2);
      expect(audit.record).toHaveBeenCalledTimes(1);
    });

    it('mark-paid recusa data de pagamento no futuro (com folga para o relógio)', async () => {
      const { db, invoice, service, audit } = pastDue();
      await expect(
        service.markInvoicePaid(
          invoice.id,
          { paidAt: new Date(NOW.getTime() + PAID_AT_CLOCK_SKEW_MS + 1000) },
          platform,
        ),
      ).rejects.toThrow(new BadRequestException(PAID_AT_IN_FUTURE_MESSAGE));
      expect(audit.record).not.toHaveBeenCalled();
      expect(invoiceRow(db, invoice.id)).toMatchObject({
        status: InvoiceStatus.OPEN,
      });

      // Dentro da folga (relógio levemente adiantado): aceito
      await expect(
        service.markInvoicePaid(
          invoice.id,
          { paidAt: new Date(NOW.getTime() + 60_000) },
          platform,
        ),
      ).resolves.toMatchObject({ status: InvoiceStatus.PAID });
    });

    it('o mesmo pagamento nunca quita duas faturas; fatura anulada não é paga', async () => {
      const { db, plan, subscription, invoice, service } = pastDue();
      const second = seedInvoice(db, {
        subscription_id: subscription.id,
        store_id: 7,
        plan_id: plan.id,
        period_start: days(NOW, 20),
        period_end: days(NOW, 50),
        due_at: days(NOW, 20),
      });
      await service.markInvoicePaid(
        invoice.id,
        { providerPaymentId: 'E123' },
        platform,
      );
      await expect(
        service.markInvoicePaid(
          second.id,
          { providerPaymentId: 'E123' },
          platform,
        ),
      ).rejects.toThrow(new ConflictException(PROVIDER_PAYMENT_USED_MESSAGE));

      await service.voidInvoice(second.id, { reason: 'Erro' }, platform);
      await expect(
        service.markInvoicePaid(second.id, {}, platform),
      ).rejects.toThrow(new ConflictException(INVOICE_VOID_MESSAGE));
    });

    it('fatura do período seguinte já iniciado avança o período', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        current_period_start: days(NOW, -35),
        current_period_end: days(NOW, -5),
      });
      const next = seedInvoice(db, {
        subscription_id: subscription.id,
        store_id: 7,
        plan_id: plan.id,
        period_start: days(NOW, -5),
        period_end: days(NOW, 25),
        due_at: days(NOW, -5),
      });
      const { service } = createSubscriptionsService(db);

      await service.markInvoicePaid(next.id, {}, platform);

      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: ACTIVE,
        current_period_start: days(NOW, -5),
        current_period_end: days(NOW, 25),
      });
    });

    it('suspensa com o período encerrado: o pagamento reativa e abre um período novo (com fatura)', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        status: SUSPENDED,
        current_period_start: days(NOW, -60),
        current_period_end: days(NOW, -30),
        suspended_at: days(NOW, -40),
      });
      const overdue = seedInvoice(db, {
        subscription_id: subscription.id,
        store_id: 7,
        plan_id: plan.id,
        period_start: days(NOW, -60),
        period_end: days(NOW, -30),
        due_at: days(NOW, -60),
      });
      const { service } = createSubscriptionsService(db);

      await service.markInvoicePaid(overdue.id, {}, platform);

      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        status: ACTIVE,
        suspended_at: null,
        current_period_start: NOW,
        current_period_end: at('2026-11-11T12:00:00.000Z'),
      });
      const fresh = rowsWhere(
        db,
        'subscription_invoices',
        (row) => row.id !== overdue.id,
      );
      expect(fresh).toEqual([
        expect.objectContaining({
          status: InvoiceStatus.OPEN,
          period_start: NOW,
          due_at: NOW,
        }),
      ]);
    });

    it('mark-failed: FAILED com +1 tentativa; paga não pode ser recusada', async () => {
      const { db, subscription, invoice, service } = pastDue();

      await service.markInvoiceFailed(
        invoice.id,
        { reason: 'Cartão recusado' },
        platform,
      );
      await service.markInvoiceFailed(invoice.id, {}, platform);
      expect(invoiceRow(db, invoice.id)).toMatchObject({
        status: InvoiceStatus.FAILED,
        attempts: 2,
      });
      expect(eventTypes(db, subscription.id)).toEqual([
        'PAYMENT_FAILED',
        'PAYMENT_FAILED',
      ]);

      // Recusada continua cobrável
      await service.markInvoicePaid(invoice.id, {}, platform);
      await expect(
        service.markInvoiceFailed(invoice.id, {}, platform),
      ).rejects.toThrow(ConflictException);
    });

    it('void: anula a fatura e a assinatura em atraso sem outra fatura vencida volta a ACTIVE', async () => {
      const { db, subscription, invoice, service } = pastDue();

      await service.voidInvoice(invoice.id, { reason: 'Cortesia' }, platform);
      expect(invoiceRow(db, invoice.id)).toMatchObject({
        status: InvoiceStatus.VOID,
        notes: 'Cortesia',
      });
      expect(subscriptionRow(db, subscription.id).status).toBe(ACTIVE);
      // Idempotente
      await service.voidInvoice(invoice.id, {}, platform);
      expect(eventTypes(db, subscription.id)).toEqual([
        'INVOICE_VOIDED',
        'STATUS_CHANGED',
      ]);
    });

    it('void de fatura paga → 409; fatura de outra assinatura/inexistente → 404', async () => {
      const { invoice, service } = pastDue();
      await service.markInvoicePaid(invoice.id, {}, platform);
      await expect(
        service.voidInvoice(invoice.id, {}, platform),
      ).rejects.toThrow(new ConflictException(INVOICE_PAID_VOID_MESSAGE));
      await expect(service.voidInvoice(999, {}, platform)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('fatura avulsa: período atual sem fatura, depois o seguinte; período repetido → 409', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db, { price: 59.9 });
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
      });
      const { service } = createSubscriptionsService(db);

      const current = await service.createInvoice(
        subscription.id,
        {},
        platform,
      );
      expect(current).toMatchObject({
        amount: 59.9,
        period_start: subscription.current_period_start,
        period_end: subscription.current_period_end,
        // O período já começou: vence agora
        due_at: NOW,
      });
      const next = await service.createInvoice(subscription.id, {}, platform);
      expect(next).toMatchObject({
        period_start: subscription.current_period_end,
        due_at: subscription.current_period_end,
      });
      await expect(
        service.createInvoice(
          subscription.id,
          {
            period_start: subscription.current_period_end!,
            period_end: days(NOW, 50),
          },
          platform,
        ),
      ).rejects.toThrow(new ConflictException(INVOICE_PERIOD_EXISTS_MESSAGE));
      await expect(
        service.createInvoice(
          subscription.id,
          { period_start: days(NOW, 1) },
          platform,
        ),
      ).rejects.toThrow(
        new BadRequestException(INVOICE_PERIOD_REQUIRED_MESSAGE),
      );
    });

    it('fatura avulsa de plano gratuito exige o valor', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const free = seedPlan(db, { price: 0 });
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: free.id,
        current_period_end: null,
      });
      const { service } = createSubscriptionsService(db);

      await expect(
        service.createInvoice(subscription.id, {}, platform),
      ).rejects.toThrow(new BadRequestException(FREE_PLAN_INVOICE_MESSAGE));
      await expect(
        service.createInvoice(subscription.id, { amount: 150 }, platform),
      ).resolves.toMatchObject({ amount: 150, period_start: NOW });
    });
  });

  describe('provedor (webhook)', () => {
    function setup(status = PAST_DUE) {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        status,
        billing_provider: 'MERCADO_PAGO',
        provider_subscription_id: 'pre-1',
        provider_status: 'authorized',
        ...(status === PAST_DUE
          ? {
              past_due_since: days(NOW, -2),
              grace_period_ends_at: days(NOW, 5),
            }
          : {}),
      });
      return { db, plan, subscription, ...createSubscriptionsService(db) };
    }

    it('pagamento aprovado quita a fatura em aberto mais antiga; repetido não paga de novo', async () => {
      const { db, plan, subscription, service, audit } = setup();
      const older = seedInvoice(db, {
        subscription_id: subscription.id,
        store_id: 7,
        plan_id: plan.id,
        due_at: days(NOW, -2),
      });

      await expect(
        service.applyProviderPayment(
          subscription.id,
          { providerPaymentId: '555', amount: 99.9 },
          NOW,
        ),
      ).resolves.toEqual({ result: 'paid', invoiceId: older.id });
      expect(invoiceRow(db, older.id)).toMatchObject({
        status: InvoiceStatus.PAID,
        provider_payment_id: '555',
        billing_provider: 'MERCADO_PAGO',
      });
      expect(subscriptionRow(db, subscription.id).status).toBe(ACTIVE);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'subscription.invoice.mark_paid',
          scope: 'SYSTEM',
        }),
      );

      await expect(
        service.applyProviderPayment(
          subscription.id,
          { providerPaymentId: '555', amount: 99.9 },
          NOW,
        ),
      ).resolves.toEqual({ result: 'duplicate', invoiceId: null });
      expect(
        rowsWhere(db, 'subscription_invoices', (row) => row.status === 'PAID'),
      ).toHaveLength(1);
    });

    it('cobrado antes da renovação: cria e quita a fatura do próximo período sem avançar antes da hora', async () => {
      const { db, subscription, service } = setup(ACTIVE);

      const result = await service.applyProviderPayment(
        subscription.id,
        { providerPaymentId: '777', amount: 99.9 },
        NOW,
      );

      expect(result.result).toBe('paid');
      expect(invoiceRow(db, result.invoiceId!)).toMatchObject({
        status: InvoiceStatus.PAID,
        period_start: subscription.current_period_end,
      });
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        current_period_end: subscription.current_period_end,
      });
    });

    it('valor menor que a fatura não quita; assinatura cancelada só registra para conferência', async () => {
      const { db, plan, subscription, service, audit } = setup();
      const invoice = seedInvoice(db, {
        subscription_id: subscription.id,
        store_id: 7,
        plan_id: plan.id,
      });

      await expect(
        service.applyProviderPayment(
          subscription.id,
          { providerPaymentId: '1', amount: 49.9 },
          NOW,
        ),
      ).resolves.toEqual({ result: 'amount_mismatch', invoiceId: invoice.id });
      expect(invoiceRow(db, invoice.id).status).toBe(InvoiceStatus.OPEN);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ result: 'FAILURE' }),
      );

      await service.cancel(subscription.id, {
        ...platform,
        atPeriodEnd: false,
        reason: 'Encerramento do contrato',
      });
      await expect(
        service.applyProviderPayment(
          subscription.id,
          { providerPaymentId: '2', amount: 99.9 },
          NOW,
        ),
      ).resolves.toEqual({ result: 'subscription_canceled', invoiceId: null });
      expect(eventTypes(db, subscription.id)).toContain('PAYMENT_AFTER_CANCEL');
    });

    it('recusa conta uma tentativa por pagamento (notificação repetida não conta de novo)', async () => {
      const { db, plan, subscription, service } = setup();
      const invoice = seedInvoice(db, {
        subscription_id: subscription.id,
        store_id: 7,
        plan_id: plan.id,
      });

      await expect(
        service.applyProviderFailure(subscription.id, {
          providerPaymentId: '9',
          reason: 'cc_rejected_insufficient_amount',
        }),
      ).resolves.toBe('failed');
      await expect(
        service.applyProviderFailure(subscription.id, {
          providerPaymentId: '9',
        }),
      ).resolves.toBe('duplicate');
      expect(invoiceRow(db, invoice.id)).toMatchObject({
        status: InvoiceStatus.FAILED,
        attempts: 1,
        failure_reason: 'cc_rejected_insufficient_amount',
      });
    });

    it('situação da preapproval: atualiza a atual e ignora autorização antiga', async () => {
      const { db, subscription, service } = setup(ACTIVE);

      await expect(
        service.applyProviderStatus(subscription.id, {
          providerSubscriptionId: 'pre-1',
          providerStatus: 'paused',
        }),
      ).resolves.toBe('updated');
      await expect(
        service.applyProviderStatus(subscription.id, {
          providerSubscriptionId: 'pre-1',
          providerStatus: 'paused',
        }),
      ).resolves.toBe('unchanged');
      // Outra preapproval só é assumida se foi autorizada e a atual não está
      await expect(
        service.applyProviderStatus(subscription.id, {
          providerSubscriptionId: 'pre-velha',
          providerStatus: 'pending',
        }),
      ).resolves.toBe('ignored');
      await expect(
        service.applyProviderStatus(subscription.id, {
          providerSubscriptionId: 'pre-2',
          providerStatus: 'authorized',
        }),
      ).resolves.toBe('updated');
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        provider_subscription_id: 'pre-2',
        provider_status: 'authorized',
      });
    });
  });

  describe('checkout da loja', () => {
    afterEach(() => jest.useRealTimers());

    function setup(overrides: Partial<Subscription> = {}, price = 99.9) {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db, { price });
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        ...overrides,
      });
      const services = createSubscriptionsService(db);
      const provider = {
        code: 'MERCADO_PAGO' as const,
        online: true,
        createCheckout: jest.fn().mockResolvedValue({
          checkout_url:
            'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=pre-1',
          provider_subscription_id: 'pre-1',
          provider_status: 'pending',
        }),
        cancelSubscription: jest.fn(),
        updateAmount: jest.fn(),
      };
      services.providers.checkoutProvider.mockReturnValue(provider);
      return { db, plan, subscription, provider, ...services };
    }

    it('sem provedor online configurado → 409 com a mensagem de indisponível', async () => {
      const { db, service, providers } = setup();
      providers.checkoutProvider.mockImplementation(() => {
        throw new ConflictException(ONLINE_BILLING_UNAVAILABLE_MESSAGE);
      });
      await expect(
        service.checkoutForStore(tenantOf(db, 7), { user: storeAdmin(7) }),
      ).rejects.toThrow(ONLINE_BILLING_UNAVAILABLE_MESSAGE);
    });

    it('cria a autorização no provedor (início no fim do período pago) e reaproveita o link pendente', async () => {
      const { db, subscription, provider, service, audit } = setup();
      const tenant = tenantOf(db, 7);

      const result = await service.checkoutForStore(tenant, {
        user: storeAdmin(7),
        now: NOW,
      });

      expect(result).toEqual({
        checkout_url:
          'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=pre-1',
        provider: 'MERCADO_PAGO',
        provider_status: 'pending',
      });
      expect(provider.createCheckout).toHaveBeenCalledWith(
        expect.objectContaining({ id: subscription.id }),
        expect.objectContaining({ price: 99.9 }),
        tenant.store,
        'admin@loja7.com',
        { startDate: subscription.current_period_end },
      );
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        billing_provider: 'MERCADO_PAGO',
        provider_subscription_id: 'pre-1',
        provider_status: 'pending',
      });
      expect(eventTypes(db, subscription.id)).toEqual(['CHECKOUT_CREATED']);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'subscription.checkout',
          storeId: 7,
        }),
      );

      await service.checkoutForStore(tenant, { user: storeAdmin(7) });
      expect(provider.createCheckout).toHaveBeenCalledTimes(1);
    });

    it('com fatura em aberto cobra ao autorizar (sem data de início)', async () => {
      const { db, plan, subscription, provider, service } = setup();
      seedInvoice(db, {
        subscription_id: subscription.id,
        store_id: 7,
        plan_id: plan.id,
      });
      await service.checkoutForStore(tenantOf(db, 7), { user: storeAdmin(7) });
      expect(provider.createCheckout).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        'admin@loja7.com',
        { startDate: null },
      );
    });

    it('checkouts simultâneos: com a trava ocupada espera FORA da transação e reaproveita o link criado pelo outro', async () => {
      jest.useFakeTimers();
      const { db, subscription, provider, service } = setup();
      const tenant = tenantOf(db, 7);
      const transaction = jest.spyOn(db.manager, 'transaction');
      let tries = 0;
      // Duas tentativas com a trava ocupada (outro pedido da loja falando com o provedor); na terceira,
      // a autorização do outro já está gravada
      db.onRawQuery = (sql) => {
        if (!sql.includes('pg_try_advisory_xact_lock')) return;
        tries += 1;
        if (tries < 3) return [{ locked: false }];
        const row = db
          .table('subscriptions')
          .find((item) => item.id === subscription.id);
        Object.assign(row ?? {}, {
          billing_provider: 'MERCADO_PAGO',
          provider_subscription_id: 'pre-concorrente',
          provider_status: 'pending',
          provider_checkout_url: 'https://mp.example/checkout/pre-concorrente',
        });
        return [{ locked: true }];
      };

      const pending = service.checkoutForStore(tenant, {
        user: storeAdmin(7),
        now: NOW,
      });
      await jest.advanceTimersByTimeAsync(CHECKOUT_LOCK_RETRY_MS * 2);
      const result = await pending;
      expect(result.checkout_url).toBe(
        'https://mp.example/checkout/pre-concorrente',
      );
      expect(provider.createCheckout).not.toHaveBeenCalled();
      // Uma transação curta por tentativa: nenhuma conexão fica parada na fila da trava
      expect(transaction).toHaveBeenCalledTimes(3);
      expect(db.rawQueries).toEqual(
        Array.from({ length: 3 }, (): unknown =>
          expect.objectContaining({
            sql: expect.stringContaining(
              'pg_try_advisory_xact_lock',
            ) as unknown,
            params: ['subscription-checkout:7'],
          }),
        ),
      );
    });

    it('trava ocupada por mais de ~3 s (provedor lento) → 409 sem chamar o provedor', async () => {
      jest.useFakeTimers();
      const { db, provider, service } = setup();
      const transaction = jest.spyOn(db.manager, 'transaction');
      db.onRawQuery = (sql) =>
        sql.includes('pg_try_advisory_xact_lock')
          ? [{ locked: false }]
          : undefined;

      const outcome = service
        .checkoutForStore(tenantOf(db, 7), { user: storeAdmin(7), now: NOW })
        .catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(
        CHECKOUT_LOCK_RETRY_MS * CHECKOUT_LOCK_ATTEMPTS,
      );
      await expect(outcome).resolves.toEqual(
        new ConflictException(CHECKOUT_IN_PROGRESS_MESSAGE),
      );
      expect(transaction).toHaveBeenCalledTimes(CHECKOUT_LOCK_ATTEMPTS);
      expect(provider.createCheckout).not.toHaveBeenCalled();
    });

    it('plano gratuito → 400; cobrança já autorizada → 409', async () => {
      const free = setup({}, 0);
      await expect(
        free.service.checkoutForStore(tenantOf(free.db, 7), {
          user: storeAdmin(7),
        }),
      ).rejects.toThrow(new BadRequestException(FREE_PLAN_CHECKOUT_MESSAGE));

      const authorized = setup({
        billing_provider: 'MERCADO_PAGO',
        provider_subscription_id: 'pre-9',
        provider_status: 'authorized',
      });
      await expect(
        authorized.service.checkoutForStore(tenantOf(authorized.db, 7), {
          user: storeAdmin(7),
        }),
      ).rejects.toThrow(
        new ConflictException(CHECKOUT_ALREADY_AUTHORIZED_MESSAGE),
      );
    });
  });

  describe('sincronização com o provedor', () => {
    it('cancelamento agendado interrompe a cobrança recorrente no provedor', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        billing_provider: 'MERCADO_PAGO',
        provider_subscription_id: 'pre-1',
        provider_status: 'authorized',
      });
      const { service, providers } = createSubscriptionsService(db);
      const provider = {
        online: true,
        cancelSubscription: jest.fn().mockResolvedValue(undefined),
      };
      providers.forCode.mockReturnValue(provider);

      await service.cancelForStore(tenantOf(db, 7), null, {
        user: storeAdmin(7),
        now: NOW,
      });

      expect(provider.cancelSubscription).toHaveBeenCalledWith('pre-1');
      expect(subscriptionRow(db, subscription.id).provider_status).toBe(
        'cancelled',
      );
      expect(eventTypes(db, subscription.id)).toEqual([
        'CANCEL_SCHEDULED',
        'PROVIDER_STATUS_CHANGED',
      ]);
    });

    it('cobrança recebida depois do cancelamento: interrompe de novo a cobrança recorrente no provedor (a de antes falhou)', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        status: CANCELED,
        canceled_at: days(NOW, -30),
        billing_provider: 'MERCADO_PAGO',
        provider_subscription_id: 'pre-1',
        provider_status: 'authorized',
      });
      const { service, providers } = createSubscriptionsService(db);
      const provider = {
        online: true,
        cancelSubscription: jest.fn().mockResolvedValue(undefined),
      };
      providers.forCode.mockReturnValue(provider);

      const paid = await service.applyProviderPayment(
        subscription.id,
        {
          providerPaymentId: 'pay-77',
          amount: 99.9,
          providerSubscriptionId: 'pre-1',
        },
        NOW,
      );
      expect(paid.result).toBe('subscription_canceled');
      expect(provider.cancelSubscription).toHaveBeenCalledWith('pre-1');
      expect(subscriptionRow(db, subscription.id).provider_status).toBe(
        'cancelled',
      );
      expect(eventTypes(db, subscription.id)).toEqual([
        'PAYMENT_AFTER_CANCEL',
        'PROVIDER_STATUS_CHANGED',
      ]);
    });

    it('cobrança de outra autorização (órfã) da mesma assinatura: a órfã é cancelada no provedor', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        billing_provider: 'MERCADO_PAGO',
        provider_subscription_id: 'pre-2',
        provider_status: 'authorized',
      });
      seedInvoice(db, {
        subscription_id: subscription.id,
        store_id: 7,
        plan_id: plan.id,
      });
      const { service, providers } = createSubscriptionsService(db);
      const provider = {
        online: true,
        cancelSubscription: jest.fn().mockResolvedValue(undefined),
      };
      providers.forCode.mockReturnValue(provider);

      await service.applyProviderPayment(
        subscription.id,
        {
          providerPaymentId: 'pay-orfa',
          amount: 99.9,
          providerSubscriptionId: 'pre-1',
        },
        NOW,
      );
      expect(provider.cancelSubscription).toHaveBeenCalledTimes(1);
      expect(provider.cancelSubscription).toHaveBeenCalledWith('pre-1');
      // A autorização registrada continua valendo
      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        provider_subscription_id: 'pre-2',
        provider_status: 'authorized',
      });
      const orphanEvent = rowsWhere(
        db,
        'subscription_events',
        (row) => row.type === 'PROVIDER_STATUS_CHANGED',
      )[0];
      expect(orphanEvent.metadata).toMatchObject({
        provider_subscription_id: 'pre-1',
        to: 'cancelled',
        orphan: true,
      });
    });

    it('rotina: tenta de novo cancelar no provedor as assinaturas canceladas ainda ativas lá (com intervalo crescente)', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        status: CANCELED,
        canceled_at: days(NOW, -1),
        billing_provider: 'MERCADO_PAGO',
        provider_subscription_id: 'pre-1',
        provider_status: 'authorized',
      });
      const { service, providers } = createSubscriptionsService(db);
      const cancelSubscription = jest
        .fn()
        .mockRejectedValueOnce({ status: 500, message: 'internal_error' })
        .mockResolvedValue(undefined);
      providers.forCode.mockReturnValue({ online: true, cancelSubscription });

      // 1ª tentativa falha: evento de falha
      await expect(
        service.retryProviderCancellation(subscription.id, NOW),
      ).resolves.toBeNull();
      expect(eventTypes(db, subscription.id)).toEqual(['PROVIDER_SYNC_FAILED']);
      // Logo depois: ainda no intervalo, não tenta
      await service.retryProviderCancellation(
        subscription.id,
        new Date(NOW.getTime() + 10 * 60_000),
      );
      expect(cancelSubscription).toHaveBeenCalledTimes(1);
      // Passado o intervalo: tenta e conclui
      await expect(
        service.retryProviderCancellation(
          subscription.id,
          new Date(NOW.getTime() + 2 * 60 * 60_000),
        ),
      ).resolves.toBe('provider_canceled');
      expect(cancelSubscription).toHaveBeenCalledTimes(2);
      expect(subscriptionRow(db, subscription.id).provider_status).toBe(
        'cancelled',
      );
      // Concluído: nada mais a fazer
      await expect(
        service.retryProviderCancellation(subscription.id, days(NOW, 2)),
      ).resolves.toBeNull();
      expect(cancelSubscription).toHaveBeenCalledTimes(2);
    });

    it('falha no provedor não desfaz o cancelamento: vira evento e auditoria de falha', async () => {
      const db = createBillingDb();
      seedStore(db, { id: 7 });
      const plan = seedPlan(db);
      const subscription = seedSubscription(db, {
        store_id: 7,
        plan_id: plan.id,
        billing_provider: 'MERCADO_PAGO',
        provider_subscription_id: 'pre-1',
        provider_status: 'authorized',
      });
      const { service, providers, audit } = createSubscriptionsService(db);
      providers.forCode.mockReturnValue({
        online: true,
        cancelSubscription: jest
          .fn()
          .mockRejectedValue({ status: 500, message: 'internal_error' }),
      });

      await service.cancelForStore(tenantOf(db, 7), null, {
        user: storeAdmin(7),
        now: NOW,
      });

      expect(subscriptionRow(db, subscription.id)).toMatchObject({
        cancel_at_period_end: true,
        provider_status: 'authorized',
      });
      expect(eventTypes(db, subscription.id)).toEqual([
        'CANCEL_SCHEDULED',
        'PROVIDER_SYNC_FAILED',
      ]);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'subscription.provider_sync',
          result: 'FAILURE',
        }),
      );
    });
  });

  it('operações do superpainel recusam (403) usuário que não é superadmin, mesmo fora da rota', async () => {
    const db = createBillingDb();
    seedStore(db, { id: 7 });
    const plan = seedPlan(db);
    const other = seedPlan(db);
    const subscription = seedSubscription(db, {
      store_id: 7,
      plan_id: plan.id,
    });
    const invoice = seedInvoice(db, {
      subscription_id: subscription.id,
      store_id: 7,
      plan_id: plan.id,
    });
    const { service } = createSubscriptionsService(db);
    const admin = { user: storeAdmin(7), now: NOW };
    const forbidden = new ForbiddenException(PLATFORM_ONLY_MESSAGE);

    await expect(
      service.changePlan(subscription.id, other.id, admin),
    ).rejects.toThrow(forbidden);
    await expect(
      service.suspend(subscription.id, { ...admin, reason: 'x' }),
    ).rejects.toThrow(forbidden);
    await expect(service.reactivate(subscription.id, admin)).rejects.toThrow(
      forbidden,
    );
    // Sem a loja do contexto (storeId), cancelar/desfazer é operação da plataforma
    await expect(
      service.cancel(subscription.id, { ...admin, atPeriodEnd: false }),
    ).rejects.toThrow(forbidden);
    await expect(service.resume(subscription.id, admin)).rejects.toThrow(
      forbidden,
    );
    await expect(
      service.createInvoice(subscription.id, {}, admin),
    ).rejects.toThrow(forbidden);
    for (const action of [
      () => service.markInvoicePaid(invoice.id, {}, admin),
      () => service.markInvoiceFailed(invoice.id, {}, admin),
      () => service.voidInvoice(invoice.id, {}, admin),
    ]) {
      await expect(action()).rejects.toThrow(forbidden);
    }
    expect(eventTypes(db, subscription.id)).toEqual([]);
    expect(subscriptionRow(db, subscription.id).status).toBe(ACTIVE);
  });

  it('a loja suspensa pela plataforma continua podendo consultar e regularizar (contexto)', () => {
    // A capacidade "billing" é liberada pelo store-access mesmo com a loja suspensa
    const access = storeAccessState(
      { account_status: StoreAccountStatus.SUSPENDED },
      { status: SUSPENDED },
    );
    expect(access.canManageBilling).toBe(true);
    expect(access.canSell).toBe(false);
  });
});
