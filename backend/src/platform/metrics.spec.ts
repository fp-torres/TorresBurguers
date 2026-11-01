import { InvoiceStatus } from '../billing/entities/subscription-invoice.entity';
import { SubscriptionStatus } from '../billing/entities/subscription.entity';
import {
  addMonthsToKey,
  ALERT_SEVERITY,
  buildAlerts,
  buildPlatformMoney,
  computeArr,
  computeMonthlyChurn,
  computeMrr,
  countByKey,
  invoicesByStatus,
  lastMonthBuckets,
  monthKeyInZone,
  monthKeysBetween,
  monthlyCounts,
  MRR_EMPTY_NOTE,
  parseFinancePeriod,
  planDistribution,
  summarizeDelinquency,
  type AlertSourceRows,
  type PlanStatusRow,
  type SubscriptionHistoryEvent,
} from './metrics';

const SP = 'America/Sao_Paulo';
const { TRIALING, ACTIVE, PAST_DUE, SUSPENDED, CANCELED } = SubscriptionStatus;

function planRow(
  plan: { id: number; price: number | string; interval?: string },
  status: SubscriptionStatus,
  count: number | string,
): PlanStatusRow {
  return {
    plan_id: plan.id,
    code: `plano-${plan.id}`,
    name: `Plano ${plan.id}`,
    price: plan.price,
    billing_interval: plan.interval ?? 'MONTHLY',
    status,
    count,
  };
}

describe('metrics: meses do calendário', () => {
  it('mês no fuso da plataforma (virada do mês às 03:00 UTC em São Paulo)', () => {
    expect(monthKeyInZone(new Date('2026-11-01T02:59:00Z'), SP)).toBe(
      '2026-10',
    );
    expect(monthKeyInZone(new Date('2026-11-01T03:00:00Z'), SP)).toBe(
      '2026-11',
    );
  });

  it('soma meses atravessando o ano e lista o intervalo', () => {
    expect(addMonthsToKey('2026-11', 3)).toBe('2027-02');
    expect(addMonthsToKey('2026-01', -1)).toBe('2025-12');
    expect(addMonthsToKey('2026-10', -11)).toBe('2025-11');
    expect(monthKeysBetween('2025-11', '2026-02')).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
  });

  it('últimos 12 meses incluem o atual, com limites no fuso', () => {
    const buckets = lastMonthBuckets(new Date('2026-10-17T12:00:00Z'), SP, 12);
    expect(buckets).toHaveLength(12);
    expect(buckets[0].month).toBe('2025-11');
    expect(buckets[11].month).toBe('2026-10');
    expect(buckets[11].start.toISOString()).toBe('2026-10-01T03:00:00.000Z');
    expect(buckets[11].end.toISOString()).toBe('2026-11-01T03:00:00.000Z');
    // Contíguos: o fim de um é o início do próximo
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].start.getTime()).toBe(buckets[i - 1].end.getTime());
    }
  });

  it('séries e contagens preenchem com zero e ignoram o que está fora', () => {
    expect(
      monthlyCounts(
        ['2026-09', '2026-10'],
        [
          { month: '2026-10', count: '3' },
          { month: '2020-01', count: 9 },
        ],
      ),
    ).toEqual([
      { month: '2026-09', count: 0 },
      { month: '2026-10', count: 3 },
    ]);
    expect(
      countByKey(['ACTIVE', 'SUSPENDED', 'INACTIVE'] as const, [
        { key: 'ACTIVE', count: '5' },
        { key: 'OUTRO', count: 2 },
      ]),
    ).toEqual({ ACTIVE: 5, SUSPENDED: 0, INACTIVE: 0 });
  });
});

describe('metrics: MRR e ARR', () => {
  const monthly = { id: 1, price: '99.90' };
  const yearly = { id: 2, price: '1200.00', interval: 'YEARLY' };
  const free = { id: 3, price: '0.00' };

  it('soma o preço mensalizado das assinaturas ATIVAS e EM ATRASO de planos pagos', () => {
    const rows = [
      planRow(monthly, ACTIVE, '3'),
      planRow(monthly, PAST_DUE, 1),
      planRow(monthly, TRIALING, 2), // teste grátis não entra
      planRow(monthly, SUSPENDED, 1), // suspensa não entra
      planRow(yearly, ACTIVE, 2), // 1200 ÷ 12 = 100 cada
      planRow(free, ACTIVE, 5), // gratuito não entra
      planRow(monthly, CANCELED, 7), // cancelada não entra
    ];
    const mrr = computeMrr(rows);
    expect(mrr).toMatchObject({
      value: 599.6,
      currency: 'BRL',
      paying_subscriptions: 6,
      has_paid_subscriptions: true,
      note: null,
    });
    expect(mrr.methodology).toContain('anuais ÷ 12');
    expect(computeArr(mrr)).toMatchObject({
      value: 7195.2,
      projection: true,
    });
    expect(computeArr(mrr).methodology).toContain('PROJEÇÃO');
  });

  it('arredonda só o total (anual que não divide exato por 12)', () => {
    const rows = [
      planRow({ id: 9, price: 1000, interval: 'YEARLY' }, ACTIVE, 3),
    ];
    expect(computeMrr(rows).value).toBe(250);
    expect(
      computeMrr([
        planRow({ id: 9, price: 1000, interval: 'YEARLY' }, ACTIVE, 1),
      ]).value,
    ).toBe(83.33);
  });

  it('sem assinaturas pagas: MRR zero com explicação (nunca estimado)', () => {
    for (const rows of [
      [],
      [planRow(free, ACTIVE, 10)],
      [planRow(monthly, TRIALING, 4)],
    ]) {
      const mrr = computeMrr(rows);
      expect(mrr).toMatchObject({
        value: 0,
        paying_subscriptions: 0,
        has_paid_subscriptions: false,
        note: MRR_EMPTY_NOTE,
      });
      expect(computeArr(mrr).value).toBe(0);
    }
  });

  it('distribuição por plano: vigentes, pagantes, MRR e participação', () => {
    const items = planDistribution([
      planRow(monthly, ACTIVE, 3),
      planRow(monthly, TRIALING, 1),
      planRow(free, ACTIVE, 4),
      planRow(free, CANCELED, 9),
    ]);
    // Mesmo número de assinaturas: ordem alfabética do nome do plano
    expect(items).toEqual([
      expect.objectContaining({
        plan: expect.objectContaining({ id: 1, price: 99.9 }) as unknown,
        subscriptions: 4,
        paying_subscriptions: 3,
        by_status: { TRIALING: 1, ACTIVE: 3, PAST_DUE: 0, SUSPENDED: 0 },
        mrr: 299.7,
        share: 0.5,
      }),
      expect.objectContaining({
        plan: expect.objectContaining({ id: 3, price: 0 }) as unknown,
        subscriptions: 4,
        paying_subscriptions: 0,
        mrr: 0,
        share: 0.5,
      }),
    ]);
    expect(planDistribution([])).toEqual([]);
  });
});

describe('metrics: churn mensal', () => {
  const prices = new Map([
    [1, 100],
    [2, 0],
  ]);
  let nextId = 1;
  const event = (
    subscriptionId: number,
    at: string,
    fields: Partial<SubscriptionHistoryEvent>,
  ): SubscriptionHistoryEvent => ({
    id: nextId++,
    subscription_id: subscriptionId,
    type: 'STATUS_CHANGED',
    from_status: null,
    to_status: null,
    to_plan_id: null,
    created_at: new Date(at),
    ...fields,
  });
  const created = (id: number, at: string, status: string, plan: number) =>
    event(id, at, { type: 'CREATED', to_status: status, to_plan_id: plan });
  const changed = (id: number, at: string, from: string, to: string) =>
    event(id, at, { from_status: from, to_status: to });

  const events: SubscriptionHistoryEvent[] = [
    // 10: pagante desde junho, cancelada em agosto
    created(10, '2026-06-01T12:00:00Z', ACTIVE, 1),
    changed(10, '2026-08-10T12:00:00Z', ACTIVE, CANCELED),
    // 11: cancelada durante o teste grátis (não é churn de pagante)
    created(11, '2026-06-15T12:00:00Z', TRIALING, 1),
    changed(11, '2026-07-05T12:00:00Z', TRIALING, CANCELED),
    // 12: plano gratuito cancelado (não conta)
    created(12, '2026-05-01T12:00:00Z', ACTIVE, 2),
    changed(12, '2026-08-20T12:00:00Z', ACTIVE, CANCELED),
    // 13: gratuito → pago em julho; atrasa, é suspensa e cancelada em setembro
    created(13, '2026-05-01T12:00:00Z', ACTIVE, 2),
    event(13, '2026-07-20T12:00:00Z', { type: 'PLAN_CHANGED', to_plan_id: 1 }),
    changed(13, '2026-08-25T12:00:00Z', ACTIVE, PAST_DUE),
    changed(13, '2026-09-02T12:00:00Z', PAST_DUE, SUSPENDED),
    changed(13, '2026-09-10T12:00:00Z', SUSPENDED, CANCELED),
    // 14: começou a pagar no meio de julho
    created(14, '2026-07-10T12:00:00Z', ACTIVE, 1),
  ];
  const now = new Date('2026-09-15T12:00:00Z');
  const buckets = lastMonthBuckets(now, 'UTC', 3);

  it('canceladas no mês ÷ pagantes no início do mês, reconstruído pelo histórico', () => {
    // Ordem dos eventos não importa (são ordenados por data e id)
    const result = computeMonthlyChurn(
      [...events].reverse(),
      prices,
      buckets,
      now,
    );
    expect(result).toEqual([
      {
        month: '2026-07',
        paying_at_start: 1, // só a 10 (a 13 ainda era gratuita; a 11 em teste)
        canceled: 0, // cancelamento no teste grátis não conta
        rate: 0,
        partial: false,
        note: null,
      },
      {
        month: '2026-08',
        paying_at_start: 3, // 10, 13 (já no plano pago) e 14
        canceled: 1, // 10 (a 12 era gratuita)
        rate: 0.3333,
        partial: false,
        note: null,
      },
      {
        month: '2026-09',
        paying_at_start: 2, // 13 (em atraso conta) e 14
        canceled: 1, // 13 cancelada a partir de SUSPENSA, num plano pago
        rate: 0.5,
        partial: true,
        note: null,
      },
    ]);
  });

  it('sem pagantes no início do mês: taxa indefinida (null) com explicação', () => {
    const [month] = computeMonthlyChurn(
      [],
      prices,
      lastMonthBuckets(now, 'UTC', 1),
      now,
    );
    expect(month).toMatchObject({
      paying_at_start: 0,
      canceled: 0,
      rate: null,
    });
    expect(month.note).toContain('não se aplica');
  });
});

describe('metrics: GMV × receita da plataforma (nunca somados)', () => {
  const months = ['2026-08', '2026-09'];
  const orders = {
    totals: { orders: '10', paid_orders: '7', gmv: '1234.50' },
    byMonth: [
      { month: '2026-08', orders: '4', paid_orders: '3', gmv: '500.25' },
      { month: '2026-09', orders: 6, paid_orders: 4, gmv: '734.25' },
      { month: '2025-01', orders: 99, paid_orders: 99, gmv: '9999' },
    ],
  };
  const invoices = {
    totals: { invoices: '2', revenue: '199.80' },
    byMonth: [{ month: '2026-09', invoices: '2', revenue: '199.80' }],
  };

  it('GMV vem só dos pedidos; a receita, só das faturas pagas', () => {
    const money = buildPlatformMoney({ months, orders, invoices });
    expect(Object.keys(money)).toEqual(['orders', 'gmv', 'platform_revenue']);
    expect(money.orders).toMatchObject({
      total: 10,
      by_month: [
        { month: '2026-08', count: 4 },
        { month: '2026-09', count: 6 },
      ],
    });
    expect(money.gmv).toMatchObject({
      total: 1234.5,
      paid_orders: 7,
      by_month: [
        { month: '2026-08', amount: 500.25, paid_orders: 3 },
        { month: '2026-09', amount: 734.25, paid_orders: 4 },
      ],
      note: null,
    });
    expect(money.platform_revenue).toMatchObject({
      total: 199.8,
      paid_invoices: 2,
      by_month: [
        { month: '2026-08', amount: 0, invoices: 0 },
        { month: '2026-09', amount: 199.8, invoices: 2 },
      ],
      note: null,
    });
    // Nenhum número da resposta é a soma dos dois
    expect(JSON.stringify(money)).not.toContain('1434.3');
    expect(money.gmv.methodology).toContain('nunca é somado');
    expect(money.platform_revenue.methodology).toContain('nunca entra');
  });

  it('mudar as faturas não muda o GMV, e vice-versa', () => {
    const base = buildPlatformMoney({ months, orders, invoices });
    const moreRevenue = buildPlatformMoney({
      months,
      orders,
      invoices: {
        totals: { invoices: 50, revenue: '50000' },
        byMonth: [{ month: '2026-08', invoices: 50, revenue: '50000' }],
      },
    });
    expect(moreRevenue.gmv).toEqual(base.gmv);
    expect(moreRevenue.orders).toEqual(base.orders);

    const noOrders = buildPlatformMoney({
      months,
      orders: { totals: null, byMonth: [] },
      invoices,
    });
    expect(noOrders.platform_revenue).toEqual(base.platform_revenue);
    expect(noOrders.gmv.total).toBe(0);
  });

  it('sem dados: zeros com explicação', () => {
    const money = buildPlatformMoney({
      months,
      orders: { totals: undefined, byMonth: [] },
      invoices: { totals: null, byMonth: [] },
      period: true,
    });
    expect(money.orders.total).toBe(0);
    expect(money.gmv.total).toBe(0);
    expect(money.gmv.note).toContain('no período');
    expect(money.platform_revenue.total).toBe(0);
    expect(money.platform_revenue.note).toContain(
      'receita da plataforma é zero',
    );
  });
});

describe('metrics: financeiro', () => {
  const now = new Date('2026-10-17T12:00:00Z');

  it('período padrão: 12 meses do calendário até hoje', () => {
    const period = parseFinancePeriod(undefined, '', now, SP);
    expect(period).toMatchObject({
      ok: true,
      from: '2025-11-01',
      to: '2026-10-17',
    });
    if (!period.ok) return;
    expect(period.months).toHaveLength(12);
    expect(period.months[0]).toBe('2025-11');
    expect(period.start.toISOString()).toBe('2025-11-01T03:00:00.000Z');
    expect(period.end.toISOString()).toBe('2026-10-18T03:00:00.000Z');
  });

  it('só "to": os 12 meses até ele; datas inválidas, invertidas ou longas demais → erro', () => {
    expect(parseFinancePeriod(undefined, '2026-03-15', now, SP)).toMatchObject({
      ok: true,
      from: '2025-04-01',
      to: '2026-03-15',
    });
    expect(parseFinancePeriod('2026-02-30', undefined, now, SP)).toMatchObject({
      ok: false,
    });
    expect(parseFinancePeriod('2026-05-01', '2026-04-01', now, SP)).toEqual({
      ok: false,
      message: 'A data inicial (from) não pode ser depois da data final (to).',
    });
    expect(
      parseFinancePeriod('2020-01-01', '2026-01-01', now, SP),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining('3 anos') as unknown,
    });
  });

  it('faturas por situação: todas as situações, inclusive zeradas', () => {
    expect(
      invoicesByStatus([
        { status: 'PAID', count: '3', amount: '299.70' },
        { status: 'FAILED', count: 1, amount: '99.90' },
      ]),
    ).toEqual([
      { status: InvoiceStatus.OPEN, count: 0, amount: 0 },
      { status: InvoiceStatus.PAID, count: 3, amount: 299.7 },
      { status: InvoiceStatus.FAILED, count: 1, amount: 99.9 },
      { status: InvoiceStatus.VOID, count: 0, amount: 0 },
    ]);
  });

  it('inadimplência: total, lojas e ranking pelo valor', () => {
    const summary = summarizeDelinquency([
      {
        store_id: '1',
        slug: 'a',
        name: 'A',
        invoices: '1',
        amount: '49.90',
        oldest_due_at: '2026-09-01T00:00:00Z',
      },
      {
        store_id: 2,
        slug: 'b',
        name: 'B',
        invoices: 2,
        amount: '199.80',
        oldest_due_at: new Date('2026-08-01T00:00:00Z'),
      },
    ]);
    expect(summary).toMatchObject({
      amount: 249.7,
      invoices: 3,
      stores: 2,
      note: null,
    });
    expect(summary.top_stores.map((row) => row.store.slug)).toEqual(['b', 'a']);
    expect(summarizeDelinquency([])).toMatchObject({
      amount: 0,
      invoices: 0,
      stores: 0,
      note: expect.stringContaining('não há inadimplência') as unknown,
    });
  });
});

describe('metrics: alertas', () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const store = (id: number, name: string) => ({
    store_id: id,
    slug: `loja-${id}`,
    name,
  });
  const empty: AlertSourceRows = {
    graceEnding: [],
    suspendedStores: [],
    suspendedSubscriptions: [],
    refundPending: [],
    failedInvoices: [],
    storesWithoutAdmin: [],
    trialsEnding: [],
    onlinePaymentsWithoutCredentials: [],
    defaultStoreId: null,
    platformCredentialsConfigured: false,
  };

  it('um alerta por situação, ordenados por gravidade', () => {
    const alerts = buildAlerts(
      {
        ...empty,
        trialsEnding: [
          { ...store(7, 'Teste'), trial_ends_at: '2026-10-20T12:00:00Z' },
        ],
        graceEnding: [
          {
            ...store(1, 'Atrasada'),
            grace_period_ends_at: '2026-10-19T12:00:00Z',
          },
        ],
        suspendedStores: [{ ...store(2, 'Suspensa'), status_reason: 'Fraude' }],
        suspendedSubscriptions: [
          { ...store(3, 'Sem pagar'), suspended_at: null },
        ],
        refundPending: [{ ...store(4, 'Estornos'), orders: '2' }],
        failedInvoices: [
          { ...store(5, 'Recusada'), invoices: 1, amount: '99.9' },
        ],
        storesWithoutAdmin: [
          { ...store(6, 'Sem admin'), pending_invitation: true },
        ],
        onlinePaymentsWithoutCredentials: [store(8, 'Sem MP')],
        inactiveStoresBilled: [
          {
            ...store(9, 'Desativada'),
            subscription_status: 'ACTIVE',
            plan_name: 'Pro',
          },
        ],
      },
      now,
      SP,
    );
    const message = (type: string) =>
      alerts.find((alert) => alert.type === type)?.message ?? '';
    expect(alerts.map((alert) => alert.type)).toEqual([
      'PAST_DUE_GRACE_ENDING',
      'SUBSCRIPTION_SUSPENDED',
      'REFUND_PENDING',
      'INVOICE_FAILED',
      'NO_ACTIVE_ADMIN',
      'STORE_SUSPENDED',
      'INACTIVE_STORE_BILLED',
      'TRIAL_ENDING',
      'ONLINE_PAYMENTS_WITHOUT_CREDENTIALS',
    ]);
    expect(message('SUBSCRIPTION_SUSPENDED')).toContain(
      'por falta de pagamento',
    );
    expect(message('INACTIVE_STORE_BILLED')).toContain('plano Pro');
    for (const alert of alerts) {
      expect(alert.severity).toBe(ALERT_SEVERITY[alert.type]);
      expect(alert.store).toEqual(
        expect.objectContaining({ id: expect.any(Number) as unknown }),
      );
    }
    expect(message('PAST_DUE_GRACE_ENDING')).toContain('19/10/2026 (2 dias)');
    expect(message('REFUND_PENDING')).toContain('2 pedidos cancelados');
    expect(message('INVOICE_FAILED')).toContain('R$');
    expect(message('NO_ACTIVE_ADMIN')).toContain('convite pendente');
    expect(message('STORE_SUSPENDED')).toContain('Fraude');
    expect(message('TRIAL_ENDING')).toContain('20/10/2026');
  });

  it('assinatura cancelada ainda cobrada no Mercado Pago ou com cobranças depois do cancelamento: alerta crítico', () => {
    const alerts = buildAlerts(
      {
        ...empty,
        canceledStillBilled: [
          {
            ...store(3, 'Ainda cobrada'),
            subscription_id: 45,
            provider_active: true,
            payments: '2',
            amount: '199.80',
          },
          {
            ...store(4, 'Devolver'),
            subscription_id: 46,
            provider_active: false,
            payments: 1,
            amount: 99.9,
          },
        ],
      },
      now,
      SP,
    );
    expect(alerts.map((alert) => [alert.type, alert.severity])).toEqual([
      ['CANCELED_STILL_BILLED', 'critical'],
      ['CANCELED_STILL_BILLED', 'critical'],
    ]);
    const [active, refund] = alerts;
    expect(active.message).toContain('ainda ativa no Mercado Pago');
    expect(active.message).toContain('2 cobranças');
    expect(active.data).toMatchObject({
      subscription_id: 45,
      provider_active: true,
      payments: 2,
      amount: 199.8,
    });
    expect(refund.message).not.toContain('ainda ativa');
    expect(refund.message).toContain('1 cobrança recebida');
  });

  it('assinatura suspensa pela plataforma: o alerta diz quem suspendeu', () => {
    const [alert] = buildAlerts(
      {
        ...empty,
        suspendedSubscriptions: [
          {
            ...store(3, 'Bloqueada'),
            suspended_at: '2026-10-10T12:00:00Z',
            suspended_by: 'PLATFORM',
          },
        ],
      },
      now,
      SP,
    );
    expect(alert).toMatchObject({
      type: 'SUBSCRIPTION_SUSPENDED',
      data: { suspended_by: 'PLATFORM' },
    });
    expect(alert.message).toContain('pela plataforma desde 10/10/2026');
  });

  it('tolerância já vencida avisa que a suspensão é iminente', () => {
    const [alert] = buildAlerts(
      {
        ...empty,
        graceEnding: [
          { ...store(1, 'A'), grace_period_ends_at: '2026-10-16T12:00:00Z' },
        ],
      },
      now,
      SP,
    );
    expect(alert.message).toContain('terminou');
  });

  it('loja padrão sem credencial própria não gera alerta se o ambiente tem MP_ACCESS_TOKEN', () => {
    const rows = {
      ...empty,
      defaultStoreId: 8,
      onlinePaymentsWithoutCredentials: [store(8, 'Padrão'), store(9, 'Outra')],
    };
    expect(
      buildAlerts(
        { ...rows, platformCredentialsConfigured: true },
        now,
        SP,
      ).map((alert) => alert.store?.id),
    ).toEqual([9]);
    expect(
      buildAlerts({ ...rows, platformCredentialsConfigured: false }, now, SP)
        .length,
    ).toBe(2);
  });

  it('sem pendências: lista vazia', () => {
    expect(buildAlerts(empty, now, SP)).toEqual([]);
  });
});
