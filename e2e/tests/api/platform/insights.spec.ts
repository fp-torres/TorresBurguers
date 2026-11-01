/**
 * Superpainel › Dashboard e financeiro (pedido §6.1 e §8 "Separação financeira"; arquitetura §11.6):
 * indicadores reais, coerentes com os dados criados pelo teste — lojas e assinaturas batem com as listas,
 * MRR/ARR e a distribuição por plano saem dos planos e assinaturas criados, pedidos e GMV das lojas ficam
 * separados da receita da plataforma (faturas pagas), e períodos sem dados mostram zero com explicação
 * (nada estimado ou inventado).
 *
 * O banco é compartilhado e rotinas em segundo plano (conciliação do PIX do sandbox, ciclo das
 * assinaturas) podem criar pedidos ou mudar situações de OUTRAS lojas: os totais globais são conferidos
 * pela coerência entre si e com as listas no mesmo instante; os números exatos, nas lojas e planos do teste
 * e num dia antigo sorteado (só as faturas do teste vencem nele).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  addDays,
  bearer,
  cleanupPlatformData,
  completeOrder,
  createPlan,
  createProductAs,
  createStore,
  expectApiError,
  expectOk,
  freshSession,
  letters,
  newApi,
  newClientAccount,
  openStore,
  placeTakeoutOrder,
  storeWithOwner,
  subscriptionDetail,
  uid,
  type CreatedStore,
  type Json,
  type Session,
  type StoreWithOwner,
} from './helpers';

const STORE_STATUSES = ['ACTIVE', 'SUSPENDED', 'INACTIVE'] as const;
const SUBSCRIPTION_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELED'] as const;

let api: APIRequestContext;
let sa: Session;
let planMonthly: Json;
let planYearly: Json;
let planTrial: Json;
let planFree: Json;
let planFinance: Json;
/** Loja com equipe, pedidos e GMV. */
let storeG: StoreWithOwner;
let storeY: CreatedStore;
let storeT: CreatedStore;
/** Suspensa pela plataforma (plano gratuito). */
let storeS: CreatedStore;
/** Sem administrador ativo (convite pendente; plano gratuito). */
let storeN: CreatedStore;
/** Faturas do financeiro. */
let storeF: CreatedStore;
const suspensionReason = `Auditoria fiscal ${uid('motivo')}`;

const cents = (value: number) => Math.round(Number(value) * 100);
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

async function dashboard(): Promise<Json> {
  return expectOk(await api.get('/platform/dashboard', { headers: bearer(sa.token) }), 200, 'GET /platform/dashboard');
}

async function finance(params: Record<string, string> = {}): Promise<Json> {
  return expectOk(await api.get('/platform/finance', { headers: bearer(sa.token), params }), 200, 'GET /platform/finance');
}

async function listTotal(path: string, params: Record<string, string>): Promise<number> {
  const page = await expectOk(await api.get(path, { headers: bearer(sa.token), params: { ...params, pageSize: '1' } }), 200, path);
  return page.total;
}

/** Quita (agora) as faturas em aberto da assinatura e devolve a soma paga. */
async function payOpenInvoices(subscriptionId: number): Promise<number> {
  const sub = await subscriptionDetail(api, sa.token, subscriptionId);
  let paid = 0;
  for (const invoice of sub.invoices as Json[]) {
    if (invoice.status !== 'OPEN') continue;
    await expectOk(
      await api.post(`/platform/invoices/${invoice.id}/mark-paid`, {
        headers: bearer(sa.token),
        data: { payment_method: 'PIX', provider_payment_id: `painel-${uid('pg')}` },
      }),
      200,
      'pagamento da fatura inicial',
    );
    paid += cents(invoice.amount);
  }
  return paid;
}

async function createInvoice(subscriptionId: number, data: Record<string, unknown>): Promise<Json> {
  return expectOk(
    await api.post(`/platform/subscriptions/${subscriptionId}/invoices`, { headers: bearer(sa.token), data }),
    201,
    'POST /platform/subscriptions/:id/invoices',
  );
}

test.beforeAll(async () => {
  api = await newApi();
  sa = await freshSession(api, 'superadmin');
  planMonthly = await createPlan(api, sa.token, { price: 37.5 });
  planYearly = await createPlan(api, sa.token, { price: 600, billing_interval: 'YEARLY' });
  planTrial = await createPlan(api, sa.token, { price: 20, trial_days: 3 });
  planFree = await createPlan(api, sa.token, { price: 0 });
  planFinance = await createPlan(api, sa.token, { price: 99.9 });

  storeG = await storeWithOwner(api, sa.token, { planId: planMonthly.id });
  storeY = await createStore(api, sa.token, { planId: planYearly.id });
  storeT = await createStore(api, sa.token, { planId: planTrial.id });
  storeS = await createStore(api, sa.token, { planId: planFree.id });
  storeN = await createStore(api, sa.token, { planId: planFree.id, name: `0 Sem responsável E2E ${letters(8)}` });
  storeF = await createStore(api, sa.token, { planId: planFinance.id });

  // Primeiras faturas pagas: as assinaturas pagas ficam ACTIVE (a rotina de cobrança não mexe nelas)
  for (const store of [storeG, storeY, storeF]) await payOpenInvoices(store.subscription.id);
  await expectOk(
    await api.post(`/platform/stores/${storeS.id}/suspend`, { headers: bearer(sa.token), data: { reason: suspensionReason } }),
    200,
    'suspensão da loja S',
  );
});

test.afterAll(async () => {
  if (!api) return;
  try {
    await cleanupPlatformData(api, sa.token);
  } finally {
    await api.dispose();
  }
});

test.describe('Dashboard global (GET /platform/dashboard)', () => {
  test('lojas e assinaturas por situação batem com as listas do superpainel; MRR, ARR e distribuição por plano', async () => {
    // Lojas: a situação só muda por ação do superpainel → comparação direta
    const board = await dashboard();
    expect(board).toMatchObject({ currency: 'BRL', time_zone: expect.any(String) });
    expect(board.stores.total).toBe(sum(STORE_STATUSES.map((status) => board.stores.by_status[status])));
    expect(board.stores.total).toBe(await listTotal('/platform/stores', {}));
    for (const status of STORE_STATUSES) {
      expect(board.stores.by_status[status], `lojas ${status}`).toBe(await listTotal('/platform/stores', { account_status: status }));
    }
    expect(board.stores.by_status.SUSPENDED).toBeGreaterThanOrEqual(1);
    expect(board.stores.new_by_month).toHaveLength(12);
    expect(board.stores.new_by_month.at(-1).count, 'lojas novas no mês (inclui as 6 do teste)').toBeGreaterThanOrEqual(6);

    // Assinaturas e planos: a rotina do ciclo pode mudar uma situação entre duas consultas → repete até bater
    await expect
      .poll(
        async () => {
          const current = await dashboard();
          const diffs: string[] = [];
          for (const status of SUBSCRIPTION_STATUSES) {
            const listed = await listTotal('/platform/subscriptions', { status });
            if (current.subscriptions.by_status[status] !== listed) {
              diffs.push(`${status}: painel ${current.subscriptions.by_status[status]} × lista ${listed}`);
            }
          }
          const notCanceled = sum(SUBSCRIPTION_STATUSES.filter((s) => s !== 'CANCELED').map((s) => current.subscriptions.by_status[s]));
          if (current.subscriptions.current !== notCanceled) diffs.push(`vigentes ${current.subscriptions.current} × ${notCanceled}`);
          const plans = current.plans as Json[];
          if (sum(plans.map((plan) => plan.subscriptions)) !== current.subscriptions.current) diffs.push('soma dos planos × vigentes');
          if (sum(plans.map((plan) => plan.paying_subscriptions)) !== current.mrr.paying_subscriptions) {
            diffs.push('pagantes dos planos × MRR');
          }
          // MRR total arredondado uma vez; o de cada plano, por plano (planos anuais ÷ 12 podem ter meio centavo)
          if (Math.abs(cents(current.mrr.value) - sum(plans.map((plan) => cents(plan.mrr)))) > plans.length) {
            diffs.push(`MRR ${current.mrr.value} × soma dos planos`);
          }
          return diffs.join('; ');
        },
        { message: 'dashboard coerente com as listas de assinaturas', timeout: 20_000 },
      )
      .toBe('');

    const fresh = await dashboard();
    const plan = (id: number) => (fresh.plans as Json[]).find((item) => item.plan.id === id);
    expect(plan(planMonthly.id)).toMatchObject({
      plan: { code: planMonthly.code, price: 37.5, billing_interval: 'MONTHLY' },
      subscriptions: 1,
      paying_subscriptions: 1,
      by_status: { TRIALING: 0, ACTIVE: 1, PAST_DUE: 0, SUSPENDED: 0 },
      mrr: 37.5,
    });
    // Plano anual: 600 ÷ 12
    expect(plan(planYearly.id)).toMatchObject({ plan: { billing_interval: 'YEARLY', price: 600 }, paying_subscriptions: 1, mrr: 50 });
    // Teste grátis e plano gratuito não entram no MRR (a loja suspensa continua com a assinatura vigente)
    expect(plan(planTrial.id)).toMatchObject({ subscriptions: 1, paying_subscriptions: 0, by_status: { TRIALING: 1 }, mrr: 0 });
    expect(plan(planFree.id)).toMatchObject({ subscriptions: 2, paying_subscriptions: 0, by_status: { ACTIVE: 2 }, mrr: 0 });
    expect(plan(planFinance.id)).toMatchObject({ subscriptions: 1, paying_subscriptions: 1, mrr: 99.9 });
    const totalSubscriptions = sum((fresh.plans as Json[]).map((item) => item.subscriptions));
    for (const item of fresh.plans as Json[]) {
      expect(item.share, `participação do plano ${item.plan.code}`).toBeCloseTo(item.subscriptions / totalSubscriptions, 4);
    }

    // MRR com dados reais (os 3 planos pagos do teste) e ARR como projeção (MRR × 12)
    expect(fresh.mrr).toMatchObject({ currency: 'BRL', has_paid_subscriptions: true, note: null });
    expect(cents(fresh.mrr.value)).toBeGreaterThanOrEqual(cents(37.5 + 50 + 99.9));
    expect(fresh.mrr.paying_subscriptions).toBeGreaterThanOrEqual(3);
    expect(fresh.mrr.methodology).toContain('MRR');
    expect(fresh.arr).toMatchObject({ projection: true, currency: 'BRL', label: 'Projeção anual (MRR × 12)' });
    expect(cents(fresh.arr.value)).toBe(cents(fresh.mrr.value) * 12);

    // Churn: 6 meses (o atual parcial) com metodologia
    expect(fresh.churn.months).toHaveLength(6);
    expect(fresh.churn.months.at(-1).partial).toBe(true);
    expect(fresh.churn.methodology.length).toBeGreaterThan(20);
  });

  test('alertas apontam as lojas do teste: suspensa (com o motivo), sem administrador e teste grátis terminando', async () => {
    const board = await dashboard();
    const alerts = board.alerts as Json[];
    const alertFor = (type: string, storeId: number) => alerts.find((alert) => alert.type === type && alert.store?.id === storeId);

    expect(alertFor('STORE_SUSPENDED', storeS.id)).toMatchObject({
      severity: 'warning',
      store: { id: storeS.id, slug: storeS.slug, name: storeS.name },
      message: `Loja suspensa pela plataforma: ${suspensionReason}.`,
    });
    expect(alertFor('NO_ACTIVE_ADMIN', storeN.id)).toMatchObject({ severity: 'warning', data: { pending_invitation: true } });
    expect(alertFor('NO_ACTIVE_ADMIN', storeG.id), 'a loja G tem administrador ativo').toBeUndefined();

    const trial = await subscriptionDetail(api, sa.token, storeT.subscription.id);
    expect(trial.status).toBe('TRIALING');
    expect(alertFor('TRIAL_ENDING', storeT.id)).toMatchObject({
      severity: 'info',
      data: { trial_ends_at: new Date(trial.trial_ends_at).toISOString() },
    });
    expect(alertFor('TRIAL_ENDING', storeG.id)).toBeUndefined();
    for (const alert of alerts) {
      expect(['critical', 'warning', 'info']).toContain(alert.severity);
      expect(typeof alert.message).toBe('string');
    }
  });

  test('pedidos e GMV das lojas e receita da plataforma em blocos separados, coerentes com os pedidos e faturas criados', async () => {
    const before = await dashboard();

    // Pedidos da loja G: 2 pagos (50.000 + 2 × 12,50), 1 em aberto e 1 cancelado
    await openStore(api, storeG.owner.token);
    const big = await createProductAs(api, storeG.owner.token, { name: 'Banquete do Painel', price: 50_000 });
    const small = await createProductAs(api, storeG.owner.token, { name: 'Refrigerante do Painel', price: 12.5, category: 'bebidas' });
    const client = await newClientAccount(api, 'Cliente do Dashboard E2E');
    const paidBig = await placeTakeoutOrder(api, client.token, storeG.slug, [{ productId: big.id, quantity: 1 }]);
    const paidSmall = await placeTakeoutOrder(api, client.token, storeG.slug, [{ productId: small.id, quantity: 2 }]);
    await placeTakeoutOrder(api, client.token, storeG.slug, [{ productId: small.id, quantity: 1 }]);
    const canceled = await placeTakeoutOrder(api, client.token, storeG.slug, [{ productId: small.id, quantity: 1 }]);
    await completeOrder(api, storeG.owner.token, paidBig.id);
    await completeOrder(api, storeG.owner.token, paidSmall.id);
    await expectOk(await api.patch(`/orders/${canceled.id}/cancel`, { headers: bearer(storeG.owner.token) }), 200, 'cancelamento');
    const gmv = cents(Number(paidBig.total_price) + Number(paidSmall.total_price));
    expect(gmv).toBe(cents(50_025));

    // Receita da plataforma: uma fatura avulsa paga agora (o GMV nunca entra nela)
    const invoice = await createInvoice(storeG.subscription.id, {
      amount: 45.67,
      period_start: '2041-03-01T00:00:00Z',
      period_end: '2041-04-01T00:00:00Z',
      due_at: '2041-03-01T00:00:00Z',
    });
    await expectOk(
      await api.post(`/platform/invoices/${invoice.id}/mark-paid`, {
        headers: bearer(sa.token),
        data: { payment_method: 'PIX', provider_payment_id: `painel-${uid('pg')}` },
      }),
      200,
    );

    const after = await dashboard();
    // Receita: exatamente a fatura paga (nenhuma rotina quita faturas no provedor MANUAL)
    expect(cents(after.platform_revenue.total) - cents(before.platform_revenue.total)).toBe(cents(45.67));
    expect(after.platform_revenue.paid_invoices - before.platform_revenue.paid_invoices).toBe(1);
    expect(cents(after.platform_revenue.by_month.at(-1).amount) - cents(before.platform_revenue.by_month.at(-1).amount)).toBe(cents(45.67));
    // GMV e pedidos: pelo menos os do teste (a conciliação do PIX do sandbox pode criar pedidos de outras lojas)
    expect(cents(after.gmv.total) - cents(before.gmv.total)).toBeGreaterThanOrEqual(gmv);
    expect(after.gmv.paid_orders - before.gmv.paid_orders).toBeGreaterThanOrEqual(2);
    expect(cents(after.gmv.by_month.at(-1).amount) - cents(before.gmv.by_month.at(-1).amount)).toBeGreaterThanOrEqual(gmv);
    expect(after.orders.total - before.orders.total).toBeGreaterThanOrEqual(3);
    expect(after.orders.by_month.at(-1).count - before.orders.by_month.at(-1).count).toBeGreaterThanOrEqual(3);
    // Blocos separados, cada um com a sua metodologia
    expect(after.gmv.methodology).toContain('não é receita da plataforma');
    expect(after.platform_revenue.methodology).toContain('o GMV das lojas nunca entra');
    expect(after.gmv.note).toBeNull();
    expect(after.platform_revenue.note).toBeNull();

    // Números exatos da loja: lista, detalhe, métricas diárias e ranking do financeiro
    const listed = await expectOk(
      await api.get('/platform/stores', { headers: bearer(sa.token), params: { search: storeG.slug } }),
      200,
    );
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ id: storeG.id, orders_30d: 3, gmv_30d: 50_025, staff_count: 1 });
    const detail = await expectOk(await api.get(`/platform/stores/${storeG.id}`, { headers: bearer(sa.token) }), 200);
    expect(detail.metrics).toMatchObject({
      orders_total: 3,
      orders_30d: 3,
      canceled_orders_total: 1,
      gmv_total: 50_025,
      gmv_30d: 50_025,
      customers: 1,
      active_admins: 1,
      currency: 'BRL',
    });
    const metrics = await expectOk(await api.get(`/platform/stores/${storeG.id}/metrics`, { headers: bearer(sa.token) }), 200);
    expect(metrics.summary).toMatchObject({ paid_orders: 2, canceled_orders: 1, gmv: 50_025 });
    expect(sum((metrics.daily as Json[]).map((day) => cents(day.gmv)))).toBe(gmv);
    expect(sum((metrics.daily as Json[]).map((day) => day.paid_orders))).toBe(2);

    const year = await finance();
    expect((year.top_stores_by_gmv as Json[]).find((row) => row.store.id === storeG.id)).toEqual({
      store: { id: storeG.id, slug: storeG.slug, name: storeG.name },
      gmv: 50_025,
      paid_orders: 2,
    });
    expect(cents(year.gmv.total)).toBeGreaterThanOrEqual(gmv);
  });
});

test.describe('Financeiro (GET /platform/finance)', () => {
  test('dia sem dados → zeros com explicação; faturas do período por situação, receita pela data do pagamento e inadimplência', async () => {
    // Dia antigo sorteado: nenhuma outra fatura nem pedido vence ou é pago nele
    const day = `${2001 + Math.floor(Math.random() * 15)}-${String(1 + Math.floor(Math.random() * 12)).padStart(2, '0')}-${String(
      1 + Math.floor(Math.random() * 28),
    ).padStart(2, '0')}`;
    const empty = await finance({ from: day, to: day });
    expect(empty.period).toEqual({ from: day, to: day, days: 1 });
    expect(empty.platform_revenue).toMatchObject({ total: 0, paid_invoices: 0 });
    expect(empty.platform_revenue.note).toContain('Nenhuma fatura de assinatura paga no período');
    expect(empty.gmv).toMatchObject({ total: 0, paid_orders: 0 });
    expect(empty.gmv.note).toContain('Nenhum pedido pago registrado no período');
    expect(empty.invoices_by_status.items).toEqual([
      { status: 'OPEN', count: 0, amount: 0 },
      { status: 'PAID', count: 0, amount: 0 },
      { status: 'FAILED', count: 0, amount: 0 },
      { status: 'VOID', count: 0, amount: 0 },
    ]);
    expect(empty.top_stores_by_gmv).toEqual([]);

    // Quatro faturas da loja F vencendo nesse dia (períodos distintos): aberta, paga, recusada e anulada
    const subscriptionId = storeF.subscription.id;
    const dueAt = `${day}T12:00:00-03:00`;
    const invoiceFor = (offset: number, amount: number) =>
      createInvoice(subscriptionId, {
        amount,
        period_start: `${addDays(day, -30 + offset)}T00:00:00Z`,
        period_end: `${addDays(day, -29 + offset)}T00:00:00Z`,
        due_at: dueAt,
        notes: 'Fatura do financeiro E2E',
      });
    const open = await invoiceFor(0, 7111.11);
    const paid = await invoiceFor(1, 222.22);
    const failed = await invoiceFor(2, 8333.33);
    const voided = await invoiceFor(3, 444.44);
    try {
      await expectOk(
        await api.post(`/platform/invoices/${paid.id}/mark-paid`, {
          headers: bearer(sa.token),
          data: { paid_at: `${day}T13:00:00-03:00`, payment_method: 'PIX', provider_payment_id: `financeiro-${uid('pg')}` },
        }),
        200,
      );
      await expectOk(
        await api.post(`/platform/invoices/${failed.id}/mark-failed`, { headers: bearer(sa.token), data: { reason: 'Cartão recusado' } }),
        200,
      );
      await expectOk(
        await api.post(`/platform/invoices/${voided.id}/void`, { headers: bearer(sa.token), data: { reason: 'Lançada por engano' } }),
        200,
      );

      const result = await finance({ from: day, to: day });
      expect(result.invoices_by_status.items).toEqual([
        { status: 'OPEN', count: 1, amount: 7111.11 },
        { status: 'PAID', count: 1, amount: 222.22 },
        { status: 'FAILED', count: 1, amount: 8333.33 },
        { status: 'VOID', count: 1, amount: 444.44 },
      ]);
      // Receita = só a fatura paga, no mês do pagamento; o GMV continua zero (blocos separados)
      expect(result.platform_revenue).toMatchObject({
        total: 222.22,
        paid_invoices: 1,
        by_month: [{ month: day.slice(0, 7), amount: 222.22, invoices: 1 }],
        note: null,
      });
      expect(result.gmv).toMatchObject({ total: 0, paid_orders: 0 });

      // Inadimplência (todas as faturas OPEN/FAILED vencidas, sem depender do período)
      const delinquent = (result.delinquency.top_stores as Json[]).find((row) => row.store.id === storeF.id);
      expect(delinquent).toMatchObject({ store: { id: storeF.id, slug: storeF.slug }, amount: 15_444.44, invoices: 2 });
      expect(new Date(delinquent.oldest_due_at).toISOString()).toBe(new Date(dueAt).toISOString());
      expect(cents(result.delinquency.amount)).toBeGreaterThanOrEqual(cents(15_444.44));
      expect(result.delinquency.note).toBeNull();

      // Alerta de fatura recusada da loja F no dashboard
      const board = await dashboard();
      expect((board.alerts as Json[]).find((alert) => alert.type === 'INVOICE_FAILED' && alert.store?.id === storeF.id)).toMatchObject({
        data: { invoices: 1, amount: 8333.33 },
      });
    } finally {
      // Anula as faturas vencidas: a inadimplência e os alertas voltam ao que eram para as outras suítes
      for (const invoice of [open, failed]) {
        await api.post(`/platform/invoices/${invoice.id}/void`, { headers: bearer(sa.token), data: { reason: 'Limpeza do teste E2E' } });
      }
    }
    const cleaned = await finance({ from: day, to: day });
    expect((cleaned.delinquency.top_stores as Json[]).some((row) => row.store.id === storeF.id)).toBe(false);
    expect(cleaned.invoices_by_status.items.find((row: Json) => row.status === 'VOID')).toMatchObject({ count: 3 });
  });

  test('período: padrão de 12 meses, no máximo 3 anos e datas no formato AAAA-MM-DD', async () => {
    const standard = await finance();
    expect(standard.period.days).toBeGreaterThanOrEqual(334);
    expect(standard.period.days).toBeLessThanOrEqual(366);
    expect(standard.period.from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(standard.gmv.by_month).toHaveLength(12);
    expect(standard.platform_revenue.by_month).toHaveLength(12);
    for (const [params, message] of [
      [{ from: '2026-13-01' }, 'Período inválido: informe from e to no formato AAAA-MM-DD (ex.: from=2026-01-01&to=2026-10-31).'],
      [{ from: '2026-10-02', to: '2026-10-01' }, 'A data inicial (from) não pode ser depois da data final (to).'],
      [{ from: '2020-01-01', to: '2023-12-31' }, 'O período pode ter no máximo 1096 dias (3 anos).'],
    ] as const) {
      await expectApiError(
        await api.get('/platform/finance', { headers: bearer(sa.token), params }),
        400,
        message,
        JSON.stringify(params),
      );
    }
  });
});

test.describe('Loja desativada com assinatura vigente', () => {
  test('plano pago: alerta INACTIVE_STORE_BILLED (a cobrança continua e ela segue nos indicadores); cancelada a assinatura, o alerta some', async () => {
    const inactive = await createStore(api, sa.token, { planId: planFinance.id, name: `Desativada com assinatura ${letters(8)}` });
    await expectOk(
      await api.post(`/platform/stores/${inactive.id}/deactivate`, {
        headers: bearer(sa.token),
        data: { reason: 'Encerramento da loja (E2E)' },
      }),
      200,
      'desativação da loja',
    );
    const alertOf = (board: Json) =>
      (board.alerts as Json[]).find((item) => item.type === 'INACTIVE_STORE_BILLED' && item.store?.id === inactive.id);

    const alert = alertOf(await dashboard());
    expect(alert, 'alerta da loja desativada com assinatura paga').toMatchObject({
      severity: 'warning',
      store: { id: inactive.id, slug: inactive.slug },
    });
    expect(['ACTIVE', 'PAST_DUE']).toContain(alert.data.subscription_status);
    expect(alert.message).toContain('Cancele a assinatura ou restaure a loja');

    await expectOk(
      await api.post(`/platform/subscriptions/${inactive.subscription.id}/cancel`, {
        headers: bearer(sa.token),
        data: { reason: 'Loja encerrada (E2E)' },
      }),
      200,
      'cancelamento da assinatura',
    );
    expect(alertOf(await dashboard()), 'assinatura cancelada: sem alerta').toBeUndefined();
  });
});
