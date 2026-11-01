/**
 * Regras puras das assinaturas SaaS (sem banco): transições de situação, períodos de cobrança,
 * teste grátis, tolerância da inadimplência, downgrade e preço mensalizado (MRR).
 * Cobertas por subscription-rules.spec.ts.
 */
import { ConflictException } from '@nestjs/common';
import { BYTES_PER_MB, bytesToMb } from '../common/uploads/storage-usage';
import { BRAND } from '../config/brand';
import { BillingInterval, type Plan } from './entities/plan.entity';
import { InvoiceStatus } from './entities/subscription-invoice.entity';
import {
  SubscriptionStatus,
  type Subscription,
} from './entities/subscription.entity';
import {
  PLAN_LIMIT_KEYS,
  PLAN_LIMIT_LABEL,
  STORAGE_LIMIT_KEY,
  STORAGE_LIMIT_LABEL,
  limitsOf,
  type PlanLimitColumn,
  type PlanLimitKey,
  type PlanUsage,
} from './plan-rules';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Tipos gravados em subscription_events.type (histórico exibido no superpainel). */
export const SubscriptionEventType = {
  CREATED: 'CREATED',
  STATUS_CHANGED: 'STATUS_CHANGED',
  PLAN_CHANGED: 'PLAN_CHANGED',
  CANCEL_SCHEDULED: 'CANCEL_SCHEDULED',
  CANCEL_REVERTED: 'CANCEL_REVERTED',
  PERIOD_RENEWED: 'PERIOD_RENEWED',
  INVOICE_CREATED: 'INVOICE_CREATED',
  INVOICE_VOIDED: 'INVOICE_VOIDED',
  INVOICE_RESCHEDULED: 'INVOICE_RESCHEDULED',
  PAYMENT_SUCCEEDED: 'PAYMENT_SUCCEEDED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_AMOUNT_MISMATCH: 'PAYMENT_AMOUNT_MISMATCH',
  PAYMENT_AFTER_CANCEL: 'PAYMENT_AFTER_CANCEL',
  CHECKOUT_CREATED: 'CHECKOUT_CREATED',
  PROVIDER_STATUS_CHANGED: 'PROVIDER_STATUS_CHANGED',
  PROVIDER_SYNC_FAILED: 'PROVIDER_SYNC_FAILED',
} as const;

export type SubscriptionEventType =
  (typeof SubscriptionEventType)[keyof typeof SubscriptionEventType];

/**
 * Transições válidas (docs/saas/arquitetura.md, seção 6). CANCELED é final: uma nova contratação
 * cria outra assinatura (o índice parcial do banco permite só uma não cancelada por loja).
 */
export const SUBSCRIPTION_TRANSITIONS: Readonly<
  Record<SubscriptionStatus, readonly SubscriptionStatus[]>
> = {
  [SubscriptionStatus.TRIALING]: [
    SubscriptionStatus.ACTIVE,
    SubscriptionStatus.PAST_DUE,
    SubscriptionStatus.CANCELED,
  ],
  [SubscriptionStatus.ACTIVE]: [
    SubscriptionStatus.PAST_DUE,
    SubscriptionStatus.SUSPENDED,
    SubscriptionStatus.CANCELED,
  ],
  [SubscriptionStatus.PAST_DUE]: [
    SubscriptionStatus.ACTIVE,
    SubscriptionStatus.SUSPENDED,
    SubscriptionStatus.CANCELED,
  ],
  [SubscriptionStatus.SUSPENDED]: [
    SubscriptionStatus.ACTIVE,
    SubscriptionStatus.CANCELED,
  ],
  [SubscriptionStatus.CANCELED]: [],
};

export const SUBSCRIPTION_STATUS_LABELS: Readonly<
  Record<SubscriptionStatus, string>
> = {
  [SubscriptionStatus.TRIALING]: 'Em teste grátis',
  [SubscriptionStatus.ACTIVE]: 'Ativa',
  [SubscriptionStatus.PAST_DUE]: 'Pagamento em atraso',
  [SubscriptionStatus.SUSPENDED]: 'Suspensa',
  [SubscriptionStatus.CANCELED]: 'Cancelada',
};

export function canTransition(
  from: SubscriptionStatus,
  to: SubscriptionStatus,
): boolean {
  return SUBSCRIPTION_TRANSITIONS[from]?.includes(to) ?? false;
}

export function transitionErrorMessage(
  from: SubscriptionStatus,
  to: SubscriptionStatus,
): string {
  const label = (status: SubscriptionStatus) =>
    SUBSCRIPTION_STATUS_LABELS[status] ?? status;
  if (from === to) {
    return `A assinatura já está na situação "${label(from)}".`;
  }
  if (from === SubscriptionStatus.CANCELED) {
    return 'A assinatura está cancelada e não pode mais mudar de situação. Uma nova contratação cria outra assinatura.';
  }
  return `A assinatura não pode passar de "${label(from)}" para "${label(to)}".`;
}

/**
 * Suspensa por decisão do superadmin (suspended_by = PLATFORM): só a reativação pelo superpainel
 * desfaz. Pagamento aprovado quita a fatura mas não reativa, e o checkout da loja é recusado.
 * Suspensão por inadimplência (BILLING) ou anterior ao registro da origem (null) segue a regra antiga:
 * pagas as faturas vencidas, volta a ACTIVE.
 */
export function isPlatformSuspension(
  subscription: Pick<Subscription, 'status' | 'suspended_by'>,
): boolean {
  return (
    subscription.status === SubscriptionStatus.SUSPENDED &&
    subscription.suspended_by === 'PLATFORM'
  );
}

/**
 * 409 (Conflict) com a explicação quando a transição não é permitida: o pedido é válido, mas a
 * situação atual da assinatura não permite a mudança (como nas transições da loja, §11.6).
 */
export function assertTransition(
  from: SubscriptionStatus,
  to: SubscriptionStatus,
): void {
  if (!canTransition(from, to)) {
    throw new ConflictException(transitionErrorMessage(from, to));
  }
}

export function intervalMonths(interval: BillingInterval): number {
  return interval === BillingInterval.YEARLY ? 12 : 1;
}

/**
 * Soma `count` períodos (mês ou ano) mantendo o dia e o horário (UTC). Quando o mês de destino não
 * tem o dia (31/01 + 1 mês, 29/02 + 1 ano), usa o último dia dele — nunca "transborda" para o mês
 * seguinte como o setMonth do JavaScript (31/01 + 1 mês = 03/03).
 * O período seguinte parte do fim do anterior: 31/01 → 28/02 → 28/03 (mesma regra de muitos
 * provedores; sem âncora de dia guardada na assinatura).
 */
export function addInterval(
  date: Date,
  interval: BillingInterval,
  count = 1,
): Date {
  const months = intervalMonths(interval) * count;
  const totalMonths = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(date.getUTCDate(), lastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/** Fim do teste grátis: início + dias corridos. */
export function trialEnd(start: Date, trialDays: number): Date {
  return new Date(start.getTime() + Math.max(0, trialDays) * DAY_MS);
}

/** Fim da tolerância da inadimplência: vencimento + dias de tolerância. */
export function graceEnd(dueAt: Date, graceDays: number): Date {
  return new Date(dueAt.getTime() + Math.max(0, graceDays) * DAY_MS);
}

export interface BillingPeriod {
  start: Date;
  end: Date;
}

/** Período que começa em `start` e dura um intervalo do plano. */
export function periodFrom(
  start: Date,
  interval: BillingInterval,
): BillingPeriod {
  return { start, end: addInterval(start, interval) };
}

/** Plano pago (gera faturas)? Preço 0 = gratuito/interno. */
export function isPaidPlan(plan: Pick<Plan, 'price'>): boolean {
  return Number(plan.price) > 0;
}

/** Arredonda em centavos sem o erro de ponto flutuante de Math.round(x * 100). */
export function roundMoney(value: number): number {
  return Number(`${Math.round(Number(`${value}e2`))}e-2`);
}

/**
 * Preço mensalizado para o MRR: anual ÷ 12. Sem arredondar (some os itens e arredonde o total
 * com roundMoney, para não acumular erro de centavos).
 */
export function monthlyPrice(
  plan: Pick<Plan, 'price' | 'billing_interval'>,
): number {
  const price = Number(plan.price) || 0;
  return plan.billing_interval === BillingInterval.YEARLY ? price / 12 : price;
}

export interface PlanLimitViolation {
  key: PlanLimitKey | typeof STORAGE_LIMIT_KEY;
  label: string;
  limit: number;
  /** Uso atual (no armazenamento, em MB com 2 casas). */
  usage: number;
}

/**
 * Downgrade só se o uso atual couber no plano novo: devolve o que excede (lista vazia = cabe).
 * Uso igual ao limite cabe; limite nulo é ilimitado. storageBytes: uso de armazenamento medido na pasta
 * de uploads (null/ausente = não medido: não bloqueia), comparado com max_storage_mb.
 */
export function canDowngrade(
  usage: PlanUsage,
  plan: Pick<Plan, PlanLimitColumn> & Partial<Pick<Plan, 'max_storage_mb'>>,
  storageBytes: number | null = null,
): PlanLimitViolation[] {
  const limits = limitsOf(plan);
  const violations: PlanLimitViolation[] = PLAN_LIMIT_KEYS.flatMap((key) => {
    const limit = limits[key];
    const used = usage[key] ?? 0;
    return limit !== null && used > limit
      ? [{ key, label: PLAN_LIMIT_LABEL[key], limit, usage: used }]
      : [];
  });
  const storageLimit = plan.max_storage_mb ?? null;
  if (
    storageLimit !== null &&
    storageBytes !== null &&
    storageBytes > storageLimit * BYTES_PER_MB
  ) {
    violations.push({
      key: STORAGE_LIMIT_KEY,
      label: STORAGE_LIMIT_LABEL,
      limit: storageLimit,
      usage: bytesToMb(storageBytes),
    });
  }
  return violations;
}

const violationNumber = new Intl.NumberFormat('pt-BR', {
  maximumFractionDigits: 2,
  useGrouping: false,
});

/** "usuários da equipe: 5 em uso (limite 3); MB de armazenamento: 612,5 em uso (limite 500)". */
export function describeViolations(violations: PlanLimitViolation[]): string {
  return violations
    .map(
      (item) =>
        `${item.label}: ${violationNumber.format(item.usage)} em uso (limite ${violationNumber.format(item.limit)})`,
    )
    .join('; ');
}

/** Faturas que ainda devem ser pagas (recusada continua cobrável: o provedor tenta de novo). */
export const UNPAID_INVOICE_STATUSES: readonly InvoiceStatus[] = [
  InvoiceStatus.OPEN,
  InvoiceStatus.FAILED,
];

export function isUnpaidInvoice(status: InvoiceStatus): boolean {
  return UNPAID_INVOICE_STATUSES.includes(status);
}

/** external_reference da assinatura no provedor de cobrança (ex.: "comestra-assinatura-12"). */
export function subscriptionExternalReference(subscriptionId: number): string {
  return `${BRAND.slug}-assinatura-${subscriptionId}`;
}

/** Id da assinatura a partir do external_reference (null se não for uma referência nossa). */
export function parseSubscriptionExternalReference(
  reference: unknown,
): number | null {
  if (typeof reference !== 'string') return null;
  const match = new RegExp(`^${BRAND.slug}-assinatura-(\\d{1,10})$`).exec(
    reference.trim(),
  );
  const id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647 ? id : null;
}
