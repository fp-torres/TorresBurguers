/**
 * Configurações da plataforma (GET/PATCH /platform/settings; arquitetura §2, §9 e §11.6): loja padrão das
 * rotas antigas, autoatendimento de lojas e o plano dele, tolerância da inadimplência e duração das
 * sessões de suporte. Estado GLOBAL: cada teste tira um retrato antes e o restaura no finally.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { E2E } from '../../../support/env';
import {
  MISSING_ID,
  STRONG_PASSWORD,
  auditPage,
  bearer,
  changeStoreStatus,
  cleanupPlatformData,
  createPlan,
  createStore,
  endSupportSession,
  expectApiError,
  expectAuditRecord,
  expectOk,
  freshSession,
  getSettings,
  jwtClaims,
  newApi,
  restoreSettings,
  settingsSnapshot,
  startSupportSession,
  storeSlug,
  trackStore,
  uniqueEmail,
  type Json,
  type Session,
  type SettingsSnapshot,
} from './helpers';
import { findSecretKeys } from '../identity/helpers';

let api: APIRequestContext;
let sa: Session;
let plan: Json;
let original: SettingsSnapshot;

test.beforeAll(async () => {
  api = await newApi();
  sa = await freshSession(api, 'superadmin');
  original = await settingsSnapshot(api, sa.token);
  plan = await createPlan(api, sa.token, { price: 0 });
});

test.afterAll(async () => {
  if (!api) return;
  try {
    // Rede de segurança: mesmo que um teste quebre no meio, a plataforma volta ao estado inicial
    await restoreSettings(api, sa.token, original);
    await cleanupPlatformData(api, sa.token);
  } finally {
    await api.dispose();
  }
});

const patchSettings = (data: Record<string, unknown>) => api.patch('/platform/settings', { headers: bearer(sa.token), data });

test.describe('GET /platform/settings', () => {
  test('mostra os valores, a loja padrão configurada e a efetiva (DEFAULT_STORE_SLUG tem prioridade) e as faixas aceitas', async () => {
    const settings = await getSettings(api, sa.token);
    expect(settings).toMatchObject({
      limits: { grace_period_days: { min: 0, max: 60 }, support_session_minutes: { min: 5, max: 240 } },
    });
    expect(typeof settings.grace_period_days).toBe('number');
    expect(typeof settings.support_session_minutes).toBe('number');
    expect(typeof settings.store_self_signup_enabled).toBe('boolean');
    expect(settings.self_signup_available).toBe(
      settings.store_self_signup_enabled === true &&
        settings.self_signup_plan?.status === 'ACTIVE' &&
        settings.self_signup_plan?.is_public === true,
    );
    if (settings.default_store_env_override) {
      expect(settings.default_store_env_override).toBe(E2E.demoStoreSlug);
      expect(settings.effective_default_store).toMatchObject({ slug: E2E.demoStoreSlug });
    }
    // A loja padrão efetiva é a das rotas antigas
    const legacy = await expectOk(await api.get('/stores/default'), 200, 'GET /stores/default');
    expect(legacy.slug).toBe(settings.effective_default_store.slug);
    expect(findSecretKeys(settings)).toEqual([]);
    await expectApiError(await patchSettings({ updated_by_user_id: sa.user.id }), 400, 'property updated_by_user_id should not exist');
  });
});

test.describe('Loja padrão das rotas antigas (default_store_id)', () => {
  test('trocar grava e audita; as rotas antigas seguem a loja efetiva (aviso quando DEFAULT_STORE_SLUG manda); loja inexistente ou desativada → 400', async () => {
    const snapshot = await settingsSnapshot(api, sa.token);
    const candidate = await createStore(api, sa.token, { planId: plan.id });
    const inactive = await createStore(api, sa.token, { planId: plan.id });
    await changeStoreStatus(api, sa.token, inactive.id, 'deactivate', 'Loja desativada para o teste da loja padrão');
    try {
      await expectApiError(await patchSettings({ default_store_id: MISSING_ID }), 400, 'Loja padrão não encontrada: escolha um estabelecimento existente.');
      await expectApiError(
        await patchSettings({ default_store_id: inactive.id }),
        400,
        'A loja padrão não pode estar desativada. Restaure a loja ou escolha outra.',
      );
      await expectApiError(await patchSettings({ default_store_id: 'demo' }), 400, 'default_store_id deve ser um id válido (número inteiro positivo).');

      const updated = await expectOk(await patchSettings({ default_store_id: candidate.id }), 200, 'troca da loja padrão');
      expect(updated).toMatchObject({ default_store_id: candidate.id, default_store: { id: candidate.id, slug: candidate.slug } });
      expect(updated.updated_by).toMatchObject({ id: sa.user.id });
      const audit = await expectAuditRecord(api, sa.token, {
        action: 'platform.settings.update',
        targetType: 'platform_settings',
        targetId: 1,
        storeId: null,
        actorId: sa.user.id,
        actorScope: 'PLATFORM',
      });
      expect(audit.metadata.changes.default_store_id).toEqual({ from: snapshot.default_store_id, to: candidate.id });

      if (updated.default_store_env_override) {
        // Ambiente de teste: DEFAULT_STORE_SLUG manda — a troca fica gravada, com aviso, e as rotas antigas não mudam
        expect(updated.effective_default_store).toMatchObject({ slug: updated.default_store_env_override });
        expect(updated.warnings).toEqual([
          `DEFAULT_STORE_SLUG está definido no ambiente ("${updated.default_store_env_override}") e tem prioridade: a loja padrão das rotas antigas continua sendo a do ambiente.`,
        ]);
        expect((await expectOk(await api.get('/stores/default'), 200)).slug).toBe(updated.default_store_env_override);
        expect((await expectOk(await api.get('/store/status'), 200)).id).not.toBe(candidate.id);
        expect((await expectOk(await api.get(`/platform/stores/${candidate.id}`, { headers: bearer(sa.token) }), 200)).is_default_store).toBe(false);
      } else {
        // Sem DEFAULT_STORE_SLUG: as rotas antigas passam a usar a loja escolhida
        expect(updated.effective_default_store).toMatchObject({ id: candidate.id });
        expect(updated.warnings).toEqual([]);
        expect((await expectOk(await api.get('/stores/default'), 200)).slug).toBe(candidate.slug);
        expect((await expectOk(await api.get('/store/status'), 200)).id).toBe(candidate.id);
        expect((await expectOk(await api.get(`/platform/stores/${candidate.id}`, { headers: bearer(sa.token) }), 200)).is_default_store).toBe(true);
      }

      // null = nenhuma loja configurada (sem o ambiente, as rotas antigas responderiam 404)
      const cleared = await expectOk(await patchSettings({ default_store_id: null }), 200, 'sem loja padrão');
      expect(cleared).toMatchObject({ default_store_id: null, default_store: null });
      expect(cleared.warnings).toHaveLength(1);
      if (!cleared.default_store_env_override) {
        expect(cleared.warnings[0]).toMatch(/Sem loja padrão, as rotas antigas/);
        await expectApiError(await api.get('/store/status'), 404);
      }
    } finally {
      await restoreSettings(api, sa.token, snapshot);
    }
    // Restaurado: a loja padrão volta a ser a original e as rotas antigas a enxergam
    const restored = await getSettings(api, sa.token);
    expect(restored.default_store_id).toBe(snapshot.default_store_id);
    expect((await expectOk(await api.get('/stores/default'), 200)).slug).toBe(restored.effective_default_store.slug);
  });
});

test.describe('Autoatendimento de lojas (store_self_signup_enabled + self_signup_plan_id)', () => {
  test('desligado → POST /stores/signup 404; ligar exige plano ACTIVE e público; ligado cria loja, assinatura e responsável; desligar volta a recusar', async () => {
    const snapshot = await settingsSnapshot(api, sa.token);
    const publicPlan = await createPlan(api, sa.token, { price: 0, is_public: true });
    const privatePlan = await createPlan(api, sa.token, { price: 0, is_public: false });
    const inactivePublic = await createPlan(api, sa.token, { price: 0, is_public: true, status: 'INACTIVE' });
    const slug = storeSlug('auto');
    const email = uniqueEmail('plat-auto');
    const signup = (overrides: Record<string, unknown> = {}) =>
      api.post('/stores/signup', {
        data: {
          store: { name: `Autoatendimento ${slug}`, slug },
          owner: { name: 'Dona do Autoatendimento', email, password: STRONG_PASSWORD, phone: '21966665555' },
          accept_terms: true,
          ...overrides,
        },
      });

    try {
      await expectOk(await patchSettings({ store_self_signup_enabled: false }), 200);
      await expectApiError(await signup(), 404, 'Cadastro de estabelecimentos indisponível.');

      await expectApiError(
        await patchSettings({ store_self_signup_enabled: true, self_signup_plan_id: null }),
        400,
        'Escolha o plano do autoatendimento (self_signup_plan_id) para habilitar o cadastro de estabelecimentos.',
      );
      for (const unavailable of [privatePlan.id, inactivePublic.id]) {
        await expectApiError(
          await patchSettings({ store_self_signup_enabled: true, self_signup_plan_id: unavailable }),
          400,
          'O plano do autoatendimento precisa estar disponível para contratação (ACTIVE) e público.',
        );
      }
      await expectApiError(
        await patchSettings({ store_self_signup_enabled: true, self_signup_plan_id: MISSING_ID }),
        400,
        'Plano do autoatendimento não encontrado.',
      );
      await expectApiError(await signup(), 404, 'Cadastro de estabelecimentos indisponível.');

      const enabled = await expectOk(
        await patchSettings({ store_self_signup_enabled: true, self_signup_plan_id: publicPlan.id }),
        200,
        'liga o autoatendimento',
      );
      expect(enabled).toMatchObject({
        store_self_signup_enabled: true,
        self_signup_plan_id: publicPlan.id,
        self_signup_available: true,
        self_signup_plan: { id: publicPlan.id, code: publicPlan.code, status: 'ACTIVE', is_public: true },
      });

      await expectApiError(await signup({ accept_terms: false }), 400, 'É preciso aceitar os termos de uso para cadastrar o estabelecimento.');
      // Loja ou responsável em lista (inclusive vazia) → 400, nunca 500; nada é criado
      for (const overrides of [
        { owner: [] },
        { owner: [{ name: 'Lista', email: uniqueEmail('plat-lista'), password: STRONG_PASSWORD }] },
        { store: [] },
        { store: [{ name: 'Lista', slug: storeSlug('lista') }] },
      ]) {
        const res = await signup(overrides);
        expect(res.status(), `lista no cadastro: ${JSON.stringify(overrides)}`).toBe(400);
      }
      const created = await expectOk(await signup(), 201, 'POST /stores/signup');
      expect(Object.keys(created).sort()).toEqual(['access_token', 'user']);
      expect(created.user).toMatchObject({ email, role: 'ADMIN', platform_role: null, store: { slug, account_status: 'ACTIVE' } });
      trackStore(created.user.store_id);
      expect(findSecretKeys(created)).toEqual([]);

      const detail = await expectOk(await api.get(`/platform/stores/${created.user.store_id}`, { headers: bearer(sa.token) }), 200);
      expect(detail).toMatchObject({
        slug,
        account_status: 'ACTIVE',
        is_open: false,
        delivery_enabled: false,
        owner_user_id: created.user.id,
        owner: { id: created.user.id, eligible: true },
        subscription: { status: 'ACTIVE', plan: { id: publicPlan.id } },
      });
      const audit = await expectAuditRecord(api, sa.token, {
        action: 'platform.store.self_signup',
        targetType: 'store',
        targetId: created.user.store_id,
        storeId: created.user.store_id,
        actorId: created.user.id,
        actorScope: 'STORE',
        secrets: [STRONG_PASSWORD, created.access_token],
      });
      expect(audit.metadata).toMatchObject({ slug, plan_id: publicPlan.id, terms_accepted: true });

      // Repetir o endereço ou o e-mail → 409
      await expectApiError(await signup(), 409, 'Este endereço (slug) já está em uso por outro estabelecimento. Escolha outro.');
      await expectApiError(
        await signup({ store: { name: 'Outra', slug: storeSlug('auto2') } }),
        409,
        'Já existe uma conta com este e-mail.',
      );

      // O plano deixou de ser vendável: o cadastro para, mesmo com o autoatendimento ligado
      await expectOk(await api.patch(`/platform/plans/${publicPlan.id}`, { headers: bearer(sa.token), data: { is_public: false } }), 200);
      expect((await getSettings(api, sa.token)).self_signup_available).toBe(false);
      await expectApiError(
        await signup({ store: { name: 'Sem plano', slug: storeSlug('auto3') }, owner: { name: 'X', email: uniqueEmail('plat-auto3'), password: STRONG_PASSWORD } }),
        404,
        'Cadastro de estabelecimentos indisponível.',
      );
      await expectOk(await api.patch(`/platform/plans/${publicPlan.id}`, { headers: bearer(sa.token), data: { is_public: true } }), 200);

      const disabled = await expectOk(await patchSettings({ store_self_signup_enabled: false }), 200, 'desliga o autoatendimento');
      expect(disabled.self_signup_available).toBe(false);
      await expectApiError(
        await signup({ store: { name: 'Desligado', slug: storeSlug('auto4') }, owner: { name: 'Y', email: uniqueEmail('plat-auto4'), password: STRONG_PASSWORD } }),
        404,
        'Cadastro de estabelecimentos indisponível.',
      );
    } finally {
      await restoreSettings(api, sa.token, snapshot);
    }
  });
});

test.describe('Tolerância da inadimplência e duração da sessão de suporte', () => {
  test('faixas validadas (0-60 dias, 5-240 min); a duração vale para as próximas sessões; sem mudança não há auditoria', async () => {
    const snapshot = await settingsSnapshot(api, sa.token);
    const store = await createStore(api, sa.token, { planId: plan.id });
    try {
      for (const value of [61, -1, 2.5, null, 'sete']) {
        await expectApiError(
          await patchSettings({ grace_period_days: value }),
          400,
          'grace_period_days deve ser um número inteiro de 0 a 60.',
          `grace_period_days = ${JSON.stringify(value)}`,
        );
      }
      for (const value of [4, 241, 30.5, null]) {
        await expectApiError(
          await patchSettings({ support_session_minutes: value }),
          400,
          'support_session_minutes deve ser um número inteiro de 5 a 240.',
          `support_session_minutes = ${JSON.stringify(value)}`,
        );
      }

      const grace = snapshot.grace_period_days === 12 ? 13 : 12;
      const updated = await expectOk(await patchSettings({ grace_period_days: grace, support_session_minutes: 5 }), 200);
      expect(updated).toMatchObject({ grace_period_days: grace, support_session_minutes: 5, warnings: [] });
      const audit = await expectAuditRecord(api, sa.token, {
        action: 'platform.settings.update',
        targetType: 'platform_settings',
        targetId: 1,
        actorId: sa.user.id,
      });
      expect(audit.metadata.changes).toEqual({
        grace_period_days: { from: snapshot.grace_period_days, to: grace },
        ...(snapshot.support_session_minutes === 5 ? {} : { support_session_minutes: { from: snapshot.support_session_minutes, to: 5 } }),
      });

      // A duração configurada vale para a sessão aberta agora (expires_at e validade do token)
      const short = await startSupportSession(api, sa.token, store.id, 'Sessão curta: duração configurada em 5 minutos.');
      const shortMinutes = (new Date(short.expiresAt).getTime() - new Date(short.session.started_at).getTime()) / 60_000;
      expect(Math.abs(shortMinutes - 5)).toBeLessThan(0.1);
      const claims = jwtClaims(short.token);
      expect(claims.exp - claims.iat).toBe(5 * 60);
      await endSupportSession(api, sa.token, short.id);

      await expectOk(await patchSettings({ support_session_minutes: 240 }), 200);
      const long = await startSupportSession(api, sa.token, store.id, 'Sessão longa: duração configurada em 240 minutos.');
      const longMinutes = (new Date(long.expiresAt).getTime() - new Date(long.session.started_at).getTime()) / 60_000;
      expect(Math.abs(longMinutes - 240)).toBeLessThan(0.1);
      expect(jwtClaims(long.token).exp - jwtClaims(long.token).iat).toBe(240 * 60);
      await endSupportSession(api, sa.token, long.id);

      // Reenviar os mesmos valores: 200, sem aviso e sem novo registro na auditoria
      const before = await auditPage(api, sa.token, { action: 'platform.settings.update', pageSize: 1 });
      const same = await expectOk(await patchSettings({ grace_period_days: grace, support_session_minutes: 240 }), 200);
      expect(same.warnings).toEqual([]);
      const after = await auditPage(api, sa.token, { action: 'platform.settings.update', pageSize: 1 });
      expect(after.total).toBe(before.total);
    } finally {
      await restoreSettings(api, sa.token, snapshot);
    }
    // Restaurado: uma sessão nova volta a durar o valor original
    const restored = await startSupportSession(api, sa.token, store.id, 'Sessão depois da restauração das configurações.');
    const minutes = (new Date(restored.expiresAt).getTime() - new Date(restored.session.started_at).getTime()) / 60_000;
    expect(Math.abs(minutes - snapshot.support_session_minutes)).toBeLessThan(0.1);
    await endSupportSession(api, sa.token, restored.id);
  });
});
