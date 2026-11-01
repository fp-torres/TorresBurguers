import { ConflictException, Logger } from '@nestjs/common';
import { appLink } from '../../notifications/links';
import type { Store } from '../../store/entities/store.entity';
import type { Plan } from '../entities/plan.entity';
import type { BillingProviderCode } from '../entities/subscription.entity';

export const ONLINE_BILLING_UNAVAILABLE_MESSAGE =
  'Cobrança online não configurada. Fale com a administração da plataforma para pagar a assinatura.';

/** Link de pagamento/autorização da cobrança recorrente criado no provedor. */
export interface BillingCheckout {
  checkout_url: string;
  /** Id da assinatura no provedor (ex.: preapproval do Mercado Pago). */
  provider_subscription_id: string;
  /** Situação no provedor (ex.: "pending" até o pagador autorizar). */
  provider_status: string | null;
}

/** O que o provedor precisa saber do plano para cobrar. */
export type CheckoutPlan = Pick<
  Plan,
  'name' | 'price' | 'currency' | 'billing_interval'
>;

export interface CheckoutOptions {
  /** Primeira cobrança (fim do teste ou do período já pago). Sem data: cobra ao autorizar. */
  startDate?: Date | null;
}

/**
 * Quem cobra a assinatura SaaS (loja → plataforma). Sempre com as credenciais da PLATAFORMA
 * (MP_SAAS_*), nunca com as de uma loja (essas são do delivery, módulo payment).
 */
export interface BillingProvider {
  readonly code: BillingProviderCode;
  /** Cobrança online pronta para uso (credenciais da plataforma configuradas)? */
  readonly online: boolean;
  createCheckout(
    subscription: { id: number },
    plan: CheckoutPlan,
    store: Pick<Store, 'name'>,
    payerEmail: string,
    options?: CheckoutOptions,
  ): Promise<BillingCheckout>;
  /** Interrompe a cobrança recorrente no provedor (nada a fazer no MANUAL). */
  cancelSubscription(providerSubscriptionId: string): Promise<void>;
  /** Novo valor das próximas cobranças recorrentes (troca de plano com a mesma periodicidade). */
  updateAmount(
    providerSubscriptionId: string,
    amount: number,
    currency: string,
  ): Promise<void>;
}

const logger = new Logger('CobrancaSaaS');
const warned = new Set<string>();

/** SAAS_BILLING_PROVIDER: MANUAL (padrão) ou MERCADO_PAGO. Valor desconhecido → MANUAL (com aviso). */
export function configuredBillingProvider(
  env: NodeJS.ProcessEnv = process.env,
): BillingProviderCode {
  const raw = env.SAAS_BILLING_PROVIDER?.trim().toUpperCase();
  if (!raw || raw === 'MANUAL') return 'MANUAL';
  if (raw === 'MERCADO_PAGO' || raw === 'MERCADOPAGO') return 'MERCADO_PAGO';
  if (!warned.has(raw)) {
    warned.add(raw);
    logger.warn(
      `SAAS_BILLING_PROVIDER="${raw}" não é reconhecido (use MANUAL ou MERCADO_PAGO): usando MANUAL.`,
    );
  }
  return 'MANUAL';
}

/** Página de retorno depois do pagamento: SAAS_BILLING_BACK_URL ou a página da assinatura no painel. */
export function billingBackUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SAAS_BILLING_BACK_URL?.trim();
  if (raw && /^https?:\/\/\S+$/i.test(raw)) return raw;
  return appLink('/subscription', env);
}

/** Erro do SDK/API do provedor em texto (sem dados sensíveis) e o status HTTP, se houver. */
export function describeProviderError(error: unknown): {
  message: string;
  httpStatus: number | null;
} {
  if (error && typeof error === 'object') {
    const data = error as {
      message?: unknown;
      status?: unknown;
      cause?: unknown;
    };
    const cause = Array.isArray(data.cause)
      ? (data.cause[0] as { description?: unknown } | undefined)
      : undefined;
    const message =
      (typeof cause?.description === 'string' && cause.description) ||
      (typeof data.message === 'string' && data.message) ||
      'erro desconhecido';
    const httpStatus = typeof data.status === 'number' ? data.status : null;
    return { message: message.slice(0, 300), httpStatus };
  }
  return { message: 'erro desconhecido', httpStatus: null };
}

/** Provedor sem cobrança online: as faturas são registradas pelo superadmin no superpainel. */
export class ManualBillingProvider implements BillingProvider {
  readonly code = 'MANUAL' as const;
  readonly online = false;

  createCheckout(): Promise<BillingCheckout> {
    return Promise.reject(
      new ConflictException(ONLINE_BILLING_UNAVAILABLE_MESSAGE),
    );
  }

  cancelSubscription(): Promise<void> {
    return Promise.resolve();
  }

  updateAmount(): Promise<void> {
    return Promise.resolve();
  }
}
