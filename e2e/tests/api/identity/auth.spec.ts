import { test, expect } from '@playwright/test';
import { DEFAULT_USERS, type DefaultUserKey } from '../../../support/users';
import {
  MISSING_ID,
  STRONG_PASSWORD,
  bearer,
  body,
  corruptSignature,
  decodeJwt,
  expectContractErrorShape,
  expectError,
  expectNoSecrets,
  foreignSignedToken,
  newClient,
  newUserWithRole,
  pngFile,
  sessionOf,
  tamperPayload,
  unsignedToken,
  cleanupTrackedStaff,
  trackStaff,
} from './helpers';

test.afterAll(cleanupTrackedStaff);

const SEVEN_DAYS_IN_SECONDS = 7 * 24 * 60 * 60;

test.describe('Login (POST /auth/login)', () => {
  for (const key of Object.keys(DEFAULT_USERS) as DefaultUserKey[]) {
    const user = DEFAULT_USERS[key];
    test(`usuário padrão ${user.role} entra e recebe access_token e usuário sem senha`, async ({ request }) => {
      const res = await request.post('/auth/login', { data: { email: user.email, password: user.password } });
      expect(res.ok(), await res.text()).toBeTruthy();
      const payload = await body(res);

      expect(Object.keys(payload).sort()).toEqual(['access_token', 'user']);
      expect(payload.access_token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
      expect(payload.user).toMatchObject({ email: user.email, role: user.role, name: user.name });
      expect(typeof payload.user.id).toBe('number');
      expectNoSecrets(payload, `login de ${user.email}`);
    });
  }

  test('o JWT traz sub, email, role e name do usuário e expira em 7 dias (JWT_EXPIRES_IN padrão)', async ({ request }) => {
    const res = await request.post('/auth/login', {
      data: { email: DEFAULT_USERS.employee.email, password: DEFAULT_USERS.employee.password },
    });
    const { access_token, user } = await res.json();
    const { header, payload } = decodeJwt(access_token);

    expect(header.alg).toBe('HS256');
    expect(payload).toMatchObject({ sub: user.id, email: user.email, role: 'EMPLOYEE', name: user.name });
    expect(payload.exp - payload.iat).toBe(SEVEN_DAYS_IN_SECONDS);
    expect(findPasswordLike(payload)).toEqual([]);
  });

  test('senha errada → 401, com a mesma mensagem de e-mail desconhecido (não revela contas)', async ({ request }) => {
    const wrong = await request.post('/auth/login', {
      data: { email: DEFAULT_USERS.admin.email, password: 'SenhaErrada@999' },
    });
    const wrongBody = await expectError(wrong, 401);
    expect(wrongBody.access_token).toBeUndefined();

    const unknown = await request.post('/auth/login', {
      data: { email: `ninguem-${Date.now()}@e2e.test`, password: 'SenhaErrada@999' },
    });
    const unknownBody = await expectError(unknown, 401);
    expect(unknownBody.message).toBe(wrongBody.message);
  });

  test('e-mail desconhecido → 401 sem token', async ({ request }) => {
    const res = await request.post('/auth/login', {
      data: { email: `desconhecido-${Date.now()}@comestra.com.br`, password: STRONG_PASSWORD },
    });
    const payload = await expectError(res, 401);
    expect(payload.access_token).toBeUndefined();
  });

  test('e-mail é aceito sem diferenciar maiúsculas/minúsculas', async ({ request }) => {
    const res = await request.post('/auth/login', {
      data: { email: DEFAULT_USERS.kitchen.email.toUpperCase(), password: DEFAULT_USERS.kitchen.password },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const { user } = await res.json();
    expect(user.email).toBe(DEFAULT_USERS.kitchen.email);
    expect(user.role).toBe('KITCHEN');
  });

  test('e-mail com espaços nas pontas é aceito (trim)', async ({ request }) => {
    const res = await request.post('/auth/login', {
      data: { email: `   ${DEFAULT_USERS.courier.email}  `, password: DEFAULT_USERS.courier.password },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    expect((await res.json()).user.role).toBe('COURIER');
  });

  test('cliente recém-cadastrado entra com o e-mail em caixa mista e com espaços', async ({ request }) => {
    const client = await newClient(request);
    const variant = `  ${client.email.toUpperCase()} `;
    const res = await request.post('/auth/login', { data: { email: variant, password: client.password } });
    expect(res.ok(), await res.text()).toBeTruthy();
    expect((await res.json()).user.id).toBe(client.user.id);
  });

  test('senha diferencia maiúsculas e não é aparada', async ({ request }) => {
    const { email, password } = DEFAULT_USERS.client;
    for (const attempt of [password.toLowerCase(), password.toUpperCase(), ` ${password}`, `${password} `]) {
      const res = await request.post('/auth/login', { data: { email, password: attempt } });
      expect(res.status(), `senha "${attempt}" não pode entrar`).toBe(401);
    }
  });

  const invalidBodies: Array<[string, Record<string, unknown>]> = [
    ['corpo vazio', {}],
    ['sem senha', { email: DEFAULT_USERS.client.email }],
    ['sem e-mail', { password: DEFAULT_USERS.client.password }],
    ['e-mail mal formatado', { email: 'cliente-sem-arroba', password: DEFAULT_USERS.client.password }],
    ['senha vazia', { email: DEFAULT_USERS.client.email, password: '' }],
    ['senha numérica', { email: DEFAULT_USERS.client.email, password: 123456789 }],
    ['campo extra', { ...pick(DEFAULT_USERS.client), remember: true }],
  ];
  for (const [label, data] of invalidBodies) {
    test(`corpo inválido (${label}) → 400 sem token`, async ({ request }) => {
      const res = await request.post('/auth/login', { data });
      const payload = await expectError(res, 400);
      expect(payload.access_token).toBeUndefined();
    });
  }
});

test.describe('Recuperação de senha', () => {
  test('não existe endpoint de recuperação de senha (o administrador redefine pelo painel)', async ({ request }) => {
    for (const path of ['/auth/forgot-password', '/auth/reset-password', '/users/forgot-password', '/auth/recover']) {
      const res = await request.post(path, { data: { email: DEFAULT_USERS.client.email } });
      expect(res.status(), `${path}: ${await res.text()}`).toBe(404);
    }
  });
});

test.describe('Rotas protegidas sem token → 401', () => {
  const routes: Array<[method: 'get' | 'post' | 'patch' | 'delete', path: string, data?: unknown]> = [
    ['get', '/users'],
    ['get', '/users/trash'],
    ['get', `/users/${MISSING_ID}`],
    ['patch', `/users/${MISSING_ID}`, { name: 'Invasor' }],
    ['delete', `/users/${MISSING_ID}`],
    ['patch', `/users/${MISSING_ID}/restore`],
    ['delete', `/users/${MISSING_ID}/permanent`],
    ['get', '/addresses'],
    ['post', '/addresses', { street: 'Rua X' }],
    ['get', `/addresses/${MISSING_ID}`],
    ['patch', `/addresses/${MISSING_ID}`, { street: 'Rua X' }],
    ['delete', `/addresses/${MISSING_ID}`],
    ['patch', '/store/status', { is_open: true }],
    ['post', '/maintenance/optimize-images'],
    ['get', '/orders'],
    ['get', '/orders/my-orders'],
    ['post', '/orders/quote', { items: [], type: 'TAKEOUT' }],
    ['post', '/orders', { items: [], type: 'TAKEOUT', paymentMethod: 'MONEY' }],
    ['get', `/orders/${MISSING_ID}`],
    ['post', '/payment/pix', { order: { items: [], type: 'TAKEOUT' } }],
    ['get', `/payment/status/${MISSING_ID}`],
  ];

  for (const [method, path, data] of routes) {
    test(`${method.toUpperCase()} ${path.replace(String(MISSING_ID), ':id')} sem token → 401`, async ({ request }) => {
      const res = await request.fetch(path, { method: method.toUpperCase(), ...(data === undefined ? {} : { data }) });
      await expectError(res, 401);
    });
  }

  test('POST /uploads sem token → 401 (a imagem não é aceita)', async ({ request }) => {
    const res = await request.post('/uploads', { multipart: { file: pngFile() } });
    await expectError(res, 401);
  });
});

test.describe('Tokens inválidos → 401', () => {
  test('token aleatório (não-JWT) → 401', async ({ request }) => {
    await expectError(await request.get('/addresses', { headers: bearer('isto-nao-e-um-jwt') }), 401);
  });

  test('token com a assinatura adulterada → 401', async ({ request }) => {
    const client = await sessionOf(request, 'client');
    await expectError(await request.get('/addresses', { headers: bearer(corruptSignature(client.token)) }), 401);
  });

  test('payload alterado para ADMIN mantendo a assinatura original → 401 em GET /users', async ({ request }) => {
    const client = await sessionOf(request, 'client');
    const admin = await sessionOf(request, 'admin');
    const forged = tamperPayload(client.token, { sub: admin.user.id, role: 'ADMIN', email: admin.user.email });
    await expectError(await request.get('/users', { headers: bearer(forged) }), 401);
  });

  test('token sem assinatura (alg "none") → 401', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    const now = Math.floor(Date.now() / 1000);
    const forged = unsignedToken({ sub: admin.user.id, email: admin.user.email, role: 'ADMIN', name: 'x', iat: now, exp: now + 3600 });
    await expectError(await request.get('/users', { headers: bearer(forged) }), 401);
  });

  test('token assinado com outro segredo → 401', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    const now = Math.floor(Date.now() / 1000);
    const forged = foreignSignedToken({ sub: admin.user.id, email: admin.user.email, role: 'ADMIN', name: 'x', iat: now, exp: now + 3600 });
    await expectError(await request.get('/users', { headers: bearer(forged) }), 401);
  });

  test('token sem o prefixo "Bearer" ou em outro esquema → 401', async ({ request }) => {
    const client = await sessionOf(request, 'client');
    await expectError(await request.get('/addresses', { headers: { Authorization: client.token } }), 401);
    await expectError(await request.get('/addresses', { headers: { Authorization: `Basic ${client.token}` } }), 401);
    await expectError(await request.get('/addresses', { headers: { Authorization: 'Bearer ' } }), 401);
  });

  test('token na query string não autentica → 401', async ({ request }) => {
    const client = await sessionOf(request, 'client');
    await expectError(await request.get(`/addresses?access_token=${client.token}`), 401);
  });
});

test.describe('Formato dos erros ({statusCode, message, error})', () => {
  test('401 por falta de token segue o formato de erro do contrato', async ({ request }) => {
    const res = await request.get('/addresses');
    expect(res.status()).toBe(401);
    expectContractErrorShape(await body(res), 401);
  });

  test('401 por token inválido segue o formato de erro do contrato', async ({ request }) => {
    const res = await request.get('/users', { headers: bearer('token-invalido') });
    expect(res.status()).toBe(401);
    expectContractErrorShape(await body(res), 401);
  });

  test('401 de credenciais inválidas, 400, 403, 404 e 409 seguem o formato de erro do contrato', async ({ request }) => {
    const wrong = await request.post('/auth/login', { data: { email: DEFAULT_USERS.admin.email, password: 'Errada@12345' } });
    expect(wrong.status()).toBe(401);
    expectContractErrorShape(await body(wrong), 401);

    const invalid = await request.post('/auth/login', { data: {} });
    expect(invalid.status()).toBe(400);
    const invalidBody = await body(invalid);
    expectContractErrorShape(invalidBody, 400);
    expect(Array.isArray(invalidBody.message), 'erros de validação vêm como lista').toBeTruthy();

    const client = await sessionOf(request, 'client');
    const forbidden = await request.get('/users', { headers: bearer(client.token) });
    expect(forbidden.status()).toBe(403);
    expectContractErrorShape(await body(forbidden), 403);

    const admin = await sessionOf(request, 'admin');
    const missing = await request.get(`/users/${MISSING_ID}`, { headers: bearer(admin.token) });
    expect(missing.status()).toBe(404);
    expectContractErrorShape(await body(missing), 404);

    const duplicate = await request.post('/users', {
      data: { name: 'Duplicado', email: DEFAULT_USERS.client.email, password: STRONG_PASSWORD },
    });
    expect(duplicate.status()).toBe(409);
    expectContractErrorShape(await body(duplicate), 409);
  });
});

test.describe('Sessão recarregada do banco a cada requisição', () => {
  test('token de um cliente que excluiu a própria conta passa a responder 401', async ({ request }) => {
    const client = await newClient(request);
    expect((await request.get('/addresses', { headers: bearer(client.token) })).status()).toBe(200);

    const del = await request.delete(`/users/${client.user.id}`, { headers: bearer(client.token) });
    expect(del.ok(), await del.text()).toBeTruthy();

    await expectError(await request.get('/addresses', { headers: bearer(client.token) }), 401);
    await expectError(await request.get('/orders/my-orders', { headers: bearer(client.token) }), 401);
    await expectError(await request.get(`/users/${client.user.id}`, { headers: bearer(client.token) }), 401);
  });

  test('token de um membro da equipe excluído pelo ADMIN passa a responder 401', async ({ request }) => {
    const kitchen = await newUserWithRole(request, 'KITCHEN');
    expect((await request.get('/orders', { headers: bearer(kitchen.token) })).status()).toBe(200);

    const admin = await sessionOf(request, 'admin');
    const del = await request.delete(`/users/${kitchen.user.id}`, { headers: bearer(admin.token) });
    expect(del.ok(), await del.text()).toBeTruthy();

    await expectError(await request.get('/orders', { headers: bearer(kitchen.token) }), 401);
  });

  test('conta excluída não consegue entrar de novo (401)', async ({ request }) => {
    const client = await newClient(request);
    const del = await request.delete(`/users/${client.user.id}`, { headers: bearer(client.token) });
    expect(del.ok(), await del.text()).toBeTruthy();

    const res = await request.post('/auth/login', { data: { email: client.email, password: client.password } });
    await expectError(res, 401);
  });

  test('promoção de perfil vale sem novo login: CLIENT promovido a EMPLOYEE já acessa GET /orders', async ({ request }) => {
    const user = await newClient(request);
    await expectError(await request.get('/orders', { headers: bearer(user.token) }), 403);

    const admin = await sessionOf(request, 'admin');
    const patch = await request.patch(`/users/${user.user.id}`, { headers: bearer(admin.token), data: { role: 'EMPLOYEE' } });
    expect(patch.ok(), await patch.text()).toBeTruthy();
    expect((await patch.json()).role).toBe('EMPLOYEE');
    trackStaff(user.user.id);

    // Mesmo token antigo (payload ainda diz CLIENT)
    expect(decodeJwt(user.token).payload.role).toBe('CLIENT');
    const orders = await request.get('/orders', { headers: bearer(user.token) });
    expect(orders.status(), await orders.text()).toBe(200);
    const self = await request.get(`/users/${user.user.id}`, { headers: bearer(user.token) });
    expect((await self.json()).role).toBe('EMPLOYEE');
  });

  test('rebaixamento vale sem novo login: ADMIN rebaixado a CLIENT perde GET /users e não cria contas da equipe', async ({ request }) => {
    const tempAdmin = await newUserWithRole(request, 'ADMIN');
    expect((await request.get('/users', { headers: bearer(tempAdmin.token) })).status()).toBe(200);

    const admin = await sessionOf(request, 'admin');
    const patch = await request.patch(`/users/${tempAdmin.user.id}`, { headers: bearer(admin.token), data: { role: 'CLIENT' } });
    expect(patch.ok(), await patch.text()).toBeTruthy();

    await expectError(await request.get('/users', { headers: bearer(tempAdmin.token) }), 403);
    const staff = await request.post('/users', {
      headers: bearer(tempAdmin.token),
      data: { name: 'Tentativa', email: `rebaixado-${Date.now()}@e2e.test`, password: STRONG_PASSWORD, role: 'KITCHEN' },
    });
    await expectError(staff, 403);
  });

  test('rebaixamento de KITCHEN para CLIENT bloqueia GET /orders na hora', async ({ request }) => {
    const kitchen = await newUserWithRole(request, 'KITCHEN');
    expect((await request.get('/orders', { headers: bearer(kitchen.token) })).status()).toBe(200);

    const admin = await sessionOf(request, 'admin');
    const patch = await request.patch(`/users/${kitchen.user.id}`, { headers: bearer(admin.token), data: { role: 'CLIENT' } });
    expect(patch.ok(), await patch.text()).toBeTruthy();

    await expectError(await request.get('/orders', { headers: bearer(kitchen.token) }), 403);
  });

  test('conta restaurada da lixeira volta a entrar', async ({ request }) => {
    const client = await newClient(request);
    const admin = await sessionOf(request, 'admin');
    expect((await request.delete(`/users/${client.user.id}`, { headers: bearer(admin.token) })).ok()).toBeTruthy();
    await expectError(await request.post('/auth/login', { data: { email: client.email, password: client.password } }), 401);

    const restore = await request.patch(`/users/${client.user.id}/restore`, { headers: bearer(admin.token) });
    expect(restore.ok(), await restore.text()).toBeTruthy();

    const res = await request.post('/auth/login', { data: { email: client.email, password: client.password } });
    expect(res.ok(), await res.text()).toBeTruthy();
    expect((await res.json()).user.id).toBe(client.user.id);
  });
});

function pick(user: { email: string; password: string }) {
  return { email: user.email, password: user.password };
}

function findPasswordLike(payload: Record<string, unknown>): string[] {
  return Object.keys(payload).filter((key) => /pass|hash/i.test(key));
}
