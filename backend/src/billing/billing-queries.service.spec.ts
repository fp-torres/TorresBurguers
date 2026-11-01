import { BillingQueriesService } from './billing-queries.service';
import { SubscriptionEvent } from './entities/subscription-event.entity';
import { SubscriptionInvoice } from './entities/subscription-invoice.entity';
import {
  Subscription,
  SubscriptionStatus,
} from './entities/subscription.entity';
import {
  createBillingDb,
  days,
  fakeProviders,
  NOW,
  seedPlan,
  seedStore,
  seedSubscription,
  ZERO_USAGE,
} from './testing/billing-fixtures.helper-spec';
import type { FakeDb } from './testing/fake-db.helper-spec';

const { ACTIVE, CANCELED } = SubscriptionStatus;

const MB = 1024 * 1024;
const STORAGE = { bytes: 3.5 * MB, files: 12, measuredAt: NOW };

function createQueries(db: FakeDb, storage: unknown = STORAGE) {
  return new BillingQueriesService(
    db.repository(Subscription) as never,
    db.repository(SubscriptionInvoice) as never,
    db.repository(SubscriptionEvent) as never,
    {
      usage: jest.fn().mockResolvedValue(ZERO_USAGE),
      storageUsage: jest.fn().mockResolvedValue(storage),
    } as never,
    fakeProviders() as never,
  );
}

describe('BillingQueriesService.subscriptionDetail (superpainel)', () => {
  it('assinatura antiga cancelada: situação da loja pela assinatura vigente e sem limites', async () => {
    const db = createBillingDb();
    seedStore(db, { id: 7 });
    const oldPlan = seedPlan(db, { max_products: 5 });
    const plan = seedPlan(db, { max_products: 50 });
    const old = seedSubscription(db, {
      store_id: 7,
      plan_id: oldPlan.id,
      status: CANCELED,
      canceled_at: days(NOW, -30),
      current_period_end: days(NOW, -30),
    });
    const current = seedSubscription(db, {
      store_id: 7,
      plan_id: plan.id,
      status: ACTIVE,
    });
    const queries = createQueries(db);

    const oldDetail = await queries.subscriptionDetail(old.id, NOW);
    expect(oldDetail.status).toBe(CANCELED);
    // Os limites da assinatura cancelada não valem mais para a loja
    expect(oldDetail.limits).toBeNull();
    // A loja continua vendendo pela assinatura vigente (antes aparecia como cancelada)
    expect(oldDetail.access).toMatchObject({
      availability: 'OPERATIONAL',
      canSell: true,
    });

    const currentDetail = await queries.subscriptionDetail(current.id, NOW);
    expect(currentDetail.limits).toMatchObject({ products: 50 });
    expect(currentDetail.access).toMatchObject({ availability: 'OPERATIONAL' });
  });

  it('loja sem assinatura vigente: a última cancelada bloqueia as vendas e não tem limites', async () => {
    const db = createBillingDb();
    seedStore(db, { id: 8 });
    const plan = seedPlan(db);
    const last = seedSubscription(db, {
      store_id: 8,
      plan_id: plan.id,
      status: CANCELED,
      canceled_at: days(NOW, -1),
    });

    const detail = await createQueries(db).subscriptionDetail(last.id, NOW);
    expect(detail.limits).toBeNull();
    expect(detail.access).toMatchObject({
      availability: 'SUBSCRIPTION_CANCELED',
      canSell: false,
    });
  });
});

describe('BillingQueriesService — armazenamento (storage)', () => {
  it('painel da loja e superpainel: uso medido × max_storage_mb do plano vigente (sem mudar usage/limits)', async () => {
    const db = createBillingDb();
    const store = seedStore(db, { id: 9 });
    const plan = seedPlan(db, { max_products: 50, max_storage_mb: 10 });
    const current = seedSubscription(db, {
      store_id: 9,
      plan_id: plan.id,
      status: ACTIVE,
    });
    const queries = createQueries(db);
    const storage = {
      used_bytes: 3.5 * MB,
      used_mb: 3.5,
      files: 12,
      limit_mb: 10,
      measured_at: NOW,
    };

    const overview = await queries.storeOverview(
      { storeId: 9, store } as never,
      NOW,
    );
    expect(overview.storage).toEqual(storage);
    expect(overview.usage).toEqual(ZERO_USAGE);
    expect(Object.keys(overview.limits ?? {}).sort()).toEqual([
      'monthly_orders',
      'products',
      'staff_users',
    ]);

    const detail = await queries.subscriptionDetail(current.id, NOW);
    expect(detail.storage).toEqual(storage);
    expect(detail.plan).toMatchObject({ max_storage_mb: 10 });
  });

  it('assinatura cancelada: limite nulo (não vale mais); pasta ilegível: uso nulo', async () => {
    const db = createBillingDb();
    seedStore(db, { id: 10 });
    const plan = seedPlan(db, { max_storage_mb: 10 });
    const old = seedSubscription(db, {
      store_id: 10,
      plan_id: plan.id,
      status: CANCELED,
      canceled_at: days(NOW, -1),
    });

    const detail = await createQueries(db, null).subscriptionDetail(
      old.id,
      NOW,
    );
    expect(detail.storage).toEqual({
      used_bytes: null,
      used_mb: null,
      files: null,
      limit_mb: null,
      measured_at: null,
    });
  });
});
