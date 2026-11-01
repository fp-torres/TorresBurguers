import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  addProduct,
  ALL_FEATURES,
  bearer,
  Cleanup,
  createPlan,
  createStore,
  defaultSession,
  expectError,
  expectNoCredentials,
  expectStatus,
  login,
  MSG,
  newApi,
  newCustomer,
  PASSWORD,
  platformAction,
  postCard,
  storeOverview,
  subscriptionDetail,
  uid,
  uniqueEmail,
  type Json,
  type Member,
  type Plan,
  type Session,
} from './helpers';

/**
 * Separação financeira (spec §8): a assinatura que a loja paga à Comestra (faturas SaaS) nunca se
 * mistura com as vendas da loja (pedidos, pagamentos do delivery, relatórios, dashboard, clientes);
 * credenciais nunca aparecem nas respostas da cobrança; GET /store/subscription e as ações da
 * assinatura são só do ADMIN da própria loja (demais perfis 403, anônimo 401).
 */

const cleanup = new Cleanup();
let superadmin: Session;
let plan: Plan;
let customer: Member;

test.beforeAll(async () => {
  const api = await newApi();
  superadmin = await defaultSession(api, 'superadmin');
  plan = await createPlan(api, superadmin, cleanup, { name: 'Separação E2E', price: 99.9, features: ALL_FEATURES });
  customer = await newCustomer(api);
  await api.dispose();
});

test.afterAll(async () => {
  await cleanup.run();
});

/** Data AAAA-MM-DD no fuso da loja (lojas novas: America/Sao_Paulo). */
function todayInStoreZone(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Tudo o que a equipe da loja enxerga das próprias vendas. */
async function storeSalesViews(request: APIRequestContext, admin: Session): Promise<Record<string, Json>> {
  const headers = bearer(admin.token);
  const today = todayInStoreZone();
  const views: Record<string, Json> = {};
  for (const [key, path] of [
    ['orders', '/orders'],
    ['summary', '/orders/summary'],
    ['reports', `/orders/reports?from=${today}&to=${today}`],
    ['charts', '/orders/charts'],
    ['customers', '/store/customers'],
  ] as const) {
    views[key] = await expectStatus(await request.get(path, { headers }), 200, `GET ${path}`);
  }
  return views;
}

async function platformRevenue(request: APIRequestContext): Promise<{ total: number; paid_invoices: number }> {
  const finance = await expectStatus(
    await request.get('/platform/finance', { headers: bearer(superadmin.token) }),
    200,
    'GET /platform/finance',
  );
  return finance.platform_revenue;
}

const cents = (value: number) => Math.round(value * 100);

test('GET /store/subscription e as ações da assinatura: só o ADMIN da própria loja', async ({ request }) => {
  const store = await createStore(request, superadmin, cleanup, plan.id, 'Acesso à assinatura', { open: false });
  const owner = bearer(store.owner.token);
  const team: Record<string, Session> = {};
  for (const role of ['EMPLOYEE', 'KITCHEN', 'COURIER']) {
    const email = uniqueEmail(`bl-${role.toLowerCase()}`);
    await expectStatus(
      await request.post('/users', { headers: owner, data: { name: `Equipe ${role}`, email, password: PASSWORD, role } }),
      201,
      `cadastro de ${role}`,
    );
    team[role] = await login(request, email, PASSWORD);
  }
  // Equipe da loja com outro perfil → "sem permissão"; contas sem loja → "exclusiva da equipe"
  const actors: Array<[string, Session, string]> = [
    ...Object.entries(team).map(([role, session]): [string, Session, string] => [role, session, MSG.noPermission]),
    ['CLIENT', customer, MSG.staffOnly],
    ['SUPER_ADMIN (sem loja)', superadmin, MSG.staffOnly],
  ];
  for (const [label, session, message] of actors) {
    const headers = bearer(session.token);
    await expectError(await request.get('/store/subscription', { headers }), 403, message, `${label}: GET`);
    for (const action of ['cancel', 'resume', 'checkout']) {
      await expectError(
        await request.post(`/store/subscription/${action}`, { headers, data: {} }),
        403,
        message,
        `${label}: POST ${action}`,
      );
    }
  }
  await expectError(await request.get('/store/subscription'), 401, MSG.invalidSession, 'anônimo');

  // O ADMIN vê só a própria assinatura; o ADMIN da loja demo vê a dele (sem as faturas desta loja)
  const own = await storeOverview(request, store.owner);
  expect(own.subscription.id).toBe(store.subscriptionId);
  const platformIds = (await subscriptionDetail(request, superadmin, store.subscriptionId)).invoices.map((i: Json) => i.id);
  expect(own.invoices.map((invoice: Json) => invoice.id).sort()).toEqual([...platformIds].sort());
  const demoAdmin = await defaultSession(request, 'admin');
  const demo = await storeOverview(request, demoAdmin);
  expect(demo.subscription.id).not.toBe(store.subscriptionId);
  for (const id of platformIds) expect(demo.invoices.map((invoice: Json) => invoice.id)).not.toContain(id);

  // A loja nunca vem do corpo da requisição, e o ADMIN não usa as rotas do superpainel
  await expectError(
    await request.post('/store/subscription/cancel', { headers: owner, data: { store_id: demoAdmin.user.store_id } }),
    400,
    MSG.notAllowed('store_id'),
    'store_id no corpo',
  );
  await expectError(await request.get(`/platform/subscriptions/${store.subscriptionId}`, { headers: owner }), 403, MSG.platformOnly, 'detalhe do superpainel');
  await expectError(await request.get('/platform/invoices', { headers: owner }), 403, MSG.platformOnly, 'faturas do superpainel');
  // Provedor MANUAL: sem cobrança online (a loja paga pelos meios combinados com a plataforma)
  await expectError(
    await request.post('/store/subscription/checkout', { headers: owner, data: {} }),
    409,
    'Cobrança online não configurada. Fale com a administração da plataforma para pagar a assinatura.',
    'checkout sem provedor online',
  );
  expect((await subscriptionDetail(request, superadmin, store.subscriptionId)).cancel_at_period_end, 'nada mudou').toBe(false);
});

test('faturas SaaS nunca entram nos pedidos, pagamentos, relatórios e dashboard da loja (e vice-versa)', async ({ request }) => {
  const store = await createStore(request, superadmin, cleanup, plan.id, 'Separação financeira');
  const product = await addProduct(request, store.owner, { price: 25 });
  const sub = store.subscriptionId;
  const revenueA = await platformRevenue(request);

  // Venda da loja (cartão no sandbox: aprovado na hora, pedido pago) não gera fatura nem receita da plataforma
  const card = await expectStatus(await postCard(request, store.slug, customer, product.id), 201, 'pagamento com cartão');
  expect(card).toMatchObject({ status: 'approved' });
  expect(typeof card.orderId).toBe('number');
  const detail = await subscriptionDetail(request, superadmin, sub);
  expect(detail.invoices, 'a venda não cria fatura da assinatura').toHaveLength(1);
  expect(await platformRevenue(request), 'a venda não é receita da plataforma').toEqual(revenueA);

  const before = await storeSalesViews(request, store.owner);
  expect(before.reports.summary.revenue, 'faturamento da loja = só a venda').toBe(25);

  // A loja paga a assinatura: duas faturas SaaS quitadas
  const extra = await platformAction(request, superadmin, `/platform/subscriptions/${sub}/invoices`, { amount: 77.77 }, 201);
  for (const invoice of [detail.invoices[0], extra]) {
    await platformAction(request, superadmin, `/platform/invoices/${invoice.id}/mark-paid`, {
      payment_method: 'PIX',
      provider_payment_id: uid('saas'),
    });
  }
  const after = await storeSalesViews(request, store.owner);
  expect(after, 'pedidos, resumo, relatórios, gráficos e clientes da loja não mudam').toEqual(before);
  expect((after.orders as Json[]).map((order) => order.id)).toEqual([card.orderId]);

  const revenueB = await platformRevenue(request);
  expect(cents(revenueB.total) - cents(revenueA.total), 'receita da plataforma = faturas SaaS pagas').toBe(cents(99.9 + 77.77));
  expect(revenueB.paid_invoices - revenueA.paid_invoices).toBe(2);
});

test('credenciais e segredos nunca aparecem nas respostas da cobrança', async ({ request }) => {
  const store = await createStore(request, superadmin, cleanup, plan.id, 'Credenciais', { open: false });
  const accessToken = `TEST-${randomBytes(24).toString('hex')}`;
  const credentials = await expectStatus(
    await request.put('/store/settings/payments', {
      headers: bearer(store.owner.token),
      data: { mp_public_key: `TEST-${randomBytes(12).toString('hex')}`, mp_access_token: accessToken },
    }),
    200,
    'PUT /store/settings/payments',
  );
  expect(JSON.stringify(credentials).includes(accessToken), 'o Access Token é só de escrita').toBe(false);

  const sub = store.subscriptionId;
  const headers = bearer(superadmin.token);
  const invoice = await platformAction(request, superadmin, `/platform/subscriptions/${sub}/invoices`, {}, 201);
  const responses: Array<[string, Json]> = [
    ['GET /store/subscription', await storeOverview(request, store.owner)],
    ['GET /platform/subscriptions/:id', await subscriptionDetail(request, superadmin, sub)],
    ['GET /platform/subscriptions', await expectStatus(await request.get(`/platform/subscriptions?search=${store.slug}`, { headers }), 200)],
    ['GET /platform/invoices', await expectStatus(await request.get(`/platform/invoices?search=${store.slug}`, { headers }), 200)],
    ['POST /platform/subscriptions/:id/invoices', invoice],
    [
      'POST /platform/invoices/:id/mark-paid',
      await platformAction(request, superadmin, `/platform/invoices/${invoice.id}/mark-paid`, { provider_payment_id: uid('cred') }),
    ],
    ['GET /platform/plans/:id', await expectStatus(await request.get(`/platform/plans/${plan.id}`, { headers }), 200)],
    ['GET /plans', await expectStatus(await request.get('/plans'), 200)],
  ];
  for (const [label, payload] of responses) expectNoCredentials(payload, label, [accessToken]);

  // O painel da loja não mostra os identificadores internos do provedor nem as notas do operador
  const overview = responses[0][1];
  expect(overview.subscription).not.toHaveProperty('provider_subscription_id');
  for (const item of overview.invoices as Json[]) {
    expect(item).not.toHaveProperty('provider_payment_id');
    expect(item).not.toHaveProperty('notes');
  }
});
