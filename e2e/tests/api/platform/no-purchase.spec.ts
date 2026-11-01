/**
 * O superadministrador não compra (pedido §6 e §11; arquitetura §4.3: o papel global é administrativo e
 * separado da operação das lojas — orders/client-only.guard.ts): orçamento, pedido e pagamentos (PIX e
 * cartão), nas rotas da loja e nas antigas, respondem 403 com a mensagem do contrato ANTES da validação
 * do corpo, e nada é criado. O token de uma sessão de suporte também não compra.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  MSG,
  bearer,
  cleanupPlatformData,
  createPlan,
  createProductAs,
  endSupportSession,
  expectApiError,
  expectOk,
  freshSession,
  newApi,
  newClientAccount,
  openStore,
  startSupportSession,
  storeDetail,
  storeWithOwner,
  type Json,
  type Session,
  type StoreWithOwner,
  type SupportSession,
} from './helpers';

let api: APIRequestContext;
let sa: Session;
let store: StoreWithOwner;
let product: Json;
let support: SupportSession;

const order = () => ({ items: [{ productId: product.id, quantity: 1 }], type: 'TAKEOUT' });
const card = () => ({ order: order(), token: 'tok-cartao-e2e', installments: 1, payment_method_id: 'visa', payer: { email: 'pagador@e2e.test' } });

/** Rotas de compra: por loja e as antigas (loja padrão), com um corpo válido e outro vazio. */
function purchaseRoutes(): Array<{ path: string; data: Json }> {
  const routes: Array<{ path: string; data: Json }> = [];
  for (const prefix of [`/stores/${store.slug}`, '']) {
    routes.push(
      { path: `${prefix}/orders/quote`, data: order() },
      { path: `${prefix}/orders`, data: { ...order(), paymentMethod: 'MONEY' } },
      { path: `${prefix}/payment/pix`, data: { order: order() } },
      { path: `${prefix}/payment/card`, data: card() },
    );
  }
  return routes;
}

test.beforeAll(async () => {
  api = await newApi();
  sa = await freshSession(api, 'superadmin');
  const plan = await createPlan(api, sa.token, { price: 0 });
  store = await storeWithOwner(api, sa.token, { planId: plan.id });
  await openStore(api, store.owner.token);
  product = await createProductAs(api, store.owner.token, { name: 'Lanche que o superadmin não compra', price: 30 });
  support = await startSupportSession(api, sa.token, store.id, 'Conferir que a sessão de suporte não faz pedidos na loja.');
});

test.afterAll(async () => {
  if (!api) return;
  try {
    if (support) await endSupportSession(api, sa.token, support.id);
    await cleanupPlatformData(api, sa.token);
  } finally {
    await api.dispose();
  }
});

test('superadmin: orçamento, pedido, PIX e cartão → 403 "Contas da administração da plataforma não fazem pedidos" e nada é criado', async () => {
  const ownOrdersBefore = await expectOk(await api.get('/orders/my-orders', { headers: bearer(sa.token) }), 200);

  for (const route of purchaseRoutes()) {
    for (const data of [route.data, {}]) {
      await expectApiError(
        await api.post(route.path, { headers: bearer(sa.token), data }),
        403,
        MSG.platformNoPurchase,
        `POST ${route.path} como superadmin (${Object.keys(data).length ? 'corpo válido' : 'corpo vazio'})`,
      );
    }
  }

  // Nenhum pedido na loja nem na conta do superadmin
  const detail = await storeDetail(api, sa.token, store.id);
  expect(detail.metrics).toMatchObject({ orders_total: 0, canceled_orders_total: 0, gmv_total: 0, customers: 0 });
  expect(await expectOk(await api.get('/orders/my-orders', { headers: bearer(sa.token) }), 200)).toEqual(ownOrdersBefore);

  // A mesma compra feita por um cliente funciona (a recusa é do papel, não da loja ou do corpo)
  const client = await newClientAccount(api, 'Cliente que compra E2E');
  const created = await expectOk(
    await api.post(`/stores/${store.slug}/orders`, { headers: bearer(client.token), data: { ...order(), paymentMethod: 'MONEY' } }),
    201,
  );
  expect(created).toMatchObject({ store_id: store.id });
  expect((await storeDetail(api, sa.token, store.id)).metrics.orders_total).toBe(1);
});

test('token de sessão de suporte (ADMIN somente leitura da loja) também não faz pedidos nem pagamentos', async () => {
  const before = (await storeDetail(api, sa.token, store.id)).metrics.orders_total;
  for (const route of purchaseRoutes().filter((item) => item.path.startsWith('/stores/'))) {
    await expectApiError(
      await api.post(route.path, { headers: bearer(support.token), data: route.data }),
      403,
      /Somente clientes fazem pedidos e pagamentos|Contas da administração da plataforma não fazem pedidos|Sessão de suporte é somente leitura/,
      `POST ${route.path} com o token de suporte`,
    );
  }
  expect((await storeDetail(api, sa.token, store.id)).metrics.orders_total).toBe(before);
});
