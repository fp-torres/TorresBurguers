import { test, expect, type Page } from '@playwright/test';
import {
  STORAGE_KEYS,
  addToCart,
  cartKey,
  createClient,
  demoStore,
  menuSection,
  openHome,
  openProduct,
  readStorage,
  seedCatalog,
  storePath,
  useSession,
  type Catalog,
  type TestClient,
} from './helpers';

/** Texto visível + atributos lidos por leitores de tela/navegador (título, alt, title, aria-label, placeholder, meta). */
async function visibleBranding(page: Page): Promise<string> {
  return page.evaluate(() => {
    const attributes = ['alt', 'title', 'aria-label', 'placeholder', 'content'];
    const attrText = [...document.querySelectorAll('[alt],[title],[aria-label],[placeholder],meta[content]')]
      .map((element) => attributes.map((name) => element.getAttribute(name) ?? '').join(' '))
      .join('\n');
    return [document.title, document.body.innerText, attrText].join('\n');
  });
}

/**
 * Plataforma × loja: a vitrine (/loja/<slug>) mostra a identidade da LOJA (nome no cabeçalho e na aba) e
 * "Pedidos online por Comestra" no rodapé; o diretório (/), o login, o cadastro e as páginas da conta
 * mostram a marca Comestra. Nenhum "Torres" em lugar nenhum.
 */
test.describe('Marca Comestra e identidade da loja na vitrine', () => {
  let catalog: Catalog;
  let client: TestClient;

  test.beforeAll(async () => {
    catalog = await seedCatalog();
    client = await createClient({ name: 'Cliente Marca' });
  });

  test.afterAll(async () => {
    await client?.api.dispose();
  });

  test('diretório, login e cadastro mostram Comestra; a vitrine mostra a loja no cabeçalho e na aba e Comestra no rodapé', async ({ page }) => {
    const store = await demoStore();
    const year = new Date().getFullYear();

    // Diretório de lojas (/): marca da plataforma e a loja demo na lista
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Peça nos estabelecimentos da sua região' })).toBeVisible();
    await expect(page).toHaveTitle(/^Comestra\b/);
    await expect(page.getByRole('banner').getByRole('link', { name: 'Página inicial' })).toContainText('Comestra');
    await expect(page.getByRole('contentinfo')).toContainText(`© ${year} Comestra`);
    await expect(page.getByRole('contentinfo').getByRole('link', { name: 'contato@comestra.com.br' })).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(store.name) }).first()).toHaveAttribute('href', storePath());

    // Vitrine da loja: identidade da loja; a plataforma só no rodapé
    await openHome(page);
    await expect(page).toHaveTitle(`${store.name} | Comestra`);
    const header = page.getByRole('banner');
    await expect(header.getByRole('link', { name: `${store.name}: cardápio` })).toContainText(store.name);
    await expect(header, 'o cabeçalho da vitrine é da loja').not.toContainText('Comestra', { useInnerText: true });
    await expect(page.getByRole('heading', { level: 1, name: store.name })).toBeVisible();
    const footer = page.getByRole('contentinfo');
    await expect(footer).toContainText(`© ${year} ${store.name}`);
    await expect(footer.getByRole('link', { name: 'Pedidos online por Comestra' })).toHaveAttribute('href', '/');

    // Telas de login e cadastro levam a marca da plataforma
    await page.goto('/signin');
    await expect(page.getByRole('link', { name: 'Página inicial' })).toContainText('Comestra');
    await expect(page).toHaveTitle(/^Comestra\b/);
    await page.goto('/signup');
    await expect(page.getByRole('link', { name: 'Página inicial' })).toContainText('Comestra');
    await expect(page).toHaveTitle(/^Comestra\b/);
  });

  test('o nome antigo "Torres" não aparece em nenhuma página (plataforma, vitrine e conta) nem nas chaves do navegador', async ({ page }) => {
    await useSession(page, client.session);

    const pages: { path: string; ready: (p: Page) => Promise<void> }[] = [
      { path: '/', ready: async (p) => { await expect(p.getByRole('heading', { level: 1, name: /estabelecimentos/ })).toBeVisible(); } },
      { path: storePath(), ready: async (p) => { await expect(menuSection(p).getByRole('button', { name: 'Tudo', exact: true })).toBeVisible(); } },
      { path: '/signin', ready: async (p) => { await expect(p.getByRole('heading', { name: /Bem-vindo de volta/ })).toBeVisible(); } },
      { path: '/signup', ready: async (p) => { await expect(p.getByRole('heading', { name: /Crie sua conta/ })).toBeVisible(); } },
      { path: '/esqueci-senha', ready: async (p) => { await expect(p.getByRole('heading', { name: 'Esqueceu a senha?' })).toBeVisible(); } },
      { path: '/my-orders', ready: async (p) => { await expect(p.getByText('Nenhum pedido ainda')).toBeVisible(); } },
      { path: '/profile', ready: async (p) => { await expect(p.getByRole('heading', { name: /Meus Dados/ })).toBeVisible(); } },
      { path: storePath('order-success'), ready: async (p) => { await expect(p.getByRole('heading', { name: 'Acompanhe seus pedidos' })).toBeVisible(); } },
      { path: '/rota-que-nao-existe', ready: async (p) => { await expect(p.getByRole('heading', { name: 'Página não encontrada' })).toBeVisible(); } },
    ];

    for (const { path, ready } of pages) {
      await page.goto(path);
      await ready(page);
      expect(await visibleBranding(page), `texto da página ${path}`).not.toMatch(/torres/i);
    }

    // Modal do produto, carrinho com itens e menu da conta
    await openHome(page);
    const dialog = await openProduct(page, catalog.burger.name);
    expect(await visibleBranding(page), 'modal do produto').not.toMatch(/torres/i);
    await dialog.getByRole('button', { name: 'Fechar' }).click();
    await addToCart(page, catalog.drink.name);
    await page.getByRole('button', { name: 'Menu da conta' }).click();
    expect(await visibleBranding(page), 'menu da conta').not.toMatch(/torres/i);
    await page.goto(storePath('cart'));
    await expect(page.getByRole('heading', { name: 'Carrinho', level: 1 })).toBeVisible();
    expect(await visibleBranding(page), 'carrinho').not.toMatch(/torres/i);

    // As chaves salvas no navegador usam o novo nome (comestra.*), com o carrinho e a última loja por loja
    const store = await demoStore();
    const keys = Object.keys(await readStorage(page));
    expect(keys.join(','), 'chaves do localStorage').not.toMatch(/torres/i);
    expect(keys).toEqual(
      expect.arrayContaining([STORAGE_KEYS.token, STORAGE_KEYS.user, cartKey(store.id), STORAGE_KEYS.theme, STORAGE_KEYS.lastStore]),
    );
    expect(keys.every((key) => key.startsWith('comestra.')), `chaves: ${keys.join(', ')}`).toBe(true);
    expect((await readStorage(page))[STORAGE_KEYS.lastStore]).toBe(store.slug);
  });
});
