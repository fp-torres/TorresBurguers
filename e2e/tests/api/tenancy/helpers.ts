/**
 * Helpers da suíte de ISOLAMENTO ENTRE LOJAS (api/tenancy).
 *
 * - A loja A é a loja demo do seed (equipe padrão). Ela nunca muda de situação, plano ou configuração
 *   aqui: os testes só leem dela e criam/cancelam os próprios produtos e pedidos.
 * - As lojas B (e C) são criadas por cada arquivo pelo superpainel (POST /platform/stores), com o
 *   responsável entrando pelo convite (POST /invitations/:token/accept), equipe, cardápio e pedidos
 *   próprios. No afterAll elas são desativadas (nada é apagado; somem da vitrine e do diretório).
 * - Os helpers compartilhados (support/*) e os de identidade são só importados, nunca alterados.
 */
import { expect, request, type APIRequestContext, type APIResponse } from '@playwright/test';
import { E2E } from '../../../support/env';
import { body, demoStore, login, loginAs, uid, uniqueEmail, type PublicStore, type Session } from '../../../support/api';
import type { DefaultUserKey } from '../../../support/users';
import { expectContractErrorShape, expectNoSecrets, makePng, messagesOf, pngFile } from '../identity/helpers';

export { body, demoStore, expectNoSecrets, makePng, pngFile, uid, uniqueEmail };
export type { PublicStore, Session };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export type StaffRole = 'ADMIN' | 'EMPLOYEE' | 'KITCHEN' | 'COURIER';
export const STAFF_ROLES: readonly StaffRole[] = ['ADMIN', 'EMPLOYEE', 'KITCHEN', 'COURIER'];

export const PASSWORD = 'SenhaForte@123';
/** Id que cabe numa coluna integer, mas não existe (a resposta de referência do "404 uniforme"). */
export const MISSING_ID = 2_147_483_000;

/** Mensagens de contrato conferidas nos testes (texto exato da API). */
export const MSG = {
  productNotFound: 'Produto não encontrado.',
  productNotInTrash: 'Produto não encontrado na lixeira.',
  addonNotFound: 'Adicional não encontrado.',
  orderNotFound: 'Pedido não encontrado.',
  paymentNotFound: 'Pagamento não encontrado.',
  paymentNotFoundOrExpired: 'Pagamento não encontrado ou expirado. Faça o pagamento novamente.',
  userNotFound: 'Usuário não encontrado',
  invitationNotFound: 'Convite não encontrado.',
  driverNotFound: 'Entregador não encontrado ou inativo.',
  customerNotFound: 'Cliente não encontrado.',
  addressNotFound: 'Endereço não encontrado.',
  storeNotFound: 'Loja não encontrada.',
  otherStore: 'Você só pode administrar a loja à qual a sua conta pertence.',
  noPermission: 'Você não tem permissão para acessar este recurso.',
  noUserPermission: 'Você não tem permissão para acessar este usuário.',
  clientsOnly: 'Somente clientes fazem pedidos e pagamentos. Contas da equipe não compram pelo sistema.',
  platformOnly: 'Área exclusiva da administração da plataforma.',
  invalidImage:
    'Imagem inválida: envie o arquivo pelo painel (campo "file" ou POST /uploads) ou informe uma URL https://.',
  storeUnavailable: 'Esta loja está temporariamente indisponível para novos pedidos.',
  productMissingInOrder: (id: number) => `Produto #${id} não encontrado.`,
  addonMissingInOrder: (id: number) => `Adicional #${id} não encontrado.`,
  addonsMissingInCatalog: (...ids: number[]) => `Adicional não encontrado: ${ids.join(', ')}.`,
  /** forbidNonWhitelisted do ValidationPipe: o campo é recusado (400), nunca usado. */
  notAllowed: (field: string) => new RegExp(`property ${field} should not exist`),
} as const;

/** Zonas de entrega próprias das lojas criadas (lojas novas nascem com a entrega desligada). */
export const DELIVERY_ZONES = {
  fallback: { fee: 9, time: '50-60 min' },
  zones: [{ neighborhoods: ['Centro'], fee: 4, time: '30-40 min' }],
};

// ---------------------------------------------------------------------------
// Contextos HTTP e sessões
// ---------------------------------------------------------------------------

/** Contexto HTTP próprio (beforeAll/afterAll não têm o fixture `request`). Lembre do dispose(). */
export function newApi(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: E2E.apiURL });
}

export const bearer = (token: string, extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${token}`,
  ...extra,
});

/** Sessões dos usuários padrão (equipe da loja demo, cliente e superadmin). */
export async function defaultSession(api: APIRequestContext, key: DefaultUserKey): Promise<Session> {
  return loginAs(api, key);
}

/** Conta criada pelos testes, com a senha para novos logins. */
export interface Member extends Session {
  email: string;
  password: string;
}

/** Equipe da loja: um membro por perfil. */
export type Team = Record<StaffRole, Session>;

/** Equipe padrão da loja demo (loja A). */
export async function demoTeam(api: APIRequestContext): Promise<Team> {
  const [admin, employee, kitchen, courier] = await Promise.all(
    (['admin', 'employee', 'kitchen', 'courier'] as const).map((key) => loginAs(api, key)),
  );
  return { ADMIN: admin, EMPLOYEE: employee, KITCHEN: kitchen, COURIER: courier };
}

// ---------------------------------------------------------------------------
// Asserções
// ---------------------------------------------------------------------------

/** Confere o status (com o corpo na mensagem de falha) e devolve o corpo. */
export async function expectStatus(res: APIResponse, status: number, label = ''): Promise<Json> {
  const payload = await body(res);
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  expect(res.status(), `${label} ${res.url()} → ${res.status()} ${text.slice(0, 600)}`.trim()).toBe(status);
  return payload;
}

/**
 * Erro no contrato {statusCode, message, error}. `message`: texto exato (string) ou padrão (RegExp),
 * comparado com as mensagens unidas por " | ".
 */
export async function expectError(
  res: APIResponse,
  status: number,
  message?: string | RegExp,
  label = '',
): Promise<Json> {
  const payload = await expectStatus(res, status, label);
  expectContractErrorShape(payload, status);
  if (message !== undefined) {
    const text = messagesOf(payload).join(' | ');
    if (typeof message === 'string') expect(text, `${label}: mensagem`).toBe(message);
    else expect(text, `${label}: mensagem`).toMatch(message);
  }
  return payload;
}

/**
 * 404 uniforme: o recurso da outra loja responde EXATAMENTE como um id inexistente
 * (mesmo status, mesma mensagem, mesmo corpo) — nunca um 403 que confirme a existência.
 */
export async function expectUniform404(
  foreign: APIResponse,
  missing: APIResponse,
  message: string,
  label: string,
): Promise<void> {
  const fromForeign = await expectError(foreign, 404, message, `${label} (registro da outra loja)`);
  const fromMissing = await expectError(missing, 404, message, `${label} (id inexistente)`);
  expect(fromForeign, `${label}: mesma resposta de um id inexistente`).toEqual(fromMissing);
}

export const ids = (list: Array<{ id: number }> | null | undefined): number[] =>
  (list ?? []).map((item) => item.id).sort((a, b) => a - b);

/** Nenhum dos ids proibidos aparece na lista. */
export function expectNoneOf(list: Array<{ id: number }>, forbidden: number[], label: string): void {
  const leaked = list.filter((item) => forbidden.includes(item.id)).map((item) => item.id);
  expect(leaked, `${label}: registros de outra loja não podem aparecer`).toEqual([]);
}

/** Todos os registros pertencem à loja informada (campo store_id). */
export function expectAllFromStore(list: Array<{ store_id?: number }>, storeId: number, label: string): void {
  const foreign = list.filter((item) => item.store_id !== storeId);
  expect(foreign.map((item) => item.store_id), `${label}: todos os registros são da loja ${storeId}`).toEqual([]);
}

export const cents = (value: unknown): number => Math.round(Number(value) * 100);

// ---------------------------------------------------------------------------
// Lojas criadas pelo superpainel
// ---------------------------------------------------------------------------

export interface TenantStore {
  id: number;
  slug: string;
  name: string;
  subscriptionId: number;
  /** Responsável (ADMIN) que entrou pelo convite do superpainel. */
  owner: Member;
}

let demoPlanId: number | null = null;

/**
 * Plano das lojas de teste: o plano interno "demo" do seed (sem cobrança, sem limites, todos os
 * recursos). Indisponível para contratação, então a criação usa allow_inactive_plan (superadmin).
 * Assim nenhum plano novo é criado na plataforma.
 */
async function testPlanId(api: APIRequestContext, superadmin: Session): Promise<number> {
  if (demoPlanId !== null) return demoPlanId;
  const res = await api.get('/platform/plans?search=demo&pageSize=100', { headers: bearer(superadmin.token) });
  const page = await expectStatus(res, 200, 'GET /platform/plans');
  const plan = (page.items as Json[]).find((item) => item.code === 'demo');
  expect(plan, 'plano interno "demo" do seed').toBeTruthy();
  demoPlanId = plan.id as number;
  return demoPlanId;
}

/** Extrai o token de uso único do link do convite (/convite/<token>). */
export function invitationToken(url: string): string {
  const token = new URL(url).pathname.split('/').filter(Boolean).pop();
  expect(token, `token no link do convite: ${url}`).toBeTruthy();
  return token as string;
}

/** Aceita um convite e devolve a sessão da conta criada. */
export async function acceptInvitation(
  api: APIRequestContext,
  url: string,
  name: string,
): Promise<{ session: Session; password: string }> {
  const res = await api.post(`/invitations/${invitationToken(url)}/accept`, { data: { name, password: PASSWORD } });
  const payload = await expectStatus(res, 201, 'POST /invitations/:token/accept');
  expect(typeof payload.access_token).toBe('string');
  return { session: { token: payload.access_token, user: payload.user }, password: PASSWORD };
}

/**
 * Cria uma loja pelo superpainel: POST /platform/stores (fechada, entrega desligada) + convite do
 * responsável, aceito na hora. Por padrão a loja abre e configura as zonas de entrega próprias.
 */
export async function createStore(
  api: APIRequestContext,
  superadmin: Session,
  label: string,
  options: { open?: boolean; delivery?: boolean } = {},
): Promise<TenantStore> {
  const slug = uid('tn').toLowerCase();
  const name = `Tenancy ${label} ${slug}`.slice(0, 120);
  const ownerEmail = uniqueEmail(`tn-owner-${label.toLowerCase().replace(/[^a-z0-9]/g, '')}`);
  const res = await api.post('/platform/stores', {
    headers: bearer(superadmin.token),
    data: {
      name,
      slug,
      plan_id: await testPlanId(api, superadmin),
      allow_inactive_plan: true,
      owner: { email: ownerEmail, name: `Responsável ${label}` },
    },
  });
  const created = await expectStatus(res, 201, `POST /platform/stores (${label})`);
  expect(created.warnings, 'loja criada sem avisos').toEqual([]);
  expect(created.invitation?.url, 'link do convite do responsável').toBeTruthy();

  const { session } = await acceptInvitation(api, created.invitation.url, `Responsável ${label}`);
  expect(session.user, 'o responsável entra como ADMIN da loja nova').toMatchObject({
    role: 'ADMIN',
    store_id: created.store.id,
    email: ownerEmail,
  });

  const owner: Member = { ...session, email: ownerEmail, password: PASSWORD };
  if (options.delivery !== false) {
    const zones = await api.patch('/store/settings', {
      headers: bearer(owner.token),
      data: { delivery_enabled: true, delivery_zones: DELIVERY_ZONES },
    });
    await expectStatus(zones, 200, `zonas de entrega da loja ${label}`);
  }
  if (options.open !== false) {
    const open = await api.patch('/store/status', { headers: bearer(owner.token), data: { is_open: true } });
    await expectStatus(open, 200, `abrir a loja ${label}`);
  }
  return {
    id: created.store.id,
    slug: created.store.slug,
    name: created.store.name,
    subscriptionId: created.subscription.id,
    owner,
  };
}

/** Desativa a loja de teste no fim do arquivo (nada é apagado; sai da vitrine e do diretório). */
export async function retireStore(api: APIRequestContext, superadmin: Session, store: TenantStore): Promise<void> {
  await api.post(`/platform/stores/${store.id}/deactivate`, {
    headers: bearer(superadmin.token),
    data: { reason: 'Fim da suíte de isolamento entre lojas (E2E).' },
  });
}

// ---------------------------------------------------------------------------
// Equipe
// ---------------------------------------------------------------------------

/** Membro da equipe criado pelo ADMIN (POST /users com perfil). */
export async function addMember(
  api: APIRequestContext,
  admin: Session,
  role: StaffRole,
  label: string = role,
): Promise<Member> {
  const email = uniqueEmail(`tn-${role.toLowerCase()}`);
  const res = await api.post('/users', {
    headers: bearer(admin.token),
    data: { name: `${label} Tenancy`.slice(0, 50), email, password: PASSWORD, role },
  });
  const created = await expectStatus(res, 201, `POST /users (${role})`);
  expect(created.store_id, `${role} criado na loja do ADMIN`).toBe(admin.user.store_id);
  return { ...(await login(api, email, PASSWORD)), email, password: PASSWORD };
}

/** Membro da equipe que entra por convite da loja (POST /store/invitations + aceite). */
export async function inviteMember(
  api: APIRequestContext,
  admin: Session,
  role: StaffRole,
  label: string = role,
): Promise<Member> {
  const email = uniqueEmail(`tn-inv-${role.toLowerCase()}`);
  const res = await api.post('/store/invitations', { headers: bearer(admin.token), data: { email, role } });
  const created = await expectStatus(res, 201, `POST /store/invitations (${role})`);
  expect(created.invitation).toMatchObject({ store_id: admin.user.store_id, role, status: 'PENDING' });
  const { session } = await acceptInvitation(api, created.url, `${label} Convidado`);
  expect(session.user).toMatchObject({ role, store_id: admin.user.store_id, email });
  return { ...session, email, password: PASSWORD };
}

/** Equipe completa de uma loja criada: responsável (ADMIN), atendente por convite, cozinha e entregador. */
export async function buildTeam(api: APIRequestContext, store: TenantStore): Promise<Team> {
  const employee = await inviteMember(api, store.owner, 'EMPLOYEE');
  const kitchen = await addMember(api, store.owner, 'KITCHEN');
  const courier = await addMember(api, store.owner, 'COURIER');
  return { ADMIN: store.owner, EMPLOYEE: employee, KITCHEN: kitchen, COURIER: courier };
}

// ---------------------------------------------------------------------------
// Cardápio
// ---------------------------------------------------------------------------

export async function addProduct(api: APIRequestContext, admin: Session, data: Record<string, unknown> = {}): Promise<Json> {
  const res = await api.post('/products', {
    headers: bearer(admin.token),
    data: { name: `Produto ${uid('tp')}`, price: 20, category: 'hamburgueres', ...data },
  });
  return expectStatus(res, 201, 'POST /products');
}

export async function addAddon(api: APIRequestContext, admin: Session, data: Record<string, unknown> = {}): Promise<Json> {
  const res = await api.post('/addons', {
    headers: bearer(admin.token),
    data: { name: `Adicional ${uid('ta')}`.slice(0, 60), price: 3, ...data },
  });
  return expectStatus(res, 201, 'POST /addons');
}

export async function trashProduct(api: APIRequestContext, admin: Session, id: number): Promise<void> {
  await expectStatus(await api.delete(`/products/${id}`, { headers: bearer(admin.token) }), 200, `DELETE /products/${id}`);
}

export async function trashAddon(api: APIRequestContext, admin: Session, id: number): Promise<void> {
  await expectStatus(await api.delete(`/addons/${id}`, { headers: bearer(admin.token) }), 200, `DELETE /addons/${id}`);
}

/** Imagem avulsa da loja (POST /uploads): devolve o nome do arquivo (s<storeId>-...webp). */
export async function uploadImage(api: APIRequestContext, admin: Session): Promise<string> {
  const res = await api.post('/uploads', { headers: bearer(admin.token), multipart: { file: pngFile(makePng(12, 12)) } });
  const payload = await expectStatus(res, 201, 'POST /uploads');
  expect(payload.filename, 'arquivo com o prefixo da loja').toMatch(new RegExp(`^s${admin.user.store_id}-[\\w.-]+\\.webp$`));
  return payload.filename as string;
}

// ---------------------------------------------------------------------------
// Clientes, pedidos e pagamentos (vitrine por loja: /stores/<slug>/...)
// ---------------------------------------------------------------------------

/** Cliente novo (cadastro público; conta global, sem loja). */
export async function newCustomer(api: APIRequestContext, label = 'Cliente'): Promise<Member> {
  const email = uniqueEmail('tn-cliente');
  const res = await api.post('/users', {
    data: { name: `${label} Tenancy`.slice(0, 50), email, password: PASSWORD, phone: '21988887777' },
  });
  await expectStatus(res, 201, 'cadastro de cliente');
  return { ...(await login(api, email, PASSWORD)), email, password: PASSWORD };
}

export async function addAddress(api: APIRequestContext, customer: Session, neighborhood = 'Centro'): Promise<Json> {
  const res = await api.post('/addresses', {
    headers: bearer(customer.token),
    data: {
      zipCode: '20040-002',
      street: 'Rua do Teste Tenancy',
      number: '100',
      neighborhood,
      city: 'Rio de Janeiro',
      state: 'RJ',
    },
  });
  return expectStatus(res, 201, 'POST /addresses');
}

export interface OrderItemInput {
  productId: number;
  quantity: number;
  addonIds?: number[];
}

export interface OrderInput {
  items: OrderItemInput[];
  type: 'DELIVERY' | 'TAKEOUT';
  addressId?: number;
}

/** Rota da vitrine de uma loja: /stores/<slug><path>. */
export const storePath = (slug: string, path: string) => `/stores/${slug}${path}`;

export async function placeOrder(
  api: APIRequestContext,
  slug: string,
  customer: Session,
  order: OrderInput,
  paymentMethod: 'MONEY' | 'PIX' | 'CREDIT_CARD' | 'DEBIT_CARD' = 'MONEY',
): Promise<Json> {
  const res = await api.post(storePath(slug, '/orders'), {
    headers: bearer(customer.token),
    data: { ...order, paymentMethod },
  });
  const created = await expectStatus(res, 201, `POST /stores/${slug}/orders`);
  return created;
}

export function cardBody(order: OrderInput | Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
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

/** Pagamento com cartão na vitrine da loja (sandbox: aprovado na hora e o pedido já vem em orderId). */
export async function payCard(
  api: APIRequestContext,
  slug: string,
  customer: Session,
  order: OrderInput,
  extra: Record<string, unknown> = {},
): Promise<Json> {
  const res = await api.post(storePath(slug, '/payment/card'), {
    headers: bearer(customer.token),
    data: cardBody(order, extra),
  });
  const payment = await expectStatus(res, 201, `POST /stores/${slug}/payment/card`);
  expect(payment.status, 'cartão aprovado no sandbox').toBe('approved');
  expect(typeof payment.orderId, 'pedido criado pelo servidor').toBe('number');
  return payment;
}

/** Avança o pedido pelos status informados (cada passo precisa responder 200). */
export async function advance(api: APIRequestContext, staff: Session, orderId: number, ...statuses: string[]): Promise<Json> {
  let last: Json = null;
  for (const status of statuses) {
    const res = await api.patch(`/orders/${orderId}`, { headers: bearer(staff.token), data: { status } });
    last = await expectStatus(res, 200, `PATCH /orders/${orderId} → ${status}`);
  }
  return last;
}

export async function getJson(api: APIRequestContext, path: string, token?: string, label = path): Promise<Json> {
  const res = await api.get(path, token ? { headers: bearer(token) } : undefined);
  return expectStatus(res, 200, label);
}

// ---------------------------------------------------------------------------
// Limpeza (afterAll): melhor esforço, na ordem inversa
// ---------------------------------------------------------------------------

export class Cleanup {
  private readonly tasks: Array<{ label: string; run: () => Promise<unknown> }> = [];

  add(label: string, run: () => Promise<unknown>): void {
    this.tasks.push({ label, run });
  }

  async run(): Promise<void> {
    for (const task of this.tasks.splice(0).reverse()) {
      try {
        await task.run();
      } catch (error) {
        console.warn(`[tenancy] limpeza "${task.label}" falhou: ${(error as Error).message}`);
      }
    }
  }
}

/** Cancela (como ADMIN da loja) um pedido criado pelo teste. */
export function cancelOrderLater(cleanup: Cleanup, api: APIRequestContext, admin: Session, orderId: number): void {
  cleanup.add(`cancelar pedido ${orderId}`, () =>
    api.patch(`/orders/${orderId}/cancel`, { headers: bearer(admin.token) }),
  );
}

/** Manda para a lixeira (como ADMIN da loja) um produto criado pelo teste. */
export function trashProductLater(cleanup: Cleanup, api: APIRequestContext, admin: Session, productId: number): void {
  cleanup.add(`lixeira do produto ${productId}`, () =>
    api.delete(`/products/${productId}`, { headers: bearer(admin.token) }),
  );
}

// ---------------------------------------------------------------------------
// Banco de teste (cliente pg do e2e): SOMENTE o banco *_e2e desta execução
// ---------------------------------------------------------------------------

export interface PgError extends Error {
  code?: string;
  constraint?: string;
}

export interface PgClient {
  connect(): Promise<void>;
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
  end(): Promise<void>;
}

interface PgModule {
  Client: new (config: { host: string; port: number; user: string; password: string; database: string }) => PgClient;
}

/** Conexão com o banco de teste desta execução (recusa qualquer banco que não termine em _e2e). */
export async function withTestDb<T>(fn: (db: PgClient) => Promise<T>): Promise<T> {
  const { host, port, user, password, database } = E2E.db;
  if (!/_e2e$/.test(database)) {
    throw new Error(`Recusado: "${database}" não é um banco de teste (*_e2e).`);
  }
  // pg não tem tipos no e2e (sem @types/pg): carregado com a interface mínima acima
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require('pg') as PgModule;
  const client = new pg.Client({ host, port, user, password, database });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Pagamentos de uma loja que a rotina de conciliação ainda vai transformar em pedido (PIX do sandbox
 * a aprovar, aprovados sem pedido). Outros arquivos podem deixar um PIX pendente na loja demo: antes de
 * comparar números "antes e depois", espera esses pagamentos virarem pedido.
 */
export async function pendingFinalizations(storeId: number): Promise<number> {
  return withTestDb(async (db) => {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "payments"
        WHERE "store_id" = $1 AND "order_id" IS NULL AND "created_at" > now() - interval '3 days'
          AND (("status" = 'approved' AND "finalize_error" IS NULL)
            OR ("status" = 'pending' AND "auto_approve_at" IS NOT NULL
                AND ("expires_at" IS NULL OR "auto_approve_at" <= "expires_at")))`,
      [storeId],
    );
    return rows[0]?.n ?? 0;
  });
}

/** Data AAAA-MM-DD no fuso informado. */
export function dateKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function addDaysKey(key: string, days: number): string {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
