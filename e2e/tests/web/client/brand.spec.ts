import { test, expect, type Page } from '@playwright/test';
import {
  STORAGE_KEYS,
  addToCart,
  createClient,
  menuSection,
  openHome,
  openProduct,
  readStorage,
  seedCatalog,
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

test.describe('Marca Comestra na vitrine', () => {
  let catalog: Catalog;
  let client: TestClient;

  test.beforeAll(async () => {
    catalog = await seedCatalog();
    client = await createClient({ name: 'Cliente Marca' });
  });

  test.afterAll(async () => {
    await client?.api.dispose();
  });

  test('título da aba, logo do cabeçalho e rodapé mostram o nome Comestra', async ({ page }) => {
    await openHome(page);

    await expect(page).toHaveTitle(/^Comestra\b/);
    await expect(page.getByRole('banner').getByRole('link', { name: 'Página inicial' })).toContainText('Comestra');
    await expect(page.getByRole('contentinfo')).toContainText(`© ${new Date().getFullYear()} Comestra`);
    await expect(page.getByRole('contentinfo').getByRole('link', { name: 'contato@comestra.com.br' })).toBeVisible();

    // Telas de login e cadastro também levam a marca
    await page.goto('/signin');
    await expect(page.getByRole('link', { name: 'Página inicial' })).toContainText('Comestra');
    await page.goto('/signup');
    await expect(page.getByRole('link', { name: 'Página inicial' })).toContainText('Comestra');
    await expect(page).toHaveTitle(/^Comestra\b/);
  });

  test('o nome antigo "Torres" não aparece em nenhuma página da loja nem nas chaves do navegador', async ({ page }) => {
    await useSession(page, client.session);

    const pages: { path: string; ready: (p: Page) => Promise<void> }[] = [
      { path: '/', ready: async (p) => { await expect(menuSection(p).getByRole('button', { name: 'Tudo', exact: true })).toBeVisible(); } },
      { path: '/signin', ready: async (p) => { await expect(p.getByRole('heading', { name: /Bem-vindo de volta/ })).toBeVisible(); } },
      { path: '/signup', ready: async (p) => { await expect(p.getByRole('heading', { name: /Crie sua conta/ })).toBeVisible(); } },
      { path: '/my-orders', ready: async (p) => { await expect(p.getByText('Nenhum pedido ainda')).toBeVisible(); } },
      { path: '/profile', ready: async (p) => { await expect(p.getByRole('heading', { name: /Meus Dados/ })).toBeVisible(); } },
      { path: '/order-success', ready: async (p) => { await expect(p.getByRole('heading', { name: /Pedido Confirmado/ })).toBeVisible(); } },
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
    await page.goto('/cart');
    await expect(page.getByRole('heading', { name: 'Carrinho', level: 1 })).toBeVisible();
    expect(await visibleBranding(page), 'carrinho').not.toMatch(/torres/i);

    // As chaves salvas no navegador usam o novo nome (comestra.*)
    const keys = Object.keys(await readStorage(page));
    expect(keys.join(','), 'chaves do localStorage').not.toMatch(/torres/i);
    expect(keys).toEqual(expect.arrayContaining([STORAGE_KEYS.token, STORAGE_KEYS.user, STORAGE_KEYS.cart, STORAGE_KEYS.theme]));
    expect(STORAGE_KEYS.cart.startsWith('comestra.')).toBe(true);
  });
});
