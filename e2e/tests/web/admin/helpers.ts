import fs from 'node:fs';
import path from 'node:path';
import {
  expect,
  request,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { E2E, STORAGE_KEYS } from '../../../support/env';
import { authedContext, contextAs, signupClient, uid, uniqueEmail, type Session } from '../../../support/api';
import { DEFAULT_USERS, type DefaultUserKey } from '../../../support/users';

/**
 * Apoio dos testes do painel (web-admin): dados criados pela API e seletores da interface.
 * Tudo que é criado aqui leva um sufixo único (uid) para não colidir com os outros testadores.
 */

export const API_URL = E2E.apiURL;
export { DEFAULT_USERS, STORAGE_KEYS, uid, uniqueEmail };

export type Role = 'ADMIN' | 'EMPLOYEE' | 'KITCHEN' | 'COURIER' | 'CLIENT';
/** Perfis da equipe de uma loja (o ADMIN só cadastra estes; clientes se cadastram sozinhos). */
export type StaffRole = Exclude<Role, 'CLIENT'>;
export type OrderStatus = 'PENDING' | 'PREPARING' | 'READY_FOR_PICKUP' | 'DELIVERING' | 'DONE' | 'CANCELED';
export type PaymentMethod = 'PIX' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'MONEY';

export interface ApiAddon {
  id: number;
  name: string;
  price: string | number;
  category: string;
}

export interface ApiProduct {
  id: number;
  name: string;
  description: string;
  price: string | number;
  promotion_price: string | number | null;
  image: string | null;
  category: string;
  available: boolean;
  ingredients: string[] | null;
  allowed_addons: ApiAddon[];
}

export interface ApiUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  phone?: string | null;
  [k: string]: unknown;
}

export interface ApiOrder {
  id: number;
  /** Número do pedido NA LOJA (o "#N" das telas). */
  number: number;
  status: OrderStatus;
  type: 'DELIVERY' | 'TAKEOUT';
  payment_method: string;
  payment_status: 'PENDING' | 'PAID' | 'FAILED';
  payment_id: number | null;
  total_price: number;
  change_for: string | null;
  driver: { id: number; name: string } | null;
  user: { id: number; name: string } | null;
}

export interface OrderItemInput {
  productId: number;
  quantity: number;
  addonIds?: number[];
  observation?: string;
  meatPoint?: string;
  removedIngredients?: string[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Lê o JSON da resposta exigindo sucesso (a mensagem de falha traz status e corpo). */
export async function okJson<T>(res: APIResponse, what: string): Promise<T> {
  const text = await res.text();
  expect(res.ok(), `${what}: ${res.status()} ${text}`).toBeTruthy();
  return JSON.parse(text) as T;
}

/**
 * Outro testador (api-identity) fecha a loja por alguns segundos num teste serial.
 * Pedidos e pagamentos criados aqui esperam a loja reabrir em vez de falhar por isso.
 */
async function sendWhileStoreOpens<T>(send: () => Promise<APIResponse>, what: string): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const res = await send();
    const text = await res.text();
    if (res.ok()) return JSON.parse(text) as T;
    if (res.status() === 400 && /loja está fechada/i.test(text) && Date.now() < deadline) {
      await sleep(1_000);
      continue;
    }
    throw new Error(`${what}: ${res.status()} ${text}`);
  }
}

/** Chamadas de apoio feitas por um usuário padrão da equipe (ADMIN por padrão). */
export class StaffApi {
  private constructor(
    readonly ctx: APIRequestContext,
    readonly session: Session,
  ) {}

  static async as(key: DefaultUserKey = 'admin'): Promise<StaffApi> {
    const { ctx, session } = await contextAs(key);
    return new StaffApi(ctx, session);
  }

  dispose(): Promise<void> {
    return this.ctx.dispose();
  }

  // --- Cardápio (ADMIN) ---

  async createAddon(name: string, price = 4, category = 'geral'): Promise<ApiAddon> {
    return okJson<ApiAddon>(await this.ctx.post('/addons', { data: { name, price, category } }), 'POST /addons');
  }

  async createProduct(input: {
    name: string;
    price: number;
    category?: string;
    description?: string;
    promotion_price?: number | null;
    ingredients?: string[];
    allowed_addons_ids?: number[];
    available?: boolean;
  }): Promise<ApiProduct> {
    const data = { category: 'hamburgueres', description: 'Produto criado pelo teste do painel', available: true, ...input };
    return okJson<ApiProduct>(await this.ctx.post('/products', { data }), 'POST /products');
  }

  async getProduct(id: number): Promise<ApiProduct> {
    return okJson<ApiProduct>(await this.ctx.get(`/products/${id}`), `GET /products/${id}`);
  }

  async productTrash(): Promise<ApiProduct[]> {
    return okJson<ApiProduct[]>(await this.ctx.get('/products/trash'), 'GET /products/trash');
  }

  async softDeleteProduct(id: number): Promise<void> {
    await okJson(await this.ctx.delete(`/products/${id}`), `DELETE /products/${id}`);
  }

  async updateProduct(id: number, data: Record<string, unknown>): Promise<ApiProduct> {
    return okJson<ApiProduct>(await this.ctx.patch(`/products/${id}`, { data }), `PATCH /products/${id}`);
  }

  // --- Equipe da loja (ADMIN) ---

  async createStaff(
    role: StaffRole,
    overrides: Partial<{ name: string; email: string; password: string; phone: string }> = {},
  ): Promise<ApiUser & { password: string }> {
    const data = {
      name: `Equipe ${uid('wa')}`,
      email: uniqueEmail('equipe-wa'),
      password: 'Equipe@E2E1',
      phone: '21977776666',
      role,
      ...overrides,
    };
    const user = await okJson<ApiUser>(await this.ctx.post('/users', { data }), 'POST /users');
    return { ...user, password: data.password };
  }

  async getUser(id: number): Promise<ApiUser> {
    return okJson<ApiUser>(await this.ctx.get(`/users/${id}`), `GET /users/${id}`);
  }

  async usersTrash(): Promise<ApiUser[]> {
    return okJson<ApiUser[]>(await this.ctx.get('/users/trash'), 'GET /users/trash');
  }

  async softDeleteUser(id: number): Promise<void> {
    await okJson(await this.ctx.delete(`/users/${id}`), `DELETE /users/${id}`);
  }

  // --- Pedidos (equipe) ---

  async getOrder(id: number): Promise<ApiOrder> {
    return okJson<ApiOrder>(await this.ctx.get(`/orders/${id}`), `GET /orders/${id}`);
  }

  async setStatus(id: number, status: OrderStatus): Promise<ApiOrder> {
    return okJson<ApiOrder>(await this.ctx.patch(`/orders/${id}`, { data: { status } }), `PATCH /orders/${id} → ${status}`);
  }

  /** Aplica uma sequência de status (ex.: PREPARING → READY_FOR_PICKUP). */
  async advance(id: number, ...statuses: OrderStatus[]): Promise<ApiOrder> {
    let order = await this.getOrder(id);
    for (const status of statuses) order = await this.setStatus(id, status);
    return order;
  }

  async assign(id: number, driverId: number): Promise<ApiOrder> {
    return okJson<ApiOrder>(await this.ctx.patch(`/orders/${id}/assign`, { data: { driverId } }), `PATCH /orders/${id}/assign`);
  }
}

/** Cliente novo (cadastro público) com um endereço num bairro só dele. */
export class Customer {
  private constructor(
    readonly ctx: APIRequestContext,
    readonly session: Session,
    readonly password: string,
    readonly neighborhood: string,
    readonly addressId: number,
  ) {}

  static async create(opts: { name?: string; neighborhood?: string } = {}): Promise<Customer> {
    const anon = await request.newContext({ baseURL: API_URL });
    const signup = await signupClient(anon, { name: opts.name ?? `Cliente WA ${uid('c')}` });
    await anon.dispose();
    const ctx = await authedContext(signup.token);
    const neighborhood = opts.neighborhood ?? `Bairro ${uid('wa')}`;
    const address = await okJson<{ id: number }>(
      await ctx.post('/addresses', {
        data: {
          zipCode: '20040003',
          street: 'Rua do Teste Painel',
          number: '100',
          complement: 'Fundos',
          neighborhood,
          city: 'Rio de Janeiro',
          state: 'RJ',
        },
      }),
      'POST /addresses',
    );
    return new Customer(ctx, signup, signup.password, neighborhood, address.id);
  }

  get name(): string {
    return this.session.user.name;
  }

  dispose(): Promise<void> {
    return this.ctx.dispose();
  }

  /** Corpo de orçamento/pedido (DELIVERY usa o endereço do cliente). */
  orderBody(items: OrderItemInput[], type: 'DELIVERY' | 'TAKEOUT' = 'DELIVERY') {
    return { items, type, ...(type === 'DELIVERY' ? { addressId: this.addressId } : {}) };
  }

  async order(input: {
    items: OrderItemInput[];
    type?: 'DELIVERY' | 'TAKEOUT';
    paymentMethod?: PaymentMethod;
    changeFor?: string;
    paymentId?: number;
  }): Promise<ApiOrder> {
    const data = {
      ...this.orderBody(input.items, input.type ?? 'DELIVERY'),
      paymentMethod: input.paymentMethod ?? 'MONEY',
      ...(input.changeFor ? { changeFor: input.changeFor } : {}),
      ...(input.paymentId ? { paymentId: input.paymentId } : {}),
    };
    return sendWhileStoreOpens<ApiOrder>(() => this.ctx.post('/orders', { data }), 'POST /orders');
  }

  /** Pagamento com cartão em sandbox (token falso → aprovado simulado). Devolve o id do pagamento. */
  async payByCard(items: OrderItemInput[], type: 'DELIVERY' | 'TAKEOUT' = 'DELIVERY'): Promise<number> {
    const data = {
      order: this.orderBody(items, type),
      token: `tok-e2e-${uid('card')}`,
      paymentMethodId: 'master',
      installments: 1,
      docNumber: '12345678909',
      docType: 'CPF',
      email: this.session.user.email,
    };
    const payment = await sendWhileStoreOpens<{ id: number; status: string }>(
      () => this.ctx.post('/payment/card', { data }),
      'POST /payment/card',
    );
    expect(payment.status, 'pagamento com cartão em sandbox').toBe('approved');
    return Number(payment.id);
  }

  /** PIX em sandbox: aprovado automaticamente alguns segundos depois. Devolve o id do pagamento. */
  async payByPix(items: OrderItemInput[], type: 'DELIVERY' | 'TAKEOUT' = 'DELIVERY'): Promise<number> {
    const payment = await sendWhileStoreOpens<{ id: number }>(
      () => this.ctx.post('/payment/pix', { data: { order: this.orderBody(items, type) } }),
      'POST /payment/pix',
    );
    await expect
      .poll(
        async () => (await okJson<{ status: string }>(await this.ctx.get(`/payment/status/${payment.id}`), 'GET /payment/status')).status,
        { timeout: 30_000, intervals: [1_000] },
      )
      .toBe('approved');
    return Number(payment.id);
  }
}

/* ------------------------------------------------------------------ */
/* Interface                                                           */
/* ------------------------------------------------------------------ */

/** Faz login pela tela /login (campos sem rótulo associado: usa os placeholders). */
export async function loginViaUi(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByPlaceholder('nome@empresa.com.br').fill(email);
  await page.getByPlaceholder('••••••••').fill(password);
  await page.getByRole('button', { name: 'Acessar Sistema' }).click();
}

/** Toast do react-hot-toast (role="status") com o texto informado (o mais recente, se houver repetidos). */
export function toast(page: Page, text: string | RegExp): Locator {
  return page.getByRole('status').filter({ hasText: text }).last();
}

/** Menu lateral do painel. */
export function sidebar(page: Page): Locator {
  return page.getByRole('complementary');
}

/** Título principal da página (h1). */
export function pageHeading(page: Page, name?: string | RegExp): Locator {
  return page.getByRole('heading', { level: 1, ...(name ? { name } : {}) });
}

/**
 * Campo de formulário pelo texto do <label> que o antecede.
 * Os formulários do painel não ligam <label> ao campo (sem htmlFor/id), então getByLabel não funciona.
 */
export function fieldByLabel(scope: Locator, label: string): Locator {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return scope
    .locator('label')
    .filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) })
    .locator('xpath=following-sibling::*[self::input or self::select or self::textarea][1]');
}

/**
 * Card de um pedido no quadro, pelo id do pedido (data-order-id). O título do card mostra o número do
 * pedido NA LOJA ("#12"), não o id: confira com orderCardHeading.
 */
export function orderCard(page: Page, id: number): Locator {
  return page.locator(`[data-order-id="${id}"]`);
}

/** Título do card: "#<número do pedido na loja>" seguido do horário. */
export function orderCardHeading(card: Locator, number: number): Locator {
  return card.getByRole('heading', { name: new RegExp(`^#${number}\\b`) });
}

/** Cabeçalho de uma coluna do quadro de pedidos. */
export function boardColumn(page: Page, title: string): Locator {
  return page.getByText(title, { exact: true });
}

export const BOARD_COLUMNS = [
  'Novos',
  'Preparando',
  'Aguardando Motoboy',
  'Retirar no Balcão',
  'Em Entrega',
  'Concluídos',
  'Cancelados',
] as const;

/** Linha de tabela (Cardápio, Equipe, Lixeira) que contém o texto. */
export function tableRow(page: Page, text: string): Locator {
  return page.getByRole('row').filter({ hasText: text });
}

/** Registra as respostas da API com erro (4xx/5xx) para provar que nenhuma ação foi recusada. */
export function trackApiFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on('response', (res) => {
    if (res.url().startsWith(API_URL) && res.status() >= 400) {
      failures.push(`${res.request().method()} ${res.url().slice(API_URL.length)} → ${res.status()}`);
    }
  });
  return failures;
}

/** Registra as chamadas de escrita (POST/PATCH/PUT/DELETE) feitas à API. */
export function trackApiWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on('request', (req) => {
    if (req.url().startsWith(API_URL) && !['GET', 'OPTIONS', 'HEAD'].includes(req.method())) {
      writes.push(`${req.method()} ${req.url().slice(API_URL.length)}`);
    }
  });
  return writes;
}

/** Erros de console e exceções não tratadas da página. */
export function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

/** Espera a resposta de uma chamada da API (método + caminho exato, sem query). */
export function waitForApi(page: Page, method: string, pathname: string | RegExp) {
  return page.waitForResponse((res) => {
    if (!res.url().startsWith(API_URL) || res.request().method() !== method) return false;
    const actual = new URL(res.url()).pathname;
    return typeof pathname === 'string' ? actual === pathname : pathname.test(actual);
  });
}

// PNG 1x1 válido (conferido pelo backend pela assinatura e processado pelo sharp)
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Grava um PNG pequeno na pasta de saída do teste e devolve o caminho (para o seletor de arquivos). */
export function tinyPng(testInfo: TestInfo, name = 'produto-e2e.png'): string {
  const file = testInfo.outputPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(TINY_PNG_BASE64, 'base64'));
  return file;
}

/** Arquivo de texto (não é imagem) para testar a recusa do seletor. */
export function textFile(testInfo: TestInfo, name = 'nao-e-imagem.txt'): string {
  const file = testInfo.outputPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'isto não é uma imagem');
  return file;
}

/** Valor monetário como o Intl pt-BR exibe (o espaço depois de "R$" é não separável). */
export function money(value: number): RegExp {
  const formatted = value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return new RegExp(`R\\$\\s${formatted.replace(/\./g, '\\.')}`);
}

/** Textos do painel visíveis ao usuário (corpo, título da aba e atributos lidos por leitores de tela). */
export async function visibleBrandTexts(page: Page): Promise<string> {
  return page.evaluate(() => {
    const texts: string[] = [document.title, document.body.innerText];
    document.querySelectorAll('[title],[alt],[aria-label],[placeholder],meta[name="description"]').forEach((el) => {
      for (const attr of ['title', 'alt', 'aria-label', 'placeholder', 'content']) {
        const value = el.getAttribute(attr);
        if (value) texts.push(value);
      }
    });
    texts.push(...Object.keys(window.localStorage));
    return texts.join('\n');
  });
}
