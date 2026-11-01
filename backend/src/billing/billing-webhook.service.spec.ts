import {
  BadRequestException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac } from 'crypto';
import {
  BILLING_PROVIDER_OFF_NOTE,
  BillingWebhookService,
  INVALID_SIGNATURE_MESSAGE,
  parseMercadoPagoNotification,
  STALE_WEBHOOK_MS,
  WEBHOOK_NOT_CONFIGURED_MESSAGE,
  WEBHOOK_RETRY_MESSAGE,
  webhookEventKey,
} from './billing-webhook.service';
import { BillingWebhookEvent } from './entities/billing-webhook-event.entity';
import { InvoiceStatus } from './entities/subscription-invoice.entity';
import {
  Subscription,
  SubscriptionStatus,
} from './entities/subscription.entity';
import { normalizeDataId, signatureManifest } from './mercado-pago-signature';
import {
  createBillingDb,
  createSubscriptionsService,
  days,
  NOW,
  rowsWhere,
  seedInvoice,
  seedPlan,
  seedSettings,
  seedStore,
  seedSubscription,
} from './testing/billing-fixtures.helper-spec';

const SECRET = 'segredo-webhook-saas';
const TS = Math.floor(NOW.getTime() / 1000);

function notification(
  dataId: string,
  options: {
    type?: string;
    action?: string;
    id?: number;
    requestId?: string;
    secret?: string;
    /** Instante da assinatura (segundos). */
    ts?: number;
  } = {},
) {
  const type = options.type ?? 'subscription_authorized_payment';
  const requestId = options.requestId ?? 'req-1';
  const ts = options.ts ?? TS;
  const manifest = signatureManifest(
    normalizeDataId(dataId)!,
    requestId,
    String(ts),
  );
  const v1 = createHmac('sha256', options.secret ?? SECRET)
    .update(manifest)
    .digest('hex');
  return {
    headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId },
    query: { 'data.id': dataId, type },
    body: {
      id: options.id ?? 1001,
      type,
      action: options.action ?? 'updated',
      data: { id: dataId },
    },
    now: NOW,
  };
}

function setup() {
  const db = createBillingDb();
  seedSettings(db);
  seedStore(db, { id: 7 });
  const plan = seedPlan(db);
  const subscription = seedSubscription(db, {
    store_id: 7,
    plan_id: plan.id,
    status: SubscriptionStatus.PAST_DUE,
    past_due_since: days(NOW, -2),
    grace_period_ends_at: days(NOW, 5),
    billing_provider: 'MERCADO_PAGO',
    provider_subscription_id: 'pre-1',
    provider_status: 'authorized',
  });
  const invoice = seedInvoice(db, {
    subscription_id: subscription.id,
    store_id: 7,
    plan_id: plan.id,
    due_at: days(NOW, -2),
  });
  const services = createSubscriptionsService(db);
  const mercadoPago = {
    getPreapproval: jest.fn(),
    getAuthorizedPayment: jest.fn(),
    getPayment: jest.fn(),
  };
  services.providers.mercadoPago.mockReturnValue(mercadoPago);
  const webhooks = new BillingWebhookService(
    db.repository(BillingWebhookEvent) as never,
    db.repository(Subscription) as never,
    services.service,
    services.providers as never,
  );
  return {
    db,
    plan,
    subscription,
    invoice,
    mercadoPago,
    webhooks,
    ...services,
  };
}

const approved = (paymentId: number) => ({
  id: 7001,
  preapproval_id: 'pre-1',
  external_reference: 'comestra-assinatura-1',
  status: 'processed',
  transaction_amount: 99.9,
  payment: { id: paymentId, status: 'approved', status_detail: 'accredited' },
});

describe('BillingWebhookService (POST /billing/webhook/mercadopago)', () => {
  const saved = process.env.MP_SAAS_WEBHOOK_SECRET;
  beforeAll(() => {
    Logger.overrideLogger(false);
  });
  beforeEach(() => {
    process.env.MP_SAAS_WEBHOOK_SECRET = SECRET;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.MP_SAAS_WEBHOOK_SECRET;
    else process.env.MP_SAAS_WEBHOOK_SECRET = saved;
  });

  it('sem segredo configurado → 503', async () => {
    delete process.env.MP_SAAS_WEBHOOK_SECRET;
    const { webhooks } = setup();
    await expect(
      webhooks.handleMercadoPago(notification('7001')),
    ).rejects.toThrow(
      new ServiceUnavailableException(WEBHOOK_NOT_CONFIGURED_MESSAGE),
    );
  });

  it('assinatura inválida → 401, sem registrar nem consultar o provedor', async () => {
    const { db, webhooks, mercadoPago } = setup();
    await expect(
      webhooks.handleMercadoPago(notification('7001', { secret: 'outro' })),
    ).rejects.toThrow(new UnauthorizedException(INVALID_SIGNATURE_MESSAGE));

    // data.id trocado depois de assinado
    const tampered = notification('7001');
    tampered.query['data.id'] = '7002';
    await expect(webhooks.handleMercadoPago(tampered)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(rowsWhere(db, 'billing_webhook_events')).toHaveLength(0);
    expect(mercadoPago.getAuthorizedPayment).not.toHaveBeenCalled();
  });

  it('sem data.id → 400', async () => {
    const { webhooks } = setup();
    const request = notification('7001');
    await expect(
      webhooks.handleMercadoPago({ ...request, query: {}, body: {} }),
    ).rejects.toThrow(BadRequestException);
  });

  it('cobrança aprovada (reconsultada no Mercado Pago) quita a fatura e reativa a assinatura', async () => {
    const { db, webhooks, mercadoPago, invoice, subscription } = setup();
    mercadoPago.getAuthorizedPayment.mockResolvedValue(approved(555));

    await expect(
      webhooks.handleMercadoPago(notification('7001')),
    ).resolves.toBe('processed');

    expect(mercadoPago.getAuthorizedPayment).toHaveBeenCalledWith('7001');
    expect(
      rowsWhere(db, 'subscription_invoices', (row) => row.id === invoice.id)[0],
    ).toMatchObject({
      status: InvoiceStatus.PAID,
      provider_payment_id: '555',
    });
    expect(
      rowsWhere(db, 'subscriptions', (row) => row.id === subscription.id)[0]
        .status,
    ).toBe(SubscriptionStatus.ACTIVE);
    expect(rowsWhere(db, 'billing_webhook_events')).toEqual([
      expect.objectContaining({
        provider: 'MERCADO_PAGO',
        topic: 'subscription_authorized_payment',
        resource_id: '7001',
        status: 'PROCESSED',
        processed_at: NOW,
      }),
    ]);
  });

  it('notificação repetida → 200 sem reprocessar; outra notificação do mesmo pagamento não paga de novo', async () => {
    const { db, webhooks, mercadoPago } = setup();
    mercadoPago.getAuthorizedPayment.mockResolvedValue(approved(555));

    await webhooks.handleMercadoPago(notification('7001'));
    await expect(
      webhooks.handleMercadoPago(notification('7001')),
    ).resolves.toBe('duplicate');
    expect(mercadoPago.getAuthorizedPayment).toHaveBeenCalledTimes(1);

    // Mesmo pagamento por outra notificação (ex.: tópico payment): idempotente pelo provider_payment_id
    await webhooks.handleMercadoPago(notification('7001', { id: 1002 }));
    expect(
      rowsWhere(db, 'subscription_invoices', (row) => row.status === 'PAID'),
    ).toHaveLength(1);
  });

  it('cobrança recusada → fatura FAILED (+1 tentativa)', async () => {
    const { db, webhooks, mercadoPago, invoice } = setup();
    mercadoPago.getAuthorizedPayment.mockResolvedValue({
      ...approved(556),
      status: 'recycling',
      payment: {
        id: 556,
        status: 'rejected',
        status_detail: 'cc_rejected_insufficient_amount',
      },
    });

    await webhooks.handleMercadoPago(notification('7002'));

    expect(
      rowsWhere(db, 'subscription_invoices', (row) => row.id === invoice.id)[0],
    ).toMatchObject({
      status: InvoiceStatus.FAILED,
      attempts: 1,
      failure_reason: 'cc_rejected_insufficient_amount',
    });
  });

  it('recurso inexistente no Mercado Pago (404) → ignorada', async () => {
    const { db, webhooks, mercadoPago } = setup();
    mercadoPago.getAuthorizedPayment.mockRejectedValue({
      status: 404,
      message: 'not found',
    });
    await expect(webhooks.handleMercadoPago(notification('123'))).resolves.toBe(
      'ignored',
    );
    expect(rowsWhere(db, 'billing_webhook_events')[0]).toMatchObject({
      status: 'IGNORED',
      error: 'Recurso não encontrado no Mercado Pago.',
    });
  });

  it('falha temporária → 503 (o Mercado Pago reenvia) e a reentrega é reprocessada', async () => {
    const { db, webhooks, mercadoPago } = setup();
    mercadoPago.getAuthorizedPayment
      .mockRejectedValueOnce({ status: 500, message: 'internal_error' })
      .mockResolvedValueOnce(approved(557));

    await expect(
      webhooks.handleMercadoPago(notification('7003')),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(rowsWhere(db, 'billing_webhook_events')[0]).toMatchObject({
      status: 'FAILED',
      error: 'internal_error',
    });

    await expect(
      webhooks.handleMercadoPago(notification('7003')),
    ).resolves.toBe('processed');
    expect(rowsWhere(db, 'billing_webhook_events')).toEqual([
      expect.objectContaining({ status: 'PROCESSED' }),
    ]);
  });

  it('MERCADO_PAGO sem MP_SAAS_ACCESS_TOKEN (configuração incompleta): falha (503) para o reenvio', async () => {
    const { db, webhooks, providers } = setup();
    providers.mercadoPago.mockReturnValue(null);
    providers.configuredCode.mockReturnValue('MERCADO_PAGO' as never);
    await expect(
      webhooks.handleMercadoPago(notification('7004')),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(rowsWhere(db, 'billing_webhook_events')[0].status).toBe('FAILED');
  });

  it('cobrança online desligada (MANUAL, sem MP_SAAS_ACCESS_TOKEN): 200 "ignored" e IGNORED; reentrega = duplicate', async () => {
    const { db, webhooks, providers, invoice } = setup();
    providers.mercadoPago.mockReturnValue(null);
    providers.configuredCode.mockReturnValue('MANUAL');
    await expect(
      webhooks.handleMercadoPago(notification('7005')),
    ).resolves.toBe('ignored');
    expect(rowsWhere(db, 'billing_webhook_events')).toEqual([
      expect.objectContaining({
        status: 'IGNORED',
        error: BILLING_PROVIDER_OFF_NOTE,
      }),
    ]);
    // A mesma notificação de novo: concluída, sem reprocessar (o Mercado Pago para de reenviar)
    await expect(
      webhooks.handleMercadoPago(notification('7005')),
    ).resolves.toBe('duplicate');
    expect(rowsWhere(db, 'billing_webhook_events')).toHaveLength(1);
    expect(
      rowsWhere(db, 'subscription_invoices', (row) => row.id === invoice.id)[0]
        .status,
    ).toBe(InvoiceStatus.OPEN);
  });

  it('reentrega com a anterior ainda em andamento → 503; travada há muito tempo → reprocessa', async () => {
    const { db, webhooks, mercadoPago } = setup();
    mercadoPago.getAuthorizedPayment.mockResolvedValue(approved(558));
    const request = notification('7005');
    const key = webhookEventKey(
      parseMercadoPagoNotification(request.query, request.body)!,
      NOW.getTime(),
    );
    db.seed('billing_webhook_events', {
      provider: 'MERCADO_PAGO',
      event_key: key,
      topic: 'subscription_authorized_payment',
      resource_id: '7005',
      status: 'RECEIVED',
      error: null,
      received_at: new Date(NOW.getTime() - 60_000),
      processed_at: null,
    });

    await expect(webhooks.handleMercadoPago(request)).rejects.toThrow(
      new ServiceUnavailableException(WEBHOOK_RETRY_MESSAGE),
    );
    expect(mercadoPago.getAuthorizedPayment).not.toHaveBeenCalled();

    // A entrega anterior "travou" (API caiu no meio): passado o prazo, a reentrega (mesmo id de
    // notificação, assinada de novo) assume e processa
    const later = new Date(NOW.getTime() + STALE_WEBHOOK_MS);
    db.now = () => later;
    const redelivery = {
      ...notification('7005', { ts: Math.floor(later.getTime() / 1000) }),
      now: later,
    };
    await expect(webhooks.handleMercadoPago(redelivery)).resolves.toBe(
      'processed',
    );
    expect(rowsWhere(db, 'billing_webhook_events')).toEqual([
      expect.objectContaining({ event_key: key, status: 'PROCESSED' }),
    ]);
  });

  it('preapproval: atualiza a situação da cobrança recorrente', async () => {
    const { db, webhooks, mercadoPago, subscription } = setup();
    mercadoPago.getPreapproval.mockResolvedValue({
      id: 'pre-1',
      status: 'paused',
      external_reference: `comestra-assinatura-${subscription.id}`,
    });

    await expect(
      webhooks.handleMercadoPago(
        notification('pre-1', { type: 'subscription_preapproval' }),
      ),
    ).resolves.toBe('processed');
    expect(
      rowsWhere(db, 'subscriptions', (row) => row.id === subscription.id)[0]
        .provider_status,
    ).toBe('paused');
  });

  it('pagamento (tópico payment) de assinatura nossa, pelo external_reference', async () => {
    const { db, webhooks, mercadoPago, subscription, invoice } = setup();
    mercadoPago.getPayment.mockResolvedValue({
      id: 888,
      status: 'approved',
      transaction_amount: 99.9,
      external_reference: `comestra-assinatura-${subscription.id}`,
      date_approved: '2026-10-11T11:00:00.000Z',
    });

    await webhooks.handleMercadoPago(notification('888', { type: 'payment' }));

    expect(
      rowsWhere(db, 'subscription_invoices', (row) => row.id === invoice.id)[0],
    ).toMatchObject({
      status: InvoiceStatus.PAID,
      provider_payment_id: '888',
      paid_at: new Date('2026-10-11T11:00:00.000Z'),
    });
  });

  it('cobrança de outra autorização (órfã, de um checkout repetido): a órfã é cancelada no Mercado Pago', async () => {
    const { db, webhooks, mercadoPago, providers, subscription } = setup();
    const cancelSubscription = jest.fn().mockResolvedValue(undefined);
    providers.forCode.mockReturnValue({ online: true, cancelSubscription });
    mercadoPago.getAuthorizedPayment.mockResolvedValue({
      ...approved(556),
      preapproval_id: 'pre-orfa',
      external_reference: `comestra-assinatura-${subscription.id}`,
    });
    await webhooks.handleMercadoPago(notification('7002'));
    expect(cancelSubscription).toHaveBeenCalledWith('pre-orfa');

    // Tópico payment: a autorização vem em metadata.preapproval_id
    mercadoPago.getPayment.mockResolvedValue({
      id: 889,
      status: 'approved',
      transaction_amount: 99.9,
      external_reference: `comestra-assinatura-${subscription.id}`,
      metadata: { preapproval_id: 'pre-orfa-2' },
    });
    await webhooks.handleMercadoPago(
      notification('889', { type: 'payment', id: 1002 }),
    );
    expect(cancelSubscription).toHaveBeenCalledWith('pre-orfa-2');
    expect(
      rowsWhere(db, 'subscriptions', (row) => row.id === subscription.id)[0],
    ).toMatchObject({
      provider_subscription_id: 'pre-1',
      provider_status: 'authorized',
    });
  });

  it('pagamento que não é de uma assinatura da plataforma e tópico desconhecido → ignorados', async () => {
    const { db, webhooks, mercadoPago } = setup();
    mercadoPago.getPayment.mockResolvedValue({
      id: 999,
      status: 'approved',
      external_reference: 'pedido-123',
    });
    await expect(
      webhooks.handleMercadoPago(notification('999', { type: 'payment' })),
    ).resolves.toBe('ignored');
    await expect(
      webhooks.handleMercadoPago(
        notification('5', { type: 'merchant_order', id: 2 }),
      ),
    ).resolves.toBe('ignored');
    expect(
      rowsWhere(db, 'subscription_invoices', (row) => row.status === 'PAID'),
    ).toHaveLength(0);
  });

  describe('chave de idempotência', () => {
    it('tópico, recurso, ação e id da notificação (o mesmo nas reentregas)', () => {
      const parsed = parseMercadoPagoNotification(
        { 'data.id': 'ABC123', type: 'subscription_preapproval' },
        { id: 42, action: 'updated' },
      );
      expect(parsed).toEqual({
        topic: 'subscription_preapproval',
        dataId: 'abc123',
        action: 'updated',
        notificationId: '42',
      });
      expect(webhookEventKey(parsed!, 1)).toBe(
        'subscription_preapproval:abc123:updated:42',
      );
      // Sem id no corpo: o instante assinado diferencia as notificações
      expect(
        webhookEventKey({ ...parsed!, notificationId: null }, 1791000000000),
      ).toBe('subscription_preapproval:abc123:updated:ts1791000000000');
      expect(parseMercadoPagoNotification({}, { data: {} })).toBeNull();
    });
  });
});
