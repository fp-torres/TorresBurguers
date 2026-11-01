/**
 * Superpainel › Auditoria (pedido §6.4; arquitetura §4.5 e §11.6): GET /platform/audit e
 * GET /platform/stores/:id/audit.
 * - Ações sensíveis da equipe da loja (configurações, credenciais do Mercado Pago, equipe, abertura) e da
 *   plataforma ficam registradas com operador, escopo, loja, alvo, resultado e metadados SEM segredos.
 * - Filtros: loja, ator, ação (nome exato; grupo pelos segmentos do nome — "plan" traz plan e plan.*,
 *   nunca platform.*; terminado em ponto, só o grupo), alvo (target_type + target_id; target_id sozinho
 *   → 400), resultado, escopo e período (from/to com data ou data e hora).
 * O registro de CADA ação do superpainel é conferido na matriz de acesso (access-matrix.spec.ts).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  MISSING_ID,
  MSG,
  STRONG_PASSWORD,
  addDays,
  auditPage,
  bearer,
  cleanupPlatformData,
  createPlan,
  createStore,
  expectApiError,
  expectAuditClean,
  expectAuditRecord,
  expectOk,
  freshSession,
  letters,
  newApi,
  storeWithOwner,
  uniqueEmail,
  type CreatedStore,
  type Json,
  type Session,
  type StoreWithOwner,
} from './helpers';
import { login } from '../../../support/api';

let api: APIRequestContext;
let sa: Session;
let plan: Json;
let store: StoreWithOwner;
let other: CreatedStore;
let staff: { id: number; email: string; password: string };
/** Credenciais do Mercado Pago gravadas pela loja (nunca podem aparecer na auditoria). */
const mpAccessToken = `TEST-${letters(28)}`;
const mpPublicKey = `TEST-${letters(20)}`;
const wrongPassword = `Errada${letters(8)}!7`;
/**
 * Janela das ações do arquivo: created_at do primeiro e do último registro (relógio do PostgreSQL, que pode
 * estar alguns ms à frente do processo de teste — por isso a janela não usa new Date()).
 */
let t0: string;
let t1: string;

const owner = () => bearer(store.owner.token);

/** created_at do registro mais recente de uma ação num alvo. */
async function recordTime(action: string, targetType: string, targetId: number): Promise<string> {
  const page = await auditPage(api, sa.token, { action, target_type: targetType, target_id: String(targetId), pageSize: 1 });
  expect(page.items[0]?.action, `registro ${action} de ${targetType}#${targetId}`).toBe(action);
  return page.items[0].created_at as string;
}
const actionsOf = (page: Json): string[] => page.items.map((item: Json) => item.action);

test.beforeAll(async () => {
  api = await newApi();
  sa = await freshSession(api, 'superadmin');
  plan = await createPlan(api, sa.token, { price: 0 });
  store = await storeWithOwner(api, sa.token, { planId: plan.id });
  other = await createStore(api, sa.token, { planId: plan.id });

  // Plataforma: plano (primeiro registro da janela) e situação da loja
  await expectOk(
    await api.patch(`/platform/plans/${plan.id}`, { headers: bearer(sa.token), data: { description: `Auditoria ${letters(6)}` } }),
    200,
    'PATCH /platform/plans/:id',
  );
  t0 = await recordTime('plan.update', 'plan', plan.id);
  await expectOk(
    await api.post(`/platform/stores/${store.id}/suspend`, { headers: bearer(sa.token), data: { reason: 'Auditoria: suspensão temporária' } }),
    200,
    'suspensão',
  );
  await expectOk(await api.post(`/platform/stores/${store.id}/reactivate`, { headers: bearer(sa.token), data: {} }), 200, 'reativação');

  // Equipe da loja: configurações, credenciais, abertura e equipe
  await expectOk(
    await api.patch('/store/settings', { headers: owner(), data: { description: 'Loja auditada pela suíte E2E' } }),
    200,
    'PATCH /store/settings',
  );
  await expectOk(
    await api.put('/store/settings/payments', { headers: owner(), data: { mp_public_key: mpPublicKey, mp_access_token: mpAccessToken } }),
    200,
    'PUT /store/settings/payments',
  );
  await expectOk(await api.delete('/store/settings/payments', { headers: owner() }), 200, 'DELETE /store/settings/payments');
  await expectOk(await api.patch('/store/status', { headers: owner(), data: { is_open: true } }), 200, 'PATCH /store/status');
  const staffEmail = uniqueEmail('plat-auditoria');
  const staffPassword = `Senha${letters(8)}@1`;
  const created = await expectOk(
    await api.post('/users', {
      headers: owner(),
      data: { name: 'Atendente Auditada', email: staffEmail, password: staffPassword, role: 'EMPLOYEE' },
    }),
    201,
    'POST /users (equipe)',
  );
  staff = { id: created.id, email: staffEmail, password: staffPassword };

  // Autenticação: sucesso, senha errada (FAILURE) e conta bloqueada (DENIED)
  await login(api, staff.email, staff.password);
  await expectApiError(await api.post('/auth/login', { data: { email: store.ownerEmail, password: wrongPassword } }), 401);
  await expectOk(
    await api.post(`/platform/users/${staff.id}/block`, { headers: bearer(sa.token), data: { reason: 'Auditoria: conta comprometida' } }),
    200,
    'bloqueio',
  );
  await expectApiError(await api.post('/auth/login', { data: { email: staff.email, password: staff.password } }), 403, MSG.blockedAccount);
  await expectOk(await api.post(`/platform/users/${staff.id}/unblock`, { headers: bearer(sa.token) }), 200, 'desbloqueio');

  t1 = await recordTime('user.unblock', 'user', staff.id);
});

test.afterAll(async () => {
  if (!api) return;
  try {
    await cleanupPlatformData(api, sa.token);
  } finally {
    await api.dispose();
  }
});

test.describe('Registros (GET /platform/audit)', () => {
  test('ações sensíveis da equipe da loja: operador, escopo STORE, loja, alvo e metadados sem as credenciais', async () => {
    const secrets = [mpAccessToken, staff.password, STRONG_PASSWORD];
    const ownerId = store.owner.user.id;
    for (const action of ['store.settings.update', 'store.payments.update', 'store.payments.remove', 'store.status.update']) {
      await expectAuditRecord(api, sa.token, {
        action,
        targetType: 'store',
        targetId: store.id,
        storeId: store.id,
        actorId: ownerId,
        actorScope: 'STORE',
        secrets,
      });
    }
    const payments = await expectAuditRecord(api, sa.token, {
      action: 'store.payments.update',
      targetType: 'store',
      targetId: store.id,
      storeId: store.id,
      secrets,
    });
    // Só o ambiente da conta configurada: nem o token nem a chave pública inteira
    expect(payments.metadata).toMatchObject({ provider: 'MERCADO_PAGO' });
    expect(JSON.stringify(payments)).not.toContain(mpAccessToken.slice(5, 20));

    const staffRecord = await expectAuditRecord(api, sa.token, {
      action: 'store.staff.create',
      targetType: 'user',
      targetId: staff.id,
      storeId: store.id,
      actorId: ownerId,
      actorScope: 'STORE',
      secrets,
    });
    expect(staffRecord.actor).toMatchObject({ id: ownerId, email: store.ownerEmail });
    expect(staffRecord.store).toMatchObject({ id: store.id, slug: store.slug });
  });

  test('autenticação: sucesso, senha errada (FAILURE, sem a senha) e conta bloqueada (DENIED) com a loja da conta', async () => {
    await expectAuditRecord(api, sa.token, {
      action: 'auth.login.success',
      targetType: 'user',
      targetId: staff.id,
      storeId: store.id,
      actorId: staff.id,
    });
    const denied = await expectAuditRecord(api, sa.token, {
      action: 'auth.login.failure',
      targetType: 'user',
      targetId: staff.id,
      storeId: store.id,
      result: 'DENIED',
      secrets: [staff.password],
    });
    expect(denied.metadata).toMatchObject({ reason: 'blocked' });

    // Senha errada não identifica a conta: o registro guarda só o e-mail digitado (nunca a senha)
    const failures = await auditPage(api, sa.token, { action: 'auth.login.failure', result: 'FAILURE', from: t0, to: t1, pageSize: 100 });
    const failure = failures.items.find((item: Json) => item.actor?.email === store.ownerEmail);
    expect(failure, 'tentativa com senha errada registrada').toBeTruthy();
    expect(failure).toMatchObject({ result: 'FAILURE', actor_scope: 'ANONYMOUS' });
    expectAuditClean(failure, [wrongPassword], 'auth.login.failure');
  });

  test('nenhum registro da janela traz senha, hash, token ou as credenciais da loja', async () => {
    const page = await auditPage(api, sa.token, { store_id: store.id, from: t0, to: t1, pageSize: 100 });
    expect(page.total).toBeGreaterThanOrEqual(9);
    for (const record of page.items) expectAuditClean(record, [mpAccessToken, staff.password, wrongPassword], record.action);
  });
});

test.describe('Filtros (GET /platform/audit)', () => {
  test('store_id e actor_id: só os registros da loja e do operador pedidos', async () => {
    const byStore = await auditPage(api, sa.token, { store_id: store.id, from: t0, to: t1, pageSize: 100 });
    for (const item of byStore.items) expect(item.store_id).toBe(store.id);
    expect(actionsOf(byStore)).toEqual(
      expect.arrayContaining([
        'platform.store.suspend',
        'platform.store.reactivate',
        'store.settings.update',
        'store.payments.update',
        'store.payments.remove',
        'store.status.update',
        'store.staff.create',
        'user.block',
        'user.unblock',
      ]),
    );
    // A outra loja (criada antes da janela) não aparece
    expect(byStore.items.some((item: Json) => item.store_id === other.id)).toBe(false);

    const byOwner = await auditPage(api, sa.token, { actor_id: store.owner.user.id, from: t0, to: t1, pageSize: 100 });
    for (const item of byOwner.items) expect(item.actor?.id).toBe(store.owner.user.id);
    expect(actionsOf(byOwner)).toEqual(expect.arrayContaining(['store.settings.update', 'store.staff.create']));
    expect(actionsOf(byOwner)).not.toContain('platform.store.suspend');

    const bySuperadmin = await auditPage(api, sa.token, { actor_id: sa.user.id, store_id: store.id, from: t0, to: t1, pageSize: 100 });
    for (const item of bySuperadmin.items) expect(item).toMatchObject({ store_id: store.id, actor: { id: sa.user.id } });
    expect(actionsOf(bySuperadmin).sort()).toEqual(['platform.store.reactivate', 'platform.store.suspend', 'user.block', 'user.unblock']);

    expect((await auditPage(api, sa.token, { store_id: MISSING_ID })).total).toBe(0);
  });

  test('ação: nome exato, grupo pelos segmentos ("plan" nunca traz platform.*) e grupo terminado em ponto', async () => {
    const window = { from: t0, to: t1, pageSize: 100 };
    const exact = await auditPage(api, sa.token, { ...window, action: 'platform.store.suspend' });
    expect(exact.items.length).toBeGreaterThan(0);
    for (const action of actionsOf(exact)) expect(action).toBe('platform.store.suspend');

    const group = await auditPage(api, sa.token, { ...window, action: 'platform.store', store_id: store.id });
    expect(actionsOf(group).sort()).toEqual(['platform.store.reactivate', 'platform.store.suspend']);

    const payments = await auditPage(api, sa.token, { ...window, action: 'store.payments', store_id: store.id });
    expect(actionsOf(payments).sort()).toEqual(['store.payments.remove', 'store.payments.update']);
    // Segmento incompleto não é grupo: "store.pay" não traz store.payments.*
    expect((await auditPage(api, sa.token, { ...window, action: 'store.pay', store_id: store.id })).total).toBe(0);

    // "plan": plan e plan.* — a janela tem platform.* (suspensão, reativação), que nunca entram
    const plans = await auditPage(api, sa.token, { ...window, action: 'plan' });
    expect(actionsOf(plans)).toContain('plan.update');
    for (const action of actionsOf(plans)) {
      expect(action === 'plan' || action.startsWith('plan.'), `${action} no grupo plan`).toBe(true);
      expect(action.startsWith('platform'), `${action} no grupo plan`).toBe(false);
    }
    const planGroup = await auditPage(api, sa.token, { ...window, action: 'plan.' });
    expect(actionsOf(planGroup)).toContain('plan.update');
    for (const action of actionsOf(planGroup)) expect(action.startsWith('plan.'), action).toBe(true);

    const logins = await auditPage(api, sa.token, { ...window, action: 'auth.login' });
    expect(new Set(actionsOf(logins))).toEqual(new Set(['auth.login.success', 'auth.login.failure']));

    // Maiúsculas viram minúsculas; caracteres fora do padrão → 400
    expect((await auditPage(api, sa.token, { ...window, action: 'PLATFORM.STORE.SUSPEND', store_id: store.id })).total).toBe(1);
    for (const action of ['plan%', 'plan*', 'platform store', '.plan']) {
      await expectApiError(
        await api.get('/platform/audit', { headers: bearer(sa.token), params: { action } }),
        400,
        'Ação inválida: use o nome da ação ou de um grupo (ex.: platform.store ou auth.login.failure).',
        `action=${action}`,
      );
    }
  });

  test('alvo: target_type + target_id; target_id sem target_type → 400 (também na auditoria da loja)', async () => {
    const byPlan = await auditPage(api, sa.token, { target_type: 'plan', target_id: String(plan.id), pageSize: 100 });
    expect(actionsOf(byPlan).sort()).toEqual(['plan.create', 'plan.update']);
    for (const item of byPlan.items) expect(item).toMatchObject({ target_type: 'plan', target_id: String(plan.id), store_id: null });

    const byUser = await auditPage(api, sa.token, { target_type: 'user', target_id: String(staff.id), pageSize: 100 });
    for (const item of byUser.items) expect(item).toMatchObject({ target_type: 'user', target_id: String(staff.id) });
    expect(actionsOf(byUser)).toEqual(
      expect.arrayContaining(['store.staff.create', 'auth.login.success', 'auth.login.failure', 'user.block', 'user.unblock']),
    );

    // Só o tipo: todos os alvos daquele tipo
    const stores = await auditPage(api, sa.token, { target_type: 'STORE', from: t0, to: t1, pageSize: 100 });
    for (const item of stores.items) expect(item.target_type).toBe('store');

    for (const path of ['/platform/audit', `/platform/stores/${store.id}/audit`]) {
      await expectApiError(
        await api.get(path, { headers: bearer(sa.token), params: { target_id: String(staff.id) } }),
        400,
        MSG.targetTypeRequired,
        `${path}?target_id sem target_type`,
      );
    }
    await expectApiError(
      await api.get('/platform/audit', { headers: bearer(sa.token), params: { target_type: 'loja-x', target_id: '1' } }),
      400,
      'Tipo do alvo inválido: use letras minúsculas, números e "_" (ex.: user, store, subscription).',
    );
    await expectApiError(
      await api.get('/platform/audit', { headers: bearer(sa.token), params: { target_type: 'user', target_id: '1 OR 1=1' } }),
      400,
      'Identificador do alvo inválido: use letras, números, ".", ":", "-" ou "_".',
    );
  });

  test('resultado e escopo: FAILURE/DENIED/SUCCESS e PLATFORM/STORE/ANONYMOUS', async () => {
    const window = { from: t0, to: t1, pageSize: 100 };
    const denied = await auditPage(api, sa.token, { ...window, result: 'DENIED' });
    expect(denied.items.some((item: Json) => item.target_id === String(staff.id) && item.action === 'auth.login.failure')).toBe(true);
    for (const item of denied.items) expect(item.result).toBe('DENIED');

    const failures = await auditPage(api, sa.token, { ...window, result: 'FAILURE' });
    expect(failures.items.some((item: Json) => item.actor?.email === store.ownerEmail)).toBe(true);
    for (const item of failures.items) expect(item.result).toBe('FAILURE');

    const success = await auditPage(api, sa.token, { ...window, result: 'SUCCESS', store_id: store.id });
    for (const item of success.items) expect(item.result).toBe('SUCCESS');
    expect(actionsOf(success)).not.toContain('auth.login.failure');

    const platform = await auditPage(api, sa.token, { ...window, actor_scope: 'PLATFORM', store_id: store.id });
    expect(actionsOf(platform)).toEqual(expect.arrayContaining(['platform.store.suspend', 'user.block']));
    for (const item of platform.items) expect(item.actor_scope).toBe('PLATFORM');

    const team = await auditPage(api, sa.token, { ...window, actor_scope: 'STORE', store_id: store.id });
    expect(actionsOf(team)).toEqual(expect.arrayContaining(['store.settings.update', 'store.staff.create']));
    for (const item of team.items) expect(item.actor_scope).toBe('STORE');

    const anonymous = await auditPage(api, sa.token, { ...window, actor_scope: 'ANONYMOUS', action: 'auth.login.failure' });
    expect(anonymous.items.some((item: Json) => item.actor?.email === store.ownerEmail)).toBe(true);

    await expectApiError(
      await api.get('/platform/audit', { headers: bearer(sa.token), params: { result: 'OK' } }),
      400,
      'Resultado inválido. Use SUCCESS, FAILURE ou DENIED.',
    );
    await expectApiError(
      await api.get('/platform/audit', { headers: bearer(sa.token), params: { actor_scope: 'ADMIN' } }),
      400,
      'Escopo inválido. Use PLATFORM, STORE, SYSTEM ou ANONYMOUS.',
    );
  });

  test('período: from/to com data e hora (to inclui o instante) ou só a data (dia inteiro); validações', async () => {
    const inWindow = await auditPage(api, sa.token, { store_id: store.id, action: 'platform.store.suspend', from: t0, to: t1 });
    expect(inWindow.total).toBe(1);
    const suspendedAt = inWindow.items[0].created_at as string;
    expect(Date.parse(suspendedAt)).toBeGreaterThanOrEqual(Date.parse(t0));
    expect(Date.parse(suspendedAt)).toBeLessThanOrEqual(Date.parse(t1));

    // "to" inclui o próprio instante; "from" depois dele exclui
    const exactInstant = new Date(suspendedAt).toISOString();
    expect((await auditPage(api, sa.token, { store_id: store.id, action: 'platform.store.suspend', to: exactInstant })).total).toBe(1);
    const after = new Date(Date.parse(suspendedAt) + 1).toISOString();
    expect((await auditPage(api, sa.token, { store_id: store.id, action: 'platform.store.suspend', from: after })).total).toBe(0);
    expect((await auditPage(api, sa.token, { store_id: store.id, from: t1 })).items.map((item: Json) => item.action)).not.toContain(
      'store.staff.create',
    );

    // Só a data: o dia inteiro (ontem a amanhã cobre o dia de hoje em qualquer fuso)
    const today = new Date().toISOString().slice(0, 10);
    const days = await auditPage(api, sa.token, { store_id: store.id, action: 'platform.store.suspend', from: addDays(today, -1), to: addDays(today, 1) });
    expect(days.total).toBe(1);
    expect((await auditPage(api, sa.token, { store_id: store.id, from: '2001-01-01', to: '2001-01-31' })).total).toBe(0);

    for (const [params, message] of [
      [{ from: 'ontem' }, 'from inválido: use uma data AAAA-MM-DD ou data e hora ISO 8601 com fuso (ex.: 2026-10-11T15:00:00Z).'],
      [{ to: '2026-02-30' }, 'to inválido: use uma data AAAA-MM-DD ou data e hora ISO 8601 com fuso (ex.: 2026-10-11T15:00:00Z).'],
      [{ from: '2026-10-11T15:00:00' }, 'from inválido: use uma data AAAA-MM-DD ou data e hora ISO 8601 com fuso (ex.: 2026-10-11T15:00:00Z).'],
      [{ from: '2026-10-12', to: '2026-10-11' }, 'A data inicial (from) não pode ser depois da data final (to).'],
    ] as const) {
      await expectApiError(
        await api.get('/platform/audit', { headers: bearer(sa.token), params }),
        400,
        message,
        JSON.stringify(params),
      );
    }
  });

  test('paginação no servidor (mais recentes primeiro) e auditoria da loja com os mesmos filtros', async () => {
    const all = await auditPage(api, sa.token, { store_id: store.id, from: t0, to: t1, pageSize: 100 });
    const first = await auditPage(api, sa.token, { store_id: store.id, from: t0, to: t1, pageSize: 3, page: 1 });
    const second = await auditPage(api, sa.token, { store_id: store.id, from: t0, to: t1, pageSize: 3, page: 2 });
    expect(first).toMatchObject({ page: 1, pageSize: 3, total: all.total });
    expect(second).toMatchObject({ page: 2, pageSize: 3, total: all.total });
    const ids = [...first.items, ...second.items].map((item: Json) => item.id);
    expect(ids).toEqual(all.items.slice(0, 6).map((item: Json) => item.id));
    const times = all.items.map((item: Json) => Date.parse(item.created_at));
    expect(times).toEqual([...times].sort((a, b) => b - a));

    // GET /platform/stores/:id/audit: a loja vem da rota; os filtros são os mesmos
    const storeAudit = await expectOk(
      await api.get(`/platform/stores/${store.id}/audit`, {
        headers: bearer(sa.token),
        params: { action: 'store.payments', from: t0, to: t1, pageSize: 100 },
      }),
      200,
    );
    expect(actionsOf(storeAudit).sort()).toEqual(['store.payments.remove', 'store.payments.update']);
    const otherAudit = await expectOk(
      await api.get(`/platform/stores/${other.id}/audit`, { headers: bearer(sa.token), params: { from: t0, to: t1, pageSize: 100 } }),
      200,
    );
    expect(otherAudit.items.filter((item: Json) => item.store_id !== other.id)).toEqual([]);
    expect(actionsOf(otherAudit)).not.toContain('store.payments.update');
    await expectApiError(await api.get(`/platform/stores/${MISSING_ID}/audit`, { headers: bearer(sa.token) }), 404, MSG.storeNotFound);
  });
});
