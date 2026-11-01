import { test, expect, type Page } from '@playwright/test';
import {
  addToCart,
  brl,
  cartLink,
  createAddress,
  createClient,
  demoStore,
  getOrder,
  loginViaUI,
  menuSection,
  money,
  nextOrderCreation,
  openCart,
  openHome,
  readStorage,
  seedCatalog,
  storePath,
  storeUrl,
  summaryValue,
  useSession,
  waitForStoreOpen,
  STORAGE_KEYS,
  type Catalog,
  type TestClient,
} from './helpers';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

let catalog: Catalog;
const clients: TestClient[] = [];

test.beforeAll(async () => {
  catalog = await seedCatalog();
});

test.afterEach(async () => {
  while (clients.length) await clients.pop()!.api.dispose();
});

async function newClient(name: string): Promise<TestClient> {
  const client = await createClient({ name });
  clients.push(client);
  return client;
}

async function expectNoHorizontalScroll(page: Page, where: string): Promise<void> {
  const size = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(size.scrollWidth, `rolagem horizontal em ${where}`).toBeLessThanOrEqual(size.clientWidth);
}

test.describe('Vitrine no celular (390x844)', () => {
  test('fluxo principal: entrar, personalizar o lanche, entrega com dinheiro e acompanhar em Meus Pedidos', async ({ page }) => {
    await waitForStoreOpen();
    const client = await newClient('Bruno Celular');
    await createAddress(client.api, { nickname: 'Casa', neighborhood: 'Botafogo', street: 'Rua São Clemente', number: '120' });

    // Sem loja visitada antes, o login leva ao diretório de lojas (marca Comestra); dali o cliente escolhe a loja
    await loginViaUI(page, client.email, client.password);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText('Bem-vindo, Bruno!')).toBeVisible();
    await expect(page.getByRole('banner').getByRole('link', { name: 'Página inicial' })).toContainText('Comestra');
    await expectNoHorizontalScroll(page, 'diretório de lojas');

    const store = await demoStore();
    await page.getByRole('link', { name: new RegExp(store.name) }).first().click();
    await expect(page).toHaveURL(storeUrl());
    await expect(page.getByRole('banner').getByRole('link', { name: `${store.name}: cardápio` })).toBeVisible();
    await expect(menuSection(page).getByRole('button', { name: 'Tudo', exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page, 'vitrine');

    await addToCart(page, catalog.burger.name, {
      meatPoint: 'Mal Passado',
      addons: [catalog.bacon.name],
      removeIngredients: ['Alface'],
      observation: 'Sem maionese',
    });
    await expect(cartLink(page)).toHaveAccessibleName('Carrinho com 1 item');
    await cartLink(page).click();
    await expect(page).toHaveURL(storeUrl('cart'));
    await expectNoHorizontalScroll(page, 'carrinho');

    const total = money(catalog.burger.price, catalog.bacon.price, 7); // Botafogo: R$ 7,00
    await page.getByRole('button', { name: 'Delivery', exact: true }).click();
    await expect(page.getByRole('radio', { name: /Casa - Rua São Clemente, 120/ })).toBeChecked();
    await expect(summaryValue(page, 'Taxa de entrega')).toHaveText(brl(7));
    await expect(summaryValue(page, 'Total')).toHaveText(brl(total));

    await page.getByRole('button', { name: 'Pagar na Entrega' }).click();
    await page.getByLabel('Troco para quanto?').fill('5000');
    const creation = nextOrderCreation(page);
    await page.getByRole('button', { name: 'Finalizar Pedido' }).click();
    const { status, order: created } = await creation;
    expect(status, JSON.stringify(created)).toBe(201);

    await expect(page.getByRole('heading', { name: 'Pedido Confirmado! 🎉' })).toBeVisible();
    await expect(page.getByText(`Pedido #${created.number} · ${store.name}`, { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page, 'pedido confirmado');

    await page.getByRole('link', { name: 'Meus Pedidos' }).click();
    await page.getByText(`Pedido #${created.number}`, { exact: true }).click();
    await expect(page.getByText(brl(total), { exact: true })).toBeVisible();
    await expect(page.getByText('Dinheiro', { exact: true })).toBeVisible();
    await expect(page.getByText(`Pagar na entrega · troco para ${brl(50)}`)).toBeVisible();
    await expect(page.getByText('🔥 Mal Passado')).toBeVisible();
    await expectNoHorizontalScroll(page, 'Meus Pedidos');

    expect(await getOrder(client.api, created.id)).toMatchObject({
      total_price: total,
      delivery_fee: 7,
      type: 'DELIVERY',
      payment_method: 'MONEY',
      status: 'PENDING',
    });
  });

  test('as páginas da loja cabem na largura do celular, sem rolagem horizontal', async ({ page }) => {
    const client = await newClient('Cliente Largura');
    await useSession(page, client.session);

    await openHome(page);
    await expectNoHorizontalScroll(page, storePath());
    await addToCart(page, catalog.promo.name);

    await openCart(page);
    await expectNoHorizontalScroll(page, storePath('cart'));

    for (const [path, ready] of [
      ['/', page.getByRole('heading', { level: 1, name: /estabelecimentos/ })],
      ['/my-orders', page.getByText('Nenhum pedido ainda')],
      ['/esqueci-senha', page.getByRole('heading', { name: 'Esqueceu a senha?' })],
      ['/profile', page.getByRole('heading', { name: /Meus Dados/ })],
      ['/signin', page.getByRole('heading', { name: /Bem-vindo de volta/ })],
      ['/signup', page.getByRole('heading', { name: /Crie sua conta/ })],
      ['/nao-existe', page.getByRole('heading', { name: 'Página não encontrada' })],
    ] as const) {
      await page.goto(path);
      await expect(ready).toBeVisible();
      await expectNoHorizontalScroll(page, path);
    }
  });

  test('no celular o tema fica no menu da conta; sair apaga o carrinho deste aparelho e mantém o tema', async ({ page }) => {
    const client = await newClient('Cliente Menu');
    await useSession(page, client.session);
    await openHome(page);
    await addToCart(page, catalog.drink.name);

    // O botão de tema do cabeçalho some no celular; o seletor fica dentro do menu
    await expect(page.getByRole('button', { name: 'Alterar Tema' })).toBeHidden();
    await page.getByRole('button', { name: 'Menu da conta' }).click();
    const appearance = page.getByText('Aparência', { exact: true });
    await expect(appearance).toBeVisible();
    const themeButtons = appearance.locator('xpath=following-sibling::div[1]//button');
    await expect(themeButtons).toHaveCount(3);
    await themeButtons.nth(1).click(); // claro, escuro, sistema
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);

    await page.getByRole('button', { name: 'Sair da Conta' }).click();
    await page.getByRole('alertdialog', { name: 'Sair?' }).getByRole('button', { name: 'Sair', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
    // Aparelho compartilhado: o carrinho de quem saiu não fica para a próxima pessoa
    await expect(cartLink(page)).toHaveAccessibleName('Carrinho');
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);

    const storage = await readStorage(page);
    expect(storage[STORAGE_KEYS.token]).toBeUndefined();
    expect(storage[STORAGE_KEYS.theme]).toBe('dark');
    expect(Object.keys(storage).filter((key) => key.startsWith(`${STORAGE_KEYS.cart}.`))).toEqual([]);
  });
});
