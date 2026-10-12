import axios from 'axios';
import api, { getApiErrorMessage } from '../../../services/api';
import { MP_PUBLIC_KEY, loadMercadoPagoSdk } from '../../../services/mercadoPago';
import { BRAND } from '../../../config/brand';
import type { CartItem } from '../../../contexts/CartContext';

// --- Contrato da API (pedidos e pagamentos) ---

export type OrderType = 'DELIVERY' | 'TAKEOUT';
export type OnlineMethod = 'CREDIT_CARD' | 'PIX';
export type OfflineMethod = 'MONEY' | 'CREDIT_CARD' | 'DEBIT_CARD';

export interface OrderItemPayload {
  productId: number;
  quantity: number;
  /** Adicionais de uma unidade; ids repetidos = quantidade (ex.: [3, 3] = 2x). */
  addonIds?: number[];
  observation?: string;
  meatPoint?: string;
  removedIngredients?: string[];
}

/** Corpo de POST /orders/quote — o mesmo "order" enviado aos pagamentos. */
export interface OrderPayload {
  items: OrderItemPayload[];
  type: OrderType;
  addressId?: number;
}

export interface Quote {
  items: { productId: number; name: string; quantity: number; unitPrice: number; addonsTotal: number; lineTotal: number }[];
  subtotal: number;
  delivery_fee: number;
  total: number;
  estimated_delivery_time: string;
  store_open: boolean;
}

export interface CardPaymentResponse {
  id: number;
  status: string;
  status_detail: string | null;
  amount: number;
  simulation?: boolean;
  /** Pedido criado pelo servidor quando o pagamento é aprovado. */
  orderId?: number;
}

export interface PixPaymentResponse {
  id: number;
  status: string;
  qr_code: string;
  qr_code_base64: string | null;
  ticket_url: string | null;
  amount: number;
  /** Vencimento do código (ISO 8601). */
  expires_at?: string | null;
  simulation?: boolean;
}

export interface PaymentStatusResponse {
  id: number;
  status: string;
  status_detail?: string | null;
  /** Presente assim que o servidor registrou o pedido do pagamento aprovado. */
  orderId?: number;
}

export const MAX_ITEM_QUANTITY = 50;
export const MAX_OBSERVATION_LENGTH = 300;

/**
 * Tempo de espera de /payment/* e /orders: o servidor pode levar 10–22 s falando com o Mercado Pago.
 * Desistir antes disso e tentar de novo arriscaria uma segunda cobrança.
 */
export const PAYMENT_TIMEOUT_MS = 45_000;
/** Prazo do PIX quando a API não informa expires_at. */
export const DEFAULT_PIX_EXPIRATION_MS = 30 * 60 * 1000;
/** Depois do vencimento, o PIX ainda é acompanhado por este tempo (pagamento no último segundo). */
export const PIX_WATCH_GRACE_MS = 2 * 60 * 1000;
/** Aprovado e ainda sem pedido: quanto esperar o servidor registrar antes de avisar o cliente. */
export const ORDER_REGISTRATION_GRACE_MS = 30_000;

// Chave pública do Mercado Pago (VITE_MP_PUBLIC_KEY; padrão: chave de TESTE)
export { MP_PUBLIC_KEY };

export function formatBRL(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** Itens do carrinho no formato da API (o carrinho já guarda um adicional por unidade). */
export function buildOrderItems(cartItems: CartItem[]): OrderItemPayload[] {
  return cartItems.map((item) => {
    const observation = item.observation?.trim().slice(0, MAX_OBSERVATION_LENGTH);
    const addonIds = (item.addons ?? []).map((addon) => Number(addon.id));
    const removed = (item.removedIngredients ?? []).filter(Boolean);
    return {
      productId: Number(item.id),
      quantity: Number(item.quantity),
      ...(addonIds.length ? { addonIds } : {}),
      ...(observation ? { observation } : {}),
      ...(item.meatPoint ? { meatPoint: item.meatPoint } : {}),
      ...(removed.length ? { removedIngredients: removed } : {}),
    };
  });
}

/** Vencimento do PIX em ms (o do servidor; sem ele, o prazo padrão). */
export function pixExpiresAt(data: Pick<PixPaymentResponse, 'expires_at'>): number {
  const parsed = data.expires_at ? Date.parse(data.expires_at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now() + DEFAULT_PIX_EXPIRATION_MS;
}

// --- Idempotência: a mesma tentativa de pagamento reenviada nunca vira duas cobranças ---

/** uuid v4 (crypto.randomUUID só existe em HTTPS/localhost; getRandomValues existe sempre). */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' && window.isSecureContext) {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Tentativa em andamento: a chave vale enquanto o pedido (payloadKey) for o mesmo. */
export interface PaymentAttempt {
  key: string;
  payloadKey: string;
}

/** Reaproveita a chave da tentativa anterior do mesmo pedido (repetição) ou cria uma nova. */
export function attemptKey(current: PaymentAttempt | null, payloadKey: string): PaymentAttempt {
  return current && current.payloadKey === payloadKey ? current : { key: newIdempotencyKey(), payloadKey };
}

/** Falha sem resposta definitiva (rede, tempo esgotado ou erro 5xx): a cobrança pode ter acontecido. */
export function isUncertainFailure(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  return !error.response || error.response.status >= 500;
}

// --- Mensagens ---

/**
 * Mensagem para o usuário: erros da API passam por getApiErrorMessage (mensagem do backend);
 * erros do próprio checkout (ex.: cartão inválido, SDK fora do ar) mostram o texto do Error.
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error) || !(error instanceof Error)) return getApiErrorMessage(error, fallback);
  return error.message || fallback;
}

const CARD_REJECTIONS: Record<string, string> = {
  cc_rejected_insufficient_amount: 'Saldo ou limite insuficiente.',
  cc_rejected_bad_filled_card_number: 'Número do cartão inválido.',
  cc_rejected_bad_filled_date: 'Data de validade inválida.',
  cc_rejected_bad_filled_security_code: 'Código de segurança (CVV) inválido.',
  cc_rejected_bad_filled_other: 'Confira os dados do cartão.',
  cc_rejected_call_for_authorize: 'Autorize o pagamento junto ao banco emissor do cartão.',
  cc_rejected_card_disabled: 'Cartão desabilitado. Ligue para o banco emissor.',
  cc_rejected_duplicated_payment: 'Pagamento duplicado. Aguarde alguns minutos antes de tentar de novo.',
  cc_rejected_high_risk: 'Pagamento recusado por segurança. Use outro cartão ou pague via PIX.',
  cc_rejected_max_attempts: 'Limite de tentativas atingido. Use outro cartão.',
  cc_rejected_blacklist: 'Pagamento não autorizado. Use outro cartão.',
};

export function cardRejectionMessage(detail?: string | null): string {
  return (detail && CARD_REJECTIONS[detail]) || 'Pagamento recusado pelo emissor do cartão. Tente outro cartão ou pague via PIX.';
}

// --- Acompanhamento do pagamento (PIX ou cartão em análise) ---

const FAILED_STATUSES = ['rejected', 'cancelled', 'refunded', 'charged_back'];

/**
 * approved: aprovado e o pedido já existe (orderId);
 * approved_pending: aprovado, mas o servidor ainda não registrou o pedido (ele registra sozinho);
 * failed: recusado, cancelado ou vencido; not_found: pagamento desconhecido;
 * timeout: continua pendente no fim do prazo; aborted: o acompanhamento foi interrompido.
 */
export type PollResult = 'approved' | 'approved_pending' | 'failed' | 'not_found' | 'timeout' | 'aborted';

export interface PollOutcome {
  result: PollResult;
  orderId?: number;
  status?: string;
  statusDetail?: string | null;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { window.clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * Consulta GET /payment/status/:id até o pedido existir, o pagamento falhar, o prazo acabar ou o
 * acompanhamento ser cancelado (signal). O próprio servidor cria o pedido quando o pagamento é aprovado.
 */
export async function pollPaymentStatus(
  paymentId: number,
  {
    intervalMs,
    timeoutMs,
    signal,
    orderGraceMs = ORDER_REGISTRATION_GRACE_MS,
    immediate = false,
  }: { intervalMs: number; timeoutMs: number; signal: AbortSignal; orderGraceMs?: number; immediate?: boolean },
): Promise<PollOutcome> {
  const deadline = Date.now() + timeoutMs;
  let approvedAt: number | null = null;
  let skipWait = immediate;

  while (!signal.aborted) {
    const limit = approvedAt !== null ? approvedAt + orderGraceMs : deadline;
    const remaining = limit - Date.now();
    if (remaining <= 0) break;
    if (!skipWait) await wait(Math.min(intervalMs, remaining), signal);
    skipWait = false;
    if (signal.aborted) break;

    try {
      const { data } = await api.get<PaymentStatusResponse>(`/payment/status/${paymentId}`, {
        signal,
        timeout: PAYMENT_TIMEOUT_MS,
      });
      if (data.status === 'approved') {
        if (typeof data.orderId === 'number') return { result: 'approved', orderId: data.orderId, status: data.status };
        approvedAt ??= Date.now();
      } else if (FAILED_STATUSES.includes(data.status)) {
        return { result: 'failed', status: data.status, statusDetail: data.status_detail ?? null };
      }
    } catch (error) {
      if (signal.aborted || axios.isCancel(error)) break;
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status === 404 || status === 403) return { result: 'not_found' };
      // Falha passageira de rede: tenta de novo na próxima volta
    }
  }

  if (signal.aborted) return { result: 'aborted' };
  return { result: approvedAt !== null ? 'approved_pending' : 'timeout' };
}

/** POST /payment/:id/cancel — o PIX deixa de valer e nunca vira pedido. 409 = já foi pago. */
export async function cancelPayment(paymentId: number): Promise<void> {
  await api.post(`/payment/${paymentId}/cancel`, undefined, { timeout: PAYMENT_TIMEOUT_MS });
}

// --- PIX em andamento, guardado na aba (por usuário) para continuar depois de recarregar ou voltar ---

export interface ActivePix {
  id: number;
  copyPaste: string;
  amount: number;
  simulation: boolean;
  /** Vencimento (ms). */
  expiresAt: number;
}

const activePixKey = (userId: number) => `${BRAND.slug}.activePix.${userId}`;

export function readActivePix(userId: number): ActivePix | null {
  try {
    const raw = sessionStorage.getItem(activePixKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActivePix> | null;
    const valid =
      !!parsed &&
      typeof parsed.id === 'number' &&
      typeof parsed.copyPaste === 'string' &&
      typeof parsed.amount === 'number' &&
      typeof parsed.expiresAt === 'number';
    if (!valid || (parsed.expiresAt as number) + PIX_WATCH_GRACE_MS < Date.now()) {
      sessionStorage.removeItem(activePixKey(userId));
      return null;
    }
    return { ...(parsed as ActivePix), simulation: !!parsed.simulation };
  } catch {
    return null;
  }
}

export function saveActivePix(userId: number, pix: ActivePix | null): void {
  try {
    if (pix) sessionStorage.setItem(activePixKey(userId), JSON.stringify(pix));
    else sessionStorage.removeItem(activePixKey(userId));
  } catch {
    // Armazenamento indisponível (modo privado): o PIX segue só nesta tela
  }
}

/** Remove o aviso antigo "pagamento aprovado sem pedido" (o servidor cria o pedido sozinho agora). */
export function clearLegacyPendingPayment(): void {
  try {
    sessionStorage.removeItem(`${BRAND.slug}.pendingPaidOrder`);
  } catch {
    // Sem acesso ao armazenamento: nada a limpar
  }
}

// --- SDK do Mercado Pago (o index.html carrega com async; aqui só esperamos ficar pronto) ---

export interface MercadoPagoPaymentMethod {
  id: string;
  payment_type_id?: string;
  settings?: { security_code?: { length?: number } }[];
}

/** Métodos do SDK usados no checkout. */
export interface MercadoPagoInstance {
  createCardToken(data: {
    cardNumber: string;
    cardholderName: string;
    cardExpirationMonth: string;
    cardExpirationYear: string;
    securityCode: string;
    identificationType: string;
    identificationNumber: string;
  }): Promise<{ id?: string }>;
  getPaymentMethods?(data: { bin: string }): Promise<{ results?: MercadoPagoPaymentMethod[] }>;
}

let mpInstance: MercadoPagoInstance | null = null;

export async function getMercadoPago(): Promise<MercadoPagoInstance> {
  if (mpInstance) return mpInstance;
  try {
    const MercadoPago = await loadMercadoPagoSdk();
    mpInstance = new MercadoPago(MP_PUBLIC_KEY, { locale: 'pt-BR' }) as MercadoPagoInstance;
    return mpInstance;
  } catch {
    throw new Error('O sistema de pagamento com cartão não carregou. Verifique sua conexão ou pague via PIX.');
  }
}

/** Pré-carrega o SDK em segundo plano (erros só aparecem quando o cliente tentar pagar). */
export function preloadMercadoPago(): void {
  getMercadoPago().catch(() => undefined);
}

/** Meio de pagamento de crédito que o Mercado Pago informa para o BIN (null = nenhum ou sem resposta). */
export async function lookupCreditMethod(digits: string): Promise<MercadoPagoPaymentMethod | null> {
  try {
    const mp = await getMercadoPago();
    const response = await mp.getPaymentMethods?.({ bin: digits.slice(0, 8) });
    return response?.results?.find((method) => method.payment_type_id === 'credit_card') ?? null;
  } catch {
    // Sem consulta ao Mercado Pago: quem chama decide pela detecção local
    return null;
  }
}
