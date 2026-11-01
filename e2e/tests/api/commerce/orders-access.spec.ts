import { test, expect, type APIRequestContext } from '@playwright/test';
import { demoStore, uid } from '../../../support/api';
import { E2E } from '../../../support/env';
import {
  Actors,
  UNKNOWN_ID,
  advance,
  createAddress,
  createProduct,
  expectNestError,
  expectNoPasswordFields,
  expectStatus,
  getOrder,
  myOrders,
  placeOrder,
  sleep,
  type Actor,
  type Json,
} from './helpers';

test.describe('Pedidos: quem vê o quê', () => {
  const actors = new Actors();
  let anon: APIRequestContext;
  let admin: Actor;
  let employee: Actor;
  let kitchen: Actor;
  let courier: Actor;
  let clientA: Actor;
  let clientB: Actor;
  let product: Json;
  let a1: Json;
  let a2: Json;
  let b1: Json;

  test.beforeAll(async () => {
    anon = await actors.anon();
    admin = await actors.defaultUser('admin');
    employee = await actors.defaultUser('employee');
    kitchen = await actors.defaultUser('kitchen');
    courier = await actors.defaultUser('courier');
    clientA = await actors.newClient('Cliente A');
    clientB = await actors.newClient('Cliente B');
    product = await createProduct(admin.ctx, { name: `Acesso ${uid('ac')}`, price: 18 });

    const address = await createAddress(clientA.ctx, 'Flamengo');
    a1 = await placeOrder(clientA.ctx, {
      items: [{ productId: product.id, quantity: 1 }],
      type: 'DELIVERY',
      addressId: address.id,
      paymentMethod: 'MONEY',
    });
    await sleep(50); // created_at distinto para a ordenação
    a2 = await placeOrder(clientA.ctx, {
      items: [{ productId: product.id, quantity: 2 }],
      type: 'TAKEOUT',
      paymentMethod: 'CREDIT_CARD',
    });
    b1 = await placeOrder(clientB.ctx, {
      items: [{ productId: product.id, quantity: 3 }],
      type: 'TAKEOUT',
      paymentMethod: 'MONEY',
    });
  });

  test.afterAll(async () => {
    await actors.dispose();
  });

  test('GET /orders/my-orders lista apenas os pedidos do cliente, do mais novo para o mais antigo', async () => {
    const mine = await myOrders(clientA.ctx);
    expect(mine.map((o) => o.id)).toEqual([a2.id, a1.id]);
    for (const order of mine) expect(order.user?.id).toBe(clientA.id);
    const times = mine.map((o) => new Date(o.created_at).getTime());
    expect([...times].sort((x, y) => y - x)).toEqual(times);

    const theirs = await myOrders(clientB.ctx);
    expect(theirs.map((o) => o.id)).toEqual([b1.id]);
  });

  test('my-orders traz itens, o retrato do endereço de entrega e a loja de cada pedido', async () => {
    const store = await demoStore();
    const mine = await myOrders(clientA.ctx);
    const delivery = mine.find((o) => o.id === a1.id);
    expect(delivery.items).toHaveLength(1);
    expect(delivery.items[0].product?.id).toBe(product.id);
    // Com o retrato (delivery_address), o endereço vivo do cadastro do cliente (address) fica de fora
    expect(delivery.address).toBeNull();
    expect(delivery.delivery_address?.neighborhood).toBe('Flamengo');
    const takeout = mine.find((o) => o.id === a2.id);
    expect(takeout.address).toBeNull();
    expect(takeout.delivery_address).toBeNull();
    expect(takeout.items[0].quantity).toBe(2);
    // Cliente compra em várias lojas: cada pedido traz o resumo da loja (nunca a loja inteira)
    for (const order of mine) {
      expect(order.store, `loja do pedido #${order.id}`).toEqual({ id: store.id, slug: store.slug, name: store.name, logo: store.logo ?? null });
      expect(order.store_id).toBe(store.id);
    }
  });

  test('GET /stores/<slug>/orders/my-orders lista só os pedidos daquela loja; loja inexistente → 404', async () => {
    const mine = await clientA.ctx.get(`/stores/${E2E.demoStoreSlug}/orders/my-orders`);
    await expectStatus(mine, 200);
    expect((await mine.json()).map((o: Json) => o.id)).toEqual([a2.id, a1.id]);
    await expectNestError(await clientA.ctx.get('/stores/loja-que-nao-existe-e2e/orders/my-orders'), 404);
  });

  test('cliente sem pedidos recebe lista vazia em my-orders', async () => {
    const fresh = await actors.newClient('Sem Pedidos');
    expect(await myOrders(fresh.ctx)).toEqual([]);
  });

  test('my-orders da equipe traz só os próprios pedidos (nunca os dos clientes)', async () => {
    for (const actor of [admin, employee, kitchen, courier]) {
      const mine = await myOrders(actor.ctx);
      expect(mine.every((o) => o.user?.id === actor.id), actor.session.user.role).toBe(true);
      expect(mine.some((o) => [a1.id, a2.id, b1.id].includes(o.id))).toBe(false);
    }
  });

  test('my-orders exige autenticação (401)', async () => {
    await expectStatus(await anon.get('/orders/my-orders'), 401);
    const bad = await actors.anon();
    await expectStatus(await bad.get('/orders/my-orders', { headers: { Authorization: 'Bearer token-invalido' } }), 401);
  });

  test('dono vê o próprio pedido em GET /orders/:id', async () => {
    const order = await getOrder(clientA.ctx, a1.id);
    expect(order).toMatchObject({ id: a1.id, status: 'PENDING', type: 'DELIVERY' });
    expect(order.user?.id).toBe(clientA.id);
    expect(order.items[0].product?.id).toBe(product.id);
  });

  test('outro cliente recebe 404 ao abrir pedido alheio (o mesmo de um pedido inexistente)', async () => {
    const missing = await clientA.ctx.get(`/orders/${UNKNOWN_ID}`);
    await expectNestError(missing, 404);
    const missingMessage = (await missing.json()).message;
    for (const res of [await clientB.ctx.get(`/orders/${a1.id}`), await clientA.ctx.get(`/orders/${b1.id}`)]) {
      await expectNestError(res, 404);
      expect((await res.json()).message, 'não confirma que o pedido existe').toBe(missingMessage);
    }
    await expectNestError(await clientB.ctx.get(`/stores/${E2E.demoStoreSlug}/orders/${a1.id}`), 404);
  });

  test('conta da plataforma (superadmin) não lê pedidos pelas rotas da loja: lista 403 e pedido de cliente 404', async () => {
    const superadmin = await actors.defaultUser('superadmin');
    await expectNestError(await superadmin.ctx.get('/orders'), 403);
    await expectNestError(await superadmin.ctx.get(`/orders/${a1.id}`), 404);
  });

  test('gestão (ADMIN, EMPLOYEE) vê qualquer pedido da própria loja, com o contato completo do cliente', async () => {
    for (const actor of [admin, employee]) {
      const order = await getOrder(actor.ctx, a1.id);
      expect(order.id, actor.session.user.role).toBe(a1.id);
      expect(order.user).toMatchObject({ id: clientA.id, email: clientA.session.user.email });
      expect(order.delivery_address?.neighborhood).toBe('Flamengo');
    }
  });

  test('cozinha: só pedidos aguardando preparo ou em preparo, sem contato, endereço e pagamento do cliente', async () => {
    const order = await getOrder(kitchen.ctx, a1.id);
    expect(order).toMatchObject({ id: a1.id, status: 'PENDING', type: 'DELIVERY' });
    expect(order.user, 'cozinha vê só o nome do cliente').toEqual({ id: clientA.id, name: clientA.session.user.name });
    expect(order).toMatchObject({ delivery_address: null, address: null, change_for: null, payment_id: null });
    expect(order.items[0].product?.id).toBe(product.id);

    for (const path of ['/orders', '/orders?scope=active']) {
      const res = await kitchen.ctx.get(path);
      await expectStatus(res, 200);
      const list: Json[] = await res.json();
      expect(list.map((o) => o.id), path).toEqual(expect.arrayContaining([a1.id, a2.id, b1.id]));
      expect(list.every((o) => ['PENDING', 'PREPARING'].includes(o.status)), `${path}: só a etapa da cozinha`).toBe(true);
      expect(JSON.stringify(list), `${path}: sem e-mail, telefone e endereço dos clientes`).not.toMatch(
        /"email"|"phone"|"street"/,
      );
    }

    // Pedido pronto saiu da etapa da cozinha: 404 uniforme (igual a um id inexistente)
    const ready = await placeOrder(clientB.ctx, {
      items: [{ productId: product.id, quantity: 1 }],
      type: 'TAKEOUT',
      paymentMethod: 'MONEY',
    });
    const preparing = await advance(kitchen.ctx, ready.id, 'PREPARING');
    expect(preparing.user, 'resposta do PATCH no formato da cozinha').toEqual({ id: clientB.id, name: clientB.session.user.name });
    await advance(kitchen.ctx, ready.id, 'READY_FOR_PICKUP');
    await expectNestError(await kitchen.ctx.get(`/orders/${ready.id}`), 404, 'Pedido não encontrado.');
    const board: Json[] = await (await kitchen.ctx.get('/orders?scope=active')).json();
    expect(board.some((o) => o.id === ready.id), 'pronto sai do quadro da cozinha').toBe(false);
    await expectStatus(await admin.ctx.patch(`/orders/${ready.id}/cancel`), 200);
  });

  test('entregador: só entregas prontas sem entregador e as próprias; nunca e-mail do cliente nem pedidos de outra etapa', async () => {
    const me = courier.id;
    // Pedidos pendentes (a1 é entrega; a2 e b1, retirada): fora da etapa do entregador → 404 uniforme
    for (const id of [a1.id, a2.id, b1.id]) {
      await expectNestError(await courier.ctx.get(`/orders/${id}`), 404, 'Pedido não encontrado.');
    }

    const address = await createAddress(clientB.ctx, 'Flamengo');
    const delivery = await placeOrder(clientB.ctx, {
      items: [{ productId: product.id, quantity: 1 }],
      type: 'DELIVERY',
      addressId: address.id,
      paymentMethod: 'MONEY',
      changeFor: 'R$ 100,00',
    });
    const orphan = await placeOrder(clientB.ctx, {
      items: [{ productId: product.id, quantity: 1 }],
      type: 'DELIVERY',
      addressId: address.id,
      paymentMethod: 'MONEY',
    });
    await advance(admin.ctx, delivery.id, 'PREPARING', 'READY_FOR_PICKUP');
    // Em entrega sem entregador (a gestão moveu): de ninguém, então não aparece para o entregador
    await advance(admin.ctx, orphan.id, 'PREPARING', 'READY_FOR_PICKUP', 'DELIVERING');

    // Pronta e sem entregador: visível, com nome, telefone, endereço, total e troco (sem e-mail)
    const ready = await getOrder(courier.ctx, delivery.id);
    expect(ready.user).toMatchObject({ id: clientB.id, name: clientB.session.user.name });
    expect(Object.keys(ready.user).sort(), 'cliente para o entregador: nome e telefone').toEqual(['id', 'name', 'phone']);
    expect(ready).toMatchObject({ status: 'READY_FOR_PICKUP', change_for: 'R$ 100,00', delivery_address: { neighborhood: 'Flamengo' } });
    expect(JSON.stringify(ready)).not.toContain(clientB.session.user.email);
    await expectNestError(await courier.ctx.get(`/orders/${orphan.id}`), 404, 'Pedido não encontrado.');

    const visibleTo = (o: Json) =>
      (o.status === 'READY_FOR_PICKUP' && o.type === 'DELIVERY' && (!o.driver || o.driver.id === me)) ||
      (o.driver?.id === me && ['READY_FOR_PICKUP', 'DELIVERING', 'DONE', 'CANCELED'].includes(o.status));
    for (const path of ['/orders', '/orders?scope=active']) {
      const list: Json[] = await (await courier.ctx.get(path)).json();
      expect(list.some((o) => o.id === delivery.id), `${path}: entrega pronta`).toBe(true);
      expect(list.some((o) => [a1.id, a2.id, b1.id, orphan.id].includes(o.id)), `${path}: fora da etapa`).toBe(false);
      expect(list.every(visibleTo), `${path}: só entregas prontas e as próprias`).toBe(true);
      expect(JSON.stringify(list), `${path}: nunca o e-mail dos clientes`).not.toMatch(/"email"/);
    }

    // Assume, conclui e continua vendo a própria entrega (recente)
    const taken = await advance(courier.ctx, delivery.id, 'DELIVERING');
    expect(taken.driver).toEqual({ id: me, name: courier.session.user.name });
    await advance(courier.ctx, delivery.id, 'DONE');
    expect((await getOrder(courier.ctx, delivery.id)).status).toBe('DONE');
    await expectStatus(await admin.ctx.patch(`/orders/${orphan.id}/cancel`), 200);
  });

  test('pedido inexistente responde 404 e id inválido responde 400', async () => {
    await expectNestError(await admin.ctx.get(`/orders/${UNKNOWN_ID}`), 404);
    await expectNestError(await clientA.ctx.get(`/orders/${UNKNOWN_ID}`), 404);
    await expectNestError(await admin.ctx.get('/orders/abc'), 400);
  });

  test('GET /orders/:id exige autenticação (401)', async () => {
    await expectStatus(await anon.get(`/orders/${a1.id}`), 401);
  });

  test('GET /orders é exclusivo da equipe: CLIENT 403 e anônimo 401', async () => {
    await expectNestError(await clientA.ctx.get('/orders'), 403);
    await expectStatus(await anon.get('/orders'), 401);
  });

  test('GET /orders lista os pedidos de todos os clientes da loja para a gestão e a cozinha (só a loja da equipe)', async () => {
    const store = await demoStore();
    for (const actor of [admin, employee, kitchen]) {
      const res = await actor.ctx.get('/orders');
      await expectStatus(res, 200);
      const list: Json[] = await res.json();
      const listed = list.map((o) => o.id);
      expect(listed, actor.session.user.role).toEqual(expect.arrayContaining([a1.id, a2.id, b1.id]));
      // Mais novos primeiro
      expect(listed.indexOf(b1.id)).toBeLessThan(listed.indexOf(a1.id));
      expect(list.every((o) => o.store_id === store.id), 'só pedidos da loja da equipe').toBe(true);
      expect(list.some((o) => o.store !== undefined), 'a relação "store" nunca sai inteira nas listas da equipe').toBe(false);
    }
  });

  test('listas em páginas: ?page=&pageSize= (até 100), mais recentes primeiro, sempre no formato de lista', async () => {
    const list = async (ctx: APIRequestContext, path: string): Promise<number[]> => {
      const res = await ctx.get(path);
      await expectStatus(res, 200);
      const data = await res.json();
      expect(Array.isArray(data), path).toBe(true);
      return data.map((o: Json) => o.id);
    };
    const top3 = await list(admin.ctx, '/orders?pageSize=3');
    expect(top3).toHaveLength(3);
    expect(await list(admin.ctx, '/orders?page=2&pageSize=1')).toEqual([top3[1]]);
    expect((await list(admin.ctx, '/orders')).length).toBeLessThanOrEqual(100);

    expect(await list(clientA.ctx, '/orders/my-orders?pageSize=1')).toEqual([a2.id]);
    expect(await list(clientA.ctx, '/orders/my-orders?page=2&pageSize=1')).toEqual([a1.id]);
    expect(await list(clientA.ctx, '/orders/my-orders?page=3&pageSize=1')).toEqual([]);
    expect(await list(clientA.ctx, `/stores/${E2E.demoStoreSlug}/orders/my-orders?pageSize=1`)).toEqual([a2.id]);

    for (const query of ['pageSize=101', 'pageSize=0', 'page=0', 'page=abc', 'page=1.5', 'page=1&page=2']) {
      await expectNestError(await admin.ctx.get(`/orders?${query}`), 400, 'Paginação inválida');
      await expectNestError(await clientA.ctx.get(`/orders/my-orders?${query}`), 400, 'Paginação inválida');
    }
  });

  test('respostas de pedidos nunca expõem senha (user e driver)', async () => {
    expectNoPasswordFields(await myOrders(clientA.ctx));
    expectNoPasswordFields(await getOrder(admin.ctx, a1.id));
    const all = await (await admin.ctx.get('/orders')).json();
    expectNoPasswordFields(all);
    const order = all.find((o: Json) => o.id === a1.id);
    expect(order.user).toMatchObject({ id: clientA.id, name: clientA.session.user.name });
  });
});
