import { test, expect, type APIRequestContext } from '@playwright/test';
import { E2E } from '../../../support/env';
import { DEFAULT_USERS } from '../../../support/users';
import { demoStore } from '../../../support/api';
import { STRONG_PASSWORD, bearer, body, decodeJwt, newApi, newClient, sessionOf, uniqueEmail, type TestUser } from './helpers';

/**
 * Sessão do site em cookie (plano refresh-token): só quem pede (X-Auth-Transport: cookie, enviado só pelo site)
 * recebe o token de acesso curto e o refresh num cookie HttpOnly; o app mobile e as integrações seguem iguais.
 *
 * As chamadas com cookie usam o fetch do Node (sem pote de cookies): cada teste escolhe exatamente o cookie,
 * o Origin e o Sec-Fetch-Site enviados, como um navegador faria. A API de teste roda com
 * AUTH_REFRESH_GRACE_SECONDS=3 (playwright.config.ts).
 */

const WEB = E2E.webURL;
const COOKIE_NAME = 'comestra_rt';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REFRESH_VALUE = /^v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const SESSION_MESSAGE = 'Sessão inválida ou expirada. Faça login novamente.';
const ORIGIN_MESSAGE = 'Origem não autorizada para a sessão deste navegador.';
const SUPPORT_OPEN_MESSAGE = 'Há uma sessão de suporte aberta a partir desta sessão. Encerre-a para voltar ao superpainel.';
const GRACE_MS = 3_000;

interface WebResponse {
  status: number;
  json: any;
  /** Linhas Set-Cookie do refresh. */
  cookies: string[];
  headers: Headers;
}

interface WebOptions {
  cookie?: string | null;
  origin?: string | null;
  site?: string;
  transport?: boolean;
  token?: string;
  data?: unknown;
  method?: string;
}

/** Chamada "do navegador do site": cabeçalho do transporte, Origin do site e o cookie escolhido. */
async function web(path: string, options: WebOptions = {}): Promise<WebResponse> {
  const headers: Record<string, string> = {};
  if (options.transport !== false) headers['X-Auth-Transport'] = 'cookie';
  if (options.origin !== null) headers.Origin = options.origin ?? WEB;
  if (options.site) headers['Sec-Fetch-Site'] = options.site;
  if (options.cookie) headers.Cookie = `${COOKIE_NAME}=${options.cookie}`;
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.data !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${E2E.apiURL}${path}`, {
    method: options.method ?? 'POST',
    headers,
    body: options.data === undefined ? undefined : JSON.stringify(options.data),
  });
  const text = await res.text();
  let json: any = text;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // corpo não-JSON
  }
  const cookies = res.headers.getSetCookie().filter((line) => line.startsWith(`${COOKIE_NAME}=`));
  return { status: res.status, json, cookies, headers: res.headers };
}

/** Valor do refresh num Set-Cookie (falha se não houver). */
function cookieValue(response: WebResponse): string {
  expect(response.cookies, `Set-Cookie do refresh: ${JSON.stringify(response.json)}`).toHaveLength(1);
  return /^comestra_rt=([^;]*)/.exec(response.cookies[0])![1];
}

/** A resposta apaga o cookie do refresh. */
function expectCleared(response: WebResponse): void {
  expect(response.cookies).toEqual([expect.stringMatching(/^comestra_rt=; Path=\/; Expires=Thu, 01 Jan 1970/)]);
}

interface CookieLogin {
  token: string;
  cookie: string;
  jti: string;
  response: WebResponse;
}

async function cookieLogin(email: string, password: string, cookie?: string): Promise<CookieLogin> {
  const response = await web('/auth/login', { data: { email, password }, cookie });
  expect(response.status, JSON.stringify(response.json)).toBe(201);
  const token = response.json.access_token as string;
  return { token, cookie: cookieValue(response), jti: decodeJwt(token).payload.jti, response };
}

async function meStatus(api: APIRequestContext, token: string): Promise<number> {
  return (await api.get('/auth/me', { headers: bearer(token) })).status();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.describe('Sessão do site em cookie: emissão', () => {
  let api: APIRequestContext;
  let client: TestUser;

  test.beforeAll(async () => {
    api = await newApi();
    client = await newClient(api);
  });
  test.afterAll(async () => {
    await api.dispose();
  });

  test('login com o cabeçalho: refresh no cookie HttpOnly, SameSite=Strict, Path=/, sem Domain, até o fim da sessão', async () => {
    const login = await cookieLogin(client.email, client.password);
    const [line] = login.response.cookies;
    expect(login.cookie).toMatch(REFRESH_VALUE);
    expect(line).toMatch(/; HttpOnly/);
    expect(line).toMatch(/; SameSite=Strict/);
    expect(line).toMatch(/; Path=\//);
    // API de teste em http (NODE_ENV=test): sem Secure e sem o prefixo __Host-
    expect(line).not.toMatch(/Domain|Secure/i);
    const maxAge = Number(/Max-Age=(\d+)/.exec(line)?.[1]);
    expect(maxAge).toBeGreaterThan(7 * 86_400 - 60);
    expect(maxAge).toBeLessThanOrEqual(7 * 86_400);
    // O valor do cookie nunca vai no corpo
    expect(JSON.stringify(login.response.json)).not.toContain(login.cookie.split('.')[2]);
    // Credenciais só para a origem do site, com a origem exata
    expect(login.response.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(login.response.headers.get('access-control-allow-credentials')).toBe('true');
  });

  test('login com o cabeçalho: token de acesso de ~15 min com jti e os campos aditivos session_transport e expires_in', async () => {
    const login = await cookieLogin(client.email, client.password);
    expect(login.response.json).toMatchObject({
      access_token: expect.any(String),
      user: expect.objectContaining({ id: client.user.id, email: client.email }),
      session_transport: 'cookie',
      expires_in: 900,
    });
    const claims = decodeJwt(login.token).payload;
    expect(claims.exp - claims.iat).toBe(900);
    expect(claims.jti).toMatch(UUID);
    expect(await meStatus(api, login.token)).toBe(200);
  });

  test('login SEM o cabeçalho (contrato do app mobile): { access_token, user }, token de 7 dias e nenhum Set-Cookie', async () => {
    const res = await web('/auth/login', { transport: false, origin: null, data: { email: client.email, password: client.password } });
    expect(res.status).toBe(201);
    expect(Object.keys(res.json).sort()).toEqual(['access_token', 'user']);
    expect(res.headers.getSetCookie()).toEqual([]);
    const claims = decodeJwt(res.json.access_token).payload;
    expect(claims.exp - claims.iat).toBe(7 * 86_400);
    expect(claims.jti).toMatch(UUID);
  });

  test('login com o cabeçalho, mas cross-site ou de outra origem: o corpo de hoje + session_transport "bearer", sem cookie', async () => {
    for (const options of [{ site: 'cross-site' }, { origin: 'https://outro-site.example' }]) {
      const res = await web('/auth/login', { ...options, data: { email: client.email, password: client.password } });
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      expect(Object.keys(res.json).sort()).toEqual(['access_token', 'session_transport', 'user']);
      expect(res.json.session_transport).toBe('bearer');
      expect(res.headers.getSetCookie()).toEqual([]);
      const claims = decodeJwt(res.json.access_token).payload;
      expect(claims.exp - claims.iat).toBe(7 * 86_400);
    }
  });

  test('preflight: a origem do site recebe credenciais e libera o cabeçalho; outra origem não recebe credenciais', async () => {
    const preflight = (origin: string) =>
      fetch(`${E2E.apiURL}/auth/web/refresh`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-auth-transport' },
      });
    const allowed = await preflight(WEB);
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
    expect(allowed.headers.get('access-control-allow-headers')).toBe('x-auth-transport');
    const other = await preflight('https://outro-site.example');
    expect(other.headers.get('access-control-allow-credentials')).toBeNull();
  });
});

test.describe('Sessão do site em cookie: renovação', () => {
  let api: APIRequestContext;
  let client: TestUser;

  test.beforeAll(async () => {
    api = await newApi();
    client = await newClient(api);
  });
  test.afterAll(async () => {
    await api.dispose();
  });

  test('refresh: token novo com o MESMO jti, ~15 min, e o cookie rotacionado (mesmo seletor, validador novo)', async () => {
    const login = await cookieLogin(client.email, client.password);
    const res = await web('/auth/web/refresh', { cookie: login.cookie });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({
      session_transport: 'cookie',
      expires_in: 900,
      user: expect.objectContaining({ id: client.user.id }),
    });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const claims = decodeJwt(res.json.access_token).payload;
    expect(claims.jti).toBe(login.jti);
    expect(claims.exp - claims.iat).toBe(900);
    expect(await meStatus(api, res.json.access_token)).toBe(200);

    const rotated = cookieValue(res);
    expect(rotated).toMatch(REFRESH_VALUE);
    expect(rotated).not.toBe(login.cookie);
    expect(rotated.split('.')[1]).toBe(login.cookie.split('.')[1]);
    // O novo cookie renova de novo
    expect((await web('/auth/web/refresh', { cookie: rotated })).status).toBe(200);
  });

  test('a família aparece UMA vez em "Sessões ativas", como a atual, depois de várias renovações', async () => {
    const login = await cookieLogin(client.email, client.password);
    let cookie = login.cookie;
    let token = login.token;
    for (let i = 0; i < 3; i++) {
      const res = await web('/auth/web/refresh', { cookie });
      expect(res.status).toBe(200);
      cookie = cookieValue(res);
      token = res.json.access_token;
    }
    const list = await (await api.get('/auth/sessions?pageSize=100', { headers: bearer(token) })).json();
    const current = list.items.filter((item: { current: boolean }) => item.current);
    expect(current).toHaveLength(1);
    const ids = list.items.map((item: { id: number }) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('cookie anterior dentro da tolerância → 200 sem Set-Cookie; depois dela → reuso: 401, família encerrada e auditada', async () => {
    const login = await cookieLogin(client.email, client.password);
    const first = await web('/auth/web/refresh', { cookie: login.cookie });
    expect(first.status).toBe(200);
    const latestToken = first.json.access_token as string;

    // Corrida entre abas / resposta perdida: o cookie anterior ainda vale por alguns segundos
    const grace = await web('/auth/web/refresh', { cookie: login.cookie });
    expect(grace.status).toBe(200);
    expect(grace.cookies).toEqual([]);
    expect(decodeJwt(grace.json.access_token).payload.jti).toBe(login.jti);

    const sessionId = (await (await api.get('/auth/sessions?pageSize=100', { headers: bearer(latestToken) })).json()).items.find(
      (item: { current: boolean }) => item.current,
    ).id;

    await sleep(GRACE_MS + 700);
    const reuse = await web('/auth/web/refresh', { cookie: login.cookie });
    expect(reuse.status).toBe(401);
    expect(reuse.json.message).toBe(SESSION_MESSAGE);
    expectCleared(reuse);
    // A família inteira caiu: o cookie atual e os tokens de acesso já emitidos
    expect((await web('/auth/web/refresh', { cookie: cookieValue(first) })).status).toBe(401);
    expect(await meStatus(api, latestToken)).toBe(401);
    expect(await meStatus(api, login.token)).toBe(401);

    const superadmin = await sessionOf(api, 'superadmin');
    const audit = await (
      await api.get(`/platform/audit?action=auth.refresh.reuse&target_type=auth_session&target_id=${sessionId}`, {
        headers: bearer(superadmin.token),
      })
    ).json();
    expect(audit.items).toEqual([
      expect.objectContaining({ action: 'auth.refresh.reuse', result: 'DENIED', metadata: { generation: 1 } }),
    ]);
  });

  test('sem cookie, cookie malformado ou de seletor desconhecido → 401 apagando o cookie', async () => {
    const unknown = `v1.${'A'.repeat(22)}.${'B'.repeat(43)}`;
    for (const cookie of [null, 'lixo', 'v1.curto.curto', unknown]) {
      const res = await web('/auth/web/refresh', { cookie });
      expect(res.status, String(cookie)).toBe(401);
      expect(res.json.message).toBe(SESSION_MESSAGE);
      expectCleared(res);
    }
  });

  test('sem o cabeçalho (app mobile), de outra origem ou cross-site → 403 nas duas rotas, sem tocar no cookie', async () => {
    const login = await cookieLogin(client.email, client.password);
    for (const path of ['/auth/web/refresh', '/auth/web/logout']) {
      for (const options of [
        { transport: false },
        { origin: 'https://outro-site.example' },
        { origin: 'null' },
        { site: 'cross-site' },
      ] as WebOptions[]) {
        const res = await web(path, { ...options, cookie: login.cookie });
        expect(res.status, `${path} ${JSON.stringify(options)}`).toBe(403);
        expect(res.json.message).toBe(ORIGIN_MESSAGE);
        expect(res.cookies).toEqual([]);
      }
    }
    // Nada disso encerrou a sessão
    expect((await web('/auth/web/refresh', { cookie: login.cookie })).status).toBe(200);
  });
});

test.describe('Sessão do site em cookie: saída e encerramento', () => {
  let api: APIRequestContext;
  let client: TestUser;

  test.beforeAll(async () => {
    api = await newApi();
    client = await newClient(api);
  });
  test.afterAll(async () => {
    await api.dispose();
  });

  test('POST /auth/web/logout: 204 apagando o cookie, a família cai (refresh e token) e repetir continua 204', async () => {
    const login = await cookieLogin(client.email, client.password);
    const out = await web('/auth/web/logout', { cookie: login.cookie });
    expect(out.status).toBe(204);
    expectCleared(out);
    expect((await web('/auth/web/refresh', { cookie: login.cookie })).status).toBe(401);
    expect(await meStatus(api, login.token)).toBe(401);
    expect((await web('/auth/web/logout', { cookie: login.cookie })).status).toBe(204);
    expect((await web('/auth/web/logout')).status).toBe(204);
  });

  test('POST /auth/logout com o token da sessão em cookie (e o cabeçalho): 204, cookie apagado e o refresh cai', async () => {
    const login = await cookieLogin(client.email, client.password);
    const out = await web('/auth/logout', { token: login.token, cookie: login.cookie });
    expect(out.status).toBe(204);
    expectCleared(out);
    expect((await web('/auth/web/refresh', { cookie: login.cookie })).status).toBe(401);

    // Sem o cabeçalho (app mobile): mesmo contrato de sempre, sem Set-Cookie
    const mobile = await cookieLogin(client.email, client.password);
    const plain = await web('/auth/logout', { token: mobile.token, transport: false });
    expect(plain.status).toBe(204);
    expect(plain.headers.getSetCookie()).toEqual([]);
    expect((await web('/auth/web/refresh', { cookie: mobile.cookie })).status).toBe(401);
  });

  test('DELETE /auth/sessions/:id da sessão em cookie (de outro aparelho) derruba o refresh dela', async () => {
    const browser = await cookieLogin(client.email, client.password);
    const other = await (await api.post('/auth/login', { data: { email: client.email, password: client.password } })).json();
    const list = await (await api.get('/auth/sessions?pageSize=100', { headers: bearer(browser.token) })).json();
    const id = list.items.find((item: { current: boolean }) => item.current).id;
    expect((await api.delete(`/auth/sessions/${id}`, { headers: bearer(other.access_token) })).status()).toBe(204);
    expect((await web('/auth/web/refresh', { cookie: browser.cookie })).status).toBe(401);
  });

  test('POST /auth/logout-all: todas as sessões caem, inclusive o refresh; com o cabeçalho, o cookie é apagado', async () => {
    const user = await newClient(api);
    const login = await cookieLogin(user.email, user.password);
    const out = await web('/auth/logout-all', { token: login.token });
    expect(out.status).toBe(204);
    expectCleared(out);
    expect((await web('/auth/web/refresh', { cookie: login.cookie })).status).toBe(401);
    expect(await meStatus(api, user.token)).toBe(401);
  });

  test('login novo no mesmo navegador revoga a sessão do cookie anterior (auth.session.revoke, reason replaced)', async () => {
    const first = await cookieLogin(client.email, client.password);
    const firstId = (await (await api.get('/auth/sessions?pageSize=100', { headers: bearer(first.token) })).json()).items.find(
      (item: { current: boolean }) => item.current,
    ).id;
    // Outra conta entra no mesmo navegador (o cookie anterior vai junto)
    const other = await newClient(api);
    const second = await cookieLogin(other.email, other.password, first.cookie);
    expect(second.jti).not.toBe(first.jti);
    expect((await web('/auth/web/refresh', { cookie: first.cookie })).status).toBe(401);
    expect(await meStatus(api, first.token)).toBe(401);
    expect((await web('/auth/web/refresh', { cookie: second.cookie })).status).toBe(200);

    const superadmin = await sessionOf(api, 'superadmin');
    const audit = await (
      await api.get(`/platform/audit?action=auth.session.revoke&target_type=auth_session&target_id=${firstId}`, {
        headers: bearer(superadmin.token),
      })
    ).json();
    expect(audit.items).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ reason: 'replaced' }) })]);
  });
});

test.describe('Sessão do site em cookie: troca de credenciais e outras emissões', () => {
  let api: APIRequestContext;

  test.beforeAll(async () => {
    api = await newApi();
  });
  test.afterAll(async () => {
    await api.dispose();
  });

  test('POST /account/password com o cabeçalho: sessão nova em cookie; o cookie e o token antigos caem', async () => {
    const user = await newClient(api);
    const login = await cookieLogin(user.email, user.password);
    const changed = await web('/account/password', {
      token: login.token,
      cookie: login.cookie,
      data: { current_password: user.password, password: `${STRONG_PASSWORD}7` },
    });
    expect(changed.status, JSON.stringify(changed.json)).toBe(200);
    expect(changed.json).toMatchObject({ session_transport: 'cookie', expires_in: 900 });
    const fresh = cookieValue(changed);
    expect(fresh.split('.')[1]).not.toBe(login.cookie.split('.')[1]);
    expect((await web('/auth/web/refresh', { cookie: login.cookie })).status).toBe(401);
    expect(await meStatus(api, login.token)).toBe(401);
    const renewed = await web('/auth/web/refresh', { cookie: fresh });
    expect(renewed.status).toBe(200);
    expect(decodeJwt(renewed.json.access_token).payload.jti).toBe(decodeJwt(changed.json.access_token).payload.jti);
  });

  test('PATCH /users/:id da própria conta (senha) com o cabeçalho: sessão nova em cookie; sem o cabeçalho, bearer de sempre', async () => {
    const user = await newClient(api);
    const login = await cookieLogin(user.email, user.password);
    const res = await api.patch(`/users/${user.user.id}`, {
      headers: { ...bearer(login.token), 'X-Auth-Transport': 'cookie', Origin: WEB, Cookie: `${COOKIE_NAME}=${login.cookie}` },
      data: { password: `${STRONG_PASSWORD}8`, current_password: user.password },
    });
    const updated = await body(res);
    expect(res.status(), JSON.stringify(updated)).toBe(200);
    expect(updated).toMatchObject({ session_transport: 'cookie', expires_in: 900, access_token: expect.any(String) });
    const setCookie = res.headersArray().filter((header) => header.name.toLowerCase() === 'set-cookie' && header.value.startsWith(`${COOKIE_NAME}=v1.`));
    expect(setCookie).toHaveLength(1);
    expect((await web('/auth/web/refresh', { cookie: login.cookie })).status).toBe(401);

    const mobile = await api.patch(`/users/${user.user.id}`, {
      headers: bearer(updated.access_token),
      data: { password: `${STRONG_PASSWORD}9`, current_password: `${STRONG_PASSWORD}8` },
    });
    const plain = await body(mobile);
    expect(mobile.status(), JSON.stringify(plain)).toBe(200);
    expect(plain).not.toHaveProperty('session_transport');
    expect(plain).not.toHaveProperty('expires_in');
    expect(decodeJwt(plain.access_token).payload.exp - decodeJwt(plain.access_token).payload.iat).toBe(7 * 86_400);
  });

  test('aceite de convite com o cabeçalho: a conta nova entra com a sessão em cookie', async () => {
    const admin = await sessionOf(api, 'admin');
    const created = await body(
      await api.post('/store/invitations', { headers: bearer(admin.token), data: { email: uniqueEmail('convite-cookie'), role: 'EMPLOYEE' } }),
    );
    expect(created.url, JSON.stringify(created)).toBeTruthy();
    const token = String(created.url).split('/').pop();
    const accepted = await web(`/invitations/${token}/accept`, { data: { name: 'Equipe Cookie', password: STRONG_PASSWORD } });
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(201);
    expect(accepted.json).toMatchObject({ session_transport: 'cookie', expires_in: 900 });
    const renewed = await web('/auth/web/refresh', { cookie: cookieValue(accepted) });
    expect(renewed.status).toBe(200);
    expect(renewed.json.user).toMatchObject({ role: 'EMPLOYEE', store_id: (await demoStore()).id });
    // A conta de teste vai para a lixeira (a equipe demo fica como estava)
    expect((await api.delete(`/users/${accepted.json.user.id}`, { headers: bearer(admin.token) })).status()).toBe(200);
  });
});

test.describe('Sessão do site em cookie: suporte a partir do superpainel', () => {
  test('refresh do superadmin responde 409 enquanto o suporte aberto pela sessão estiver ativo e 200 depois', async () => {
    const api = await newApi();
    try {
      const sa = DEFAULT_USERS.superadmin;
      const login = await cookieLogin(sa.email, sa.password);
      const storeId = (await demoStore()).id;
      const started = await body(
        await api.post(`/platform/stores/${storeId}/support-sessions`, {
          headers: bearer(login.token),
          data: { reason: 'Chamado E2E: sessão do site em cookie durante o suporte.' },
        }),
      );
      expect(started.access_token, JSON.stringify(started)).toBeTruthy();
      // O token de suporte continua bearer (resposta inalterada)
      expect(started).not.toHaveProperty('session_transport');

      const blocked = await web('/auth/web/refresh', { cookie: login.cookie });
      expect(blocked.status).toBe(409);
      expect(blocked.json.message).toBe(SUPPORT_OPEN_MESSAGE);
      expect(blocked.cookies).toEqual([]);

      // Encerrar o suporte pelo próprio token de suporte (sem apagar o cookie do superpainel)
      const ended = await web('/auth/logout', { token: started.access_token });
      expect(ended.status).toBe(204);
      expect(ended.cookies).toEqual([]);

      const back = await web('/auth/web/refresh', { cookie: login.cookie });
      expect(back.status, JSON.stringify(back.json)).toBe(200);
      expect(back.json.user).toMatchObject({ platform_role: 'SUPER_ADMIN' });
      await web('/auth/web/logout', { cookie: cookieValue(back) });
    } finally {
      await api.dispose();
    }
  });
});
