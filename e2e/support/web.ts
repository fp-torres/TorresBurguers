import { request, type Page } from '@playwright/test';
import { E2E, STORAGE_KEYS } from './env';
import { loginAs, type Session } from './api';
import type { DefaultUserKey } from './users';

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
