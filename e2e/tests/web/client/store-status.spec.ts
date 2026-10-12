import { test, expect, request, type Page } from '@playwright/test';
import {
  API_URL,
  addToCart,
  cartLink,
  createClient,
  fulfillJson,
  menuSection,
  modalAddButton,
  openCart,
  openHome,
  openProduct,
  overrideStoreStatus,
  refreshStoreStatus,
  searchBox,
  searchFor,
  seedCatalog,
  trackRequests,
  useSession,
  type Catalog,
} from './helpers';

/**
 * A loja real NUNCA é fechada aqui: GET /store/status (e o store_open da cotação) são
 * interceptados com page.route e só a resposta vista por esta página muda.
 */

let catalog: Catalog;

test.beforeAll(async () => {
  catalog = await seedCatalog();
});

const CLOSING_MESSAGE = 'Voltamos amanhã às 18h.';
const visibleHeaderBadge = (page: Page, text: 'Aberto' | 'Fechado') =>
  page.getByRole('banner').getByText(text, { exact: true }).filter({ visible: true });

test.describe('Loja fechada (status simulado)', () => {
  test('vitrine mostra banner de loja fechada, a mensagem configurada, o aviso de pedidos pausados e o selo Fechado', async ({ page }) => {
    await overrideStoreStatus(page, { is_open: false, closing_message: CLOSING_MESSAGE });
    await openHome(page);

    await expect(page.getByText('LOJA FECHADA', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Estamos fechados agora 🔒' })).toBeVisible();
    await expect(page.getByText(CLOSING_MESSAGE, { exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Pedidos pausados.' })).toContainText(
      'não é possível adicionar itens ao carrinho enquanto a loja estiver fechada',
    );
    await expect(visibleHeaderBadge(page, 'Fechado')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ver Cardápio' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fazer Pedido' })).toHaveCount(0);
  });

  test('sem mensagem configurada aparece o texto padrão; adicionar fica desabilitado e o produto não abre', async ({ page }) => {
    await overrideStoreStatus(page, { is_open: false, closing_message: null });
    await openHome(page);
    await expect(page.getByText('No momento não estamos recebendo pedidos. Volte mais tarde!')).toBeVisible();

    // Destaques (Imperdíveis) também ficam bloqueados
    const imperdiveis = page.locator('section', { has: page.getByRole('heading', { name: 'Imperdíveis' }) });
    await expect(imperdiveis.getByRole('button', { name: 'Fechado', exact: true }).first()).toBeDisabled();
    await expect(imperdiveis.getByRole('button', { name: 'Adicionar', exact: true })).toHaveCount(0);

    await searchFor(page, catalog.tag);
    const menu = menuSection(page);
    for (const product of [catalog.burger, catalog.drink, catalog.promo, catalog.combo]) {
      await expect(menu.getByRole('button', { name: `${product.name}: loja fechada` })).toBeDisabled();
    }
    await expect(menu.getByRole('button', { name: `Adicionar ${catalog.drink.name}` })).toHaveCount(0);

    await menu.getByRole('heading', { name: catalog.drink.name }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(cartLink(page)).toHaveAccessibleName('Carrinho');
  });

  test('carrinho mostra "Loja fechada" com a mensagem e bloqueia cartão, PIX e pagamento na retirada', async ({ page }) => {
    const client = await createClient();
    try {
      const store = await overrideStoreStatus(page, null);
      await useSession(page, client.session);
      await openHome(page);
      await addToCart(page, catalog.drink.name);

      store.set({ is_open: false, closing_message: CLOSING_MESSAGE });
      const writes = trackRequests(page, (method, path) => method === 'POST' && (path === '/orders' || path.startsWith('/payment')));
      await openCart(page);

      const main = page.getByRole('main');
      await expect(main.getByText('Loja fechada', { exact: true })).toBeVisible();
      await expect(main.getByText(CLOSING_MESSAGE, { exact: true })).toBeVisible();

      await expect(page.getByRole('button', { name: /^Pagar (com cartão|R\$)/ })).toBeDisabled();
      await expect(page.getByText('A loja está fechada no momento.').first()).toBeVisible();

      await page.getByRole('button', { name: 'PIX', exact: true }).click();
      await expect(page.getByRole('button', { name: /^Gerar (PIX|QR Code)/ })).toBeDisabled();

      await page.getByRole('button', { name: 'Pagar na Retirada' }).click();
      await expect(page.getByRole('button', { name: 'Finalizar Pedido' })).toBeDisabled();
      expect(writes).toEqual([]);
    } finally {
      await client.api.dispose();
    }
  });

  test('se a loja fecha com o modal aberto, o botão vira "Loja fechada" na próxima consulta do status', async ({ page }) => {
    const store = await overrideStoreStatus(page, { is_open: true });
    await openHome(page);
    const dialog = await openProduct(page, catalog.burger.name);
    await expect(modalAddButton(dialog)).toBeEnabled();

    store.set({ is_open: false, closing_message: null });
    await refreshStoreStatus(page);
    await expect(dialog.getByRole('button', { name: 'Loja fechada' })).toBeDisabled();
    await expect(modalAddButton(dialog)).toHaveCount(0);
  });

  test('quando a loja reabre, a vitrine volta a aceitar pedidos na próxima consulta do status', async ({ page }) => {
    const store = await overrideStoreStatus(page, { is_open: false, closing_message: null });
    await openHome(page);
    await searchFor(page, catalog.drink.name);
    const menu = menuSection(page);
    await expect(menu.getByRole('button', { name: `${catalog.drink.name}: loja fechada` })).toBeDisabled();

    store.set({ is_open: true, closing_message: null });
    await refreshStoreStatus(page);
    await expect(menu.getByRole('button', { name: `Adicionar ${catalog.drink.name}` })).toBeEnabled();
    await expect(page.getByText('LOJA FECHADA', { exact: true })).toHaveCount(0);
    await expect(visibleHeaderBadge(page, 'Aberto')).toBeVisible();

    await addToCart(page, catalog.drink.name);
    await expect(cartLink(page)).toHaveAccessibleName('Carrinho com 1 item');
  });

  test('com a loja aberta, a mensagem de abertura configurada no painel aparece na vitrine', async ({ page }) => {
    await overrideStoreStatus(page, { is_open: true, opening_message: 'Hoje: entrega grátis no Centro!' });
    await openHome(page);
    await expect(page.getByText('Hoje: entrega grátis no Centro!', { exact: true })).toBeVisible();
    await expect(visibleHeaderBadge(page, 'Aberto')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fazer Pedido' })).toBeVisible();
  });
});

test.describe('Banner da página inicial (GET /promotions/banner)', () => {
  test('mostra o título e a mensagem da promoção devolvidos pela API', async ({ page }) => {
    const api = await request.newContext({ baseURL: API_URL });
    const banner = await (await api.get('/promotions/banner')).json();
    await api.dispose();

    await openHome(page);
    await expect(page.getByRole('heading', { name: banner.title, exact: true })).toBeVisible();
    await expect(page.getByText(banner.message, { exact: true })).toBeVisible();
    await expect(page.getByText(banner.type === 'football' ? 'Jogo de Hoje' : 'Oferta de Hoje', { exact: true })).toBeVisible();
  });

  test('banner de jogo do dia mostra os times, o campeonato e o horário', async ({ page }) => {
    await page.route(`${API_URL}/promotions/banner`, (route) =>
      fulfillJson(route, 200, {
        type: 'football',
        title: 'Hoje tem jogo! ⚽',
        message: 'Peça o combo e assista com a gente.',
        details: { home: 'Flamengo', away: 'Vasco', tournament: 'Brasileirão', time: '21:30' },
      }),
    );
    await openHome(page);
    await expect(page.getByText('Jogo de Hoje', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Hoje tem jogo! ⚽' })).toBeVisible();
    await expect(page.getByText('Flamengo', { exact: true })).toBeVisible();
    await expect(page.getByText('Vasco', { exact: true })).toBeVisible();
    await expect(page.getByText('Brasileirão · 21:30')).toBeVisible();
  });

  test('se o banner não responder, a vitrine mostra um texto padrão e o cardápio funciona', async ({ page }) => {
    await page.route(`${API_URL}/promotions/banner`, (route) => route.abort('failed'));
    await openHome(page);
    await expect(page.getByRole('heading', { name: 'Peça agora mesmo 🍔' })).toBeVisible();
    await searchFor(page, catalog.drink.name);
    await expect(menuSection(page).getByRole('heading', { name: catalog.drink.name })).toBeVisible();
    await expect(searchBox(page)).toBeVisible();
  });
});
