/**
 * "A suspensão de uma loja não apaga seus dados" (pedido §6.2 e §16; arquitetura §4.2 e §11.6):
 * produtos, adicionais, pedidos (com preços e situação), equipe, convites, clientes, configurações
 * (inclusive pagamentos e horários), assinatura e indicadores ficam intactos ao suspender e ao
 * reativar — e também ao desativar e restaurar ("nada é apagado"). Tudo numa loja própria do teste.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  STRONG_PASSWORD,
  bearer,
  changeStoreStatus,
  cleanupPlatformData,
  completeOrder,
  createPlan,
  createProductAs,
  expectApiError,
  expectOk,
  freshSession,
  newApi,
  newClientAccount,
  openStore,
  placeTakeoutOrder,
  storeWithOwner,
  uniqueEmail,
  MSG,
  type Json,
  type Session,
  type StoreWithOwner,
  type TestAccount,
} from './helpers';

let api: APIRequestContext;
let sa: Session;
let store: StoreWithOwner;
let clients: TestAccount[];

/** Lista ordenada por id, só com os campos que importam para "os dados continuam lá". */
const byId = <T extends { id: number }>(items: T[], pick: (item: T) => Json) =>
  [...items].sort((a, b) => a.id - b.id).map((item) => ({ id: item.id, ...pick(item) }));

/** O que muda numa troca de situação (e só isso): situação, motivo, datas e capacidades do momento. */
const VOLATILE_STORE_KEYS = ['account_status', 'status_reason', 'status_changed_at', 'updated_at', 'access'];
const withoutVolatile = (value: Json) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !VOLATILE_STORE_KEYS.includes(key)));

/** Retrato pelo superpainel (vale também com a loja desativada). */
async function platformSnapshot(): Promise<Json> {
  const headers = bearer(sa.token);
  const detail = await expectOk(await api.get(`/platform/stores/${store.id}`, { headers }), 200);
  const team = await expectOk(await api.get(`/platform/stores/${store.id}/users`, { headers }), 200);
  const invitations = await expectOk(await api.get(`/platform/stores/${store.id}/invitations`, { headers }), 200);
  const metrics = await expectOk(await api.get(`/platform/stores/${store.id}/metrics`, { headers }), 200);
  const subscription = await expectOk(await api.get(`/platform/subscriptions/${store.subscription.id}`, { headers }), 200);
  return {
    store: withoutVolatile(detail),
    team: byId(team.items, (user: Json) => ({ email: user.email, role: user.role, deleted_at: user.deleted_at, is_owner: user.is_owner })),
    invitations: byId(invitations.items, (inv: Json) => ({ email: inv.email, role: inv.role, status: inv.status })),
    metrics: { summary: metrics.summary, by_status: metrics.by_status, by_payment_method: metrics.by_payment_method },
    subscription: { id: subscription.id, status: subscription.status, plan_id: subscription.plan_id, invoices: subscription.invoices.length },
  };
}

/** Retrato pelo painel da loja (ADMIN, leitura) e pelos clientes. */
async function panelSnapshot(): Promise<Json> {
  const headers = bearer(store.owner.token);
  const settings = await expectOk(await api.get('/store/settings', { headers }), 200, 'GET /store/settings');
  const products = await expectOk(await api.get('/products', { headers }), 200, 'GET /products');
  const trash = await expectOk(await api.get('/products/trash', { headers }), 200, 'GET /products/trash');
  const addons = await expectOk(await api.get('/addons', { headers }), 200, 'GET /addons');
  const orders = await expectOk(await api.get('/orders', { headers }), 200, 'GET /orders');
  const team = await expectOk(await api.get('/users', { headers }), 200, 'GET /users');
  const customers = await expectOk(await api.get('/store/customers', { headers }), 200, 'GET /store/customers');
  const invitations = await expectOk(await api.get('/store/invitations', { headers }), 200, 'GET /store/invitations');
  const myOrders: Json[] = [];
  for (const client of clients) {
    const own = await expectOk(await api.get(`/stores/${store.slug}/orders/my-orders`, { headers: bearer(client.token) }), 200);
    myOrders.push(byId(own, (order: Json) => ({ status: order.status, total_price: order.total_price })));
  }
  return {
    settings: withoutVolatile(settings),
    products: byId(products, (p: Json) => ({
      name: p.name,
      price: p.price,
      category: p.category,
      available: p.available,
      allowed_addons: (p.allowed_addons ?? []).map((addon: Json) => addon.id).sort(),
    })),
    trash: byId(trash, (p: Json) => ({ name: p.name })),
    addons: byId(addons, (a: Json) => ({ name: a.name, price: a.price })),
    orders: byId(orders, (o: Json) => ({
      status: o.status,
      payment_status: o.payment_status,
      payment_method: o.payment_method,
      total_price: o.total_price,
      customer: o.user?.id ?? null,
      items: (o.items ?? []).map((item: Json) => ({ product: item.product?.id, quantity: item.quantity, unit_price: item.unit_price })),
    })),
    team: byId(team, (user: Json) => ({ email: user.email, role: user.role })),
    customers: { total: customers.total, items: byId(customers.items, (c: Json) => ({ orders_count: c.orders_count, total_spent: c.total_spent })) },
    invitations: byId(invitations.items, (inv: Json) => ({ email: inv.email, status: inv.status })),
    myOrders,
  };
}

test.beforeAll(async () => {
  api = await newApi();
  sa = await freshSession(api, 'superadmin');
  const plan = await createPlan(api, sa.token, {
    price: 0,
    features: { online_payments: true, advanced_reports: true, custom_branding: true },
  });
  store = await storeWithOwner(api, sa.token, { planId: plan.id });
  const owner = bearer(store.owner.token);

  // Configurações completas: cadastro, endereço, operação, entrega, horários, identidade e pagamentos
  await expectOk(
    await api.patch('/store/settings', {
      headers: owner,
      data: {
        description: 'Loja com dados completos para o teste de suspensão.',
        phone: '21977776666',
        address_zip_code: '20040003',
        address_street: 'Rua da Suspensão',
        address_number: '42',
        address_neighborhood: 'Centro',
        address_city: 'Rio de Janeiro',
        address_state: 'RJ',
        opening_message: 'Aberto! Peça já.',
        closing_message: 'Fechado por hoje.',
        takeout_estimate: '10-15 min',
        opening_hours: [{ day: 1, open: '18:00', close: '23:00' }],
        delivery_zones: { fallback: { fee: 9, time: '40-50 min' }, zones: [{ neighborhoods: ['Centro'], fee: 4, time: '20-30 min' }] },
        delivery_enabled: true,
        primary_color: '#0F766E',
      },
    }),
    200,
    'PATCH /store/settings',
  );
  await expectOk(
    await api.put('/store/settings/payments', {
      headers: owner,
      data: { mp_public_key: 'TEST-chave-publica-suspensao', mp_access_token: 'TEST-token-de-acesso-suspensao-123456' },
    }),
    200,
    'PUT /store/settings/payments',
  );

  // Cardápio: adicional, produtos (um com o adicional) e um produto na lixeira
  const addon = await expectOk(await api.post('/addons', { headers: owner, data: { name: 'Bacon extra', price: 4.5 } }), 201);
  const burger = await createProductAs(api, store.owner.token, { name: 'X-Suspensão', price: 32.9, allowed_addons_ids: [addon.id] });
  const drink = await createProductAs(api, store.owner.token, { name: 'Suco da casa', price: 9.5, category: 'bebidas' });
  const retired = await createProductAs(api, store.owner.token, { name: 'Produto aposentado', price: 5 });
  await expectOk(await api.delete(`/products/${retired.id}`, { headers: owner }), 200);

  // Equipe e convite pendente
  await expectOk(
    await api.post('/users', {
      headers: owner,
      data: { name: 'Atendente da Suspensão', email: uniqueEmail('plat-atendente'), password: STRONG_PASSWORD, role: 'EMPLOYEE' },
    }),
    201,
  );
  await expectOk(await api.post('/store/invitations', { headers: owner, data: { email: uniqueEmail('plat-convidado'), role: 'KITCHEN' } }), 201);

  // Pedidos de dois clientes: pago (concluído), pendente e cancelado
  await openStore(api, store.owner.token);
  clients = [await newClientAccount(api, 'Cliente A Suspensão'), await newClientAccount(api, 'Cliente B Suspensão')];
  const paid = await placeTakeoutOrder(api, clients[0].token, store.slug, [
    { productId: burger.id, quantity: 2 },
    { productId: drink.id, quantity: 1 },
  ]);
  await completeOrder(api, store.owner.token, paid.id);
  await placeTakeoutOrder(api, clients[1].token, store.slug, [{ productId: drink.id, quantity: 3 }]);
  const canceled = await placeTakeoutOrder(api, clients[0].token, store.slug, [{ productId: burger.id, quantity: 1 }]);
  await expectOk(await api.patch(`/orders/${canceled.id}/cancel`, { headers: owner }), 200);
});

test.afterAll(async () => {
  if (!api) return;
  try {
    await cleanupPlatformData(api, sa.token);
  } finally {
    await api.dispose();
  }
});

test('suspender e reativar não apagam produtos, pedidos, equipe, clientes, convites, configurações nem a assinatura', async () => {
  const platformBefore = await platformSnapshot();
  const panelBefore = await panelSnapshot();
  // Retrato não vazio: o teste compara dados de verdade
  expect(panelBefore.products).toHaveLength(2);
  expect(panelBefore.trash).toHaveLength(1);
  expect(panelBefore.orders).toHaveLength(3);
  expect(panelBefore.team).toHaveLength(2);
  expect(panelBefore.customers.total).toBe(2);
  expect(panelBefore.invitations).toHaveLength(2);
  expect(panelBefore.settings.payments).toMatchObject({ access_token_configured: true, mp_public_key: 'TEST-chave-publica-suspensao' });
  expect(platformBefore.store.metrics).toMatchObject({ orders_total: 2, canceled_orders_total: 1, customers: 2, staff: 2 });
  expect(platformBefore.store.metrics.gmv_total).toBeCloseTo(32.9 * 2 + 9.5, 2);

  const suspended = await changeStoreStatus(api, sa.token, store.id, 'suspend', 'Auditoria cadastral (teste de preservação)');
  expect(suspended.account_status).toBe('SUSPENDED');
  expect(await platformSnapshot(), 'superpainel com a loja suspensa').toEqual(platformBefore);
  expect(await panelSnapshot(), 'painel da loja suspensa (leitura)').toEqual(panelBefore);

  await changeStoreStatus(api, sa.token, store.id, 'reactivate', 'Auditoria concluída');
  expect(await platformSnapshot(), 'superpainel depois de reativar').toEqual(platformBefore);
  expect(await panelSnapshot(), 'painel depois de reativar').toEqual(panelBefore);
});

test('desativar e restaurar também não apagam nada (o painel fecha enquanto a loja está desativada)', async () => {
  const platformBefore = await platformSnapshot();
  const panelBefore = await panelSnapshot();

  await changeStoreStatus(api, sa.token, store.id, 'deactivate', 'Encerramento temporário (teste de preservação)');
  expect(await platformSnapshot(), 'superpainel com a loja desativada').toEqual(platformBefore);
  // As sessões da equipe foram encerradas pela desativação e o login fica recusado enquanto ela durar
  await expectApiError(await api.get('/store/settings', { headers: bearer(store.owner.token) }), 401, MSG.session);
  await expectApiError(
    await api.post('/auth/login', { data: { email: store.owner.email, password: store.owner.password } }),
    403,
    MSG.inactiveStoreLogin,
  );
  // O histórico do cliente continua acessível (pedidos são do cliente também)
  const history = await expectOk(await api.get('/orders/my-orders', { headers: bearer(clients[0].token) }), 200);
  expect(history.filter((order: Json) => order.store?.id === store.id)).toHaveLength(2);

  await changeStoreStatus(api, sa.token, store.id, 'restore', 'Retomada (teste de preservação)');
  // Restaurada, a equipe entra de novo (a sessão antiga continua encerrada)
  const relogin = await expectOk(
    await api.post('/auth/login', { data: { email: store.owner.email, password: store.owner.password } }),
    201,
    'login do responsável depois de restaurar',
  );
  store.owner.token = relogin.access_token;
  expect(await platformSnapshot(), 'superpainel depois de restaurar').toEqual(platformBefore);
  expect(await panelSnapshot(), 'painel depois de restaurar').toEqual(panelBefore);
});
