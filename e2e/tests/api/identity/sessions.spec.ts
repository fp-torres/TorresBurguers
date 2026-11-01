import { test, expect, type APIRequestContext } from '@playwright/test';
import { demoStore, login } from '../../../support/api';
import {
  MISSING_ID,
  STRONG_PASSWORD,
  bearer,
  body,
  decodeJwt,
  expectError,
  newApi,
  newClient,
  sessionOf,
  type TestUser,
} from './helpers';

/**
 * Sessões de acesso (auth_sessions): cada token emitido leva um "jti" e só vale enquanto a sessão dele estiver
 * aberta. POST /auth/logout encerra a sessão do token (o de suporte também encerra o suporte), GET /auth/sessions
 * lista as sessões ativas da própria conta e DELETE /auth/sessions/:id encerra uma delas.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_MESSAGE = /Sessão inválida ou expirada/;
const SUPPORT_ENDED_MESSAGE = /A sessão de suporte terminou ou expirou/;
const SUPPORT_READ_ONLY = /Sessão de suporte é somente leitura/;
const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

interface SessionItem {
  id: number;
  kind: 'USER' | 'SUPPORT';
  current: boolean;
  created_at: string;
  expires_at: string;
  ip: string | null;
  browser: string;
  support_session_id: number | null;
}

async function listSessions(api: APIRequestContext, token: string, query = 'pageSize=100'): Promise<{ items: SessionItem[]; total: number }> {
  const res = await api.get(`/auth/sessions?${query}`, { headers: bearer(token) });
  expect(res.status(), `GET /auth/sessions: ${await res.text()}`).toBe(200);
  return res.json();
}

/** Login com um navegador conhecido (o resumo aparece na lista). */
async function loginWith(api: APIRequestContext, user: TestUser, userAgent = CHROME_WINDOWS): Promise<string> {
  const res = await api.post('/auth/login', {
    data: { email: user.email, password: user.password },
    headers: { 'User-Agent': userAgent },
  });
  expect(res.status(), `login: ${await res.text()}`).toBe(201);
  return (await res.json()).access_token;
}

async function meStatus(api: APIRequestContext, token: string): Promise<number> {
  return (await api.get('/auth/me', { headers: bearer(token) })).status();
}

test.describe('Sessões da própria conta', () => {
  test('o token do login leva um jti; a sessão aparece na lista como a atual, com navegador resumido e IP', async ({ request }) => {
    const client = await newClient(request);
    const token = await loginWith(request, client);
    expect(decodeJwt(token).payload.jti).toMatch(UUID);

    const { items, total } = await listSessions(request, token);
    expect(total).toBe(2); // o login do cadastro (newClient) e este
    expect(items[0]).toMatchObject({ kind: 'USER', current: true, browser: 'Chrome no Windows', support_session_id: null });
    expect(items[0].ip).toBeTruthy();
    expect(new Date(items[0].expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(items.filter((item) => item.current)).toHaveLength(1);
    // Nada de jti nem do User-Agent completo na resposta
    const text = JSON.stringify(items);
    expect(text).not.toContain(decodeJwt(token).payload.jti);
    expect(text).not.toContain('AppleWebKit');
  });

  test('POST /auth/logout: 204, o token deixa de valer (401) e as outras sessões da conta continuam', async ({ request }) => {
    const client = await newClient(request);
    const other = await loginWith(request, client);

    const res = await request.post('/auth/logout', { headers: bearer(client.token) });
    expect(res.status(), await res.text()).toBe(204);
    expect(await res.text()).toBe('');

    await expectError(await request.get('/auth/me', { headers: bearer(client.token) }), 401, SESSION_MESSAGE);
    // De novo com o token encerrado: 401 (nada a encerrar)
    await expectError(await request.post('/auth/logout', { headers: bearer(client.token) }), 401);
    expect(await meStatus(request, other)).toBe(200);
    const { items } = await listSessions(request, other);
    expect(items.map((item) => item.current)).toEqual([true]);
  });

  test('DELETE /auth/sessions/:id encerra outra sessão da conta; a lista e o token acompanham', async ({ request }) => {
    const client = await newClient(request);
    const phone = await loginWith(request, client, 'okhttp/4.9.2');
    const before = await listSessions(request, client.token);
    const phoneSession = before.items.find((item) => item.browser === 'Aplicativo no Android');
    expect(phoneSession, JSON.stringify(before.items)).toBeTruthy();
    expect(phoneSession!.current).toBe(false);

    const res = await request.delete(`/auth/sessions/${phoneSession!.id}`, { headers: bearer(client.token) });
    expect(res.status(), await res.text()).toBe(204);
    await expectError(await request.get('/auth/me', { headers: bearer(phone) }), 401, SESSION_MESSAGE);
    expect(await meStatus(request, client.token)).toBe(200);

    const after = await listSessions(request, client.token);
    expect(after.items.map((item) => item.id)).not.toContain(phoneSession!.id);
    // Idempotente: encerrar de novo a mesma sessão não falha
    expect((await request.delete(`/auth/sessions/${phoneSession!.id}`, { headers: bearer(client.token) })).status()).toBe(204);
  });

  test('encerrar a PRÓPRIA sessão pela lista equivale ao logout', async ({ request }) => {
    const client = await newClient(request);
    const { items } = await listSessions(request, client.token);
    const current = items.find((item) => item.current)!;
    expect((await request.delete(`/auth/sessions/${current.id}`, { headers: bearer(client.token) })).status()).toBe(204);
    expect(await meStatus(request, client.token)).toBe(401);
  });

  test('sessão de outra conta ou inexistente → 404; id inválido → 400; a lista só mostra as da própria conta', async ({ request }) => {
    const alice = await newClient(request);
    const bob = await newClient(request);
    const aliceSessions = await listSessions(request, alice.token);
    const bobSessions = await listSessions(request, bob.token);
    const aliceIds = aliceSessions.items.map((item) => item.id);
    expect(bobSessions.items.some((item) => aliceIds.includes(item.id))).toBe(false);

    await expectError(await request.delete(`/auth/sessions/${aliceIds[0]}`, { headers: bearer(bob.token) }), 404, /Sessão não encontrada/);
    expect(await meStatus(request, alice.token), 'a sessão da outra conta continua valendo').toBe(200);
    await expectError(await request.delete(`/auth/sessions/${MISSING_ID}`, { headers: bearer(bob.token) }), 404);
    await expectError(await request.delete('/auth/sessions/abc', { headers: bearer(bob.token) }), 400);
    await expectError(await request.get('/auth/sessions?page=0', { headers: bearer(bob.token) }), 400);
  });

  test('sem token → 401 em todas as rotas de sessão', async ({ request }) => {
    await expectError(await request.post('/auth/logout'), 401);
    await expectError(await request.get('/auth/sessions'), 401);
    await expectError(await request.delete('/auth/sessions/1'), 401);
  });

  test('POST /auth/logout-all encerra todas as sessões registradas; um login novo aparece sozinho na lista', async ({ request }) => {
    const client = await newClient(request);
    const second = await loginWith(request, client);
    expect((await request.post('/auth/logout-all', { headers: bearer(second) })).status()).toBe(204);
    expect(await meStatus(request, client.token)).toBe(401);
    expect(await meStatus(request, second)).toBe(401);

    const fresh = await login(request, client.email, client.password);
    const { items, total } = await listSessions(request, fresh.token);
    expect(total).toBe(1);
    expect(items[0].current).toBe(true);
  });

  test('trocar a própria senha: o token novo tem sessão própria e as sessões antigas saem da lista', async ({ request }) => {
    const client = await newClient(request);
    const old = await loginWith(request, client);
    const res = await request.patch(`/users/${client.user.id}`, {
      headers: bearer(client.token),
      data: { password: `${STRONG_PASSWORD}9`, current_password: client.password },
    });
    const updated = await body(res);
    expect(res.status(), JSON.stringify(updated)).toBe(200);
    expect(decodeJwt(updated.access_token).payload.jti).toMatch(UUID);
    expect(await meStatus(request, old)).toBe(401);

    const { items } = await listSessions(request, updated.access_token);
    expect(items).toHaveLength(1);
    expect(items[0].current).toBe(true);
  });
});

test.describe('Sessão de suporte encerrada pelo próprio token', () => {
  let api: APIRequestContext;
  let saToken: string;
  let storeId: number;

  test.beforeAll(async () => {
    api = await newApi();
    saToken = (await sessionOf(api, 'superadmin')).token;
    storeId = (await demoStore()).id;
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  async function startSupport(): Promise<{ token: string; id: number }> {
    const res = await api.post(`/platform/stores/${storeId}/support-sessions`, {
      headers: bearer(saToken),
      data: { reason: 'Chamado E2E: conferir as sessões de acesso do suporte.' },
    });
    const started = await body(res);
    expect(res.status(), JSON.stringify(started)).toBe(201);
    return { token: started.access_token, id: started.session.id };
  }

  async function supportStatus(id: number): Promise<string> {
    const res = await api.get(`/platform/support-sessions?store_id=${storeId}&pageSize=100`, { headers: bearer(saToken) });
    const { items } = await res.json();
    return (items as Array<{ id: number; status: string }>).find((item) => item.id === id)?.status ?? 'NOT_FOUND';
  }

  test('o token de suporte leva jti e sid; a sessão aparece (SUPPORT) nas sessões do superadmin', async () => {
    const support = await startSupport();
    const claims = decodeJwt(support.token).payload;
    expect(claims).toMatchObject({ sid: support.id });
    expect(claims.jti).toMatch(UUID);

    const { items } = await listSessions(api, saToken);
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'SUPPORT', support_session_id: support.id, current: false })]));
    // Com o próprio token de suporte, a lista é a da conta do superadmin, com a sessão de suporte como a atual
    const own = await listSessions(api, support.token);
    expect(own.items.find((item) => item.current)).toMatchObject({ kind: 'SUPPORT', support_session_id: support.id });

    expect((await api.post('/auth/logout', { headers: bearer(support.token) })).status()).toBe(204);
  });

  test('POST /auth/logout com o token de suporte encerra a sessão de suporte (auditado) sem o token do superpainel', async () => {
    const support = await startSupport();
    expect(await supportStatus(support.id)).toBe('ACTIVE');

    const res = await api.post('/auth/logout', { headers: bearer(support.token) });
    expect(res.status(), await res.text()).toBe(204);

    await expectError(await api.get('/auth/me', { headers: bearer(support.token) }), 401, SUPPORT_ENDED_MESSAGE);
    expect(await supportStatus(support.id)).toBe('ENDED');
    expect(await meStatus(api, saToken), 'o token do superpainel continua valendo').toBe(200);

    const audit = await api.get(
      `/platform/audit?action=platform.support_session.end&target_type=support_session&target_id=${support.id}`,
      { headers: bearer(saToken) },
    );
    const { items } = await audit.json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ result: 'SUCCESS', metadata: expect.objectContaining({ via: 'logout', support_session_id: support.id }) });
  });

  test('o token de suporte continua somente leitura nas outras rotas de sessão (encerrar outra sessão, sair de todas)', async () => {
    const support = await startSupport();
    const { items } = await listSessions(api, saToken);
    const target = items.find((item) => item.current)!;
    await expectError(await api.delete(`/auth/sessions/${target.id}`, { headers: bearer(support.token) }), 403, SUPPORT_READ_ONLY);
    await expectError(await api.post('/auth/logout-all', { headers: bearer(support.token) }), 403, SUPPORT_READ_ONLY);
    expect(await meStatus(api, saToken)).toBe(200);
    expect((await api.post('/auth/logout', { headers: bearer(support.token) })).status()).toBe(204);
  });

  test('encerrar a sessão SUPPORT pela lista do superadmin derruba o token de suporte e encerra o suporte', async () => {
    const support = await startSupport();
    const { items } = await listSessions(api, saToken);
    const session = items.find((item) => item.support_session_id === support.id)!;

    const res = await api.delete(`/auth/sessions/${session.id}`, { headers: bearer(saToken) });
    expect(res.status(), await res.text()).toBe(204);
    await expectError(await api.get('/auth/me', { headers: bearer(support.token) }), 401, SUPPORT_ENDED_MESSAGE);
    expect(await supportStatus(support.id)).toBe('ENDED');
  });

  test('suporte encerrado pelo superpainel: o token cai e a sessão sai da lista', async () => {
    const support = await startSupport();
    expect((await api.post(`/platform/support-sessions/${support.id}/end`, { headers: bearer(saToken) })).status()).toBe(200);
    await expectError(await api.get('/auth/me', { headers: bearer(support.token) }), 401, SUPPORT_ENDED_MESSAGE);
    const { items } = await listSessions(api, saToken);
    expect(items.some((item) => item.support_session_id === support.id)).toBe(false);
  });
});
