import { test, expect, type APIResponse } from '@playwright/test';
import { DEFAULT_USERS, type DefaultUserKey } from '../../../support/users';
import {
  STRONG_PASSWORD,
  bearer,
  cancelOrderAsAdmin,
  cleanupTrackedStaff,
  createAddress,
  createOrder,
  createProduct,
  findSecretKeys,
  makePng,
  newApi,
  newClient,
  newUserWithRole,
  pngFile,
  retireProduct,
  sessionOf,
  signupPayload,
  trackStaff,
  uniqueEmail,
  type Product,
  type TestUser,
} from './helpers';

/** Hash bcrypt em qualquer valor do corpo (mesmo que a chave tenha outro nome). */
const BCRYPT_HASH = /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{20,}/;

async function expectClean(res: APIResponse, label: string): Promise<any> {
  const text = await res.text();
  expect(res.ok(), `${label}: ${res.status()} ${text.slice(0, 300)}`).toBeTruthy();
  expect(text, `${label}: nenhum hash bcrypt pode aparecer`).not.toMatch(BCRYPT_HASH);
  const payload = JSON.parse(text);
  expect(findSecretKeys(payload), `${label}: chaves de senha/hash`).toEqual([]);
  return payload;
}

let product: Product;
let client: TestUser;
let courier: TestUser;
let deliveryOrderId: number;
let readyOrderId: number;
const captured: Array<[string, unknown]> = [];
const createdOrders: number[] = [];

test.beforeAll(async () => {
  const api = await newApi();
  const admin = await sessionOf(api, 'admin');
  product = await createProduct(api);
  client = await newClient(api);
  courier = await newUserWithRole(api, 'COURIER');
  const address = await createAddress(api, client.token, { neighborhood: 'Laranjeiras' });

  const delivery = await createOrder(api, client.token, {
    items: [{ productId: product.id, quantity: 2 }],
    type: 'DELIVERY',
    addressId: address.id,
    paymentMethod: 'MONEY',
  });
  deliveryOrderId = delivery.id;
  createdOrders.push(delivery.id);
  captured.push(['POST /orders', delivery]);

  const preparing = await api.patch(`/orders/${delivery.id}`, { headers: bearer(admin.token), data: { status: 'PREPARING' } });
  expect(preparing.ok(), await preparing.text()).toBeTruthy();
  captured.push(['PATCH /orders/:id (status)', await preparing.json()]);

  const assign = await api.patch(`/orders/${delivery.id}/assign`, {
    headers: bearer(admin.token),
    data: { driverId: courier.user.id },
  });
  expect(assign.ok(), await assign.text()).toBeTruthy();
  const assigned = await assign.json();
  expect(assigned.driver?.id, 'pedido com entregador atribuído').toBe(courier.user.id);
  captured.push(['PATCH /orders/:id/assign', assigned]);

  // Segundo pedido pronto, sem entregador, no mesmo bairro (aparece em /nearby)
  const ready = await createOrder(api, client.token, {
    items: [{ productId: product.id, quantity: 1 }],
    type: 'DELIVERY',
    addressId: address.id,
    paymentMethod: 'CREDIT_CARD', // maquininha na entrega
  });
  readyOrderId = ready.id;
  createdOrders.push(ready.id);
  for (const status of ['PREPARING', 'READY_FOR_PICKUP']) {
    const moved = await api.patch(`/orders/${ready.id}`, { headers: bearer(admin.token), data: { status } });
    expect(moved.ok(), await moved.text()).toBeTruthy();
  }

  // Pedido cancelado pelo dono (resposta do cancelamento também é verificada)
  const toCancel = await createOrder(api, client.token, {
    items: [{ productId: product.id, quantity: 1 }],
    type: 'TAKEOUT',
    paymentMethod: 'MONEY',
  });
  const canceled = await api.patch(`/orders/${toCancel.id}/cancel`, { headers: bearer(client.token) });
  expect(canceled.ok(), await canceled.text()).toBeTruthy();
  captured.push(['PATCH /orders/:id/cancel', await canceled.json()]);

  await api.dispose();
});

test.afterAll(async () => {
  const api = await newApi();
  for (const id of createdOrders) await cancelOrderAsAdmin(api, id);
  if (product) await retireProduct(api, product.id);
  await api.dispose();
  await cleanupTrackedStaff();
});

test.describe('password_hash/senha nunca aparecem nas respostas com usuários', () => {
  test('login de todos os perfis e de contas novas', async ({ request }) => {
    for (const key of Object.keys(DEFAULT_USERS) as DefaultUserKey[]) {
      const { email, password } = DEFAULT_USERS[key];
      await expectClean(await request.post('/auth/login', { data: { email, password } }), `login ${key}`);
    }
    for (const user of [client, courier]) {
      await expectClean(
        await request.post('/auth/login', { data: { email: user.email, password: user.password } }),
        `login ${user.email}`,
      );
    }
  });

  test('cadastro público (JSON e multipart) e cadastro de equipe pelo ADMIN', async ({ request }) => {
    await expectClean(await request.post('/users', { data: signupPayload() }), 'POST /users JSON');
    await expectClean(
      await request.post('/users', {
        multipart: { name: 'Multipart', email: uniqueEmail('hyg'), password: STRONG_PASSWORD, file: pngFile(makePng(8, 8)) },
      }),
      'POST /users multipart',
    );
    const admin = await sessionOf(request, 'admin');
    const kitchen = await expectClean(
      await request.post('/users', { headers: bearer(admin.token), data: signupPayload({ role: 'KITCHEN' }) }),
      'POST /users (ADMIN cria KITCHEN)',
    );
    trackStaff(kitchen.id);
  });

  test('GET /users (todos os usuários)', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    const users = await expectClean(await request.get('/users', { headers: bearer(admin.token) }), 'GET /users');
    expect(users.length).toBeGreaterThan(5);
  });

  test('GET /users/:id (próprio usuário e ADMIN)', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    await expectClean(await request.get(`/users/${client.user.id}`, { headers: bearer(client.token) }), 'GET /users/:id próprio');
    await expectClean(await request.get(`/users/${client.user.id}`, { headers: bearer(admin.token) }), 'GET /users/:id ADMIN');
    await expectClean(await request.get(`/users/${admin.user.id}`, { headers: bearer(admin.token) }), 'GET /users/:id do ADMIN');
  });

  test('PATCH /users/:id (JSON, troca de senha e multipart)', async ({ request }) => {
    const user = await newClient(request);
    await expectClean(
      await request.patch(`/users/${user.user.id}`, { headers: bearer(user.token), data: { name: 'Higiene' } }),
      'PATCH JSON',
    );
    await expectClean(
      await request.patch(`/users/${user.user.id}`, { headers: bearer(user.token), data: { password: 'OutraSenha#99' } }),
      'PATCH senha',
    );
    await expectClean(
      await request.patch(`/users/${user.user.id}`, { headers: bearer(user.token), multipart: { file: pngFile(makePng(8, 8)) } }),
      'PATCH multipart',
    );
    const admin = await sessionOf(request, 'admin');
    await expectClean(
      await request.patch(`/users/${user.user.id}`, { headers: bearer(admin.token), data: { role: 'EMPLOYEE' } }),
      'PATCH perfil (ADMIN)',
    );
    trackStaff(user.user.id);
  });

  test('GET /users/trash e PATCH /users/:id/restore', async ({ request }) => {
    const user = await newClient(request);
    const admin = await sessionOf(request, 'admin');
    expect((await request.delete(`/users/${user.user.id}`, { headers: bearer(admin.token) })).ok()).toBeTruthy();
    await expectClean(await request.get('/users/trash', { headers: bearer(admin.token) }), 'GET /users/trash');
    await expectClean(
      await request.patch(`/users/${user.user.id}/restore`, { headers: bearer(admin.token) }),
      'PATCH /users/:id/restore',
    );
  });

  for (const key of ['admin', 'employee', 'kitchen', 'courier'] as const) {
    test(`GET /orders como ${DEFAULT_USERS[key].role}: user/driver de todos os pedidos sem senha`, async ({ request }) => {
      const session = await sessionOf(request, key);
      const orders = await expectClean(await request.get('/orders', { headers: bearer(session.token) }), `GET /orders (${key})`);
      const mine = orders.find((o: { id: number }) => o.id === deliveryOrderId);
      expect(mine, 'pedido de entrega criado no beforeAll aparece na lista').toBeTruthy();
      expect(mine.user).toMatchObject({ id: client.user.id, name: client.user.name });
      expect(mine.driver).toMatchObject({ id: courier.user.id });
    });
  }

  test('GET /orders/:id para o dono, o ADMIN, o atendente e o entregador', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    const employee = await sessionOf(request, 'employee');
    for (const [label, token] of [
      ['dono', client.token],
      ['ADMIN', admin.token],
      ['EMPLOYEE', employee.token],
      ['entregador', courier.token],
    ] as const) {
      const order = await expectClean(
        await request.get(`/orders/${deliveryOrderId}`, { headers: bearer(token) }),
        `GET /orders/:id (${label})`,
      );
      expect(order.user?.id).toBe(client.user.id);
      expect(order.driver?.id).toBe(courier.user.id);
    }
  });

  test('GET /orders/my-orders do cliente', async ({ request }) => {
    const orders = await expectClean(await request.get('/orders/my-orders', { headers: bearer(client.token) }), 'GET /orders/my-orders');
    expect(orders.map((o: { id: number }) => o.id)).toEqual(expect.arrayContaining([deliveryOrderId, readyOrderId]));
  });

  test('respostas de criação, mudança de status, atribuição e cancelamento de pedido', async () => {
    expect(captured.map(([label]) => label)).toEqual([
      'POST /orders',
      'PATCH /orders/:id (status)',
      'PATCH /orders/:id/assign',
      'PATCH /orders/:id/cancel',
    ]);
    for (const [label, payload] of captured) {
      expect(findSecretKeys(payload), label).toEqual([]);
      expect(JSON.stringify(payload), label).not.toMatch(BCRYPT_HASH);
    }
  });

  test('GET /orders/drivers/list e GET /orders/:id/nearby', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    const drivers = await expectClean(await request.get('/orders/drivers/list', { headers: bearer(admin.token) }), 'drivers/list');
    expect(drivers.map((d: { id: number }) => d.id)).toContain(courier.user.id);

    const nearby = await expectClean(
      await request.get(`/orders/${deliveryOrderId}/nearby`, { headers: bearer(admin.token) }),
      'GET /orders/:id/nearby',
    );
    const ready = nearby.find((o: { id: number }) => o.id === readyOrderId);
    expect(ready, 'pedido pronto do mesmo bairro aparece em /nearby').toBeTruthy();
    expect(ready.user?.id).toBe(client.user.id);
  });
});
