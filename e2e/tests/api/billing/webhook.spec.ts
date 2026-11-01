import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  ALL_FEATURES,
  Cleanup,
  createPlan,
  createStore,
  defaultSession,
  deliverWebhook,
  eventsOf,
  expectError,
  expectStatus,
  mercadoPagoSignature,
  MSG,
  newApi,
  sql,
  subscriptionDetail,
  webhookEvents,
  WEBHOOK_PATH,
  type BillingStore,
  type Session,
} from './helpers';

/**
 * Notificações da cobrança SaaS (POST /billing/webhook/mercadopago — conta Mercado Pago da PLATAFORMA,
 * separada do webhook do delivery). A autenticidade vem do x-signature (MP_SAAS_WEBHOOK_SECRET =
 * e2e-saas-webhook-secret na API de teste); notificações repetidas são deduplicadas por
 * billing_webhook_events (provider + event_key) e nunca geram efeitos duplicados.
 *
 * Na API de teste a cobrança online está desligada (SAAS_BILLING_PROVIDER=MANUAL, sem MP_SAAS_ACCESS_TOKEN):
 * não há o que reconsultar no Mercado Pago, então a notificação válida é registrada como IGNORED e
 * respondida com 200 (com 503 o Mercado Pago reenviaria para sempre). Os testes cobrem a assinatura,
 * o registro e a deduplicação (o processamento depende do Mercado Pago real).
 */

const cleanup = new Cleanup();
let superadmin: Session;
let store: BillingStore;

test.beforeAll(async () => {
  const api = await newApi();
  superadmin = await defaultSession(api, 'superadmin');
  const plan = await createPlan(api, superadmin, cleanup, { name: 'Webhook E2E', price: 39.9, features: ALL_FEATURES });
  store = await createStore(api, superadmin, cleanup, plan.id, 'Webhook', { open: false });
  await api.dispose();
});

test.afterAll(async () => {
  await cleanup.run();
});

/** data.id numérico único (como os ids de pagamento do Mercado Pago). */
function paymentId(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
}

test('assinatura ausente, inválida, malformada ou expirada → 401; sem data.id → 400; nada é registrado', async ({ request }) => {
  const dataId = paymentId();
  const delivery = { dataId, notificationId: `notif-${randomUUID()}` };
  const requestId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const cases: Array<[string, Record<string, string>]> = [
    ['sem x-signature', { 'x-request-id': requestId }],
    ['segredo errado', { 'x-signature': mercadoPagoSignature({ dataId, requestId, secret: 'outro-segredo' }), 'x-request-id': requestId }],
    [
      'assinatura de outro recurso',
      { 'x-signature': mercadoPagoSignature({ dataId: paymentId(), requestId }), 'x-request-id': requestId },
    ],
    [
      'x-request-id trocado',
      { 'x-signature': mercadoPagoSignature({ dataId, requestId }), 'x-request-id': randomUUID() },
    ],
    ['v1 malformado', { 'x-signature': `ts=${now},v1=nao-e-hex`, 'x-request-id': requestId }],
    ['sem ts', { 'x-signature': `v1=${'a'.repeat(64)}`, 'x-request-id': requestId }],
    [
      'reenvio antigo (ts de 10 min atrás)',
      { 'x-signature': mercadoPagoSignature({ dataId, requestId, ts: now - 600 }), 'x-request-id': requestId },
    ],
  ];
  for (const [label, headers] of cases) {
    await expectError(await deliverWebhook(request, delivery, headers), 401, MSG.webhookInvalidSignature, label);
  }
  await expectError(
    await request.post(WEBHOOK_PATH, {
      headers: { 'x-signature': mercadoPagoSignature({ dataId, requestId }), 'x-request-id': requestId },
      data: { type: 'payment', action: 'payment.updated' },
    }),
    400,
    MSG.webhookInvalidNotification,
    'sem data.id',
  );
  expect(await webhookEvents(dataId), 'notificação recusada não é registrada').toEqual([]);
});

test('assinatura válida: registrada uma vez; reentregas deduplicadas, sem efeito na assinatura (corpo não confiável)', async ({
  request,
}) => {
  const before = await subscriptionDetail(request, superadmin, store.subscriptionId);
  const invoice = before.invoices[0];
  expect(invoice.status).toBe('OPEN');

  const dataId = paymentId();
  const delivery = {
    dataId,
    // Id da notificação no corpo: até 40 caracteres entram na chave de idempotência
    notificationId: randomUUID(),
    // O corpo "diz" que a fatura foi paga: nada disso é confiável (o recurso é reconsultado no provedor)
    extraBody: {
      status: 'approved',
      external_reference: `comestra-assinatura-${store.subscriptionId}`,
      transaction_amount: invoice.amount,
    },
  };

  // Cobrança online desligada (MANUAL, sem MP_SAAS_ACCESS_TOKEN): 200 "ignored" e registro IGNORED
  // (com 503 o Mercado Pago reenviaria para sempre uma notificação que nunca poderá ser processada)
  const first = await expectStatus(await deliverWebhook(request, delivery), 200, 'notificação válida com a cobrança online desligada');
  expect(first).toEqual({ status: 'ok', result: 'ignored' });
  const recorded = await webhookEvents(dataId);
  expect(recorded, 'uma notificação registrada').toHaveLength(1);
  expect(recorded[0]).toMatchObject({
    provider: 'MERCADO_PAGO',
    event_key: `payment:${dataId}:payment.updated:${delivery.notificationId}`,
    topic: 'payment',
    resource_id: dataId,
    status: 'IGNORED',
    error: MSG.webhookProviderOff,
  });
  expect(recorded[0].processed_at, 'concluída na hora').not.toBeNull();

  // Reentrega da MESMA notificação (novo x-request-id e ts): mesma chave, 200 "duplicate" sem reprocessar
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const duplicate = await expectStatus(await deliverWebhook(request, delivery), 200, `reentrega ${attempt} da notificação`);
    expect(duplicate).toEqual({ status: 'ok', result: 'duplicate' });
  }
  const afterRetry = await webhookEvents(dataId);
  expect(afterRetry, 'registro intocado pelas reentregas').toEqual(recorded);

  // Uma notificação que falhou (ex.: provedor fora do ar) é reprocessada na reentrega (simulado no banco)
  await sql(`UPDATE "billing_webhook_events" SET "status" = 'FAILED', "processed_at" = NULL WHERE "id" = $1`, [recorded[0].id]);
  expect(await expectStatus(await deliverWebhook(request, delivery), 200, 'reentrega de notificação que falhou')).toEqual({
    status: 'ok',
    result: 'ignored',
  });
  const [reprocessed] = await webhookEvents(dataId);
  expect(reprocessed).toMatchObject({ id: recorded[0].id, status: 'IGNORED' });

  // Outra notificação do mesmo recurso (id diferente) é outro evento
  expect(
    await expectStatus(await deliverWebhook(request, { ...delivery, notificationId: randomUUID() }), 200, 'outra notificação'),
  ).toEqual({ status: 'ok', result: 'ignored' });
  expect(await webhookEvents(dataId), 'nova notificação = novo registro').toHaveLength(2);

  // Nenhum efeito na cobrança: a fatura continua em aberto e nenhum pagamento foi registrado
  const after = await subscriptionDetail(request, superadmin, store.subscriptionId);
  expect(after.invoices.find((item: { id: number }) => item.id === invoice.id)).toMatchObject({
    status: 'OPEN',
    paid_at: null,
    provider_payment_id: null,
  });
  expect(after.invoices).toHaveLength(before.invoices.length);
  expect(eventsOf(after, 'PAYMENT_SUCCEEDED')).toEqual([]);
});

test('o webhook do delivery não aceita notificações da cobrança SaaS como suas', async ({ request }) => {
  // Fluxos separados: a notificação da plataforma enviada ao webhook do delivery não cria registro da cobrança
  const dataId = paymentId();
  const requestId = randomUUID();
  const res = await request.post(`/payment/webhook?data.id=${dataId}&type=payment`, {
    headers: { 'x-signature': mercadoPagoSignature({ dataId, requestId }), 'x-request-id': requestId },
    data: { id: `notif-${randomUUID()}`, type: 'payment', action: 'payment.updated', data: { id: dataId } },
  });
  expect(await expectStatus(res, 200, 'POST /payment/webhook'), 'o delivery só confirma o recebimento').toEqual({ status: 'ok' });
  expect(await webhookEvents(dataId), 'nenhum registro em billing_webhook_events').toEqual([]);
});
