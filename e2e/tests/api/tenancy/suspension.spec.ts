import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { loginAs } from '../../../support/api';
import {
  Cleanup,
  MSG,
  addAddon,
  addAddress,
  addProduct,
  advance,
  bearer,
  buildTeam,
  cardBody,
  cancelOrderLater,
  createStore,
  demoStore,
  expectError,
  expectNoSecrets,
  expectStatus,
  getJson,
  ids,
  makePng,
  newApi,
  newCustomer,
  payCard,
  placeOrder,
  pngFile,
  retireStore,
  storePath,
  trashProduct,
  trashProductLater,
  uid,
  uniqueEmail,
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
 * Seção 16 do pedido — "A suspensão de uma loja não apaga seus dados" no contexto do isolamento:
 * a loja B é suspensa pelo superpainel; a vitrine dela continua visível mas recusa orçamento, pedido e
 * pagamento; o painel fica só leitura para cardápio, equipe e configurações (pedidos em andamento
 * continuam: concluir, cancelar, estornar — docs/saas/arquitetura.md §4.2); nada é apagado e a loja A
 * não é afetada. Reativar devolve tudo ao normal.
 *
 * Os testes formam um fluxo (suspender → conferir → reativar): modo serial.
 */
test.describe('Isolamento entre lojas: loja B suspensa pelo superpainel', () => {
  test.describe.configure({ mode: 'serial' });

  const cleanup = new Cleanup();
  const reason = `Suspensão de teste E2E ${uid('mot')}`;
  const suspendedMessage = `Loja suspensa pela plataforma: ${reason}. Novos pedidos estão bloqueados; os dados e o histórico continuam disponíveis.`;
  const manageBlocked = `${suspendedMessage} Alterações no cardápio, na equipe e nas configurações estão bloqueadas.`;

  let api: APIRequestContext;
  let superadmin: Session;
  let demo: PublicStore;
  let adminA: Session;
  let storeB: TenantStore;
  let teamB: Team;
  let client: Member;
  let address: Json;

  let productA: Json;
  let productB: Json;
  let productBHidden: Json;
  let productBTrashed: Json;
  let addonB: Json;
  let pendingB: Json;
  let readyB: Json;
  let paidB: Json;

  let before: Snapshot;
  let accessA: Json;
  let publicMenu: number[];

  interface Snapshot {
    products: number[];
    trash: number[];
    addons: number[];
    orders: Array<{ id: number; status: string; payment_status: string }>;
    team: number[];
    customers: number;
    usage: Json;
  }

  const takeout = (productId: number, quantity = 1): OrderInput => ({ items: [{ productId, quantity }], type: 'TAKEOUT' });

  /** Tudo o que a loja B tem (pelo painel de B e pelo superpainel). */
  async function snapshotB(): Promise<Snapshot> {
    const token = teamB.ADMIN.token;
    const orders: Json[] = await getJson(api, '/orders', token, 'pedidos de B');
    const customers = await getJson(api, '/store/customers', token, 'clientes de B');
    const detail = await getJson(api, `/platform/stores/${storeB.id}`, superadmin.token, 'detalhe de B no superpainel');
    return {
      products: ids(await getJson(api, '/products', token, 'cardápio de B')),
      trash: ids(await getJson(api, '/products/trash', token, 'lixeira de B')),
      addons: ids(await getJson(api, '/addons', token, 'adicionais de B')),
      orders: orders
        .map((order) => ({ id: order.id as number, status: order.status as string, payment_status: order.payment_status as string }))
        .sort((a, b) => a.id - b.id),
      team: ids(await getJson(api, '/users', token, 'equipe de B')),
      customers: customers.total as number,
      usage: detail.usage,
    };
  }

  test.beforeAll(async () => {
    api = await newApi();
    superadmin = await loginAs(api, 'superadmin');
    demo = await demoStore();
    adminA = await loginAs(api, 'admin');

    storeB = await createStore(api, superadmin, 'Suspensa');
    cleanup.add('desativar a loja B', () => retireStore(api, superadmin, storeB));
    teamB = await buildTeam(api, storeB);
    addonB = await addAddon(api, teamB.ADMIN, { price: 3 });
    productB = await addProduct(api, teamB.ADMIN, { name: `Burger Suspenso ${uid('ps')}`, price: 24, allowed_addons_ids: [addonB.id] });
    productBHidden = await addProduct(api, teamB.ADMIN, { available: false });
    productBTrashed = await addProduct(api, teamB.ADMIN);
    await trashProduct(api, teamB.ADMIN, productBTrashed.id);

    productA = await addProduct(api, adminA, { price: 11 });
    trashProductLater(cleanup, api, adminA, productA.id);

    client = await newCustomer(api, 'Cliente Suspensa');
    address = await addAddress(api, client, 'Centro');
    pendingB = await placeOrder(api, storeB.slug, client, takeout(productB.id));
    readyB = await placeOrder(api, storeB.slug, client, {
      items: [{ productId: productB.id, quantity: 1, addonIds: [addonB.id] }],
      type: 'DELIVERY',
      addressId: address.id,
    });
    await advance(api, teamB.ADMIN, readyB.id, 'PREPARING', 'READY_FOR_PICKUP');
    paidB = await payCard(api, storeB.slug, client, takeout(productB.id, 2));

    accessA = (await getJson(api, '/store/settings', adminA.token, 'configurações de A')).access;
    publicMenu = ids(await getJson(api, storePath(storeB.slug, '/products'), undefined, 'cardápio público de B'));
    expect(publicMenu, 'vitrine de B: o produto público, nunca a lixeira').toContain(productB.id);
    expect(publicMenu).not.toContain(productBTrashed.id);
    before = await snapshotB();
    expect(before.orders.map((order) => order.id)).toEqual(ids([pendingB, readyB, { id: paidB.orderId }]));
  });

  test.afterAll(async () => {
    await cleanup.run();
    await api.dispose();
  });

  test('o superpainel suspende a loja B (motivo obrigatório; 409 se já suspensa) e nada é apagado', async () => {
    const suspend = (token: string, data: Record<string, unknown>) =>
      api.post(`/platform/stores/${storeB.id}/suspend`, { headers: bearer(token), data });

    // Só a plataforma suspende: nem o ADMIN de B, nem o de A
    await expectError(await suspend(teamB.ADMIN.token, { reason }), 403, MSG.platformOnly, 'ADMIN de B suspende a própria loja');
    await expectError(await suspend(adminA.token, { reason }), 403, MSG.platformOnly, 'ADMIN de A suspende a loja B');
    await expectError(
      await suspend(superadmin.token, {}),
      400,
      'Informe o motivo (ele aparece para a equipe da loja e fica na auditoria).',
      'suspender sem motivo',
    );

    const suspended = await expectStatus(await suspend(superadmin.token, { reason }), 200, 'suspender a loja B');
    expectNoSecrets(suspended, 'loja suspensa (superpainel)');
    expect(suspended).toMatchObject({ id: storeB.id, account_status: 'SUSPENDED', status_reason: reason, warnings: [] });
    expect(suspended.access).toEqual({
      availability: 'SUSPENDED',
      canSell: false,
      canRead: true,
      canOperate: true,
      canManage: false,
      canManageBilling: true,
      publicVisible: true,
      message: suspendedMessage,
    });
    await expectError(await suspend(superadmin.token, { reason }), 409, 'A loja já está suspensa.', 'suspender de novo');

    // Auditoria da loja registra a suspensão com o motivo
    const audit = await getJson(
      api,
      `/platform/stores/${storeB.id}/audit?action=platform.store.suspend`,
      superadmin.token,
      'auditoria da suspensão',
    );
    const entries: Json[] = audit.items;
    expect(entries.length, 'uma suspensão registrada na auditoria da loja B').toBe(1);
    expect(entries[0]).toMatchObject({ action: 'platform.store.suspend', store_id: storeB.id });
    expect(entries[0].metadata).toMatchObject({ from: 'ACTIVE', to: 'SUSPENDED', reason });

    // Nada foi apagado e a loja A segue como estava
    expect(await snapshotB(), 'dados da loja B intactos depois da suspensão').toEqual(before);
    expect((await getJson(api, '/store/settings', adminA.token)).access, 'situação da loja A não muda').toEqual(accessA);
  });

  test('vitrine da loja suspensa: perfil e cardápio visíveis, mas orçamento, pedido e pagamentos recusados (403)', async () => {
    const profile = await getJson(api, `/stores/${storeB.slug}`, undefined, 'perfil público de B');
    expect(profile).toMatchObject({ id: storeB.id, ordering_available: false, unavailable_message: MSG.storeUnavailable });
    expectNoSecrets(profile, 'perfil público da loja suspensa');
    const menu: Json[] = await getJson(api, storePath(storeB.slug, '/products'), undefined, 'cardápio público de B');
    expect(ids(menu), 'cardápio público de B continua o mesmo de antes da suspensão').toEqual(publicMenu);
    await getJson(api, storePath(storeB.slug, '/status'), undefined, 'status público de B');

    const headers = bearer(client.token);
    const order = takeout(productB.id);
    const attempts: Array<[string, () => Promise<APIResponse>]> = [
      ['orçamento', () => api.post(storePath(storeB.slug, '/orders/quote'), { headers, data: order })],
      ['pedido na entrega', () => api.post(storePath(storeB.slug, '/orders'), { headers, data: { ...order, paymentMethod: 'MONEY' } })],
      ['pedido de entrega', () =>
        api.post(storePath(storeB.slug, '/orders'), {
          headers,
          data: { items: order.items, type: 'DELIVERY', addressId: address.id, paymentMethod: 'MONEY' },
        })],
      ['cartão', () => api.post(storePath(storeB.slug, '/payment/card'), { headers, data: cardBody(order) })],
      ['PIX', () => api.post(storePath(storeB.slug, '/payment/pix'), { headers, data: { order } })],
    ];
    // A mensagem diz que a loja não aceita pedidos novos (o texto exato para o cliente — com ou sem o
    // motivo interno da suspensão — está em aberto na documentação)
    for (const [label, call] of attempts) {
      await expectError(
        await call(),
        403,
        /Novos pedidos estão bloqueados|indisponível para novos pedidos/,
        `vitrine suspensa: ${label}`,
      );
    }

    // Nenhum pedido novo em B; a loja A continua vendendo para o mesmo cliente
    expect((await getJson(api, '/orders', teamB.ADMIN.token)).map((o: Json) => o.id).sort((a: number, b: number) => a - b)).toEqual(
      before.orders.map((o) => o.id),
    );
    const quoteA = await expectStatus(
      await api.post(storePath(demo.slug, '/orders/quote'), { headers, data: takeout(productA.id) }),
      200,
      'orçamento na loja A durante a suspensão de B',
    );
    expect(Number(quoteA.subtotal)).toBe(11);
    expect((await getJson(api, `/stores/${demo.slug}`)).ordering_available, 'a loja A continua vendendo').toBe(true);
  });

  test('o cliente não vê o motivo interno da suspensão: a recusa da compra usa a mensagem genérica da vitrine', async () => {
    const headers = bearer(client.token);
    const order = takeout(productB.id);
    const attempts: Array<[string, () => Promise<APIResponse>]> = [
      ['orçamento', () => api.post(storePath(storeB.slug, '/orders/quote'), { headers, data: order })],
      ['pedido', () => api.post(storePath(storeB.slug, '/orders'), { headers, data: { ...order, paymentMethod: 'MONEY' } })],
      ['cartão', () => api.post(storePath(storeB.slug, '/payment/card'), { headers, data: cardBody(order) })],
      ['PIX', () => api.post(storePath(storeB.slug, '/payment/pix'), { headers, data: { order } })],
    ];
    for (const [label, call] of attempts) {
      const payload = await expectError(await call(), 403, undefined, `vitrine suspensa: ${label}`);
      expect(JSON.stringify(payload), `${label}: o motivo interno não chega ao cliente`).not.toContain(reason);
      expect(payload.message, `${label}: mesma mensagem do perfil público`).toBe(MSG.storeUnavailable);
    }
  });

  test('painel da loja suspensa: leitura liberada; cardápio, equipe e configurações bloqueados (403 com o motivo)', async () => {
    const admin = bearer(teamB.ADMIN.token);
    for (const path of ['/products', '/products/trash', '/addons', '/orders', '/users', '/users/trash', '/store/customers', '/orders/summary', '/store/subscription']) {
      await getJson(api, path, teamB.ADMIN.token, `ADMIN de B (suspensa): GET ${path}`);
    }
    const settings = await getJson(api, '/store/settings', teamB.ADMIN.token);
    expect(settings.access).toMatchObject({ availability: 'SUSPENDED', canManage: false, message: suspendedMessage });
    for (const [role, session] of Object.entries(teamB) as Array<[StaffRole, Session]>) {
      const list: Json[] = await getJson(api, '/orders?scope=active', session.token, `${role} de B (suspensa): quadro`);
      expect(list.every((o) => o.store_id === storeB.id), `${role} de B vê só pedidos de B`).toBe(true);
    }

    const writes: Array<[string, () => Promise<APIResponse>]> = [
      ['POST /products', () => api.post('/products', { headers: admin, data: { name: 'Novo na suspensa', price: 5, category: 'bebidas' } })],
      ['PATCH /products/:id', () => api.patch(`/products/${productB.id}`, { headers: admin, data: { price: 1 } })],
      ['DELETE /products/:id', () => api.delete(`/products/${productB.id}`, { headers: admin })],
      ['PATCH /products/:id/restore', () => api.patch(`/products/${productBTrashed.id}/restore`, { headers: admin })],
      ['DELETE /products/:id/permanent', () => api.delete(`/products/${productBTrashed.id}/permanent`, { headers: admin })],
      ['POST /addons', () => api.post('/addons', { headers: admin, data: { name: 'Adicional suspenso', price: 1 } })],
      ['PATCH /addons/:id', () => api.patch(`/addons/${addonB.id}`, { headers: admin, data: { price: 9 } })],
      ['PATCH /store/settings', () => api.patch('/store/settings', { headers: admin, data: { description: 'Alterada na suspensão' } })],
      ['PATCH /store/status (ADMIN)', () => api.patch('/store/status', { headers: admin, data: { is_open: false } })],
      ['PATCH /store/status (EMPLOYEE)', () => api.patch('/store/status', { headers: bearer(teamB.EMPLOYEE.token), data: { is_open: false } })],
      ['POST /store/logo', () => api.post('/store/logo', { headers: admin, multipart: { file: pngFile(makePng(8, 8)) } })],
      ['PUT /store/settings/payments', () =>
        api.put('/store/settings/payments', { headers: admin, data: { mp_public_key: `TEST-${uid('pk')}`, mp_access_token: `TEST-${uid('tk')}` } })],
      ['POST /users (equipe)', () =>
        api.post('/users', { headers: admin, data: { name: 'Equipe Suspensa', email: uniqueEmail('tn-susp'), password: 'SenhaForte@123', role: 'EMPLOYEE' } })],
      ['PATCH /users/:id (equipe)', () => api.patch(`/users/${teamB.KITCHEN.user.id}`, { headers: admin, data: { name: 'Cozinha Renomeada' } })],
      ['DELETE /users/:id (equipe)', () => api.delete(`/users/${teamB.KITCHEN.user.id}`, { headers: admin })],
      ['POST /store/invitations', () => api.post('/store/invitations', { headers: admin, data: { email: uniqueEmail('tn-susp-inv'), role: 'KITCHEN' } })],
    ];
    for (const [label, call] of writes) {
      await expectError(await call(), 403, manageBlocked, `loja suspensa: ${label}`);
    }

    // Pedidos em andamento continuam: preparo, entrega e cancelamento com estorno
    expect(await advance(api, teamB.KITCHEN, pendingB.id, 'PREPARING')).toMatchObject({ id: pendingB.id, status: 'PREPARING' });
    expect(await advance(api, teamB.COURIER, readyB.id, 'DELIVERING', 'DONE')).toMatchObject({ id: readyB.id, status: 'DONE' });
    const canceled = await expectStatus(
      await api.patch(`/orders/${paidB.orderId}/cancel`, { headers: bearer(teamB.EMPLOYEE.token) }),
      200,
      'cancelar o pedido pago na loja suspensa',
    );
    expect(canceled).toMatchObject({ id: paidB.orderId, status: 'CANCELED', payment_status: 'REFUNDED', store_id: storeB.id });

    // Cardápio, equipe e configurações continuam exatamente como antes
    const now = await snapshotB();
    expect({ products: now.products, trash: now.trash, addons: now.addons, team: now.team }).toEqual({
      products: before.products,
      trash: before.trash,
      addons: before.addons,
      team: before.team,
    });
    expect((await getJson(api, `/products/${productB.id}`, teamB.ADMIN.token)).price).toBe(productB.price);
    const kitchen = await getJson(api, `/users/${teamB.KITCHEN.user.id}`, teamB.ADMIN.token);
    expect(kitchen).toMatchObject({ id: teamB.KITCHEN.user.id, name: teamB.KITCHEN.user.name, store_id: storeB.id });
  });

  test('reativar volta ao normal: a vitrine vende, o painel altera e os dados continuam lá', async () => {
    const reactivated = await expectStatus(
      await api.post(`/platform/stores/${storeB.id}/reactivate`, { headers: bearer(superadmin.token), data: {} }),
      200,
      'reativar a loja B',
    );
    expect(reactivated).toMatchObject({ id: storeB.id, account_status: 'ACTIVE', status_reason: null });
    expect(reactivated.access).toMatchObject({ availability: 'OPERATIONAL', canSell: true, canManage: true, message: null });
    await expectError(
      await api.post(`/platform/stores/${storeB.id}/reactivate`, { headers: bearer(superadmin.token), data: {} }),
      409,
      'A loja já está ativa.',
      'reativar de novo',
    );

    expect(await getJson(api, `/stores/${storeB.slug}`)).toMatchObject({ ordering_available: true, unavailable_message: null });
    const order = await expectStatus(
      await api.post(storePath(storeB.slug, '/orders'), { headers: bearer(client.token), data: { ...takeout(productB.id), paymentMethod: 'MONEY' } }),
      201,
      'pedido na loja B reativada',
    );
    expect(order.store_id).toBe(storeB.id);
    cancelOrderLater(cleanup, api, teamB.ADMIN, order.id);

    const product = await expectStatus(
      await api.post('/products', { headers: bearer(teamB.ADMIN.token), data: { name: `Volta ${uid('rv')}`, price: 7, category: 'bebidas' } }),
      201,
      'ADMIN de B volta a alterar o cardápio',
    );
    expect(product.store_id).toBe(storeB.id);
    await expectStatus(await api.patch('/store/status', { headers: bearer(teamB.EMPLOYEE.token), data: { is_open: true } }), 200);

    // Tudo o que existia antes da suspensão continua na loja B
    const now = await snapshotB();
    expect(now.products).toEqual(expect.arrayContaining(before.products));
    expect(now.trash).toEqual(before.trash);
    expect(now.team).toEqual(before.team);
    expect(now.orders.map((o) => o.id)).toEqual(expect.arrayContaining(before.orders.map((o) => o.id)));
    expect(now.customers).toBe(before.customers);
    expect(productBHidden.store_id).toBe(storeB.id);
  });
});
