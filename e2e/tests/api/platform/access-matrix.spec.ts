/**
 * Matriz de acesso do superpainel (docs/saas/arquitetura.md §5.6 e §11.6; pedido §6, §11 e §16):
 * TODAS as rotas /platform/** — lidas de platform/*.controller.ts e billing/platform-billing.controller.ts —
 * exigem o token NORMAL do superadmin. Anônimo → 401; cliente, perfis da equipe (inclusive o ADMIN da
 * própria loja-alvo) e o token de uma sessão de suporte → 403; superadmin → 2xx.
 * Inclui a manutenção (common/maintenance.controller.ts: GET/POST /platform/maintenance/optimize-images e
 * cleanup-uploads, GET /platform/maintenance/store-credentials e POST .../store-credentials/reencrypt) e o
 * e-mail de teste (POST /platform/settings/test-email, com o driver de log da API de teste).
 *
 * As chamadas recusadas usam o MESMO caminho e corpo da chamada do superadmin, que vem depois: se
 * alguma recusa tivesse alterado algo (criado a loja, suspendido, revogado...), a chamada do
 * superadmin falharia (409/400/404). Nas ações que alteram algo, a auditoria (GET /platform/audit
 * por ação + target_type + target_id) traz o registro do superadmin — operador, loja, alvo, resultado
 * e metadados sem segredos — e só ele: nenhuma recusa executou a ação.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  MSG,
  auditPage,
  auditRecordsAfter,
  bearer,
  changeStoreStatus,
  cleanupPlatformData,
  expectAuditRecord,
  latestAuditId,
  linkToken,
  waitMaintenanceIdle,
  createPlan,
  createStore,
  defaultSessions,
  ensureStoreStatus,
  expectApiError,
  expectOk,
  newApi,
  newClientAccount,
  startSupportSession,
  endSupportSession,
  storeSlug,
  storeWithOwner,
  subscriptionDetail,
  trackPlan,
  trackStore,
  planCode,
  uid,
  uniqueEmail,
  type CreatedStore,
  type Json,
  type Session,
  type StoreWithOwner,
  type SupportSession,
  type TestAccount,
} from './helpers';
import { findSecretKeys } from '../identity/helpers';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface Probe {
  path: string;
  data?: unknown;
}

interface RouteCase {
  /** Método e rota como no controller (":id" no lugar do parâmetro). */
  name: string;
  /** Status de sucesso do superadmin. */
  status: number;
  /** Deixa o alvo no estado necessário (sem depender do teste anterior) e devolve caminho e corpo. */
  prepare: () => Promise<Probe>;
  /** Confere o efeito da chamada do superadmin. */
  verify?: (payload: Json, probe: Probe) => Promise<void> | void;
  /** Registro esperado na auditoria (ações que alteram algo). */
  audit?: (payload: Json, probe: Probe) => RouteAudit;
}

interface RouteAudit {
  action: string;
  targetType: string;
  targetId: number | string;
  /** Loja afetada (null: ação da plataforma sem loja). */
  storeId?: number | null;
  /** Valores que nunca podem aparecer no registro (tokens de link e de sessão). */
  secrets?: Array<string | null | undefined>;
}

interface DeniedActor {
  label: string;
  token: () => string | null;
  status: 401 | 403;
  message: string;
}

let api: APIRequestContext;
let sessions: Awaited<ReturnType<typeof defaultSessions>>;
let sa: Session;
let planFree: Json;
let planPaid: Json;
let planPaid2: Json;
/** Situação, edição, convites e equipe. */
let storeM: StoreWithOwner;
/** Só leitura: a sessão de suporte usada como ator recusado é desta loja. */
let storeS: CreatedStore;
/** Assinatura paga (troca de plano, cancelamento, suspensão, faturas). */
let storeB: CreatedStore;
/** Loja sem assinatura vigente (POST /platform/stores/:id/subscription). */
let storeC: CreatedStore;
let target: TestAccount;
let support: SupportSession;
let invoicePeriod = 0;
/** Última otimização de imagens antes da chamada do superadmin (a nova precisa ser outra). */
let previousJob: Json = null;
/** Última limpeza de arquivos antes da chamada do superadmin (a nova precisa ser outra). */
let previousCleanup: Json = null;
/** Registro mais recente da auditoria antes da regravação das credenciais (ação sem alvo). */
let reencryptAuditMarker = 0;

const CLEANUP_PATH = '/platform/maintenance/cleanup-uploads';
const CREDENTIALS_PATH = '/platform/maintenance/store-credentials';
const REENCRYPT_ACTION = 'platform.maintenance.reencrypt_credentials';

const methodOf = (name: string) => name.split(' ')[0] as Method;

/** Espera a limpeza de arquivos em andamento terminar (uma por vez em toda a plataforma) e devolve a última. */
async function waitCleanupIdle(): Promise<Json> {
  let job: Json = null;
  await expect
    .poll(
      async () => {
        job = (await expectOk(await api.get(CLEANUP_PATH, { headers: bearer(sa.token) }), 200, `GET ${CLEANUP_PATH}`)).job;
        return job?.status ?? 'NONE';
      },
      { message: 'limpeza de arquivos terminar', timeout: 60_000 },
    )
    .not.toBe('RUNNING');
  return job;
}

async function send(probe: Probe, method: Method, token: string | null) {
  return api.fetch(probe.path, {
    method,
    headers: token ? bearer(token) : {},
    ...(probe.data === undefined ? {} : { data: probe.data }),
  });
}

/** Período futuro e único por fatura avulsa (uma fatura válida por período da assinatura). */
function nextInvoicePeriod() {
  invoicePeriod += 1;
  const start = new Date(Date.UTC(2040 + invoicePeriod, 0, 1));
  const end = new Date(Date.UTC(2040 + invoicePeriod, 1, 1));
  return { period_start: start.toISOString(), period_end: end.toISOString(), due_at: start.toISOString() };
}

async function createInvoice(subscriptionId: number): Promise<Json> {
  const res = await api.post(`/platform/subscriptions/${subscriptionId}/invoices`, {
    headers: bearer(sa.token),
    data: { amount: 10, ...nextInvoicePeriod(), notes: 'Fatura avulsa da matriz de acesso' },
  });
  return expectOk(res, 201, 'POST /platform/subscriptions/:id/invoices (preparação)');
}

/** Assinatura da loja B ativa e sem cancelamento agendado. */
async function ensureSubscriptionActive(): Promise<Json> {
  let sub = await subscriptionDetail(api, sa.token, storeB.subscription.id);
  expect(sub.status, 'a assinatura da loja B nunca é cancelada pela matriz').not.toBe('CANCELED');
  if (sub.status === 'SUSPENDED' || sub.status === 'PAST_DUE') {
    await expectOk(
      await api.post(`/platform/subscriptions/${sub.id}/reactivate`, {
        headers: bearer(sa.token),
        data: { force: true, reason: 'Preparação da matriz de acesso' },
      }),
      200,
      'reativação (preparação)',
    );
  }
  sub = await subscriptionDetail(api, sa.token, storeB.subscription.id);
  if (sub.cancel_at_period_end) {
    await expectOk(
      await api.post(`/platform/subscriptions/${sub.id}/resume`, { headers: bearer(sa.token) }),
      200,
      'desistência do cancelamento (preparação)',
    );
    sub = await subscriptionDetail(api, sa.token, storeB.subscription.id);
  }
  return sub;
}

async function platformUser(id: number): Promise<Json> {
  return expectOk(await api.get(`/platform/users/${id}`, { headers: bearer(sa.token) }), 200, `GET /platform/users/${id}`);
}

const DENIED: DeniedActor[] = [
  { label: 'anônimo', token: () => null, status: 401, message: MSG.session },
  { label: 'CLIENT', token: () => sessions.client.token, status: 403, message: MSG.platformOnly },
  { label: 'ADMIN (loja demo)', token: () => sessions.admin.token, status: 403, message: MSG.platformOnly },
  { label: 'EMPLOYEE', token: () => sessions.employee.token, status: 403, message: MSG.platformOnly },
  { label: 'KITCHEN', token: () => sessions.kitchen.token, status: 403, message: MSG.platformOnly },
  { label: 'COURIER', token: () => sessions.courier.token, status: 403, message: MSG.platformOnly },
  { label: 'ADMIN da própria loja-alvo', token: () => storeM.owner.token, status: 403, message: MSG.platformOnly },
  { label: 'token de sessão de suporte', token: () => support.token, status: 403, message: MSG.platformOnly },
];

const ROUTES: RouteCase[] = [
  // --- Estabelecimentos -----------------------------------------------------------------------
  {
    name: 'GET /platform/stores',
    status: 200,
    prepare: async () => ({ path: `/platform/stores?search=${storeM.slug}` }),
    verify: (page) => {
      expect(page).toMatchObject({ page: 1, pageSize: 20 });
      expect(page.items.map((item: Json) => item.id)).toContain(storeM.id);
    },
  },
  {
    name: 'POST /platform/stores',
    status: 201,
    prepare: async () => {
      const slug = storeSlug('matriz');
      return {
        path: '/platform/stores',
        data: { name: `Matriz E2E ${slug}`, slug, plan_id: planFree.id, owner: { email: uniqueEmail('matriz-dono') } },
      };
    },
    verify: (created, probe) => {
      trackStore(created.store.id);
      expect(created.store.slug).toBe((probe.data as Json).slug);
      expect(created.subscription).toMatchObject({ store_id: created.store.id, plan_id: planFree.id, status: 'ACTIVE' });
      expect(String(created.invitation?.url ?? '')).toMatch(/\/convite\/[\w-]{32,}$/);
    },
    audit: (created) => ({
      action: 'platform.store.create',
      targetType: 'store',
      targetId: created.store.id,
      storeId: created.store.id,
      secrets: [linkToken(created.invitation.url)],
    }),
  },
  {
    name: 'GET /platform/stores/:id',
    status: 200,
    prepare: async () => ({ path: `/platform/stores/${storeM.id}` }),
    verify: (detail) => expect(detail).toMatchObject({ id: storeM.id, slug: storeM.slug }),
  },
  {
    name: 'PATCH /platform/stores/:id',
    status: 200,
    prepare: async () => ({ path: `/platform/stores/${storeM.id}`, data: { name: `Matriz editada ${uid('n')}` } }),
    verify: (detail, probe) => {
      expect(detail.name).toBe((probe.data as Json).name);
      expect(detail.warnings).toEqual([]);
    },
    audit: () => ({ action: 'platform.store.update', targetType: 'store', targetId: storeM.id, storeId: storeM.id }),
  },
  {
    name: 'POST /platform/stores/:id/suspend',
    status: 200,
    prepare: async () => {
      await ensureStoreStatus(api, sa.token, storeM.id, 'ACTIVE');
      return { path: `/platform/stores/${storeM.id}/suspend`, data: { reason: 'Matriz de acesso: suspensão' } };
    },
    verify: (detail) => expect(detail).toMatchObject({ account_status: 'SUSPENDED', status_reason: 'Matriz de acesso: suspensão' }),
    audit: () => ({ action: 'platform.store.suspend', targetType: 'store', targetId: storeM.id, storeId: storeM.id }),
  },
  {
    name: 'POST /platform/stores/:id/reactivate',
    status: 200,
    prepare: async () => {
      await ensureStoreStatus(api, sa.token, storeM.id, 'SUSPENDED');
      return { path: `/platform/stores/${storeM.id}/reactivate`, data: {} };
    },
    verify: (detail) => expect(detail).toMatchObject({ account_status: 'ACTIVE', status_reason: null }),
    audit: () => ({ action: 'platform.store.reactivate', targetType: 'store', targetId: storeM.id, storeId: storeM.id }),
  },
  // Desativar encerra as sessões da equipe da loja (token_version + 1): estas duas rotas usam a loja C
  // (sem equipe), para o token do ADMIN da loja M continuar valendo nas recusas das rotas seguintes
  {
    name: 'POST /platform/stores/:id/deactivate',
    status: 200,
    prepare: async () => {
      await ensureStoreStatus(api, sa.token, storeC.id, 'ACTIVE');
      return { path: `/platform/stores/${storeC.id}/deactivate`, data: { reason: 'Matriz de acesso: desativação' } };
    },
    verify: (detail) => expect(detail.account_status).toBe('INACTIVE'),
    audit: () => ({ action: 'platform.store.deactivate', targetType: 'store', targetId: storeC.id, storeId: storeC.id }),
  },
  {
    name: 'POST /platform/stores/:id/restore',
    status: 200,
    prepare: async () => {
      await ensureStoreStatus(api, sa.token, storeC.id, 'INACTIVE');
      return { path: `/platform/stores/${storeC.id}/restore`, data: {} };
    },
    verify: (detail) => expect(detail.account_status).toBe('ACTIVE'),
    audit: () => ({ action: 'platform.store.restore', targetType: 'store', targetId: storeC.id, storeId: storeC.id }),
  },
  {
    name: 'GET /platform/stores/:id/users',
    status: 200,
    prepare: async () => ({ path: `/platform/stores/${storeM.id}/users` }),
    verify: (page) => expect(page.items.map((user: Json) => user.id)).toContain(storeM.owner.user.id),
  },
  {
    name: 'GET /platform/stores/:id/metrics',
    status: 200,
    prepare: async () => ({ path: `/platform/stores/${storeM.id}/metrics` }),
    verify: (metrics) => expect(metrics.store).toMatchObject({ id: storeM.id }),
  },
  {
    name: 'GET /platform/stores/:id/audit',
    status: 200,
    prepare: async () => ({ path: `/platform/stores/${storeM.id}/audit` }),
    verify: (page) => {
      expect(page.total).toBeGreaterThan(0);
      for (const item of page.items) expect(item.store_id).toBe(storeM.id);
    },
  },
  {
    name: 'GET /platform/stores/:id/invitations',
    status: 200,
    prepare: async () => ({ path: `/platform/stores/${storeM.id}/invitations` }),
    verify: (page) => expect(Array.isArray(page.items)).toBe(true),
  },
  {
    name: 'POST /platform/stores/:id/invitations',
    status: 201,
    prepare: async () => {
      await ensureStoreStatus(api, sa.token, storeM.id, 'ACTIVE');
      return { path: `/platform/stores/${storeM.id}/invitations`, data: { email: uniqueEmail('matriz-convite'), role: 'EMPLOYEE' } };
    },
    verify: (created, probe) => {
      expect(created.invitation).toMatchObject({ store_id: storeM.id, email: (probe.data as Json).email, status: 'PENDING' });
      expect(String(created.url)).toMatch(/\/convite\/[\w-]{32,}$/);
    },
    audit: (created) => ({
      action: 'invitation.create',
      targetType: 'invitation',
      targetId: created.invitation.id,
      storeId: storeM.id,
      secrets: [linkToken(created.url)],
    }),
  },
  {
    name: 'DELETE /platform/invitations/:id',
    status: 200,
    prepare: async () => {
      await ensureStoreStatus(api, sa.token, storeM.id, 'ACTIVE');
      const created = await expectOk(
        await api.post(`/platform/stores/${storeM.id}/invitations`, {
          headers: bearer(sa.token),
          data: { email: uniqueEmail('matriz-revogar'), role: 'KITCHEN' },
        }),
        201,
        'convite (preparação)',
      );
      return { path: `/platform/invitations/${created.invitation.id}` };
    },
    verify: (invitation) => expect(invitation.status).toBe('REVOKED'),
    audit: (invitation) => ({ action: 'invitation.revoke', targetType: 'invitation', targetId: invitation.id, storeId: storeM.id }),
  },
  // --- Usuários e acessos ---------------------------------------------------------------------
  {
    name: 'GET /platform/users',
    status: 200,
    prepare: async () => ({ path: `/platform/users?search=${encodeURIComponent(target.email)}` }),
    verify: (page) => expect(page.items.map((user: Json) => user.id)).toEqual([target.user.id]),
  },
  {
    name: 'GET /platform/users/:id',
    status: 200,
    prepare: async () => ({ path: `/platform/users/${target.user.id}` }),
    verify: (user) => expect(user).toMatchObject({ id: target.user.id, email: target.email, role: 'CLIENT' }),
  },
  {
    name: 'POST /platform/users/:id/block',
    status: 200,
    prepare: async () => {
      if ((await platformUser(target.user.id)).blocked_at) {
        await expectOk(await api.post(`/platform/users/${target.user.id}/unblock`, { headers: bearer(sa.token) }), 200);
      }
      return { path: `/platform/users/${target.user.id}/block`, data: { reason: 'Matriz de acesso: bloqueio' } };
    },
    verify: (user) => expect(user.blocked_at).not.toBeNull(),
    audit: () => ({ action: 'user.block', targetType: 'user', targetId: target.user.id, storeId: null }),
  },
  {
    name: 'POST /platform/users/:id/unblock',
    status: 200,
    prepare: async () => {
      if (!(await platformUser(target.user.id)).blocked_at) {
        await expectOk(
          await api.post(`/platform/users/${target.user.id}/block`, { headers: bearer(sa.token), data: { reason: 'Preparação' } }),
          200,
        );
      }
      return { path: `/platform/users/${target.user.id}/unblock` };
    },
    verify: (user) => expect(user.blocked_at).toBeNull(),
    audit: () => ({ action: 'user.unblock', targetType: 'user', targetId: target.user.id, storeId: null }),
  },
  {
    name: 'POST /platform/users/:id/revoke-sessions',
    status: 200,
    prepare: async () => ({ path: `/platform/users/${target.user.id}/revoke-sessions` }),
    verify: (result) => expect(result.user.id).toBe(target.user.id),
    audit: () => ({ action: 'user.revoke_sessions', targetType: 'user', targetId: target.user.id, storeId: null }),
  },
  {
    name: 'POST /platform/users/:id/password-reset',
    status: 200,
    prepare: async () => ({ path: `/platform/users/${target.user.id}/password-reset` }),
    verify: (result) => expect(String(result.url)).toMatch(/\/redefinir-senha\/[\w-]{32,}$/),
    audit: (result) => ({
      action: 'user.password_reset_link',
      targetType: 'user',
      targetId: target.user.id,
      storeId: null,
      secrets: [linkToken(result.url)],
    }),
  },
  {
    name: 'GET /platform/auth-events',
    status: 200,
    prepare: async () => ({ path: `/platform/auth-events?user_id=${target.user.id}` }),
    verify: (page) => {
      for (const item of page.items) expect(item.action).toMatch(/^auth\./);
    },
  },
  // --- Sessões de suporte ---------------------------------------------------------------------
  {
    name: 'POST /platform/stores/:id/support-sessions',
    status: 201,
    prepare: async () => ({
      path: `/platform/stores/${storeS.id}/support-sessions`,
      data: { reason: 'Matriz de acesso: abrir uma sessão de suporte' },
    }),
    verify: async (started) => {
      expect(started.session).toMatchObject({ store_id: storeS.id, status: 'ACTIVE', platform_user_id: sa.user.id });
      await endSupportSession(api, sa.token, started.session.id);
    },
    audit: (started) => ({
      action: 'platform.support_session.start',
      targetType: 'support_session',
      targetId: started.session.id,
      storeId: storeS.id,
      secrets: [started.access_token],
    }),
  },
  {
    name: 'GET /platform/support-sessions',
    status: 200,
    prepare: async () => ({ path: `/platform/support-sessions?store_id=${storeS.id}` }),
    verify: (page) => {
      expect(page.items.map((session: Json) => session.id)).toContain(support.id);
      for (const session of page.items) expect(JSON.stringify(session)).not.toContain(support.token);
    },
  },
  {
    name: 'POST /platform/support-sessions/:id/end',
    status: 200,
    prepare: async () => {
      const started = await startSupportSession(api, sa.token, storeS.id, 'Matriz de acesso: sessão a encerrar');
      return { path: `/platform/support-sessions/${started.id}/end` };
    },
    verify: (session) => expect(session).toMatchObject({ status: 'ENDED', active: false }),
    audit: (session) => ({ action: 'platform.support_session.end', targetType: 'support_session', targetId: session.id, storeId: storeS.id }),
  },
  // --- Configurações, indicadores e auditoria -------------------------------------------------
  {
    name: 'GET /platform/settings',
    status: 200,
    prepare: async () => ({ path: '/platform/settings' }),
    verify: (settings) => expect(settings).toHaveProperty('support_session_minutes'),
  },
  {
    name: 'PATCH /platform/settings',
    status: 200,
    prepare: async () => {
      // Reenvia o valor atual: nada muda no estado global (a recusa dos demais é o que importa)
      const settings = await expectOk(await api.get('/platform/settings', { headers: bearer(sa.token) }), 200);
      return { path: '/platform/settings', data: { grace_period_days: settings.grace_period_days } };
    },
    verify: (settings, probe) => {
      expect(settings.grace_period_days).toBe((probe.data as Json).grace_period_days);
      expect(settings.warnings).toEqual([]);
    },
  },
  {
    // A API de teste usa o driver de log (playwright.config.ts): nada é enviado de verdade
    name: 'POST /platform/settings/test-email',
    status: 200,
    prepare: async () => ({ path: '/platform/settings/test-email', data: { to: uniqueEmail('matriz-email') } }),
    verify: (result, probe) =>
      expect(result).toMatchObject({ to: (probe.data as Json).to, driver: 'log', delivered: false, error: null }),
    audit: () => ({ action: 'platform.settings.test_email', targetType: 'platform_settings', targetId: 1, storeId: null }),
  },
  {
    name: 'GET /platform/dashboard',
    status: 200,
    prepare: async () => ({ path: '/platform/dashboard' }),
    verify: (dashboard) => expect(dashboard.stores.total).toBeGreaterThanOrEqual(5),
  },
  {
    name: 'GET /platform/finance',
    status: 200,
    prepare: async () => ({ path: '/platform/finance' }),
    verify: (finance) => expect(finance).toHaveProperty('platform_revenue'),
  },
  {
    name: 'GET /platform/audit',
    status: 200,
    prepare: async () => ({ path: `/platform/audit?target_type=store&target_id=${storeM.id}` }),
    verify: (page) => {
      expect(page.total).toBeGreaterThan(0);
      for (const item of page.items) expect(item).toMatchObject({ target_type: 'store', target_id: String(storeM.id) });
    },
  },
  // --- Planos -----------------------------------------------------------------------------------
  {
    name: 'GET /platform/plans',
    status: 200,
    prepare: async () => ({ path: `/platform/plans?search=${planFree.code}` }),
    verify: (page) => expect(page.items.map((plan: Json) => plan.id)).toContain(planFree.id),
  },
  {
    name: 'GET /platform/plans/:id',
    status: 200,
    prepare: async () => ({ path: `/platform/plans/${planFree.id}` }),
    verify: (plan) => expect(plan).toMatchObject({ id: planFree.id, code: planFree.code }),
  },
  {
    name: 'POST /platform/plans',
    status: 201,
    prepare: async () => {
      const code = planCode('matriz');
      return { path: '/platform/plans', data: { code, name: `Matriz ${code}`, price: 0, is_public: false } };
    },
    verify: (plan, probe) => {
      trackPlan(plan.id);
      expect(plan.code).toBe((probe.data as Json).code);
    },
    audit: (plan) => ({ action: 'plan.create', targetType: 'plan', targetId: plan.id, storeId: null }),
  },
  {
    name: 'PATCH /platform/plans/:id',
    status: 200,
    prepare: async () => ({ path: `/platform/plans/${planFree.id}`, data: { description: `Matriz ${uid('d')}` } }),
    verify: (plan, probe) => expect(plan.description).toBe((probe.data as Json).description),
    audit: () => ({ action: 'plan.update', targetType: 'plan', targetId: planFree.id, storeId: null }),
  },
  // --- Assinaturas e faturas ------------------------------------------------------------------
  {
    name: 'GET /platform/subscriptions',
    status: 200,
    prepare: async () => ({ path: `/platform/subscriptions?search=${storeB.slug}` }),
    verify: (page) => expect(page.items.map((sub: Json) => sub.id)).toContain(storeB.subscription.id),
  },
  {
    name: 'GET /platform/subscriptions/:id',
    status: 200,
    prepare: async () => ({ path: `/platform/subscriptions/${storeB.subscription.id}` }),
    verify: (sub) => expect(sub).toMatchObject({ id: storeB.subscription.id, store_id: storeB.id }),
  },
  {
    name: 'POST /platform/stores/:id/subscription',
    status: 201,
    prepare: async () => {
      const detail = await expectOk(await api.get(`/platform/stores/${storeC.id}`, { headers: bearer(sa.token) }), 200);
      if (detail.subscription && detail.subscription.status !== 'CANCELED') {
        await expectOk(
          await api.post(`/platform/subscriptions/${detail.subscription.id}/cancel`, {
            headers: bearer(sa.token),
            data: { reason: 'Preparação da matriz de acesso' },
          }),
          200,
          'cancelamento (preparação)',
        );
      }
      return { path: `/platform/stores/${storeC.id}/subscription`, data: { plan_id: planFree.id, reason: 'Matriz de acesso' } };
    },
    verify: (sub) => expect(sub).toMatchObject({ store_id: storeC.id, plan_id: planFree.id, status: 'ACTIVE' }),
    audit: (sub) => ({ action: 'subscription.create', targetType: 'subscription', targetId: sub.id, storeId: storeC.id }),
  },
  {
    name: 'POST /platform/subscriptions/:id/change-plan',
    status: 200,
    prepare: async () => {
      const sub = await ensureSubscriptionActive();
      const to = sub.plan_id === planPaid.id ? planPaid2.id : planPaid.id;
      return { path: `/platform/subscriptions/${sub.id}/change-plan`, data: { plan_id: to, reason: 'Matriz de acesso' } };
    },
    verify: (sub, probe) => expect(sub.plan_id).toBe((probe.data as Json).plan_id),
    audit: (sub) => ({ action: 'subscription.change_plan', targetType: 'subscription', targetId: sub.id, storeId: storeB.id }),
  },
  {
    name: 'POST /platform/subscriptions/:id/cancel',
    status: 200,
    prepare: async () => {
      const sub = await ensureSubscriptionActive();
      return { path: `/platform/subscriptions/${sub.id}/cancel`, data: { at_period_end: true, reason: 'Matriz de acesso' } };
    },
    verify: (sub) => expect(sub).toMatchObject({ cancel_at_period_end: true }),
    audit: (sub) => ({ action: 'subscription.cancel_scheduled', targetType: 'subscription', targetId: sub.id, storeId: storeB.id }),
  },
  {
    name: 'POST /platform/subscriptions/:id/resume',
    status: 200,
    prepare: async () => {
      const sub = await ensureSubscriptionActive();
      await expectOk(
        await api.post(`/platform/subscriptions/${sub.id}/cancel`, {
          headers: bearer(sa.token),
          data: { at_period_end: true, reason: 'Preparação da matriz de acesso' },
        }),
        200,
        'cancelamento agendado (preparação)',
      );
      return { path: `/platform/subscriptions/${sub.id}/resume` };
    },
    verify: (sub) => expect(sub.cancel_at_period_end).toBe(false),
    audit: (sub) => ({ action: 'subscription.resume', targetType: 'subscription', targetId: sub.id, storeId: storeB.id }),
  },
  {
    name: 'POST /platform/subscriptions/:id/reactivate',
    status: 200,
    prepare: async () => {
      const sub = await ensureSubscriptionActive();
      await expectOk(
        await api.post(`/platform/subscriptions/${sub.id}/suspend`, {
          headers: bearer(sa.token),
          data: { reason: 'Preparação da matriz de acesso' },
        }),
        200,
        'suspensão (preparação)',
      );
      return { path: `/platform/subscriptions/${sub.id}/reactivate`, data: { force: true, reason: 'Matriz de acesso' } };
    },
    verify: (sub) => expect(sub.status).toBe('ACTIVE'),
    audit: (sub) => ({ action: 'subscription.reactivate', targetType: 'subscription', targetId: sub.id, storeId: storeB.id }),
  },
  {
    name: 'POST /platform/subscriptions/:id/suspend',
    status: 200,
    prepare: async () => {
      const sub = await ensureSubscriptionActive();
      return { path: `/platform/subscriptions/${sub.id}/suspend`, data: { reason: 'Matriz de acesso: suspensão da assinatura' } };
    },
    verify: (sub) => expect(sub.status).toBe('SUSPENDED'),
    audit: (sub) => ({ action: 'subscription.suspend', targetType: 'subscription', targetId: sub.id, storeId: storeB.id }),
  },
  {
    name: 'POST /platform/subscriptions/:id/invoices',
    status: 201,
    prepare: async () => {
      const sub = await ensureSubscriptionActive();
      return { path: `/platform/subscriptions/${sub.id}/invoices`, data: { amount: 10, ...nextInvoicePeriod() } };
    },
    verify: (invoice) => expect(invoice).toMatchObject({ subscription_id: storeB.subscription.id, status: 'OPEN', amount: 10 }),
    audit: (invoice) => ({ action: 'subscription.invoice.create', targetType: 'subscription_invoice', targetId: invoice.id, storeId: storeB.id }),
  },
  {
    name: 'GET /platform/invoices',
    status: 200,
    prepare: async () => ({ path: `/platform/invoices?search=${storeB.slug}` }),
    verify: (page) => {
      expect(page.total).toBeGreaterThan(0);
      for (const invoice of page.items) expect(invoice.store_id).toBe(storeB.id);
    },
  },
  {
    name: 'POST /platform/invoices/:id/mark-paid',
    status: 200,
    prepare: async () => {
      const invoice = await createInvoice((await ensureSubscriptionActive()).id);
      return {
        path: `/platform/invoices/${invoice.id}/mark-paid`,
        data: { payment_method: 'PIX', provider_payment_id: `matriz-${uid('pg')}` },
      };
    },
    verify: (invoice) => expect(invoice.status).toBe('PAID'),
    audit: (invoice) => ({ action: 'subscription.invoice.mark_paid', targetType: 'subscription_invoice', targetId: invoice.id, storeId: storeB.id }),
  },
  {
    name: 'POST /platform/invoices/:id/mark-failed',
    status: 200,
    prepare: async () => {
      const invoice = await createInvoice((await ensureSubscriptionActive()).id);
      return { path: `/platform/invoices/${invoice.id}/mark-failed`, data: { reason: 'Matriz de acesso: cartão recusado' } };
    },
    verify: (invoice) => expect(invoice.status).toBe('FAILED'),
    audit: (invoice) => ({ action: 'subscription.invoice.mark_failed', targetType: 'subscription_invoice', targetId: invoice.id, storeId: storeB.id }),
  },
  {
    name: 'POST /platform/invoices/:id/void',
    status: 200,
    prepare: async () => {
      const invoice = await createInvoice((await ensureSubscriptionActive()).id);
      return { path: `/platform/invoices/${invoice.id}/void`, data: { reason: 'Matriz de acesso: anulação' } };
    },
    verify: (invoice) => expect(invoice.status).toBe('VOID'),
    audit: (invoice) => ({ action: 'subscription.invoice.void', targetType: 'subscription_invoice', targetId: invoice.id, storeId: storeB.id }),
  },
  // --- Manutenção (common/maintenance.controller.ts) ------------------------------------------
  {
    name: 'GET /platform/maintenance/optimize-images',
    status: 200,
    prepare: async () => ({ path: '/platform/maintenance/optimize-images' }),
    verify: (payload) => {
      expect(payload).toHaveProperty('job');
      if (payload.job !== null) expect(['RUNNING', 'SUCCEEDED', 'FAILED']).toContain(payload.job.status);
    },
  },
  {
    name: 'POST /platform/maintenance/optimize-images',
    status: 202,
    prepare: async () => {
      // Uma execução por vez em toda a plataforma: espera a anterior (de outro arquivo) terminar
      previousJob = await waitMaintenanceIdle(api, sa.token);
      return { path: '/platform/maintenance/optimize-images' };
    },
    verify: async (payload) => {
      expect(payload.job).toMatchObject({ started_by: { id: sa.user.id } });
      expect(payload.job.id).not.toBe(previousJob?.id);
      // Termina em segundo plano (não deixa a trava ocupada para os próximos arquivos)
      const finished = await waitMaintenanceIdle(api, sa.token);
      expect(finished).toMatchObject({ id: payload.job.id, status: 'SUCCEEDED' });
    },
    audit: (payload) => ({
      action: 'platform.maintenance.optimize_images',
      targetType: 'maintenance_job',
      targetId: payload.job.id,
      storeId: null,
    }),
  },
  {
    name: 'GET /platform/maintenance/cleanup-uploads',
    status: 200,
    prepare: async () => ({ path: CLEANUP_PATH }),
    verify: (payload) => {
      expect(Object.keys(payload)).toEqual(['job']);
      if (payload.job !== null) {
        expect(payload.job.kind).toBe('cleanup_uploads');
        expect(['RUNNING', 'SUCCEEDED', 'FAILED']).toContain(payload.job.status);
      }
    },
  },
  {
    name: 'POST /platform/maintenance/cleanup-uploads',
    status: 202,
    prepare: async () => {
      // Uma limpeza por vez (verificar e apagar dividem a trava): espera a anterior terminar.
      // Modo "check": só conta os arquivos sem uso, nada é apagado
      previousCleanup = await waitCleanupIdle();
      return { path: CLEANUP_PATH, data: { mode: 'check' } };
    },
    verify: async (payload) => {
      expect(payload.job).toMatchObject({ kind: 'cleanup_uploads', summary: { mode: 'check' }, started_by: { id: sa.user.id } });
      expect(payload.job.id).not.toBe(previousCleanup?.id);
      // Termina em segundo plano (não deixa a trava ocupada para os próximos arquivos)
      const finished = await waitCleanupIdle();
      expect(finished).toMatchObject({ id: payload.job.id, status: 'SUCCEEDED', summary: { mode: 'check', deleted: 0 } });
    },
    audit: (payload) => ({
      action: 'platform.maintenance.cleanup_uploads',
      targetType: 'maintenance_job',
      targetId: payload.job.id,
      storeId: null,
    }),
  },
  {
    name: 'GET /platform/maintenance/store-credentials',
    status: 200,
    prepare: async () => ({ path: CREDENTIALS_PATH }),
    verify: (status) => {
      expect(Object.keys(status).sort()).toEqual(['current', 'legacy', 'total', 'unknown']);
      expect(status.total).toBe(status.current + status.legacy + status.unknown);
    },
  },
  {
    // Ação da plataforma sem alvo (sem target_type/target_id): a auditoria é conferida aqui pelo marcador
    name: 'POST /platform/maintenance/store-credentials/reencrypt',
    status: 200,
    prepare: async () => {
      reencryptAuditMarker = await latestAuditId(api, sa.token);
      return { path: `${CREDENTIALS_PATH}/reencrypt` };
    },
    verify: async (result) => {
      expect(Object.keys(result).sort()).toEqual(['already_current', 'changed', 'failed', 'failed_store_ids', 'migrated', 'total']);
      // Só a chamada do superadmin foi registrada (nenhuma recusa executou a regravação), só com contagens
      const page = await auditPage(api, sa.token, { action: REENCRYPT_ACTION, pageSize: 100 });
      const records = (page.items as Json[]).filter((item) => item.action === REENCRYPT_ACTION && item.id > reencryptAuditMarker);
      expect(
        records.map((record) => ({ actor: record.actor?.id ?? null, result: record.result, store: record.store_id })),
        `${REENCRYPT_ACTION}: registros desde o início do teste`,
      ).toEqual([{ actor: sa.user.id, result: 'SUCCESS', store: null }]);
      expect(records[0].actor_scope).toBe('PLATFORM');
      expect(records[0].metadata).toEqual({
        total: result.total,
        migrated: result.migrated,
        already_current: result.already_current,
        changed: result.changed,
        failed: result.failed,
      });
    },
  },
];

test.beforeAll(async () => {
  api = await newApi();
  sessions = await defaultSessions(api);
  sa = sessions.superadmin;

  planFree = await createPlan(api, sa.token, { price: 0 });
  planPaid = await createPlan(api, sa.token, { price: 49.9 });
  planPaid2 = await createPlan(api, sa.token, { price: 99.9 });

  storeM = await storeWithOwner(api, sa.token, { planId: planFree.id });
  storeS = await createStore(api, sa.token, { planId: planFree.id });
  storeB = await createStore(api, sa.token, { planId: planPaid.id });
  storeC = await createStore(api, sa.token, { planId: planFree.id });
  target = await newClientAccount(api, 'Alvo da Matriz E2E');

  // A fatura do 1º período (vencimento = início) fica paga: a rotina de cobrança não mexe na assinatura
  const subscription = await subscriptionDetail(api, sa.token, storeB.subscription.id);
  for (const invoice of subscription.invoices as Json[]) {
    if (invoice.status === 'OPEN') {
      await expectOk(
        await api.post(`/platform/invoices/${invoice.id}/mark-paid`, {
          headers: bearer(sa.token),
          data: { payment_method: 'PIX', provider_payment_id: `matriz-inicial-${uid('pg')}` },
        }),
        200,
        'pagamento da 1ª fatura',
      );
    }
  }

  support = await startSupportSession(api, sa.token, storeS.id, 'Matriz de acesso: token de suporte como ator recusado');
});

test.afterAll(async () => {
  if (!api) return;
  try {
    if (support) await endSupportSession(api, sa.token, support.id);
    await cleanupPlatformData(api, sa.token);
  } finally {
    await api.dispose();
  }
});

test.describe('Superpainel: matriz de acesso de todas as rotas /platform/**', () => {
  for (const route of ROUTES) {
    test(`${route.name}: anônimo 401; CLIENT, ADMIN, EMPLOYEE, KITCHEN, COURIER e sessão de suporte 403; superadmin ${route.status}`, async () => {
      const method = methodOf(route.name);
      const probe = await route.prepare();
      const lastAuditId = route.audit ? await latestAuditId(api, sa.token) : 0;

      for (const actor of DENIED) {
        const res = await send(probe, method, actor.token());
        await expectApiError(res, actor.status, actor.message, `${route.name} como ${actor.label}`);
      }

      const res = await send(probe, method, sa.token);
      const payload = await expectOk(res, route.status, `${route.name} como superadmin`);
      expect(findSecretKeys(payload), `${route.name}: nenhuma senha ou hash na resposta`).toEqual([]);
      await route.verify?.(payload, probe);

      if (route.audit) {
        const expected = route.audit(payload, probe);
        await expectAuditRecord(api, sa.token, {
          ...expected,
          actorId: sa.user.id,
          actorScope: 'PLATFORM',
          result: 'SUCCESS',
        });
        // Só a chamada do superadmin foi registrada: nenhuma das recusas executou a ação
        const records = await auditRecordsAfter(api, sa.token, { ...expected, afterId: lastAuditId });
        expect(
          records.map((record: Json) => ({ actor: record.actor?.id ?? null, result: record.result })),
          `${route.name}: registros de ${expected.action} desde o início do teste`,
        ).toEqual([{ actor: sa.user.id, result: 'SUCCESS' }]);
      }
    });
  }

  test('a matriz cobre todas as rotas /platform/** documentadas pela API (inclusive a manutenção)', async () => {
    const res = await api.get('/api-json');
    test.skip(res.status() === 404, 'Swagger desligado neste ambiente (SWAGGER_ENABLED=false)');
    const doc = await expectOk(res, 200, 'GET /api-json');
    const documented = Object.entries(doc.paths as Record<string, Record<string, unknown>>)
      .filter(([path]) => path.startsWith('/platform/'))
      .flatMap(([path, operations]) =>
        Object.keys(operations).map((method) => `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`),
      )
      .sort();
    expect(ROUTES.map((route) => route.name).sort()).toEqual(documented);
  });

  test('a recusa não depende do formato: id inexistente ou inválido também dá 401/403 antes da validação', async () => {
    for (const path of ['/platform/stores/abc', `/platform/users/99999999999`, '/platform/subscriptions/0']) {
      await expectApiError(await api.get(path), 401, MSG.session, `GET ${path} anônimo`);
      await expectApiError(await api.get(path, { headers: bearer(sessions.admin.token) }), 403, MSG.platformOnly, `GET ${path} ADMIN`);
      await expectApiError(await api.get(path, { headers: bearer(support.token) }), 403, MSG.platformOnly, `GET ${path} suporte`);
      // O superadmin passa pela autorização e recebe a validação do id
      const res = await api.get(path, { headers: bearer(sa.token) });
      expect([400, 404], `GET ${path} superadmin: ${res.status()}`).toContain(res.status());
    }
  });
});
