import { expect, request, type APIRequestContext, type Locator, type Page, type Route } from '@playwright/test';
import { E2E, STORAGE_KEYS, cartKey } from '../../../support/env';
import { authedContext, contextAs, demoStore, signupClient, type Session } from '../../../support/api';
import { isStoreApiResponse, legacyApiPath, storeApi } from '../../../support/routes';
import { storePath, storeUrl, useSession } from '../../../support/web';

/**
 * Helpers da vitrine (área web-client): catálogo semeado pela API, clientes isolados
 * e atalhos de interface (busca, modal do produto, carrinho, resumo, simulação do status da loja).
 * A vitrine é a da loja demo (/loja/<slug>), que chama as rotas da API por loja (/stores/<slug>/...).
 */

export const API_URL = E2E.apiURL;
export { STORAGE_KEYS, cartKey, demoStore, isStoreApiResponse, storeApi, storePath, storeUrl, useSession };

/** PNG 1x1 válido: imagem dos produtos semeados (o backend converte para .webp). */
export const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// ---------------------------------------------------------------------------
// Dinheiro
// ---------------------------------------------------------------------------

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** 25.9 → "R$ 25,90" com espaço comum (o Playwright normaliza o espaço não separável da página). */
export function brl(value: number): string {
  return BRL.format(value).replace(/\s/g, ' ');
}

/** Soma em centavos para não acumular erro de ponto flutuante. */
export function money(...values: number[]): number {
  return values.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100;
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Trecho de regex de um valor em reais, tolerante ao espaço não separável: "R\$\s*16,90". */
export function brlPattern(value: number): string {
  return escapeRegex(brl(value)).replace(' ', '\\s*');
}

// ---------------------------------------------------------------------------
// Catálogo semeado (uma vez por worker; cada execução usa uma etiqueta única)
// ---------------------------------------------------------------------------

export interface SeedAddon {
  id: number;
  name: string;
  price: number;
}

export interface SeedProduct {
  id: number;
  name: string;
  price: number;
  promotion_price: number | null;
  category: string;
  image: string | null;
  description: string;
}

export interface Catalog {
  /** Texto único presente no nome de todos os produtos visíveis desta execução. */
  tag: string;
  /** Palavra única presente só na descrição do suco. */
  descriptionWord: string;
  bacon: SeedAddon;
  cheddar: SeedAddon;
  /** Adicional pausado (available=false) permitido no hambúrguer: não deve aparecer no modal. */
  pausedAddon: SeedAddon;
  burger: SeedProduct;
  drink: SeedProduct;
  promo: SeedProduct;
  combo: SeedProduct;
  /** Produto com available=false: fora da vitrine. */
  unavailable: SeedProduct;
  /** Produto na lixeira (soft delete): fora da vitrine. */
  removed: SeedProduct;
  burgerIngredients: string[];
}

let catalogPromise: Promise<Catalog> | null = null;

/** Cria (uma vez por worker) adicionais e produtos com imagem pela API, como ADMIN. */
export function seedCatalog(): Promise<Catalog> {
  catalogPromise ??= createCatalog();
  return catalogPromise;
}

async function createCatalog(): Promise<Catalog> {
  const { ctx: admin } = await contextAs('admin');
  try {
    const tag = `wc${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 5)}`;
    const descriptionWord = `${tag}desc`;

    const bacon = await createAddon(admin, { name: `Bacon Extra ${tag}`, price: 4.5 });
    const cheddar = await createAddon(admin, { name: `Cheddar Cremoso ${tag}`, price: 3 });
    const pausedAddon = await createAddon(admin, { name: `Ovo Pausado ${tag}`, price: 2, available: false });

    const burgerIngredients = ['Alface', 'Tomate', 'Cebola'];
    const burger = await createProduct(admin, {
      name: `Hambúrguer Brasa ${tag}`,
      description: 'Pão brioche, blend 180g e molho da casa.',
      price: 30,
      category: 'hamburgueres',
      ingredients: burgerIngredients,
      addonIds: [bacon.id, cheddar.id, pausedAddon.id],
    });
    const drink = await createProduct(admin, {
      name: `Suco de Laranja ${tag}`,
      description: `Natural e gelado (${descriptionWord}).`,
      price: 9.9,
      category: 'bebidas',
    });
    const promo = await createProduct(admin, {
      name: `Batata Rústica ${tag}`,
      description: 'Porção crocante com alecrim.',
      price: 20,
      promotionPrice: 15,
      category: 'acompanhamentos',
    });
    const combo = await createProduct(admin, {
      name: `Combo Dupla ${tag}`,
      description: 'Dois burgers e batata.',
      price: 45,
      category: 'combos',
    });
    const unavailable = await createProduct(admin, {
      name: `Milkshake Pausado ${tag}`,
      description: 'Fora de estoque.',
      price: 12,
      category: 'sobremesas',
      available: false,
    });
    const removed = await createProduct(admin, {
      name: `Wrap Removido ${tag}`,
      description: 'Saiu do cardápio.',
      price: 18,
      category: 'entradas',
    });
    const del = await admin.delete(`/products/${removed.id}`);
    expect(del.ok(), `DELETE /products/${removed.id}: ${del.status()} ${await del.text()}`).toBeTruthy();

    return { tag, descriptionWord, bacon, cheddar, pausedAddon, burger, drink, promo, combo, unavailable, removed, burgerIngredients };
  } finally {
    await admin.dispose();
  }
}

async function createAddon(
  admin: APIRequestContext,
  data: { name: string; price: number; available?: boolean },
): Promise<SeedAddon> {
  const res = await admin.post('/addons', {
    data: { name: data.name, price: data.price, category: 'hamburgueres', available: data.available ?? true },
  });
  expect(res.status(), `POST /addons: ${await res.text()}`).toBe(201);
  const json = await res.json();
  return { id: json.id, name: json.name, price: Number(json.price) };
}

async function createProduct(
  admin: APIRequestContext,
  data: {
    name: string;
    description: string;
    price: number;
    promotionPrice?: number;
    category: string;
    available?: boolean;
    ingredients?: string[];
    addonIds?: number[];
  },
): Promise<SeedProduct> {
  const multipart: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
    name: data.name,
    description: data.description,
    price: data.price.toFixed(2),
    category: data.category,
    available: String(data.available ?? true),
    file: { name: 'produto.png', mimeType: 'image/png', buffer: PNG_1PX },
  };
  if (data.promotionPrice !== undefined) multipart.promotion_price = data.promotionPrice.toFixed(2);
  if (data.ingredients) multipart.ingredients = JSON.stringify(data.ingredients);
  if (data.addonIds) multipart.allowed_addons_ids = JSON.stringify(data.addonIds);

  const res = await admin.post('/products', { multipart });
  expect(res.status(), `POST /products ${data.name}: ${await res.text()}`).toBe(201);
  const json = await res.json();
  return {
    id: json.id,
    name: json.name,
    price: Number(json.price),
    promotion_price: json.promotion_price === null || json.promotion_price === undefined ? null : Number(json.promotion_price),
    category: json.category,
    image: json.image ?? null,
    description: json.description ?? '',
  };
}

// ---------------------------------------------------------------------------
// Clientes, endereços e pedidos (sempre dados próprios do teste)
// ---------------------------------------------------------------------------

export interface TestClient {
  session: Session;
  email: string;
  password: string;
  name: string;
  /** Contexto HTTP autenticado como o cliente (lembre de dispose()). */
  api: APIRequestContext;
}

export async function createClient(
  overrides: Partial<{ name: string; email: string; password: string; phone: string }> = {},
): Promise<TestClient> {
  const anon = await request.newContext({ baseURL: API_URL });
  try {
    const created = await signupClient(anon, { name: 'Cliente Vitrine', ...overrides });
    const api = await authedContext(created.token);
    return {
      session: { token: created.token, user: created.user },
      email: created.user.email,
      password: created.password,
      name: created.user.name,
      api,
    };
  } finally {
    await anon.dispose();
  }
}

export interface AddressInput {
  nickname: string;
  zipCode: string;
  street: string;
  number: string;
  neighborhood: string;
  city: string;
  state: string;
  complement?: string;
}

export async function createAddress(api: APIRequestContext, data: Partial<AddressInput> = {}): Promise<{ id: number } & AddressInput> {
  const payload: AddressInput = {
    nickname: 'Casa',
    zipCode: '20040003',
    street: 'Rua da Assembleia',
    number: '10',
    neighborhood: 'Centro',
    city: 'Rio de Janeiro',
    state: 'RJ',
    ...data,
  };
  const res = await api.post('/addresses', { data: payload });
  expect(res.status(), `POST /addresses: ${await res.text()}`).toBe(201);
  return res.json();
}

export async function listMyOrders(api: APIRequestContext): Promise<any[]> {
  const res = await api.get('/orders/my-orders');
  expect(res.ok(), `GET /orders/my-orders: ${res.status()} ${await res.text()}`).toBeTruthy();
  return res.json();
}

export async function getOrder(api: APIRequestContext, id: number): Promise<any> {
  const res = await api.get(`/orders/${id}`);
  expect(res.ok(), `GET /orders/${id}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return res.json();
}

/**
 * Outro testador (api-identity) pode fechar a loja por alguns segundos num teste serial.
 * Antes de um checkout real, espera a loja estar aberta (nunca altera o status).
 */
export async function waitForStoreOpen(timeout = 45_000): Promise<void> {
  const ctx = await request.newContext({ baseURL: API_URL });
  try {
    await expect
      .poll(async () => (await (await ctx.get(`/stores/${E2E.demoStoreSlug}/status`)).json()).is_open, {
        timeout,
        message: 'a loja real precisa estar aberta para o checkout',
      })
      .toBe(true);
  } finally {
    await ctx.dispose();
  }
}

// ---------------------------------------------------------------------------
// Vitrine
// ---------------------------------------------------------------------------

export function searchBox(page: Page): Locator {
  return page.getByRole('searchbox', { name: 'Buscar no cardápio' });
}

export function menuSection(page: Page): Locator {
  return page.locator('#menu-section');
}

export function cartLink(page: Page): Locator {
  return page.getByRole('link', { name: /^Carrinho/ });
}

/** Abre a vitrine da loja demo (/loja/<slug>) e espera o cardápio terminar de carregar. */
export async function openHome(page: Page): Promise<void> {
  await page.goto(storePath());
  await expect(searchBox(page)).toBeVisible();
  await expect(menuSection(page).getByRole('button', { name: 'Tudo', exact: true })).toBeVisible();
}

/** Busca no cardápio inteiro e espera a contagem de resultados. */
export async function searchFor(page: Page, term: string): Promise<void> {
  await searchBox(page).fill(term);
  await expect(page.getByText(new RegExp(`\\d+ resultados? para "${escapeRegex(term.trim())}"`))).toBeVisible();
}

/** Card do produto na lista principal: imagem, selo de oferta, nome, preço e botão (todo produto semeado tem imagem). */
export function productCard(page: Page, name: string): Locator {
  return menuSection(page).getByRole('heading', { name, exact: true }).locator('xpath=ancestor::div[.//img][1]');
}

/** Busca o produto pelo nome e abre o modal pelo botão "Adicionar <nome>". */
export async function openProduct(page: Page, name: string): Promise<Locator> {
  await searchFor(page, name);
  await menuSection(page).getByRole('button', { name: `Adicionar ${name}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog).toBeVisible();
  return dialog;
}

export function modalAddButton(dialog: Locator): Locator {
  return dialog.getByRole('button', { name: /^Adicionar\s+R\$/ });
}

/** Quantidade exibida entre "Diminuir quantidade" e "Aumentar quantidade" (modal ou linha do carrinho). */
export function quantityValue(scope: Locator): Locator {
  return scope.getByRole('button', { name: 'Diminuir quantidade' }).locator('xpath=following-sibling::span[1]');
}

export interface AddOptions {
  quantity?: number;
  meatPoint?: string;
  addons?: string[];
  removeIngredients?: string[];
  observation?: string;
}

/** Fluxo real do cliente: busca, abre o modal, personaliza e adiciona ao carrinho. */
export async function addToCart(page: Page, name: string, options: AddOptions = {}): Promise<void> {
  const dialog = await openProduct(page, name);
  if (options.meatPoint) await dialog.getByRole('button', { name: options.meatPoint, exact: true }).click();
  for (const ingredient of options.removeIngredients ?? []) {
    await dialog.getByRole('checkbox', { name: ingredient, exact: true }).check();
  }
  for (const addon of options.addons ?? []) {
    await dialog.getByRole('button', { name: `Adicionar ${addon}`, exact: true }).click();
  }
  if (options.observation) await dialog.getByRole('textbox', { name: 'Observação' }).fill(options.observation);
  for (let i = 1; i < (options.quantity ?? 1); i++) {
    await dialog.getByRole('button', { name: 'Aumentar quantidade' }).click();
  }
  await modalAddButton(dialog).click();
  await expect(dialog).toBeHidden();
}

// ---------------------------------------------------------------------------
// Carrinho e checkout
// ---------------------------------------------------------------------------

/** Abre o carrinho da loja demo (/loja/<slug>/cart). */
export async function openCart(page: Page): Promise<void> {
  await page.goto(storePath('cart'));
  await expect(page.getByRole('heading', { name: 'Carrinho', level: 1, exact: true })).toBeVisible();
}

/**
 * Itens do carrinho da loja demo salvos no navegador ("comestra.cart.<storeId>" = { v, storeId, storeSlug, items }).
 * Sem carrinho salvo (vazio), devolve [].
 */
export async function storedCartItems(page: Page): Promise<any[]> {
  const store = await demoStore();
  const raw = (await readStorage(page))[cartKey(store.id)];
  if (!raw) return [];
  const saved = JSON.parse(raw);
  expect(saved, 'carrinho guardado por loja').toMatchObject({ v: 2, storeId: store.id, storeSlug: store.slug });
  return saved.items;
}

/** Linha do carrinho: nome, personalizações, total da linha e botões de quantidade. */
export function cartLine(page: Page, name: string): Locator {
  return page
    .getByRole('heading', { level: 3, name, exact: true })
    .locator('xpath=ancestor::div[.//button[@aria-label="Aumentar quantidade"]][1]');
}

/** Valor ao lado de um rótulo do resumo ("Subtotal", "Taxa de entrega", "Total"). */
export function summaryValue(page: Page, label: string): Locator {
  return page.getByText(label, { exact: true }).locator('xpath=following-sibling::span[1]');
}

/** O resumo passa de "Subtotal (estimado)" para "Subtotal" quando a cotação do servidor chega. */
export async function expectServerQuote(page: Page): Promise<void> {
  await expect(page.getByText('Subtotal', { exact: true })).toBeVisible({ timeout: 15_000 });
}

/** Espera a próxima resposta do orçamento (POST /stores/<slug>/orders/quote, cujo corpo satisfaça `match`). */
export function nextQuote(page: Page, match: (body: any) => boolean = () => true): Promise<any> {
  return page
    .waitForResponse((r) => isStoreApiResponse(r, 'POST', '/orders/quote') && match(r.request().postDataJSON()), { timeout: 15_000 })
    .then((r) => r.json());
}

/** Espera o POST /stores/<slug>/orders feito pela página e devolve status, corpo enviado e resposta. */
export function nextOrderCreation(page: Page, timeout = 30_000): Promise<{ status: number; sent: any; order: any }> {
  return page
    .waitForResponse((r) => isStoreApiResponse(r, 'POST', '/orders'), { timeout })
    .then(async (r) => ({ status: r.status(), sent: r.request().postDataJSON(), order: await r.json() }));
}

/** Cartão de teste do Mercado Pago (aprovado: titular APRO). */
export const TEST_CARD = { number: '5031433215406351', name: 'APRO', expiry: '1130', cvc: '123', cpf: '12345678909' };

/** Preenche o formulário de cartão (rótulos sem htmlFor: localizados pelo placeholder). */
export async function fillCard(page: Page, card: Partial<typeof TEST_CARD>): Promise<void> {
  const fields: [keyof typeof TEST_CARD, Locator][] = [
    ['number', page.getByPlaceholder('0000 0000 0000 0000')],
    ['name', page.getByPlaceholder('COMO ESTÁ NO CARTÃO')],
    ['expiry', page.getByPlaceholder('MM/AA')],
    ['cvc', page.getByPlaceholder('123', { exact: true })],
    ['cpf', page.getByPlaceholder('000.000.000-00')],
  ];
  for (const [key, input] of fields) {
    const value = card[key];
    if (value !== undefined) await input.fill(value);
  }
}

/**
 * Registra as chamadas feitas pela página (para provar que nada foi cobrado/criado). O caminho é registrado
 * sem o prefixo da loja (/stores/<slug>/orders → /orders), para valer tanto para a rota da loja quanto a antiga;
 * `fullPath` guarda o caminho chamado de fato.
 */
export function trackRequests(
  page: Page,
  test: (method: string, path: string) => boolean,
): { method: string; path: string; fullPath: string }[] {
  const seen: { method: string; path: string; fullPath: string }[] = [];
  page.on('request', (req) => {
    if (!req.url().startsWith(API_URL)) return;
    const fullPath = new URL(req.url()).pathname;
    const path = legacyApiPath(fullPath);
    if (test(req.method(), path)) seen.push({ method: req.method(), path, fullPath });
  });
  return seen;
}

export async function readStorage(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const data: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      data[key] = localStorage.getItem(key) ?? '';
    }
    return data;
  });
}

// ---------------------------------------------------------------------------
// Simulação do status da loja (NUNCA fecha a loja real: só altera a resposta vista pela página)
// ---------------------------------------------------------------------------

export interface StoreOverride {
  is_open: boolean;
  closing_message?: string | null;
  opening_message?: string | null;
}

/**
 * Intercepta o que a vitrine lê sobre a loja — o perfil (GET /stores/<slug>, com is_open e as mensagens),
 * o status (GET /stores/<slug>/status ou a rota antiga /store/status) — e o orçamento (store_open),
 * buscando a resposta real e sobrescrevendo só o status. `set(null)` volta ao valor real.
 */
export async function overrideStoreStatus(page: Page, initial: StoreOverride | null) {
  let current: StoreOverride | null = initial;
  const profilePath = `/stores/${E2E.demoStoreSlug}`;

  const overrideStatus = async (route: Route) => {
    if (route.request().method() !== 'GET' || !current) return route.continue();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const json = await response.json();
    await route.fulfill({ response, json: { ...json, ...current } });
  };
  await page.route((url) => url.origin === new URL(API_URL).origin && url.pathname === profilePath, overrideStatus);
  await page.route(storeApi('/store/status'), overrideStatus);

  await page.route(storeApi('/orders/quote'), async (route: Route) => {
    if (route.request().method() !== 'POST' || !current) return route.continue();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const json = await response.json();
    await route.fulfill({ response, json: { ...json, store_open: current.is_open } });
  });

  return {
    set(next: StoreOverride | null) {
      current = next;
    },
  };
}

/** A vitrine consulta o status a cada 30 s e quando a aba volta a ficar visível: força a consulta. */
export async function refreshStoreStatus(page: Page): Promise<void> {
  const response = page.waitForResponse((r) => isStoreApiResponse(r, 'GET', '/store/status'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await response;
}

/** Resposta JSON com CORS liberado (a página roda em outra origem que a API). */
export async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Formulário de endereço (rótulos sem htmlFor: localizados pelo placeholder ou pelo rótulo vizinho)
// ---------------------------------------------------------------------------

export function addressFields(dialog: Locator) {
  return {
    nickname: dialog.getByPlaceholder('Ex: Minha Casa'),
    zip: dialog.getByPlaceholder('00000-000'),
    street: dialog.getByPlaceholder('Preenchimento automático'),
    number: dialog.getByPlaceholder('123', { exact: true }),
    neighborhood: dialog.locator('label:text-is("Bairro") + input'),
    complement: dialog.getByPlaceholder('Apto, Bloco...'),
    city: dialog.locator('label:text-is("Cidade") + input'),
    state: dialog.getByPlaceholder('RJ', { exact: true }),
    save: dialog.getByRole('button', { name: 'Salvar Endereço' }),
  };
}

// ---------------------------------------------------------------------------
// Login pela interface
// ---------------------------------------------------------------------------

export async function loginViaUI(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/signin');
  await page.getByPlaceholder('seu@email.com').fill(email);
  await page.getByPlaceholder('******').fill(password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
}
