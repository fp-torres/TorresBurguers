import { expect, request, type BrowserContext, type Page } from '@playwright/test';
import { E2E, STORAGE_KEYS } from './env';
import { loginAs, type Session } from './api';
import { DEFAULT_USERS, type DefaultUserKey } from './users';

/** Página da vitrine de uma loja: cardápio (padrão), carrinho ou confirmação do pedido. */
export type StorePage = 'cart' | 'order-success';

/** Caminho da vitrine na web: storePath() → "/loja/demo"; storePath('cart') → "/loja/demo/cart". */
export function storePath(page?: StorePage, slug: string = E2E.demoStoreSlug): string {
  return page ? `/loja/${slug}/${page}` : `/loja/${slug}`;
}

/** Regex de URL que termina na página da vitrine (ex.: toHaveURL(storeUrl('cart'))). */
export function storeUrl(page?: StorePage, slug: string = E2E.demoStoreSlug): RegExp {
  return new RegExp(`${storePath(page, slug).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

/**
 * Injeta a sessão no localStorage antes de qualquer script da página rodar
 * (equivale a já estar logado). Para testar o login em si, use a interface.
 */
export async function useSession(page: Page, session: Session): Promise<void> {
  await page.addInitScript(
    ({ keys, token, user }) => {
      if (!window.sessionStorage.getItem('__e2e_session_seeded')) {
        window.localStorage.setItem(keys.token, token);
        window.localStorage.setItem(keys.user, JSON.stringify(user));
        window.sessionStorage.setItem('__e2e_session_seeded', '1');
      }
    },
    { keys: STORAGE_KEYS, token: session.token, user: session.user },
  );
}

/** Faz login via API com um usuário padrão e injeta a sessão na página. */
export async function signInAs(page: Page, key: DefaultUserKey): Promise<Session> {
  const api = await request.newContext({ baseURL: E2E.apiURL });
  const session = await loginAs(api, key);
  await api.dispose();
  await useSession(page, session);
  return session;
}

/** Nome do cookie do refresh na web de teste (http: sem o prefixo __Host-, que exige HTTPS). */
export const REFRESH_COOKIE = 'comestra_rt';

/** jti (id da sessão) de um token, sem conferir a assinatura. */
export function sessionIdOf(token: string): string {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).jti as string;
}

/**
 * Sessão do site em cookie, como depois do login pela tela: login pela API com X-Auth-Transport: cookie e o
 * Origin do site, pelo page.request (o cookie HttpOnly do refresh fica no contexto do navegador), mais o
 * marcador (sem segredo) e o usuário no localStorage por addInitScript. A página renova o token de acesso na
 * subida (POST /auth/web/refresh): nada de token no localStorage.
 */
export async function useCookieSession(page: Page, key: DefaultUserKey): Promise<Session> {
  const credentials = DEFAULT_USERS[key];
  const res = await page.request.post(`${E2E.apiURL}/auth/login`, {
    data: { email: credentials.email, password: credentials.password },
    headers: { 'X-Auth-Transport': 'cookie', Origin: E2E.webURL },
  });
  expect(res.status(), `login em cookie de ${key}: ${await res.text()}`).toBe(201);
  const data = await res.json();
  expect(data.session_transport, 'a API de teste abre a sessão em cookie para a origem do site').toBe('cookie');
  const session: Session = { token: data.access_token, user: data.user };
  await page.addInitScript(
    ({ keys, marker, user }) => {
      if (!window.sessionStorage.getItem('__e2e_session_seeded')) {
        window.localStorage.setItem(keys.user, JSON.stringify(user));
        window.localStorage.setItem(keys.session, JSON.stringify(marker));
        window.sessionStorage.setItem('__e2e_session_seeded', '1');
      }
    },
    { keys: STORAGE_KEYS, marker: { v: 1, sid: sessionIdOf(session.token), uid: session.user.id }, user: session.user },
  );
  return session;
}

/** Cookie do refresh guardado no contexto do navegador (undefined se não houver). */
export async function refreshCookie(context: BrowserContext) {
  return (await context.cookies(E2E.apiURL)).find((cookie) => cookie.name === REFRESH_COOKIE);
}

/**
 * A página está numa sessão em cookie: nenhum JWT (eyJ...) no localStorage nem no sessionStorage, o marcador da
 * sessão no lugar do token e o refresh num cookie HttpOnly e SameSite=Strict.
 */
export async function expectCookieSession(page: Page): Promise<void> {
  const storage = await page.evaluate(() => {
    const dump = (area: Storage) => {
      const data: Record<string, string> = {};
      for (let i = 0; i < area.length; i++) {
        const key = area.key(i)!;
        data[key] = area.getItem(key) ?? '';
      }
      return data;
    };
    return { local: dump(window.localStorage), session: dump(window.sessionStorage) };
  });
  const everything = [...Object.values(storage.local), ...Object.values(storage.session)].join('\n');
  expect(everything, 'JWT guardado no armazenamento do navegador').not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.eyJ/);
  expect(storage.local[STORAGE_KEYS.token], 'token no localStorage').toBeUndefined();
  expect(JSON.parse(storage.local[STORAGE_KEYS.session] ?? 'null'), 'marcador da sessão em cookie').toMatchObject({ v: 1, sid: expect.any(String) });
  const cookie = await refreshCookie(page.context());
  expect(cookie, 'cookie do refresh').toBeTruthy();
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
}
