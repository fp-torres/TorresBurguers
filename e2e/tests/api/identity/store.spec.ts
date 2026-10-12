import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import {
  bearer,
  body,
  createAddress,
  createProduct,
  expectError,
  newApi,
  newClient,
  retireProduct,
  sessionOf,
  type Product,
  type TestUser,
} from './helpers';

const STATUS_KEYS = ['closing_message', 'id', 'is_open', 'opening_message'];

interface StoreStatus {
  id: number;
  is_open: boolean;
  opening_message: string | null;
  closing_message: string | null;
}

async function currentStatus(api: APIRequestContext): Promise<StoreStatus> {
  const res = await api.get('/store/status');
  expect(res.status()).toBe(200);
  return res.json();
}

/**
 * Rede de segurança dos testes de validação: se um bug deixar a loja fechada,
 * ela é reaberta na hora (os outros testadores dependem dela aberta).
 */
async function ensureStoreOpen(api: APIRequestContext): Promise<void> {
  const status = await currentStatus(api);
  if (status.is_open) return;
  const admin = await sessionOf(api, 'admin');
  const reopen = await api.patch('/store/status', { headers: bearer(admin.token), data: { is_open: true } });
  expect(reopen.ok(), `reabrindo a loja: ${await reopen.text()}`).toBeTruthy();
  throw new Error('A requisição de validação deixou a loja FECHADA (reaberta automaticamente).');
}

function expectStatusShape(payload: any): void {
  expect(Object.keys(payload).sort()).toEqual(STATUS_KEYS);
  expect(typeof payload.id).toBe('number');
  expect(typeof payload.is_open).toBe('boolean');
  for (const key of ['opening_message', 'closing_message']) {
    expect(payload[key] === null || typeof payload[key] === 'string', `${key}: ${payload[key]}`).toBeTruthy();
  }
}

test.describe('Status da loja (GET/PATCH /store/status)', () => {
  test('GET é público e devolve exatamente {id, is_open, opening_message, closing_message}', async ({ request }) => {
    const res = await request.get('/store/status');
    expect(res.status()).toBe(200);
    expectStatusShape(await res.json());
  });

  test('ADMIN altera o status e recebe o status atualizado', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    const res = await request.patch('/store/status', { headers: bearer(admin.token), data: { is_open: true } });
    expect(res.status(), await res.text()).toBe(200);
    const payload = await res.json();
    expectStatusShape(payload);
    expect(payload.is_open).toBe(true);
  });

  test('EMPLOYEE (atendente) altera o status da loja', async ({ request }) => {
    const employee = await sessionOf(request, 'employee');
    const res = await request.patch('/store/status', { headers: bearer(employee.token), data: { is_open: true } });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).is_open).toBe(true);
  });

  test('ADMIN edita as mensagens da vitrine, texto vazio limpa a mensagem e o status aberto não muda', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    const before = await currentStatus(request);
    try {
      const set = await request.patch('/store/status', {
        headers: bearer(admin.token),
        data: { opening_message: '  Bem-vindo (teste E2E)  ', closing_message: 'Voltamos amanhã (teste E2E)' },
      });
      expect(set.status(), await set.text()).toBe(200);
      const after = await currentStatus(request);
      expect(after).toMatchObject({
        is_open: before.is_open,
        opening_message: 'Bem-vindo (teste E2E)',
        closing_message: 'Voltamos amanhã (teste E2E)',
      });

      const cleared = await request.patch('/store/status', { headers: bearer(admin.token), data: { opening_message: '' } });
      expect(cleared.status(), await cleared.text()).toBe(200);
      const final = await currentStatus(request);
      expect(final.opening_message).toBeNull();
      expect(final.closing_message).toBe('Voltamos amanhã (teste E2E)');
    } finally {
      await request.patch('/store/status', {
        headers: bearer(admin.token),
        data: { opening_message: before.opening_message ?? '', closing_message: before.closing_message ?? '' },
      });
      await ensureStoreOpen(request);
    }
  });

  for (const key of ['kitchen', 'courier', 'client'] as const) {
    test(`perfil ${key} não altera o status da loja (403)`, async ({ request }) => {
      const session = await sessionOf(request, key);
      try {
        await expectError(
          await request.patch('/store/status', { headers: bearer(session.token), data: { is_open: true } }),
          403,
        );
      } finally {
        await ensureStoreOpen(request);
      }
    });
  }

  test('PATCH com corpo vazio não altera nada', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    const before = await currentStatus(request);
    try {
      const res = await request.patch('/store/status', { headers: bearer(admin.token), data: {} });
      expect(res.status(), await res.text()).toBe(200);
      expect(await res.json()).toEqual(before);
    } finally {
      await ensureStoreOpen(request);
    }
  });

  test('anônimo não altera o status da loja (401)', async ({ request }) => {
    await expectError(await request.patch('/store/status', { data: { is_open: true } }), 401);
  });

  const invalid: Array<[string, Record<string, unknown>]> = [
    ['is_open que não é booleano', { is_open: 'talvez' }],
    ['is_open null', { is_open: null }],
    ['mensagem de loja aberta com mais de 200 caracteres', { opening_message: 'a'.repeat(201) }],
    ['mensagem de loja fechada que não é texto', { closing_message: 12345 }],
    ['campo desconhecido', { is_open: true, horario: '18h' }],
  ];
  for (const [label, data] of invalid) {
    test(`PATCH com ${label} → 400 e nada muda`, async ({ request }) => {
      const admin = await sessionOf(request, 'admin');
      const before = await currentStatus(request);
      try {
        await expectError(await request.patch('/store/status', { headers: bearer(admin.token), data }), 400);
        expect(await currentStatus(request)).toEqual(before);
      } finally {
        await ensureStoreOpen(request);
      }
    });
  }
});

// ÚNICO teste da suíte que fecha a loja. Tudo é preparado antes; a janela fechada dura
// só as requisições verificadas, e a loja é reaberta no finally.
test.describe.serial('Loja fechada', () => {
  let client: TestUser;
  let product: Product;
  let orderBody: Record<string, unknown>;
  const createdOrders: number[] = [];

  test.beforeAll(async () => {
    const api = await newApi();
    client = await newClient(api);
    product = await createProduct(api, { price: 12.5 });
    const address = await createAddress(api, client.token, { neighborhood: 'Botafogo' });
    orderBody = { items: [{ productId: product.id, quantity: 2 }], type: 'DELIVERY', addressId: address.id };
    await api.dispose();
  });

  test.afterAll(async () => {
    const api = await newApi();
    for (const id of createdOrders) await api.patch(`/orders/${id}/cancel`, { headers: bearer(client.token) });
    if (product) await retireProduct(api, product.id);
    await api.dispose();
  });

  test('com a loja fechada o quote informa store_open:false e pedidos/pagamentos são recusados; reaberta, tudo volta', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    const employee = await sessionOf(request, 'employee');
    const before = await currentStatus(request);
    expect(before.is_open, 'a loja precisa estar aberta antes do teste').toBe(true);
    const closingMessage = 'Fechado para manutenção (teste E2E)';

    let employeeClose: APIResponse | undefined;
    let fallbackClose: APIResponse | undefined;
    let closedResults: Record<string, { status: number; payload: any }> = {};
    const capture = async (res: APIResponse) => ({ status: res.status(), payload: await body(res) });

    try {
      // O atendente fecha a loja (se falhar, o ADMIN fecha para os demais itens serem verificados)
      employeeClose = await request.patch('/store/status', {
        headers: bearer(employee.token),
        data: { is_open: false, closing_message: closingMessage },
      });
      if (!employeeClose.ok()) {
        fallbackClose = await request.patch('/store/status', {
          headers: bearer(admin.token),
          data: { is_open: false, closing_message: closingMessage },
        });
      }

      const [status, quote, order, pix, card] = await Promise.all([
        request.get('/store/status').then(capture),
        request.post('/orders/quote', { headers: bearer(client.token), data: orderBody }).then(capture),
        request
          .post('/orders', { headers: bearer(client.token), data: { ...orderBody, paymentMethod: 'MONEY' } })
          .then(capture),
        request.post('/payment/pix', { headers: bearer(client.token), data: { order: orderBody } }).then(capture),
        request
          .post('/payment/card', {
            headers: bearer(client.token),
            data: { order: orderBody, token: 'tok-e2e-loja-fechada', paymentMethodId: 'master', docNumber: '12345678909' },
          })
          .then(capture),
      ]);
      closedResults = { status, quote, order, pix, card };
    } finally {
      // Reabre com o ADMIN (e, se falhar, tenta de novo/usa o atendente) restaurando as mensagens
      let reopened = false;
      let lastError = '';
      for (const token of [admin.token, admin.token, employee.token]) {
        const reopen = await request
          .patch('/store/status', {
            headers: bearer(token),
            data: {
              is_open: true,
              opening_message: before.opening_message ?? '',
              closing_message: before.closing_message ?? '',
            },
          })
          .catch((error: Error) => error);
        if (!(reopen instanceof Error) && reopen.ok()) {
          reopened = true;
          break;
        }
        lastError = reopen instanceof Error ? reopen.message : `${reopen.status()} ${await reopen.text()}`;
      }
      expect(reopened, `REABERTURA da loja falhou: ${lastError}`).toBe(true);
    }

    // --- Verificações (já com a loja reaberta) ---
    expect.soft(employeeClose?.status(), 'EMPLOYEE consegue fechar a loja').toBe(200);
    if (fallbackClose) expect(fallbackClose.ok(), 'fechamento pelo ADMIN').toBeTruthy();

    const { status, quote, order, pix, card } = closedResults;
    expect.soft(status.payload, 'GET /store/status com a loja fechada').toMatchObject({
      is_open: false,
      closing_message: closingMessage,
    });

    expect.soft(quote.status, `quote com loja fechada: ${JSON.stringify(quote.payload)}`).toBe(200);
    expect.soft(quote.payload, 'quote com loja fechada').toMatchObject({
      store_open: false,
      subtotal: 25,
      delivery_fee: 7,
      total: 32,
    });

    expect.soft(order.status, `POST /orders com loja fechada: ${JSON.stringify(order.payload)}`).toBe(400);
    expect.soft(JSON.stringify(order.payload)).toMatch(/fechad/i);
    expect.soft(pix.status, `POST /payment/pix com loja fechada: ${JSON.stringify(pix.payload)}`).toBe(400);
    expect.soft(card.status, `POST /payment/card com loja fechada: ${JSON.stringify(card.payload)}`).toBe(400);

    // Reaberta: status restaurado, quote volta a store_open:true e o pedido passa
    const after = await currentStatus(request);
    expect(after).toEqual(before);

    const reopenedQuote = await request.post('/orders/quote', { headers: bearer(client.token), data: orderBody });
    expect(reopenedQuote.status()).toBe(200);
    expect(await reopenedQuote.json()).toMatchObject({ store_open: true, subtotal: 25, delivery_fee: 7, total: 32 });

    const created = await request.post('/orders', {
      headers: bearer(client.token),
      data: { ...orderBody, paymentMethod: 'MONEY' },
    });
    expect(created.status(), await created.text()).toBe(201);
    createdOrders.push((await created.json()).id);

    // Nada foi gravado enquanto a loja estava fechada
    const mine = await (await request.get('/orders/my-orders', { headers: bearer(client.token) })).json();
    expect(mine).toHaveLength(1);
  });
});
