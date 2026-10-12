import { test, expect } from '@playwright/test';
import {
  MISSING_ID,
  bearer,
  cancelOrderAsAdmin,
  cleanupTrackedStaff,
  createAddress,
  createOrder,
  createProduct,
  expectError,
  expectNoSecrets,
  newApi,
  newClient,
  newUserWithRole,
  retireProduct,
  sessionOf,
  signupPayload,
  type Product,
} from './helpers';

let product: Product;
const createdOrders: number[] = [];

test.beforeAll(async () => {
  const api = await newApi();
  product = await createProduct(api);
  await api.dispose();
});

test.afterAll(async () => {
  const api = await newApi();
  for (const id of createdOrders) await cancelOrderAsAdmin(api, id);
  if (product) await retireProduct(api, product.id);
  await api.dispose();
  await cleanupTrackedStaff();
});

const NON_ADMIN = ['client', 'employee', 'kitchen', 'courier'] as const;

test.describe('Lixeira de usuários (GET /users/trash) — somente ADMIN', () => {
  test('ADMIN vê na lixeira apenas as contas excluídas, sem senha', async ({ request }) => {
    const [active, deleted] = [await newClient(request), await newClient(request)];
    const admin = await sessionOf(request, 'admin');
    expect((await request.delete(`/users/${deleted.user.id}`, { headers: bearer(admin.token) })).ok()).toBeTruthy();

    const res = await request.get('/users/trash', { headers: bearer(admin.token) });
    expect(res.status()).toBe(200);
    const trash = await res.json();
    const ids = trash.map((u: { id: number }) => u.id);
    expect(ids).toContain(deleted.user.id);
    expect(ids).not.toContain(active.user.id);
    expect(trash.find((u: { id: number }) => u.id === deleted.user.id).deleted_at).toBeTruthy();
    expectNoSecrets(trash, 'GET /users/trash');
  });

  for (const key of NON_ADMIN) {
    test(`perfil ${key} não acessa a lixeira de usuários (403)`, async ({ request }) => {
      const session = await sessionOf(request, key);
      await expectError(await request.get('/users/trash', { headers: bearer(session.token) }), 403);
    });
  }
});

test.describe('Restauração (PATCH /users/:id/restore) — somente ADMIN', () => {
  test('ADMIN restaura a conta: volta à lista, sai da lixeira e o login funciona', async ({ request }) => {
    const client = await newClient(request);
    const admin = await sessionOf(request, 'admin');
    expect((await request.delete(`/users/${client.user.id}`, { headers: bearer(admin.token) })).ok()).toBeTruthy();

    const res = await request.patch(`/users/${client.user.id}/restore`, { headers: bearer(admin.token) });
    expect(res.status(), await res.text()).toBe(200);
    const restored = await res.json();
    expect(restored).toMatchObject({ id: client.user.id, email: client.email, role: 'CLIENT' });
    expect(restored.deleted_at ?? null).toBeNull();
    expectNoSecrets(restored, 'PATCH /users/:id/restore');

    const active = await (await request.get('/users', { headers: bearer(admin.token) })).json();
    expect(active.map((u: { id: number }) => u.id)).toContain(client.user.id);
    const trash = await (await request.get('/users/trash', { headers: bearer(admin.token) })).json();
    expect(trash.map((u: { id: number }) => u.id)).not.toContain(client.user.id);
    expect((await request.post('/auth/login', { data: { email: client.email, password: client.password } })).ok()).toBeTruthy();
  });

  test('perfis não-admin não restauram contas (403) e a conta segue na lixeira', async ({ request }) => {
    const client = await newClient(request);
    const admin = await sessionOf(request, 'admin');
    expect((await request.delete(`/users/${client.user.id}`, { headers: bearer(admin.token) })).ok()).toBeTruthy();

    for (const key of NON_ADMIN) {
      const session = await sessionOf(request, key);
      const res = await request.patch(`/users/${client.user.id}/restore`, { headers: bearer(session.token) });
      expect(res.status(), `${key} restaurando: ${await res.text()}`).toBe(403);
    }
    const trash = await (await request.get('/users/trash', { headers: bearer(admin.token) })).json();
    expect(trash.map((u: { id: number }) => u.id)).toContain(client.user.id);
  });

  test('restaurar id inexistente → 404', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    await expectError(await request.patch(`/users/${MISSING_ID}/restore`, { headers: bearer(admin.token) }), 404);
  });
});

test.describe('Exclusão definitiva (DELETE /users/:id/permanent) — somente ADMIN', () => {
  test('conta sem pedidos é apagada de vez: some da lixeira, não pode ser restaurada e o e-mail fica livre', async ({ request }) => {
    const client = await newClient(request);
    const admin = await sessionOf(request, 'admin');
    expect((await request.delete(`/users/${client.user.id}`, { headers: bearer(admin.token) })).ok()).toBeTruthy();

    const res = await request.delete(`/users/${client.user.id}/permanent`, { headers: bearer(admin.token) });
    expect(res.status(), await res.text()).toBe(200);

    const trash = await (await request.get('/users/trash', { headers: bearer(admin.token) })).json();
    expect(trash.map((u: { id: number }) => u.id)).not.toContain(client.user.id);
    await expectError(await request.get(`/users/${client.user.id}`, { headers: bearer(admin.token) }), 404);
    await expectError(await request.patch(`/users/${client.user.id}/restore`, { headers: bearer(admin.token) }), 404);

    const again = await request.post('/users', { data: signupPayload({ email: client.email }) });
    expect(again.status(), await again.text()).toBe(201);
  });

  test('token de uma conta apagada definitivamente → 401', async ({ request }) => {
    const client = await newClient(request);
    const admin = await sessionOf(request, 'admin');
    const res = await request.delete(`/users/${client.user.id}/permanent`, { headers: bearer(admin.token) });
    expect(res.status(), await res.text()).toBe(200);
    await expectError(await request.get('/addresses', { headers: bearer(client.token) }), 401);
    await expectError(await request.post('/auth/login', { data: { email: client.email, password: client.password } }), 401);
  });

  test('conta com endereços (sem pedidos) também é apagada de vez', async ({ request }) => {
    const client = await newClient(request);
    await createAddress(request, client.token);
    const admin = await sessionOf(request, 'admin');
    expect((await request.delete(`/users/${client.user.id}`, { headers: bearer(admin.token) })).ok()).toBeTruthy();

    const res = await request.delete(`/users/${client.user.id}/permanent`, { headers: bearer(admin.token) });
    expect(res.status(), await res.text()).toBe(200);
  });

  test('conta com pedidos → 409 com o motivo, continua na lixeira e o pedido mantém o cliente', async ({ request }) => {
    const client = await newClient(request);
    const order = await createOrder(request, client.token, {
      items: [{ productId: product.id, quantity: 1 }],
      type: 'TAKEOUT',
      paymentMethod: 'MONEY',
    });
    createdOrders.push(order.id);
    const admin = await sessionOf(request, 'admin');
    expect((await request.delete(`/users/${client.user.id}`, { headers: bearer(admin.token) })).ok()).toBeTruthy();

    const res = await request.delete(`/users/${client.user.id}/permanent`, { headers: bearer(admin.token) });
    await expectError(res, 409, /pedido/i);

    const trash = await (await request.get('/users/trash', { headers: bearer(admin.token) })).json();
    expect(trash.map((u: { id: number }) => u.id)).toContain(client.user.id);
    const stored = await (await request.get(`/orders/${order.id}`, { headers: bearer(admin.token) })).json();
    expect(stored.user).toMatchObject({ id: client.user.id, email: client.email });
  });

  test('entregador vinculado a uma entrega → 409', async ({ request }) => {
    const courier = await newUserWithRole(request, 'COURIER');
    const client = await newClient(request);
    const address = await createAddress(request, client.token, { neighborhood: 'Centro' });
    const order = await createOrder(request, client.token, {
      items: [{ productId: product.id, quantity: 1 }],
      type: 'DELIVERY',
      addressId: address.id,
      paymentMethod: 'MONEY',
    });
    createdOrders.push(order.id);

    const admin = await sessionOf(request, 'admin');
    const preparing = await request.patch(`/orders/${order.id}`, { headers: bearer(admin.token), data: { status: 'PREPARING' } });
    expect(preparing.ok(), await preparing.text()).toBeTruthy();
    const assign = await request.patch(`/orders/${order.id}/assign`, {
      headers: bearer(admin.token),
      data: { driverId: courier.user.id },
    });
    expect(assign.ok(), await assign.text()).toBeTruthy();

    const res = await request.delete(`/users/${courier.user.id}/permanent`, { headers: bearer(admin.token) });
    await expectError(res, 409);
    expect((await request.get(`/users/${courier.user.id}`, { headers: bearer(admin.token) })).status()).toBe(200);
  });

  test('perfis não-admin não usam a exclusão definitiva (403), nem na própria conta', async ({ request }) => {
    const target = await newClient(request);
    for (const key of NON_ADMIN) {
      const session = await sessionOf(request, key);
      const res = await request.delete(`/users/${target.user.id}/permanent`, { headers: bearer(session.token) });
      expect(res.status(), `${key}: ${await res.text()}`).toBe(403);
    }
    const self = await request.delete(`/users/${target.user.id}/permanent`, { headers: bearer(target.token) });
    await expectError(self, 403);
    expect((await request.get(`/users/${target.user.id}`, { headers: bearer(target.token) })).status()).toBe(200);
  });

  test('ADMIN não apaga definitivamente a própria conta (400)', async ({ request }) => {
    const tempAdmin = await newUserWithRole(request, 'ADMIN');
    await expectError(
      await request.delete(`/users/${tempAdmin.user.id}/permanent`, { headers: bearer(tempAdmin.token) }),
      400,
    );
    expect((await request.get('/users', { headers: bearer(tempAdmin.token) })).status()).toBe(200);
  });

  test('id inexistente → 404', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    await expectError(await request.delete(`/users/${MISSING_ID}/permanent`, { headers: bearer(admin.token) }), 404);
  });
});
