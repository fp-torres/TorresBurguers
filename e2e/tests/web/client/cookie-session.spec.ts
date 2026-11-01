import { test, expect, type Page, type Request } from '@playwright/test';
import { E2E } from '../../../support/env';
import { expectCookieSession, refreshCookie, sessionIdOf, useCookieSession } from '../../../support/web';
import { DEFAULT_USERS } from '../../../support/users';
import { createClient, loginViaUI, readStorage, storePath, storeUrl, STORAGE_KEYS } from './helpers';

/**
 * Sessão do site em cookie no navegador (plano refresh-token): o login pela tela guarda o token de acesso só na
 * memória da aba e o refresh num cookie HttpOnly; a aba renova sozinha (subida, 401, perto de vencer) e as abas
 * do mesmo navegador se acompanham pelo marcador sem segredo. A API de teste usa AUTH_REFRESH_GRACE_SECONDS=3.
 */

const REFRESH_PATH = '/auth/web/refresh';

function isRefresh(req: Request): boolean {
  return req.method() === 'POST' && new URL(req.url()).pathname === REFRESH_PATH;
}

/** Renovação feita pelo próprio teste com o cookie do contexto (como a página faria). */
async function refreshStatus(page: Page): Promise<number> {
  const res = await page.request.post(`${E2E.apiURL}${REFRESH_PATH}`, {
    headers: { 'X-Auth-Transport': 'cookie', Origin: E2E.webURL },
  });
  return res.status();
}

/** Abre a conta pelo menu e confere quem está logado. */
async function expectSignedInAs(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Menu da conta' }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
}

test.describe('Sessão do site em cookie (vitrine e conta do cliente)', () => {
  test('login pela tela: nenhum JWT no localStorage nem no sessionStorage; refresh em cookie HttpOnly e SameSite=Strict', async ({ page }) => {
    const client = await createClient({ name: 'Cliente Cookie' });
    try {
      await loginViaUI(page, client.email, client.password);
      await expect(page).not.toHaveURL(/\/signin$/);
      await expectCookieSession(page);
      const storage = await readStorage(page);
      expect(JSON.parse(storage[STORAGE_KEYS.session])).toMatchObject({ uid: client.session.user.id });
      expect(storage[STORAGE_KEYS.user]).not.toMatch(/password/i);
    } finally {
      await client.api.dispose();
    }
  });

  test('recarregar a página mantém a sessão (renova na subida) sem voltar a pedir login', async ({ page }) => {
    await useCookieSession(page, 'client');
    const refreshed = page.waitForRequest(isRefresh);
    await page.goto('/my-orders');
    await refreshed;
    await expect(page).toHaveURL(/\/my-orders$/);

    const again = page.waitForResponse((res) => isRefresh(res.request()) && res.status() === 200);
    await page.reload();
    await again;
    await expect(page).toHaveURL(/\/my-orders$/);
    await expectSignedInAs(page, DEFAULT_USERS.client.name);
    await expectCookieSession(page);
  });

  test('401 numa chamada: a aba renova uma vez e repete a chamada, sem sair da conta', async ({ page }) => {
    await useCookieSession(page, 'client');
    const apiOrigin = new URL(E2E.apiURL).origin;
    // Ordem dos acontecimentos: 401 simulado, renovações e repetições da chamada recusada
    const events: string[] = [];
    page.on('response', (res) => {
      if (isRefresh(res.request())) events.push(`refresh:${res.status()}`);
    });

    // A primeira chamada autenticada da página recebe um 401 simulado (como um token que venceu no caminho)
    let rejectedUrl: string | null = null;
    await page.route((url) => url.origin === apiOrigin && url.pathname !== REFRESH_PATH, async (route) => {
      const request = route.request();
      if (request.headers().authorization) {
        if (rejectedUrl === null) {
          rejectedUrl = request.url();
          events.push('rejected');
          await route.fulfill({
            status: 401,
            contentType: 'application/json',
            body: JSON.stringify({ statusCode: 401, message: 'Sessão inválida ou expirada. Faça login novamente.', error: 'Unauthorized' }),
          });
          return;
        }
        if (request.url() === rejectedUrl) events.push('repeat');
      }
      await route.continue();
    });

    await page.goto('/my-orders');
    // Depois do 401: uma renovação bem-sucedida e, em seguida, a mesma chamada de novo
    await expect
      .poll(() => {
        const afterReject = events.slice(events.indexOf('rejected') + 1);
        const refreshed = afterReject.indexOf('refresh:200');
        return events.includes('rejected') && refreshed >= 0 && afterReject.slice(refreshed + 1).includes('repeat');
      }, { timeout: 20_000, message: 'depois do 401: renovação (200) e a mesma chamada de novo' })
      .toBe(true);
    expect(events.filter((event) => event.startsWith('refresh:') && event !== 'refresh:200'), 'renovações recusadas').toEqual([]);
    await expect(page).toHaveURL(/\/my-orders$/);
    await expect(page.getByText('Sua sessão expirou')).toHaveCount(0);
    await expectSignedInAs(page, DEFAULT_USERS.client.name);
    await expectCookieSession(page);
  });

  test('duas abas renovando juntas seguem logadas e a sessão não é revogada', async ({ context }) => {
    const first = await context.newPage();
    await useCookieSession(first, 'client');
    await first.goto('/my-orders');
    await expectSignedInAs(first, DEFAULT_USERS.client.name);

    const second = await context.newPage();
    await second.goto('/my-orders');
    await expectSignedInAs(second, DEFAULT_USERS.client.name);

    // As duas recarregam ao mesmo tempo: as duas renovam com o mesmo cookie (Web Lock + tolerância do servidor)
    const statuses: number[] = [];
    for (const tab of [first, second]) {
      tab.on('response', (res) => {
        if (isRefresh(res.request())) statuses.push(res.status());
      });
    }
    await Promise.all([first.reload(), second.reload()]);
    await expect.poll(() => statuses.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    expect(statuses.every((status) => status === 200), `renovações: ${statuses.join(', ')}`).toBe(true);
    await expectSignedInAs(first, DEFAULT_USERS.client.name);
    await expectSignedInAs(second, DEFAULT_USERS.client.name);
    expect(await refreshStatus(first)).toBe(200);
  });

  test('sair numa aba: a outra mostra "Você saiu da conta em outra aba" e o refresh do cookie passa a responder 401', async ({ context }) => {
    const client = await createClient({ name: 'Cliente Duas Abas' });
    try {
      const first = await context.newPage();
      await loginViaUI(first, client.email, client.password);
      await expect(first).not.toHaveURL(/\/signin$/);
      await first.goto('/my-orders');
      await expectSignedInAs(first, 'Cliente Duas Abas');

      const second = await context.newPage();
      await second.goto('/my-orders');
      await expectSignedInAs(second, 'Cliente Duas Abas');

      await second.getByRole('button', { name: 'Menu da conta' }).click();
      await second.getByRole('button', { name: 'Sair da Conta' }).click();
      const loggedOut = second.waitForResponse((res) => new URL(res.url()).pathname === '/auth/web/logout');
      await second.getByRole('alertdialog', { name: 'Sair?' }).getByRole('button', { name: 'Sair', exact: true }).click();
      expect((await loggedOut).status()).toBe(204);

      await expect(first.getByText('Você saiu da conta em outra aba.')).toBeVisible({ timeout: 10_000 });
      expect(await refreshCookie(context)).toBeUndefined();
      expect(await refreshStatus(first)).toBe(401);
    } finally {
      await client.api.dispose();
    }
  });

  test('cookie roubado e usado em outro navegador: a família cai e a página da vítima sai no próximo uso', async ({ browser, page }) => {
    const victim = await createClient({ name: 'Cliente Vitima' });
    try {
      await loginViaUI(page, victim.email, victim.password);
      await expect(page).not.toHaveURL(/\/signin$/);
      await expectCookieSession(page);
      const stolen = (await refreshCookie(page.context()))!;

      // O atacante usa o cookie em outro contexto: renova (o cookie da vítima vira o "anterior")
      const attacker = await browser.newContext();
      try {
        await attacker.addCookies([stolen]);
        const first = await attacker.request.post(`${E2E.apiURL}${REFRESH_PATH}`, {
          headers: { 'X-Auth-Transport': 'cookie', Origin: E2E.webURL },
        });
        expect(first.status()).toBe(200);
        const marker = JSON.parse((await readStorage(page))[STORAGE_KEYS.session]);
        expect(sessionIdOf((await first.json()).access_token)).toBe(marker.sid);

        // Passada a tolerância, a vítima volta a usar o cookie dela: reuso → a família inteira é encerrada
        await page.waitForTimeout(3_700);
        const reuse = page.waitForResponse((res) => isRefresh(res.request()));
        await page.reload();
        expect((await reuse).status()).toBe(401);
        await expect(page.getByRole('button', { name: 'Menu da conta' })).toHaveCount(0);
        expect((await readStorage(page))[STORAGE_KEYS.session]).toBeUndefined();

        // O atacante também perdeu a sessão
        const after = await attacker.request.post(`${E2E.apiURL}${REFRESH_PATH}`, {
          headers: { 'X-Auth-Transport': 'cookie', Origin: E2E.webURL },
        });
        expect(after.status()).toBe(401);
      } finally {
        await attacker.close();
      }
    } finally {
      await victim.api.dispose();
    }
  });

  test('sessão do navegador encerrada fora da aba: na vitrine a página só fica sem login (sem aviso nem ida ao /signin)', async ({ page }) => {
    await useCookieSession(page, 'client');
    // Outro aparelho encerrou esta sessão ("Sessões ativas") antes de a página abrir
    const out = await page.request.post(`${E2E.apiURL}/auth/web/logout`, {
      headers: { 'X-Auth-Transport': 'cookie', Origin: E2E.webURL },
    });
    expect(out.status()).toBe(204);

    const refused = page.waitForResponse((res) => isRefresh(res.request()));
    await page.goto(storePath());
    expect((await refused).status()).toBe(401);
    await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
    await expect(page).toHaveURL(storeUrl());
    await expect(page.getByText('Sua sessão expirou')).toHaveCount(0);
    const storage = await readStorage(page);
    expect(storage[STORAGE_KEYS.session]).toBeUndefined();
    expect(storage[STORAGE_KEYS.user]).toBeUndefined();
  });
});
