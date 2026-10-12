import { test, expect } from '@playwright/test';
import {
  ADDRESS,
  MISSING_ID,
  OUT_OF_RANGE_ID,
  bearer,
  body,
  cancelOrderAsAdmin,
  createAddress,
  createOrder,
  createProduct,
  expectError,
  expectNoSecrets,
  newApi,
  newClient,
  retireProduct,
  sessionOf,
  type Product,
} from './helpers';

let product: Product;
const createdOrders: number[] = [];

test.beforeAll(async () => {
  const api = await newApi();
  product = await createProduct(api, { price: 20 });
  await api.dispose();
});

test.afterAll(async () => {
  const api = await newApi();
  for (const id of createdOrders) await cancelOrderAsAdmin(api, id);
  if (product) await retireProduct(api, product.id);
  await api.dispose();
});

test.describe('Endereços do próprio usuário (CRUD)', () => {
  test('cadastra endereço com CEP só em dígitos, UF em maiúsculas e textos aparados', async ({ request }) => {
    const client = await newClient(request);
    const res = await request.post('/addresses', {
      headers: bearer(client.token),
      data: { ...ADDRESS, zipCode: '22041-001', state: ' rj ', street: '  Avenida Atlântica  ', city: ' Rio de Janeiro ' },
    });
    expect(res.status(), await res.text()).toBe(201);
    const address = await res.json();
    expect(address).toMatchObject({
      zipCode: '22041001',
      state: 'RJ',
      street: 'Avenida Atlântica',
      number: '1500',
      complement: 'Apto 202',
      neighborhood: 'Copacabana',
      city: 'Rio de Janeiro',
      nickname: 'Casa',
    });
    expect(typeof address.id).toBe('number');
    expect(address.deleted_at, 'coluna interna de exclusão não aparece').toBeUndefined();
    expectNoSecrets(address, 'POST /addresses');
  });

  test('número numérico e "S/N" são aceitos; opcionais podem ficar de fora', async ({ request }) => {
    const client = await newClient(request);
    const numeric = await createAddress(request, client.token, { number: 1500 });
    expect(numeric.number).toBe('1500');

    const minimal = await request.post('/addresses', {
      headers: bearer(client.token),
      data: { zipCode: '01001000', street: 'Praça da Sé', number: 'S/N', neighborhood: 'Sé', city: 'São Paulo', state: 'SP' },
    });
    expect(minimal.status(), await minimal.text()).toBe(201);
    const saved = await minimal.json();
    expect(saved).toMatchObject({ number: 'S/N', state: 'SP', zipCode: '01001000' });
    expect(saved.nickname ?? null).toBeNull();
    expect(saved.complement ?? null).toBeNull();
  });

  test('coordenadas válidas são gravadas como número', async ({ request }) => {
    const client = await newClient(request);
    const address = await createAddress(request, client.token, { latitude: -22.9711, longitude: '-43.1822' });
    expect(address.latitude).toBeCloseTo(-22.9711, 4);
    expect(address.longitude).toBeCloseTo(-43.1822, 4);
  });

  test('GET /addresses lista somente os endereços do próprio usuário', async ({ request }) => {
    const [a, b] = [await newClient(request), await newClient(request)];
    const a1 = await createAddress(request, a.token, { nickname: 'Casa A' });
    const a2 = await createAddress(request, a.token, { nickname: 'Trabalho A' });
    const b1 = await createAddress(request, b.token, { nickname: 'Casa B' });

    const listA = await (await request.get('/addresses', { headers: bearer(a.token) })).json();
    expect(listA.map((x: { id: number }) => x.id)).toEqual([a1.id, a2.id]);
    const listB = await (await request.get('/addresses', { headers: bearer(b.token) })).json();
    expect(listB.map((x: { id: number }) => x.id)).toEqual([b1.id]);
  });

  test('GET /addresses/:id devolve o próprio endereço', async ({ request }) => {
    const client = await newClient(request);
    const address = await createAddress(request, client.token);
    const res = await request.get(`/addresses/${address.id}`, { headers: bearer(client.token) });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ id: address.id, street: ADDRESS.street, zipCode: '22041001' });
  });

  test('PATCH atualiza só os campos enviados e aceita null nos opcionais', async ({ request }) => {
    const client = await newClient(request);
    const address = await createAddress(request, client.token);
    const res = await request.patch(`/addresses/${address.id}`, {
      headers: bearer(client.token),
      data: { number: '200', complement: null, state: 'sp', zipCode: '01001-000' },
    });
    expect(res.status(), await res.text()).toBe(200);
    const updated = await res.json();
    expect(updated).toMatchObject({ id: address.id, number: '200', state: 'SP', zipCode: '01001000', street: ADDRESS.street });
    expect(updated.complement).toBeNull();

    const fetched = await (await request.get(`/addresses/${address.id}`, { headers: bearer(client.token) })).json();
    expect(fetched).toMatchObject({ number: '200', state: 'SP', complement: null });
  });

  test('PATCH com corpo vazio não altera o endereço', async ({ request }) => {
    const client = await newClient(request);
    const address = await createAddress(request, client.token);
    const res = await request.patch(`/addresses/${address.id}`, { headers: bearer(client.token), data: {} });
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toEqual(address);
  });

  test('DELETE remove o endereço: some da lista e consultas seguintes → 404', async ({ request }) => {
    const client = await newClient(request);
    const keep = await createAddress(request, client.token, { nickname: 'Fica' });
    const drop = await createAddress(request, client.token, { nickname: 'Sai' });

    const res = await request.delete(`/addresses/${drop.id}`, { headers: bearer(client.token) });
    expect(res.status(), await res.text()).toBe(200);

    await expectError(await request.get(`/addresses/${drop.id}`, { headers: bearer(client.token) }), 404);
    await expectError(await request.patch(`/addresses/${drop.id}`, { headers: bearer(client.token), data: { number: '1' } }), 404);
    await expectError(await request.delete(`/addresses/${drop.id}`, { headers: bearer(client.token) }), 404);
    const list = await (await request.get('/addresses', { headers: bearer(client.token) })).json();
    expect(list.map((x: { id: number }) => x.id)).toEqual([keep.id]);
  });

  test('membros da equipe também têm endereços próprios e isolados', async ({ request }) => {
    const client = await newClient(request);
    const clientAddress = await createAddress(request, client.token);
    const admin = await sessionOf(request, 'admin');
    const list = await (await request.get('/addresses', { headers: bearer(admin.token) })).json();
    expect(list.map((x: { id: number }) => x.id)).not.toContain(clientAddress.id);
  });
});

test.describe('Endereço de outro usuário → 404', () => {
  test('GET do endereço de outro cliente → 404', async ({ request }) => {
    const [owner, other] = [await newClient(request), await newClient(request)];
    const address = await createAddress(request, owner.token);
    await expectError(await request.get(`/addresses/${address.id}`, { headers: bearer(other.token) }), 404);
  });

  test('PATCH no endereço de outro cliente → 404 e nada muda', async ({ request }) => {
    const [owner, other] = [await newClient(request), await newClient(request)];
    const address = await createAddress(request, owner.token);
    await expectError(
      await request.patch(`/addresses/${address.id}`, { headers: bearer(other.token), data: { street: 'Rua do Invasor' } }),
      404,
    );
    const current = await (await request.get(`/addresses/${address.id}`, { headers: bearer(owner.token) })).json();
    expect(current.street).toBe(ADDRESS.street);
  });

  test('DELETE no endereço de outro cliente → 404 e o endereço continua com o dono', async ({ request }) => {
    const [owner, other] = [await newClient(request), await newClient(request)];
    const address = await createAddress(request, owner.token);
    await expectError(await request.delete(`/addresses/${address.id}`, { headers: bearer(other.token) }), 404);
    expect((await request.get(`/addresses/${address.id}`, { headers: bearer(owner.token) })).status()).toBe(200);
  });

  test('ADMIN e atendente também recebem 404 no endereço de um cliente (escopo é sempre o próprio usuário)', async ({ request }) => {
    const owner = await newClient(request);
    const address = await createAddress(request, owner.token);
    for (const key of ['admin', 'employee'] as const) {
      const staff = await sessionOf(request, key);
      const res = await request.get(`/addresses/${address.id}`, { headers: bearer(staff.token) });
      expect(res.status(), `${key}: ${await res.text()}`).toBe(404);
    }
  });

  test('não é possível transferir o endereço para outro usuário pelo corpo (campo extra → 400)', async ({ request }) => {
    const [owner, other] = [await newClient(request), await newClient(request)];
    const address = await createAddress(request, owner.token);
    await expectError(
      await request.patch(`/addresses/${address.id}`, { headers: bearer(owner.token), data: { user: { id: other.user.id } } }),
      400,
    );
    await expectError(
      await request.post('/addresses', { headers: bearer(owner.token), data: { ...ADDRESS, userId: other.user.id } }),
      400,
    );
    const list = await (await request.get('/addresses', { headers: bearer(other.token) })).json();
    expect(list).toEqual([]);
  });
});

test.describe('Validação de endereço', () => {
  for (const zipCode of ['1234', '123456789', 'abcdefgh', '', '22041-0011']) {
    test(`CEP inválido "${zipCode}" → 400`, async ({ request }) => {
      const client = await sessionOf(request, 'client');
      await expectError(
        await request.post('/addresses', { headers: bearer(client.token), data: { ...ADDRESS, zipCode } }),
        400,
        /CEP inválido/,
      );
    });
  }

  for (const state of ['XX', 'Rio de Janeiro', '', 'R1']) {
    test(`UF inválida "${state}" → 400`, async ({ request }) => {
      const client = await sessionOf(request, 'client');
      await expectError(
        await request.post('/addresses', { headers: bearer(client.token), data: { ...ADDRESS, state } }),
        400,
        /UF inválida/,
      );
    });
  }

  for (const field of ['zipCode', 'street', 'number', 'neighborhood', 'city', 'state'] as const) {
    test(`campo obrigatório ${field} ausente → 400`, async ({ request }) => {
      const client = await sessionOf(request, 'client');
      const data: Record<string, unknown> = { ...ADDRESS };
      delete data[field];
      await expectError(await request.post('/addresses', { headers: bearer(client.token), data }), 400);
    });
  }

  test('campos obrigatórios vazios ou só com espaços → 400 com uma mensagem por campo', async ({ request }) => {
    const client = await sessionOf(request, 'client');
    const res = await request.post('/addresses', {
      headers: bearer(client.token),
      data: { ...ADDRESS, street: '   ', number: '', neighborhood: ' ', city: '' },
    });
    const payload = await expectError(res, 400);
    const text = (payload.message as string[]).join(' | ');
    for (const expected of [/rua/i, /número/i, /bairro/i, /cidade/i]) expect(text).toMatch(expected);
  });

  const tooLong: Array<[string, Record<string, unknown>]> = [
    ['rua com 151 caracteres', { street: 'R'.repeat(151) }],
    ['apelido com 51 caracteres', { nickname: 'A'.repeat(51) }],
    ['complemento com 101 caracteres', { complement: 'C'.repeat(101) }],
    ['número com 21 caracteres', { number: '1'.repeat(21) }],
    ['bairro com 101 caracteres', { neighborhood: 'B'.repeat(101) }],
    ['cidade com 101 caracteres', { city: 'C'.repeat(101) }],
  ];
  for (const [label, override] of tooLong) {
    test(`${label} → 400`, async ({ request }) => {
      const client = await sessionOf(request, 'client');
      await expectError(
        await request.post('/addresses', { headers: bearer(client.token), data: { ...ADDRESS, ...override } }),
        400,
      );
    });
  }

  const badCoordinates: Array<[string, Record<string, unknown>]> = [
    ['latitude 91', { latitude: 91 }],
    ['longitude -181', { longitude: -181 }],
    ['latitude não numérica', { latitude: 'abc' }],
  ];
  for (const [label, override] of badCoordinates) {
    test(`coordenada inválida (${label}) → 400`, async ({ request }) => {
      const client = await sessionOf(request, 'client');
      await expectError(
        await request.post('/addresses', { headers: bearer(client.token), data: { ...ADDRESS, ...override } }),
        400,
      );
    });
  }

  test('PATCH com campo obrigatório null ou CEP inválido → 400 e nada muda', async ({ request }) => {
    const client = await newClient(request);
    const address = await createAddress(request, client.token);
    for (const data of [{ street: null }, { city: null }, { zipCode: '123' }, { state: 'ZZ' }]) {
      const res = await request.patch(`/addresses/${address.id}`, { headers: bearer(client.token), data });
      expect(res.status(), `${JSON.stringify(data)}: ${await res.text()}`).toBe(400);
    }
    const current = await (await request.get(`/addresses/${address.id}`, { headers: bearer(client.token) })).json();
    expect(current).toMatchObject({ street: ADDRESS.street, city: ADDRESS.city, zipCode: '22041001', state: 'RJ' });
  });

  for (const id of ['abc', '0', '-1', OUT_OF_RANGE_ID, '1.5']) {
    test(`id inválido "${id}" → 400`, async ({ request }) => {
      const client = await sessionOf(request, 'client');
      await expectError(await request.get(`/addresses/${id}`, { headers: bearer(client.token) }), 400);
    });
  }

  test('id inexistente → 404', async ({ request }) => {
    const client = await sessionOf(request, 'client');
    await expectError(await request.get(`/addresses/${MISSING_ID}`, { headers: bearer(client.token) }), 404);
  });
});

test.describe('Busca de CEP (GET /addresses/cep/:cep) — pública', () => {
  for (const cep of ['123', 'abcdefgh', '123456789', '0100100']) {
    test(`formato inválido "${cep}" → 400`, async ({ request }) => {
      await expectError(await request.get(`/addresses/cep/${cep}`), 400, /CEP inválido/);
    });
  }

  test('CEP válido 01001000 → 200 no formato ViaCEP (ou 404/502 se o serviço externo falhar, nunca 500)', async ({ request }) => {
    const res = await request.get('/addresses/cep/01001000', { timeout: 30_000 });
    const payload = await body(res);
    expect([200, 404, 502], JSON.stringify(payload)).toContain(res.status());
    if (res.status() === 200) {
      expect(payload).toEqual({
        cep: '01001-000',
        logradouro: expect.any(String),
        complemento: expect.any(String),
        bairro: expect.any(String),
        localidade: 'São Paulo',
        uf: 'SP',
      });
      expect(payload.logradouro).toMatch(/Sé/);
    }
  });

  test('CEP com máscara (01001-000) é aceito e não exige token', async ({ request }) => {
    const res = await request.get('/addresses/cep/01001-000', { timeout: 30_000 });
    expect([200, 404, 502], await res.text()).toContain(res.status());
    if (res.status() === 200) expect((await res.json()).uf).toBe('SP');
  });

  test('CEP inexistente (00000000) → 404 (ou 502 sem internet), nunca 500', async ({ request }) => {
    const res = await request.get('/addresses/cep/00000000', { timeout: 30_000 });
    const payload = await body(res);
    expect([404, 502], JSON.stringify(payload)).toContain(res.status());
    expect(payload).toMatchObject({ statusCode: res.status() });
  });
});

test.describe('Endereço usado em pedido', () => {
  test('excluir endereço usado em pedido não falha e o pedido continua exibindo o endereço', async ({ request }) => {
    const client = await newClient(request);
    const address = await createAddress(request, client.token, { neighborhood: 'Centro', street: 'Rua do Pedido Antigo' });
    const order = await createOrder(request, client.token, {
      items: [{ productId: product.id, quantity: 1 }],
      type: 'DELIVERY',
      addressId: address.id,
      paymentMethod: 'MONEY',
    });
    createdOrders.push(order.id);
    expect(order.address?.id).toBe(address.id);

    const del = await request.delete(`/addresses/${address.id}`, { headers: bearer(client.token) });
    expect(del.status(), await del.text()).toBe(200);
    const list = await (await request.get('/addresses', { headers: bearer(client.token) })).json();
    expect(list.map((x: { id: number }) => x.id)).not.toContain(address.id);

    const own = await (await request.get(`/orders/${order.id}`, { headers: bearer(client.token) })).json();
    expect(own.address).toMatchObject({ id: address.id, street: 'Rua do Pedido Antigo', neighborhood: 'Centro' });

    const history = await (await request.get('/orders/my-orders', { headers: bearer(client.token) })).json();
    expect(history.find((o: { id: number }) => o.id === order.id)?.address?.street).toBe('Rua do Pedido Antigo');

    const admin = await sessionOf(request, 'admin');
    const staffView = await (await request.get(`/orders/${order.id}`, { headers: bearer(admin.token) })).json();
    expect(staffView.address?.street).toBe('Rua do Pedido Antigo');
  });

  test('endereço excluído não recebe pedidos novos (quote e pedido → 404)', async ({ request }) => {
    const client = await newClient(request);
    const address = await createAddress(request, client.token);
    expect((await request.delete(`/addresses/${address.id}`, { headers: bearer(client.token) })).ok()).toBeTruthy();

    const items = [{ productId: product.id, quantity: 1 }];
    await expectError(
      await request.post('/orders/quote', { headers: bearer(client.token), data: { items, type: 'DELIVERY', addressId: address.id } }),
      404,
    );
    await expectError(
      await request.post('/orders', {
        headers: bearer(client.token),
        data: { items, type: 'DELIVERY', addressId: address.id, paymentMethod: 'MONEY' },
      }),
      404,
    );
  });
});
