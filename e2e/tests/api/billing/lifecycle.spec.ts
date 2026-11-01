import { expect, test } from '@playwright/test';
import {
  addMonths,
  addProduct,
  ALL_FEATURES,
  bearer,
  cancelOrderLater,
  Cleanup,
  createPlan,
  createStore,
  DAY_MS,
  defaultSession,
  eventsOf,
  expectError,
  expectStatus,
  ms,
  MSG,
  newApi,
  newCustomer,
  platformAction,
  postOrder,
  postPlatform,
  sql,
  storeOverview,
  subscriptionDetail,
  waitForSubscription,
  type BillingStore,
  type Json,
  type Member,
  type Plan,
  type Session,
} from './helpers';

/**
 * Ciclo de vida das assinaturas (SubscriptionLifecycleService, docs/saas/arquitetura.md §6 e §11.4):
 * fim do teste grátis, renovação no fim do período, PAST_DUE (vende durante a tolerância), SUSPENDED
 * depois da tolerância (não vende) e cancelamento agendado concluído no fim do período.
 * A passagem do tempo é simulada mudando as datas da assinatura no banco de TESTE; a rotina roda a
 * cada SAAS_BILLING_INTERVAL_MS (10 s na API de teste) e o teste espera com expect.poll.
 */

test.describe.configure({ timeout: 180_000 });

const cleanup = new Cleanup();
let superadmin: Session;
let customer: Member;
let graceDays: number;
let plans: { trialPaid: Plan; trialFree: Plan; paid: Plan };

test.beforeAll(async () => {
  const api = await newApi();
  superadmin = await defaultSession(api, 'superadmin');
  plans = {
    trialPaid: await createPlan(api, superadmin, cleanup, {
      name: 'Ciclo teste pago E2E',
      price: 49.9,
      trial_days: 14,
      features: ALL_FEATURES,
    }),
    trialFree: await createPlan(api, superadmin, cleanup, { name: 'Ciclo teste grátis E2E', trial_days: 7, features: ALL_FEATURES }),
    paid: await createPlan(api, superadmin, cleanup, { name: 'Ciclo mensal E2E', price: 99.9, features: ALL_FEATURES }),
  };
  customer = await newCustomer(api);
  const settings = await expectStatus(
    await api.get('/platform/settings', { headers: bearer(superadmin.token) }),
    200,
    'GET /platform/settings',
  );
  graceDays = settings.grace_period_days;
  expect(Number.isInteger(graceDays), 'tolerância da plataforma (dias)').toBe(true);
  await api.dispose();
});

test.afterAll(async () => {
  await cleanup.run();
});

/** "Agora menos 1 minuto" em milissegundos inteiros (as datas da API têm precisão de ms). */
const MINUTE_AGO = `date_trunc('milliseconds', now() - interval '1 minute')`;

async function storeWithProduct(
  request: Parameters<typeof createStore>[0],
  planId: number,
  label: string,
): Promise<{ store: BillingStore; productId: number }> {
  const store = await createStore(request, superadmin, cleanup, planId, label);
  const product = await addProduct(request, store.owner);
  return { store, productId: product.id };
}

async function expectOrderAccepted(request: Parameters<typeof createStore>[0], store: BillingStore, productId: number, label: string) {
  const order = await expectStatus(await postOrder(request, store.slug, customer, productId), 201, label);
  cancelOrderLater(cleanup, store.owner, order.id);
}

function statusChange(detail: Json, from: string, to: string): Json | undefined {
  return eventsOf(detail, 'STATUS_CHANGED').find((event) => event.from_status === from && event.to_status === to);
}

test('fim do teste grátis (plano pago): fatura do 1º período; sem pagamento → PAST_DUE na tolerância, ainda vendendo', async ({
  request,
}) => {
  const { store, productId } = await storeWithProduct(request, plans.trialPaid.id, 'Fim do teste pago');
  const sub = store.subscriptionId;
  const [row] = await sql<{ trial_ends_at: Date }>(
    `UPDATE "subscriptions" SET "trial_ends_at" = ${MINUTE_AGO}, "current_period_end" = ${MINUTE_AGO}
      WHERE "id" = $1 AND "status" = 'TRIALING' RETURNING "trial_ends_at"`,
    [sub],
  );
  expect(row, 'assinatura em teste grátis').toBeTruthy();
  const trialEnd = new Date(row.trial_ends_at);

  const detail = await waitForSubscription(request, superadmin, sub, (d) => d.status === 'PAST_DUE', 'fim do teste → PAST_DUE');
  expect(detail.invoices, 'uma fatura do 1º período').toHaveLength(1);
  const invoice = detail.invoices[0];
  expect(invoice).toMatchObject({ status: 'OPEN', amount: 49.9, plan_id: plans.trialPaid.id });
  expect(ms(invoice.period_start), 'o 1º período começa no fim do teste').toBe(trialEnd.getTime());
  expect(ms(invoice.period_end)).toBe(addMonths(trialEnd, 1).getTime());
  expect(ms(invoice.due_at), 'vence no início do período').toBe(trialEnd.getTime());
  expect(ms(detail.current_period_start)).toBe(trialEnd.getTime());
  expect(ms(detail.current_period_end)).toBe(addMonths(trialEnd, 1).getTime());
  expect(ms(detail.past_due_since)).toBe(trialEnd.getTime());
  expect(ms(detail.grace_period_ends_at), `tolerância de ${graceDays} dias (platform_settings)`).toBe(
    trialEnd.getTime() + graceDays * DAY_MS,
  );
  expect(statusChange(detail, 'TRIALING', 'ACTIVE')).toMatchObject({ actor: null, metadata: { trigger: 'lifecycle.trial_end' } });
  expect(eventsOf(detail, 'INVOICE_CREATED', invoice.id)[0]).toMatchObject({ metadata: { trigger: 'lifecycle.trial_end' } });
  expect(statusChange(detail, 'ACTIVE', 'PAST_DUE')).toMatchObject({
    actor: null,
    metadata: { trigger: 'lifecycle.invoice_overdue', invoice_id: invoice.id, grace_days: graceDays },
  });

  // Na tolerância a loja continua vendendo; a equipe vê o aviso
  await expectOrderAccepted(request, store, productId, 'pedido durante a tolerância');
  const overview = await storeOverview(request, store.owner);
  expect(overview.access).toMatchObject({ availability: 'PAST_DUE', canSell: true, canManage: true, message: MSG.pastDueWarning });

  // Pagamento registrado → ACTIVE (sem atraso)
  await platformAction(request, superadmin, `/platform/invoices/${invoice.id}/mark-paid`, { payment_method: 'PIX' });
  const paid = await subscriptionDetail(request, superadmin, sub);
  expect(paid).toMatchObject({ status: 'ACTIVE', past_due_since: null, grace_period_ends_at: null });
  expect(ms(paid.current_period_end), 'o período pago continua o mesmo').toBe(addMonths(trialEnd, 1).getTime());
});

test('fim do teste grátis (plano gratuito) → ACTIVE sem vencimento e sem fatura', async ({ request }) => {
  const store = await createStore(request, superadmin, cleanup, plans.trialFree.id, 'Fim do teste grátis', { open: false });
  const sub = store.subscriptionId;
  const created = await subscriptionDetail(request, superadmin, sub);
  expect(created.status).toBe('TRIALING');
  const [row] = await sql<{ trial_ends_at: Date }>(
    `UPDATE "subscriptions" SET "trial_ends_at" = ${MINUTE_AGO}, "current_period_end" = ${MINUTE_AGO}
      WHERE "id" = $1 AND "status" = 'TRIALING' RETURNING "trial_ends_at"`,
    [sub],
  );
  const detail = await waitForSubscription(request, superadmin, sub, (d) => d.status === 'ACTIVE', 'fim do teste grátis → ACTIVE');
  expect(detail).toMatchObject({ current_period_end: null, past_due_since: null, invoices: [] });
  expect(ms(detail.current_period_start)).toBe(new Date(row.trial_ends_at).getTime());
  expect(statusChange(detail, 'TRIALING', 'ACTIVE')).toMatchObject({ metadata: { trigger: 'lifecycle.trial_end' } });
});

test('renovação: fatura do próximo período; sem pagamento → PAST_DUE; fim da tolerância → SUSPENDED (não vende); pagamento → ACTIVE', async ({
  request,
}) => {
  const { store, productId } = await storeWithProduct(request, plans.paid.id, 'Renovação');
  const sub = store.subscriptionId;
  const first = (await subscriptionDetail(request, superadmin, sub)).invoices[0];
  await platformAction(request, superadmin, `/platform/invoices/${first.id}/mark-paid`, { payment_method: 'PIX' });
  expect((await subscriptionDetail(request, superadmin, sub)).status, '1º período pago').toBe('ACTIVE');

  const [row] = await sql<{ current_period_end: Date }>(
    `UPDATE "subscriptions" SET "current_period_end" = ${MINUTE_AGO}
      WHERE "id" = $1 AND "status" = 'ACTIVE' RETURNING "current_period_end"`,
    [sub],
  );
  expect(row, 'assinatura ativa').toBeTruthy();
  const oldEnd = new Date(row.current_period_end);

  const renewed = await waitForSubscription(
    request,
    superadmin,
    sub,
    (d) => d.status === 'PAST_DUE' && d.invoices.length === 2,
    'renovação com fatura em aberto → PAST_DUE',
  );
  const renewal = (renewed.invoices as Json[]).find((invoice) => invoice.id !== first.id);
  expect(renewal).toMatchObject({ status: 'OPEN', amount: 99.9, plan_id: plans.paid.id });
  expect(ms(renewal.period_start), 'o novo período começa no fim do anterior').toBe(oldEnd.getTime());
  expect(ms(renewal.period_end)).toBe(addMonths(oldEnd, 1).getTime());
  expect(ms(renewal.due_at), 'vence no início do período').toBe(oldEnd.getTime());
  expect(ms(renewed.current_period_start)).toBe(oldEnd.getTime());
  expect(ms(renewed.current_period_end)).toBe(addMonths(oldEnd, 1).getTime());
  expect(eventsOf(renewed, 'PERIOD_RENEWED')[0]).toMatchObject({ metadata: { invoice_id: renewal.id, prepaid: false } });
  await expectOrderAccepted(request, store, productId, 'pedido durante a tolerância');

  // Fim da tolerância: a vitrine para de vender na hora (a situação considera as datas) e a rotina suspende
  await sql(
    `UPDATE "subscriptions" SET "grace_period_ends_at" = ${MINUTE_AGO} WHERE "id" = $1 AND "status" = 'PAST_DUE'`,
    [sub],
  );
  // O cliente recebe a mensagem genérica; a equipe vê a inadimplência no painel
  await expectError(await postOrder(request, store.slug, customer, productId), 403, MSG.storeUnavailable, 'tolerância vencida');
  const suspended = await waitForSubscription(request, superadmin, sub, (d) => d.status === 'SUSPENDED', 'fim da tolerância → SUSPENDED');
  expect(suspended.suspended_at).toBeTruthy();
  expect(suspended.suspended_by, 'suspensão por inadimplência (o pagamento regulariza)').toBe('BILLING');
  expect(statusChange(suspended, 'PAST_DUE', 'SUSPENDED')).toMatchObject({
    actor: null,
    metadata: { trigger: 'lifecycle.grace_ended' },
  });
  await expectError(await postOrder(request, store.slug, customer, productId), 403, MSG.storeUnavailable, 'assinatura suspensa');
  expect((await storeOverview(request, store.owner)).access).toMatchObject({
    message: MSG.subscriptionSuspendedStore,
    availability: 'SUBSCRIPTION_SUSPENDED',
    canSell: false,
    canManageBilling: true,
  });
  // Várias rodadas depois, nada duplicado: uma fatura por período
  expect(suspended.invoices).toHaveLength(2);
  expect(eventsOf(suspended, 'INVOICE_CREATED', renewal.id)).toHaveLength(1);
  expect(eventsOf(suspended, 'PERIOD_RENEWED')).toHaveLength(1);

  // Pagamento confirmado → ACTIVE e a loja volta a vender
  await platformAction(request, superadmin, `/platform/invoices/${renewal.id}/mark-paid`, { payment_method: 'TED' });
  const regularized = await subscriptionDetail(request, superadmin, sub);
  expect(regularized).toMatchObject({
    status: 'ACTIVE',
    suspended_at: null,
    suspended_by: null,
    past_due_since: null,
    grace_period_ends_at: null,
  });
  expect(statusChange(regularized, 'SUSPENDED', 'ACTIVE')).toMatchObject({ metadata: { trigger: 'invoice.paid', invoice_id: renewal.id } });
  await expectOrderAccepted(request, store, productId, 'pedido depois do pagamento');
});

test('cancelamento agendado → CANCELED no fim do período (rotina); faturas de períodos futuros anuladas', async ({ request }) => {
  const { store, productId } = await storeWithProduct(request, plans.paid.id, 'Cancelamento na rotina');
  const sub = store.subscriptionId;
  const first = (await subscriptionDetail(request, superadmin, sub)).invoices[0];
  await platformAction(request, superadmin, `/platform/invoices/${first.id}/mark-paid`, { payment_method: 'PIX' });
  const future = await platformAction(request, superadmin, `/platform/subscriptions/${sub}/invoices`, {}, 201);
  await platformAction(request, superadmin, `/platform/subscriptions/${sub}/cancel`, {
    at_period_end: true,
    reason: 'Encerramento no fim do período (E2E)',
  });
  await expectOrderAccepted(request, store, productId, 'pedido antes do fim do período');

  const [row] = await sql<{ current_period_end: Date }>(
    `UPDATE "subscriptions" SET "current_period_end" = ${MINUTE_AGO}
      WHERE "id" = $1 AND "status" = 'ACTIVE' AND "cancel_at_period_end" RETURNING "current_period_end"`,
    [sub],
  );
  expect(row, 'cancelamento agendado').toBeTruthy();
  const canceled = await waitForSubscription(request, superadmin, sub, (d) => d.status === 'CANCELED', 'fim do período → CANCELED');
  expect(ms(canceled.canceled_at), 'cancelada no fim do período').toBe(new Date(row.current_period_end).getTime());
  expect(statusChange(canceled, 'ACTIVE', 'CANCELED')).toMatchObject({ actor: null, metadata: { trigger: 'lifecycle.period_end' } });
  const byId = new Map((canceled.invoices as Json[]).map((invoice) => [invoice.id, invoice.status]));
  expect(byId.get(first.id), 'fatura paga continua paga').toBe('PAID');
  expect(byId.get(future.id), 'fatura do período seguinte anulada').toBe('VOID');
  expect(canceled.invoices, 'nenhuma renovação depois do cancelamento').toHaveLength(2);

  await expectError(await postPlatform(request, superadmin, `/platform/subscriptions/${sub}/resume`), 409, MSG.subscriptionCanceled, 'desfazer');
  await expectError(await postOrder(request, store.slug, customer, productId), 403, MSG.storeUnavailable, 'vitrine');
});
