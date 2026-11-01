import { expect, test } from '@playwright/test';
import { makePng, pngFile } from '../identity/helpers';
import {
  acceptInvitation,
  addProduct,
  ALL_FEATURES,
  bearer,
  cancelOrderLater,
  Cleanup,
  createPlan,
  createStore,
  defaultSession,
  expectError,
  expectStatus,
  FEATURE_LABEL,
  LIMIT_LABEL,
  MSG,
  newApi,
  newCustomer,
  NO_FEATURES,
  PASSWORD,
  platformAction,
  postCard,
  postOrder,
  postPix,
  postProduct,
  storeOverview,
  storePath,
  uniqueEmail,
  type BillingStore,
  type Member,
  type Plan,
  type Session,
} from './helpers';

/**
 * Limites e recursos do plano (PlanLimitsService): max_products (inclusive restaurar da lixeira),
 * max_staff_users (cadastro direto, convite, aceite e restauração), max_monthly_orders (cancelados não
 * contam) e os recursos online_payments, advanced_reports e custom_branding — sempre com a mensagem da
 * API. Planos gratuitos: a rotina de cobrança não mexe nessas assinaturas.
 */

const cleanup = new Cleanup();
let superadmin: Session;
let limited: Plan;
let full: Plan;
let customer: Member;

test.beforeAll(async () => {
  const api = await newApi();
  superadmin = await defaultSession(api, 'superadmin');
  limited = await createPlan(api, superadmin, cleanup, {
    name: 'Limitado E2E',
    max_products: 2,
    max_staff_users: 2,
    max_monthly_orders: 2,
    features: NO_FEATURES,
  });
  full = await createPlan(api, superadmin, cleanup, { name: 'Completo E2E', features: ALL_FEATURES });
  customer = await newCustomer(api);
  await api.dispose();
});

test.afterAll(async () => {
  await cleanup.run();
});

function limitedStore(request: Parameters<typeof createStore>[0], label: string): Promise<BillingStore> {
  return createStore(request, superadmin, cleanup, limited.id, label);
}

test('max_products: cadastro e restauração da lixeira respeitam o limite (indisponível também conta)', async ({ request }) => {
  const store = await limitedStore(request, 'Limite de produtos');
  const owner = bearer(store.owner.token);
  const message = MSG.limitReached(limited.name, 2, LIMIT_LABEL.products);

  const first = await addProduct(request, store.owner, { available: false });
  const second = await addProduct(request, store.owner);
  await expectError(await postProduct(request, store.owner), 403, message, '3º produto (o indisponível conta)');

  await expectStatus(await request.delete(`/products/${second.id}`, { headers: owner }), 200, 'lixeira');
  const third = await addProduct(request, store.owner);
  await expectError(
    await request.patch(`/products/${second.id}/restore`, { headers: owner }),
    403,
    message,
    'restaurar da lixeira acima do limite',
  );
  const trash = await expectStatus(await request.get('/products/trash', { headers: owner }), 200, 'lixeira');
  expect((trash as Array<{ id: number }>).map((item) => item.id), 'o produto continua na lixeira').toContain(second.id);

  await expectStatus(await request.delete(`/products/${third.id}`, { headers: owner }), 200, 'abrir vaga');
  await expectStatus(await request.patch(`/products/${second.id}/restore`, { headers: owner }), 200, 'restaurar com vaga');
  const overview = await storeOverview(request, store.owner);
  expect(overview.usage.products).toBe(2);
  expect(overview.limits).toEqual({ staff_users: 2, products: 2, monthly_orders: 2 });
  expect(first.available).toBe(false);
});

test('max_staff_users: cadastro direto, convite, aceite do convite e restauração da lixeira', async ({ request }) => {
  const store = await limitedStore(request, 'Limite de equipe');
  const owner = bearer(store.owner.token);
  const message = MSG.limitReached(limited.name, 2, LIMIT_LABEL.staff_users);
  const staffBody = (role: string) => ({
    name: `Equipe ${role} Cobrança`,
    email: uniqueEmail(`bl-${role.toLowerCase()}`),
    password: PASSWORD,
    role,
  });

  // O responsável já ocupa 1 das 2 vagas
  const employee = await expectStatus(
    await request.post('/users', { headers: owner, data: staffBody('EMPLOYEE') }),
    201,
    'cadastro direto (2ª vaga)',
  );
  await expectError(await request.post('/users', { headers: owner, data: staffBody('KITCHEN') }), 403, message, 'cadastro acima do limite');
  await expectError(
    await request.post('/store/invitations', { headers: owner, data: { email: uniqueEmail('bl-convite'), role: 'KITCHEN' } }),
    403,
    message,
    'convite sem vaga',
  );

  // Equipe na lixeira não conta: abre vaga para o convite
  await expectStatus(await request.delete(`/users/${employee.id}`, { headers: owner }), 200, 'equipe para a lixeira');
  const invite = await expectStatus(
    await request.post('/store/invitations', { headers: owner, data: { email: uniqueEmail('bl-convite'), role: 'COURIER' } }),
    201,
    'convite com vaga',
  );
  // A vaga é ocupada antes do aceite: o aceite confere o limite de novo
  const courier = await expectStatus(
    await request.post('/users', { headers: owner, data: staffBody('COURIER') }),
    201,
    'cadastro ocupa a vaga',
  );
  await expectError(await acceptInvitation(request, invite.url, 'Convidado Cobrança'), 403, message, 'aceite sem vaga');
  await expectError(
    await request.patch(`/users/${employee.id}/restore`, { headers: owner }),
    403,
    message,
    'restaurar equipe sem vaga',
  );
  expect((await storeOverview(request, store.owner)).usage.staff_users).toBe(2);

  // Com a vaga liberada, o mesmo convite (ainda pendente) pode ser aceito
  await expectStatus(await request.delete(`/users/${courier.id}`, { headers: owner }), 200, 'liberar vaga');
  const accepted = await expectStatus(
    await acceptInvitation(request, invite.url, 'Convidado Cobrança'),
    201,
    'aceite com vaga',
  );
  expect(accepted.user).toMatchObject({ role: 'COURIER', store_id: store.id });
  expect((await storeOverview(request, store.owner)).usage.staff_users).toBe(2);
});

test('max_monthly_orders: pedidos do mês acima do limite são recusados (cancelados não contam)', async ({ request }) => {
  const store = await limitedStore(request, 'Limite de pedidos');
  const product = await addProduct(request, store.owner);
  const first = await expectStatus(await postOrder(request, store.slug, customer, product.id), 201, '1º pedido');
  const second = await expectStatus(await postOrder(request, store.slug, customer, product.id), 201, '2º pedido');
  cancelOrderLater(cleanup, store.owner, second.id);
  await expectError(await postOrder(request, store.slug, customer, product.id), 403, MSG.monthlyOrdersLimit, '3º pedido do mês');

  await expectStatus(
    await request.patch(`/orders/${first.id}/cancel`, { headers: bearer(store.owner.token) }),
    200,
    'cancelar um pedido',
  );
  const third = await expectStatus(await postOrder(request, store.slug, customer, product.id), 201, 'pedido na vaga do cancelado');
  cancelOrderLater(cleanup, store.owner, third.id);
  await expectError(await postOrder(request, store.slug, customer, product.id), 403, MSG.monthlyOrdersLimit, 'limite de novo');
  expect((await storeOverview(request, store.owner)).usage.monthly_orders).toBe(2);
});

test('recursos do plano: pagamentos online, relatórios e identidade visual recusados (403); upgrade libera', async ({ request }) => {
  const store = await limitedStore(request, 'Recursos');
  const owner = bearer(store.owner.token);
  const product = await addProduct(request, store.owner);
  const today = new Date().toISOString().slice(0, 10);

  // online_payments
  await expectError(await postPix(request, store.slug, customer, product.id), 403, MSG.onlinePaymentNotInPlan, 'PIX');
  await expectError(await postCard(request, store.slug, customer, product.id), 403, MSG.onlinePaymentNotInPlan, 'cartão');
  const profile = await expectStatus(await request.get(storePath(store.slug, '')), 200, 'perfil público');
  expect(profile.payments.online_enabled, 'vitrine sem pagamento online').toBe(false);
  // Pagamento na retirada continua
  const order = await expectStatus(await postOrder(request, store.slug, customer, product.id), 201, 'pedido pago na retirada');
  cancelOrderLater(cleanup, store.owner, order.id);

  // advanced_reports
  const reports = MSG.featureMissing(limited.name, FEATURE_LABEL.advanced_reports);
  await expectError(await request.get(`/orders/reports?from=${today}&to=${today}`, { headers: owner }), 403, reports, 'relatórios');
  await expectError(await request.get('/orders/charts', { headers: owner }), 403, reports, 'gráficos');

  // custom_branding (voltar à cor padrão continua permitido)
  const branding = MSG.featureMissing(limited.name, FEATURE_LABEL.custom_branding);
  await expectError(
    await request.patch('/store/settings', { headers: owner, data: { primary_color: '#AA3300' } }),
    403,
    branding,
    'cor própria',
  );
  await expectError(
    await request.post('/store/logo', { headers: owner, multipart: { file: pngFile(makePng(16, 16)) } }),
    403,
    branding,
    'logo próprio',
  );
  await expectStatus(
    await request.patch('/store/settings', { headers: owner, data: { primary_color: null } }),
    200,
    'cor padrão permitida',
  );
  expect((await storeOverview(request, store.owner)).features).toEqual(NO_FEATURES);

  // Upgrade para o plano completo: os recursos valem na hora
  await platformAction(request, superadmin, `/platform/subscriptions/${store.subscriptionId}/change-plan`, { plan_id: full.id });
  expect((await storeOverview(request, store.owner)).features).toEqual(ALL_FEATURES);
  const pix = await expectStatus(await postPix(request, store.slug, customer, product.id), 201, 'PIX liberado (sandbox)');
  expect(pix.status).toBe('pending');
  await expectStatus(await request.get(`/orders/reports?from=${today}&to=${today}`, { headers: owner }), 200, 'relatórios liberados');
  await expectStatus(await request.get('/orders/charts', { headers: owner }), 200, 'gráficos liberados');
  const colored = await expectStatus(
    await request.patch('/store/settings', { headers: owner, data: { primary_color: '#AA3300' } }),
    200,
    'cor própria liberada',
  );
  expect(String(colored.primary_color).toLowerCase()).toBe('#aa3300');
  const afterUpgrade = await expectStatus(await request.get(storePath(store.slug, '')), 200);
  expect(afterUpgrade.payments.online_enabled, 'vitrine com pagamento online').toBe(true);
});
