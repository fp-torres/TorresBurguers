import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { loginAs } from '../../../support/api';
import {
  Cleanup,
  MISSING_ID,
  MSG,
  addAddress,
  addProduct,
  advance,
  bearer,
  buildTeam,
  cancelOrderLater,
  createStore,
  demoStore,
  demoTeam,
  expectAllFromStore,
  expectError,
  expectNoneOf,
  expectUniform404,
  getJson,
  ids,
  newApi,
  newCustomer,
  payCard,
  placeOrder,
  retireStore,
  storePath,
  trashProductLater,
  type Json,
  type Member,
  type PublicStore,
  type Session,
  type StaffRole,
  type Team,
  type TenantStore,
} from './helpers';

/**
 * Seção 16 do pedido — "A loja A não consegue acessar ou alterar pedidos da loja B" (e vice-versa):
 * detalhe, status, cancelamento, atribuição de entregador, "pedidos próximos", quadros da cozinha e do
 * entregador e as rotas por loja. Recurso de outra loja → 404 uniforme (igual a um id inexistente).
 */
test.describe('Isolamento entre lojas: pedidos', () => {
  const cleanup = new Cleanup();
  let api: APIRequestContext;
  let superadmin: Session;
  let demo: PublicStore;
  let teamA: Team;
  let storeB: TenantStore;
  let teamB: Team;
  let clientB: Member;
  let clientBoth: Member;

  let productA: Json;
  let productB: Json;
  let aPending: Json;
  let aDelivery: Json;
  let bPending: Json;
  let bDelivery: Json;
  let bDelivery2: Json;
  let bPaid: Json;

  const ordersB = () => [bPending, bDelivery, bDelivery2, bPaid];
  const ordersA = () => [aPending, aDelivery];
  /**
   * Pedidos de B que cada perfil de B enxerga (a cozinha, os que esperam preparo: bPending e o pago
   * bPaid; o entregador, as entregas prontas sem entregador: bDelivery e bDelivery2; a gestão, todos).
   */
  const visibleInB = (role: StaffRole) =>
    role === 'KITCHEN' ? [bPending, bPaid] : role === 'COURIER' ? [bDelivery, bDelivery2] : ordersB();

  test.beforeAll(async () => {
    api = await newApi();
    superadmin = await loginAs(api, 'superadmin');
    demo = await demoStore();
    teamA = await demoTeam(api);

    storeB = await createStore(api, superadmin, 'Pedidos');
    cleanup.add('desativar a loja B', () => retireStore(api, superadmin, storeB));
    teamB = await buildTeam(api, storeB);
    productB = await addProduct(api, storeB.owner, { name: 'Burger da Loja B', price: 22 });

    clientB = await newCustomer(api, 'Cliente so B');
    clientBoth = await newCustomer(api, 'Cliente A e B');
    const addressB = await addAddress(api, clientB, 'Centro');
    const addressBoth = await addAddress(api, clientBoth, 'Centro');

    // Loja B: pendente, duas entregas prontas no mesmo bairro e um pedido pago com cartão
    bPending = await placeOrder(api, storeB.slug, clientB, { items: [{ productId: productB.id, quantity: 1 }], type: 'TAKEOUT' });
    bDelivery = await placeOrder(api, storeB.slug, clientB, { items: [{ productId: productB.id, quantity: 2 }], type: 'DELIVERY', addressId: addressB.id });
    bDelivery2 = await placeOrder(api, storeB.slug, clientBoth, { items: [{ productId: productB.id, quantity: 1 }], type: 'DELIVERY', addressId: addressBoth.id });
    await advance(api, teamB.ADMIN, bDelivery.id, 'PREPARING', 'READY_FOR_PICKUP');
    await advance(api, teamB.ADMIN, bDelivery2.id, 'PREPARING', 'READY_FOR_PICKUP');
    const payment = await payCard(api, storeB.slug, clientBoth, { items: [{ productId: productB.id, quantity: 3 }], type: 'TAKEOUT' });
    bPaid = await getJson(api, `/orders/${payment.orderId}`, clientBoth.token, 'pedido pago em B');

    // Loja A (demo): produto e pedidos próprios do teste (cancelados no fim)
    productA = await addProduct(api, teamA.ADMIN, { name: 'Burger da Loja A (tenancy)', price: 18 });
    trashProductLater(cleanup, api, teamA.ADMIN, productA.id);
    aPending = await placeOrder(api, demo.slug, clientBoth, { items: [{ productId: productA.id, quantity: 1 }], type: 'TAKEOUT' });
    cancelOrderLater(cleanup, api, teamA.ADMIN, aPending.id);
    aDelivery = await placeOrder(api, demo.slug, clientBoth, { items: [{ productId: productA.id, quantity: 1 }], type: 'DELIVERY', addressId: addressBoth.id });
    cancelOrderLater(cleanup, api, teamA.ADMIN, aDelivery.id);
    await advance(api, teamA.ADMIN, aDelivery.id, 'PREPARING', 'READY_FOR_PICKUP');

    for (const order of ordersB()) expect(order.store_id, `pedido #${order.id} na loja B`).toBe(storeB.id);
    for (const order of ordersA()) expect(order.store_id, `pedido #${order.id} na loja A`).toBe(demo.id);
  });

  test.afterAll(async () => {
    await cleanup.run();
    await api.dispose();
  });

  const roles = (team: Team) => Object.entries(team) as Array<[StaffRole, Session]>;

  test('equipe de cada loja (todos os perfis) não abre pedido da outra: 404 uniforme', async () => {
    for (const [role, session] of roles(teamA)) {
      const headers = bearer(session.token);
      for (const order of ordersB()) {
        await expectUniform404(
          await api.get(`/orders/${order.id}`, { headers }),
          await api.get(`/orders/${MISSING_ID}`, { headers }),
          MSG.orderNotFound,
          `${role} de A: GET /orders/${order.id}`,
        );
        await expectUniform404(
          await api.get(storePath(demo.slug, `/orders/${order.id}`), { headers }),
          await api.get(storePath(demo.slug, `/orders/${MISSING_ID}`), { headers }),
          MSG.orderNotFound,
          `${role} de A: GET /stores/<A>/orders/${order.id}`,
        );
      }
    }
    for (const [role, session] of roles(teamB)) {
      const headers = bearer(session.token);
      for (const order of ordersA()) {
        await expectUniform404(
          await api.get(`/orders/${order.id}`, { headers }),
          await api.get(`/orders/${MISSING_ID}`, { headers }),
          MSG.orderNotFound,
          `${role} de B: GET /orders/${order.id}`,
        );
      }
      // Controle: a equipe de B abre os pedidos de B da própria etapa
      const [visible] = visibleInB(role);
      const own = await getJson(api, `/orders/${visible.id}`, session.token, `${role} de B: pedido de B`);
      expect(own).toMatchObject({ id: visible.id, store_id: storeB.id });
    }
  });

  test('listas e quadros da cozinha e do entregador trazem só os pedidos da própria loja', async () => {
    for (const [role, session] of roles(teamA)) {
      for (const path of ['/orders', '/orders?scope=active']) {
        const list: Json[] = await getJson(api, path, session.token, `${role} de A: ${path}`);
        expectAllFromStore(list, demo.id, `${role} de A: ${path}`);
        expectNoneOf(list, ids(ordersB()), `${role} de A: ${path}`);
      }
    }
    for (const [role, session] of roles(teamB)) {
      const expected = ids(visibleInB(role));
      const all: Json[] = await getJson(api, '/orders', session.token, `${role} de B: /orders`);
      expect(ids(all), `${role} de B: exatamente os pedidos de B da própria etapa`).toEqual(expected);
      const active: Json[] = await getJson(api, '/orders?scope=active', session.token, `${role} de B: quadro`);
      expectAllFromStore(active, storeB.id, `${role} de B: quadro`);
      expectNoneOf(active, ids(ordersA()), `${role} de B: quadro`);
      expect(ids(active), `${role} de B: quadro com os pedidos de B da própria etapa`).toEqual(expected);
    }
  });

  test('status, cancelamento, atribuição e "próximos" de pedido de outra loja → 404 uniforme e nada muda', async () => {
    type Attempt = [string, Session, (id: number) => Promise<APIResponse>, number];
    const patchStatus = (s: Session, status: string) => (id: number) =>
      api.patch(`/orders/${id}`, { headers: bearer(s.token), data: { status } });
    const cancel = (s: Session) => (id: number) => api.patch(`/orders/${id}/cancel`, { headers: bearer(s.token) });
    const assign = (s: Session, driverId: number) => (id: number) =>
      api.patch(`/orders/${id}/assign`, { headers: bearer(s.token), data: { driverId } });
    const nearby = (s: Session) => (id: number) => api.get(`/orders/${id}/nearby`, { headers: bearer(s.token) });

    const againstB: Attempt[] = [
      ['ADMIN de A: PATCH status', teamA.ADMIN, patchStatus(teamA.ADMIN, 'PREPARING'), bPending.id],
      ['ADMIN de A: cancelar', teamA.ADMIN, cancel(teamA.ADMIN), bPending.id],
      ['ADMIN de A: cancelar pedido pago (estorno)', teamA.ADMIN, cancel(teamA.ADMIN), bPaid.id],
      ['ADMIN de A: atribuir entregador de B', teamA.ADMIN, assign(teamA.ADMIN, teamB.COURIER.user.id), bDelivery.id],
      ['ADMIN de A: pedidos próximos', teamA.ADMIN, nearby(teamA.ADMIN), bDelivery.id],
      ['EMPLOYEE de A: cancelar pelo quadro', teamA.EMPLOYEE, patchStatus(teamA.EMPLOYEE, 'CANCELED'), bPaid.id],
      ['EMPLOYEE de A: cancelar', teamA.EMPLOYEE, cancel(teamA.EMPLOYEE), bPending.id],
      ['KITCHEN de A: iniciar preparo', teamA.KITCHEN, patchStatus(teamA.KITCHEN, 'PREPARING'), bPending.id],
      ['COURIER de A: retirar entrega', teamA.COURIER, patchStatus(teamA.COURIER, 'DELIVERING'), bDelivery.id],
    ];
    const againstA: Attempt[] = [
      ['ADMIN de B: PATCH status', teamB.ADMIN, patchStatus(teamB.ADMIN, 'PREPARING'), aPending.id],
      ['ADMIN de B: cancelar', teamB.ADMIN, cancel(teamB.ADMIN), aPending.id],
      ['ADMIN de B: atribuir entregador de B', teamB.ADMIN, assign(teamB.ADMIN, teamB.COURIER.user.id), aDelivery.id],
      ['ADMIN de B: pedidos próximos', teamB.ADMIN, nearby(teamB.ADMIN), aDelivery.id],
      ['EMPLOYEE de B: cancelar pelo quadro', teamB.EMPLOYEE, patchStatus(teamB.EMPLOYEE, 'CANCELED'), aPending.id],
      ['KITCHEN de B: iniciar preparo', teamB.KITCHEN, patchStatus(teamB.KITCHEN, 'PREPARING'), aPending.id],
      ['COURIER de B: retirar entrega', teamB.COURIER, patchStatus(teamB.COURIER, 'DELIVERING'), aDelivery.id],
    ];
    for (const [label, , call, id] of [...againstB, ...againstA]) {
      await expectUniform404(await call(id), await call(MISSING_ID), MSG.orderNotFound, label);
    }

    // Nada mudou nos pedidos das duas lojas
    const check = async (staff: Session, order: Json) => {
      const now = await getJson(api, `/orders/${order.id}`, staff.token);
      expect(now, `pedido #${order.id} intacto`).toMatchObject({
        status: order.id === bDelivery.id || order.id === bDelivery2.id || order.id === aDelivery.id ? 'READY_FOR_PICKUP' : order.status,
        payment_status: order.payment_status,
        driver: null,
        store_id: order.store_id,
      });
    };
    for (const order of ordersB()) await check(teamB.ADMIN, order);
    for (const order of ordersA()) await check(teamA.ADMIN, order);
    const paid = await getJson(api, `/orders/${bPaid.id}`, teamB.ADMIN.token);
    expect(paid.payment_status, 'pagamento de B não foi estornado pela loja A').toBe('PAID');
  });

  test('entregador de outra loja nunca é atribuído (404) e cada loja lista só os próprios entregadores', async () => {
    await expectUniform404(
      await api.patch(`/orders/${aDelivery.id}/assign`, { headers: bearer(teamA.ADMIN.token), data: { driverId: teamB.COURIER.user.id } }),
      await api.patch(`/orders/${aDelivery.id}/assign`, { headers: bearer(teamA.ADMIN.token), data: { driverId: MISSING_ID } }),
      MSG.driverNotFound,
      'ADMIN de A atribui o entregador de B ao pedido de A',
    );
    await expectUniform404(
      await api.patch(`/orders/${bDelivery.id}/assign`, { headers: bearer(teamB.EMPLOYEE.token), data: { driverId: teamA.COURIER.user.id } }),
      await api.patch(`/orders/${bDelivery.id}/assign`, { headers: bearer(teamB.EMPLOYEE.token), data: { driverId: MISSING_ID } }),
      MSG.driverNotFound,
      'atendente de B atribui o entregador de A ao pedido de B',
    );
    // Equipe que não é entregador (de outra loja) também não vira entregador
    await expectError(
      await api.patch(`/orders/${bDelivery.id}/assign`, { headers: bearer(teamB.ADMIN.token), data: { driverId: teamA.KITCHEN.user.id } }),
      404,
      MSG.driverNotFound,
    );

    const driversA: Json[] = await getJson(api, '/orders/drivers/list', teamA.ADMIN.token);
    expectNoneOf(driversA, [teamB.COURIER.user.id], 'entregadores de A');
    const driversB: Json[] = await getJson(api, '/orders/drivers/list', teamB.EMPLOYEE.token);
    expect(ids(driversB), 'entregadores de B: só o entregador de B').toEqual([teamB.COURIER.user.id]);

    for (const [staff, order] of [[teamA.ADMIN, aDelivery], [teamB.ADMIN, bDelivery]] as Array<[Session, Json]>) {
      const now = await getJson(api, `/orders/${order.id}`, staff.token);
      expect(now, `pedido #${order.id} continua sem entregador`).toMatchObject({ status: 'READY_FOR_PICKUP', driver: null });
    }
  });

  test('"pedidos próximos" agrupa só pedidos da mesma loja, mesmo no mesmo bairro', async () => {
    const nearB: Json[] = await getJson(api, `/orders/${bDelivery.id}/nearby`, teamB.ADMIN.token);
    expect(ids(nearB), 'próximos de B: a outra entrega pronta de B no Centro').toEqual([bDelivery2.id]);
    const nearA: Json[] = await getJson(api, `/orders/${aDelivery.id}/nearby`, teamA.ADMIN.token);
    expectAllFromStore(nearA, demo.id, 'próximos de A');
    expectNoneOf(nearA, ids(ordersB()), 'próximos de A (entregas de B no mesmo bairro)');
  });

  test('rotas de pedidos com o slug da loja B e token da equipe de A → 403 (o slug nunca troca a loja)', async () => {
    const headers = bearer(teamA.ADMIN.token);
    const B = (path: string) => storePath(storeB.slug, path);
    const attempts: Array<[string, () => Promise<APIResponse>]> = [
      ['GET /stores/<B>/orders', () => api.get(B('/orders'), { headers })],
      ['GET /stores/<B>/orders?scope=active', () => api.get(B('/orders?scope=active'), { headers })],
      ['GET /stores/<B>/orders/:id', () => api.get(B(`/orders/${bPending.id}`), { headers })],
      ['PATCH /stores/<B>/orders/:id', () => api.patch(B(`/orders/${bPending.id}`), { headers, data: { status: 'PREPARING' } })],
      ['PATCH /stores/<B>/orders/:id/cancel', () => api.patch(B(`/orders/${bPending.id}/cancel`), { headers })],
      ['PATCH /stores/<B>/orders/:id/assign', () => api.patch(B(`/orders/${bDelivery.id}/assign`), { headers, data: { driverId: teamB.COURIER.user.id } })],
      ['GET /stores/<B>/orders/:id/nearby', () => api.get(B(`/orders/${bDelivery.id}/nearby`), { headers })],
      ['GET /stores/<B>/orders/drivers/list', () => api.get(B('/orders/drivers/list'), { headers })],
      ['GET /stores/<B>/orders/summary', () => api.get(B('/orders/summary'), { headers })],
      ['GET /stores/<B>/orders/reports', () => api.get(B('/orders/reports'), { headers })],
    ];
    for (const [label, call] of attempts) await expectError(await call(), 403, MSG.otherStore, label);
    for (const [role, session] of roles(teamA).filter(([role]) => role !== 'ADMIN')) {
      await expectError(
        await api.get(B(`/orders/${bPending.id}`), { headers: bearer(session.token) }),
        403,
        MSG.otherStore,
        `${role} de A: GET /stores/<B>/orders/:id`,
      );
    }
    const still = await getJson(api, `/orders/${bPending.id}`, teamB.ADMIN.token);
    expect(still.status).toBe('PENDING');
  });

  test('cliente: o pedido fica na loja em que foi feito; my-orders por loja filtra e a rota de outra loja → 404', async () => {
    const mine: Json[] = await getJson(api, '/orders/my-orders', clientBoth.token);
    const byId = new Map(mine.map((order) => [order.id, order]));
    expect(byId.get(bPaid.id)?.store).toEqual({ id: storeB.id, slug: storeB.slug, name: storeB.name, logo: null });
    expect(byId.get(aPending.id)?.store).toMatchObject({ id: demo.id, slug: demo.slug });

    const onlyB: Json[] = await getJson(api, storePath(storeB.slug, '/orders/my-orders'), clientBoth.token);
    expect(ids(onlyB)).toEqual(ids([bDelivery2, bPaid]));
    const onlyA: Json[] = await getJson(api, storePath(demo.slug, '/orders/my-orders'), clientBoth.token);
    expectAllFromStore(onlyA, demo.id, 'my-orders na loja A');
    expectNoneOf(onlyA, ids(ordersB()), 'my-orders na loja A');

    // Pedido de B pela rota da loja A → 404 (consulta e cancelamento); pela rota de B → 200
    await expectUniform404(
      await api.get(storePath(demo.slug, `/orders/${bDelivery2.id}`), { headers: bearer(clientBoth.token) }),
      await api.get(storePath(demo.slug, `/orders/${MISSING_ID}`), { headers: bearer(clientBoth.token) }),
      MSG.orderNotFound,
      'cliente: pedido de B pela rota da loja A',
    );
    await expectError(
      await api.patch(storePath(demo.slug, `/orders/${bDelivery2.id}/cancel`), { headers: bearer(clientBoth.token) }),
      404,
      MSG.orderNotFound,
      'cliente cancela pedido de B pela rota da loja A',
    );
    expect(await getJson(api, storePath(storeB.slug, `/orders/${bPaid.id}`), clientBoth.token)).toMatchObject({ id: bPaid.id, store_id: storeB.id });
    expect(await getJson(api, `/orders/${bPaid.id}`, clientBoth.token)).toMatchObject({ id: bPaid.id, store_id: storeB.id });

    // Outro cliente não vê o pedido (de nenhuma loja)
    await expectUniform404(
      await api.get(`/orders/${bPaid.id}`, { headers: bearer(clientB.token) }),
      await api.get(`/orders/${MISSING_ID}`, { headers: bearer(clientB.token) }),
      MSG.orderNotFound,
      'outro cliente: pedido pago de B',
    );
    expect((await getJson(api, `/orders/${bDelivery2.id}`, teamB.ADMIN.token)).status).toBe('READY_FOR_PICKUP');
  });

  test('controle: a equipe de B (cozinha e entregador) opera os pedidos de B normalmente', async () => {
    const preparing = await advance(api, teamB.KITCHEN, bPending.id, 'PREPARING');
    expect(preparing).toMatchObject({ id: bPending.id, status: 'PREPARING', store_id: storeB.id });
    const delivering = await advance(api, teamB.COURIER, bDelivery.id, 'DELIVERING');
    expect(delivering.driver?.id, 'o entregador de B assume a entrega de B').toBe(teamB.COURIER.user.id);
    const done = await advance(api, teamB.COURIER, bDelivery.id, 'DONE');
    expect(done).toMatchObject({ status: 'DONE', payment_status: 'PAID' });
    // A entrega concluída continua com o entregador que a fez (recente) e saiu da etapa da cozinha
    expect(await getJson(api, `/orders/${bDelivery.id}`, teamB.COURIER.token)).toMatchObject({ id: bDelivery.id, status: 'DONE' });
    await expectError(
      await api.get(`/orders/${bDelivery.id}`, { headers: bearer(teamB.KITCHEN.token) }),
      404,
      MSG.orderNotFound,
    );
    // O entregador de A continua sem enxergar a entrega concluída de B
    await expectError(
      await api.get(`/orders/${bDelivery.id}`, { headers: bearer(teamA.COURIER.token) }),
      404,
      MSG.orderNotFound,
    );
  });
});
