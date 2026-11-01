import { test, expect, type APIRequestContext } from '@playwright/test';
import { loginAs } from '../../../support/api';
import {
  Cleanup,
  MISSING_ID,
  MSG,
  addAddress,
  addDaysKey,
  addMember,
  addProduct,
  advance,
  bearer,
  cancelOrderLater,
  cents,
  createStore,
  dateKey,
  demoStore,
  demoTeam,
  expectAllFromStore,
  expectError,
  expectNoneOf,
  expectStatus,
  expectUniform404,
  getJson,
  ids,
  newApi,
  newCustomer,
  payCard,
  pendingFinalizations,
  placeOrder,
  retireStore,
  trashProductLater,
  uid,
  type Json,
  type Member,
  type PublicStore,
  type Session,
  type Team,
  type TenantStore,
} from './helpers';

/**
 * Seção 16 do pedido — "Relatórios não agregam dados indevidos de outros estabelecimentos".
 * Os números da loja A (dashboard, gráficos, relatório, clientes, uso do plano e métricas do
 * superpainel) são lidos ANTES e DEPOIS de a loja B vender (pedidos pagos, na entrega, cancelado) e
 * precisam ser idênticos; os números de B precisam bater exatamente com os pedidos de B.
 */
test.describe('Isolamento entre lojas: relatórios, dashboard e clientes', () => {
  const cleanup = new Cleanup();
  let api: APIRequestContext;
  let superadmin: Session;
  let demo: PublicStore;
  let teamA: Team;
  let storeB: TenantStore;
  let employeeB: Member;
  let onlyB: Member;
  let both: Member;
  let burger: Json;
  let drink: Json;
  let productA: Json;
  let aOrder: Json;
  const ordersB: Json[] = [];
  let range: { from: string; to: string };

  type Snapshot = Record<string, Json>;
  let before: Snapshot;
  let after: Snapshot;

  async function snapshotA(): Promise<Snapshot> {
    const t = teamA.ADMIN.token;
    const query = `from=${range.from}&to=${range.to}`;
    return {
      summary: await getJson(api, '/orders/summary', t),
      charts: await getJson(api, '/orders/charts', t),
      report: await getJson(api, `/orders/reports?${query}`, t),
      customers: await getJson(api, '/store/customers?pageSize=100', t),
      bothDetail: await getJson(api, `/store/customers/${both.user.id}`, t),
      usage: (await getJson(api, '/store/subscription', t)).usage,
      metrics: await getJson(api, `/platform/stores/${demo.id}/metrics?${query}`, superadmin.token),
    };
  }

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    api = await newApi();
    superadmin = await loginAs(api, 'superadmin');
    demo = await demoStore();
    teamA = await demoTeam(api);
    const today = dateKey(new Date(), 'America/Sao_Paulo');
    range = { from: addDaysKey(today, -6), to: today };

    storeB = await createStore(api, superadmin, 'Relatorios');
    cleanup.add('desativar a loja B', () => retireStore(api, superadmin, storeB));
    employeeB = await addMember(api, storeB.owner, 'EMPLOYEE');
    burger = await addProduct(api, storeB.owner, { name: `Burger Campeão B ${uid('r')}`, price: 20 });
    drink = await addProduct(api, storeB.owner, { name: `Suco da Casa B ${uid('r')}`, price: 8, category: 'bebidas' });

    onlyB = await newCustomer(api, 'Cliente so de B');
    both = await newCustomer(api, 'Cliente de A e B');
    const addressBoth = await addAddress(api, both, 'Centro');

    // O cliente das duas lojas compra primeiro em A (antes da leitura "antes")
    productA = await addProduct(api, teamA.ADMIN, { name: `Produto A relatório ${uid('r')}`, price: 11 });
    trashProductLater(cleanup, api, teamA.ADMIN, productA.id);
    aOrder = await placeOrder(api, demo.slug, both, { items: [{ productId: productA.id, quantity: 1 }], type: 'TAKEOUT' });
    cancelOrderLater(cleanup, api, teamA.ADMIN, aOrder.id);

    // PIX do sandbox deixado por outros arquivos na loja A vira pedido pela conciliação: espera terminar
    await expect
      .poll(() => pendingFinalizations(demo.id), {
        timeout: 120_000,
        intervals: [1_000, 2_000, 5_000],
        message: 'pagamentos da loja A ainda virando pedido (conciliação)',
      })
      .toBe(0);
    before = await snapshotA();

    // Vendas da loja B: na entrega concluída (paga), cartão (pago), entrega paga, cancelado e pendente
    const b1 = await placeOrder(api, storeB.slug, onlyB, { items: [{ productId: burger.id, quantity: 2 }], type: 'TAKEOUT' });
    await advance(api, storeB.owner, b1.id, 'PREPARING', 'READY_FOR_PICKUP', 'DONE');
    const b2 = await payCard(api, storeB.slug, onlyB, { items: [{ productId: burger.id, quantity: 1 }, { productId: drink.id, quantity: 1 }], type: 'TAKEOUT' });
    const b3 = await payCard(api, storeB.slug, both, { items: [{ productId: burger.id, quantity: 1 }], type: 'DELIVERY', addressId: addressBoth.id });
    const b4 = await placeOrder(api, storeB.slug, both, { items: [{ productId: drink.id, quantity: 3 }], type: 'TAKEOUT' });
    await expectStatus(await api.patch(`/orders/${b4.id}/cancel`, { headers: bearer(storeB.owner.token) }), 200, 'cancelar pedido de B');
    const b5 = await placeOrder(api, storeB.slug, onlyB, { items: [{ productId: drink.id, quantity: 1 }], type: 'TAKEOUT' });
    for (const id of [b1.id, b2.orderId, b3.orderId, b4.id, b5.id]) {
      ordersB.push(await getJson(api, `/orders/${id}`, storeB.owner.token, `pedido #${id} de B`));
    }

    after = await snapshotA();
  });

  test.afterAll(async () => {
    await cleanup.run();
    await api.dispose();
  });

  test('dashboard, gráficos e relatório da loja A são idênticos antes e depois das vendas da loja B', async () => {
    expect(after.summary, 'GET /orders/summary de A').toEqual(before.summary);
    expect(after.charts, 'GET /orders/charts de A').toEqual(before.charts);
    expect(after.report, 'GET /orders/reports de A').toEqual(before.report);
    const names = (after.report.topProducts as Json[]).map((p) => p.name);
    expect(names.filter((name) => name === burger.name || name === drink.name), 'produtos de B fora do relatório de A').toEqual([]);
    const chartNames = (after.charts.productsChart as Json[]).map((p) => p.name);
    expect(chartNames.filter((name) => name === burger.name || name === drink.name)).toEqual([]);
  });

  test('clientes da loja A: quem só comprou em B não aparece e o cliente das duas lojas aparece só com os pedidos de A', async () => {
    expect(after.customers, 'GET /store/customers de A').toEqual(before.customers);
    expectNoneOf(after.customers.items, [onlyB.user.id], 'clientes de A');
    expect(after.bothDetail, 'detalhe do cliente das duas lojas em A').toEqual(before.bothDetail);
    expectAllFromStore(after.bothDetail.orders, demo.id, 'pedidos do cliente na loja A');
    expect(ids(after.bothDetail.orders)).toEqual([aOrder.id]);
    expect(after.bothDetail.stats.orders_count).toBe(1);

    for (const staff of [teamA.ADMIN, teamA.EMPLOYEE]) {
      const headers = bearer(staff.token);
      await expectUniform404(
        await api.get(`/store/customers/${onlyB.user.id}`, { headers }),
        await api.get(`/store/customers/${MISSING_ID}`, { headers }),
        MSG.customerNotFound,
        `${staff.user.role} de A: cliente que só comprou em B`,
      );
      const search = await getJson(api, `/store/customers?search=${encodeURIComponent(onlyB.email)}`, staff.token);
      expect(search, 'busca pelo e-mail do cliente de B na loja A').toMatchObject({ items: [], total: 0 });
    }
  });

  test('uso do plano e métricas do superpainel da loja A não mudam com as vendas de B', async () => {
    expect(after.usage, 'uso do plano de A (pedidos do mês, produtos, equipe)').toEqual(before.usage);
    expect(after.metrics, 'GET /platform/stores/<A>/metrics').toEqual(before.metrics);
  });

  test('os números da loja B contam exatamente os pedidos de B (dashboard, gráficos, relatório, clientes e métricas)', async () => {
    const t = storeB.owner.token;
    expect(ids(await getJson(api, '/orders', t)), 'pedidos de B').toEqual(ids(ordersB));
    const live = ordersB.filter((o) => o.status !== 'CANCELED');
    const paid = live.filter((o) => o.payment_status === 'PAID');
    const revenueCents = paid.reduce((sum, o) => sum + cents(o.total_price), 0);
    expect(revenueCents, 'B vendeu R$ 92,00 pagos (40 + 28 + 24)').toBe(9200);

    expect(await getJson(api, '/orders/summary', t)).toEqual({
      totalOrders: live.length,
      revenue: revenueCents / 100,
      pendingOrders: live.filter((o) => o.status === 'PENDING').length,
      preparingOrders: live.filter((o) => o.status === 'PREPARING').length,
      pendingPayments: live.filter((o) => o.payment_status === 'PENDING' && o.status !== 'DONE').length,
    });

    const report = await getJson(api, `/orders/reports?from=${range.from}&to=${range.to}`, t);
    expect(report.summary).toEqual({
      orders: ordersB.length,
      canceledOrders: 1,
      paidOrders: paid.length,
      revenue: revenueCents / 100,
      averageTicket: Math.round(revenueCents / paid.length) / 100,
    });
    expect(report.topProducts).toEqual([
      { name: burger.name, quantity: 4 },
      { name: drink.name, quantity: 2 },
    ]);
    const charts = await getJson(api, '/orders/charts', t);
    expect(charts.productsChart).toEqual([
      { name: burger.name, quantity: 4 },
      { name: drink.name, quantity: 2 },
    ]);
    expect((charts.revenueChart as Json[]).reduce((sum, day) => sum + cents(day.total), 0)).toBe(revenueCents);

    // Clientes de B: os dois que compraram em B, cada um só com os pedidos de B
    for (const staff of [storeB.owner, employeeB]) {
      const customers = await getJson(api, '/store/customers?pageSize=100', staff.token);
      expect(customers.total).toBe(2);
      expect(ids(customers.items)).toEqual(ids([onlyB.user, both.user]));
    }
    const bothInB = await getJson(api, `/store/customers/${both.user.id}`, t);
    expectAllFromStore(bothInB.orders, storeB.id, 'pedidos do cliente das duas lojas em B');
    expect(ids(bothInB.orders)).toEqual(ids(ordersB.filter((o) => o.user?.id === both.user.id)));
    expect(bothInB.stats).toMatchObject({ orders_count: 2, total_spent: 24 });
    const onlyBInB = await getJson(api, `/store/customers/${onlyB.user.id}`, t);
    expect(onlyBInB.stats).toMatchObject({ orders_count: 3, total_spent: 68 });

    // Uso do plano de B: pedidos do mês (sem o cancelado), produtos e equipe só de B
    expect((await getJson(api, '/store/subscription', t)).usage).toEqual({ staff_users: 2, products: 2, monthly_orders: live.length });

    // Superpainel: métricas de B
    const metrics = await getJson(api, `/platform/stores/${storeB.id}/metrics?from=${range.from}&to=${range.to}`, superadmin.token);
    expect(metrics.store).toMatchObject({ id: storeB.id, slug: storeB.slug });
    expect(metrics.summary).toMatchObject({ orders: ordersB.length, canceled_orders: 1, paid_orders: paid.length, gmv: revenueCents / 100 });
  });

  test('relatórios e dashboard são do ADMIN da própria loja: atendente → 403; slug de B com token de A → 403', async () => {
    for (const path of ['/orders/summary', '/orders/charts', `/orders/reports?from=${range.from}&to=${range.to}`]) {
      await expectError(await api.get(path, { headers: bearer(employeeB.token) }), 403, MSG.noPermission, `atendente de B: ${path}`);
      await expectError(
        await api.get(`/stores/${storeB.slug}${path}`, { headers: bearer(teamA.ADMIN.token) }),
        403,
        MSG.otherStore,
        `ADMIN de A: /stores/<B>${path}`,
      );
    }
    await expectError(
      await api.get(`/platform/stores/${storeB.id}/metrics`, { headers: bearer(teamA.ADMIN.token) }),
      403,
      MSG.platformOnly,
      'métricas de B pelo superpainel com token de loja',
    );
  });
});
