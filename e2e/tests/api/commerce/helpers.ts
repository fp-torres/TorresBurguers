/**
 * Helpers da área api-commerce (catálogo, pedidos e pagamentos).
 * Usa os helpers compartilhados de e2e/support sem alterá-los.
 */
import { request, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { E2E } from '../../../support/env';
import { authedContext, body, login, signupClient, uid, uniqueEmail, type Session } from '../../../support/api';
import { DEFAULT_USERS, type DefaultUserKey } from '../../../support/users';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export type StaffRole = 'ADMIN' | 'EMPLOYEE' | 'KITCHEN' | 'COURIER';

export interface Actor {
  ctx: APIRequestContext;
  session: Session;
  id: number;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Id que cabe numa coluna integer mas não existe (os testes nunca chegam perto disso). */
export const UNKNOWN_ID = 2_147_483_000;

/** Inteiro válido em JSON/URL, mas acima do maior valor de uma coluna integer do PostgreSQL. */
export const OUT_OF_RANGE_ID = 99_999_999_999;

// ---------------------------------------------------------------------------
// Contextos HTTP (abertos por arquivo de teste, descartados no afterAll)
// ---------------------------------------------------------------------------

export class Actors {
  private readonly opened: APIRequestContext[] = [];

  async anon(): Promise<APIRequestContext> {
    const ctx = await request.newContext({ baseURL: E2E.apiURL });
    this.opened.push(ctx);
    return ctx;
  }

  async withSession(session: Session): Promise<Actor> {
    const ctx = await authedContext(session.token);
    this.opened.push(ctx);
    return { ctx, session, id: session.user.id };
  }

  async defaultUser(key: DefaultUserKey): Promise<Actor> {
    const anon = await this.anon();
    const user = DEFAULT_USERS[key];
    return this.withSession(await login(anon, user.email, user.password));
  }

  /** Cliente novo (cadastro público), isolado dos demais testes. */
  async newClient(label = 'Cliente Commerce'): Promise<Actor> {
    const anon = await this.anon();
    const session = await signupClient(anon, { name: `${label} ${uid('c')}`.slice(0, 50) });
    return this.withSession(session);
  }

  /** Conta da equipe criada pelo ADMIN (POST /users com role). */
  async newStaff(admin: APIRequestContext, role: StaffRole): Promise<Actor> {
    const email = uniqueEmail(role.toLowerCase());
    const password = 'SenhaForte@123';
    const res = await admin.post('/users', {
      data: { name: `${role} Commerce ${uid('s')}`.slice(0, 50), email, password, role },
    });
    expect(res.status(), `criar ${role}: ${await res.text()}`).toBe(201);
    const anon = await this.anon();
    return this.withSession(await login(anon, email, password));
  }

  async dispose(): Promise<void> {
    await Promise.all(this.opened.splice(0).map((ctx) => ctx.dispose()));
  }
}

// ---------------------------------------------------------------------------
// Asserções de resposta
// ---------------------------------------------------------------------------

/** message do erro do Nest como texto (string ou lista unida). */
export async function errorText(res: APIResponse): Promise<string> {
  const data = await body(res);
  if (data && typeof data === 'object') {
    const message = (data as { message?: unknown }).message;
    return Array.isArray(message) ? message.join(' | ') : String(message ?? '');
  }
  return String(data ?? '');
}

/** Confere o status HTTP (com o corpo na mensagem de falha) e, opcionalmente, a mensagem. */
export async function expectStatus(res: APIResponse, status: number, message?: RegExp | string): Promise<void> {
  const text = await res.text();
  expect(res.status(), `${res.url()} → ${res.status()} ${text.slice(0, 600)}`).toBe(status);
  if (message !== undefined) {
    const msg = await errorText(res);
    if (typeof message === 'string') expect(msg).toContain(message);
    else expect(msg).toMatch(message);
  }
}

/** Erro no formato do Nest: {statusCode, message (string | string[]), error}. */
export async function expectNestError(res: APIResponse, status: number, message?: RegExp | string): Promise<void> {
  await expectStatus(res, status, message);
  const data = await body(res);
  expect(data, 'corpo de erro do Nest').toMatchObject({ statusCode: status });
  expect(typeof data.error, 'campo error').toBe('string');
  expect(typeof data.message === 'string' || Array.isArray(data.message), 'campo message').toBeTruthy();
}

/** Nenhum campo de senha (password / password_hash) em lugar nenhum da resposta. */
export function expectNoPasswordFields(data: unknown): void {
  expect(JSON.stringify(data)).not.toMatch(/password/i);
}

export const cents = (value: unknown): number => Math.round(Number(value) * 100);

/** Compara valores monetários em centavos (aceita "30.00" ou 30). */
export function expectMoney(actual: unknown, expected: number, label = 'valor'): void {
  expect(cents(actual), `${label}: ${String(actual)}`).toBe(Math.round(expected * 100));
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

export async function createAddon(admin: APIRequestContext, data: Record<string, unknown> = {}): Promise<Json> {
  const res = await admin.post('/addons', { data: { name: `Adicional ${uid('ad')}`, price: 2, ...data } });
  expect(res.status(), `POST /addons: ${await res.text()}`).toBe(201);
  return res.json();
}

export async function deleteAddon(admin: APIRequestContext, id: number): Promise<void> {
  const res = await admin.delete(`/addons/${id}`);
  expect(res.status(), `DELETE /addons/${id}: ${await res.text()}`).toBe(200);
}

export async function createProduct(admin: APIRequestContext, data: Record<string, unknown> = {}): Promise<Json> {
  const res = await admin.post('/products', {
    data: { name: `Produto ${uid('p')}`, price: 20, category: 'hamburgueres', ...data },
  });
  expect(res.status(), `POST /products: ${await res.text()}`).toBe(201);
  return res.json();
}

export async function updateProduct(admin: APIRequestContext, id: number, data: Record<string, unknown>): Promise<Json> {
  const res = await admin.patch(`/products/${id}`, { data });
  expect(res.status(), `PATCH /products/${id}: ${await res.text()}`).toBe(200);
  return res.json();
}

export async function softDeleteProduct(admin: APIRequestContext, id: number): Promise<void> {
  const res = await admin.delete(`/products/${id}`);
  expect(res.status(), `DELETE /products/${id}: ${await res.text()}`).toBe(200);
}

/** PNG 1x1 válido. */
export const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** JPEG 2x2 válido (gerado com sharp). */
export const JPEG_2PX = Buffer.from(
  '/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJQA59//2Q==',
  'base64',
);

/** WebP 2x2 válido (gerado com sharp). */
export const WEBP_2PX = Buffer.from(
  'UklGRjYAAABXRUJQVlA4ICoAAADwAQCdASoCAAIAAsBMJaACdLoB+AAETAAA/t+AP996A3k//5Ka/xtx2AA=',
  'base64',
);

/** GIF 1x1 válido (formato não aceito pela API). */
export const GIF_1PX = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');

/** SVG com script (formato não aceito pela API). */
export const SVG_SCRIPT = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>',
);

export function fileBlob(content: Buffer, type: string): Blob {
  return new Blob([new Uint8Array(content)], { type });
}

/** FormData a partir de pares [campo, valor] (campos repetidos permitidos). */
export function form(fields: [string, string | Blob][], file?: { blob: Blob; name: string }): FormData {
  const fd = new FormData();
  for (const [name, value] of fields) {
    if (typeof value === 'string') fd.append(name, value);
    else fd.append(name, value, 'arquivo');
  }
  if (file) fd.append('file', file.blob, file.name);
  return fd;
}

export async function getProducts(ctx: APIRequestContext): Promise<Json[]> {
  const res = await ctx.get('/products');
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

export async function getAddons(ctx: APIRequestContext): Promise<Json[]> {
  const res = await ctx.get('/addons');
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

export const ids = (list: { id: number }[] | null | undefined): number[] =>
  (list ?? []).map((item) => item.id).sort((a, b) => a - b);

// ---------------------------------------------------------------------------
// Endereços
// ---------------------------------------------------------------------------

export async function createAddress(
  client: APIRequestContext,
  neighborhood = 'Centro',
  extra: Record<string, unknown> = {},
): Promise<Json> {
  const res = await client.post('/addresses', {
    data: {
      zipCode: '20040-002',
      street: 'Rua do Teste Commerce',
      number: '100',
      neighborhood,
      city: 'Rio de Janeiro',
      state: 'RJ',
      ...extra,
    },
  });
  expect(res.status(), `POST /addresses: ${await res.text()}`).toBe(201);
  return res.json();
}

// ---------------------------------------------------------------------------
// Pedidos e pagamentos (tolerantes ao teste de "loja fechada" de outro testador)
// ---------------------------------------------------------------------------

export interface ItemInput {
  productId: number;
  quantity: number;
  addonIds?: number[];
  observation?: string;
  meatPoint?: string;
  removedIngredients?: string[];
}

export interface QuoteInput {
  items: ItemInput[];
  type: 'DELIVERY' | 'TAKEOUT';
  addressId?: number;
}

export interface OrderInput extends QuoteInput {
  paymentMethod: string;
  paymentId?: number;
  changeFor?: string;
}

async function storeWasClosed(res: APIResponse): Promise<boolean> {
  if (res.status() === 400) return /fechad/i.test(await errorText(res));
  if (res.status() === 200) {
    const data = await body(res);
    return !!data && typeof data === 'object' && data.store_open === false;
  }
  return false;
}

async function waitStoreOpen(timeoutMs = 10_000): Promise<void> {
  const ctx = await request.newContext({ baseURL: E2E.apiURL });
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await (await ctx.get('/store/status')).json();
      if (status.is_open) return;
      await sleep(250);
    }
  } finally {
    await ctx.dispose();
  }
}

/**
 * POST de orçamento/pedido/pagamento. Outro testador fecha a loja por instantes: se a resposta for
 * "loja fechada", espera 1 s (e a loja reabrir) e tenta UMA vez mais. Nunca mexe no status da loja.
 */
export async function postCommerce(ctx: APIRequestContext, path: string, data: unknown): Promise<APIResponse> {
  const res = await ctx.post(path, { data });
  if (!(await storeWasClosed(res))) return res;
  await sleep(1000);
  await waitStoreOpen();
  return ctx.post(path, { data });
}

export async function quote(client: APIRequestContext, input: QuoteInput): Promise<Json> {
  const res = await postCommerce(client, '/orders/quote', input);
  await expectStatus(res, 200);
  return res.json();
}

export function tryOrder(client: APIRequestContext, input: Record<string, unknown> | OrderInput): Promise<APIResponse> {
  return postCommerce(client, '/orders', input);
}

export async function placeOrder(client: APIRequestContext, input: OrderInput): Promise<Json> {
  const res = await tryOrder(client, input);
  await expectStatus(res, 201);
  return res.json();
}

export async function getOrder(ctx: APIRequestContext, id: number): Promise<Json> {
  const res = await ctx.get(`/orders/${id}`);
  await expectStatus(res, 200);
  return res.json();
}

export async function myOrders(ctx: APIRequestContext): Promise<Json[]> {
  const res = await ctx.get('/orders/my-orders');
  await expectStatus(res, 200);
  return res.json();
}

export function patchStatus(ctx: APIRequestContext, id: number, status: string): Promise<APIResponse> {
  return ctx.patch(`/orders/${id}`, { data: { status } });
}

/** Avança o pedido pelos status informados (cada passo precisa responder 200). */
export async function advance(ctx: APIRequestContext, id: number, ...statuses: string[]): Promise<Json> {
  let last: Json = null;
  for (const status of statuses) {
    const res = await patchStatus(ctx, id, status);
    await expectStatus(res, 200);
    last = await res.json();
  }
  return last;
}

export function cardBody(order: QuoteInput | Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    order,
    token: `tok-${uid('card')}`,
    paymentMethodId: 'master',
    installments: 1,
    docNumber: '12345678909',
    docType: 'CPF',
    ...extra,
  };
}

export async function payCard(client: APIRequestContext, order: QuoteInput): Promise<Json> {
  const res = await postCommerce(client, '/payment/card', cardBody(order));
  await expectStatus(res, 201);
  return res.json();
}

export async function payPix(client: APIRequestContext, order: QuoteInput): Promise<Json> {
  const res = await postCommerce(client, '/payment/pix', { order });
  await expectStatus(res, 201);
  return res.json();
}

export async function paymentStatus(ctx: APIRequestContext, id: number): Promise<Json> {
  const res = await ctx.get(`/payment/status/${id}`);
  await expectStatus(res, 200);
  return res.json();
}

/** Espera o PIX do sandbox ser aprovado (PIX_SANDBOX_APPROVAL_SECONDS, padrão 5 s). */
export async function waitApproved(ctx: APIRequestContext, id: number, timeoutMs = 20_000): Promise<void> {
  await expect
    .poll(async () => (await paymentStatus(ctx, id)).status, {
      timeout: timeoutMs,
      intervals: [500, 1000],
      message: `PIX ${id} aprovado no sandbox`,
    })
    .toBe('approved');
}
