import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { E2E, cartKey } from '../../../support/env';
import { contextAs, demoStore, type PublicStore } from '../../../support/api';
import { storePath, storeUrl, useSession } from '../../../support/web';
import { addToCart, cartLine, cartLink, menuSection, readStorage, searchBox, searchFor, summaryValue } from '../client/helpers';
import { orderCard, orderCardHeading } from '../admin/helpers';
import {
  addProduct,
  bearer,
  escapeRegex,
  expectStatus,
  newApi,
  newCustomer,
  retireTenantStore,
  superadminSession,
  tenantStore,
  uid,
  type Json,
  type Member,
  type Session,
  type TenantStore,
} from '../platform/helpers';

/**
 * Vitrine com várias lojas: diretório em / (só lojas vendendo), /loja/<slug> de duas lojas com cardápios
 * diferentes, carrinho separado por loja, checkout na loja B que cria o pedido NA LOJA B (número da loja, no
 * quadro da equipe de B e nunca no da loja demo), loja suspensa indisponível e endereço fora da área de uma loja
 * que recusa entregas fora das zonas. Lojas próprias deste arquivo (desativadas no fim); a loja demo só ganha um
 * produto deste arquivo, que vai para a lixeira no fim.
 */

let api: APIRequestContext;
let superadmin: Session;
let demo: PublicStore;
const tag = uid('vit').replace(/-/g, '');
const stores: TenantStore[] = [];
let storeB: TenantStore;
let demoProduct: Json;
let productB: Json;

test.beforeAll(async () => {
  api = await newApi();
  superadmin = await superadminSession(api);
  demo = await demoStore();
  storeB = await tenantStore(api, superadmin, `Vitrine ${tag} B`);
  stores.push(storeB);
  productB = await addProduct(api, storeB.owner, { name: `Pastel Exclusivo B ${tag}`, price: 14.5, category: 'bebidas' });
  const { ctx: demoAdmin } = await contextAs('admin');
  try {
    const res = await demoAdmin.post('/products', { data: { name: `Suco Exclusivo Demo ${tag}`, price: 9.5, category: 'bebidas' } });
    demoProduct = await expectStatus(res, 201, 'produto da loja demo');
  } finally {
    await demoAdmin.dispose();
  }
});

test.afterAll(async () => {
  for (const store of stores) await retireTenantStore(api, superadmin, store);
  const { ctx: demoAdmin } = await contextAs('admin');
  await demoAdmin.delete(`/products/${demoProduct.id}`).catch(() => undefined);
  await demoAdmin.dispose();
  await api.dispose();
});

async function extraStore(label: string, options: { open?: boolean; delivery?: boolean } = {}): Promise<TenantStore> {
  const store = await tenantStore(api, superadmin, `Vitrine ${tag} ${label}`, options);
  stores.push(store);
  return store;
}

/** Abre a vitrine da loja e espera o cardápio. */
async function openStorefront(page: Page, store: { slug: string; name: string }): Promise<void> {
  await page.goto(storePath(undefined, store.slug));
  await expect(page.getByRole('heading', { level: 1, name: store.name })).toBeVisible();
  await expect(searchBox(page)).toBeVisible();
}

async function expectInMenu(page: Page, name: string, present: boolean): Promise<void> {
  await searchFor(page, name);
  await expect(menuSection(page).getByRole('heading', { name, exact: true })).toHaveCount(present ? 1 : 0);
}

/** Itens do carrinho guardado de uma loja ("comestra.cart.<storeId>"). */
async function savedCart(page: Page, storeId: number): Promise<Json[]> {
  const raw = (await readStorage(page))[cartKey(storeId)];
  return raw ? (JSON.parse(raw).items as Json[]) : [];
}

/** Outra aba de navegador (contexto novo) com a sessão informada já injetada. */
async function panelPage(browser: Browser, session: Session): Promise<Page> {
  const context = await browser.newContext({
    baseURL: E2E.webURL,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  await useSession(page, session);
  return page;
}

test('diretório em / mostra só as lojas vendendo e leva à vitrine de cada uma', async ({ page }) => {
  const storeC = await extraStore('C', { delivery: false });
  const closedStore = await extraStore('Desativada', { open: false, delivery: false });
  await expectStatus(
    await api.post(`/platform/stores/${closedStore.id}/deactivate`, { headers: bearer(superadmin.token), data: { reason: 'Diretório (E2E web).' } }),
    200,
    'desativar a loja',
  );

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Peça nos estabelecimentos da sua região', level: 1 })).toBeVisible();
  // A seção do diretório tem o nome do título: "Estabelecimentos" e, durante a busca, "Resultados da busca"
  const directory = page.getByRole('region', { name: /^(Estabelecimentos|Resultados da busca)$/ });
  await expect(directory.getByRole('link', { name: new RegExp(`^${escapeRegex(demo.name)}\\b`) })).toBeVisible();

  await page.getByRole('searchbox', { name: 'Buscar estabelecimento' }).fill(tag);
  await expect(directory.getByRole('heading', { name: 'Resultados da busca', level: 2 })).toBeVisible();
  await expect(directory).toContainText(`para "${tag}"`);
  const linkB = directory.getByRole('link', { name: new RegExp(`^${escapeRegex(storeB.name)}\\b`) });
  const linkC = directory.getByRole('link', { name: new RegExp(`^${escapeRegex(storeC.name)}\\b`) });
  await expect(linkB).toBeVisible();
  await expect(linkC).toBeVisible();
  await expect(linkB).toHaveAttribute('href', `/loja/${storeB.slug}`);
  await expect(directory.getByRole('listitem'), 'só as lojas ativas da busca (a desativada não aparece)').toHaveCount(2);
  await expect(directory.getByRole('link', { name: new RegExp(escapeRegex(closedStore.name)) })).toHaveCount(0);
  await expect(linkB).toContainText('Aberto agora');

  await linkC.click();
  await expect(page).toHaveURL(storeUrl(undefined, storeC.slug));
  await expect(page.getByRole('heading', { level: 1, name: storeC.name })).toBeVisible();

  // A loja desativada responde "não encontrada" na vitrine
  await page.goto(storePath(undefined, closedStore.slug));
  await expect(page.getByRole('heading', { level: 1, name: closedStore.name })).toHaveCount(0);
});

test('cada loja mostra o próprio cardápio em /loja/<slug>', async ({ page }) => {
  await openStorefront(page, demo);
  await expectInMenu(page, demoProduct.name, true);
  await expectInMenu(page, productB.name, false);

  await openStorefront(page, storeB);
  await expectInMenu(page, productB.name, true);
  const card = menuSection(page).getByRole('heading', { name: productB.name, exact: true }).locator('xpath=ancestor::div[.//button][1]');
  await expect(card).toContainText('R$ 14,50');
  await expectInMenu(page, demoProduct.name, false);
});

test('carrinho separado por loja; o checkout na loja B cria o pedido na loja B, no quadro de B e nunca no da loja demo', async ({ page, browser }) => {
  const client: Member = await newCustomer(api, 'Vitrine');
  await useSession(page, client);

  // Carrinho da loja demo
  await openStorefront(page, demo);
  await addToCart(page, demoProduct.name);
  await expect(cartLink(page)).not.toHaveAccessibleName('Carrinho');
  expect(await savedCart(page, demo.id), 'carrinho da loja demo com o item').toHaveLength(1);

  // Na loja B o carrinho começa vazio e recebe só o produto de B
  await openStorefront(page, storeB);
  await expect(cartLink(page)).toHaveAccessibleName('Carrinho');
  await addToCart(page, productB.name);
  expect(await savedCart(page, storeB.id)).toHaveLength(1);
  expect(await savedCart(page, demo.id), 'o carrinho da loja demo continua com o item dela').toHaveLength(1);

  await page.goto(storePath('cart', storeB.slug));
  await expect(page.getByRole('heading', { name: 'Carrinho', level: 1, exact: true })).toBeVisible();
  await expect(cartLine(page, productB.name)).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: demoProduct.name, exact: true })).toHaveCount(0);
  await expect(page.getByText('Subtotal', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(summaryValue(page, 'Total')).toHaveText('R$ 14,50');

  // Retirada, pago na retirada
  await page.getByRole('button', { name: 'Pagar na Retirada' }).click();
  const creation = page.waitForResponse(
    (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === `/stores/${storeB.slug}/orders`,
  );
  await page.getByRole('button', { name: 'Finalizar Pedido' }).click();
  const response = await creation;
  const order = await response.json();
  expect(response.status(), JSON.stringify(order)).toBe(201);
  expect(response.request().postDataJSON()).toMatchObject({ type: 'TAKEOUT', paymentMethod: 'MONEY', items: [{ productId: productB.id, quantity: 1 }] });
  expect(order.number, 'primeiro pedido da loja B: número da loja, não o id global').toBe(1);

  await expect(page).toHaveURL(storeUrl('order-success', storeB.slug));
  await expect(page.getByText(`Pedido #${order.number} · ${storeB.name}`, { exact: true })).toBeVisible();
  expect(await savedCart(page, storeB.id), 'o carrinho de B foi esvaziado').toHaveLength(0);
  expect(await savedCart(page, demo.id), 'o carrinho da loja demo não mudou').toHaveLength(1);

  // O pedido é da loja B: a equipe de B o enxerga com o número da loja (a equipe só vê pedidos da própria loja)
  const asOwner = await api.get(`/orders/${order.id}`, { headers: bearer(storeB.owner.token) });
  expect(await expectStatus(asOwner, 200, 'pedido visto pela equipe de B')).toMatchObject({ id: order.id, number: order.number });

  // Quadro de pedidos da equipe de B: o card com o número da loja
  const ownerPage = await panelPage(browser, storeB.owner);
  try {
    await ownerPage.goto('/orders');
    const card = orderCard(ownerPage, order.id);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(orderCardHeading(card, order.number)).toBeVisible();
    await expect(card).toContainText(productB.name);
  } finally {
    await ownerPage.context().close();
  }

  // Quadro da loja demo: o pedido de B não aparece (e a API responde 404 para a equipe da demo)
  const { ctx: demoAdmin, session: demoAdminSession } = await contextAs('admin');
  try {
    expect((await demoAdmin.get(`/orders/${order.id}`)).status(), 'pedido de outra loja').toBe(404);
    const demoPage = await panelPage(browser, demoAdminSession);
    try {
      const board = demoPage.waitForResponse(
        (res) => res.request().method() === 'GET' && res.url().startsWith(E2E.apiURL) && new URL(res.url()).pathname === '/orders' && res.ok(),
      );
      await demoPage.goto('/orders');
      const loaded = (await (await board).json()) as Json;
      const list: Json[] = Array.isArray(loaded) ? loaded : (loaded.items ?? []);
      expect(list.map((item) => item.id), 'a lista da loja demo não traz o pedido de B').not.toContain(order.id);
      await expect(demoPage.getByText('Novos', { exact: true }).first()).toBeVisible();
      await expect(orderCard(demoPage, order.id)).toHaveCount(0);
    } finally {
      await demoPage.context().close();
    }
  } finally {
    await demoAdmin.dispose();
  }

  // De volta à loja demo, o carrinho dela ainda tem o item
  await page.goto(storePath('cart', demo.slug));
  await expect(cartLine(page, demoProduct.name)).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: productB.name, exact: true })).toHaveCount(0);
});

test('loja suspensa: a vitrine mostra "Pedidos indisponíveis", não deixa pedir e sai do diretório', async ({ page }) => {
  const suspended = await extraStore('Suspensa', { delivery: false });
  const product = await addProduct(api, suspended.owner, { name: `Lanche Suspenso ${tag}`, price: 12, category: 'bebidas' });
  const reason = 'Suspensa pelo suporte (E2E web).';
  await expectStatus(
    await api.post(`/platform/stores/${suspended.id}/suspend`, { headers: bearer(superadmin.token), data: { reason } }),
    200,
    'suspender a loja',
  );
  const profile = await (await api.get(`/stores/${suspended.slug}`)).json();
  expect(profile.ordering_available).toBe(false);

  const client = await newCustomer(api, 'Suspensa');
  await useSession(page, client);
  await openStorefront(page, suspended);
  await expect(page.getByRole('list', { name: 'Informações da loja' })).toContainText('Pedidos indisponíveis');
  await expect(page.getByRole('status', { name: 'Loja sem pedidos pelo site no momento' })).toBeVisible();
  await expect(page.getByText('Pedidos indisponíveis no momento', { exact: true })).toBeVisible();
  if (profile.unavailable_message) await expect(page.getByText(profile.unavailable_message).first()).toBeVisible();
  await searchFor(page, product.name);
  await expect(menuSection(page).getByRole('button', { name: `Adicionar ${product.name}`, exact: true })).toHaveCount(0);
  await expect(menuSection(page).getByRole('button', { name: `${product.name}: pedidos indisponíveis` })).toBeDisabled();

  // A API também recusa o pedido
  const refused = await api.post(`/stores/${suspended.slug}/orders`, {
    headers: bearer(client.token),
    data: { items: [{ productId: product.id, quantity: 1 }], type: 'TAKEOUT', paymentMethod: 'MONEY' },
  });
  expect(refused.status(), 'loja suspensa não aceita pedidos').toBeGreaterThanOrEqual(400);
  expect(refused.status()).toBeLessThan(500);

  // Fora do diretório
  await page.goto('/');
  await page.getByRole('searchbox', { name: 'Buscar estabelecimento' }).fill(suspended.slug);
  await expect(page.getByText('Nenhum estabelecimento encontrado')).toBeVisible();
});

test('endereço fora da área numa loja que recusa: aviso no carrinho, pagamento bloqueado e opção de retirar no balcão', async ({ page }) => {
  const refusing = await extraStore('Recusa');
  await expectStatus(
    await api.patch('/store/settings', {
      headers: bearer(refusing.owner.token),
      data: {
        delivery_enabled: true,
        delivery_zones: { zones: [{ neighborhoods: ['Centro'], fee: 4, time: '30-40 min' }], outside_zones: 'refuse' },
      },
    }),
    200,
    'zonas com recusa fora da área',
  );
  expect((await (await api.get(`/stores/${refusing.slug}`)).json()).delivers_outside_zones).toBe(false);
  const product = await addProduct(api, refusing.owner, { name: `Lanche Zona ${tag}`, price: 20, category: 'bebidas' });

  const client = await newCustomer(api, 'Fora da Área');
  const address = await expectStatus(
    await api.post('/addresses', {
      headers: bearer(client.token),
      data: { nickname: 'Praia', zipCode: '22041-001', street: 'Rua Barata Ribeiro', number: '200', neighborhood: 'Copacabana', city: 'Rio de Janeiro', state: 'RJ' },
    }),
    201,
    'endereço fora da área',
  );

  const posts: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/(orders|payment\/(pix|card))$/.test(new URL(req.url()).pathname)) posts.push(new URL(req.url()).pathname);
  });

  await useSession(page, client);
  await openStorefront(page, refusing);
  await addToCart(page, product.name);
  await page.goto(storePath('cart', refusing.slug));
  await expect(page.getByRole('heading', { name: 'Carrinho', level: 1, exact: true })).toBeVisible();

  const quote = page.waitForResponse(
    (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === `/stores/${refusing.slug}/orders/quote` && res.request().postDataJSON()?.type === 'DELIVERY',
  );
  await page.getByRole('button', { name: 'Delivery', exact: true }).click();
  const quoted = await quote;
  expect(quoted.status()).toBe(400);
  expect(await quoted.json()).toMatchObject({ code: 'DELIVERY_OUT_OF_AREA', message: 'Este endereço está fora da área de entrega da loja.' });

  await expect(page.getByText(`${refusing.name} entrega só nos bairros e CEPs atendidos: fora deles, o pedido é recusado antes do pagamento.`)).toBeVisible();
  await expect(page.getByRole('radio', { name: /Praia - Rua Barata Ribeiro, 200/ })).toBeChecked();
  await expect(page.getByText('Fora da área de entrega', { exact: true })).toBeVisible();
  const notice = page.getByRole('alert').filter({ hasText: 'Este endereço está fora da área de entrega da loja.' });
  await expect(notice).toContainText('Nada foi cobrado.');
  await expect(summaryValue(page, 'Taxa de entrega')).toHaveText('Fora da área');
  await page.getByRole('button', { name: 'Pagar na Entrega' }).click();
  await expect(page.getByRole('button', { name: 'Finalizar Pedido' }), 'pagamento bloqueado fora da área').toBeDisabled();
  expect(posts, 'nada foi enviado como pedido ou cobrança').toEqual([]);
  expect(address.id).toBeTruthy();

  // "Retirar no balcão" troca para retirada e libera o pedido
  await notice.getByRole('button', { name: 'Retirar no balcão' }).click();
  await expect(notice).toBeHidden();
  await expect(summaryValue(page, 'Total')).toHaveText('R$ 20,00', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Pagar na Retirada' }).click();
  await expect(page.getByRole('button', { name: 'Finalizar Pedido' })).toBeEnabled();
});
