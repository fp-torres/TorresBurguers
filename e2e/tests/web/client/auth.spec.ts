import { test, expect, request } from '@playwright/test';
import { login, uniqueEmail } from '../../../support/api';
import { DEFAULT_USERS } from '../../../support/users';
import {
  API_URL,
  STORAGE_KEYS,
  addToCart,
  cartLine,
  cartLink,
  createClient,
  expectServerQuote,
  loginViaUI,
  openHome,
  readStorage,
  searchBox,
  seedCatalog,
  useSession,
  type Catalog,
} from './helpers';

let catalog: Catalog;

test.beforeAll(async () => {
  catalog = await seedCatalog();
});

test.describe('Cadastro pela interface', () => {
  test('mostra validações de e-mail, força e confirmação da senha antes de liberar o botão', async ({ page }) => {
    await page.goto('/signup');
    const submit = page.getByRole('button', { name: 'Criar Conta Segura' });
    await expect(submit).toBeDisabled();

    await page.getByPlaceholder('Seu Nome').fill('Maria Validação');
    await page.getByPlaceholder('(21) 99999-9999').fill('21988887777');
    await expect(page.getByPlaceholder('(21) 99999-9999')).toHaveValue('(21) 98888-7777');

    await page.getByPlaceholder('seu@email.com').fill('maria@exemplo.com');
    await page.getByPlaceholder('Repita o email').fill('maria@exemplo.co');
    await expect(page.getByText('Os emails não conferem')).toBeVisible();
    await page.getByPlaceholder('Repita o email').fill('MARIA@exemplo.com');
    await expect(page.getByText('Email confirmado!')).toBeVisible();

    const password = page.getByPlaceholder('Crie uma senha forte');
    await password.fill('abcdefghi');
    await expect(page.getByText('Força: Senha Fraca')).toBeVisible();
    await password.fill('Abcdefghi');
    await expect(page.getByText('Força: Senha Média')).toBeVisible();
    await password.fill('Abcdefgh1');
    await expect(page.getByText('Força: Senha Forte')).toBeVisible();

    await page.getByPlaceholder('Repita a senha').fill('Abcdefgh2');
    await expect(page.getByText('As senhas não coincidem')).toBeVisible();
    await expect(submit).toBeDisabled();

    await page.getByPlaceholder('Repita a senha').fill('Abcdefgh1');
    await expect(page.getByText('Senhas conferem!')).toBeVisible();
    await expect(submit).toBeEnabled();

    // Telefone incompleto bloqueia de novo
    await page.getByPlaceholder('(21) 99999-9999').fill('2198');
    await expect(submit).toBeDisabled();
  });

  test('cria uma conta de cliente, leva ao login e a nova conta consegue entrar', async ({ page }) => {
    const email = uniqueEmail('web-cadastro');
    const password = 'SenhaForte@2026';

    await page.goto('/signup');
    await page.getByPlaceholder('Seu Nome').fill('Joana Cadastro');
    await page.getByPlaceholder('(21) 99999-9999').fill('21977776666');
    await page.getByPlaceholder('seu@email.com').fill(email);
    await page.getByPlaceholder('Repita o email').fill(email);
    await page.getByPlaceholder('Crie uma senha forte').fill(password);
    await page.getByPlaceholder('Repita a senha').fill(password);
    await page.getByRole('button', { name: 'Criar Conta Segura' }).click();

    await expect(page.getByText('Conta criada com sucesso! Faça login.')).toBeVisible();
    await expect(page).toHaveURL(/\/signin$/);

    // A conta criada é de cliente, com o telefone informado
    const api = await request.newContext({ baseURL: API_URL });
    const session = await login(api, email, password);
    await api.dispose();
    expect(session.user.role).toBe('CLIENT');
    expect(String(session.user.phone).replace(/\D/g, '')).toBe('21977776666');

    await page.getByPlaceholder('seu@email.com').fill(email);
    await page.getByPlaceholder('******').fill(password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page.getByText('Bem-vindo, Joana!')).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole('button', { name: 'Menu da conta' }).click();
    await expect(page.getByText('Joana Cadastro', { exact: true })).toBeVisible();
    await expect(page.getByText(email, { exact: true })).toBeVisible();
  });

  test('e-mail já cadastrado (mesmo em maiúsculas) mostra "E-mail já cadastrado" e não sai da tela', async ({ page }) => {
    const existing = DEFAULT_USERS.client.email.toUpperCase();
    await page.goto('/signup');
    await page.getByPlaceholder('Seu Nome').fill('Cliente Repetido');
    await page.getByPlaceholder('(21) 99999-9999').fill('21955554444');
    await page.getByPlaceholder('seu@email.com').fill(existing);
    await page.getByPlaceholder('Repita o email').fill(existing);
    await page.getByPlaceholder('Crie uma senha forte').fill('SenhaForte@2026');
    await page.getByPlaceholder('Repita a senha').fill('SenhaForte@2026');
    await page.getByRole('button', { name: 'Criar Conta Segura' }).click();

    await expect(page.getByText('E-mail já cadastrado')).toBeVisible();
    await expect(page).toHaveURL(/\/signup$/);
  });
});

test.describe('Login e logout na loja', () => {
  test('senha errada mostra aviso e não abre sessão', async ({ page }) => {
    await loginViaUI(page, DEFAULT_USERS.client.email, 'SenhaErrada@1');
    await expect(page.getByText('Email ou senha inválidos.')).toBeVisible();
    await expect(page).toHaveURL(/\/signin$/);
    const storage = await readStorage(page);
    expect(storage[STORAGE_KEYS.token]).toBeUndefined();
    expect(storage[STORAGE_KEYS.user]).toBeUndefined();
  });

  test('cliente com carrinho cheio entra pelo menu e volta direto para o carrinho já com a cotação', async ({ page }) => {
    const client = await createClient({ name: 'Lucas Carrinho' });
    try {
      await openHome(page);
      await addToCart(page, catalog.drink.name);

      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await expect(page.getByText('Olá, visitante!')).toBeVisible();
      await page.getByRole('link', { name: 'Entrar', exact: true }).click();
      await expect(page).toHaveURL(/\/signin$/);

      await page.getByPlaceholder('seu@email.com').fill(`  ${client.email.toUpperCase()}  `);
      await page.getByPlaceholder('******').fill(client.password);
      await page.getByRole('button', { name: 'Entrar', exact: true }).click();

      await expect(page).toHaveURL(/\/cart$/);
      await expect(cartLine(page, catalog.drink.name)).toBeVisible();
      await expectServerQuote(page);
    } finally {
      await client.api.dispose();
    }
  });

  test('sair da conta mantém o carrinho e o tema escolhido', async ({ page }) => {
    const client = await createClient({ name: 'Paula Logout' });
    try {
      await useSession(page, client.session);
      await openHome(page);
      await addToCart(page, catalog.drink.name);

      await page.getByRole('button', { name: 'Alterar Tema' }).click();
      await page.getByRole('button', { name: 'Escuro', exact: true }).click();
      await expect(page.locator('html')).toHaveClass(/\bdark\b/);

      await page.getByRole('button', { name: 'Menu da conta' }).click();
      await page.getByRole('button', { name: 'Sair da Conta' }).click();
      const confirm = page.getByRole('alertdialog', { name: 'Sair?' });
      await expect(confirm).toBeVisible();
      await confirm.getByRole('button', { name: 'Sair', exact: true }).click();

      await expect(page.getByText('Você saiu da conta. Volte sempre!')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
      await expect(cartLink(page)).toHaveAccessibleName('Carrinho com 1 item');
      await expect(page.locator('html')).toHaveClass(/\bdark\b/);

      const storage = await readStorage(page);
      expect(storage[STORAGE_KEYS.token]).toBeUndefined();
      expect(storage[STORAGE_KEYS.user]).toBeUndefined();
      expect(storage[STORAGE_KEYS.theme]).toBe('dark');
      expect(JSON.parse(storage[STORAGE_KEYS.cart])).toHaveLength(1);

      await page.reload();
      await expect(searchBox(page)).toBeVisible();
      await expect(cartLink(page)).toHaveAccessibleName('Carrinho com 1 item');
      await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    } finally {
      await client.api.dispose();
    }
  });

  test('"Esqueceu a senha?" explica que o administrador redefine a senha e mostra o e-mail de suporte', async ({ page }) => {
    await page.goto('/signin');
    await page.getByRole('link', { name: 'Esqueceu a senha?' }).click();
    const message = page.getByText(/contato@comestra\.com\.br/);
    await expect(message).toBeVisible();
    await expect(message).toContainText('administrador');
    await expect(page).toHaveURL(/\/signin$/);
  });

  test('conta da equipe que entra pela tela da loja é levada ao painel do seu perfil', async ({ page }) => {
    await loginViaUI(page, DEFAULT_USERS.kitchen.email, DEFAULT_USERS.kitchen.password);
    await expect(page).toHaveURL(/\/orders$/);
    await expect(page.getByText('Você entrou como Cozinha. Abrindo o painel da equipe.')).toBeVisible();
  });
});
