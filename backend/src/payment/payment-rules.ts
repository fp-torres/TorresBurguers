/**
 * Regras puras dos pagamentos (sem Mercado Pago, sem Nest). Cobertas por payment-rules.spec.ts.
 */
import { envFlag, isDevOrTest } from '../config/env';
import { toCents } from '../orders/order-rules';

export const DEFAULT_PIX_SANDBOX_APPROVAL_SECONDS = 5;
/** Prazo padrão para pagar o PIX (PIX_EXPIRATION_MINUTES). */
export const DEFAULT_PIX_EXPIRATION_MINUTES = 30;
/** O Mercado Pago não aceita PIX que vence em menos de 30 minutos. */
export const MERCADO_PAGO_MIN_PIX_MINUTES = 30;
const MAX_PIX_EXPIRATION_MINUTES = 30 * 24 * 60; // 30 dias (máximo do Mercado Pago)

/** Ids das aprovações simuladas ficam numa faixa própria, longe dos ids reais do Mercado Pago. */
export const SIMULATED_ID_BASE = 900_000_000_000_000;

export const PAYMENT_ALREADY_USED_MESSAGE =
  'Este pagamento já foi utilizado em outro pedido.';
export const PAYMENT_ORDER_CANCELED_MESSAGE =
  'Este pagamento já foi usado em um pedido que foi cancelado (o valor é estornado). Faça um novo pagamento.';

/** Chave de idempotência enviada pelos apps (uuid ou similar). */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Status do Mercado Pago que ainda podem virar "approved". */
export const PENDING_PAYMENT_STATUSES = [
  'pending',
  'in_process',
  'authorized',
  'in_mediation',
];

export interface PaymentMode {
  /** Sandbox: recusa/falha do Mercado Pago vira aprovação SIMULADA e PIX é aprovado sozinho. */
  sandbox: boolean;
  /** PAYMENT_SANDBOX=true pedido fora de development/test (recusado). */
  sandboxRefused: boolean;
  accessToken: string | null;
  pixApprovalSeconds: number;
  /** Prazo do PIX em minutos (date_of_expiration e o expires_at mostrado nos apps). */
  pixExpirationMinutes: number;
  /** PIX_EXPIRATION_MINUTES abaixo do mínimo do Mercado Pago foi elevado para 30. */
  pixExpirationAdjusted: boolean;
  /** URL pública de POST /payment/webhook enviada ao Mercado Pago (MP_NOTIFICATION_URL). */
  notificationUrl: string | null;
}

function numberFrom(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * O sandbox só existe em NODE_ENV=development ou test:
 * - PAYMENT_SANDBOX=true/false decide; vazio = automático (sandbox quando não há MP_ACCESS_TOKEN
 *   ou quando ele é uma credencial de teste "TEST-...");
 * - em produção (ou NODE_ENV ausente/desconhecido) nunca liga: PAYMENT_SANDBOX=true é recusado.
 */
export function resolvePaymentMode(env: NodeJS.ProcessEnv): PaymentMode {
  const accessToken = env.MP_ACCESS_TOKEN?.trim() || null;
  const devOrTest = isDevOrTest(env);
  const automatic =
    devOrTest && (!accessToken || accessToken.startsWith('TEST-'));
  const requested = envFlag('PAYMENT_SANDBOX', automatic, env);

  const seconds = numberFrom(env.PIX_SANDBOX_APPROVAL_SECONDS);
  const pixApprovalSeconds =
    seconds !== null && seconds >= 0
      ? seconds
      : DEFAULT_PIX_SANDBOX_APPROVAL_SECONDS;

  const minutes = numberFrom(env.PIX_EXPIRATION_MINUTES);
  let pixExpirationMinutes =
    minutes !== null &&
    Number.isInteger(minutes) &&
    minutes >= 1 &&
    minutes <= MAX_PIX_EXPIRATION_MINUTES
      ? minutes
      : DEFAULT_PIX_EXPIRATION_MINUTES;
  // Com o Mercado Pago de verdade, menos de 30 minutos é recusado na criação do PIX
  const pixExpirationAdjusted =
    !!accessToken && pixExpirationMinutes < MERCADO_PAGO_MIN_PIX_MINUTES;
  if (pixExpirationAdjusted)
    pixExpirationMinutes = MERCADO_PAGO_MIN_PIX_MINUTES;

  const notification = env.MP_NOTIFICATION_URL?.trim();
  return {
    sandbox: requested && devOrTest,
    sandboxRefused: requested && !devOrTest,
    accessToken,
    pixApprovalSeconds,
    pixExpirationMinutes,
    pixExpirationAdjusted,
    notificationUrl:
      notification && /^https?:\/\/\S+$/i.test(notification)
        ? notification
        : null,
  };
}

export type PaymentKind = 'CARD' | 'PIX';

/** Forma de pagamento do pedido → tipo de pagamento online que pode quitá-lo. */
export function paymentKindFor(paymentMethod: string): PaymentKind | null {
  if (paymentMethod === 'PIX') return 'PIX';
  if (paymentMethod === 'CREDIT_CARD' || paymentMethod === 'DEBIT_CARD')
    return 'CARD';
  return null;
}

/**
 * Forma de pagamento do pedido criado por um pagamento com cartão: o tipo informado pelo
 * Mercado Pago (payment_type_id) ou, sem ele, o meio (debvisa, debmaster, debelo... = débito).
 */
export function cardOrderMethod(
  paymentMethodId?: string | null,
  paymentTypeId?: string | null,
): 'CREDIT_CARD' | 'DEBIT_CARD' {
  if (paymentTypeId === 'debit_card' || paymentTypeId === 'prepaid_card')
    return 'DEBIT_CARD';
  if (paymentTypeId === 'credit_card') return 'CREDIT_CARD';
  return paymentMethodId?.startsWith('deb') ? 'DEBIT_CARD' : 'CREDIT_CARD';
}

/** O valor pago precisa ser o total do pedido, com tolerância de R$ 0,01 (para mais ou para menos). */
export function amountMatches(paid: number, total: number): boolean {
  return Math.abs(toCents(paid) - toCents(total)) <= 1;
}

/** Status que não mudam mais sozinhos (não precisa consultar o Mercado Pago de novo no polling). */
export function isFinalPaymentStatus(status: string): boolean {
  return [
    'approved',
    'rejected',
    'cancelled',
    'refunded',
    'charged_back',
  ].includes(status);
}

export function isSimulatedPaymentId(id: number): boolean {
  return id >= SIMULATED_ID_BASE;
}

/**
 * Progresso de um PIX simulado (sandbox): aprovado em auto_approve_at; sem aprovação até expires_at,
 * expira (cancelled/expired). Sem mudança → null.
 */
export function simulatedPixProgress(
  record: {
    status: string;
    auto_approve_at: Date | null;
    expires_at: Date | null;
  },
  now: Date = new Date(),
): { status: string; status_detail: string } | null {
  if (record.status !== 'pending') return null;
  const approveAt = record.auto_approve_at?.getTime() ?? null;
  const expiresAt = record.expires_at?.getTime() ?? null;
  if (
    approveAt !== null &&
    now.getTime() >= approveAt &&
    (expiresAt === null || approveAt <= expiresAt)
  ) {
    return { status: 'approved', status_detail: 'accredited' };
  }
  if (expiresAt !== null && now.getTime() >= expiresAt) {
    return { status: 'cancelled', status_detail: 'expired' };
  }
  return null;
}

/** Data no formato aceito pelo Mercado Pago (ISO 8601 com fuso): 2026-10-11T19:35:00.000+00:00. */
export function mercadoPagoDate(date: Date): string {
  return date.toISOString().replace('Z', '+00:00');
}

/** Referência externa dos pagamentos deste servidor: "<slug>-cliente-<userId>-<timestamp>". */
export function externalReferenceUserId(
  reference?: string | null,
): number | null {
  const match = /-cliente-(\d+)-\d+$/.exec(reference ?? '');
  return match ? Number(match[1]) : null;
}

function paymentIdFrom(value: unknown): number | null {
  const text =
    typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  if (!/^\d{1,16}$/.test(text)) return null;
  const id = Number(text);
  return id >= 1 && id <= Number.MAX_SAFE_INTEGER ? id : null;
}

/**
 * Id do pagamento numa notificação do Mercado Pago:
 * webhook (corpo { type: "payment", data: { id } } ou ?type=payment&data.id=) ou IPN (?topic=payment&id=).
 * Outros tópicos (merchant_order, etc.) → null.
 */
export function parseWebhookPaymentId(
  body: unknown,
  query: Record<string, unknown> = {},
): number | null {
  const data = (body ?? {}) as {
    type?: unknown;
    topic?: unknown;
    action?: unknown;
    data?: { id?: unknown } | null;
  };
  const topic =
    [data.type, data.topic, query.type, query.topic].find(
      (value): value is string => typeof value === 'string' && value !== '',
    ) ?? 'payment';
  const action = typeof data.action === 'string' ? data.action : '';
  if (topic !== 'payment' && !action.startsWith('payment')) return null;
  return (
    paymentIdFrom(data.data?.id) ??
    paymentIdFrom(query['data.id']) ??
    paymentIdFrom(query.id)
  );
}

/** Nome do pagador do PIX a partir do nome do usuário logado ("Maria da Silva" → Maria / da Silva). */
export function splitPayerName(fullName?: string | null): {
  first_name: string;
  last_name: string;
} {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first_name: 'Cliente', last_name: 'Cliente' };
  return {
    first_name: parts[0],
    last_name: parts.length > 1 ? parts.slice(1).join(' ') : 'Cliente',
  };
}

/** Lê o erro do SDK do Mercado Pago (corpo JSON da API) ou de rede, sem expor dados do cartão. */
export function describeMercadoPagoError(error: unknown): {
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
    return { message, httpStatus };
  }
  const message =
    typeof error === 'string' || typeof error === 'number'
      ? String(error)
      : 'erro desconhecido';
  return { message: message || 'erro desconhecido', httpStatus: null };
}
