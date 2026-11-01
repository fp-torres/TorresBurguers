import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { IncomingHttpHeaders } from 'http';
import { IsNull, LessThan, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/database-errors';
import { BillingWebhookEvent } from './entities/billing-webhook-event.entity';
import { Subscription } from './entities/subscription.entity';
import {
  normalizeDataId,
  verifyMercadoPagoSignature,
} from './mercado-pago-signature';
import { describeProviderError } from './providers/billing-provider';
import { BillingProvidersService } from './providers/billing-providers.service';
import type { MercadoPagoBillingProvider } from './providers/mercado-pago-billing.provider';
import { parseSubscriptionExternalReference } from './subscription-rules';
import { SubscriptionsService } from './subscriptions.service';

export const WEBHOOK_NOT_CONFIGURED_MESSAGE =
  'Notificações da cobrança da plataforma não estão configuradas (MP_SAAS_WEBHOOK_SECRET).';
export const INVALID_SIGNATURE_MESSAGE = 'Assinatura da notificação inválida.';
export const INVALID_NOTIFICATION_MESSAGE =
  'Notificação inválida: data.id ausente ou em formato desconhecido.';
export const WEBHOOK_RETRY_MESSAGE =
  'Notificação não processada agora; ela será reenviada pelo Mercado Pago.';
/** Observação gravada no registro IGNORED quando a cobrança online está desligada. */
export const BILLING_PROVIDER_OFF_NOTE =
  'Cobrança online desligada (SAAS_BILLING_PROVIDER=MANUAL e sem MP_SAAS_ACCESS_TOKEN): notificação ignorada.';

const PROVIDER = 'MERCADO_PAGO';
/** Notificação "em processamento" há mais que isso é considerada travada e pode ser reprocessada. */
export const STALE_WEBHOOK_MS = 10 * 60 * 1000;

export interface MercadoPagoNotification {
  topic: string;
  dataId: string;
  action: string;
  /** Id da notificação no corpo (o mesmo nas reentregas). */
  notificationId: string | null;
}

export type WebhookOutcome = 'processed' | 'ignored' | 'duplicate';

function text(value: unknown, max: number): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value).slice(0, max);
  }
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : null;
}

/** Tópico, recurso e ação da notificação (query string e corpo; nada disso é confiável). */
export function parseMercadoPagoNotification(
  query: Record<string, unknown>,
  body: unknown,
): MercadoPagoNotification | null {
  const data = (body && typeof body === 'object' ? body : {}) as {
    id?: unknown;
    type?: unknown;
    topic?: unknown;
    action?: unknown;
    data?: { id?: unknown } | null;
  };
  // O x-signature é calculado sobre o data.id da URL; o do corpo é só o plano B
  const dataId = normalizeDataId(query['data.id'] ?? data.data?.id ?? query.id);
  if (!dataId) return null;
  const topic = (
    text(data.type, 60) ??
    text(data.topic, 60) ??
    text(query.type, 60) ??
    text(query.topic, 60) ??
    'desconhecido'
  ).toLowerCase();
  const notificationId = text(data.id, 40);
  return {
    topic,
    dataId,
    action: text(data.action, 60) ?? '',
    notificationId:
      notificationId && /^[\w-]+$/.test(notificationId) ? notificationId : null,
  };
}

/** Chave de idempotência: a mesma notificação (reentregas) tem sempre a mesma chave. */
export function webhookEventKey(
  notification: MercadoPagoNotification,
  timestampMs: number,
): string {
  const unique = notification.notificationId ?? `ts${timestampMs}`;
  return `${notification.topic}:${notification.dataId}:${notification.action || '-'}:${unique}`.slice(
    0,
    200,
  );
}

function header(headers: IncomingHttpHeaders, name: string): unknown {
  return headers[name];
}

/** 404 do Mercado Pago na reconsulta: recurso que não existe nesta conta (ex.: notificação de teste). */
function isNotFound(error: unknown): boolean {
  return describeProviderError(error).httpStatus === 404;
}

/**
 * POST /billing/webhook/mercadopago — notificações da cobrança SaaS (conta Mercado Pago da
 * PLATAFORMA; o webhook do delivery é outro: /payment/webhook).
 * 1. sem MP_SAAS_WEBHOOK_SECRET → 503; x-signature inválido/expirado → 401;
 * 2. idempotência por billing_webhook_events (provider + event_key): repetida → 200 sem reprocessar
 *    (só uma notificação que falhou, ou travou, é reprocessada; ainda em andamento → 503 para o
 *    Mercado Pago reenviar depois);
 * 3. o corpo nunca é confiável: o recurso é reconsultado no Mercado Pago e só então a assinatura e a
 *    fatura mudam (pagamento aprovado → fatura paga, com provider_payment_id único; recusado → falha).
 */
@Injectable()
export class BillingWebhookService {
  private readonly logger = new Logger(BillingWebhookService.name);

  constructor(
    @InjectRepository(BillingWebhookEvent)
    private readonly events: Repository<BillingWebhookEvent>,
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    private readonly billing: SubscriptionsService,
    private readonly providers: BillingProvidersService,
  ) {}

  async handleMercadoPago(input: {
    headers: IncomingHttpHeaders;
    query: Record<string, unknown>;
    body: unknown;
    now?: Date;
  }): Promise<WebhookOutcome> {
    const now = input.now ?? new Date();
    const secret = process.env.MP_SAAS_WEBHOOK_SECRET?.trim();
    if (!secret) {
      throw new ServiceUnavailableException(WEBHOOK_NOT_CONFIGURED_MESSAGE);
    }
    const notification = parseMercadoPagoNotification(
      input.query ?? {},
      input.body,
    );
    if (!notification) {
      throw new BadRequestException(INVALID_NOTIFICATION_MESSAGE);
    }
    const signature = verifyMercadoPagoSignature({
      signature: header(input.headers, 'x-signature'),
      requestId: header(input.headers, 'x-request-id'),
      dataId: notification.dataId,
      secret,
      now: now.getTime(),
    });
    if (!signature.valid) {
      this.logger.warn(
        `Notificação da cobrança recusada (${signature.reason}): ${notification.topic} ${notification.dataId}`,
      );
      throw new UnauthorizedException(INVALID_SIGNATURE_MESSAGE);
    }

    const claim = await this.claim(
      webhookEventKey(notification, signature.timestampMs),
      notification,
      now,
    );
    if (claim.kind === 'done') return 'duplicate';
    if (claim.kind === 'busy') {
      // Outra entrega da mesma notificação ainda está em andamento: o Mercado Pago tenta de novo depois
      throw new ServiceUnavailableException(WEBHOOK_RETRY_MESSAGE);
    }
    const { event } = claim;

    try {
      const outcome = await this.process(notification, now);
      await this.finish(event.id, outcome.status, outcome.note, now);
      return outcome.status === 'IGNORED' ? 'ignored' : 'processed';
    } catch (error) {
      const message = describeProviderError(error).message;
      await this.finish(event.id, 'FAILED', message, now);
      this.logger.warn(
        `Notificação ${notification.topic} ${notification.dataId} falhou: ${message}`,
      );
      // 503: o Mercado Pago reenvia e a próxima entrega reprocessa (evento FAILED)
      throw new ServiceUnavailableException(WEBHOOK_RETRY_MESSAGE);
    }
  }

  /**
   * Registra a notificação (única por provider + event_key). Já registrada e concluída (PROCESSED/
   * IGNORED) → "done" (200 sem reprocessar). Falhou, ou está "em processamento" há mais de
   * STALE_WEBHOOK_MS (a API caiu no meio) → assume e reprocessa. Em processamento → "busy".
   */
  private async claim(
    key: string,
    notification: MercadoPagoNotification,
    now: Date,
  ): Promise<
    | { kind: 'claimed'; event: BillingWebhookEvent }
    | { kind: 'done' }
    | { kind: 'busy' }
  > {
    try {
      const event = await this.events.save(
        this.events.create({
          provider: PROVIDER,
          event_key: key,
          topic: notification.topic.slice(0, 60),
          resource_id: notification.dataId,
          status: 'RECEIVED',
          error: null,
          processed_at: null,
        }),
      );
      return { kind: 'claimed', event };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    const existing = await this.events.findOne({
      where: { provider: PROVIDER, event_key: key },
    });
    if (!existing) return { kind: 'busy' };
    if (existing.status === 'PROCESSED' || existing.status === 'IGNORED') {
      return { kind: 'done' };
    }
    const claimed =
      existing.status === 'FAILED'
        ? await this.events.update(
            { id: existing.id, status: 'FAILED' },
            { status: 'RECEIVED', error: null, processed_at: null },
          )
        : await this.events.update(
            {
              id: existing.id,
              status: 'RECEIVED',
              processed_at: IsNull(),
              received_at: LessThan(new Date(now.getTime() - STALE_WEBHOOK_MS)),
            },
            { error: null },
          );
    return claimed.affected
      ? { kind: 'claimed', event: existing }
      : { kind: 'busy' };
  }

  private async finish(
    id: number,
    status: 'PROCESSED' | 'IGNORED' | 'FAILED',
    note: string | null,
    now: Date,
  ): Promise<void> {
    try {
      await this.events.update(
        { id },
        { status, error: note?.slice(0, 500) ?? null, processed_at: now },
      );
    } catch (error) {
      this.logger.error(
        `Notificação #${id}: situação não gravada (${(error as Error).message}).`,
      );
    }
  }

  private async process(
    notification: MercadoPagoNotification,
    now: Date,
  ): Promise<{ status: 'PROCESSED' | 'IGNORED'; note: string | null }> {
    const mercadoPago = this.providers.mercadoPago();
    if (!mercadoPago) {
      if (this.providers.configuredCode() === 'MANUAL') {
        // Cobrança online desligada (MANUAL) e sem a credencial: não há o que reconsultar nem o que
        // aplicar. Registra como IGNORED e responde 200 (com 503 o Mercado Pago reenviaria para sempre)
        return { status: 'IGNORED', note: BILLING_PROVIDER_OFF_NOTE };
      }
      // MERCADO_PAGO sem a credencial (configuração incompleta): falha e o Mercado Pago reenvia depois
      throw new Error('MP_SAAS_ACCESS_TOKEN não configurado.');
    }
    try {
      switch (notification.topic) {
        case 'subscription_preapproval':
        case 'preapproval':
          return await this.onPreapproval(mercadoPago, notification.dataId);
        case 'subscription_authorized_payment':
        case 'authorized_payment':
          return await this.onAuthorizedPayment(
            mercadoPago,
            notification.dataId,
            now,
          );
        case 'payment':
          return await this.onPayment(mercadoPago, notification.dataId, now);
        default:
          return {
            status: 'IGNORED',
            note: `Tópico não tratado: ${notification.topic}`,
          };
      }
    } catch (error) {
      if (isNotFound(error)) {
        return {
          status: 'IGNORED',
          note: 'Recurso não encontrado no Mercado Pago.',
        };
      }
      throw error;
    }
  }

  private async onPreapproval(
    mercadoPago: MercadoPagoBillingProvider,
    dataId: string,
  ) {
    const preapproval = await mercadoPago.getPreapproval(dataId);
    const providerId = text(preapproval.id, 80);
    const subscription = await this.findSubscription(
      preapproval.external_reference,
      providerId,
    );
    if (!subscription || !providerId) {
      return this.ignored('Assinatura da plataforma não encontrada.');
    }
    const result = await this.billing.applyProviderStatus(subscription.id, {
      providerSubscriptionId: providerId,
      providerStatus: text(preapproval.status, 40),
    });
    return result === 'ignored'
      ? this.ignored('Autorização antiga desta assinatura (ignorada).')
      : this.processed(null);
  }

  private async onAuthorizedPayment(
    mercadoPago: MercadoPagoBillingProvider,
    dataId: string,
    now: Date,
  ) {
    const charge = await mercadoPago.getAuthorizedPayment(dataId);
    const preapprovalId = text(charge.preapproval_id, 80);
    const subscription = await this.findSubscription(
      charge.external_reference,
      preapprovalId,
    );
    if (!subscription) {
      return this.ignored('Assinatura da plataforma não encontrada.');
    }
    const payment = charge.payment ?? {};
    const paymentId = text(payment.id, 80);
    const status = text(payment.status, 40);
    if (status === 'approved' && paymentId) {
      const paid = await this.billing.applyProviderPayment(
        subscription.id,
        {
          providerPaymentId: paymentId,
          amount: charge.transaction_amount ?? null,
          paidAt: now,
          // Cobrança de uma autorização que não é a registrada (órfã) → cancelada no provedor
          providerSubscriptionId: preapprovalId,
        },
        now,
      );
      return this.processed(`Pagamento ${paymentId}: ${paid.result}`);
    }
    if ((status === 'rejected' || status === 'cancelled') && paymentId) {
      const failed = await this.billing.applyProviderFailure(subscription.id, {
        providerPaymentId: paymentId,
        reason: text(payment.status_detail, 200) ?? status,
      });
      return this.processed(`Pagamento ${paymentId}: ${failed}`);
    }
    return this.ignored(
      `Cobrança ainda não concluída (${text(charge.status, 40) ?? 'sem situação'}).`,
    );
  }

  private async onPayment(
    mercadoPago: MercadoPagoBillingProvider,
    dataId: string,
    now: Date,
  ) {
    const payment = await mercadoPago.getPayment(dataId);
    const metadata = (payment.metadata ?? {}) as { preapproval_id?: unknown };
    const preapprovalId = text(metadata.preapproval_id, 80);
    const subscription = await this.findSubscription(
      payment.external_reference,
      preapprovalId,
    );
    if (!subscription) {
      return this.ignored(
        'Pagamento não pertence a uma assinatura da plataforma.',
      );
    }
    const paymentId = text(payment.id, 80) ?? dataId;
    const status = text(payment.status, 40);
    if (status === 'approved') {
      const approvedAt = payment.date_approved
        ? new Date(payment.date_approved)
        : now;
      const paid = await this.billing.applyProviderPayment(
        subscription.id,
        {
          providerPaymentId: paymentId,
          amount: payment.transaction_amount ?? null,
          paidAt: Number.isNaN(approvedAt.getTime()) ? now : approvedAt,
          providerSubscriptionId: preapprovalId,
        },
        now,
      );
      return this.processed(`Pagamento ${paymentId}: ${paid.result}`);
    }
    if (status === 'rejected' || status === 'cancelled') {
      const failed = await this.billing.applyProviderFailure(subscription.id, {
        providerPaymentId: paymentId,
        reason: text(payment.status_detail, 200) ?? status,
      });
      return this.processed(`Pagamento ${paymentId}: ${failed}`);
    }
    return this.ignored(
      `Pagamento ${paymentId} ainda ${status ?? 'pendente'}.`,
    );
  }

  /**
   * Assinatura da notificação: pelo external_reference que NÓS criamos ("comestra-assinatura-<id>")
   * ou pelo id da preapproval guardado na assinatura.
   */
  private async findSubscription(
    externalReference: unknown,
    providerSubscriptionId: string | null,
  ): Promise<Pick<Subscription, 'id' | 'store_id'> | null> {
    const referenced = parseSubscriptionExternalReference(externalReference);
    if (referenced) {
      const byReference = await this.subscriptions.findOne({
        where: { id: referenced },
        select: { id: true, store_id: true },
      });
      if (byReference) return byReference;
    }
    if (!providerSubscriptionId) return null;
    return this.subscriptions.findOne({
      where: { provider_subscription_id: providerSubscriptionId },
      select: { id: true, store_id: true },
    });
  }

  private processed(note: string | null) {
    return { status: 'PROCESSED' as const, note };
  }

  private ignored(note: string) {
    return { status: 'IGNORED' as const, note };
  }
}
