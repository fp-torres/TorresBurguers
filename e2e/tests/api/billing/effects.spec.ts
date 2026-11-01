import { expect, test } from '@playwright/test';
import {
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
  MSG,
  newApi,
  newCustomer,
  NO_FEATURES,
  platformAction,
  postCard,
  postOrder,
  postPix,
  postProduct,
  storeOverview,
  storePath,
  uniqueEmail,
  PASSWORD,
  type BillingStore,
  type Json,
  type Member,
  type Plan,
  type Session,
} from './helpers';

/**
 * Situação da assinatura × vitrine e painel (docs/saas/arquitetura.md §4.2): assinatura suspensa ou
 * cancelada → a vitrine continua visível, mas não vende (pedido e pagamento online recusados); o painel
 * lê, opera os pedidos e regulariza a cobrança, mas não altera cardápio, equipe nem configurações.
 * Reativada (ou recontratada) → volta a vender. Plano gratuito com todos os recursos: a rotina de
 * cobrança nunca mexe nessas assinaturas (sem período nem faturas).
 */

const cleanup = new Cleanup();
let superadmin: Session;
let plan: Plan;
let customer: Member;

test.beforeAll(async () => {
  const api = await newApi();
  superadmin = await defaultSession(api, 'superadmin');
  plan = await createPlan(api, superadmin, cleanup, { name: 'Efeitos E2E', features: ALL_FEATURES });
  customer = await newCustomer(api);
  await api.dispose();
});

test.afterAll(async () => {
  await cleanup.run();
});

async function sellingStore(request: Parameters<typeof createStore>[0], label: string): Promise<{ store: BillingStore; productId: number }> {
  const store = await createStore(request, superadmin, cleanup, plan.id, label);
  const product = await addProduct(request, store.owner);
  return { store, productId: product.id };
}

async function expectSells(request: Parameters<typeof createStore>[0], store: BillingStore, productId: number, label: string): Promise<Json> {
  const order = await expectStatus(await postOrder(request, store.slug, customer, productId), 201, `${label}: pedido`);
  cancelOrderLater(cleanup, store.owner, order.id);
  const profile = await expectStatus(await request.get(storePath(store.slug, '')), 200, `${label}: perfil público`);
  expect(profile, `${label}: vitrine vendendo`).toMatchObject({ ordering_available: true, unavailable_message: null });
  return order;
}

test('assinatura suspensa: vitrine não vende; painel lê, opera pedidos e regulariza; reativada volta a vender', async ({ request }) => {
  const { store, productId } = await sellingStore(request, 'Suspensa');
  const owner = bearer(store.owner.token);
  const order = await expectSells(request, store, productId, 'antes da suspensão');
  const pix = await expectStatus(await postPix(request, store.slug, customer, productId), 201, 'PIX antes da suspensão (sandbox)');
  expect(pix.status).toBe('pending');

  await platformAction(request, superadmin, `/platform/subscriptions/${store.subscriptionId}/suspend`, {
    reason: 'Suspensão de teste dos efeitos (E2E)',
  });

  // Vitrine: visível, sem vender; o cliente recebe a mensagem genérica (o motivo é assunto da loja)
  for (const [label, call] of [
    ['pedido', () => postOrder(request, store.slug, customer, productId)],
    ['PIX', () => postPix(request, store.slug, customer, productId)],
    ['cartão', () => postCard(request, store.slug, customer, productId)],
  ] as const) {
    await expectError(await call(), 403, MSG.storeUnavailable, `vitrine suspensa: ${label}`);
  }
  const profile = await expectStatus(await request.get(storePath(store.slug, '')), 200, 'perfil público');
  expect(profile).toMatchObject({ ordering_available: false, unavailable_message: MSG.storeUnavailable });
  const menu = (await expectStatus(await request.get(storePath(store.slug, '/products')), 200, 'cardápio público')) as Json[];
  expect(menu.map((item) => item.id), 'o cardápio continua visível').toContain(productId);

  // Painel: leitura, pedidos e cobrança liberados; alterações bloqueadas
  const orders = (await expectStatus(await request.get('/orders', { headers: owner }), 200, 'GET /orders')) as Json[];
  expect(orders.map((item) => item.id)).toContain(order.id);
  const preparing = await expectStatus(
    await request.patch(`/orders/${order.id}`, { headers: owner, data: { status: 'PREPARING' } }),
    200,
    'operar pedido existente',
  );
  expect(preparing.status).toBe('PREPARING');
  // Suspensão pelo superadmin (sem inadimplência): o painel não afirma falta de pagamento
  const blocked = `${MSG.subscriptionSuspendedNeutral} ${MSG.manageBlockedSuffix}`;
  await expectError(await postProduct(request, store.owner), 403, blocked, 'criar produto');
  await expectError(
    await request.patch('/store/settings', { headers: owner, data: { description: 'Alteração bloqueada' } }),
    403,
    blocked,
    'alterar configurações',
  );
  await expectError(
    await request.post('/users', {
      headers: owner,
      data: { name: 'Equipe Bloqueada', email: uniqueEmail('bl-equipe'), password: PASSWORD, role: 'EMPLOYEE' },
    }),
    403,
    blocked,
    'cadastrar equipe',
  );
  const settings = await expectStatus(await request.get('/store/settings', { headers: owner }), 200, 'GET /store/settings');
  expect(settings.access).toMatchObject({ availability: 'SUBSCRIPTION_SUSPENDED', canSell: false, canManage: false });
  const overview = await storeOverview(request, store.owner);
  expect(overview.subscription.status).toBe('SUSPENDED');
  expect(overview.access).toMatchObject({
    availability: 'SUBSCRIPTION_SUSPENDED',
    canRead: true,
    canOperate: true,
    canManageBilling: true,
    message: MSG.subscriptionSuspendedNeutral,
  });

  await platformAction(request, superadmin, `/platform/subscriptions/${store.subscriptionId}/reactivate`, {});
  await expectSells(request, store, productId, 'depois da reativação');
  await addProduct(request, store.owner);
  await expectStatus(
    await request.patch('/store/settings', { headers: owner, data: { description: 'Loja reativada' } }),
    200,
    'configurações liberadas',
  );
});

test('assinatura cancelada: não vende nem altera; nova contratação volta a vender', async ({ request }) => {
  const { store, productId } = await sellingStore(request, 'Cancelada');
  const owner = bearer(store.owner.token);
  await expectSells(request, store, productId, 'antes do cancelamento');

  await platformAction(request, superadmin, `/platform/subscriptions/${store.subscriptionId}/cancel`, {
    at_period_end: false,
    reason: 'Cancelamento de teste dos efeitos (E2E)',
  });
  await expectError(await postOrder(request, store.slug, customer, productId), 403, MSG.storeUnavailable, 'pedido');
  await expectError(await postPix(request, store.slug, customer, productId), 403, MSG.storeUnavailable, 'PIX');
  await expectError(
    await postProduct(request, store.owner),
    403,
    `${MSG.subscriptionCanceledStore} ${MSG.manageBlockedSuffix}`,
    'criar produto',
  );
  await expectStatus(await request.get('/orders', { headers: owner }), 200, 'pedidos continuam legíveis');
  const overview = await storeOverview(request, store.owner);
  expect(overview).toMatchObject({
    subscription: { id: store.subscriptionId, status: 'CANCELED' },
    features: NO_FEATURES,
    limits: null,
    access: { availability: 'SUBSCRIPTION_CANCELED', canSell: false, canManageBilling: true },
  });

  const renewed = await platformAction(
    request,
    superadmin,
    `/platform/stores/${store.id}/subscription`,
    { plan_id: plan.id, reason: 'Recontratação (E2E)' },
    201,
  );
  expect(renewed).toMatchObject({ status: 'ACTIVE', access: { availability: 'OPERATIONAL', canSell: true } });
  await expectSells(request, store, productId, 'depois da nova contratação');
  await addProduct(request, store.owner);
});
