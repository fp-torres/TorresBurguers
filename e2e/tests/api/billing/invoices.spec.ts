import { expect, test } from '@playwright/test';
import {
  addMonths,
  ALL_FEATURES,
  bearer,
  Cleanup,
  createPlan,
  createStore,
  defaultSession,
  eventsOf,
  expectError,
  expectNear,
  expectStatus,
  MISSING_ID,
  ms,
  MSG,
  newApi,
  platformAction,
  postPlatform,
  storeOverview,
  subscriptionDetail,
  uid,
  waitForSubscription,
  type BillingStore,
  type Json,
  type Plan,
  type Session,
} from './helpers';

/**
 * Faturas da assinatura (provedor MANUAL, superpainel): fatura do 1º período, fatura avulsa com
 * período/valor/vencimento padrão, registro manual do pagamento (idempotente, sem eventos duplicados,
 * provider_payment_id único, paid_at nunca no futuro), recusa (tentativas) e anulação.
 * Plano pago: a fatura do 1º período vence na contratação, então a rotina pode marcar a assinatura
 * PAST_DUE durante o teste — os testes não dependem disso, salvo quando esperam a rotina.
 */

const cleanup = new Cleanup();
let superadmin: Session;
let paid: Plan;
let trial: Plan;

test.beforeAll(async () => {
  const api = await newApi();
  superadmin = await defaultSession(api, 'superadmin');
  paid = await createPlan(api, superadmin, cleanup, { name: 'Faturas E2E', price: 99.9, features: ALL_FEATURES });
  trial = await createPlan(api, superadmin, cleanup, { name: 'Faturas teste E2E', price: 49.9, trial_days: 10, features: ALL_FEATURES });
  await api.dispose();
});

test.afterAll(async () => {
  await cleanup.run();
});

const invoicePath = (id: number, action: string) => `/platform/invoices/${id}/${action}`;

async function paidStore(request: Parameters<typeof createStore>[0], label: string): Promise<{ store: BillingStore; detail: Json; first: Json }> {
  const store = await createStore(request, superadmin, cleanup, paid.id, label, { open: false });
  const detail = await subscriptionDetail(request, superadmin, store.subscriptionId);
  expect(detail.invoices, 'plano pago: uma fatura do 1º período').toHaveLength(1);
  return { store, detail, first: detail.invoices[0] };
}

async function auditCount(request: Parameters<typeof createStore>[0], action: string, invoiceId: number): Promise<number> {
  const page = await expectStatus(
    await request.get(`/platform/audit?action=${action}&target_type=subscription_invoice&target_id=${invoiceId}`, {
      headers: bearer(superadmin.token),
    }),
    200,
    'GET /platform/audit',
  );
  return page.total as number;
}

test('fatura do 1º período e fatura avulsa com período, valor e vencimento padrão; validações', async ({ request }) => {
  const { store, detail, first } = await paidStore(request, 'Fatura padrão');
  const sub = store.subscriptionId;
  expect(first).toMatchObject({
    subscription_id: sub,
    store_id: store.id,
    plan_id: paid.id,
    status: 'OPEN',
    amount: 99.9,
    currency: 'BRL',
    period_start: detail.current_period_start,
    period_end: detail.current_period_end,
    due_at: detail.current_period_start,
    paid_at: null,
    billing_provider: 'MANUAL',
    provider_payment_id: null,
    attempts: 0,
  });

  // Sem corpo: período seguinte (o atual já tem fatura), preço do plano, vence no início do período
  const next = await platformAction(request, superadmin, `/platform/subscriptions/${sub}/invoices`, {}, 201);
  expect(next).toMatchObject({
    subscription_id: sub,
    status: 'OPEN',
    amount: 99.9,
    period_start: detail.current_period_end,
    due_at: detail.current_period_end,
  });
  expect(ms(next.period_end)).toBe(addMonths(new Date(detail.current_period_end), 1).getTime());
  await expectError(
    await postPlatform(request, superadmin, `/platform/subscriptions/${sub}/invoices`, {}),
    409,
    MSG.invoicePeriodExists,
    'uma fatura válida por período',
  );

  const start = '2030-01-31T12:00:00.000Z';
  const end = '2030-02-28T12:00:00.000Z';
  const custom = await platformAction(
    request,
    superadmin,
    `/platform/subscriptions/${sub}/invoices`,
    { amount: '10.50', period_start: start, period_end: end, due_at: start, notes: '  Ajuste de implantação (E2E)  ' },
    201,
  );
  expect(custom).toMatchObject({ amount: 10.5, period_start: start, period_end: end, due_at: start, status: 'OPEN' });
  expect(custom.notes).toContain('Ajuste de implantação (E2E)');
  expect(await auditCount(request, 'subscription.invoice.create', custom.id), 'fatura avulsa auditada').toBe(1);

  const path = `/platform/subscriptions/${sub}/invoices`;
  for (const [label, data, message] of [
    ['só o início do período', { period_start: start }, MSG.invoicePeriodRequired],
    ['fim antes do início', { period_start: end, period_end: start }, MSG.invoicePeriodInvalid],
    ['valor zero', { amount: 0 }, 'O valor da fatura deve ser maior que zero.'],
    ['valor inválido', { amount: 'dez reais' }, 'Informe um valor válido (ex.: 99.90).'],
    ['data inválida', { period_start: 'ontem', period_end: end }, 'period_start deve ser uma data ISO 8601 (ex.: 2026-10-11T15:00:00Z).'],
    ['observação longa', { notes: 'x'.repeat(301) }, 'As observações podem ter no máximo 300 caracteres.'],
    ['loja no corpo', { store_id: store.id }, MSG.notAllowed('store_id')],
  ] as Array<[string, Record<string, unknown>, string]>) {
    await expectError(await postPlatform(request, superadmin, path, data), 400, message, label);
  }
  await expectError(
    await postPlatform(request, superadmin, `/platform/subscriptions/${MISSING_ID}/invoices`, {}),
    404,
    MSG.subscriptionNotFound,
    'assinatura inexistente',
  );
  const after = await subscriptionDetail(request, superadmin, sub);
  expect(after.invoices, 'as tentativas recusadas não criaram faturas').toHaveLength(3);

  // Painel da loja: as mesmas faturas, sem os campos internos do operador
  const overview = await storeOverview(request, store.owner);
  expect((overview.invoices as Json[]).map((invoice) => invoice.id).sort()).toEqual([first.id, next.id, custom.id].sort());
  for (const invoice of overview.invoices as Json[]) {
    for (const key of ['notes', 'provider_payment_id', 'store_id', 'subscription_id', 'updated_at']) {
      expect(invoice, `fatura ${invoice.id} no painel da loja sem "${key}"`).not.toHaveProperty(key);
    }
  }
});

test('fatura avulsa no teste grátis: o período padrão é o primeiro depois do teste', async ({ request }) => {
  const store = await createStore(request, superadmin, cleanup, trial.id, 'Fatura no teste', { open: false });
  const detail = await subscriptionDetail(request, superadmin, store.subscriptionId);
  expect(detail).toMatchObject({ status: 'TRIALING', invoices: [] });
  const invoice = await platformAction(request, superadmin, `/platform/subscriptions/${store.subscriptionId}/invoices`, {}, 201);
  expect(invoice).toMatchObject({
    status: 'OPEN',
    amount: 49.9,
    plan_id: trial.id,
    period_start: detail.trial_ends_at,
    due_at: detail.trial_ends_at,
  });
  expect(ms(invoice.period_end)).toBe(addMonths(new Date(detail.trial_ends_at), 1).getTime());
  const after = await subscriptionDetail(request, superadmin, store.subscriptionId);
  expect(after, 'o teste grátis continua').toMatchObject({ status: 'TRIALING', trial_ends_at: detail.trial_ends_at });
});

test('registro manual do pagamento é idempotente: sem eventos nem auditoria duplicados', async ({ request }) => {
  const { store, first } = await paidStore(request, 'Pagamento idempotente');
  const payment = { payment_method: 'PIX', provider_payment_id: uid('pix').replace(/-/g, '_'), notes: 'Comprovante conferido (E2E)' };
  const paidAt = Date.now();
  const invoice = await platformAction(request, superadmin, invoicePath(first.id, 'mark-paid'), payment);
  expect(invoice).toMatchObject({
    id: first.id,
    status: 'PAID',
    payment_method: 'PIX',
    provider_payment_id: payment.provider_payment_id,
    notes: payment.notes,
  });
  expectNear(invoice.paid_at, paidAt, 120_000, 'paid_at padrão = agora');
  const stored = (await subscriptionDetail(request, superadmin, store.subscriptionId)).invoices.find(
    (item: Json) => item.id === first.id,
  );

  const repeated = await platformAction(request, superadmin, invoicePath(first.id, 'mark-paid'), payment);
  const withoutId = await platformAction(request, superadmin, invoicePath(first.id, 'mark-paid'), { payment_method: 'Boleto' });
  for (const again of [repeated, withoutId]) {
    expect(again, 'a fatura paga volta como está (nada é gravado de novo)').toMatchObject({
      status: 'PAID',
      paid_at: invoice.paid_at,
      provider_payment_id: payment.provider_payment_id,
      payment_method: 'PIX',
      updated_at: stored.updated_at,
    });
  }
  const detail = await subscriptionDetail(request, superadmin, store.subscriptionId);
  expect(eventsOf(detail, 'PAYMENT_SUCCEEDED', first.id), 'um único evento de pagamento').toHaveLength(1);
  expect(await auditCount(request, 'subscription.invoice.mark_paid', first.id), 'uma única auditoria').toBe(1);
  expect(detail).toMatchObject({ status: 'ACTIVE', past_due_since: null, grace_period_ends_at: null });

  await expectError(
    await postPlatform(request, superadmin, invoicePath(first.id, 'mark-paid'), { provider_payment_id: uid('outro') }),
    409,
    MSG.paidWithOtherPayment,
    'fatura paga com outro pagamento',
  );
  expect(eventsOf(await subscriptionDetail(request, superadmin, store.subscriptionId), 'PAYMENT_SUCCEEDED', first.id)).toHaveLength(1);
});

test('o mesmo pagamento não quita duas faturas (409) e paid_at nunca fica no futuro (400)', async ({ request }) => {
  const { store, first } = await paidStore(request, 'Pagamento único');
  const next = await platformAction(request, superadmin, `/platform/subscriptions/${store.subscriptionId}/invoices`, {}, 201);
  const paymentId = `mp_${uid('pay').replace(/-/g, '_')}`;
  await platformAction(request, superadmin, invoicePath(first.id, 'mark-paid'), { provider_payment_id: paymentId });
  await expectError(
    await postPlatform(request, superadmin, invoicePath(next.id, 'mark-paid'), { provider_payment_id: paymentId }),
    409,
    MSG.providerPaymentUsed,
    'mesmo provider_payment_id em outra fatura',
  );

  const inOneHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await expectError(
    await postPlatform(request, superadmin, invoicePath(next.id, 'mark-paid'), { paid_at: inOneHour }),
    400,
    MSG.paidAtFuture,
    'paid_at no futuro',
  );
  await expectError(
    await postPlatform(request, superadmin, invoicePath(next.id, 'mark-paid'), { paid_at: 'amanhã' }),
    400,
    'paid_at deve ser uma data ISO 8601 (ex.: 2026-10-11T15:00:00Z).',
    'paid_at inválido',
  );
  await expectError(
    await postPlatform(request, superadmin, invoicePath(next.id, 'mark-paid'), { provider_payment_id: 'pagamento #1' }),
    400,
    'Identificador do pagamento inválido: use letras, números, ponto, hífen, barra ou sublinhado.',
    'provider_payment_id com caracteres inválidos',
  );
  const stillOpen = (await subscriptionDetail(request, superadmin, store.subscriptionId)).invoices.find(
    (invoice: Json) => invoice.id === next.id,
  );
  expect(stillOpen, 'as tentativas recusadas não pagaram a fatura').toMatchObject({ status: 'OPEN', paid_at: null });

  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const late = await platformAction(request, superadmin, invoicePath(next.id, 'mark-paid'), {
    paid_at: twoDaysAgo,
    provider_payment_id: `${paymentId}_2`,
    payment_method: 'TED',
  });
  expect(late).toMatchObject({ status: 'PAID', paid_at: twoDaysAgo, provider_payment_id: `${paymentId}_2` });
});

test('recusa: a fatura continua devida e conta as tentativas; paga não volta a falhar', async ({ request }) => {
  const { store, first } = await paidStore(request, 'Pagamento recusado');
  // Motivo obrigatório (impacto financeiro): sem ele → 400 e nada muda
  for (const data of [{}, { reason: '   ' }]) {
    await expectError(
      await postPlatform(request, superadmin, invoicePath(first.id, 'mark-failed'), data),
      400,
      'Informe o motivo da recusa do pagamento.',
      `recusar sem motivo ${JSON.stringify(data)}`,
    );
  }
  const failed = await platformAction(request, superadmin, invoicePath(first.id, 'mark-failed'), { reason: 'Cartão recusado (E2E)' });
  expect(failed).toMatchObject({ id: first.id, status: 'FAILED', attempts: 1, failure_reason: 'Cartão recusado (E2E)', paid_at: null });
  // A resposta traz a linha gravada (updated_at da mudança, não o de antes)
  const storedFailed = (await subscriptionDetail(request, superadmin, store.subscriptionId)).invoices.find((item: Json) => item.id === first.id);
  expect(failed.updated_at, 'updated_at da resposta = o gravado').toBe(storedFailed.updated_at);
  const again = await platformAction(request, superadmin, invoicePath(first.id, 'mark-failed'), { reason: 'Saldo insuficiente (E2E)' });
  expect(again).toMatchObject({ status: 'FAILED', attempts: 2, failure_reason: 'Saldo insuficiente (E2E)' });
  const detail = await subscriptionDetail(request, superadmin, store.subscriptionId);
  expect(eventsOf(detail, 'PAYMENT_FAILED', first.id)).toHaveLength(2);
  const storeView = (await storeOverview(request, store.owner)).invoices.find((invoice: Json) => invoice.id === first.id);
  expect(storeView, 'a loja vê a recusa e as tentativas').toMatchObject({ status: 'FAILED', attempts: 2, failure_reason: 'Saldo insuficiente (E2E)' });

  const paidInvoice = await platformAction(request, superadmin, invoicePath(first.id, 'mark-paid'), { payment_method: 'PIX' });
  expect(paidInvoice).toMatchObject({ status: 'PAID', attempts: 2 });
  const storedPaid = (await subscriptionDetail(request, superadmin, store.subscriptionId)).invoices.find((item: Json) => item.id === first.id);
  expect(paidInvoice.updated_at, 'updated_at da resposta do pagamento = o gravado').toBe(storedPaid.updated_at);
  await expectError(
    await postPlatform(request, superadmin, invoicePath(first.id, 'mark-failed'), { reason: 'Tentativa (E2E)' }),
    409,
    MSG.invoiceAlreadyPaid,
    'recusar paga',
  );
});

test('anulação: idempotente; anulada não é paga nem recusada; paga não anula; atraso anulado volta a ACTIVE', async ({ request }) => {
  const { store, first } = await paidStore(request, 'Anulação');
  const sub = store.subscriptionId;
  const next = await platformAction(request, superadmin, `/platform/subscriptions/${sub}/invoices`, {}, 201);

  // Motivo obrigatório (a fatura deixa de ser cobrada): sem ele → 400 e a fatura continua em aberto
  for (const data of [{}, { reason: '' }, { reason: null }]) {
    await expectError(
      await postPlatform(request, superadmin, invoicePath(next.id, 'void'), data),
      400,
      'Informe o motivo da anulação.',
      `anular sem motivo ${JSON.stringify(data)}`,
    );
  }
  expect((await subscriptionDetail(request, superadmin, sub)).invoices.find((item: Json) => item.id === next.id).status).toBe('OPEN');

  const voided = await platformAction(request, superadmin, invoicePath(next.id, 'void'), { reason: 'Lançada por engano (E2E)' });
  expect(voided).toMatchObject({ id: next.id, status: 'VOID', paid_at: null });
  const stored = (await subscriptionDetail(request, superadmin, sub)).invoices.find((item: Json) => item.id === next.id);
  expect(voided.updated_at, 'updated_at da resposta = o gravado na anulação').toBe(stored.updated_at);
  const again = await platformAction(request, superadmin, invoicePath(next.id, 'void'), { reason: 'De novo (E2E)' });
  expect(again, 'anular de novo não grava nada').toMatchObject({ status: 'VOID', updated_at: stored.updated_at });
  expect(await auditCount(request, 'subscription.invoice.void', next.id), 'anular de novo não audita de novo').toBe(1);
  await expectError(await postPlatform(request, superadmin, invoicePath(next.id, 'mark-paid'), {}), 409, MSG.invoiceVoid, 'pagar anulada');
  await expectError(
    await postPlatform(request, superadmin, invoicePath(next.id, 'mark-failed'), { reason: 'Tentativa (E2E)' }),
    409,
    MSG.invoiceVoid,
    'recusar anulada',
  );

  // Fatura anulada não ocupa o período: ele pode ser faturado de novo; a nova fatura paga não é anulada
  const rebilled = await platformAction(
    request,
    superadmin,
    `/platform/subscriptions/${sub}/invoices`,
    { period_start: next.period_start, period_end: next.period_end },
    201,
  );
  expect(rebilled).toMatchObject({ status: 'OPEN', period_start: next.period_start, amount: 99.9 });
  await platformAction(request, superadmin, invoicePath(rebilled.id, 'mark-paid'), { payment_method: 'PIX' });
  await expectError(
    await postPlatform(request, superadmin, invoicePath(rebilled.id, 'void'), { reason: 'Tentativa (E2E)' }),
    409,
    MSG.paidInvoiceVoid,
    'anular paga',
  );

  // A fatura do 1º período venceu na contratação: a rotina marca PAST_DUE; anulá-la regulariza
  await waitForSubscription(request, superadmin, sub, (detail) => detail.status === 'PAST_DUE', 'fatura vencida → PAST_DUE');
  await platformAction(request, superadmin, invoicePath(first.id, 'void'), { reason: 'Cortesia de implantação (E2E)' });
  const restored = await subscriptionDetail(request, superadmin, sub);
  expect(restored).toMatchObject({ status: 'ACTIVE', past_due_since: null, grace_period_ends_at: null });
  expect(eventsOf(restored, 'STATUS_CHANGED')[0]).toMatchObject({
    from_status: 'PAST_DUE',
    to_status: 'ACTIVE',
    metadata: { trigger: 'invoice.void', invoice_id: first.id },
  });
});

test('fatura inexistente → 404; só o superadmin registra pagamentos; lista por loja e situação', async ({ request }) => {
  const { store, first } = await paidStore(request, 'Lista de faturas');
  for (const action of ['mark-paid', 'mark-failed', 'void']) {
    const data = action === 'mark-paid' ? {} : { reason: 'Fatura inexistente (E2E)' };
    await expectError(await postPlatform(request, superadmin, invoicePath(MISSING_ID, action), data), 404, MSG.invoiceNotFound, action);
  }
  for (const action of ['mark-paid', 'void']) {
    await expectError(
      await request.post(invoicePath(first.id, action), { headers: bearer(store.owner.token), data: {} }),
      403,
      MSG.platformOnly,
      `ADMIN da loja: ${action}`,
    );
  }
  const headers = bearer(superadmin.token);
  const open = await expectStatus(await request.get(`/platform/invoices?search=${store.slug}&status=open`, { headers }), 200);
  expect(open).toMatchObject({ total: 1, page: 1 });
  expect(open.items[0]).toMatchObject({
    id: first.id,
    status: 'OPEN',
    store: { id: store.id, slug: store.slug, name: store.name },
  });
  const paidPage = await expectStatus(await request.get(`/platform/invoices?search=${store.slug}&status=PAID`, { headers }), 200);
  expect(paidPage.total).toBe(0);
  await expectError(
    await request.get('/platform/invoices?status=PENDING', { headers }),
    400,
    'Situação da fatura inválida. Use OPEN, PAID, FAILED ou VOID.',
    'situação desconhecida',
  );
});
