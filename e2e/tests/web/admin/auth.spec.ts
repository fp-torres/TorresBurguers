import { test, expect } from '@playwright/test';
import { E2E } from '../../../support/env';
import { signInAs, useSession } from '../../../support/web';
import {
  DEFAULT_USERS,
  STORAGE_KEYS,
  loginViaUi,
  pageHeading,
  sidebar,
  toast,
  trackApiFailures,
  waitForApi,
} from './helpers';

const ADMIN_ONLY_PATHS = ['/dashboard', '/products', '/users', '/trash', '/admin'];
const STAFF_PATHS = ['/dashboard', '/orders', '/products', '/users', '/trash'];

async function storedSession(page: import('@playwright/test').Page) {
  return page.evaluate((keys) => ({
    token: localStorage.getItem(keys.token),
    user: localStorage.getItem(keys.user),
    cart: localStorage.getItem(keys.cart),
    theme: localStorage.getItem(keys.theme),
  }), STORAGE_KEYS);
}

test.describe('Login do painel (/login)', () => {
  test('administrador entra pelo /login e cai no Dashboard com o menu completo', async ({ page }) => {
    const admin = DEFAULT_USERS.admin;
    await loginViaUi(page, admin.email, admin.password);

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(toast(page, 'Bem-vindo, Administrador!')).toBeVisible();
    await expect(pageHeading(page, /^Dashboard/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Painel Administrativo' })).toBeVisible();

    const menu = sidebar(page).getByRole('navigation').getByRole('link');
    await expect(menu).toHaveText(['Dashboard', 'Pedidos', 'Cardápio', 'Equipe', 'Lixeira']);
    await expect(sidebar(page).getByText('Admin', { exact: true })).toBeVisible();
    await expect(page.getByRole('banner')).toContainText(`Administrador · ${admin.email}`);

    // Sessão guardada sem dados sensíveis
    const session = await storedSession(page);
    expect(session.token).toBeTruthy();
    expect(session.user).not.toContain('password');
  });

  const staff = [
    { key: 'employee', label: 'atendente', title: 'Gestão de Pedidos', role: 'Atendente' },
    { key: 'kitchen', label: 'cozinha', title: /^Monitor da Cozinha/, role: 'Cozinha' },
    { key: 'courier', label: 'entregador', title: /^Painel de Entregas/, role: 'Entregador' },
  ] as const;

  for (const member of staff) {
    test(`${member.label} entra pelo /login, cai em Pedidos e é redirecionado das páginas do administrador`, async ({ page }) => {
      const user = DEFAULT_USERS[member.key];
      const failures = trackApiFailures(page);
      await loginViaUi(page, user.email, user.password);

      await expect(page).toHaveURL(/\/orders$/);
      await expect(pageHeading(page, member.title)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole('heading', { name: 'Painel da Equipe' })).toBeVisible();
      await expect(sidebar(page).getByRole('navigation').getByRole('link')).toHaveText(['Pedidos']);
      await expect(sidebar(page).getByText('Equipe', { exact: true })).toBeVisible();
      await expect(page.getByRole('banner')).toContainText(`${member.role} · ${user.email}`);

      for (const path of ADMIN_ONLY_PATHS) {
        await page.goto(path);
        await expect(page, `${path} deve redirecionar para /orders`).toHaveURL(/\/orders$/);
        await expect(pageHeading(page, member.title)).toBeVisible({ timeout: 20_000 });
      }

      // As telas do administrador nem chegam a chamar endpoints que a API recusaria
      expect(failures.filter((f) => /→ 40[13]$/.test(f))).toEqual([]);
    });
  }

  test('cliente que tenta entrar pelo /login é recusado, fica sem sessão e volta para a loja', async ({ page }) => {
    const client = DEFAULT_USERS.client;
    await loginViaUi(page, client.email, client.password);

    await expect(toast(page, 'Esta área é exclusiva da equipe')).toBeVisible();
    await expect(page).toHaveURL(`${E2E.webURL}/`);
    const session = await storedSession(page);
    expect(session.token).toBeNull();
    expect(session.user).toBeNull();

    await page.goto('/orders');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('cliente com sessão da loja que abre o painel volta para a vitrine', async ({ page }) => {
    await signInAs(page, 'client');
    for (const path of ['/dashboard', '/orders']) {
      await page.goto(path);
      await expect(page, `${path} deve levar o cliente para a loja`).toHaveURL(`${E2E.webURL}/`);
    }
    await expect(sidebar(page)).toHaveCount(0);
  });

  test('senha errada ou e-mail desconhecido mostram "Credenciais inválidas." e não criam sessão', async ({ page }) => {
    await loginViaUi(page, DEFAULT_USERS.admin.email, 'SenhaErrada@999');
    await expect(toast(page, 'Credenciais inválidas.')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('button', { name: 'Acessar Sistema' })).toBeEnabled();

    await page.getByPlaceholder('nome@empresa.com.br').fill('ninguem-wa@e2e.test');
    await page.getByPlaceholder('••••••••').fill('Qualquer@123');
    const second = waitForApi(page, 'POST', '/auth/login');
    await page.getByRole('button', { name: 'Acessar Sistema' }).click();
    expect((await second).status()).toBe(401);
    await expect(toast(page, 'Credenciais inválidas.').last()).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    expect((await storedSession(page)).token).toBeNull();
  });

  test('e-mail com letras maiúsculas também entra (login sem diferenciar maiúsculas)', async ({ page }) => {
    await loginViaUi(page, DEFAULT_USERS.employee.email.toUpperCase(), DEFAULT_USERS.employee.password);
    await expect(page).toHaveURL(/\/orders$/);
    await expect(pageHeading(page, 'Gestão de Pedidos')).toBeVisible({ timeout: 20_000 });
  });

  test('"Esqueci a senha" explica que um administrador redefine a senha e mostra o e-mail de suporte', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Esqueci a senha' }).click();
    const help = toast(page, /administrador/i);
    await expect(help).toBeVisible();
    await expect(help).toContainText('contato@comestra.com.br');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('visitante sem sessão que abre uma página do painel é levado ao /login', async ({ page }) => {
    for (const path of STAFF_PATHS) {
      await page.goto(path);
      await expect(page, `${path} sem sessão`).toHaveURL(/\/login$/);
    }
    await expect(page.getByRole('button', { name: 'Acessar Sistema' })).toBeVisible();
  });
});

test.describe('Sessão no painel', () => {
  test('sair do sistema pede confirmação, encerra a sessão e mantém carrinho e tema', async ({ page }) => {
    await signInAs(page, 'employee');
    await page.goto('/orders');
    await expect(pageHeading(page, 'Gestão de Pedidos')).toBeVisible({ timeout: 20_000 });

    // Tema escolhido no menu e um carrinho salvo antes de sair
    await sidebar(page).getByRole('button', { name: /^Tema:/ }).click();
    const cartValue = JSON.stringify([{ id: 'wa-cart-item', quantity: 1 }]);
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [STORAGE_KEYS.cart, cartValue]);
    const before = await storedSession(page);
    expect(before.theme).toBeTruthy();

    // Cancelar mantém a sessão
    await sidebar(page).getByRole('button', { name: 'Sair do Sistema' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Sair do Sistema?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/orders$/);
    expect((await storedSession(page)).token).toBeTruthy();

    // Confirmar encerra a sessão
    await sidebar(page).getByRole('button', { name: 'Sair do Sistema' }).click();
    await page.getByRole('alertdialog', { name: 'Sair do Sistema?' }).getByRole('button', { name: 'Sair', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);

    const after = await storedSession(page);
    expect(after.token).toBeNull();
    expect(after.user).toBeNull();
    expect(after.cart, 'logout não pode apagar o carrinho').toBe(cartValue);
    expect(after.theme, 'logout não pode apagar o tema').toBe(before.theme);

    await page.goto('/orders');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('token inválido no painel encerra a sessão e leva ao /login com aviso', async ({ page, request }) => {
    const res = await request.post(`${E2E.apiURL}/auth/login`, {
      data: { email: DEFAULT_USERS.employee.email, password: DEFAULT_USERS.employee.password },
    });
    const { user } = await res.json();
    await useSession(page, { token: 'token-invalido-do-teste', user });

    await page.goto('/orders');
    await expect(page).toHaveURL(/\/login$/, { timeout: 20_000 });
    await expect(toast(page, 'Sua sessão expirou. Faça login novamente.')).toBeVisible();
    const session = await storedSession(page);
    expect(session.token).toBeNull();
    expect(session.user).toBeNull();
  });
});
