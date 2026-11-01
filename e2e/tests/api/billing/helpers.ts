/**
 * Helpers da suíte de COBRANÇA SaaS (api/billing): planos, assinaturas, faturas, limites e recursos do
 * plano, webhook da cobrança e rotina de ciclo de vida (SubscriptionLifecycleService).
 *
 * - A loja demo nunca muda aqui (situação, plano, assinatura): cada arquivo cria os PRÓPRIOS planos
 *   (privados, desativados no afterAll) e as próprias lojas (POST /platform/stores + convite aceito).
 *   No afterAll as faturas em aberto das lojas são anuladas, as assinaturas canceladas (a rotina não
 *   mexe mais nelas) e as lojas desativadas (nada é apagado; somem da vitrine e do diretório).
 * - A rotina roda a cada SAAS_BILLING_INTERVAL_MS (10 s na API de teste): a passagem do tempo é
 *   simulada mudando datas no banco de TESTE (*_e2e) e esperando a rotina com expect.poll.
 * - support/* e identity/helpers são só importados, nunca alterados.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { expect, request, type APIRequestContext, type APIResponse } from '@playwright/test';
import { E2E } from '../../../support/env';
import { body, login, loginAs, uid, uniqueEmail, type Session } from '../../../support/api';
import type { DefaultUserKey } from '../../../support/users';
import { expectContractErrorShape, expectNoSecrets, messagesOf } from '../identity/helpers';

export { body, expectContractErrorShape, expectNoSecrets, login, messagesOf, uid, uniqueEmail };
export type { Session };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export const PASSWORD = 'SenhaForte@123';
/** Id que cabe numa coluna integer, mas não existe. */
export const MISSING_ID = 2_147_483_000;
/** Espera máxima por uma rodada da rotina (intervalo de 10 s + processamento). */
export const LIFECYCLE_TIMEOUT = 45_000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Mensagens de contrato conferidas nos testes (texto exato da API). */
export const MSG = {
  platformOnly: 'Área exclusiva da administração da plataforma.',
  noPermission: 'Você não tem permissão para acessar este recurso.',
  /** Conta sem loja (cliente ou superadmin fora de sessão de suporte) numa rota da equipe. */
  staffOnly: 'Esta área é exclusiva da equipe de uma loja.',
  invalidSession: 'Sessão inválida ou expirada. Faça login novamente.',
  // Planos
  planNotFound: 'Plano não encontrado.',
  planCodeTaken: 'Já existe um plano com este código. Escolha outro.',
  planUnavailable: 'Este plano não está disponível para novas contratações.',
  // Assinaturas
  subscriptionNotFound: 'Assinatura não encontrada.',
  subscriptionExists:
    'A loja já tem uma assinatura vigente. Mude o plano ou cancele a assinatura atual antes de criar outra.',
  noCurrentSubscription: 'A loja não tem uma assinatura vigente. Fale com a administração da plataforma.',
  samePlan: 'A assinatura já está neste plano.',
  subscriptionCanceled:
    'A assinatura está cancelada e não pode mais ser alterada. Uma nova contratação cria outra assinatura.',
  nothingToResume: 'Não há cancelamento agendado para desfazer.',
  periodEnded: 'O período da assinatura já terminou: o cancelamento não pode mais ser desfeito.',
  overdueInvoices: 'Há faturas vencidas em aberto. Registre o pagamento ou reative com force e um motivo.',
  forceReasonRequired: 'Informe o motivo para reativar sem o pagamento das faturas vencidas.',
  suspendReasonRequired: 'Informe o motivo da suspensão.',
  cancelReasonRequired: 'Informe o motivo do cancelamento imediato.',
  platformSuspensionCheckout:
    'A assinatura foi suspensa pela administração da plataforma. Fale com o suporte para regularizar.',
  reasonTooLong: 'O motivo pode ter no máximo 300 caracteres.',
  storeNotFound: 'Loja não encontrada.',
  // Faturas
  invoiceNotFound: 'Fatura não encontrada.',
  freePlanInvoice: 'O plano desta assinatura é gratuito: informe o valor da fatura.',
  invoicePeriodRequired: 'Informe o início e o fim do período da fatura (period_start e period_end).',
  invoicePeriodInvalid: 'O fim do período da fatura deve ser depois do início.',
  invoicePeriodExists: 'Já existe uma fatura para este período.',
  invoiceVoid: 'Esta fatura foi anulada e não pode mais ser paga nem recusada.',
  invoiceAlreadyPaid: 'Esta fatura já foi paga.',
  paidAtFuture: 'A data do pagamento (paid_at) não pode estar no futuro.',
  paidInvoiceVoid: 'Fatura paga não pode ser anulada (estorno não é feito pela plataforma).',
  providerPaymentUsed: 'Este pagamento já foi usado para quitar outra fatura.',
  paidWithOtherPayment: 'Esta fatura já foi paga com outro pagamento.',
  // Situação da loja (store-access.ts)
  /** Painel da equipe: suspensa pela rotina (tolerância vencida). O cliente recebe sempre storeUnavailable. */
  subscriptionSuspendedStore:
    'A assinatura está suspensa por falta de pagamento. Regularize a cobrança para voltar a vender.',
  /** Painel da equipe: suspensa sem inadimplência conhecida (ex.: pelo superadmin) — mensagem neutra. */
  subscriptionSuspendedNeutral:
    'A assinatura da loja está suspensa. Fale com o suporte da plataforma para regularizar e voltar a vender.',
  subscriptionCanceledStore: 'A assinatura da loja foi cancelada. Contrate um plano para voltar a vender.',
  pastDueWarning:
    'Há uma cobrança da assinatura em aberto. Regularize antes do fim da tolerância para evitar a suspensão da loja.',
  manageBlockedSuffix: 'Alterações no cardápio, na equipe e nas configurações estão bloqueadas.',
  /** Perfil público da loja que não vende (mensagem genérica: o motivo é assunto da loja com a plataforma). */
  storeUnavailable: 'Esta loja está temporariamente indisponível para novos pedidos.',
  // Limites e recursos do plano
  limitReached: (planName: string, limit: number, label: string) =>
    `Limite do plano ${planName} atingido: ${limit} ${label}. Fale com a administração da plataforma para mudar de plano.`,
  featureMissing: (planName: string, featureLabel: string) => `O plano ${planName} não inclui ${featureLabel}.`,
  monthlyOrdersLimit:
    'Esta loja atingiu o limite de pedidos do plano neste mês e não está recebendo novos pedidos agora.',
  onlinePaymentNotInPlan: 'Esta loja não oferece pagamento online. Escolha pagar na entrega ou na retirada.',
  // Webhook da cobrança
  webhookInvalidSignature: 'Assinatura da notificação inválida.',
  webhookInvalidNotification: 'Notificação inválida: data.id ausente ou em formato desconhecido.',
  webhookRetry: 'Notificação não processada agora; ela será reenviada pelo Mercado Pago.',
  webhookProviderOff:
    'Cobrança online desligada (SAAS_BILLING_PROVIDER=MANUAL e sem MP_SAAS_ACCESS_TOKEN): notificação ignorada.',
  notAllowed: (field: string) => `property ${field} should not exist`,
} as const;

export const LIMIT_LABEL = {
  staff_users: 'usuários da equipe',
  products: 'produtos no cardápio',
  monthly_orders: 'pedidos neste mês',
} as const;

export const FEATURE_LABEL = {
  online_payments: 'pagamentos online (PIX e cartão)',
  advanced_reports: 'relatórios e gráficos',
  custom_branding: 'identidade visual própria (logo e cor)',
} as const;

export const ALL_FEATURES = { online_payments: true, advanced_reports: true, custom_branding: true };
export const NO_FEATURES = { online_payments: false, advanced_reports: false, custom_branding: false };

// ---------------------------------------------------------------------------
// Contextos HTTP, sessões e asserções
// ---------------------------------------------------------------------------

/** Contexto HTTP próprio (beforeAll/afterAll não têm o fixture `request`). Lembre do dispose(). */
export function newApi(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: E2E.apiURL });
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const defaultSessions = new Map<DefaultUserKey, Session>();
/** Sessão de um usuário padrão (reaproveitada no worker). */
export async function defaultSession(api: APIRequestContext, key: DefaultUserKey): Promise<Session> {
  const cached = defaultSessions.get(key);
  if (cached) return cached;
  const session = await loginAs(api, key);
  defaultSessions.set(key, session);
  return session;
}

/** Confere o status e devolve o corpo (JSON). */
export async function expectStatus(res: APIResponse, status: number, label = ''): Promise<Json> {
  const payload = await body(res);
  expect(res.status(), `${label ? `${label}: ` : ''}esperado ${status}, veio ${res.status()} ${JSON.stringify(payload)}`).toBe(
    status,
  );
  return payload;
}

/**
 * Erro no formato do contrato ({statusCode, message, error}) com a mensagem em português: texto exato
 * (uma das mensagens, quando message é uma lista) ou expressão regular.
 */
export async function expectError(
  res: APIResponse,
  status: number,
  message: string | RegExp,
  label = '',
): Promise<Json> {
  const payload = await expectStatus(res, status, label);
  expectContractErrorShape(payload, status);
  const messages = messagesOf(payload);
  if (typeof message === 'string') {
    expect(messages, `${label}: mensagem da API`).toContain(message);
  } else {
    expect(messages.join(' | '), `${label}: mensagem da API`).toMatch(message);
  }
  return payload;
}

/** Instante (ms) de um campo de data da API. */
export const ms = (value: unknown): number => new Date(String(value)).getTime();

/** Confere um instante com folga (relógios da API, do banco e do teste). */
export function expectNear(actual: unknown, expected: number, toleranceMs: number, label: string): void {
  expect(actual, `${label}: data presente`).toBeTruthy();
  const diff = Math.abs(ms(actual) - expected);
  expect(diff, `${label}: ${String(actual)} ≈ ${new Date(expected).toISOString()} (±${toleranceMs} ms)`).toBeLessThanOrEqual(
    toleranceMs,
  );
}

/** Mesmo mês do calendário seguinte (regra do período mensal, sem âncora: 31/01 → 28/02). */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/** Caminhos de chaves que parecem credenciais (token, segredo, senha, hash) em qualquer nível. */
export function credentialKeys(value: unknown, at = '$'): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...credentialKeys(item, `${at}[${index}]`)));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|pass(word)?|hash|senha|credential/i.test(key)) found.push(`${at}.${key}`);
      found.push(...credentialKeys(child, `${at}.${key}`));
    }
  }
  return found;
}

/** Nenhuma credencial (chave sensível ou valor conhecido) no corpo da resposta. */
export function expectNoCredentials(value: unknown, label: string, knownSecrets: string[] = []): void {
  expectNoSecrets(value, label);
  expect(credentialKeys(value), `${label}: nenhuma chave de token/segredo/credencial`).toEqual([]);
  const text = JSON.stringify(value);
  for (const secret of [E2E.saasWebhookSecret, ...knownSecrets]) {
    expect(text.includes(secret), `${label}: o valor de uma credencial não pode aparecer na resposta`).toBe(false);
  }
}

// ---------------------------------------------------------------------------
// Limpeza (afterAll): melhor esforço, na ordem inversa
// ---------------------------------------------------------------------------

/** Tarefas de limpeza com um contexto HTTP próprio (o fixture `request` de cada teste já foi fechado). */
export class Cleanup {
  private readonly tasks: Array<{ label: string; run: (api: APIRequestContext) => Promise<unknown> }> = [];

  add(label: string, run: (api: APIRequestContext) => Promise<unknown>): void {
    this.tasks.push({ label, run });
  }

  async run(): Promise<void> {
    const api = await newApi();
    try {
      for (const task of this.tasks.splice(0).reverse()) {
        try {
          await task.run(api);
        } catch (error) {
          console.warn(`[billing] limpeza "${task.label}" falhou: ${(error as Error).message}`);
        }
      }
    } finally {
      await api.dispose();
    }
  }
}

// ---------------------------------------------------------------------------
// Planos (superpainel)
// ---------------------------------------------------------------------------

export interface Plan {
  id: number;
  code: string;
  name: string;
  price: number;
  trial_days: number;
  max_staff_users: number | null;
  max_products: number | null;
  max_monthly_orders: number | null;
  features: Record<string, boolean>;
  status: string;
  is_public: boolean;
  [key: string]: unknown;
}

/** Código único de plano (minúsculas, números e hífens; até 40). */
export function planCode(prefix = 'bl'): string {
  return uid(prefix).toLowerCase().slice(0, 40);
}

/**
 * Cria um plano pelo superpainel. Por padrão: privado (fora de GET /plans), ACTIVE, gratuito, sem
 * limites e sem recursos. Registra a desativação no cleanup.
 */
export async function createPlan(
  api: APIRequestContext,
  superadmin: Session,
  cleanup: Cleanup,
  data: Record<string, unknown> = {},
): Promise<Plan> {
  const code = planCode();
  const res = await api.post('/platform/plans', {
    headers: bearer(superadmin.token),
    data: { code, name: `Cobrança E2E ${code}`, price: 0, is_public: false, features: NO_FEATURES, ...data },
  });
  const plan = (await expectStatus(res, 201, 'POST /platform/plans')) as Plan;
  retirePlanLater(cleanup, superadmin, plan.id);
  return plan;
}

/** Resposta de uma limpeza: falha inesperada vira aviso no log (a limpeza continua). */
async function cleanupOk(res: APIResponse, label: string, accepted: number[] = []): Promise<void> {
  if (!res.ok() && !accepted.includes(res.status())) {
    throw new Error(`${label}: ${res.status()} ${await res.text()}`);
  }
}

/** Tira o plano de venda no fim do arquivo (planos nunca são apagados). */
export function retirePlanLater(cleanup: Cleanup, superadmin: Session, planId: number): void {
  cleanup.add(`desativar plano ${planId}`, async (api) =>
    cleanupOk(
      await api.patch(`/platform/plans/${planId}`, {
        headers: bearer(superadmin.token),
        data: { status: 'INACTIVE', is_public: false },
      }),
      `PATCH /platform/plans/${planId}`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Lojas (superpainel + convite do responsável)
// ---------------------------------------------------------------------------

export interface Member extends Session {
  email: string;
  password: string;
}

export interface BillingStore {
  id: number;
  slug: string;
  name: string;
  /** Assinatura criada junto com a loja. */
  subscriptionId: number;
  /** Responsável (ADMIN) que entrou pelo convite do superpainel. */
  owner: Member;
}

/** Extrai o token de uso único do link do convite (/convite/<token>). */
export function invitationToken(url: string): string {
  const token = new URL(url).pathname.split('/').filter(Boolean).pop();
  expect(token, `token no link do convite: ${url}`).toBeTruthy();
  return token as string;
}

/** Aceita o convite (POST /invitations/:token/accept): devolve a resposta crua. */
export function acceptInvitation(api: APIRequestContext, url: string, name: string): Promise<APIResponse> {
  return api.post(`/invitations/${invitationToken(url)}/accept`, { data: { name, password: PASSWORD } });
}

/**
 * Loja nova pelo superpainel (POST /platform/stores) no plano informado, com o responsável já dentro
 * pelo convite. Por padrão a loja é aberta (PATCH /store/status) para receber pedidos de retirada.
 * Registra no cleanup: anular faturas em aberto, cancelar a assinatura vigente e desativar a loja.
 */
export async function createStore(
  api: APIRequestContext,
  superadmin: Session,
  cleanup: Cleanup,
  planId: number,
  label: string,
  options: { open?: boolean; allowInactivePlan?: boolean } = {},
): Promise<BillingStore> {
  const slug = uid('bl').toLowerCase();
  const name = `Cobrança ${label} ${slug}`.slice(0, 120);
  const ownerEmail = uniqueEmail('bl-owner');
  const res = await api.post('/platform/stores', {
    headers: bearer(superadmin.token),
    data: {
      name,
      slug,
      plan_id: planId,
      ...(options.allowInactivePlan ? { allow_inactive_plan: true } : {}),
      owner: { email: ownerEmail, name: `Responsável ${label}`.slice(0, 50) },
    },
  });
  const created = await expectStatus(res, 201, `POST /platform/stores (${label})`);
  retireStoreLater(cleanup, superadmin, { id: created.store.id, slug });
  expect(created.warnings, 'loja criada sem avisos').toEqual([]);
  expect(created.invitation?.url, 'link do convite do responsável').toBeTruthy();

  const accepted = await expectStatus(
    await acceptInvitation(api, created.invitation.url, `Responsável ${label}`.slice(0, 50)),
    201,
    'aceite do convite do responsável',
  );
  const owner: Member = { token: accepted.access_token, user: accepted.user, email: ownerEmail, password: PASSWORD };
  expect(owner.user, 'o responsável entra como ADMIN da loja nova').toMatchObject({
    role: 'ADMIN',
    store_id: created.store.id,
  });
  if (options.open !== false) {
    await expectStatus(
      await api.patch('/store/status', { headers: bearer(owner.token), data: { is_open: true } }),
      200,
      `abrir a loja ${label}`,
    );
  }
  return {
    id: created.store.id,
    slug: created.store.slug,
    name: created.store.name,
    subscriptionId: created.subscription.id,
    owner,
  };
}

/**
 * Fim do arquivo: anula as faturas em aberto, cancela a assinatura vigente (a rotina deixa de
 * processá-la) e desativa a loja. Nada é apagado.
 */
export function retireStoreLater(cleanup: Cleanup, superadmin: Session, store: { id: number; slug: string }): void {
  cleanup.add(`aposentar loja ${store.id}`, async (api) => {
    const headers = bearer(superadmin.token);
    const reason = 'Fim da suíte de cobrança (E2E).';
    // Cada passo é independente: uma falha vira aviso e não impede os seguintes
    const step = async (label: string, call: () => Promise<APIResponse>, accepted: number[] = []) => {
      try {
        await cleanupOk(await call(), label, accepted);
      } catch (error) {
        console.warn(`[billing] limpeza da loja ${store.id}: ${(error as Error).message}`);
      }
    };
    const list = await api.get(`/platform/subscriptions?pageSize=100&search=${encodeURIComponent(store.slug)}`, { headers });
    const ids: number[] = [];
    if (list.ok()) {
      for (const item of ((await list.json()).items ?? []) as Json[]) if (item.store_id === store.id) ids.push(item.id);
    }
    for (const id of ids) {
      const sub = await api.get(`/platform/subscriptions/${id}`, { headers });
      if (!sub.ok()) continue;
      const detail = await sub.json();
      for (const invoice of (detail.invoices ?? []) as Json[]) {
        if (invoice.status === 'OPEN' || invoice.status === 'FAILED') {
          await step(`anular fatura ${invoice.id}`, () =>
            api.post(`/platform/invoices/${invoice.id}/void`, { headers, data: { reason } }),
          );
        }
      }
      if (detail.status !== 'CANCELED') {
        await step(
          `cancelar assinatura ${id}`,
          () => api.post(`/platform/subscriptions/${id}/cancel`, { headers, data: { at_period_end: false, reason } }),
          [409],
        );
      }
    }
    await step(
      `desativar loja ${store.id}`,
      () => api.post(`/platform/stores/${store.id}/deactivate`, { headers, data: { reason } }),
      [409],
    );
  });
}

// ---------------------------------------------------------------------------
// Assinaturas e faturas
// ---------------------------------------------------------------------------

export async function subscriptionDetail(api: APIRequestContext, superadmin: Session, id: number): Promise<Json> {
  return expectStatus(
    await api.get(`/platform/subscriptions/${id}`, { headers: bearer(superadmin.token) }),
    200,
    `GET /platform/subscriptions/${id}`,
  );
}

/** GET /store/subscription como o ADMIN da loja. */
export async function storeOverview(api: APIRequestContext, admin: Session): Promise<Json> {
  return expectStatus(await api.get('/store/subscription', { headers: bearer(admin.token) }), 200, 'GET /store/subscription');
}

export function postPlatform(
  api: APIRequestContext,
  superadmin: Session,
  path: string,
  data?: Record<string, unknown>,
): Promise<APIResponse> {
  return api.post(path, { headers: bearer(superadmin.token), ...(data === undefined ? {} : { data }) });
}

/** Ação do superpainel que precisa dar certo (devolve o corpo). */
export async function platformAction(
  api: APIRequestContext,
  superadmin: Session,
  path: string,
  data: Record<string, unknown> | undefined,
  status = 200,
): Promise<Json> {
  return expectStatus(await postPlatform(api, superadmin, path, data), status, `POST ${path}`);
}

/** Eventos do histórico de um tipo (opcionalmente só os de uma fatura). */
export function eventsOf(detail: Json, type: string, invoiceId?: number): Json[] {
  return ((detail.events ?? []) as Json[]).filter(
    (event) => event.type === type && (invoiceId === undefined || event.metadata?.invoice_id === invoiceId),
  );
}

/** Espera a rotina levar a assinatura a um estado (expect.poll; sem esperas fixas). */
export async function waitForSubscription(
  api: APIRequestContext,
  superadmin: Session,
  id: number,
  predicate: (detail: Json) => boolean,
  label: string,
  timeout = LIFECYCLE_TIMEOUT,
): Promise<Json> {
  let last: Json = null;
  await expect
    .poll(
      async () => {
        last = await subscriptionDetail(api, superadmin, id);
        return predicate(last);
      },
      { message: `${label} (rotina de assinaturas)`, timeout, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  return last;
}

// ---------------------------------------------------------------------------
// Cardápio, clientes e pedidos (vitrine por loja)
// ---------------------------------------------------------------------------

export async function addProduct(api: APIRequestContext, admin: Session, data: Record<string, unknown> = {}): Promise<Json> {
  return expectStatus(await postProduct(api, admin, data), 201, 'POST /products');
}

export function postProduct(api: APIRequestContext, admin: Session, data: Record<string, unknown> = {}): Promise<APIResponse> {
  return api.post('/products', {
    headers: bearer(admin.token),
    data: {
      name: `Lanche cobrança ${uid('bp')}`.slice(0, 60),
      description: 'Produto criado pela suíte de cobrança',
      price: 25,
      category: 'hamburgueres',
      available: true,
      ...data,
    },
  });
}

/** Cliente novo (cadastro público; conta global). */
export async function newCustomer(api: APIRequestContext): Promise<Member> {
  const email = uniqueEmail('bl-cliente');
  await expectStatus(
    await api.post('/users', { data: { name: 'Cliente Cobrança', email, password: PASSWORD, phone: '21988887777' } }),
    201,
    'cadastro de cliente',
  );
  return { ...(await login(api, email, PASSWORD)), email, password: PASSWORD };
}

/** Pedido de retirada (sem endereço): só depende do cardápio e da loja aberta. */
export const takeout = (productId: number) => ({ items: [{ productId, quantity: 1 }], type: 'TAKEOUT' });

export const storePath = (slug: string, path: string) => `/stores/${slug}${path}`;

/** POST /stores/<slug>/orders (pagamento na retirada): devolve a resposta crua. */
export function postOrder(api: APIRequestContext, slug: string, customer: Session, productId: number): Promise<APIResponse> {
  return api.post(storePath(slug, '/orders'), {
    headers: bearer(customer.token),
    data: { ...takeout(productId), paymentMethod: 'MONEY' },
  });
}

export function postPix(api: APIRequestContext, slug: string, customer: Session, productId: number): Promise<APIResponse> {
  return api.post(storePath(slug, '/payment/pix'), {
    headers: bearer(customer.token),
    data: { order: takeout(productId) },
  });
}

export function postCard(api: APIRequestContext, slug: string, customer: Session, productId: number): Promise<APIResponse> {
  return api.post(storePath(slug, '/payment/card'), {
    headers: bearer(customer.token),
    data: {
      order: takeout(productId),
      token: `tok-${uid('card')}`,
      paymentMethodId: 'master',
      installments: 1,
      docNumber: '12345678909',
      docType: 'CPF',
    },
  });
}

/** Cancela (como ADMIN da loja) um pedido criado pelo teste. */
export function cancelOrderLater(cleanup: Cleanup, admin: Session, orderId: number): void {
  cleanup.add(`cancelar pedido ${orderId}`, (api) => api.patch(`/orders/${orderId}/cancel`, { headers: bearer(admin.token) }));
}

// ---------------------------------------------------------------------------
// Banco de teste (cliente pg do e2e): SOMENTE o banco *_e2e desta execução
// ---------------------------------------------------------------------------

export interface PgClient {
  connect(): Promise<void>;
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
  end(): Promise<void>;
}

interface PgModule {
  Client: new (config: { host: string; port: number; user: string; password: string; database: string }) => PgClient;
}

/** Consulta no banco de teste (recusa qualquer banco que não termine em _e2e). */
export async function sql<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  const { host, port, user, password, database } = E2E.db;
  if (!/_e2e$/.test(database)) throw new Error(`Recusado: "${database}" não é um banco de teste (*_e2e).`);
  // pg não tem tipos no e2e (sem @types/pg): carregado com a interface mínima acima
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require('pg') as PgModule;
  const client = new pg.Client({ host, port, user, password, database });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Webhook da cobrança SaaS (POST /billing/webhook/mercadopago)
// ---------------------------------------------------------------------------

export const WEBHOOK_PATH = '/billing/webhook/mercadopago';

/**
 * x-signature do Mercado Pago: "ts=<ts>,v1=<HMAC-SHA256 hex>" do manifesto
 * "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" (data.id alfanumérico em minúsculas).
 */
export function mercadoPagoSignature(input: {
  dataId: string;
  requestId: string;
  ts?: number;
  secret?: string;
}): string {
  const ts = input.ts ?? Math.floor(Date.now() / 1000);
  const dataId = /^[A-Za-z0-9]+$/.test(input.dataId) ? input.dataId.toLowerCase() : input.dataId;
  const manifest = `id:${dataId};request-id:${input.requestId};ts:${ts};`;
  const v1 = createHmac('sha256', input.secret ?? E2E.saasWebhookSecret).update(manifest, 'utf8').digest('hex');
  return `ts=${ts},v1=${v1}`;
}

export interface WebhookDelivery {
  dataId: string;
  /** Id da notificação no corpo (o mesmo nas reentregas). */
  notificationId: string;
  topic?: string;
  action?: string;
  extraBody?: Record<string, unknown>;
}

/** Entrega uma notificação com assinatura válida (cada entrega tem ts e x-request-id próprios). */
export function deliverWebhook(
  api: APIRequestContext,
  delivery: WebhookDelivery,
  headers: Record<string, string> | 'signed' = 'signed',
): Promise<APIResponse> {
  const topic = delivery.topic ?? 'payment';
  const requestId = randomUUID();
  const signed =
    headers === 'signed'
      ? { 'x-signature': mercadoPagoSignature({ dataId: delivery.dataId, requestId }), 'x-request-id': requestId }
      : headers;
  return api.post(`${WEBHOOK_PATH}?data.id=${encodeURIComponent(delivery.dataId)}&type=${topic}`, {
    headers: signed,
    data: {
      id: delivery.notificationId,
      type: topic,
      action: delivery.action ?? `${topic}.updated`,
      live_mode: false,
      data: { id: delivery.dataId },
      ...delivery.extraBody,
    },
  });
}

export interface WebhookEventRow {
  id: number;
  provider: string;
  event_key: string;
  topic: string | null;
  resource_id: string | null;
  status: string;
  error: string | null;
  received_at: Date;
  processed_at: Date | null;
}

/** Notificações registradas (billing_webhook_events) de um recurso. */
export function webhookEvents(resourceId: string): Promise<WebhookEventRow[]> {
  return sql<WebhookEventRow>(
    `SELECT "id", "provider", "event_key", "topic", "resource_id", "status", "error", "received_at", "processed_at"
       FROM "billing_webhook_events" WHERE "resource_id" = $1 ORDER BY "id"`,
    [resourceId],
  );
}
