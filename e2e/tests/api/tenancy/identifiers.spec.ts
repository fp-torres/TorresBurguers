import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { loginAs } from '../../../support/api';
import {
  Cleanup,
  MISSING_ID,
  MSG,
  addAddon,
  addAddress,
  addProduct,
  advance,
  bearer,
  buildTeam,
  cancelOrderLater,
  cardBody,
  createStore,
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
  placeOrder,
  retireStore,
  storePath,
  trashProductLater,
  uniqueEmail,
  type Json,
  type Member,
  type PublicStore,
  type Session,
  type Team,
  type TenantStore,
} from './helpers';

/**
 * Seção 16 do pedido — "Alterar um identificador no frontend não concede acesso a outro tenant".
 * A loja vem SEMPRE do servidor (usuário autenticado ou slug da vitrine): store_id/storeId/tenantId/slug
 * no corpo são recusados pelos DTOs (400), cabeçalhos inventados são ignorados e ids de outra loja
 * valem como inexistentes.
 */
test.describe('Isolamento entre lojas: identificadores adulterados', () => {
  const cleanup = new Cleanup();
  let api: APIRequestContext;
  let superadmin: Session;
  let demo: PublicStore;
  let teamA: Team;
  let storeB: TenantStore;
  let teamB: Team;
  let clientX: Member;
  let clientY: Member;
  let addressX: Json;
  let addressY: Json;

  let productA: Json;
  let addonA: Json;
  let productB: Json;
  let addonB: Json;
  let aOrder: Json;
  let aDelivery: Json;
  let bOrder: Json;
  let bDelivery: Json;
  let bPayment: Json;

  /** Cabeçalhos que um cliente adulterado poderia mandar para "trocar" de loja. */
  const forgedHeaders = (store: { id: number; slug: string }) => ({
    'X-Store-Id': String(store.id),
    'X-Tenant-Id': String(store.id),
    'X-Store-Slug': store.slug,
    'X-Tenant': store.slug,
  });

  test.beforeAll(async () => {
    api = await newApi();
    superadmin = await loginAs(api, 'superadmin');
    demo = await demoStore();
    teamA = await demoTeam(api);

    storeB = await createStore(api, superadmin, 'Identificadores');
    cleanup.add('desativar a loja B', () => retireStore(api, superadmin, storeB));
    teamB = await buildTeam(api, storeB);
    addonB = await addAddon(api, teamB.ADMIN, { price: 2 });
    productB = await addProduct(api, teamB.ADMIN, { price: 21, allowed_addons_ids: [addonB.id] });

    addonA = await addAddon(api, teamA.ADMIN, { price: 2 });
    cleanup.add('lixeira do adicional de A', () => api.delete(`/addons/${addonA.id}`, { headers: bearer(teamA.ADMIN.token) }));
    productA = await addProduct(api, teamA.ADMIN, { price: 19, allowed_addons_ids: [addonA.id] });
    trashProductLater(cleanup, api, teamA.ADMIN, productA.id);

    clientX = await newCustomer(api, 'Cliente X');
    clientY = await newCustomer(api, 'Cliente Y');
    addressX = await addAddress(api, clientX, 'Centro');
    addressY = await addAddress(api, clientY, 'Centro');

    aOrder = await placeOrder(api, demo.slug, clientX, { items: [{ productId: productA.id, quantity: 1 }], type: 'TAKEOUT' });
    cancelOrderLater(cleanup, api, teamA.ADMIN, aOrder.id);
    aDelivery = await placeOrder(api, demo.slug, clientX, { items: [{ productId: productA.id, quantity: 1 }], type: 'DELIVERY', addressId: addressX.id });
    cancelOrderLater(cleanup, api, teamA.ADMIN, aDelivery.id);
    await advance(api, teamA.ADMIN, aDelivery.id, 'PREPARING');

    bOrder = await placeOrder(api, storeB.slug, clientX, { items: [{ productId: productB.id, quantity: 1 }], type: 'TAKEOUT' });
    bDelivery = await placeOrder(api, storeB.slug, clientX, { items: [{ productId: productB.id, quantity: 1 }], type: 'DELIVERY', addressId: addressX.id });
    await advance(api, teamB.ADMIN, bDelivery.id, 'PREPARING');
    bPayment = await payCard(api, storeB.slug, clientX, { items: [{ productId: productB.id, quantity: 2 }], type: 'TAKEOUT' });
  });

  test.afterAll(async () => {
    await cleanup.run();
    await api.dispose();
  });

  test('store_id, storeId, tenantId e slug no corpo são recusados (400) em todas as escritas — nada é gravado', async () => {
    const productItems = (productId: number) => ({ items: [{ productId, quantity: 1 }], type: 'TAKEOUT' });
    const writes: Array<[string, Session, 'post' | 'patch', string, Record<string, unknown>]> = [
      ['ADMIN de A: POST /products', teamA.ADMIN, 'post', '/products', { name: 'Forjado', price: 1, category: 'bebidas' }],
      ['ADMIN de A: PATCH /products/:id', teamA.ADMIN, 'patch', `/products/${productA.id}`, { name: 'Forjado' }],
      ['ADMIN de A: POST /addons', teamA.ADMIN, 'post', '/addons', { name: 'Forjado', price: 1 }],
      ['ADMIN de A: PATCH /addons/:id', teamA.ADMIN, 'patch', `/addons/${addonA.id}`, { price: 1 }],
      ['ADMIN de A: PATCH /store/settings', teamA.ADMIN, 'patch', '/store/settings', { description: 'Forjado' }],
      ['ADMIN de A: PATCH /store/status', teamA.ADMIN, 'patch', '/store/status', { is_open: true }],
      ['ADMIN de A: POST /store/invitations', teamA.ADMIN, 'post', '/store/invitations', { email: uniqueEmail('tn-forjado'), role: 'EMPLOYEE' }],
      ['ADMIN de A: PATCH /orders/:id', teamA.ADMIN, 'patch', `/orders/${aOrder.id}`, { status: 'PREPARING' }],
      ['ADMIN de A: PATCH /orders/:id/assign', teamA.ADMIN, 'patch', `/orders/${aDelivery.id}/assign`, { driverId: teamA.COURIER.user.id }],
      // Contas: "mudar de loja" editando o próprio perfil ou o de alguém da equipe (o nome enviado é o atual)
      ['ATENDENTE de A: PATCH /users/<si mesmo>', teamA.EMPLOYEE, 'patch', `/users/${teamA.EMPLOYEE.user.id}`, { name: teamA.EMPLOYEE.user.name }],
      ['ADMIN de A: PATCH /users/<atendente de A>', teamA.ADMIN, 'patch', `/users/${teamA.EMPLOYEE.user.id}`, { name: teamA.EMPLOYEE.user.name }],
      ['ADMIN de B: PATCH /users/<cozinha de B>', teamB.ADMIN, 'patch', `/users/${teamB.KITCHEN.user.id}`, { name: teamB.KITCHEN.user.name }],
      ['cliente: PATCH /users/<si mesmo>', clientX, 'patch', `/users/${clientX.user.id}`, { name: clientX.user.name }],
      // Endereços (globais, da conta do cliente)
      ['cliente: POST /addresses', clientX, 'post', '/addresses', { zipCode: '20040-002', street: 'Rua Forjada', number: '1', neighborhood: 'Centro', city: 'Rio de Janeiro', state: 'RJ' }],
      ['cliente: PATCH /addresses/:id', clientX, 'patch', `/addresses/${addressX.id}`, { number: String(addressX.number) }],
      ['cliente: POST /orders/quote (rota antiga)', clientX, 'post', '/orders/quote', productItems(productA.id)],
      ['cliente: POST /stores/<B>/orders/quote', clientX, 'post', storePath(storeB.slug, '/orders/quote'), productItems(productB.id)],
      ['cliente: POST /stores/<B>/orders', clientX, 'post', storePath(storeB.slug, '/orders'), { ...productItems(productB.id), paymentMethod: 'MONEY' }],
      ['cliente: POST /stores/<B>/payment/card', clientX, 'post', storePath(storeB.slug, '/payment/card'), cardBody(productItems(productB.id))],
      ['cliente: POST /stores/<B>/payment/pix', clientX, 'post', storePath(storeB.slug, '/payment/pix'), { order: productItems(productB.id) }],
    ];
    const ordersBefore = ids(await getJson(api, '/orders', teamB.ADMIN.token));
    for (const [label, actor, method, path, data] of writes) {
      for (const [field, value] of [['store_id', storeB.id], ['storeId', storeB.id], ['tenantId', storeB.id], ['slug', storeB.slug]] as const) {
        const res = await api[method](path, { headers: bearer(actor.token), data: { ...data, [field]: value } });
        await expectError(res, 400, MSG.notAllowed(field), `${label} + ${field}`);
      }
    }
    // Também dentro do pedido enviado ao pagamento
    await expectError(
      await api.post(storePath(storeB.slug, '/payment/card'), {
        headers: bearer(clientX.token),
        data: cardBody({ ...productItems(productB.id), storeId: demo.id }),
      }),
      400,
      MSG.notAllowed('storeId'),
      'pedido do pagamento com storeId',
    );

    // Nada foi gravado em nenhuma loja
    expect(ids(await getJson(api, '/orders', teamB.ADMIN.token)), 'nenhum pedido novo em B').toEqual(ordersBefore);
    expect((await getJson(api, `/orders/${aOrder.id}`, teamA.ADMIN.token)).status).toBe('PENDING');
    expect((await getJson(api, `/orders/${aDelivery.id}`, teamA.ADMIN.token)).driver).toBeNull();
    expect((await getJson(api, `/products/${productA.id}`)).name).toBe(productA.name);
    const settings = await getJson(api, '/store/settings', teamA.ADMIN.token);
    expect(settings.description).not.toBe('Forjado');
    // As contas continuam nas lojas de origem (cliente sem loja) e nenhum endereço foi criado
    expect((await getJson(api, `/users/${teamA.EMPLOYEE.user.id}`, teamA.ADMIN.token)).store_id).toBe(demo.id);
    expect((await getJson(api, `/users/${teamB.KITCHEN.user.id}`, teamB.ADMIN.token)).store_id).toBe(storeB.id);
    expect((await getJson(api, '/auth/me', clientX.token)).store_id).toBeNull();
    expect(ids(await getJson(api, '/addresses', clientX.token))).toEqual([addressX.id]);
  });

  test('na query: rotas com filtros validados recusam a loja (400); nas demais o parâmetro é ignorado e a loja é a do token', async () => {
    const adminA = bearer(teamA.ADMIN.token);
    for (const field of ['storeId', 'store_id', 'tenantId']) {
      await expectError(await api.get(`/store/customers?${field}=${storeB.id}`, { headers: adminA }), 400, MSG.notAllowed(field), `GET /store/customers?${field}`);
      await expectError(await api.get(`/store/invitations?${field}=${storeB.id}`, { headers: adminA }), 400, MSG.notAllowed(field), `GET /store/invitations?${field}`);
      await expectError(await api.get(`/stores?${field}=${storeB.id}`), 400, MSG.notAllowed(field), `GET /stores?${field}`);
    }

    const forged = `storeId=${storeB.id}&store_id=${storeB.id}&tenantId=${storeB.id}&slug=${storeB.slug}`;
    const plainProducts = ids(await getJson(api, '/products', teamA.ADMIN.token));
    const forgedProducts: Json[] = await getJson(api, `/products?${forged}`, teamA.ADMIN.token);
    expect(ids(forgedProducts), 'GET /products?storeId=<B> = cardápio de A').toEqual(plainProducts);
    expectNoneOf(forgedProducts, [productB.id], 'GET /products?storeId=<B>');

    const forgedOrders: Json[] = await getJson(api, `/orders?${forged}`, teamA.ADMIN.token);
    expectAllFromStore(forgedOrders, demo.id, 'GET /orders?storeId=<B>');
    expectNoneOf(forgedOrders, [bOrder.id, bDelivery.id, bPayment.orderId], 'GET /orders?storeId=<B>');

    const summary = await getJson(api, '/orders/summary', teamA.ADMIN.token);
    expect(await getJson(api, `/orders/summary?${forged}`, teamA.ADMIN.token), 'resumo de A').toEqual(summary);
    expect((await getJson(api, `/store/settings?${forged}`, teamA.ADMIN.token)).id).toBe(demo.id);
    expect((await getJson(api, `/store/status?${forged}`)).id, 'visitante: loja padrão').toBe(demo.id);
    expect((await getJson(api, `/users?${forged}`, teamA.ADMIN.token)).some((u: Json) => u.store_id === storeB.id)).toBe(false);
    // E o contrário: o ADMIN de B com a loja A na query continua em B
    const bProducts: Json[] = await getJson(api, `/products?storeId=${demo.id}&slug=${demo.slug}`, teamB.ADMIN.token);
    expectAllFromStore(bProducts, storeB.id, 'GET /products?storeId=<A> com token de B');
  });

  test('cabeçalhos inventados (X-Store-Id, X-Tenant-Id, X-Store-Slug) não trocam a loja', async () => {
    const towardB = bearer(teamA.ADMIN.token, forgedHeaders(storeB));
    expect((await expectStatus(await api.get('/store/settings', { headers: towardB }), 200)).id).toBe(demo.id);
    const products: Json[] = await expectStatus(await api.get('/products', { headers: towardB }), 200);
    expectAllFromStore(products, demo.id, 'GET /products com cabeçalhos de B');
    const orders: Json[] = await expectStatus(await api.get('/orders', { headers: towardB }), 200);
    expectAllFromStore(orders, demo.id, 'GET /orders com cabeçalhos de B');
    const team: Json[] = await expectStatus(await api.get('/users', { headers: towardB }), 200);
    expectAllFromStore(team, demo.id, 'GET /users com cabeçalhos de B');
    await expectError(await api.get(`/orders/${bOrder.id}`, { headers: towardB }), 404, MSG.orderNotFound);
    await expectError(await api.get(`/products/${productB.id}`, { headers: towardB }), 404, MSG.productNotFound);

    // Escrita com os cabeçalhos: grava na loja do token (A), nunca em B
    const created = await expectStatus(
      await api.post('/products', { headers: towardB, data: { name: 'Produto com cabeçalho forjado', price: 3, category: 'bebidas' } }),
      201,
    );
    trashProductLater(cleanup, api, teamA.ADMIN, created.id);
    expect(created.store_id).toBe(demo.id);
    expect((await getJson(api, storePath(storeB.slug, '/products'))).some((p: Json) => p.id === created.id)).toBe(false);

    // Visitante e cliente com os cabeçalhos: rotas antigas continuam na loja padrão
    const anonB = forgedHeaders(storeB);
    expect((await expectStatus(await api.get('/store/status', { headers: anonB }), 200)).id).toBe(demo.id);
    expectAllFromStore(await expectStatus(await api.get('/products', { headers: anonB }), 200), demo.id, 'visitante com cabeçalhos de B');
    await expectError(
      await api.post('/orders/quote', {
        headers: bearer(clientX.token, anonB),
        data: { items: [{ productId: productB.id, quantity: 1 }], type: 'TAKEOUT' },
      }),
      400,
      MSG.productMissingInOrder(productB.id),
      'cliente com cabeçalhos de B na rota antiga',
    );

    // E o ADMIN de B com cabeçalhos apontando para A continua em B
    const towardA = bearer(teamB.ADMIN.token, forgedHeaders(demo));
    expect((await expectStatus(await api.get('/store/settings', { headers: towardA }), 200)).id).toBe(storeB.id);
    await expectError(await api.get(`/orders/${aOrder.id}`, { headers: towardA }), 404, MSG.orderNotFound);
  });

  test('slug da loja B na vitrine com token da equipe de A: só a leitura pública de B; compra e gestão recusadas', async () => {
    const adminA = bearer(teamA.ADMIN.token);
    const B = (path: string) => storePath(storeB.slug, path);
    const asA: Json[] = await expectStatus(await api.get(B('/products'), { headers: adminA }), 200);
    const asVisitor: Json[] = await getJson(api, B('/products'));
    expect(ids(asA), 'a equipe de A vê o mesmo cardápio público que qualquer visitante').toEqual(ids(asVisitor));
    expect((await expectStatus(await api.get(B('/status'), { headers: adminA }), 200)).id).toBe(storeB.id);
    await expectError(await api.get(B('/products/trash'), { headers: adminA }), 403, MSG.otherStore);
    await expectError(await api.get(B(`/products/${productA.id}`), { headers: adminA }), 404, MSG.productNotFound);

    const order = { items: [{ productId: productB.id, quantity: 1 }], type: 'TAKEOUT' };
    for (const [label, path, data] of [
      ['orçamento', B('/orders/quote'), order],
      ['pedido', B('/orders'), { ...order, paymentMethod: 'MONEY' }],
      ['cartão', B('/payment/card'), cardBody(order)],
      ['PIX', B('/payment/pix'), { order }],
    ] as Array<[string, string, Record<string, unknown>]>) {
      await expectError(await api.post(path, { headers: adminA, data }), 403, MSG.clientsOnly, `equipe de A compra em B (${label})`);
    }
    // my-orders pelo slug de B: só os pedidos da própria conta (nenhum)
    expect(await getJson(api, B('/orders/my-orders'), teamA.ADMIN.token)).toEqual([]);
  });

  test('ids da loja B em requisições da loja A (e de A em B) valem como inexistentes', async () => {
    const asClient = bearer(clientX.token);
    const quoteAt = (path: string, items: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
      api.post(path, { headers: asClient, data: { items, type: 'TAKEOUT', ...extra } });

    // Produto e adicional de B na loja A (rota antiga = loja padrão, e rota da vitrine de A)
    for (const path of ['/orders/quote', storePath(demo.slug, '/orders/quote')]) {
      await expectError(await quoteAt(path, [{ productId: productB.id, quantity: 1 }]), 400, MSG.productMissingInOrder(productB.id), `${path} com produto de B`);
      await expectError(await quoteAt(path, [{ productId: MISSING_ID, quantity: 1 }]), 400, MSG.productMissingInOrder(MISSING_ID), `${path} com produto inexistente`);
      await expectError(
        await quoteAt(path, [{ productId: productA.id, quantity: 1, addonIds: [addonB.id] }]),
        400,
        MSG.addonMissingInOrder(addonB.id),
        `${path} com adicional de B`,
      );
    }
    await expectError(
      await api.post(storePath(demo.slug, '/orders'), { headers: asClient, data: { items: [{ productId: productB.id, quantity: 1 }], type: 'TAKEOUT', paymentMethod: 'MONEY' } }),
      400,
      MSG.productMissingInOrder(productB.id),
      'pedido em A com produto de B',
    );
    await expectError(
      await api.post(storePath(demo.slug, '/payment/card'), { headers: asClient, data: cardBody({ items: [{ productId: productB.id, quantity: 1 }], type: 'TAKEOUT' }) }),
      400,
      MSG.productMissingInOrder(productB.id),
      'cartão em A com produto de B (nada é cobrado)',
    );

    // Produto e adicional de A na loja B
    await expectError(await quoteAt(storePath(storeB.slug, '/orders/quote'), [{ productId: productA.id, quantity: 1 }]), 400, MSG.productMissingInOrder(productA.id));
    await expectError(
      await quoteAt(storePath(storeB.slug, '/orders/quote'), [{ productId: productB.id, quantity: 1, addonIds: [addonA.id] }]),
      400,
      MSG.addonMissingInOrder(addonA.id),
    );

    // Endereço de outro cliente (endereços são da conta do cliente, globais)
    await expectError(
      await api.post(storePath(storeB.slug, '/orders/quote'), {
        headers: asClient,
        data: { items: [{ productId: productB.id, quantity: 1 }], type: 'DELIVERY', addressId: addressY.id },
      }),
      404,
      MSG.addressNotFound,
      'endereço de outro cliente',
    );

    // Entregador de outra loja
    await expectError(
      await api.patch(`/orders/${aDelivery.id}/assign`, { headers: bearer(teamA.ADMIN.token), data: { driverId: teamB.COURIER.user.id } }),
      404,
      MSG.driverNotFound,
    );
    await expectError(
      await api.patch(`/orders/${bDelivery.id}/assign`, { headers: bearer(teamB.ADMIN.token), data: { driverId: teamA.COURIER.user.id } }),
      404,
      MSG.driverNotFound,
    );

    // Pagamento de B: não vira pedido em A, não é consultado nem estornado pela equipe de A
    for (const path of ['/orders', storePath(demo.slug, '/orders')]) {
      await expectError(
        await api.post(path, {
          headers: asClient,
          data: { items: [{ productId: productA.id, quantity: 2 }], type: 'TAKEOUT', paymentMethod: 'CREDIT_CARD', paymentId: bPayment.id },
        }),
        400,
        MSG.paymentNotFoundOrExpired,
        `${path} com o pagamento de B`,
      );
    }
    await expectUniform404(
      await api.get(`/payment/status/${bPayment.id}`, { headers: bearer(teamA.ADMIN.token) }),
      await api.get(`/payment/status/${MISSING_ID}`, { headers: bearer(teamA.ADMIN.token) }),
      MSG.paymentNotFound,
      'ADMIN de A consulta o pagamento de B',
    );
    await expectUniform404(
      await api.patch(`/orders/${bPayment.orderId}/cancel`, { headers: bearer(teamA.ADMIN.token) }),
      await api.patch(`/orders/${MISSING_ID}/cancel`, { headers: bearer(teamA.ADMIN.token) }),
      MSG.orderNotFound,
      'ADMIN de A cancela (estorna) o pedido pago de B',
    );
    const paidOrder = await getJson(api, `/orders/${bPayment.orderId}`, teamB.ADMIN.token);
    expect(paidOrder).toMatchObject({ payment_status: 'PAID', store_id: storeB.id });
    const status = await getJson(api, `/payment/status/${bPayment.id}`, clientX.token);
    expect(status).toMatchObject({ id: bPayment.id, status: 'approved', orderId: bPayment.orderId });

    // Nenhum pedido novo apareceu em A com itens de B
    const ordersA: Json[] = await getJson(api, '/orders', teamA.ADMIN.token);
    const leaked = ordersA.filter((o) => (o.items ?? []).some((i: Json) => i.product?.id === productB.id));
    expect(leaked.map((o) => o.id)).toEqual([]);
  });
});
