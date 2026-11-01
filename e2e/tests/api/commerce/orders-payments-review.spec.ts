import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  ALL_FEATURES,
  bearer,
  cancelOrderLater,
  Cleanup,
  createPlan,
  createStore,
  defaultSession,
  expectError,
  expectStatus,
  addProduct,
  MSG,
  newApi,
  newCustomer,
  postOrder,
  postPix,
  storePath,
  type BillingStore,
  type Member,
  type Plan,
  type Session,
} from '../billing/helpers';

/**
 * Revisão de segurança, rodada 2 (pedidos e pagamentos):
 * - PIX pendentes de OUTROS clientes não reservam vagas do limite mensal do plano (contas descartáveis
 *   não bloqueiam as vendas da loja); os do próprio cliente continuam reservando;
 * - GET /stores/:slug/orders/my-orders responde igual para loja desativada e inexistente (404).
 * (Cozinha/entregador fora da etapa nas escritas: orders-workflow.spec.ts.)
 */

const cleanup = new Cleanup();
let api: APIRequestContext;
let superadmin: Session;
let plan: Plan;

test.beforeAll(async () => {
  api = await newApi();
  superadmin = await defaultSession(api, 'superadmin');
  plan = await createPlan(api, superadmin, cleanup, {
    name: 'Revisão pedidos E2E',
    max_monthly_orders: 3,
    features: ALL_FEATURES,
  });
});

test.afterAll(async () => {
  await cleanup.run();
  await api.dispose();
});

/** PIX criado no sandbox (pendente): cancelado pelo próprio cliente no fim do arquivo (nunca vira pedido). */
async function pendingPix(store: BillingStore, customer: Member, productId: number): Promise<number> {
  const pix = await expectStatus(await postPix(api, store.slug, customer, productId), 201, 'PIX pendente');
  expect(pix.status, 'PIX recém-criado').toBe('pending');
  cleanup.add(`cancelar PIX ${pix.id}`, (ctx) =>
    ctx.post(storePath(store.slug, `/payment/${pix.id}/cancel`), { headers: bearer(customer.token) }),
  );
  return pix.id as number;
}

test('limite mensal: PIX pendentes de outros clientes não ocupam vaga; os do próprio cliente continuam ocupando', async () => {
  const store = await createStore(api, superadmin, cleanup, plan.id, 'Reservas PIX');
  const product = await addProduct(api, store.owner);
  const [first, attackerA, attackerB, payer, legit, last] = await Promise.all(
    Array.from({ length: 6 }, () => newCustomer(api)),
  );

  const order1 = await expectStatus(await postOrder(api, store.slug, first, product.id), 201, '1º pedido do mês');
  cancelOrderLater(cleanup, store.owner, order1.id);

  // Contas descartáveis geram PIX que nunca serão pagos (antes: cada um reservava uma vaga do mês)
  await pendingPix(store, attackerA, product.id);
  await pendingPix(store, attackerB, product.id);
  // Um cliente com PIX pendente na loja
  await pendingPix(store, payer, product.id);

  // Cliente legítimo: 1 usado + 1 novo = 2 de 3 (as cobranças dos outros não contam)
  const order2 = await expectStatus(await postOrder(api, store.slug, legit, product.id), 201, 'pedido com PIX pendentes de outros');
  cancelOrderLater(cleanup, store.owner, order2.id);

  // O PIX pendente do próprio cliente reserva a vaga dele: 2 usados + 1 reserva + 1 novo > 3
  await expectError(
    await postOrder(api, store.slug, payer, product.id),
    403,
    MSG.monthlyOrdersLimit,
    'pedido de quem já tem um PIX pendente na última vaga',
  );

  // A última vaga continua livre para os demais
  const order3 = await expectStatus(await postOrder(api, store.slug, last, product.id), 201, 'última vaga do mês');
  cancelOrderLater(cleanup, store.owner, order3.id);
  await expectError(await postOrder(api, store.slug, legit, product.id), 403, MSG.monthlyOrdersLimit, 'limite atingido');
});

test('GET /stores/:slug/orders/my-orders: loja desativada responde o mesmo 404 da inexistente', async () => {
  const store = await createStore(api, superadmin, cleanup, plan.id, 'Minhas compras');
  const customer = await newCustomer(api);
  const unknown = await api.get(storePath('loja-que-nunca-existiu-e2e', '/orders/my-orders'), {
    headers: bearer(customer.token),
  });
  const unknownBody = await expectError(unknown, 404, MSG.storeNotFound, 'loja inexistente');

  await expectStatus(
    await api.get(storePath(store.slug, '/orders/my-orders'), { headers: bearer(customer.token) }),
    200,
    'loja ativa',
  );
  await expectStatus(
    await api.post(`/platform/stores/${store.id}/deactivate`, {
      headers: bearer(superadmin.token),
      data: { reason: 'Revisão de segurança (E2E): loja desativada' },
    }),
    200,
    'desativar a loja',
  );
  try {
    const inactive = await api.get(storePath(store.slug, '/orders/my-orders'), { headers: bearer(customer.token) });
    const inactiveBody = await expectError(inactive, 404, MSG.storeNotFound, 'loja desativada');
    expect(inactiveBody, 'mesma resposta da loja inexistente').toEqual(unknownBody);
    // A vitrine da loja desativada também é 404 (mesma regra)
    await expectError(await api.get(storePath(store.slug, '')), 404, MSG.storeNotFound, 'vitrine da loja desativada');
  } finally {
    await expectStatus(
      await api.post(`/platform/stores/${store.id}/restore`, {
        headers: bearer(superadmin.token),
        data: { reason: 'Fim do teste de revisão (E2E)' },
      }),
      200,
      'restaurar a loja',
    );
  }
});
