import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { loginAs } from '../../../support/api';
import {
  Cleanup,
  MISSING_ID,
  MSG,
  addAddon,
  addProduct,
  bearer,
  buildTeam,
  cancelOrderLater,
  cardBody,
  createStore,
  demoStore,
  expectAllFromStore,
  expectError,
  expectNoneOf,
  expectStatus,
  expectUniform404,
  getJson,
  ids,
  newApi,
  newCustomer,
  placeOrder,
  retireStore,
  storePath,
  trashProductLater,
  uid,
  type Json,
  type Member,
  type OrderInput,
  type PublicStore,
  type Session,
  type StaffRole,
  type Team,
  type TenantStore,
} from './helpers';

/**
 * Rotas antigas (sem slug: /products, /addons, /store/status, /orders, /orders/quote, /payment/*),
 * usadas pelo app mobile e por versões antigas do site (docs/saas/arquitetura.md §5.4 e §10):
 * - a equipe autenticada lê e opera SEMPRE a própria loja (a equipe de B nunca cai na loja padrão);
 * - visitante e cliente ficam na loja padrão (a loja demo, A): produto/adicional de B → "não encontrado".
 */
test.describe('Isolamento entre lojas: rotas antigas (sem slug)', () => {
  const cleanup = new Cleanup();
  let api: APIRequestContext;
  let superadmin: Session;
  let demo: PublicStore;
  let adminA: Session;
  let storeB: TenantStore;
  let teamB: Team;
  let client: Member;

  let productA: Json;
  let addonA: Json;
  let productB: Json;
  let addonB: Json;
  let orderB: Json;

  const roles = (team: Team) => Object.entries(team) as Array<[StaffRole, Session]>;
  const takeout = (productId: number, addonIds?: number[]): OrderInput => ({
    items: [{ productId, quantity: 1, ...(addonIds ? { addonIds } : {}) }],
    type: 'TAKEOUT',
  });

  test.beforeAll(async () => {
    api = await newApi();
    superadmin = await loginAs(api, 'superadmin');
    demo = await demoStore();
    adminA = await loginAs(api, 'admin');

    storeB = await createStore(api, superadmin, 'Rotas antigas');
    cleanup.add('desativar a loja B', () => retireStore(api, superadmin, storeB));
    teamB = await buildTeam(api, storeB);
    addonB = await addAddon(api, teamB.ADMIN, { price: 2 });
    productB = await addProduct(api, teamB.ADMIN, { name: `Burger Antigo B ${uid('lb')}`, price: 19, allowed_addons_ids: [addonB.id] });

    addonA = await addAddon(api, adminA, { price: 2 });
    cleanup.add('lixeira do adicional da loja A', () => api.delete(`/addons/${addonA.id}`, { headers: bearer(adminA.token) }));
    productA = await addProduct(api, adminA, { name: `Burger Antigo A ${uid('la')}`, price: 16, allowed_addons_ids: [addonA.id] });
    trashProductLater(cleanup, api, adminA, productA.id);

    client = await newCustomer(api, 'Cliente Rotas Antigas');
    orderB = await placeOrder(api, storeB.slug, client, takeout(productB.id));
  });

  test.afterAll(async () => {
    await cleanup.run();
    await api.dispose();
  });

  test('equipe de B (cada perfil) lê pelas rotas antigas o cardápio e o status da PRÓPRIA loja B', async () => {
    for (const [role, session] of roles(teamB)) {
      const headers = bearer(session.token);
      const status = await getJson(api, '/store/status', session.token, `${role} de B: GET /store/status`);
      expect(status.id, `${role} de B: status da loja B`).toBe(storeB.id);

      const products: Json[] = await getJson(api, '/products', session.token, `${role} de B: GET /products`);
      expectAllFromStore(products, storeB.id, `${role} de B: GET /products`);
      expect(ids(products), `${role} de B: cardápio de B`).toContain(productB.id);
      expectNoneOf(products, [productA.id], `${role} de B: GET /products`);

      const addons: Json[] = await getJson(api, '/addons', session.token, `${role} de B: GET /addons`);
      expectAllFromStore(addons, storeB.id, `${role} de B: GET /addons`);
      expect(ids(addons)).toContain(addonB.id);
      expectNoneOf(addons, [addonA.id], `${role} de B: GET /addons`);

      expect(await getJson(api, `/products/${productB.id}`, session.token)).toMatchObject({ id: productB.id, store_id: storeB.id });
      await expectUniform404(
        await api.get(`/products/${productA.id}`, { headers }),
        await api.get(`/products/${MISSING_ID}`, { headers }),
        MSG.productNotFound,
        `${role} de B: GET /products/<produto de A>`,
      );
    }
  });

  test('equipe de B opera a PRÓPRIA loja pelas rotas antigas: status, cardápio, pedidos e equipe — a loja A não muda', async () => {
    const statusA = await getJson(api, storePath(demo.slug, '/status'));
    const message = `Fechada pela rota antiga ${uid('msg')}`;

    // Atendente de B fecha e reabre a loja B (PATCH /store/status sem slug)
    const closed = await expectStatus(
      await api.patch('/store/status', { headers: bearer(teamB.EMPLOYEE.token), data: { is_open: false, closing_message: message } }),
      200,
      'atendente de B fecha a loja pela rota antiga',
    );
    try {
      expect(closed).toMatchObject({ id: storeB.id, is_open: false, closing_message: message });
      expect(await getJson(api, storePath(storeB.slug, '/status'))).toMatchObject({ id: storeB.id, is_open: false, closing_message: message });
      expect(await getJson(api, storePath(demo.slug, '/status')), 'a loja A não foi fechada').toEqual(statusA);
      expect(await getJson(api, '/store/status'), 'visitante: status da loja padrão (A), intacto').toEqual(statusA);
    } finally {
      await expectStatus(
        await api.patch('/store/status', { headers: bearer(teamB.EMPLOYEE.token), data: { is_open: true } }),
        200,
        'reabrir a loja B',
      );
    }

    // ADMIN de B cria produto e adicional pelas rotas antigas: nascem em B, nunca na loja padrão
    const product = await expectStatus(
      await api.post('/products', { headers: bearer(teamB.ADMIN.token), data: { name: `Novo B ${uid('nb')}`, price: 9, category: 'bebidas' } }),
      201,
    );
    const addon = await expectStatus(
      await api.post('/addons', { headers: bearer(teamB.ADMIN.token), data: { name: `Molho B ${uid('mb')}`.slice(0, 60), price: 1 } }),
      201,
    );
    expect(product.store_id).toBe(storeB.id);
    expect(addon.store_id).toBe(storeB.id);
    expect(ids(await getJson(api, storePath(storeB.slug, '/products')))).toContain(product.id);
    expectNoneOf(await getJson(api, '/products'), [product.id], 'cardápio da loja padrão (visitante)');
    expectNoneOf(await getJson(api, storePath(demo.slug, '/products')), [product.id], 'vitrine de A');
    expectNoneOf(await getJson(api, '/products', adminA.token), [product.id], 'cardápio de A (ADMIN de A)');

    // Pedidos e equipe pelas rotas antigas: os de B
    const orders: Json[] = await getJson(api, '/orders', teamB.ADMIN.token);
    expect(ids(orders)).toEqual([orderB.id]);
    const preparing = await expectStatus(
      await api.patch(`/orders/${orderB.id}`, { headers: bearer(teamB.KITCHEN.token), data: { status: 'PREPARING' } }),
      200,
      'cozinha de B pela rota antiga',
    );
    expect(preparing).toMatchObject({ id: orderB.id, status: 'PREPARING', store_id: storeB.id });
    const team: Json[] = await getJson(api, '/users', teamB.ADMIN.token);
    expectAllFromStore(team, storeB.id, 'GET /users (ADMIN de B)');
    expect(ids(team)).toEqual(ids(Object.values(teamB).map((member) => member.user)));
  });

  test('visitante nas rotas antigas: loja padrão (A) — o cardápio e o status de B não aparecem', async () => {
    expect((await getJson(api, '/stores/default')).id, 'loja padrão = loja demo').toBe(demo.id);
    expect((await getJson(api, '/store/status')).id).toBe(demo.id);

    const products: Json[] = await getJson(api, '/products');
    expectAllFromStore(products, demo.id, 'visitante: GET /products');
    expect(ids(products)).toContain(productA.id);
    expectNoneOf(products, [productB.id], 'visitante: GET /products');
    const addons: Json[] = await getJson(api, '/addons');
    expectAllFromStore(addons, demo.id, 'visitante: GET /addons');
    expectNoneOf(addons, [addonB.id], 'visitante: GET /addons');
    await expectUniform404(
      await api.get(`/products/${productB.id}`),
      await api.get(`/products/${MISSING_ID}`),
      MSG.productNotFound,
      'visitante: GET /products/<produto de B>',
    );
    await expectStatus(await api.get('/promotions/banner'), 200, 'banner global (loja padrão)');
  });

  test('cliente nas rotas antigas compra na loja padrão: itens de B → "não encontrado" e o pedido nasce na loja A', async () => {
    const headers = bearer(client.token);
    expect((await getJson(api, '/store/status', client.token)).id).toBe(demo.id);
    expectAllFromStore(await getJson(api, '/products', client.token), demo.id, 'cliente: GET /products');

    const refused: Array<[string, () => Promise<APIResponse>, string]> = [
      ['orçamento com produto de B', () => api.post('/orders/quote', { headers, data: takeout(productB.id) }), MSG.productMissingInOrder(productB.id)],
      ['pedido com produto de B', () => api.post('/orders', { headers, data: { ...takeout(productB.id), paymentMethod: 'MONEY' } }), MSG.productMissingInOrder(productB.id)],
      ['pedido com adicional de B', () =>
        api.post('/orders', { headers, data: { ...takeout(productA.id, [addonB.id]), paymentMethod: 'MONEY' } }), MSG.addonMissingInOrder(addonB.id)],
      ['cartão com produto de B', () => api.post('/payment/card', { headers, data: cardBody(takeout(productB.id)) }), MSG.productMissingInOrder(productB.id)],
      ['PIX com produto de B', () => api.post('/payment/pix', { headers, data: { order: takeout(productB.id) } }), MSG.productMissingInOrder(productB.id)],
    ];
    for (const [label, call, message] of refused) {
      await expectError(await call(), 400, message, `cliente na rota antiga: ${label}`);
    }

    // Com os itens da loja padrão, o pedido nasce na loja A
    const quote = await expectStatus(await api.post('/orders/quote', { headers, data: takeout(productA.id, [addonA.id]) }), 200);
    expect(Number(quote.subtotal)).toBe(18);
    const order = await expectStatus(
      await api.post('/orders', { headers, data: { ...takeout(productA.id, [addonA.id]), paymentMethod: 'MONEY' } }),
      201,
      'pedido na rota antiga',
    );
    cancelOrderLater(cleanup, api, adminA, order.id);
    expect(order.store_id, 'pedido da rota antiga nasce na loja padrão').toBe(demo.id);

    const mine: Json[] = await getJson(api, '/orders/my-orders', client.token);
    const stores = new Map(mine.map((item) => [item.id, item.store?.id]));
    expect(stores.get(order.id)).toBe(demo.id);
    expect(stores.get(orderB.id)).toBe(storeB.id);
    expect(ids(await getJson(api, '/orders', teamB.ADMIN.token)), 'o pedido da rota antiga não aparece em B').toEqual([orderB.id]);
  });

  test('equipe de B não compra pelas rotas antigas (nem na loja padrão): 403', async () => {
    for (const [role, session] of roles(teamB)) {
      const headers = bearer(session.token);
      await expectError(await api.post('/orders/quote', { headers, data: takeout(productB.id) }), 403, MSG.clientsOnly, `${role} de B: orçamento`);
      await expectError(
        await api.post('/orders', { headers, data: { ...takeout(productA.id), paymentMethod: 'MONEY' } }),
        403,
        MSG.clientsOnly,
        `${role} de B: pedido com produto da loja padrão`,
      );
    }
    await expectError(
      await api.post('/payment/card', { headers: bearer(teamB.ADMIN.token), data: cardBody(takeout(productB.id)) }),
      403,
      MSG.clientsOnly,
      'ADMIN de B: cartão',
    );
    expect(ids(await getJson(api, '/orders', teamB.ADMIN.token))).toEqual([orderB.id]);
  });
});
