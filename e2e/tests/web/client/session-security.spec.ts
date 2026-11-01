import { test, expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { demoStore, login, loginAs, type Session } from '../../../support/api';
import { BRAND, E2E, STORAGE_KEYS } from '../../../support/env';
import { signInAs, useSession } from '../../../support/web';
import { createClient } from './helpers';

/**
 * Sessões no navegador: sair encerra a sessão no servidor (o token deixa de valer), "Sessões ativas" lista e encerra
 * as sessões da conta (Meus Dados e menu do painel) e "Encerrar e voltar ao superpainel" encerra o suporte com o
 * próprio token de suporte.
 */

let api: APIRequestContext;

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: E2E.apiURL });
});

test.afterAll(async () => {
  await api.dispose();
});

async function meStatus(token: string): Promise<number> {
  return (await api.get('/auth/me', { headers: { Authorization: `Bearer ${token}` } })).status();
}

/** Outra sessão da mesma conta, aberta "pelo app" (o resumo do navegador fica "Aplicativo no Android"). */
async function appSession(email: string, password: string): Promise<string> {
  const res = await api.post('/auth/login', { data: { email, password }, headers: { 'User-Agent': 'okhttp/4.9.2' } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).access_token;
}

function sessionsSection(page: Page) {
  return page.getByRole('region', { name: 'Sessões ativas' });
}

test.describe('Cliente: sessões da conta', () => {
  test('Meus Dados mostra as sessões ativas (este navegador primeiro) e encerra a de outro aparelho', async ({ page }) => {
    const client = await createClient();
    try {
      const phone = await appSession(client.email, client.password);
      await useSession(page, client.session);
      await page.goto('/profile');

      const section = sessionsSection(page);
      await expect(section.getByRole('listitem').first()).toContainText('Este navegador');
      const phoneItem = section.getByRole('listitem').filter({ hasText: 'Aplicativo no Android' });
      await expect(phoneItem).toBeVisible();

      await phoneItem.getByRole('button', { name: /Encerrar a sessão Aplicativo no Android/ }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Sessão encerrada' }).last()).toBeVisible();
      await expect(phoneItem).toHaveCount(0);
      expect(await meStatus(phone), 'o token do outro aparelho caiu').toBe(401);
      expect(await meStatus(client.session.token), 'este navegador continua conectado').toBe(200);
    } finally {
      await client.api.dispose();
    }
  });

  test('"Sair da Conta" encerra a sessão no servidor (POST /auth/logout): o token antigo deixa de valer', async ({ page }) => {
    const client = await createClient();
    try {
      await useSession(page, client.session);
      await page.goto('/profile');
      await expect(sessionsSection(page)).toBeVisible();

      await page.getByRole('button', { name: 'Menu da conta' }).click();
      await page.getByRole('button', { name: 'Sair da Conta' }).click();
      const logout = page.waitForResponse((res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/auth/logout');
      await page.getByRole('alertdialog', { name: 'Sair?' }).getByRole('button', { name: 'Sair', exact: true }).click();
      expect((await logout).status()).toBe(204);

      await expect.poll(() => meStatus(client.session.token)).toBe(401);
      expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEYS.token)).toBeNull();
    } finally {
      await client.api.dispose();
    }
  });

  test('"Sair de todos os aparelhos" derruba todas as sessões da conta e volta para o login', async ({ page }) => {
    const client = await createClient();
    try {
      const phone = await appSession(client.email, client.password);
      await useSession(page, client.session);
      await page.goto('/profile');

      await sessionsSection(page).getByRole('button', { name: 'Sair de todos os aparelhos' }).click();
      await page.getByRole('alertdialog', { name: 'Sair de todos os aparelhos?' }).getByRole('button', { name: 'Sair de todos' }).click();
      // Login da loja (a página protegida pede para voltar a Meus Dados depois)
      await expect(page).toHaveURL(/\/signin(\?|$)/);

      expect(await meStatus(client.session.token)).toBe(401);
      expect(await meStatus(phone)).toBe(401);
      // A conta continua: um login novo funciona
      const again = await login(api, client.email, client.password);
      expect(await meStatus(again.token)).toBe(200);
    } finally {
      await client.api.dispose();
    }
  });
});

test.describe('Painel: sessões da equipe', () => {
  test('"Sessões ativas" no menu lista este navegador; "Sair do Sistema" encerra a sessão no servidor', async ({ page }) => {
    const admin = await signInAs(page, 'admin');
    await page.goto('/dashboard');

    const menu = page.getByRole('complementary');
    await menu.getByRole('button', { name: 'Sessões ativas' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sessões da sua conta' });
    await expect(dialog.getByRole('listitem').first()).toContainText('Este navegador');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await menu.getByRole('button', { name: 'Sair do Sistema' }).click();
    await page.getByRole('alertdialog', { name: 'Sair do Sistema?' }).getByRole('button', { name: 'Sair', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect.poll(() => meStatus(admin.token)).toBe(401);
  });
});

test.describe('Sessão de suporte', () => {
  test('"Encerrar e voltar ao superpainel" sem o superpainel nesta aba: encerra o suporte com o próprio token, na hora', async ({ page }) => {
    const superadmin = await loginAs(api, 'superadmin');
    const store = await demoStore();
    const started = await api.post(`/platform/stores/${store.id}/support-sessions`, {
      headers: { Authorization: `Bearer ${superadmin.token}` },
      data: { reason: 'Chamado E2E: encerrar o suporte pelo próprio token.' },
    });
    expect(started.status(), await started.text()).toBe(201);
    const { access_token: supportToken, session } = await started.json();
    const me = await api.get('/auth/me', { headers: { Authorization: `Bearer ${supportToken}` } });
    const supportSession: Session = { token: supportToken, user: await me.json() };

    // Como uma aba recarregada durante o suporte: só o token de suporte (sem a sessão do superpainel na memória)
    await useSession(page, supportSession);
    await page.goto('/dashboard');
    await page.getByRole('button', { name: 'Encerrar e voltar ao superpainel' }).click();
    await expect(page).toHaveURL(/\/login$/);

    expect(await meStatus(supportToken), 'o token de suporte caiu').toBe(401);
    const list = await api.get(`/platform/support-sessions?store_id=${store.id}&pageSize=100`, {
      headers: { Authorization: `Bearer ${superadmin.token}` },
    });
    const status = ((await list.json()).items as Array<{ id: number; status: string }>).find((item) => item.id === session.id)?.status;
    expect(status, 'encerrada no servidor sem esperar o próximo login').toBe('ENDED');
    // Nada pendente para o próximo login do superadmin
    expect(await page.evaluate((key) => localStorage.getItem(key), `${BRAND.slug}.supportSessionToEnd`)).toBeNull();
  });
});
