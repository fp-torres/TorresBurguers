import { test, expect, type APIRequestContext } from '@playwright/test';
import { uid } from '../../../support/api';
import {
  Actors,
  UNKNOWN_ID,
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

  test('my-orders traz itens e endereço de cada pedido', async () => {
    const mine = await myOrders(clientA.ctx);
    const delivery = mine.find((o) => o.id === a1.id);
    expect(delivery.items).toHaveLength(1);
    expect(delivery.items[0].product?.id).toBe(product.id);
    expect(delivery.address?.neighborhood).toBe('Flamengo');
    const takeout = mine.find((o) => o.id === a2.id);
    expect(takeout.address).toBeNull();
    expect(takeout.items[0].quantity).toBe(2);
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

  test('outro cliente recebe 403 ao abrir pedido alheio', async () => {
    await expectNestError(await clientB.ctx.get(`/orders/${a1.id}`), 403);
    await expectNestError(await clientA.ctx.get(`/orders/${b1.id}`), 403);
  });

  test('equipe (ADMIN, EMPLOYEE, KITCHEN, COURIER) vê qualquer pedido', async () => {
    for (const actor of [admin, employee, kitchen, courier]) {
      const order = await getOrder(actor.ctx, a1.id);
      expect(order.id, actor.session.user.role).toBe(a1.id);
      expect(order.user?.id).toBe(clientA.id);
    }
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

  test('GET /orders lista os pedidos de todos os clientes para cada perfil da equipe', async () => {
    for (const actor of [admin, employee, kitchen, courier]) {
      const res = await actor.ctx.get('/orders');
      await expectStatus(res, 200);
      const list: Json[] = await res.json();
      const listed = list.map((o) => o.id);
      expect(listed, actor.session.user.role).toEqual(expect.arrayContaining([a1.id, a2.id, b1.id]));
      // Mais novos primeiro
      expect(listed.indexOf(b1.id)).toBeLessThan(listed.indexOf(a1.id));
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
