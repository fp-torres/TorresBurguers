/**
 * Helpers da suíte api/platform (superadministrador e superpainel, docs/saas/arquitetura.md §5.6 e §11.6).
 * Usa os helpers compartilhados (support/*) e os de identidade sem alterá-los.
 *
 * Regras da suíte (o banco é único e a execução é serial):
 * - cada arquivo cria as PRÓPRIAS lojas, planos e contas (slugs, códigos e e-mails únicos);
 * - a loja demo e os usuários padrão nunca mudam de situação, plano ou bloqueio;
 * - configurações globais alteradas (loja padrão, autoatendimento, tolerância, sessão de suporte) voltam
 *   ao valor original em finally/afterAll (restoreSettings);
 * - no fim de cada arquivo, as lojas criadas são desativadas (saem da vitrine e dos alertas; nada é
 *   apagado) e os planos criados ficam indisponíveis (cleanupPlatformData).
 */
import { expect, request, type APIRequestContext, type APIResponse } from '@playwright/test';
import { E2E } from '../../../support/env';
import { DEFAULT_USERS, type DefaultUserKey } from '../../../support/users';
import { body, demoStore, login, uid, uniqueEmail, type Session } from '../../../support/api';
import {
  STRONG_PASSWORD,
  bearer,
  decodeJwt,
  expectContractErrorShape,
  findSecretKeys,
  messagesOf,
} from '../identity/helpers';

export { STRONG_PASSWORD, bearer, body, decodeJwt, uid, uniqueEmail };
export type { Session };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

/** Id válido para uma coluna integer, mas inexistente. */
export const MISSING_ID = 2_147_483_000;

/** Mensagens do contrato (conferidas literalmente). */
export const MSG = {
  session: 'Sessão inválida ou expirada. Faça login novamente.',
  platformOnly: 'Área exclusiva da administração da plataforma.',
  supportReadOnlyStore: 'Sessão de suporte é somente leitura: nenhuma alteração pode ser feita na loja.',
  supportReadOnly: 'Sessão de suporte é somente leitura: nenhuma alteração pode ser feita.',
  supportEnded: 'A sessão de suporte terminou ou expirou. Inicie outra pelo superpainel.',
  blockedAccount: 'Esta conta está bloqueada. Fale com o suporte da plataforma.',
  inactiveStoreLogin: 'Esta loja foi desativada na plataforma. Fale com o suporte.',
  storeNotFound: 'Loja não encontrada.',
  slugReserved: 'Este endereço (slug) é reservado pela plataforma. Escolha outro.',
  slugTaken: 'Este endereço (slug) já está em uso por outro estabelecimento. Escolha outro.',
  slugFormat:
    'Endereço da loja (slug) inválido: use de 3 a 60 caracteres com letras minúsculas, números e hífens, começando e terminando com letra ou número (ex.: lanchonete-do-bairro).',
  ownerEmailInUse:
    'Já existe uma conta com o e-mail do responsável. Use outro e-mail: a conta do responsável é criada quando ele aceita o convite.',
  ownerNotEligible:
    'O responsável precisa ser um administrador (ADMIN) ativo desta loja: fora da lixeira e não bloqueado.',
  reasonRequired: 'Informe o motivo (ele aparece para a equipe da loja e fica na auditoria).',
  targetTypeRequired: 'Informe o tipo do alvo (target_type) junto com target_id.',
  platformNoPurchase: 'Contas da administração da plataforma não fazem pedidos. Use uma conta de cliente.',
  signupUnavailable: 'Cadastro de estabelecimentos indisponível.',
} as const;

// ---------------------------------------------------------------------------
// Contextos e sessões
// ---------------------------------------------------------------------------

/** Contexto HTTP próprio (beforeAll/afterAll não têm o fixture `request`). Lembre de dispose(). */
export function newApi(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: E2E.apiURL });
}

/**
 * Login novo de um usuário padrão (sem cache entre arquivos): outra suíte pode ter encerrado as sessões
 * de uma conta padrão, e um token velho viraria 401 onde o teste espera 403.
 */
export function freshSession(api: APIRequestContext, key: DefaultUserKey): Promise<Session> {
  const user = DEFAULT_USERS[key];
  return login(api, user.email, user.password);
}

/** Id da loja demo (loja da equipe padrão e loja padrão das rotas antigas). */
export async function demoStoreId(_api?: APIRequestContext): Promise<number> {
  return (await demoStore()).id;
}

/** Sessões de todos os perfis da matriz (equipe da loja demo, cliente e superadmin). */
export async function defaultSessions(api: APIRequestContext): Promise<Record<DefaultUserKey, Session>> {
  const keys = Object.keys(DEFAULT_USERS) as DefaultUserKey[];
  const sessions = {} as Record<DefaultUserKey, Session>;
  for (const key of keys) sessions[key] = await freshSession(api, key);
  return sessions;
}

// ---------------------------------------------------------------------------
// Respostas
// ---------------------------------------------------------------------------

/** Confere o status (com o corpo na mensagem de falha) e devolve o JSON. */
export async function expectOk<T = Json>(res: APIResponse, status: number, label?: string): Promise<T> {
  const text = await res.text();
  expect(res.status(), `${label ?? res.url()} → ${res.status()} ${text.slice(0, 800)}`).toBe(status);
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

/** Erro no formato do contrato {statusCode, message, error}; a mensagem é conferida quando informada. */
export async function expectApiError(
  res: APIResponse,
  status: number,
  message?: RegExp | string,
  label?: string,
): Promise<Json> {
  const payload = await body(res);
  expect(res.status(), `${label ?? res.url()}: esperado ${status}, veio ${res.status()}: ${JSON.stringify(payload).slice(0, 600)}`).toBe(
    status,
  );
  expectContractErrorShape(payload, status);
  if (message !== undefined) {
    const joined = messagesOf(payload).join(' | ');
    if (typeof message === 'string') expect(joined, label).toContain(message);
    else expect(joined, label).toMatch(message);
  }
  return payload;
}

export const errorText = (payload: unknown): string => messagesOf(payload).join(' | ');

/** Chaves de senha/hash (identity) e de token/segredo com valor real (não removido pela auditoria). */
export function findSensitiveKeys(value: unknown, at = '$'): string[] {
  const found = findSecretKeys(value, at);
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) node.forEach((item, index) => walk(item, `${path}[${index}]`));
    else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (/token|secret|segredo|authorization|cookie|credential/i.test(key) && child !== '[removido]' && child !== null) {
          found.push(`${path}.${key}`);
        }
        walk(child, `${path}.${key}`);
      }
    }
  };
  walk(value, at);
  return found;
}

/** Nenhum dos valores secretos informados (tokens de link, senhas, Access Token) aparece no JSON. */
export function expectNoSecretValues(value: unknown, secrets: Array<string | null | undefined>, label: string): void {
  const json = JSON.stringify(value);
  for (const secret of secrets) {
    if (!secret) continue;
    expect(json.includes(secret), `${label}: um segredo (${secret.slice(0, 6)}…) apareceu na resposta`).toBe(false);
  }
}

/** Token do link (último segmento de /convite/<token> ou /redefinir-senha/<token>). */
export function linkToken(url: string): string {
  return String(url).split('/').pop() as string;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Texto aleatório só com letras minúsculas (buscas que não podem conter dígitos). */
export function letters(length = 10): string {
  return Array.from({ length }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
}

/** E-mail único sem dígitos (a busca de usuários também procura os dígitos do termo nos telefones). */
export function lettersEmail(prefix = 'plat'): string {
  return `${prefix}-${letters(12)}@e2e.test`;
}

/** Dia do calendário (AAAA-MM-DD) somado de `days` dias. */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Dados próprios: planos, lojas, responsáveis e clientes
// ---------------------------------------------------------------------------

const createdStores = new Set<number>();
const createdPlans = new Set<number>();

/** Código de plano único (minúsculas, números e hífens; até 40 caracteres). */
export function planCode(prefix = 'plat'): string {
  return uid(`${prefix}-plano`).toLowerCase().slice(0, 40).replace(/-+$/, '');
}

/** Slug de loja único (3 a 60 caracteres, minúsculas, números e hífens). */
export function storeSlug(prefix = 'plat'): string {
  return uid(`${prefix}-loja`).toLowerCase().slice(0, 60).replace(/-+$/, '');
}

export interface PlanInput {
  price?: number;
  trial_days?: number;
  is_public?: boolean;
  status?: 'ACTIVE' | 'INACTIVE';
  features?: Record<string, boolean>;
  [key: string]: unknown;
}

/** Plano próprio da suíte (privado e sem teste grátis, salvo se pedido). */
export async function createPlan(api: APIRequestContext, saToken: string, overrides: PlanInput = {}): Promise<Json> {
  const code = planCode();
  const res = await api.post('/platform/plans', {
    headers: bearer(saToken),
    data: {
      code,
      name: `Plano Plataforma E2E ${code}`.slice(0, 80),
      price: 0,
      billing_interval: 'MONTHLY',
      trial_days: 0,
      is_public: false,
      status: 'ACTIVE',
      features: { online_payments: false, advanced_reports: true, custom_branding: true },
      ...overrides,
    },
  });
  const plan = await expectOk(res, 201, 'POST /platform/plans');
  createdPlans.add(plan.id);
  return plan;
}

export interface CreatedStore {
  id: number;
  slug: string;
  name: string;
  ownerEmail: string;
  store: Json;
  subscription: Json;
  invitation: Json;
  warnings: string[];
}

/** Valida e cria uma loja pelo superpainel (fechada, entrega desligada) com o convite do responsável. */
export async function createStore(
  api: APIRequestContext,
  saToken: string,
  options: { planId: number; slug?: string; name?: string; ownerEmail?: string; extra?: Record<string, unknown> },
): Promise<CreatedStore> {
  const slug = options.slug ?? storeSlug();
  const ownerEmail = options.ownerEmail ?? uniqueEmail('plat-dono');
  const name = options.name ?? `Plataforma E2E ${slug}`.slice(0, 120);
  const res = await api.post('/platform/stores', {
    headers: bearer(saToken),
    data: { name, slug, plan_id: options.planId, owner: { email: ownerEmail, name: 'Responsável E2E' }, ...options.extra },
  });
  const created = await expectOk(res, 201, `POST /platform/stores (${slug})`);
  createdStores.add(created.store.id);
  return {
    id: created.store.id,
    slug: created.store.slug,
    name: created.store.name,
    ownerEmail,
    store: created.store,
    subscription: created.subscription,
    invitation: created.invitation,
    warnings: created.warnings,
  };
}

/** Registra uma loja criada por outro caminho (ex.: autoatendimento) para a limpeza do arquivo. */
export function trackStore(id: number): void {
  createdStores.add(id);
}

/** Registra um plano criado por outro caminho para a limpeza do arquivo. */
export function trackPlan(id: number): void {
  createdPlans.add(id);
}

export interface TestAccount extends Session {
  email: string;
  password: string;
}

/** Aceita o convite (link da resposta) e devolve a sessão da conta criada. */
export async function acceptInvitation(
  api: APIRequestContext,
  url: string,
  data: Record<string, unknown> = {},
): Promise<TestAccount> {
  const res = await api.post(`/invitations/${linkToken(url)}/accept`, {
    data: { name: 'Responsável E2E', password: STRONG_PASSWORD, ...data },
  });
  const accepted = await expectOk(res, 201, 'POST /invitations/:token/accept');
  return {
    token: accepted.access_token,
    user: accepted.user,
    email: accepted.user.email,
    password: String(data.password ?? STRONG_PASSWORD),
  };
}

export interface StoreWithOwner extends CreatedStore {
  owner: TestAccount;
}

/** Loja nova com o responsável (ADMIN) já cadastrado pelo convite. */
export async function storeWithOwner(
  api: APIRequestContext,
  saToken: string,
  options: { planId: number; slug?: string; name?: string; extra?: Record<string, unknown> },
): Promise<StoreWithOwner> {
  const created = await createStore(api, saToken, options);
  expect(created.invitation?.url, 'convite do responsável na criação da loja').toBeTruthy();
  const owner = await acceptInvitation(api, created.invitation.url, { name: 'Responsável E2E' });
  expect(owner.user).toMatchObject({ role: 'ADMIN', store_id: created.id, platform_role: null });
  return { ...created, owner };
}

/** Abre a loja (PATCH /store/status) com a sessão do ADMIN dela. */
export async function openStore(api: APIRequestContext, adminToken: string): Promise<void> {
  const res = await api.patch('/store/status', { headers: bearer(adminToken), data: { is_open: true } });
  await expectOk(res, 200, 'PATCH /store/status');
}

export async function createProductAs(
  api: APIRequestContext,
  adminToken: string,
  overrides: Record<string, unknown> = {},
): Promise<Json> {
  const res = await api.post('/products', {
    headers: bearer(adminToken),
    data: { name: `Produto Plataforma ${uid('p')}`.slice(0, 100), price: 25, category: 'hamburgueres', ...overrides },
  });
  return expectOk(res, 201, 'POST /products');
}

/** Cliente novo (cadastro público) já com login. */
export async function newClientAccount(
  api: APIRequestContext,
  name = 'Cliente Plataforma E2E',
  email = uniqueEmail('plat-cliente'),
  phone = '21988887777',
): Promise<TestAccount> {
  const res = await api.post('/users', { data: { name, email, password: STRONG_PASSWORD, phone } });
  await expectOk(res, 201, 'POST /users (cadastro de cliente)');
  const session = await login(api, email, STRONG_PASSWORD);
  return { ...session, email, password: STRONG_PASSWORD };
}

/** Pedido de retirada pago na retirada (MONEY) na vitrine da loja. */
export async function placeTakeoutOrder(
  api: APIRequestContext,
  clientToken: string,
  slug: string,
  items: Array<{ productId: number; quantity: number }>,
): Promise<Json> {
  const res = await api.post(`/stores/${slug}/orders`, {
    headers: bearer(clientToken),
    data: { items, type: 'TAKEOUT', paymentMethod: 'MONEY' },
  });
  return expectOk(res, 201, `POST /stores/${slug}/orders`);
}

/** Conclui o pedido (DONE): o pagamento na retirada passa a PAID. */
export async function completeOrder(api: APIRequestContext, adminToken: string, orderId: number): Promise<Json> {
  const res = await api.patch(`/orders/${orderId}`, { headers: bearer(adminToken), data: { status: 'DONE' } });
  const order = await expectOk(res, 200, `PATCH /orders/${orderId} (DONE)`);
  expect(order).toMatchObject({ status: 'DONE', payment_status: 'PAID' });
  return order;
}

/** CNPJ numérico válido e aleatório (dígitos verificadores calculados). */
export function validCnpj(): string {
  const base = Array.from({ length: 12 }, (_, index) => (index < 8 ? Math.floor(Math.random() * 10) : [0, 0, 0, 1][index - 8]));
  const digit = (values: number[], weights: number[]) => {
    const rest = values.reduce((sum, value, index) => sum + value * weights[index], 0) % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const first = digit(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = digit([...base, first], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return [...base, first, second].join('');
}

// ---------------------------------------------------------------------------
// Superpainel: loja, assinatura, sessões de suporte
// ---------------------------------------------------------------------------

export async function storeDetail(api: APIRequestContext, saToken: string, storeId: number): Promise<Json> {
  return expectOk(await api.get(`/platform/stores/${storeId}`, { headers: bearer(saToken) }), 200, `GET /platform/stores/${storeId}`);
}

export async function changeStoreStatus(
  api: APIRequestContext,
  saToken: string,
  storeId: number,
  action: 'suspend' | 'reactivate' | 'deactivate' | 'restore',
  reason?: string,
): Promise<Json> {
  const res = await api.post(`/platform/stores/${storeId}/${action}`, {
    headers: bearer(saToken),
    data: reason === undefined ? {} : { reason },
  });
  return expectOk(res, 200, `POST /platform/stores/${storeId}/${action}`);
}

/** Leva a loja à situação pedida pelas transições válidas (sem depender do teste anterior). */
export async function ensureStoreStatus(
  api: APIRequestContext,
  saToken: string,
  storeId: number,
  target: 'ACTIVE' | 'SUSPENDED' | 'INACTIVE',
): Promise<void> {
  const current = (await storeDetail(api, saToken, storeId)).account_status as string;
  if (current === target) return;
  if (current === 'INACTIVE') await changeStoreStatus(api, saToken, storeId, 'restore', 'Preparação do teste E2E');
  if (current === 'SUSPENDED' && target !== 'INACTIVE') await changeStoreStatus(api, saToken, storeId, 'reactivate');
  if (target === 'SUSPENDED') await changeStoreStatus(api, saToken, storeId, 'suspend', 'Preparação do teste E2E');
  if (target === 'INACTIVE') await changeStoreStatus(api, saToken, storeId, 'deactivate', 'Preparação do teste E2E');
}

export async function subscriptionDetail(api: APIRequestContext, saToken: string, subscriptionId: number): Promise<Json> {
  return expectOk(
    await api.get(`/platform/subscriptions/${subscriptionId}`, { headers: bearer(saToken) }),
    200,
    `GET /platform/subscriptions/${subscriptionId}`,
  );
}

export interface SupportSession {
  token: string;
  id: number;
  expiresAt: string;
  session: Json;
}

export async function startSupportSession(
  api: APIRequestContext,
  saToken: string,
  storeId: number,
  reason = 'Chamado E2E: conferir a configuração da loja com o responsável.',
): Promise<SupportSession> {
  const res = await api.post(`/platform/stores/${storeId}/support-sessions`, { headers: bearer(saToken), data: { reason } });
  const started = await expectOk(res, 201, 'POST /platform/stores/:id/support-sessions');
  return { token: started.access_token, id: started.session.id, expiresAt: started.expires_at, session: started.session };
}

export async function endSupportSession(api: APIRequestContext, saToken: string, sessionId: number): Promise<Json> {
  const res = await api.post(`/platform/support-sessions/${sessionId}/end`, { headers: bearer(saToken) });
  return expectOk(res, 200, `POST /platform/support-sessions/${sessionId}/end`);
}

/**
 * Espera a otimização de imagens (uma execução por vez em toda a plataforma) não estar em andamento e
 * devolve a última execução (null se nunca rodou).
 */
export async function waitMaintenanceIdle(api: APIRequestContext, saToken: string): Promise<Json> {
  let job: Json = null;
  await expect
    .poll(
      async () => {
        const res = await api.get('/platform/maintenance/optimize-images', { headers: bearer(saToken) });
        job = (await expectOk(res, 200, 'GET /platform/maintenance/optimize-images')).job;
        return job?.status ?? 'NONE';
      },
      { message: 'otimização de imagens terminar', timeout: 60_000 },
    )
    .not.toBe('RUNNING');
  return job;
}

// ---------------------------------------------------------------------------
// Configurações da plataforma (estado global: sempre restaurar)
// ---------------------------------------------------------------------------

export const SETTINGS_KEYS = [
  'default_store_id',
  'grace_period_days',
  'support_session_minutes',
  'store_self_signup_enabled',
  'self_signup_plan_id',
] as const;

export type SettingsSnapshot = Record<(typeof SETTINGS_KEYS)[number], Json>;

export async function getSettings(api: APIRequestContext, saToken: string): Promise<Json> {
  return expectOk(await api.get('/platform/settings', { headers: bearer(saToken) }), 200, 'GET /platform/settings');
}

export async function settingsSnapshot(api: APIRequestContext, saToken: string): Promise<SettingsSnapshot> {
  const settings = await getSettings(api, saToken);
  return Object.fromEntries(SETTINGS_KEYS.map((key) => [key, settings[key]])) as SettingsSnapshot;
}

/** Devolve as configurações ao retrato (uma única gravação; só o que mudou é aplicado) e confere. */
export async function restoreSettings(api: APIRequestContext, saToken: string, snapshot: SettingsSnapshot): Promise<void> {
  const res = await api.patch('/platform/settings', { headers: bearer(saToken), data: { ...snapshot } });
  await expectOk(res, 200, 'PATCH /platform/settings (restauração)');
  const after = await settingsSnapshot(api, saToken);
  expect(after, 'configurações da plataforma restauradas').toEqual(snapshot);
}

// ---------------------------------------------------------------------------
// Auditoria
// ---------------------------------------------------------------------------

export async function auditPage(
  api: APIRequestContext,
  saToken: string,
  params: Record<string, string | number | boolean>,
): Promise<Json> {
  const res = await api.get('/platform/audit', { headers: bearer(saToken), params });
  return expectOk(res, 200, `GET /platform/audit?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`);
}

export interface AuditCriteria {
  action: string;
  targetType: string;
  targetId: string | number;
  storeId?: number | null;
  actorId?: number | null;
  actorScope?: string;
  result?: 'SUCCESS' | 'FAILURE' | 'DENIED';
  /** Valores que nunca podem aparecer no registro (tokens de link, senhas, Access Token...). */
  secrets?: Array<string | null | undefined>;
}

/**
 * Registro da auditoria de uma ação (filtro exato por action + target_type + target_id): confere ator,
 * loja, alvo, resultado e metadados sem segredos. Devolve o mais recente.
 */
export async function expectAuditRecord(api: APIRequestContext, saToken: string, criteria: AuditCriteria): Promise<Json> {
  let record: Json = null;
  await expect
    .poll(
      async () => {
        const page = await auditPage(api, saToken, {
          action: criteria.action,
          target_type: criteria.targetType,
          target_id: String(criteria.targetId),
          pageSize: 100,
        });
        record =
          page.items.find(
            (item: Json) =>
              item.action === criteria.action &&
              (criteria.result === undefined || item.result === criteria.result) &&
              (criteria.storeId === undefined || item.store_id === criteria.storeId),
          ) ?? null;
        return record !== null;
      },
      { message: `auditoria ${criteria.action} em ${criteria.targetType}#${criteria.targetId}`, timeout: 10_000 },
    )
    .toBe(true);

  expect(record, `registro ${criteria.action}`).toMatchObject({
    action: criteria.action,
    result: criteria.result ?? 'SUCCESS',
    target_type: criteria.targetType,
    target_id: String(criteria.targetId),
  });
  if (criteria.storeId !== undefined) {
    expect(record.store_id, `${criteria.action}: loja afetada`).toBe(criteria.storeId);
    if (criteria.storeId !== null) expect(record.store, `${criteria.action}: resumo da loja`).toMatchObject({ id: criteria.storeId });
  }
  if (criteria.actorId !== undefined) {
    expect(record.actor?.id ?? null, `${criteria.action}: operador`).toBe(criteria.actorId);
    if (criteria.actorId !== null) {
      expect(typeof record.actor.email, `${criteria.action}: e-mail do operador`).toBe('string');
    }
  }
  if (criteria.actorScope) expect(record.actor_scope, `${criteria.action}: escopo`).toBe(criteria.actorScope);
  expect(Number.isNaN(new Date(record.created_at).getTime()), `${criteria.action}: data e hora`).toBe(false);
  expectAuditClean(record, criteria.secrets ?? [], criteria.action);
  return record;
}

/**
 * Id do registro mais recente da auditoria (0 se vazia). Marca "a partir daqui" sem depender do relógio
 * do processo de teste: o created_at vem do relógio do PostgreSQL, que pode estar alguns ms adiantado.
 */
export async function latestAuditId(api: APIRequestContext, saToken: string): Promise<number> {
  const page = await auditPage(api, saToken, { pageSize: 1 });
  return page.items[0]?.id ?? 0;
}

/** Registros de uma ação (nome exato) em um alvo gravados depois do registro `afterId`. */
export async function auditRecordsAfter(
  api: APIRequestContext,
  saToken: string,
  criteria: { action: string; targetType: string; targetId: string | number; afterId: number },
): Promise<Json[]> {
  const page = await auditPage(api, saToken, {
    action: criteria.action,
    target_type: criteria.targetType,
    target_id: String(criteria.targetId),
    pageSize: 100,
  });
  return (page.items as Json[]).filter((item) => item.action === criteria.action && item.id > criteria.afterId);
}

/** Metadados sem senhas, hashes, tokens ou segredos (chaves sensíveis só como "[removido]"). */
export function expectAuditClean(record: Json, secrets: Array<string | null | undefined>, label: string): void {
  expect(findSensitiveKeys(record), `${label}: chaves sensíveis no registro da auditoria`).toEqual([]);
  expectNoSecretValues(record, secrets, `${label} (auditoria)`);
}

// ---------------------------------------------------------------------------
// Limpeza do arquivo
// ---------------------------------------------------------------------------

/**
 * Lojas criadas pelo arquivo → desativadas (saem da vitrine, do diretório e dos alertas; nada é
 * apagado). Planos criados → indisponíveis para novas contratações. Sessões de suporte abertas → encerradas.
 */
export async function cleanupPlatformData(api: APIRequestContext, saToken: string): Promise<void> {
  const active = await expectOk(
    await api.get('/platform/support-sessions', { headers: bearer(saToken), params: { active: true, pageSize: 100 } }),
    200,
    'GET /platform/support-sessions?active=true',
  );
  for (const session of active.items as Json[]) {
    if (createdStores.has(session.store_id)) {
      await api.post(`/platform/support-sessions/${session.id}/end`, { headers: bearer(saToken) });
    }
  }
  for (const id of createdStores) {
    const res = await api.get(`/platform/stores/${id}`, { headers: bearer(saToken) });
    if (res.status() !== 200) continue;
    const detail = await res.json();
    if (detail.account_status !== 'INACTIVE') {
      await api.post(`/platform/stores/${id}/deactivate`, {
        headers: bearer(saToken),
        data: { reason: 'Limpeza da suíte E2E da plataforma (dados preservados).' },
      });
    }
  }
  createdStores.clear();
  for (const id of createdPlans) {
    await api.patch(`/platform/plans/${id}`, { headers: bearer(saToken), data: { status: 'INACTIVE', is_public: false } });
  }
  createdPlans.clear();
}

/** Atalho: login do superadmin + limpeza, para o afterAll de cada arquivo. */
export async function cleanupWithFreshSuperadmin(): Promise<void> {
  const api = await newApi();
  try {
    const superadmin = await freshSession(api, 'superadmin');
    await cleanupPlatformData(api, superadmin.token);
  } finally {
    await api.dispose();
  }
}

/** Payload do JWT (sem conferir a assinatura): só para ler as claims. */
export function jwtClaims(token: string): Record<string, Json> {
  return decodeJwt(token).payload;
}
