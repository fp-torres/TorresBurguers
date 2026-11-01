import { BadRequestException } from '@nestjs/common';
import { InvoiceStatus } from '../billing/entities/subscription-invoice.entity';
import { PaymentStatus } from '../orders/order.enums';
import { MRR_EMPTY_NOTE } from './metrics';
import { PlatformInsightsService } from './platform-insights.service';
import {
  fakeQueryBuilder,
  paramsOf,
  sqlOf,
  type FakeQueryBuilder,
} from './testing/fake-query-builder.helper-spec';

const NOW = new Date('2026-10-17T12:00:00.000Z');

/** Repositório cujo createQueryBuilder devolve um QueryBuilder falso novo (sem dados) a cada chamada. */
function repository() {
  const builders: FakeQueryBuilder[] = [];
  return {
    builders,
    createQueryBuilder: jest.fn(() => {
      const qb = fakeQueryBuilder();
      builders.push(qb);
      return qb;
    }),
    find: jest.fn().mockResolvedValue([]),
  };
}

function setup() {
  const repos = {
    stores: repository(),
    subscriptions: repository(),
    events: repository(),
    invoices: repository(),
    plans: repository(),
    orders: repository(),
  };
  const tenants = { defaultStore: jest.fn().mockResolvedValue(null) };
  const service = new PlatformInsightsService(
    repos.stores as never,
    repos.subscriptions as never,
    repos.events as never,
    repos.invoices as never,
    repos.plans as never,
    repos.orders as never,
    tenants as never,
  );
  return { service, repos, tenants };
}

describe('PlatformInsightsService', () => {
  const originalZone = process.env.STORE_TIME_ZONE;
  beforeEach(() => delete process.env.STORE_TIME_ZONE);
  afterAll(() => {
    if (originalZone === undefined) delete process.env.STORE_TIME_ZONE;
    else process.env.STORE_TIME_ZONE = originalZone;
  });

  it('dashboard sem dados: tudo zerado com explicação, nada inventado', async () => {
    const { service } = setup();
    const dashboard = await service.dashboard(NOW);

    expect(dashboard.time_zone).toBe('America/Sao_Paulo');
    expect(dashboard.stores).toMatchObject({
      total: 0,
      by_status: { ACTIVE: 0, SUSPENDED: 0, INACTIVE: 0 },
    });
    expect(dashboard.stores.new_by_month).toHaveLength(12);
    expect(dashboard.stores.new_by_month[11]).toEqual({
      month: '2026-10',
      count: 0,
    });
    expect(dashboard.subscriptions.current).toBe(0);
    expect(dashboard.mrr).toMatchObject({
      value: 0,
      has_paid_subscriptions: false,
      note: MRR_EMPTY_NOTE,
    });
    expect(dashboard.arr).toMatchObject({ value: 0, projection: true });
    expect(dashboard.churn.months).toHaveLength(6);
    expect(dashboard.churn.months.every((month) => month.rate === null)).toBe(
      true,
    );
    expect(dashboard.gmv.total).toBe(0);
    expect(dashboard.gmv.note).not.toBeNull();
    expect(dashboard.platform_revenue.total).toBe(0);
    expect(dashboard.platform_revenue.note).not.toBeNull();
    expect(dashboard.orders.by_month).toHaveLength(12);
    expect(dashboard.plans).toEqual([]);
    expect(dashboard.alerts).toEqual([]);
  });

  it('GMV e receita da plataforma saem de consultas separadas (pedidos × faturas)', async () => {
    const { service, repos } = setup();
    await service.dashboard(NOW);

    const ordersSql = repos.orders.builders.map(sqlOf).join('\n');
    const invoicesSql = repos.invoices.builders.map(sqlOf).join('\n');
    expect(ordersSql).toContain('o.total_price');
    expect(ordersSql).not.toContain('i.amount');
    expect(invoicesSql).toContain('i.amount');
    expect(invoicesSql).not.toContain('total_price');

    // Receita: só faturas PAGAS, pela data do pagamento
    const revenue = repos.invoices.builders.find((qb) =>
      sqlOf(qb).includes('i.paid_at'),
    );
    expect(revenue && paramsOf(revenue)).toMatchObject({
      paidInvoice: InvoiceStatus.PAID,
    });
    // GMV: pedidos pagos e não cancelados, mês no fuso da plataforma
    const gmvByMonth = repos.orders.builders.find((qb) =>
      sqlOf(qb).includes("'YYYY-MM'"),
    );
    expect(gmvByMonth && paramsOf(gmvByMonth)).toMatchObject({
      paid: PaymentStatus.PAID,
      tz: 'America/Sao_Paulo',
    });
  });

  it('financeiro: período padrão de 12 meses; período inválido → 400', async () => {
    const { service } = setup();
    const finance = await service.finance({}, NOW);
    expect(finance.period).toEqual({
      from: '2025-11-01',
      to: '2026-10-17',
      days: 351,
    });
    expect(finance.platform_revenue.by_month).toHaveLength(12);
    expect(finance.gmv.by_month).toHaveLength(12);
    expect(finance.invoices_by_status.items).toHaveLength(4);
    expect(finance.top_stores_by_gmv).toEqual([]);
    expect(finance.delinquency).toMatchObject({
      amount: 0,
      invoices: 0,
      stores: 0,
    });

    await expect(
      service.finance({ from: '2026-10-18', to: '2026-10-01' }, NOW),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
