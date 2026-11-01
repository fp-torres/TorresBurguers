import { test, expect } from '@playwright/test';
import { demoStore } from '../../../support/api';
import { E2E, cartKey } from '../../../support/env';
import { expectCookieSession, signInAs, useSession } from '../../../support/web';
import { seedCatalog } from '../client/helpers';
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

const ADMIN_ONLY_PATHS = ['/dashboard', '/products', '/users', '/trash', '/settings', '/subscription', '/admin'];
const STAFF_PATHS = ['/dashboard', '/orders', '/products', '/users', '/trash', '/customers', '/settings', '/subscription'];

/** Sessão, carrinho da loja demo (comestra.cart.<storeId>) e tema salvos no navegador. */
async function storedSession(page: import('@playwright/test').Page) {
  const store = await demoStore();
  return page.evaluate(({ keys, cart }) => ({
    token: localStorage.getItem(keys.token),
    session: localStorage.getItem(keys.session),
    user: localStorage.getItem(keys.user),
    cart: localStorage.getItem(cart),
    theme: localStorage.getItem(keys.theme),
  }), { keys: STORAGE_KEYS, cart: cartKey(store.id) });
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
    await expect(menu).toHaveText(['Dashboard', 'Pedidos', 'Clientes', 'Cardápio', 'Equipe', 'Lixeira', 'Configurações', 'Assinatura']);
    await expect(sidebar(page).getByText('Admin', { exact: true })).toBeVisible();
    await expect(page.getByRole('banner')).toContainText(`Administrador · ${admin.email}`);
    // O painel é da loja do usuário: o estabelecimento aparece no menu e no cabeçalho
    await expect(sidebar(page)).toContainText('Lanchonete Demo');
    await expect(page.getByRole('banner')).toContainText('Lanchonete Demo');

    // Sessão guardada sem dados sensíveis: em cookie, o navegador só tem o marcador (o token fica na memória)
    const session = await storedSession(page);
    expect(session.token).toBeNull();
    expect(session.session).toBeTruthy();
    await expectCookieSession(page);
    expect(session.user).not.toContain('password');
  });

  // O atendente também vê os clientes da loja (somente leitura); cozinha e entregador, só os pedidos
  const staff = [
    { key: 'employee', label: 'atendente', title: 'Gestão de Pedidos', role: 'Atendente', menu: ['Pedidos', 'Clientes'], blocked: ADMIN_ONLY_PATHS },
    { key: 'kitchen', label: 'cozinha', title: /^Monitor da Cozinha/, role: 'Cozinha', menu: ['Pedidos'], blocked: [...ADMIN_ONLY_PATHS, '/customers'] },
    { key: 'courier', label: 'entregador', title: /^Painel de Entregas/, role: 'Entregador', menu: ['Pedidos'], blocked: [...ADMIN_ONLY_PATHS, '/customers'] },
  ] as const;

  for (const member of staff) {
    test(`${member.label} entra pelo /login, cai em Pedidos e é redirecionado das páginas do administrador`, async ({ page }) => {
      const user = DEFAULT_USERS[member.key];
      const failures = trackApiFailures(page);
      await loginViaUi(page, user.email, user.password);

      await expect(page).toHaveURL(/\/orders$/);
      await expect(pageHeading(page, member.title)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole('heading', { name: 'Painel da Equipe' })).toBeVisible();
      await expect(sidebar(page).getByRole('navigation').getByRole('link')).toHaveText([...member.menu]);
      await expect(sidebar(page).getByText('Equipe', { exact: true })).toBeVisible();
      await expect(page.getByRole('banner')).toContainText(`${member.role} · ${user.email}`);

      for (const path of member.blocked) {
        await page.goto(path);
        await expect(page, `${path} deve redirecionar para /orders`).toHaveURL(/\/orders$/);
        await expect(pageHeading(page, member.title)).toBeVisible({ timeout: 20_000 });
      }

      // As telas do administrador nem chegam a chamar endpoints que a API recusaria
      expect(failures.filter((f) => /→ 40[13]$/.test(f))).toEqual([]);
    });
  }

  test('cliente que tenta entrar pelo /login é recusado, fica sem sessão e volta para a loja (o carrinho do aparelho continua)', async ({ page }) => {
    // Carrinho do cliente neste aparelho, com um produto de verdade do cardápio da loja demo
    const store = await demoStore();
    const { drink } = await seedCatalog();
    const cart = JSON.stringify({
      v: 2,
      storeId: store.id,
      storeSlug: store.slug,
      items: [{ cartId: 'e2e-login-painel', id: drink.id, name: drink.name, price: drink.price, category: drink.category, quantity: 1 }],
    });
    await page.goto('/login');
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [cartKey(store.id), cart]);

    const client = DEFAULT_USERS.client;
    await loginViaUi(page, client.email, client.password);

    await expect(toast(page, 'Esta área é exclusiva da equipe')).toBeVisible();
    await expect(page).toHaveURL(`${E2E.webURL}/`);
    const session = await storedSession(page);
    expect(session.token).toBeNull();
    expect(session.user).toBeNull();
    // A sessão é descartada, mas o carrinho é da mesma pessoa: continua no aparelho
    const kept = JSON.parse(session.cart ?? '{"items":[]}') as { items: Array<{ cartId: string }> };
    expect(kept.items.map((item) => item.cartId), 'carrinho mantido').toEqual(['e2e-login-painel']);

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

  test('"Esqueci a senha" abre a recuperação por link (/esqueci-senha) com o e-mail digitado', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('nome@empresa.com.br').fill(DEFAULT_USERS.employee.email);
    await page.getByRole('link', { name: 'Esqueci a senha' }).click();
    await expect(page).toHaveURL(/\/esqueci-senha$/);
    await expect(page.getByRole('heading', { name: 'Esqueceu a senha?' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'E-mail' })).toHaveValue(DEFAULT_USERS.employee.email);
    await expect(page.getByRole('button', { name: 'Enviar link de redefinição' })).toBeEnabled();
    // Volta para o login do painel ou da loja
    await expect(page.getByRole('link', { name: 'Entrar no painel' })).toHaveAttribute('href', '/login');
    await expect(page.getByRole('link', { name: 'Entrar na loja' })).toHaveAttribute('href', '/signin');
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
  test('sair do sistema pede confirmação, encerra a sessão, apaga os carrinhos do aparelho e mantém o tema', async ({ page }) => {
    await signInAs(page, 'employee');
    await page.goto('/orders');
    await expect(pageHeading(page, 'Gestão de Pedidos')).toBeVisible({ timeout: 20_000 });

    // Tema escolhido no menu e um carrinho salvo (por loja) antes de sair
    await sidebar(page).getByRole('button', { name: /^Tema:/ }).click();
    const store = await demoStore();
    const cartValue = JSON.stringify({ v: 2, storeId: store.id, storeSlug: store.slug, items: [{ id: 'wa-cart-item', quantity: 1 }] });
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [cartKey(store.id), cartValue]);
    const before = await storedSession(page);
    expect(before.theme).toBeTruthy();
    expect(before.cart).toBe(cartValue);

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
    expect(after.session).toBeNull();
    expect(after.user).toBeNull();
    expect(after.cart, 'sair apaga os carrinhos deste aparelho (aparelho compartilhado)').toBeNull();
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
