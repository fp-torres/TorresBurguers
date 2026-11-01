import { expect, test } from '@playwright/test';
import {
  ALL_FEATURES,
  bearer,
  Cleanup,
  createPlan,
  defaultSession,
  expectError,
  expectStatus,
  MISSING_ID,
  MSG,
  newApi,
  NO_FEATURES,
  planCode,
  retirePlanLater,
  type Json,
  type Session,
} from './helpers';

/**
 * Planos da plataforma: criação e edição pelo superpainel (validações em português, auditoria) e a
 * página pública GET /plans (só planos ACTIVE e públicos, só campos comerciais).
 * Os planos criados aqui são desativados no afterAll (planos nunca são apagados).
 */

/** Campos comerciais do plano público (billing-presenter: presentPublicPlan). */
const PUBLIC_PLAN_KEYS = [
  'billing_interval',
  'code',
  'currency',
  'description',
  'features',
  'id',
  'max_monthly_orders',
  'max_products',
  'max_staff_users',
  'monthly_price',
  'name',
  'price',
  'trial_days',
].sort();

const INTERNAL_PLAN_KEYS = ['status', 'is_public', 'sort_order', 'created_at', 'updated_at', 'active_subscriptions'];

const cleanup = new Cleanup();
let superadmin: Session;

test.beforeAll(async () => {
  const api = await newApi();
  superadmin = await defaultSession(api, 'superadmin');
  await api.dispose();
});

test.afterAll(async () => {
  await cleanup.run();
});

async function auditOf(api: Parameters<typeof createPlan>[0], action: string, planId: number): Promise<Json[]> {
  const page = await expectStatus(
    await api.get(`/platform/audit?action=${action}&target_type=plan&target_id=${planId}&pageSize=100`, {
      headers: bearer(superadmin.token),
    }),
    200,
    'GET /platform/audit',
  );
  return page.items as Json[];
}

test.describe('Planos — superpainel', () => {
  test('cria plano com padrões e normalização (código em minúsculas, preço mensalizado) e audita', async ({ request }) => {
    const code = planCode('bl-novo');
    const res = await request.post('/platform/plans', {
      headers: bearer(superadmin.token),
      // is_public omitido de propósito: o padrão é aparecer na página pública
      data: { code: `  ${code.toUpperCase()}  `, name: '  Essencial E2E  ', price: '29.90' },
    });
    const plan = await expectStatus(res, 201, 'POST /platform/plans');
    retirePlanLater(cleanup, superadmin, plan.id);
    expect(plan).toMatchObject({
      code,
      name: 'Essencial E2E',
      description: null,
      price: 29.9,
      currency: 'BRL',
      billing_interval: 'MONTHLY',
      monthly_price: 29.9,
      trial_days: 0,
      max_staff_users: null,
      max_products: null,
      max_monthly_orders: null,
      features: NO_FEATURES,
      status: 'ACTIVE',
      is_public: true,
      sort_order: 0,
      active_subscriptions: 0,
    });

    // Plano anual: o preço mensalizado (anual ÷ 12) é o usado para comparar planos e no MRR
    const yearly = await createPlan(request, superadmin, cleanup, {
      price: 1199.88,
      billing_interval: ' yearly ',
      trial_days: '14',
      max_staff_users: 3,
      max_products: '50',
      max_monthly_orders: 1000,
      features: { online_payments: true },
      sort_order: 7,
    });
    // monthly_price = anual ÷ 12 arredondado em centavos (nunca 99.99000000000001)
    expect(yearly.monthly_price, 'preço mensalizado = anual ÷ 12, em centavos').toBe(99.99);
    expect(yearly).toMatchObject({
      price: 1199.88,
      billing_interval: 'YEARLY',
      trial_days: 14,
      max_staff_users: 3,
      max_products: 50,
      max_monthly_orders: 1000,
      features: { online_payments: true, advanced_reports: false, custom_branding: false },
      is_public: false,
      sort_order: 7,
    });

    const detail = await expectStatus(
      await request.get(`/platform/plans/${plan.id}`, { headers: bearer(superadmin.token) }),
      200,
      'GET /platform/plans/:id',
    );
    expect(detail).toMatchObject({ id: plan.id, code, active_subscriptions: 0 });

    const audit = await auditOf(request, 'plan.create', plan.id);
    expect(audit, 'plan.create auditado uma vez').toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'plan.create',
      result: 'SUCCESS',
      actor_scope: 'PLATFORM',
      actor: { id: superadmin.user.id },
      target_type: 'plan',
      target_id: String(plan.id),
    });
    expect(audit[0].metadata).toMatchObject({ code, price: 29.9 });
  });

  test('validações da criação: mensagens em português, campos desconhecidos e código repetido', async ({ request }) => {
    const headers = bearer(superadmin.token);
    const invalid = await request.post('/platform/plans', {
      headers,
      data: {
        code: 'Código Inválido!',
        name: '',
        price: -1,
        billing_interval: 'WEEKLY',
        trial_days: 366,
        max_staff_users: 0,
        max_products: 1.5,
        max_monthly_orders: -3,
        features: { online_payments: true, delivery_robots: true },
        status: 'ARCHIVED',
        is_public: 'talvez',
        sort_order: -1,
        store_id: 1,
      },
    });
    const payload = await expectError(invalid, 400, MSG.notAllowed('store_id'), 'plano inválido');
    expect(payload.message).toEqual(
      expect.arrayContaining([
        'Código do plano inválido: use letras minúsculas, números e hífens (ex.: essencial, pro-anual).',
        'O nome do plano é obrigatório.',
        'O preço não pode ser negativo.',
        'Periodicidade inválida. Use MONTHLY (mensal) ou YEARLY (anual).',
        'Os dias de teste grátis devem ser um número inteiro de 0 a 365.',
        'O limite de usuários da equipe deve ser um número inteiro a partir de 1 (ou null para ilimitado).',
        'O limite de produtos deve ser um número inteiro a partir de 1 (ou null para ilimitado).',
        'O limite de pedidos por mês deve ser um número inteiro a partir de 1 (ou null para ilimitado).',
        'Recurso desconhecido: "delivery_robots". Use: online_payments, advanced_reports, custom_branding.',
        'Situação do plano inválida. Use ACTIVE (disponível) ou INACTIVE (indisponível para novas contratações).',
        'is_public deve ser verdadeiro ou falso.',
        'A ordem de exibição deve ser um número inteiro de 0 a 100000.',
      ]),
    );

    await expectError(await request.post('/platform/plans', { headers, data: {} }), 400, 'O código do plano é obrigatório.', 'sem código');
    await expectError(
      await request.post('/platform/plans', { headers, data: { code: planCode(), name: 'Sem preço' } }),
      400,
      'Informe um preço válido (ex.: 99.90).',
      'sem preço',
    );
    await expectError(
      await request.post('/platform/plans', { headers, data: { code: planCode(), name: 'Caro', price: 1_000_000 } }),
      400,
      'Preço acima do limite permitido.',
      'preço acima do limite',
    );
    await expectError(
      await request.post('/platform/plans', { headers, data: { code: 'a'.repeat(41), name: 'Longo', price: 1 } }),
      400,
      'O código do plano pode ter no máximo 40 caracteres.',
      'código longo',
    );
    await expectError(
      await request.post('/platform/plans', { headers, data: { code: planCode(), name: 'N'.repeat(81), price: 1 } }),
      400,
      'O nome do plano pode ter no máximo 80 caracteres.',
      'nome longo',
    );
    await expectError(
      await request.post('/platform/plans', { headers, data: { code: planCode(), name: 'Recursos', price: 1, features: ['online_payments'] } }),
      400,
      'features deve ser um objeto com os recursos (online_payments, advanced_reports, custom_branding) marcados como true ou false.',
      'features em lista',
    );
    await expectError(
      await request.post('/platform/plans', { headers, data: { code: planCode(), name: 'Recursos', price: 1, features: { custom_branding: 'sim' } } }),
      400,
      'O recurso custom_branding deve ser true ou false.',
      'recurso não booleano',
    );

    // Código único (comparado depois de normalizado: maiúsculas e espaços não driblam a regra)
    const existing = await createPlan(request, superadmin, cleanup);
    const before = (await expectStatus(await request.get(`/platform/plans?search=${existing.code}`, { headers }), 200)).total;
    await expectError(
      await request.post('/platform/plans', { headers, data: { code: ` ${existing.code.toUpperCase()} `, name: 'Repetido', price: 1 } }),
      409,
      MSG.planCodeTaken,
      'código repetido',
    );
    const after = (await expectStatus(await request.get(`/platform/plans?search=${existing.code}`, { headers }), 200)).total;
    expect(after, 'nenhum plano novo com o código repetido').toBe(before);
  });

  test('edição: só o que mudou, recursos mesclados, validações, 404 e auditoria com antes/depois', async ({ request }) => {
    const headers = bearer(superadmin.token);
    const plan = await createPlan(request, superadmin, cleanup, { price: 19.9, features: { online_payments: true } });
    const other = await createPlan(request, superadmin, cleanup);

    const merged = await expectStatus(
      await request.patch(`/platform/plans/${plan.id}`, { headers, data: { features: { advanced_reports: true } } }),
      200,
      'PATCH features',
    );
    expect(merged.features, 'só as chaves enviadas mudam').toEqual({
      online_payments: true,
      advanced_reports: true,
      custom_branding: false,
    });

    const edited = await expectStatus(
      await request.patch(`/platform/plans/${plan.id}`, {
        headers,
        data: { price: '39.90', trial_days: 7, max_products: 10, description: '  Plano editado  ' },
      }),
      200,
      'PATCH preço e limites',
    );
    expect(edited).toMatchObject({
      price: 39.9,
      monthly_price: 39.9,
      trial_days: 7,
      max_products: 10,
      description: 'Plano editado',
      code: plan.code,
      name: plan.name,
    });
    const unlimited = await expectStatus(
      await request.patch(`/platform/plans/${plan.id}`, { headers, data: { max_products: null } }),
      200,
      'PATCH limite nulo',
    );
    expect(unlimited.max_products, 'null = ilimitado').toBeNull();

    const audit = await auditOf(request, 'plan.update', plan.id);
    expect(audit.length, 'cada edição efetiva é auditada').toBe(3);
    const priceChange = audit.find((entry) => entry.metadata?.price);
    expect(priceChange?.metadata).toMatchObject({ price: { from: 19.9, to: 39.9 } });
    expect(priceChange?.metadata.fields).toEqual(expect.arrayContaining(['price', 'trial_days', 'max_products', 'description']));

    // Nada mudou: 200 com o plano atual e nenhuma auditoria nova
    const same = await expectStatus(
      await request.patch(`/platform/plans/${plan.id}`, { headers, data: { price: 39.9, name: plan.name } }),
      200,
      'PATCH sem mudança',
    );
    expect(same).toMatchObject({ id: plan.id, price: 39.9 });
    expect(await auditOf(request, 'plan.update', plan.id), 'edição sem mudança não é auditada').toHaveLength(3);

    await expectError(
      await request.patch(`/platform/plans/${plan.id}`, { headers, data: { name: null, price: null } }),
      400,
      'O nome do plano é obrigatório.',
      'campos obrigatórios nulos',
    );
    await expectError(
      await request.patch(`/platform/plans/${plan.id}`, { headers, data: { price: -5 } }),
      400,
      'O preço não pode ser negativo.',
      'preço negativo',
    );
    await expectError(
      await request.patch(`/platform/plans/${plan.id}`, { headers, data: { code: other.code } }),
      409,
      MSG.planCodeTaken,
      'código de outro plano',
    );
    await expectError(
      await request.patch(`/platform/plans/${plan.id}`, { headers, data: { active_subscriptions: 0 } }),
      400,
      MSG.notAllowed('active_subscriptions'),
      'campo calculado',
    );
    await expectError(
      await request.patch(`/platform/plans/${MISSING_ID}`, { headers, data: { name: 'Fantasma' } }),
      404,
      MSG.planNotFound,
      'plano inexistente',
    );
    await expectError(
      await request.get(`/platform/plans/${MISSING_ID}`, { headers }),
      404,
      MSG.planNotFound,
      'detalhe de plano inexistente',
    );

    const final = await expectStatus(await request.get(`/platform/plans/${plan.id}`, { headers }), 200);
    expect(final, 'as edições recusadas não mudaram nada').toMatchObject({
      code: plan.code,
      name: plan.name,
      price: 39.9,
      max_products: null,
      features: { online_payments: true, advanced_reports: true, custom_branding: false },
    });
  });

  test('somente o superadmin gerencia planos (equipe 403, anônimo 401)', async ({ request }) => {
    const admin = await defaultSession(request, 'admin');
    const client = await defaultSession(request, 'client');
    const data = { code: planCode(), name: 'Plano indevido', price: 1, is_public: false };
    for (const [label, session] of [
      ['ADMIN da loja', admin],
      ['cliente', client],
    ] as const) {
      await expectError(await request.get('/platform/plans', { headers: bearer(session.token) }), 403, MSG.platformOnly, `${label}: GET`);
      await expectError(
        await request.post('/platform/plans', { headers: bearer(session.token), data }),
        403,
        MSG.platformOnly,
        `${label}: POST`,
      );
    }
    await expectError(await request.post('/platform/plans', { data }), 401, MSG.invalidSession, 'anônimo');
    const created = await expectStatus(
      await request.get(`/platform/plans?search=${data.code}`, { headers: bearer(superadmin.token) }),
      200,
    );
    expect(created.total, 'nenhum plano criado pelas tentativas recusadas').toBe(0);
  });
});

test.describe('Planos — página pública (GET /plans)', () => {
  test('só planos ACTIVE e públicos, na ordem de exibição, sem campos internos', async ({ request }) => {
    const publicLate = await createPlan(request, superadmin, cleanup, {
      is_public: true,
      price: 59.9,
      sort_order: 41,
      description: 'Plano público da suíte de cobrança',
      max_products: 30,
      features: ALL_FEATURES,
    });
    const publicEarly = await createPlan(request, superadmin, cleanup, { is_public: true, price: 89.9, sort_order: 40 });
    const privatePlan = await createPlan(request, superadmin, cleanup, { is_public: false, price: 9.9 });
    const inactivePublic = await createPlan(request, superadmin, cleanup, { is_public: true, status: 'INACTIVE', price: 9.9 });
    expect(inactivePublic.status).toBe('INACTIVE');

    const list = (await expectStatus(await request.get('/plans'), 200, 'GET /plans (anônimo)')) as Json[];
    expect(Array.isArray(list), 'GET /plans devolve a lista de planos').toBe(true);
    const ids = list.map((plan) => plan.id);
    expect(ids).toContain(publicLate.id);
    expect(ids).toContain(publicEarly.id);
    expect(ids, 'plano privado fica fora da página pública').not.toContain(privatePlan.id);
    expect(ids, 'plano INACTIVE fica fora da página pública').not.toContain(inactivePublic.id);
    expect(ids.indexOf(publicEarly.id), 'ordem de exibição (sort_order)').toBeLessThan(ids.indexOf(publicLate.id));

    for (const plan of list) {
      expect(Object.keys(plan).sort(), `plano ${plan.id}: só campos comerciais`).toEqual(PUBLIC_PLAN_KEYS);
      for (const key of INTERNAL_PLAN_KEYS) expect(plan, `plano ${plan.id} sem "${key}"`).not.toHaveProperty(key);
    }
    expect(list.find((plan) => plan.id === publicLate.id)).toEqual({
      id: publicLate.id,
      code: publicLate.code,
      name: publicLate.name,
      description: 'Plano público da suíte de cobrança',
      price: 59.9,
      currency: 'BRL',
      billing_interval: 'MONTHLY',
      monthly_price: 59.9,
      trial_days: 0,
      max_staff_users: null,
      max_products: 30,
      max_monthly_orders: null,
      features: ALL_FEATURES,
    });

    // Tirar de venda (INACTIVE) ou tornar privado remove da página pública; o inverso inclui
    const headers = bearer(superadmin.token);
    await expectStatus(await request.patch(`/platform/plans/${publicLate.id}`, { headers, data: { status: 'INACTIVE' } }), 200);
    await expectStatus(await request.patch(`/platform/plans/${publicEarly.id}`, { headers, data: { is_public: false } }), 200);
    await expectStatus(await request.patch(`/platform/plans/${privatePlan.id}`, { headers, data: { is_public: true } }), 200);
    const after = ((await expectStatus(await request.get('/plans'), 200)) as Json[]).map((plan) => plan.id);
    expect(after).not.toContain(publicLate.id);
    expect(after).not.toContain(publicEarly.id);
    expect(after).toContain(privatePlan.id);
  });
});
