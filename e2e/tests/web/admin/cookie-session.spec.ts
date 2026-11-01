import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { contextAs, demoStore } from '../../../support/api';
import { E2E } from '../../../support/env';
import { expectCookieSession, refreshCookie, useCookieSession } from '../../../support/web';
import { DEFAULT_USERS, STORAGE_KEYS, loginViaUi, sidebar, toast } from './helpers';

/**
 * Sessão do site em cookie no painel e no superpainel (plano refresh-token). O superadmin que entra pela tela
 * fica com o token de acesso só em memória; durante um suporte, o refresh da sessão dele responde 409 (um script
 * na aba de suporte não obtém o acesso pleno) e, ao encerrar, a aba volta ao superpainel sem novo login, mesmo
 * depois de recarregar a página.
 */

async function refreshStatus(page: Page): Promise<number> {
  const res = await page.request.post(`${E2E.apiURL}/auth/web/refresh`, {
    headers: { 'X-Auth-Transport': 'cookie', Origin: E2E.webURL },
  });
  return res.status();
}

/** Superadmin entra pela tela (sessão em cookie) e inicia o suporte da loja demo pela tela. */
async function startSupportFromCookieSession(page: Page): Promise<number> {
  const superadmin = DEFAULT_USERS.superadmin;
  await loginViaUi(page, superadmin.email, superadmin.password);
  await expect(page).toHaveURL(/\/platform$/);
  await expectCookieSession(page);

  const store = await demoStore();
  await page.goto(`/platform/stores/${store.id}?tab=support`);
  await page.getByRole('button', { name: 'Iniciar sessão de suporte' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Iniciar sessão de suporte?' });
  await dialog.getByLabel('Motivo').fill('Chamado E2E: suporte a partir da sessão em cookie.');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && /\/platform\/stores\/\d+\/support-sessions$/.test(new URL(r.url()).pathname));
  await dialog.getByRole('button', { name: 'Iniciar e abrir o painel' }).click();
  const body = await (await started).json();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(sidebar(page).getByText('Suporte', { exact: true })).toBeVisible();
  return body.session.id as number;
}

async function supportStatus(api: APIRequestContext, id: number): Promise<string> {
  const store = await demoStore();
  const res = await api.get(`/platform/support-sessions?store_id=${store.id}&page=1&pageSize=100`);
  const { items } = await res.json();
  return (items as { id: number; status: string }[]).find((item) => item.id === id)?.status ?? 'NOT_FOUND';
}

test.describe('Sessão do site em cookie no painel', () => {
  let platform: { ctx: APIRequestContext };

  test.beforeAll(async () => {
    platform = await contextAs('superadmin');
  });
  test.afterAll(async () => {
    await platform.ctx.dispose();
  });

  test('login do painel pela tela: sessão em cookie, recarregar mantém o painel e "Sair do Sistema" encerra o cookie', async ({ page }) => {
    const admin = DEFAULT_USERS.admin;
    await loginViaUi(page, admin.email, admin.password);
    await expect(page).toHaveURL(/\/dashboard$/);
    await expectCookieSession(page);

    await page.goto('/orders');
    await page.reload();
    await expect(page.getByRole('banner')).toContainText(`Administrador · ${admin.email}`, { timeout: 20_000 });
    await expect(page).toHaveURL(/\/orders$/);

    await sidebar(page).getByRole('button', { name: 'Sair do Sistema' }).click();
    await page.getByRole('alertdialog', { name: 'Sair do Sistema?' }).getByRole('button', { name: 'Sair', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect.poll(() => refreshCookie(page.context())).toBeUndefined();
    expect(await refreshStatus(page)).toBe(401);
  });

  test('suporte iniciado numa sessão em cookie: refresh 409 durante o suporte; encerrar volta ao superpainel sem login, mesmo depois de recarregar', async ({ page }) => {
    const id = await startSupportFromCookieSession(page);

    // A aba de suporte não obtém o acesso pleno do superadmin pelo cookie
    expect(await refreshStatus(page)).toBe(409);
    const storage = await page.evaluate(() => ({ ...localStorage }));
    expect(storage[`comestra.platformSession`]).toBeUndefined();
    expect(storage[STORAGE_KEYS.session], 'marcador da sessão do superpainel').toBeTruthy();

    await page.reload();
    await expect(sidebar(page).getByText('Suporte', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Encerrar e voltar ao superpainel' }).click();
    await expect(page).toHaveURL(/\/platform$/);
    await expect(sidebar(page).getByText('Suporte', { exact: true })).toBeHidden();
    await expect(toast(page, /Entre novamente/)).toHaveCount(0);
    await expect.poll(() => supportStatus(platform.ctx, id)).toBe('ENDED');
    await expectCookieSession(page);
    expect(await refreshStatus(page)).toBe(200);
  });

  test('"Sair do Sistema" durante o suporte iniciado em cookie: encerra o suporte e a sessão do cookie', async ({ page }) => {
    const id = await startSupportFromCookieSession(page);
    await sidebar(page).getByRole('button', { name: 'Sair do Sistema' }).click();
    await page.getByRole('alertdialog', { name: 'Sair do Sistema?' }).getByRole('button', { name: 'Sair', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect.poll(() => supportStatus(platform.ctx, id)).toBe('ENDED');
    await expect.poll(() => refreshCookie(page.context())).toBeUndefined();
    expect(await refreshStatus(page)).toBe(401);
  });

  test('sessão em cookie encerrada fora da aba: o painel leva ao /login com o aviso de sessão expirada', async ({ page }) => {
    await useCookieSession(page, 'admin');
    const out = await page.request.post(`${E2E.apiURL}/auth/web/logout`, {
      headers: { 'X-Auth-Transport': 'cookie', Origin: E2E.webURL },
    });
    expect(out.status()).toBe(204);

    await page.goto('/orders');
    await expect(page).toHaveURL(/\/login$/);
    await expect(toast(page, 'Sua sessão expirou. Faça login novamente.')).toBeVisible();
    const storage = await page.evaluate(() => ({ ...localStorage }));
    expect(storage[STORAGE_KEYS.session]).toBeUndefined();
    expect(storage[STORAGE_KEYS.user]).toBeUndefined();
  });
});
