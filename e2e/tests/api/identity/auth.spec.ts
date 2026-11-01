import { test, expect, type APIRequestContext } from '@playwright/test';
import { login } from '../../../support/api';
import { E2E } from '../../../support/env';
import { DEFAULT_USERS, type DefaultUserKey } from '../../../support/users';
import {
  MISSING_ID,
  STRONG_PASSWORD,
  bearer,
  body,
  corruptSignature,
  decodeJwt,
  demoStore,
  expectContractErrorShape,
  expectError,
  expectNoSecrets,
  foreignSignedToken,
  newClient,
  newUserWithRole,
  platformAccount,
  pngFile,
  sessionOf,
  tamperPayload,
  uniqueEmail,
  unsignedToken,
  cleanupTrackedStaff,
} from './helpers';

test.afterAll(cleanupTrackedStaff);

const SEVEN_DAYS_IN_SECONDS = 7 * 24 * 60 * 60;

/** SessionUser: respostas de conta montadas por lista de campos permitidos (docs/saas/arquitetura.md §5.1). */
const SESSION_USER_KEYS = [
  'avatar',
  'created_at',
  'email',
  'id',
  'name',
  'phone',
  'platform_role',
  'role',
  'store',
  'store_id',
  'updated_at',
];
const SESSION_STORE_KEYS = ['account_status', 'id', 'logo', 'name', 'primary_color', 'slug'];
const STAFF_KEYS: DefaultUserKey[] = ['admin', 'kitchen', 'courier', 'employee'];

/** Gera pelo superpainel um link de redefinição para a conta e devolve o código do link. */
async function resetTokenFor(request: APIRequestContext, userId: number): Promise<string> {
  const superadmin = await sessionOf(request, 'superadmin');
  const res = await request.post(`/platform/users/${userId}/password-reset`, { headers: bearer(superadmin.token) });
  expect(res.status(), `link de redefinição: ${await res.text()}`).toBe(200);
  const { url } = await res.json();
  expect(url, 'o link aponta para a página de redefinição da web').toMatch(
    new RegExp(`^${E2E.webURL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/redefinir-senha/[A-Za-z0-9_-]{32,128}$`),
  );
  return String(url).split('/').pop() as string;
}

test.describe('Login (POST /auth/login)', () => {
  for (const key of Object.keys(DEFAULT_USERS) as DefaultUserKey[]) {
    const user = DEFAULT_USERS[key];
    test(`usuário padrão ${key} (${user.role}) entra e recebe access_token e a sessão sem senha`, async ({ request }) => {
      const store = await demoStore();
      const res = await request.post('/auth/login', { data: { email: user.email, password: user.password } });
      expect(res.ok(), await res.text()).toBeTruthy();
      const payload = await body(res);

      expect(Object.keys(payload).sort()).toEqual(['access_token', 'user']);
      expect(payload.access_token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
      expect(payload.user).toMatchObject({ email: user.email, role: user.role, name: user.name });
      expect(typeof payload.user.id).toBe('number');
      expect(Object.keys(payload.user).sort(), 'SessionUser só com os campos permitidos').toEqual(SESSION_USER_KEYS);
      expectNoSecrets(payload, `login de ${user.email}`);

      if (STAFF_KEYS.includes(key)) {
        // Equipe: pertence à loja demo; a sessão traz o resumo da loja (sem credenciais)
        expect(payload.user.store_id).toBe(store.id);
        expect(payload.user.platform_role).toBeNull();
        expect(Object.keys(payload.user.store).sort()).toEqual(SESSION_STORE_KEYS);
        expect(payload.user.store).toMatchObject({ id: store.id, slug: E2E.demoStoreSlug, name: store.name, account_status: 'ACTIVE' });
      } else {
        // Cliente e superadmin: contas globais, sem loja
        expect(payload.user.store_id).toBeNull();
        expect(payload.user.store).toBeNull();
        expect(payload.user.platform_role).toBe(key === 'superadmin' ? 'SUPER_ADMIN' : null);
      }
    });
  }

  test('o JWT traz sub, email, role, name e a versão das sessões (tv) e expira em 7 dias (JWT_EXPIRES_IN padrão)', async ({ request }) => {
    const res = await request.post('/auth/login', {
      data: { email: DEFAULT_USERS.employee.email, password: DEFAULT_USERS.employee.password },
    });
    const { access_token, user } = await res.json();
    const { header, payload } = decodeJwt(access_token);

    expect(header.alg).toBe('HS256');
    expect(payload).toMatchObject({ sub: user.id, email: user.email, role: 'EMPLOYEE', name: user.name });
    expect(Number.isInteger(payload.tv), `claim tv: ${JSON.stringify(payload)}`).toBe(true);
    expect(payload.tv).toBeGreaterThanOrEqual(0);
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
    // Conta própria: as falhas contam no limite por IP + e-mail (LOGIN_FAILURES), que não deve atingir o cliente padrão
    const client = await newClient(request);
    for (const attempt of [client.password.toLowerCase(), client.password.toUpperCase(), ` ${client.password}`, `${client.password} `]) {
      const res = await request.post('/auth/login', { data: { email: client.email, password: attempt } });
      expect(res.status(), `senha "${attempt}" não pode entrar`).toBe(401);
    }
  });

  test('10 senhas erradas seguidas na mesma conta (IP + e-mail) → 429 até para a senha certa; outras contas seguem entrando', async ({ request }) => {
    const victim = await newClient(request);
    for (let attempt = 1; attempt <= 10; attempt++) {
      const res = await request.post('/auth/login', { data: { email: victim.email, password: `Errada@${attempt}xyz` } });
      expect(res.status(), `tentativa ${attempt}: ${await res.text()}`).toBe(401);
    }
    // Limite atingido: nem a senha certa entra (o limite é conferido antes da senha)
    const locked = await request.post('/auth/login', { data: { email: victim.email, password: victim.password } });
    const lockedBody = await expectError(locked, 429);
    expect(lockedBody.access_token).toBeUndefined();
    // Mesma regra com o e-mail em outra caixa (a chave é o e-mail normalizado)
    expect((await request.post('/auth/login', { data: { email: victim.email.toUpperCase(), password: victim.password } })).status()).toBe(429);

    // O limite é por conta: outro cliente, do mesmo IP, entra normalmente
    const other = await newClient(request);
    expect((await request.post('/auth/login', { data: { email: other.email, password: other.password } })).status()).toBe(201);
    // Tokens já emitidos da conta bloqueada por tentativas continuam valendo (não é bloqueio da conta)
    expect((await request.get('/addresses', { headers: bearer(victim.token) })).status()).toBe(200);
  });

  test('rajada de logins simultâneos na mesma conta: só 10 senhas são conferidas, as demais → 429 (limite atômico)', async ({ request }) => {
    const victim = await newClient(request);
    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        request.post('/auth/login', { data: { email: victim.email, password: `Chute@${i}xyz` } }),
      ),
    );
    const statuses = responses.map((res) => res.status());
    expect(statuses.filter((status) => status === 401), `status: ${statuses.join(',')}`).toHaveLength(10);
    expect(statuses.filter((status) => status === 429)).toHaveLength(30);
    // A senha certa também fica bloqueada até a janela passar
    expect((await request.post('/auth/login', { data: { email: victim.email, password: victim.password } })).status()).toBe(429);
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

test.describe('Sessão atual (GET /auth/me)', () => {
  test('devolve a própria sessão (SessionUser + support_session) sem segredos', async ({ request }) => {
    const store = await demoStore();
    for (const key of ['admin', 'client', 'superadmin'] as const) {
      const session = await sessionOf(request, key);
      const res = await request.get('/auth/me', { headers: bearer(session.token) });
      expect(res.status(), await res.text()).toBe(200);
      const me = await res.json();
      expect(Object.keys(me).sort()).toEqual([...SESSION_USER_KEYS, 'support_session'].sort());
      expect(me).toMatchObject({ id: session.user.id, email: DEFAULT_USERS[key].email, role: DEFAULT_USERS[key].role, support_session: null });
      expect(me.store_id).toBe(key === 'admin' ? store.id : null);
      expectNoSecrets(me, `GET /auth/me (${key})`);
    }
  });
});

test.describe('Recuperação de senha', () => {
  test('pedir o link responde 202 com a mesma mensagem genérica para conta existente e desconhecida', async ({ request }) => {
    const client = await newClient(request);
    const known = await request.post('/auth/forgot-password', { data: { email: client.email } });
    expect(known.status(), await known.text()).toBe(202);
    const knownBody = await known.json();
    expect(typeof knownBody.message).toBe('string');

    const unknown = await request.post('/auth/forgot-password', { data: { email: uniqueEmail('ninguem') } });
    expect(unknown.status(), await unknown.text()).toBe(202);
    expect(await unknown.json(), 'resposta igual: não revela se o e-mail tem conta').toEqual(knownBody);

    // Pedir o link não troca a senha nem derruba a sessão
    expect((await request.post('/auth/login', { data: { email: client.email, password: client.password } })).status()).toBe(201);
    expect((await request.get('/addresses', { headers: bearer(client.token) })).status()).toBe(200);
  });

  for (const [label, data] of [
    ['sem e-mail', {}],
    ['e-mail mal formatado', { email: 'sem-arroba' }],
    ['campo extra', { email: 'alguem@e2e.test', role: 'ADMIN' }],
  ] as const) {
    test(`pedido de link com corpo inválido (${label}) → 400`, async ({ request }) => {
      await expectError(await request.post('/auth/forgot-password', { data }), 400);
    });
  }

  test('link inválido ou inexistente → 404 na consulta e na redefinição, e a senha não muda', async ({ request }) => {
    const client = await newClient(request);
    const forged = 'A'.repeat(43);
    await expectError(await request.get(`/auth/reset-password/${forged}`), 404);
    await expectError(await request.get('/auth/reset-password/curto'), 404);
    await expectError(await request.post('/auth/reset-password', { data: { token: forged, password: 'NovaSenha#2026' } }), 404);
    expect((await request.post('/auth/login', { data: { email: client.email, password: client.password } })).status()).toBe(201);
  });

  test('link gerado pelo superpainel: consulta mascarada, redefine uma única vez e encerra as sessões abertas', async ({ request }) => {
    const client = await newClient(request);
    const token = await resetTokenFor(request, client.user.id);

    const info = await request.get(`/auth/reset-password/${token}`);
    expect(info.status(), await info.text()).toBe(200);
    const view = await info.json();
    expect(Object.keys(view).sort()).toEqual(['email_masked', 'expires_at']);
    expect(view.email_masked).not.toBe(client.email);
    expect(Date.parse(view.expires_at)).toBeGreaterThan(Date.now());

    const newPassword = 'Redefinida#2026';
    const reset = await request.post('/auth/reset-password', { data: { token, password: newPassword } });
    expect(reset.status(), await reset.text()).toBe(200);
    expect(typeof (await reset.json()).message).toBe('string');

    // Sessões antigas encerradas; só a senha nova entra
    await expectError(await request.get('/addresses', { headers: bearer(client.token) }), 401);
    expect((await request.post('/auth/login', { data: { email: client.email, password: client.password } })).status()).toBe(401);
    const relogin = await login(request, client.email, newPassword);
    expect(relogin.user.id).toBe(client.user.id);

    // Uso único: o mesmo link não vale de novo
    await expectError(await request.get(`/auth/reset-password/${token}`), 404);
    await expectError(await request.post('/auth/reset-password', { data: { token, password: 'OutraSenha#2026' } }), 404);
    expect((await request.post('/auth/login', { data: { email: client.email, password: newPassword } })).status()).toBe(201);
  });

  test('nova senha fora da política → 400 e o link continua valendo', async ({ request }) => {
    const client = await newClient(request);
    const token = await resetTokenFor(request, client.user.id);
    await expectError(await request.post('/auth/reset-password', { data: { token, password: 'fraca' } }), 400);
    expect((await request.get(`/auth/reset-password/${token}`)).status()).toBe(200);
    expect((await request.post('/auth/login', { data: { email: client.email, password: client.password } })).status()).toBe(201);
  });

  test('um link novo invalida o anterior', async ({ request }) => {
    const client = await newClient(request);
    const first = await resetTokenFor(request, client.user.id);
    const second = await resetTokenFor(request, client.user.id);
    await expectError(await request.get(`/auth/reset-password/${first}`), 404);
    expect((await request.get(`/auth/reset-password/${second}`)).status()).toBe(200);
  });

  test('só o superadmin gera links pelo superpainel (ADMIN da loja e cliente → 403)', async ({ request }) => {
    const client = await newClient(request);
    for (const key of ['admin', 'client'] as const) {
      const session = await sessionOf(request, key);
      await expectError(await request.post(`/platform/users/${client.user.id}/password-reset`, { headers: bearer(session.token) }), 403);
    }
  });

  test('rotas inventadas de recuperação não existem (404)', async ({ request }) => {
    for (const path of ['/users/forgot-password', '/auth/recover', '/users/reset-password']) {
      const res = await request.post(path, { data: { email: DEFAULT_USERS.client.email } });
      expect(res.status(), `${path}: ${await res.text()}`).toBe(404);
    }
  });
});

test.describe('Rotas protegidas sem token → 401', () => {
  const routes: Array<[method: 'get' | 'post' | 'patch' | 'delete', path: string, data?: unknown]> = [
    ['get', '/auth/me'],
    ['post', '/auth/logout-all'],
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
    ['get', '/store/settings'],
    ['post', '/maintenance/optimize-images'],
    ['get', '/platform/users'],
    ['get', '/orders'],
    ['get', '/orders/my-orders'],
    ['get', '/orders/reports'],
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

  test('payload alterado para outra versão de sessão (tv) mantendo a assinatura → 401', async ({ request }) => {
    const client = await sessionOf(request, 'client');
    const forged = tamperPayload(client.token, { tv: 999 });
    await expectError(await request.get('/addresses', { headers: bearer(forged) }), 401);
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

  test('401 de credenciais inválidas, 400, 403, 404, 409 e 429 seguem o formato de erro do contrato', async ({ request }) => {
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

    const victim = await newClient(request);
    for (let attempt = 0; attempt < 10; attempt++) {
      await request.post('/auth/login', { data: { email: victim.email, password: 'Errada@12345' } });
    }
    const limited = await request.post('/auth/login', { data: { email: victim.email, password: victim.password } });
    expect(limited.status()).toBe(429);
    expectContractErrorShape(await body(limited), 429);
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

  test('troca de perfil pelo ADMIN encerra as sessões do membro; no novo login vale o perfil novo (KITCHEN → EMPLOYEE)', async ({ request }) => {
    const member = await newUserWithRole(request, 'KITCHEN');
    await expectError(await request.get('/orders/drivers/list', { headers: bearer(member.token) }), 403);

    const admin = await sessionOf(request, 'admin');
    const patch = await request.patch(`/users/${member.user.id}`, { headers: bearer(admin.token), data: { role: 'EMPLOYEE' } });
    expect(patch.ok(), await patch.text()).toBeTruthy();
    expect((await patch.json()).role).toBe('EMPLOYEE');

    // O token antigo (perfil KITCHEN) deixa de valer na hora
    await expectError(await request.get('/orders', { headers: bearer(member.token) }), 401);
    const relogin = await login(request, member.email, member.password);
    expect(relogin.user.role).toBe('EMPLOYEE');
    expect(decodeJwt(relogin.token).payload.tv).toBeGreaterThan(decodeJwt(member.token).payload.tv ?? 0);
    expect((await request.get('/orders/drivers/list', { headers: bearer(relogin.token) })).status()).toBe(200);
  });

  test('cliente não é promovido a equipe: PATCH de perfil pelo ADMIN → 404 e o cliente continua sem acesso ao painel', async ({ request }) => {
    const user = await newClient(request);
    await expectError(await request.get('/orders', { headers: bearer(user.token) }), 403);

    const admin = await sessionOf(request, 'admin');
    await expectError(
      await request.patch(`/users/${user.user.id}`, { headers: bearer(admin.token), data: { role: 'EMPLOYEE' } }),
      404,
    );
    await expectError(await request.get('/orders', { headers: bearer(user.token) }), 403);
    const self = await request.get(`/users/${user.user.id}`, { headers: bearer(user.token) });
    expect((await self.json())).toMatchObject({ role: 'CLIENT', store_id: null });
  });

  test('rebaixamento encerra as sessões: ADMIN rebaixado a EMPLOYEE perde GET /users e não cria contas da equipe', async ({ request }) => {
    const tempAdmin = await newUserWithRole(request, 'ADMIN');
    expect((await request.get('/users', { headers: bearer(tempAdmin.token) })).status()).toBe(200);

    const admin = await sessionOf(request, 'admin');
    const patch = await request.patch(`/users/${tempAdmin.user.id}`, { headers: bearer(admin.token), data: { role: 'EMPLOYEE' } });
    expect(patch.ok(), await patch.text()).toBeTruthy();

    await expectError(await request.get('/users', { headers: bearer(tempAdmin.token) }), 401);
    const demoted = await login(request, tempAdmin.email, tempAdmin.password);
    expect(demoted.user.role).toBe('EMPLOYEE');
    await expectError(await request.get('/users', { headers: bearer(demoted.token) }), 403);
    const staff = await request.post('/users', {
      headers: bearer(demoted.token),
      data: { name: 'Tentativa', email: uniqueEmail('rebaixado'), password: STRONG_PASSWORD, role: 'KITCHEN' },
    });
    await expectError(staff, 403);
  });

  test('a equipe não tem perfil de cliente: ADMIN não rebaixa KITCHEN a CLIENT (400) e o acesso continua', async ({ request }) => {
    const kitchen = await newUserWithRole(request, 'KITCHEN');
    expect((await request.get('/orders', { headers: bearer(kitchen.token) })).status()).toBe(200);

    const admin = await sessionOf(request, 'admin');
    await expectError(
      await request.patch(`/users/${kitchen.user.id}`, { headers: bearer(admin.token), data: { role: 'CLIENT' } }),
      400,
    );
    expect((await request.get('/orders', { headers: bearer(kitchen.token) })).status()).toBe(200);
    expect((await request.get(`/users/${kitchen.user.id}`, { headers: bearer(kitchen.token) })).ok()).toBeTruthy();
  });

  test('membro da equipe restaurado da lixeira volta a entrar', async ({ request }) => {
    const member = await newUserWithRole(request, 'COURIER');
    const admin = await sessionOf(request, 'admin');
    expect((await request.delete(`/users/${member.user.id}`, { headers: bearer(admin.token) })).ok()).toBeTruthy();
    await expectError(await request.post('/auth/login', { data: { email: member.email, password: member.password } }), 401);

    const restore = await request.patch(`/users/${member.user.id}/restore`, { headers: bearer(admin.token) });
    expect(restore.ok(), await restore.text()).toBeTruthy();

    const res = await request.post('/auth/login', { data: { email: member.email, password: member.password } });
    expect(res.ok(), await res.text()).toBeTruthy();
    expect((await res.json()).user.id).toBe(member.user.id);
  });

  test('conta de cliente não é excluída nem restaurada pelo ADMIN da loja (404): clientes são geridos pelo superpainel', async ({ request }) => {
    const client = await newClient(request);
    const admin = await sessionOf(request, 'admin');
    await expectError(await request.delete(`/users/${client.user.id}`, { headers: bearer(admin.token) }), 404);
    await expectError(await request.patch(`/users/${client.user.id}/restore`, { headers: bearer(admin.token) }), 404);
    expect((await request.post('/auth/login', { data: { email: client.email, password: client.password } })).ok()).toBeTruthy();
    expect((await platformAccount(request, client.user.id)).deleted_at ?? null).toBeNull();
  });
});

test.describe('Encerrar sessões', () => {
  test('sair de todos os dispositivos (POST /auth/logout-all) derruba todos os tokens da conta', async ({ request }) => {
    const client = await newClient(request);
    const second = await login(request, client.email, client.password);
    expect((await request.get('/addresses', { headers: bearer(second.token) })).status()).toBe(200);

    const res = await request.post('/auth/logout-all', { headers: bearer(client.token) });
    expect(res.status(), await res.text()).toBe(204);

    for (const token of [client.token, second.token]) {
      await expectError(await request.get('/addresses', { headers: bearer(token) }), 401);
    }
    const fresh = await login(request, client.email, client.password);
    expect((await request.get('/addresses', { headers: bearer(fresh.token) })).status()).toBe(200);
  });

  test('trocar a própria senha devolve um access_token novo e encerra as outras sessões', async ({ request }) => {
    const client = await newClient(request);
    const other = await login(request, client.email, client.password);

    const res = await request.patch(`/users/${client.user.id}`, {
      headers: bearer(client.token),
      data: { password: 'TrocaPropria#2026' },
    });
    expect(res.status(), await res.text()).toBe(200);
    const updated = await res.json();
    expect(typeof updated.access_token, 'token novo na resposta').toBe('string');
    expectNoSecrets(updated, 'PATCH com troca da própria senha');

    for (const token of [client.token, other.token]) {
      await expectError(await request.get('/addresses', { headers: bearer(token) }), 401);
    }
    expect((await request.get('/addresses', { headers: bearer(updated.access_token) })).status()).toBe(200);
    expect(decodeJwt(updated.access_token).payload.tv).toBe((decodeJwt(client.token).payload.tv ?? 0) + 1);
  });

  test('trocar o próprio e-mail também devolve um token novo e encerra as outras sessões', async ({ request }) => {
    const client = await newClient(request);
    const res = await request.patch(`/users/${client.user.id}`, {
      headers: bearer(client.token),
      data: { email: uniqueEmail('troca-email') },
    });
    expect(res.status(), await res.text()).toBe(200);
    const updated = await res.json();
    expect(typeof updated.access_token).toBe('string');
    await expectError(await request.get('/addresses', { headers: bearer(client.token) }), 401);
    expect((await request.get('/addresses', { headers: bearer(updated.access_token) })).status()).toBe(200);
  });

  test('editar só nome e telefone não troca o token nem encerra sessões', async ({ request }) => {
    const client = await newClient(request);
    const res = await request.patch(`/users/${client.user.id}`, {
      headers: bearer(client.token),
      data: { name: 'Sem Troca de Token', phone: '21911112222' },
    });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).access_token).toBeUndefined();
    expect((await request.get('/addresses', { headers: bearer(client.token) })).status()).toBe(200);
  });
});

test.describe('Conta bloqueada pelo superpainel', () => {
  test('login com a senha certa → 403; senha errada continua 401; tokens abertos → 401; o desbloqueio devolve o acesso', async ({ request }) => {
    const client = await newClient(request);
    const superadmin = await sessionOf(request, 'superadmin');

    const block = await request.post(`/platform/users/${client.user.id}/block`, {
      headers: bearer(superadmin.token),
      data: { reason: 'Bloqueio do teste E2E' },
    });
    expect(block.status(), await block.text()).toBe(200);

    const blocked = await request.post('/auth/login', { data: { email: client.email, password: client.password } });
    const blockedBody = await expectError(blocked, 403, /bloqueada/i);
    expect(blockedBody.access_token).toBeUndefined();
    // A situação da conta só aparece depois da senha certa (senha errada não revela o bloqueio)
    const wrong = await request.post('/auth/login', { data: { email: client.email, password: 'Errada@12345' } });
    const wrongBody = await expectError(wrong, 401);
    expect(wrongBody.message).not.toMatch(/bloquead/i);
    await expectError(await request.get('/addresses', { headers: bearer(client.token) }), 401);

    const unblock = await request.post(`/platform/users/${client.user.id}/unblock`, { headers: bearer(superadmin.token) });
    expect(unblock.status(), await unblock.text()).toBe(200);
    const again = await request.post('/auth/login', { data: { email: client.email, password: client.password } });
    expect(again.status(), await again.text()).toBe(201);
  });

  test('ADMIN da loja não bloqueia contas (rota exclusiva do superpainel → 403)', async ({ request }) => {
    const client = await newClient(request);
    const admin = await sessionOf(request, 'admin');
    await expectError(
      await request.post(`/platform/users/${client.user.id}/block`, { headers: bearer(admin.token), data: { reason: 'Tentativa' } }),
      403,
    );
    expect((await request.post('/auth/login', { data: { email: client.email, password: client.password } })).status()).toBe(201);
  });
});

function pick(user: { email: string; password: string }) {
  return { email: user.email, password: user.password };
}

function findPasswordLike(payload: Record<string, unknown>): string[] {
  return Object.keys(payload).filter((key) => /pass|hash/i.test(key));
}
