import { randomUUID } from 'crypto';
import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  Logger,
} from '@nestjs/common';
import {
  Invoice as MercadoPagoAuthorizedPayment,
  MercadoPagoConfig,
  Payment as MercadoPagoPayment,
  PreApproval,
} from 'mercadopago';
import { BRAND } from '../../config/brand';
import {
  intervalMonths,
  subscriptionExternalReference,
} from '../subscription-rules';
import {
  describeProviderError,
  type BillingCheckout,
  type BillingProvider,
  type CheckoutOptions,
  type CheckoutPlan,
} from './billing-provider';

type PreapprovalCreateBody = Parameters<PreApproval['create']>[0]['body'];
type PreapprovalUpdateBody = Parameters<PreApproval['update']>[0]['body'];

/** Assinatura recorrente (preapproval) como o Mercado Pago devolve. */
export interface PreapprovalResource {
  id?: string;
  status?: string;
  external_reference?: string | number;
  init_point?: string;
  next_payment_date?: string | number;
}

/** Cobrança de uma assinatura (authorized_payment): cada mensalidade/anuidade cobrada. */
export interface AuthorizedPaymentResource {
  id?: string | number;
  preapproval_id?: string;
  status?: string;
  external_reference?: string;
  transaction_amount?: number;
  currency_id?: string;
  debit_date?: string;
  payment?: { id?: string | number; status?: string; status_detail?: string };
}

/** Pagamento (v1/payments) gerado pela cobrança da assinatura. */
export interface PaymentResource {
  id?: string | number;
  status?: string;
  status_detail?: string;
  external_reference?: string;
  transaction_amount?: number;
  currency_id?: string;
  date_approved?: string;
  metadata?: unknown;
}

/** Chamadas à API do Mercado Pago (conta da PLATAFORMA) usadas pela cobrança SaaS. Os testes usam um dublê. */
export interface MercadoPagoSaasApi {
  createPreapproval(
    body: PreapprovalCreateBody,
    idempotencyKey: string,
  ): Promise<PreapprovalResource>;
  getPreapproval(id: string): Promise<PreapprovalResource>;
  updatePreapproval(
    id: string,
    body: PreapprovalUpdateBody,
  ): Promise<PreapprovalResource>;
  getAuthorizedPayment(id: string): Promise<AuthorizedPaymentResource>;
  getPayment(id: string): Promise<PaymentResource>;
}

/** Limite de espera por chamada (o SDK ainda repete falhas de rede/5xx por conta própria). */
export const MERCADO_PAGO_TIMEOUT_MS = 15_000;

/**
 * SDK oficial (PreApproval; Invoice = /authorized_payments; Payment) com uma configuração NOVA a
 * cada chamada: o SDK guarda a chave de idempotência na configuração compartilhada.
 */
export class MercadoPagoSaasSdkApi implements MercadoPagoSaasApi {
  constructor(
    private readonly accessToken: string,
    private readonly timeoutMs = 10_000,
  ) {}

  private config(idempotencyKey?: string): MercadoPagoConfig {
    return new MercadoPagoConfig({
      accessToken: this.accessToken,
      options: {
        timeout: this.timeoutMs,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
    });
  }

  createPreapproval(body: PreapprovalCreateBody, idempotencyKey: string) {
    return new PreApproval(this.config(idempotencyKey)).create({ body });
  }

  getPreapproval(id: string) {
    return new PreApproval(this.config()).get({ id });
  }

  updatePreapproval(id: string, body: PreapprovalUpdateBody) {
    return new PreApproval(this.config(randomUUID())).update({
      id,
      body,
    }) as Promise<PreapprovalResource>;
  }

  getAuthorizedPayment(id: string) {
    return new MercadoPagoAuthorizedPayment(this.config()).get({ id });
  }

  getPayment(id: string) {
    return new MercadoPagoPayment(this.config()).get({ id });
  }
}

/** Promessa com prazo: o provedor fora do ar não segura a requisição (nem o webhook) indefinidamente. */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs = MERCADO_PAGO_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(
            new Error('Tempo esgotado ao falar com o Mercado Pago.'),
            {
              status: 504,
            },
          ),
        ),
      timeoutMs,
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const logger = new Logger('CobrancaSaaS');

/** Erro do provedor na criação do checkout: recusa (4xx) → 400 com o motivo; resto → 502. */
function checkoutFailure(error: unknown): HttpException {
  const { message, httpStatus } = describeProviderError(error);
  logger.warn(
    `Mercado Pago (cobrança SaaS): falha ao criar a assinatura — ${message}`,
  );
  if (httpStatus !== null && httpStatus >= 400 && httpStatus < 500) {
    return new BadRequestException(
      `O Mercado Pago recusou a assinatura: ${message}`,
    );
  }
  return new BadGatewayException(
    'Não foi possível falar com o Mercado Pago agora. Tente novamente em alguns minutos.',
  );
}

/**
 * Cobrança recorrente pelo Mercado Pago Assinaturas (preapproval sem plano associado), na conta da
 * plataforma (MP_SAAS_ACCESS_TOKEN). O pagador autoriza no link (init_point) e o Mercado Pago cobra
 * a cada período; as cobranças chegam pelo webhook POST /billing/webhook/mercadopago.
 */
export class MercadoPagoBillingProvider implements BillingProvider {
  readonly code = 'MERCADO_PAGO' as const;
  readonly online = true;

  constructor(
    private readonly api: MercadoPagoSaasApi,
    private readonly options: { backUrl: string; now?: () => Date },
  ) {}

  async createCheckout(
    subscription: { id: number },
    plan: CheckoutPlan,
    store: { name: string },
    payerEmail: string,
    options: CheckoutOptions = {},
  ): Promise<BillingCheckout> {
    const now = this.options.now?.() ?? new Date();
    // Data de início só no futuro (fim do teste ou do período já pago); senão cobra ao autorizar
    const start =
      options.startDate && options.startDate.getTime() > now.getTime() + 60_000
        ? options.startDate
        : null;
    const body: PreapprovalCreateBody = {
      reason: `${BRAND.name} — plano ${plan.name} (${store.name})`.slice(
        0,
        250,
      ),
      external_reference: subscriptionExternalReference(subscription.id),
      payer_email: payerEmail,
      back_url: this.options.backUrl,
      status: 'pending',
      auto_recurring: {
        frequency: intervalMonths(plan.billing_interval),
        frequency_type: 'months',
        transaction_amount: Number(plan.price),
        currency_id: plan.currency || 'BRL',
        ...(start ? { start_date: start.toISOString() } : {}),
      },
    };

    let created: PreapprovalResource;
    try {
      created = await withTimeout(
        this.api.createPreapproval(body, randomUUID()),
      );
    } catch (error) {
      throw checkoutFailure(error);
    }
    if (!created?.id || !created.init_point) {
      throw new BadGatewayException(
        'O Mercado Pago não devolveu o link de pagamento da assinatura. Tente novamente.',
      );
    }
    return {
      checkout_url: created.init_point,
      provider_subscription_id: String(created.id),
      provider_status: created.status ?? 'pending',
    };
  }

  async cancelSubscription(providerSubscriptionId: string): Promise<void> {
    await withTimeout(
      this.api.updatePreapproval(providerSubscriptionId, {
        status: 'cancelled',
      }),
    );
  }

  async updateAmount(
    providerSubscriptionId: string,
    amount: number,
    currency: string,
  ): Promise<void> {
    await withTimeout(
      this.api.updatePreapproval(providerSubscriptionId, {
        auto_recurring: { transaction_amount: amount, currency_id: currency },
      }),
    );
  }

  // --- Reconsultas do webhook (o corpo da notificação nunca é confiável) ---

  getPreapproval(id: string): Promise<PreapprovalResource> {
    return withTimeout(this.api.getPreapproval(id));
  }

  getAuthorizedPayment(id: string): Promise<AuthorizedPaymentResource> {
    return withTimeout(this.api.getAuthorizedPayment(id));
  }

  getPayment(id: string): Promise<PaymentResource> {
    return withTimeout(this.api.getPayment(id));
  }
}
