import { expect, test } from '@playwright/test';
import {
  addMonths,
  addProduct,
  ALL_FEATURES,
  bearer,
  body,
  Cleanup,
  createPlan,
  createStore,
  DAY_MS,
  defaultSession,
  eventsOf,
  expectContractErrorShape,
  expectError,
  expectNear,
  expectStatus,
  LIMIT_LABEL,
  MISSING_ID,
  ms,
  MSG,
  newApi,
  NO_FEATURES,
  platformAction,
  postPlatform,
  postProduct,
  sql,
  storeOverview,
  subscriptionDetail,
  type Json,
  type Plan,
  type Session,
} from './helpers';

/**
 * Assinaturas pelo superpainel (provedor MANUAL): contratação, troca de plano (upgrade/downgrade),
 * cancelamento agendado e desistência (superpainel e ADMIN da loja), cancelamento imediato,
 * suspensão e reativação — com as transições de situação validadas (docs/saas/arquitetura.md §6).
 * Cada teste usa a própria loja; a loja demo nunca muda.
 */

const cleanup = new Cleanup();
let superadmin: Session;
let plans: { free: Plan; paid: Plan; trial: Plan; small: Plan; inactive: Plan };

test.beforeAll(async () => {
  const api = await newApi();
  superadmin = await defaultSession(api, 'superadmin');
  plans = {
    free: await createPlan(api, superadmin, cleanup, { name: 'Grátis completo E2E', features: ALL_FEATURES }),
    paid: await createPlan(api, superadmin, cleanup, { name: 'Pro E2E', price: 99.9, features: ALL_FEATURES }),
    trial: await createPlan(api, superadmin, cleanup, { name: 'Teste 14 dias E2E', price: 49.9, trial_days: 14, features: ALL_FEATURES }),
    small: await createPlan(api, superadmin, cleanup, {
      name: 'Pequeno E2E',
      max_products: 1,
      max_staff_users: 1,
      max_monthly_orders: 5,
      features: NO_FEATURES,
    }),
    inactive: await createPlan(api, superadmin, cleanup, { name: 'Fora de venda E2E', price: 10, status: 'INACTIVE' }),
  };
  await api.dispose();
});

test.afterAll(async () => {
  await cleanup.run();
});

const subPath = (id: number, action: string) => `/platform/subscriptions/${id}/${action}`;

test.describe('Assinaturas — contratação e troca de plano', () => {
  test('nova assinatura só para loja sem assinatura vigente (409 se já houver); teste grátis e plano interno', async ({
    request,
  }) => {
    const store = await createStore(request, superadmin, cleanup, plans.free.id, 'Contratação');
    const first = await subscriptionDetail(request, superadmin, store.subscriptionId);
    expect(first, 'plano gratuito: ACTIVE sem vencimento').toMatchObject({
      store_id: store.id,
      plan_id: plans.free.id,
      status: 'ACTIVE',
      trial_ends_at: null,
      current_period_end: null,
      cancel_at_period_end: false,
      billing_provider: 'MANUAL',
      store: { id: store.id, slug: store.slug },
    });
    expect(first.invoices, 'plano gratuito não gera fatura').toEqual([]);
    expect(eventsOf(first, 'CREATED')).toHaveLength(1);

    const createPath = `/platform/stores/${store.id}/subscription`;
    await expectError(
      await postPlatform(request, superadmin, createPath, { plan_id: plans.trial.id }),
      409,
      MSG.subscriptionExists,
      'loja com assinatura vigente',
    );

    const canceled = await platformAction(request, superadmin, subPath(store.subscriptionId, 'cancel'), {
      at_period_end: false,
      reason: 'Troca de contrato (E2E)',
    });
    expect(canceled).toMatchObject({ status: 'CANCELED', cancel_at_period_end: false, limits: null });
    expectNear(canceled.canceled_at, Date.now(), 120_000, 'canceled_at');

    // Validações (a loja agora não tem assinatura vigente)
    await expectError(
      await postPlatform(request, superadmin, createPath, { plan_id: plans.inactive.id }),
      400,
      MSG.planUnavailable,
      'plano INACTIVE sem allow_inactive_plan',
    );
    await expectError(await postPlatform(request, superadmin, createPath, { plan_id: MISSING_ID }), 404, MSG.planNotFound, 'plano inexistente');
    await expectError(
      await postPlatform(request, superadmin, createPath, { plan_id: 'abc' }),
      400,
      'Informe o plano (plan_id) com um id válido.',
      'plan_id inválido',
    );
    await expectError(
      await postPlatform(request, superadmin, createPath, { plan_id: plans.trial.id, store_id: store.id }),
      400,
      MSG.notAllowed('store_id'),
      'store_id no corpo',
    );
    await expectError(
      await postPlatform(request, superadmin, `/platform/stores/${MISSING_ID}/subscription`, { plan_id: plans.trial.id }),
      404,
      MSG.storeNotFound,
      'loja inexistente',
    );

    // Plano com teste grátis → TRIALING até o fim do teste (o período atual é o teste), sem fatura
    const startedAt = Date.now();
    const created = await platformAction(
      request,
      superadmin,
      createPath,
      { plan_id: plans.trial.id, reason: 'Recontratação (E2E)' },
      201,
    );
    expect(created.id, 'nova contratação cria outra assinatura').not.toBe(store.subscriptionId);
    expect(created).toMatchObject({
      store_id: store.id,
      plan_id: plans.trial.id,
      status: 'TRIALING',
      cancel_at_period_end: false,
      canceled_at: null,
      limits: { staff_users: null, products: null, monthly_orders: null },
      access: { availability: 'OPERATIONAL', canSell: true },
    });
    expectNear(created.trial_ends_at, startedAt + 14 * DAY_MS, 120_000, 'fim do teste grátis (14 dias)');
    expect(created.current_period_end, 'o período atual é o teste grátis').toBe(created.trial_ends_at);
    expect(created.invoices, 'teste grátis não gera fatura').toEqual([]);
    expect(eventsOf(created, 'CREATED')[0]).toMatchObject({
      to_status: 'TRIALING',
      to_plan_id: plans.trial.id,
      reason: 'Recontratação (E2E)',
      actor: { id: superadmin.user.id },
    });

    // A assinatura antiga continua cancelada; a situação da loja vem da vigente
    const old = await subscriptionDetail(request, superadmin, store.subscriptionId);
    expect(old).toMatchObject({ status: 'CANCELED', limits: null, access: { availability: 'OPERATIONAL' } });
    const overview = await storeOverview(request, store.owner);
    expect(overview.subscription).toMatchObject({ id: created.id, status: 'TRIALING', plan_id: plans.trial.id });
    expect(overview.plan.id).toBe(plans.trial.id);

    const audit = await expectStatus(
      await request.get(`/platform/audit?action=subscription.create&target_type=subscription&target_id=${created.id}`, {
        headers: bearer(superadmin.token),
      }),
      200,
    );
    expect(audit.items, 'contratação auditada').toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ store_id: store.id, actor: { id: superadmin.user.id } });

    // Plano interno/negociado (INACTIVE) só com allow_inactive_plan: plano pago → ACTIVE + fatura do 1º período
    await platformAction(request, superadmin, subPath(created.id, 'cancel'), { at_period_end: false, reason: 'Troca para plano interno (E2E)' });
    const internal = await platformAction(
      request,
      superadmin,
      createPath,
      { plan_id: plans.inactive.id, allow_inactive_plan: true, reason: 'Plano negociado (E2E)' },
      201,
    );
    expect(internal).toMatchObject({ plan_id: plans.inactive.id, status: 'ACTIVE', trial_ends_at: null });
    expect(ms(internal.current_period_end)).toBe(addMonths(new Date(internal.current_period_start), 1).getTime());
    expect(internal.invoices).toHaveLength(1);
    expect(internal.invoices[0]).toMatchObject({
      status: 'OPEN',
      amount: 10,
      plan_id: plans.inactive.id,
      period_start: internal.current_period_start,
      period_end: internal.current_period_end,
      due_at: internal.current_period_start,
    });
  });

  test('troca de plano: downgrade recusado quando o uso não cabe; upgrade vale na hora (com fatura)', async ({ request }) => {
    const store = await createStore(request, superadmin, cleanup, plans.free.id, 'Troca de plano');
    const changePath = subPath(store.subscriptionId, 'change-plan');
    await addProduct(request, store.owner);
    const extra = await addProduct(request, store.owner);

    const refused = await expectError(
      await postPlatform(request, superadmin, changePath, { plan_id: plans.small.id }),
      409,
      `O uso atual da loja não cabe no plano ${plans.small.name}: ${LIMIT_LABEL.products}: 2 em uso (limite 1). Reduza o uso antes de mudar de plano.`,
      'downgrade com uso acima do limite',
    );
    expect(refused.violations).toEqual([{ key: 'products', label: LIMIT_LABEL.products, limit: 1, usage: 2 }]);
    await expectError(await postPlatform(request, superadmin, changePath, { plan_id: plans.free.id }), 400, MSG.samePlan, 'mesmo plano');
    await expectError(
      await postPlatform(request, superadmin, changePath, { plan_id: plans.inactive.id }),
      400,
      MSG.planUnavailable,
      'plano fora de venda',
    );
    await expectError(await postPlatform(request, superadmin, changePath, { plan_id: MISSING_ID }), 404, MSG.planNotFound, 'plano inexistente');
    await expectError(
      await postPlatform(request, superadmin, subPath(MISSING_ID, 'change-plan'), { plan_id: plans.small.id }),
      404,
      MSG.subscriptionNotFound,
      'assinatura inexistente',
    );
    const unchanged = await subscriptionDetail(request, superadmin, store.subscriptionId);
    expect(unchanged.plan_id, 'trocas recusadas não mudam o plano').toBe(plans.free.id);
    expect(eventsOf(unchanged, 'PLAN_CHANGED')).toEqual([]);

    // Uso igual ao limite cabe: com um produto na lixeira, o downgrade passa e vale na hora
    await expectStatus(await request.delete(`/products/${extra.id}`, { headers: bearer(store.owner.token) }), 200, 'lixeira');
    const down = await platformAction(request, superadmin, changePath, { plan_id: plans.small.id, reason: 'Downgrade (E2E)' });
    expect(down).toMatchObject({
      plan_id: plans.small.id,
      status: 'ACTIVE',
      current_period_end: null,
      limits: { staff_users: 1, products: 1, monthly_orders: 5 },
    });
    expect(eventsOf(down, 'PLAN_CHANGED')[0]).toMatchObject({
      from_plan_id: plans.free.id,
      to_plan_id: plans.small.id,
      reason: 'Downgrade (E2E)',
      metadata: { proration: false },
    });
    await expectError(
      await postProduct(request, store.owner),
      403,
      MSG.limitReached(plans.small.name, 1, LIMIT_LABEL.products),
      'limite do plano novo vale na hora',
    );

    // Upgrade de um plano sem período para um pago: começa um período agora, com fatura que vence agora
    const upgradedAt = Date.now();
    const up = await platformAction(request, superadmin, changePath, { plan_id: plans.paid.id });
    expect(up).toMatchObject({ plan_id: plans.paid.id, limits: { staff_users: null, products: null, monthly_orders: null } });
    expect(['ACTIVE', 'PAST_DUE'], 'fatura nova vence agora: a rotina pode já tê-la marcado').toContain(up.status);
    expectNear(up.current_period_start, upgradedAt, 120_000, 'início do período do plano pago');
    expect(ms(up.current_period_end)).toBe(addMonths(new Date(up.current_period_start), 1).getTime());
    const invoice = (up.invoices as Json[]).find((item) => item.plan_id === plans.paid.id);
    expect(invoice, 'fatura do plano novo').toMatchObject({
      status: 'OPEN',
      amount: 99.9,
      period_start: up.current_period_start,
      period_end: up.current_period_end,
    });
    expectNear(invoice.due_at, upgradedAt, 120_000, 'vencimento da fatura do upgrade');
    await addProduct(request, store.owner); // sem limite de produtos no plano novo

    const overview = await storeOverview(request, store.owner);
    expect(overview.plan.id).toBe(plans.paid.id);
    expect(overview.features).toEqual(ALL_FEATURES);
    expect(overview.limits).toEqual({ staff_users: null, products: null, monthly_orders: null });
  });

  test('superpainel lista assinaturas com filtros por situação, plano e loja', async ({ request }) => {
    const store = await createStore(request, superadmin, cleanup, plans.trial.id, 'Listagem', { open: false });
    const headers = bearer(superadmin.token);
    const page = await expectStatus(
      await request.get(`/platform/subscriptions?search=${store.slug}&status=trialing&plan_id=${plans.trial.id}`, { headers }),
      200,
      'GET /platform/subscriptions',
    );
    expect(page).toMatchObject({ total: 1, page: 1 });
    expect(page.items[0]).toMatchObject({
      id: store.subscriptionId,
      status: 'TRIALING',
      store: { id: store.id, slug: store.slug, name: store.name },
      plan: { id: plans.trial.id, code: plans.trial.code, price: 49.9, billing_interval: 'MONTHLY', status: 'ACTIVE' },
    });
    const none = await expectStatus(
      await request.get(`/platform/subscriptions?search=${store.slug}&status=ACTIVE`, { headers }),
      200,
    );
    expect(none.total).toBe(0);
    await expectError(
      await request.get('/platform/subscriptions?status=PAUSED', { headers }),
      400,
      'Situação inválida. Use TRIALING, ACTIVE, PAST_DUE, SUSPENDED ou CANCELED.',
      'situação desconhecida',
    );
  });
});

test.describe('Assinaturas — cancelamento', () => {
  test('cancelamento no fim do período e desistência pelo superpainel e pelo ADMIN da loja', async ({ request }) => {
    const store = await createStore(request, superadmin, cleanup, plans.trial.id, 'Cancelamento agendado');
    const sub = store.subscriptionId;
    const owner = bearer(store.owner.token);

    const scheduled = await platformAction(request, superadmin, subPath(sub, 'cancel'), {
      at_period_end: true,
      reason: 'Loja vai fechar (E2E)',
    });
    expect(scheduled).toMatchObject({ status: 'TRIALING', cancel_at_period_end: true, canceled_at: null });
    expect(scheduled.access, 'a loja continua vendendo até o fim do período').toMatchObject({
      availability: 'OPERATIONAL',
      canSell: true,
    });
    const scheduledEvent = eventsOf(scheduled, 'CANCEL_SCHEDULED');
    expect(scheduledEvent).toHaveLength(1);
    expect(scheduledEvent[0]).toMatchObject({ reason: 'Loja vai fechar (E2E)', actor: { id: superadmin.user.id } });
    expect(ms(scheduledEvent[0].metadata.cancel_at)).toBe(ms(scheduled.current_period_end));

    const again = await platformAction(request, superadmin, subPath(sub, 'cancel'), { at_period_end: true });
    expect(eventsOf(again, 'CANCEL_SCHEDULED'), 'agendar de novo não duplica o histórico').toHaveLength(1);

    const resumed = await platformAction(request, superadmin, subPath(sub, 'resume'), undefined);
    expect(resumed).toMatchObject({ status: 'TRIALING', cancel_at_period_end: false });
    expect(eventsOf(resumed, 'CANCEL_REVERTED')).toHaveLength(1);
    await expectError(await postPlatform(request, superadmin, subPath(sub, 'resume')), 409, MSG.nothingToResume, 'nada a desfazer');

    // ADMIN da loja: cancela no fim do período e desiste (resposta = visão da assinatura da loja)
    const canceledByAdmin = await expectStatus(
      await request.post('/store/subscription/cancel', { headers: owner, data: { reason: 'Decisão do dono (E2E)' } }),
      200,
      'POST /store/subscription/cancel',
    );
    expect(canceledByAdmin.subscription).toMatchObject({ id: sub, status: 'TRIALING', cancel_at_period_end: true });
    const resumedByAdmin = await expectStatus(
      await request.post('/store/subscription/resume', { headers: owner }),
      200,
      'POST /store/subscription/resume',
    );
    expect(resumedByAdmin.subscription).toMatchObject({ id: sub, cancel_at_period_end: false });
    await expectError(await request.post('/store/subscription/resume', { headers: owner }), 409, MSG.nothingToResume, 'ADMIN: nada a desfazer');

    const history = await subscriptionDetail(request, superadmin, sub);
    expect(eventsOf(history, 'CANCEL_SCHEDULED')).toHaveLength(2);
    expect(eventsOf(history, 'CANCEL_REVERTED')).toHaveLength(2);
    expect(eventsOf(history, 'CANCEL_SCHEDULED')[0], 'o ADMIN aparece como autor').toMatchObject({
      reason: 'Decisão do dono (E2E)',
      actor: { id: store.owner.user.id },
    });

    // Período já encerrado: o cancelamento não pode mais ser desfeito e a loja para de vender na hora
    // (a situação considera as datas, sem esperar a rotina). O fim do teste grátis fica no futuro para a
    // rotina não concluir o cancelamento durante o teste.
    await platformAction(request, superadmin, subPath(sub, 'cancel'), { at_period_end: true });
    await sql(`UPDATE "subscriptions" SET "current_period_end" = now() - interval '1 minute' WHERE "id" = $1`, [sub]);
    await expectError(await postPlatform(request, superadmin, subPath(sub, 'resume')), 409, MSG.periodEnded, 'superpainel: período encerrado');
    await expectError(await request.post('/store/subscription/resume', { headers: owner }), 409, MSG.periodEnded, 'ADMIN: período encerrado');
    const ended = await subscriptionDetail(request, superadmin, sub);
    expect(ended).toMatchObject({ cancel_at_period_end: true, access: { availability: 'SUBSCRIPTION_CANCELED', canSell: false } });
    // Vitrine: continua visível, sem vender; o perfil público usa a mensagem genérica (o motivo é da loja)
    const profile = await expectStatus(await request.get(`/stores/${store.slug}`), 200, 'perfil público');
    expect(profile).toMatchObject({ ordering_available: false, unavailable_message: MSG.storeUnavailable });
  });

  test('cancelamento imediato anula só as faturas de períodos futuros; assinatura cancelada não muda mais (409)', async ({
    request,
  }) => {
    const store = await createStore(request, superadmin, cleanup, plans.paid.id, 'Cancelamento imediato');
    const sub = store.subscriptionId;
    const initial = await subscriptionDetail(request, superadmin, sub);
    expect(initial.invoices, 'plano pago: fatura do 1º período').toHaveLength(1);
    const current = initial.invoices[0];
    const future = await platformAction(request, superadmin, subPath(sub, 'invoices'), {}, 201);
    expect(ms(future.period_start), 'fatura avulsa padrão = período seguinte').toBe(ms(initial.current_period_end));

    // Cancelar agora (anula faturas futuras) exige o motivo: sem ele → 400 e nada muda
    for (const data of [{}, { at_period_end: false }, { at_period_end: false, reason: '  ' }]) {
      await expectError(
        await postPlatform(request, superadmin, subPath(sub, 'cancel'), data),
        400,
        'Informe o motivo do cancelamento imediato.',
        `cancelar agora sem motivo ${JSON.stringify(data)}`,
      );
    }
    const untouched = await subscriptionDetail(request, superadmin, sub);
    expect(untouched.status, 'cancelamento sem motivo não grava nada').not.toBe('CANCELED');
    expect(eventsOf(untouched, 'STATUS_CHANGED').filter((event) => event.to_status === 'CANCELED')).toEqual([]);

    const canceledAt = Date.now();
    const canceled = await platformAction(request, superadmin, subPath(sub, 'cancel'), {
      at_period_end: false,
      reason: 'Encerramento imediato (E2E)',
    });
    expect(canceled).toMatchObject({ status: 'CANCELED', cancel_at_period_end: false, limits: null });
    expectNear(canceled.canceled_at, canceledAt, 120_000, 'canceled_at');
    const byId = new Map((canceled.invoices as Json[]).map((invoice) => [invoice.id, invoice]));
    expect(byId.get(current.id)?.status, 'fatura do período que já começou continua devida').toBe('OPEN');
    expect(byId.get(future.id)?.status, 'fatura de período futuro é anulada').toBe('VOID');
    const statusEvent = eventsOf(canceled, 'STATUS_CHANGED').find((event) => event.to_status === 'CANCELED');
    expect(['ACTIVE', 'PAST_DUE'], 'cancelada a partir de ACTIVE (ou PAST_DUE, se a rotina já marcou a fatura)').toContain(
      statusEvent?.from_status,
    );
    expect(statusEvent).toMatchObject({ reason: 'Encerramento imediato (E2E)', metadata: { trigger: 'cancel.now' } });

    // CANCELED é final: nenhuma ação muda a assinatura (409)
    for (const [label, action, data] of [
      ['cancelar de novo', 'cancel', { at_period_end: false, reason: 'Tentativa (E2E)' }],
      ['agendar cancelamento', 'cancel', { at_period_end: true }],
      ['trocar de plano', 'change-plan', { plan_id: plans.free.id }],
      ['desfazer cancelamento', 'resume', undefined],
      ['reativar', 'reactivate', { force: true, reason: 'Tentativa (E2E)' }],
      ['nova fatura', 'invoices', { amount: 10 }],
    ] as Array<[string, string, Record<string, unknown> | undefined]>) {
      await expectError(await postPlatform(request, superadmin, subPath(sub, action), data), 409, MSG.subscriptionCanceled, label);
    }
    const owner = bearer(store.owner.token);
    await expectError(await request.post('/store/subscription/cancel', { headers: owner, data: {} }), 409, MSG.noCurrentSubscription, 'ADMIN cancela');
    await expectError(await request.post('/store/subscription/resume', { headers: owner }), 409, MSG.noCurrentSubscription, 'ADMIN desfaz');

    const overview = await storeOverview(request, store.owner);
    expect(overview).toMatchObject({
      subscription: { id: sub, status: 'CANCELED' },
      limits: null,
      features: NO_FEATURES,
      access: { availability: 'SUBSCRIPTION_CANCELED', canSell: false, canManageBilling: true },
    });
    const final = await subscriptionDetail(request, superadmin, sub);
    expect(final.status).toBe('CANCELED');
    expect(eventsOf(final, 'STATUS_CHANGED').filter((event) => event.to_status === 'CANCELED')).toHaveLength(1);
  });
});

test.describe('Assinaturas — suspensão e reativação', () => {
  test('suspensão exige motivo; reativação sem fatura vencida volta a ACTIVE', async ({ request }) => {
    const store = await createStore(request, superadmin, cleanup, plans.free.id, 'Suspensão');
    const sub = store.subscriptionId;
    for (const [label, data, message] of [
      ['sem motivo', {}, MSG.suspendReasonRequired],
      ['motivo em branco', { reason: '   ' }, MSG.suspendReasonRequired],
      ['motivo longo', { reason: 'x'.repeat(301) }, MSG.reasonTooLong],
    ] as Array<[string, Record<string, unknown>, string]>) {
      await expectError(await postPlatform(request, superadmin, subPath(sub, 'suspend'), data), 400, message, `suspender ${label}`);
    }
    expect((await subscriptionDetail(request, superadmin, sub)).status, 'pedidos recusados não suspendem').toBe('ACTIVE');

    const suspendedAt = Date.now();
    const suspended = await platformAction(request, superadmin, subPath(sub, 'suspend'), {
      reason: 'Uso indevido da plataforma (E2E)',
    });
    expect(suspended).toMatchObject({
      status: 'SUSPENDED',
      access: { availability: 'SUBSCRIPTION_SUSPENDED', canSell: false, canManage: false, canManageBilling: true },
    });
    expectNear(suspended.suspended_at, suspendedAt, 120_000, 'suspended_at');
    expect(eventsOf(suspended, 'STATUS_CHANGED')[0]).toMatchObject({
      from_status: 'ACTIVE',
      to_status: 'SUSPENDED',
      reason: 'Uso indevido da plataforma (E2E)',
      actor: { id: superadmin.user.id },
      metadata: { trigger: 'platform.suspend' },
    });
    const audit = await expectStatus(
      await request.get(`/platform/audit?action=subscription.suspend&target_type=subscription&target_id=${sub}`, {
        headers: bearer(superadmin.token),
      }),
      200,
    );
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0].metadata).toMatchObject({ from: 'ACTIVE', to: 'SUSPENDED', reason: 'Uso indevido da plataforma (E2E)' });

    const reactivated = await platformAction(request, superadmin, subPath(sub, 'reactivate'), {});
    expect(reactivated).toMatchObject({
      status: 'ACTIVE',
      suspended_at: null,
      past_due_since: null,
      grace_period_ends_at: null,
      access: { availability: 'OPERATIONAL', canSell: true },
    });
    expect(eventsOf(reactivated, 'STATUS_CHANGED')[0]).toMatchObject({
      from_status: 'SUSPENDED',
      to_status: 'ACTIVE',
      metadata: { trigger: 'platform.reactivate' },
    });
  });

  test('reativação com faturas vencidas exige force e motivo (vencimento renovado)', async ({ request }) => {
    const store = await createStore(request, superadmin, cleanup, plans.free.id, 'Reativação forçada', { open: false });
    const sub = store.subscriptionId;
    await expectError(await postPlatform(request, superadmin, subPath(sub, 'invoices'), {}), 400, MSG.freePlanInvoice, 'plano gratuito sem valor');
    const overdue = await platformAction(
      request,
      superadmin,
      subPath(sub, 'invoices'),
      { amount: 15, due_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), notes: 'Serviço avulso (E2E)' },
      201,
    );
    // ACTIVE ou PAST_DUE (a rotina pode já ter visto a fatura vencida): as duas podem ser suspensas
    await platformAction(request, superadmin, subPath(sub, 'suspend'), { reason: 'Inadimplência (E2E)' });

    const conflict = await expectError(
      await postPlatform(request, superadmin, subPath(sub, 'reactivate'), {}),
      409,
      MSG.overdueInvoices,
      'reativar sem force',
    );
    expect(conflict.overdue_invoices).toEqual([overdue.id]);
    for (const data of [{ force: true }, { force: true, reason: '   ' }]) {
      await expectError(
        await postPlatform(request, superadmin, subPath(sub, 'reactivate'), data),
        400,
        MSG.forceReasonRequired,
        `force ${JSON.stringify(data)}`,
      );
    }
    expect((await subscriptionDetail(request, superadmin, sub)).status).toBe('SUSPENDED');

    const forcedAt = Date.now();
    const forced = await platformAction(request, superadmin, subPath(sub, 'reactivate'), {
      force: true,
      reason: 'Acordo de pagamento (E2E)',
    });
    expect(forced).toMatchObject({ status: 'ACTIVE', suspended_at: null, past_due_since: null, grace_period_ends_at: null });
    const rescheduled = (forced.invoices as Json[]).find((invoice) => invoice.id === overdue.id);
    expect(rescheduled?.status, 'a fatura continua devida').toBe('OPEN');
    expectNear(rescheduled?.due_at, forcedAt, 120_000, 'vencimento movido para a reativação');
    expect(eventsOf(forced, 'STATUS_CHANGED').find((event) => event.to_status === 'ACTIVE')).toMatchObject({
      from_status: 'SUSPENDED',
      reason: 'Acordo de pagamento (E2E)',
      metadata: { trigger: 'platform.reactivate_forced', forced: true, rescheduled_invoices: [overdue.id] },
    });

    // Pagamento registrado: assinatura regularizada (ACTIVE), mesmo que a rotina já a tenha marcado PAST_DUE
    await platformAction(request, superadmin, `/platform/invoices/${overdue.id}/mark-paid`, { payment_method: 'PIX' });
    const paid = await subscriptionDetail(request, superadmin, sub);
    expect(paid).toMatchObject({ status: 'ACTIVE', past_due_since: null, grace_period_ends_at: null });
  });
});

/**
 * Suspensão decidida pelo superadmin (suspended_by = PLATFORM): pagamento quita a fatura, mas só a
 * reativação pelo superpainel devolve a loja (a inadimplência — BILLING — continua regularizada pelo pagamento).
 */
test.describe('Assinaturas — suspensão pela plataforma × pagamento', () => {
  test('pagamento registrado não desfaz a suspensão da plataforma; checkout da loja → 409; só a reativação devolve', async ({
    request,
  }) => {
    const store = await createStore(request, superadmin, cleanup, plans.paid.id, 'Suspensão administrativa', { open: false });
    const sub = store.subscriptionId;
    const open = (await subscriptionDetail(request, superadmin, sub)).invoices.find((invoice: Json) => invoice.status === 'OPEN');
    expect(open, 'plano pago abre a fatura do 1º período').toBeDefined();

    const suspended = await platformAction(request, superadmin, subPath(sub, 'suspend'), { reason: 'Bloqueio administrativo (E2E)' });
    expect(suspended).toMatchObject({ status: 'SUSPENDED', suspended_by: 'PLATFORM' });

    // O pagamento é registrado (a fatura fica paga), mas a loja continua suspensa
    const paid = await platformAction(request, superadmin, `/platform/invoices/${open.id}/mark-paid`, { payment_method: 'PIX' });
    expect(paid).toMatchObject({ id: open.id, status: 'PAID' });
    const afterPayment = await subscriptionDetail(request, superadmin, sub);
    expect(afterPayment).toMatchObject({ status: 'SUSPENDED', suspended_by: 'PLATFORM' });
    expect(afterPayment.access).toMatchObject({ canSell: false });
    expect(eventsOf(afterPayment, 'STATUS_CHANGED').filter((event) => event.to_status === 'ACTIVE'), 'nenhuma reativação').toEqual([]);

    // A loja não abre cobrança nova enquanto a suspensão for da plataforma
    await expectError(
      await request.post('/store/subscription/checkout', { headers: bearer(store.owner.token), data: {} }),
      409,
      MSG.platformSuspensionCheckout,
      'checkout com a assinatura suspensa pela plataforma',
    );

    const reactivated = await platformAction(request, superadmin, subPath(sub, 'reactivate'), {});
    expect(reactivated).toMatchObject({ status: 'ACTIVE', suspended_at: null, suspended_by: null });
  });
});

/**
 * Transições inválidas → 409 (Conflict), como as da loja (§11.6) e as de assinatura cancelada/
 * desistência (§11.6, resume): suspender/reativar fora da situação permitida também respondem 409.
 */
test.describe('Assinaturas — transições inválidas', () => {
  async function expectConflict(res: Awaited<ReturnType<typeof postPlatform>>, message: string, label: string) {
    const payload = await body(res);
    expect.soft(res.status(), `${label}: transição inválida → 409 (${JSON.stringify(payload)})`).toBe(409);
    expect.soft(payload?.message, `${label}: mensagem`).toBe(message);
    if (res.status() >= 400) expectContractErrorShape(payload, res.status());
  }

  test('suspender só ACTIVE/PAST_DUE: em teste grátis, já suspensa ou cancelada → 409', async ({ request }) => {
    const trialing = await createStore(request, superadmin, cleanup, plans.trial.id, 'Suspender teste', { open: false });
    const active = await createStore(request, superadmin, cleanup, plans.free.id, 'Suspender duas vezes', { open: false });
    const canceled = await createStore(request, superadmin, cleanup, plans.free.id, 'Suspender cancelada', { open: false });
    await platformAction(request, superadmin, subPath(active.subscriptionId, 'suspend'), { reason: 'Primeira suspensão (E2E)' });
    await platformAction(request, superadmin, subPath(canceled.subscriptionId, 'cancel'), {
      at_period_end: false,
      reason: 'Cancelada para o teste de transição (E2E)',
    });

    const reason = { reason: 'Transição inválida (E2E)' };
    await expectConflict(
      await postPlatform(request, superadmin, subPath(trialing.subscriptionId, 'suspend'), reason),
      'A assinatura não pode passar de "Em teste grátis" para "Suspensa".',
      'TRIALING → SUSPENDED',
    );
    await expectConflict(
      await postPlatform(request, superadmin, subPath(active.subscriptionId, 'suspend'), reason),
      'A assinatura já está na situação "Suspensa".',
      'SUSPENDED → SUSPENDED',
    );
    await expectConflict(
      await postPlatform(request, superadmin, subPath(canceled.subscriptionId, 'suspend'), reason),
      'A assinatura está cancelada e não pode mais mudar de situação. Uma nova contratação cria outra assinatura.',
      'CANCELED → SUSPENDED',
    );

    // Nada foi gravado pelas tentativas
    expect((await subscriptionDetail(request, superadmin, trialing.subscriptionId)).status).toBe('TRIALING');
    const twice = await subscriptionDetail(request, superadmin, active.subscriptionId);
    expect(eventsOf(twice, 'STATUS_CHANGED').filter((event) => event.to_status === 'SUSPENDED')).toHaveLength(1);
    expect((await subscriptionDetail(request, superadmin, canceled.subscriptionId)).status).toBe('CANCELED');
  });

  test('reativar só SUSPENDED/PAST_DUE: ativa ou em teste grátis → 409', async ({ request }) => {
    const active = await createStore(request, superadmin, cleanup, plans.free.id, 'Reativar ativa', { open: false });
    const trialing = await createStore(request, superadmin, cleanup, plans.trial.id, 'Reativar teste', { open: false });
    const message = 'Só assinaturas suspensas ou com pagamento em atraso podem ser reativadas.';
    await expectConflict(await postPlatform(request, superadmin, subPath(active.subscriptionId, 'reactivate'), {}), message, 'ACTIVE → ACTIVE');
    await expectConflict(
      await postPlatform(request, superadmin, subPath(trialing.subscriptionId, 'reactivate'), {}),
      message,
      'TRIALING → ACTIVE (reativar)',
    );
    const detail = await subscriptionDetail(request, superadmin, active.subscriptionId);
    expect(detail.status).toBe('ACTIVE');
    expect(eventsOf(detail, 'STATUS_CHANGED'), 'nenhuma mudança gravada').toEqual([]);
    expect((await subscriptionDetail(request, superadmin, trialing.subscriptionId)).status).toBe('TRIALING');
  });
});
