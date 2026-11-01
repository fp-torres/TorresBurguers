import { test, expect, request } from '@playwright/test';
import { contextAs, login, uniqueEmail } from '../../../support/api';
import { DEFAULT_USERS } from '../../../support/users';
import { expectCookieSession } from '../../../support/web';
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
  storeUrl,
  storePath,
  storedCartItems,
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

  test('cria uma conta de cliente, já entra na conta e volta para a loja visitada', async ({ page }) => {
    const email = uniqueEmail('web-cadastro');
    const password = 'SenhaForte@2026';

    // Loja visitada antes do cadastro (é para ela que o cliente volta)
    await openHome(page);
    await page.goto('/signup');
    await page.getByPlaceholder('Seu Nome').fill('Joana Cadastro');
    await page.getByPlaceholder('(21) 99999-9999').fill('21977776666');
    await page.getByPlaceholder('seu@email.com').fill(email);
    await page.getByPlaceholder('Repita o email').fill(email);
    await page.getByPlaceholder('Crie uma senha forte').fill(password);
    await page.getByPlaceholder('Repita a senha').fill(password);
    await page.getByRole('button', { name: 'Criar Conta Segura' }).click();

    // A conta é criada e a sessão já é aberta: volta ao cardápio da loja
    await expect(page.getByText('Conta criada! Bem-vindo, Joana!')).toBeVisible();
    // O link de confirmação do e-mail sai em segundo plano: a tela avisa onde procurar
    await expect(page.getByText(`Enviamos um link para confirmar o e-mail ${email}.`)).toBeVisible();
    await expect(page).toHaveURL(storeUrl());
    const storage = await readStorage(page);
    // Sessão aberta em cookie: marcador sem segredo no navegador, token de acesso só na memória da aba
    expect(storage[STORAGE_KEYS.session], 'sessão aberta').toBeTruthy();
    await expectCookieSession(page);
    expect(storage[STORAGE_KEYS.user]).not.toMatch(/password/i);

    // A conta criada é de cliente (global, sem loja), com o telefone informado, e entra pela API
    const api = await request.newContext({ baseURL: API_URL });
    const session = await login(api, email, password);
    await api.dispose();
    expect(session.user.role).toBe('CLIENT');
    expect(session.user.store_id).toBeNull();
    expect(String(session.user.phone).replace(/\D/g, '')).toBe('21977776666');

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
      // O login guarda o destino: o carrinho desta loja
      await expect(page).toHaveURL(/\/signin(\?|$)/);

      await page.getByPlaceholder('seu@email.com').fill(`  ${client.email.toUpperCase()}  `);
      await page.getByPlaceholder('******').fill(client.password);
      await page.getByRole('button', { name: 'Entrar', exact: true }).click();

      await expect(page).toHaveURL(storeUrl('cart'));
      await expect(cartLine(page, catalog.drink.name)).toBeVisible();
      await expectServerQuote(page);
    } finally {
      await client.api.dispose();
    }
  });

  // Aparelho compartilhado: quem sai não deixa carrinho (com observações livres) nem a última loja para a próxima pessoa
  test('sair da conta apaga os carrinhos e a última loja deste aparelho e mantém o tema escolhido', async ({ page }) => {
    const client = await createClient({ name: 'Paula Logout' });
    try {
      await useSession(page, client.session);
      await openHome(page);
      await addToCart(page, catalog.drink.name, { observation: 'Entregar para a Ana, apto 302' });
      // Carrinho de outra loja guardado neste aparelho (as chaves são por loja)
      await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ v: 2, storeId: 999999, storeSlug: 'outra-loja', items: [] })), `${STORAGE_KEYS.cart}.999999`);

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
      await expect(cartLink(page)).toHaveAccessibleName('Carrinho');
      await expect(page.locator('html')).toHaveClass(/\bdark\b/);

      const storage = await readStorage(page);
      expect(storage[STORAGE_KEYS.token]).toBeUndefined();
      expect(storage[STORAGE_KEYS.user]).toBeUndefined();
      expect(storage[STORAGE_KEYS.theme]).toBe('dark');
      expect(storage[STORAGE_KEYS.lastStore], 'última loja de quem saiu').toBeUndefined();
      expect(Object.keys(storage).filter((key) => key === STORAGE_KEYS.cart || key.startsWith(`${STORAGE_KEYS.cart}.`)), 'carrinhos de quem saiu').toEqual([]);
      expect(JSON.stringify(storage)).not.toContain('apto 302');

      await page.reload();
      await expect(searchBox(page)).toBeVisible();
      await expect(cartLink(page)).toHaveAccessibleName('Carrinho');
      await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    } finally {
      await client.api.dispose();
    }
  });

  test('depois que um cliente sai, a próxima pessoa que entra não é levada ao carrinho nem vê os itens de quem saiu', async ({ page }) => {
    const first = await createClient({ name: 'Ana Primeira' });
    const next = await createClient({ name: 'Bruno Seguinte' });
    try {
      await useSession(page, first.session);
      await openHome(page);
      await addToCart(page, catalog.drink.name, { observation: 'Interfone quebrado, apto 302' });
      await page.getByRole('button', { name: 'Menu da conta' }).click();
      await page.getByRole('button', { name: 'Sair da Conta' }).click();
      await page.getByRole('alertdialog', { name: 'Sair?' }).getByRole('button', { name: 'Sair', exact: true }).click();
      await expect(page.getByText('Você saiu da conta. Volte sempre!')).toBeVisible();

      // A próxima pessoa entra pelo /signin sem destino: vai para o diretório, não para o carrinho da loja anterior
      await loginViaUI(page, next.email, next.password);
      await expect(page).toHaveURL((url) => url.pathname === '/');
      await page.goto(storePath('cart'));
      await expect(cartLink(page)).toHaveAccessibleName('Carrinho');
      await expect(cartLine(page, catalog.drink.name)).toHaveCount(0);
      expect(JSON.stringify(await readStorage(page))).not.toContain('apto 302');
    } finally {
      await first.api.dispose();
      await next.api.dispose();
    }
  });

  test('"Esqueceu a senha?" abre /esqueci-senha com o e-mail digitado e pede o link (resposta genérica)', async ({ page }) => {
    const client = await createClient({ name: 'Rita Esqueceu' });
    try {
      await page.goto('/signin');
      await page.getByPlaceholder('seu@email.com').fill(client.email);
      await page.getByRole('link', { name: 'Esqueceu a senha?' }).click();
      await expect(page).toHaveURL(/\/esqueci-senha$/);
      await expect(page.getByRole('heading', { name: 'Esqueceu a senha?' })).toBeVisible();
      await expect(page.getByLabel('E-mail')).toHaveValue(client.email);

      const sent = page.waitForResponse((r) => r.url() === `${API_URL}/auth/forgot-password` && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Enviar link de redefinição' }).click();
      expect((await sent).status()).toBe(202);
      await expect(page.getByRole('heading', { name: 'Verifique seu e-mail' })).toBeVisible();
      await expect(page.getByText('Se houver uma conta com este e-mail', { exact: false })).toBeVisible();
      await expect(page.getByRole('link', { name: 'contato@comestra.com.br' })).toBeVisible();

      // Pedir o link não troca a senha: a conta continua entrando com a senha atual
      const api = await request.newContext({ baseURL: API_URL });
      expect((await login(api, client.email, client.password)).user.id).toBe(client.session.user.id);
      await api.dispose();
    } finally {
      await client.api.dispose();
    }
  });

  test('link de redefinição (/redefinir-senha/:token) troca a senha pela tela, vale uma vez e a conta entra com a senha nova', async ({ page }) => {
    const client = await createClient({ name: 'Bruno Redefine' });
    const { ctx: superadmin } = await contextAs('superadmin');
    try {
      // Sem provedor de e-mail, o link de uso único é gerado pelo superpainel
      const res = await superadmin.post(`/platform/users/${client.session.user.id}/password-reset`);
      expect(res.status(), await res.text()).toBe(200);
      const { url } = await res.json();
      const path = new URL(url).pathname;
      expect(path).toMatch(/^\/redefinir-senha\/[A-Za-z0-9_-]+$/);

      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Crie uma nova senha' })).toBeVisible();
      const newPassword = 'NovaSenha#Web2026';
      await page.getByRole('textbox', { name: 'Nova senha', exact: true }).fill(newPassword);
      await page.getByRole('textbox', { name: 'Confirmar nova senha', exact: true }).fill(newPassword);
      const saved = page.waitForResponse((r) => r.url() === `${API_URL}/auth/reset-password` && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Salvar nova senha' }).click();
      expect((await saved).status()).toBe(200);
      await expect(page).toHaveURL(/\/signin$/);
      await expect(page.getByText('Senha redefinida. Entre com a nova senha.')).toBeVisible();

      // A sessão antiga caiu; a senha antiga não entra mais e a nova entra
      expect((await client.api.get('/addresses')).status()).toBe(401);
      await loginViaUI(page, client.email, client.password);
      await expect(page.getByText('Email ou senha inválidos.')).toBeVisible();
      await loginViaUI(page, client.email, newPassword);
      await expect(page.getByText('Bem-vindo, Bruno!')).toBeVisible();

      // Uso único: o mesmo link não vale de novo
      await page.goto(path);
      await expect(page.getByRole('heading', { name: 'Link inválido' })).toBeVisible();
      await expect(page.getByText('Este link não vale mais', { exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Pedir novo link' })).toHaveAttribute('href', '/esqueci-senha');
    } finally {
      await superadmin.dispose();
      await client.api.dispose();
    }
  });

  test('redefinir a senha com a própria sessão aberta neste navegador encerra a sessão, mas mantém o carrinho', async ({ page }) => {
    const client = await createClient({ name: 'Carla Redefine' });
    const { ctx: superadmin } = await contextAs('superadmin');
    try {
      await useSession(page, client.session);
      await openHome(page);
      await addToCart(page, catalog.drink.name);
      expect((await storedCartItems(page)).map((item) => item.name)).toEqual([catalog.drink.name]);

      const res = await superadmin.post(`/platform/users/${client.session.user.id}/password-reset`);
      expect(res.status(), await res.text()).toBe(200);
      const { url } = await res.json();
      await page.goto(new URL(url).pathname);
      await expect(page.getByRole('heading', { name: 'Crie uma nova senha' })).toBeVisible();
      const newPassword = 'NovaSenha#Carla2026';
      await page.getByRole('textbox', { name: 'Nova senha', exact: true }).fill(newPassword);
      await page.getByRole('textbox', { name: 'Confirmar nova senha', exact: true }).fill(newPassword);
      await page.getByRole('button', { name: 'Salvar nova senha' }).click();
      await expect(page).toHaveURL(/\/signin$/);

      // A sessão desta conta (que deixou de valer) sai do navegador; o carrinho é da mesma pessoa e fica
      const storage = await readStorage(page);
      expect(storage[STORAGE_KEYS.token], 'token removido').toBeUndefined();
      expect(storage[STORAGE_KEYS.user], 'usuário removido').toBeUndefined();
      expect((await storedCartItems(page)).map((item) => item.name), 'carrinho mantido').toEqual([catalog.drink.name]);
    } finally {
      await superadmin.dispose();
      await client.api.dispose();
    }
  });

  test('conta da equipe que entra pela tela da loja é levada ao painel do seu perfil', async ({ page }) => {
    await loginViaUI(page, DEFAULT_USERS.kitchen.email, DEFAULT_USERS.kitchen.password);
    await expect(page).toHaveURL(/\/orders$/);
    await expect(page.getByText('Você entrou como Cozinha. Abrindo o painel da equipe.')).toBeVisible();
  });
});
