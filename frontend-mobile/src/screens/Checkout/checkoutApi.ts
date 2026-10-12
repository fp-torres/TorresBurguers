import axios from 'axios';
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import api, { LONG_TIMEOUT_MS } from '../../services/api';
import { BRAND } from '../../config/brand';
import { getErrorMessage } from '../../utils/errors';
import { normalizeObservation } from '../../utils/catalog';
import type { CartItem } from '../../contexts/CartContext';
import type { AppStackParamList } from '../../routes/app.routes';

// --- Contrato da API (pedidos e pagamentos) ---

export type OrderType = 'DELIVERY' | 'TAKEOUT';
/** Com paymentId = pago pelo app; sem = pago na entrega/retirada (CREDIT_CARD/DEBIT_CARD = maquininha). */
export type PaymentMethodCode = 'PIX' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'MONEY';

export interface OrderItemPayload {
  productId: number;
  quantity: number;
  /** Adicionais de uma unidade; ids repetidos = quantidade (ex.: [3, 3] = 2x). */
  addonIds?: number[];
  /** Ponto da carne (só hambúrgueres). */
  meatPoint?: string;
  /** Observação para a cozinha (até 300 caracteres). */
  observation?: string;
}

/** Corpo de POST /orders/quote — o mesmo "order" enviado aos pagamentos. */
export interface QuotePayload {
  items: OrderItemPayload[];
  type: OrderType;
  addressId?: number;
}

/** Pedido levado às telas de pagamento: o corpo do orçamento + a forma escolhida. */
export interface CheckoutOrder extends QuotePayload {
  paymentMethod: PaymentMethodCode;
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

/** Parâmetros da tela PaymentPix. */
export interface PaymentPixParams {
  payment_id: number;
  qr_code: string;
  qr_code_base64: string;
  total: number;
  /** Vencimento do código (ms). */
  expires_at: number;
  simulation?: boolean;
}

/** Parâmetros da tela PaymentCard. */
export interface PaymentCardParams {
  payload_order: CheckoutOrder;
  total: number;
  email: string;
}

/** Chave pública do Mercado Pago (EXPO_PUBLIC_MP_PUBLIC_KEY no .env; padrão: chave de TESTE). */
export const MP_PUBLIC_KEY = process.env.EXPO_PUBLIC_MP_PUBLIC_KEY || 'TEST-6aeab6dc-85c6-4d63-b0e6-8f605114628d';
export const IS_TEST_KEY = MP_PUBLIC_KEY.startsWith('TEST-');

/** Prazo do PIX quando a API não informa expires_at. */
export const DEFAULT_PIX_EXPIRATION_MS = 30 * 60 * 1000;
/** Depois do vencimento, o PIX ainda é acompanhado por este tempo (pagamento no último segundo). */
export const PIX_WATCH_GRACE_MS = 2 * 60 * 1000;
/** Aprovado e ainda sem pedido: quanto esperar o servidor registrar antes de avisar o cliente. */
export const ORDER_REGISTRATION_GRACE_MS = 30_000;

/**
 * Itens do carrinho no formato da API: cada adicional repetido conforme a quantidade escolhida,
 * mais o ponto da carne e a observação quando houver.
 */
export function buildOrderItems(cart: CartItem[]): OrderItemPayload[] {
  return cart.map((item) => {
    const addonIds = item.addons.flatMap(({ addon, quantity }) =>
      Array.from({ length: Math.max(0, quantity) }, () => addon.id),
    );
    const observation = normalizeObservation(item.observation);
    return {
      productId: item.product.id,
      quantity: item.quantity,
      ...(addonIds.length ? { addonIds } : {}),
      ...(item.meatPoint ? { meatPoint: item.meatPoint } : {}),
      ...(observation ? { observation } : {}),
    };
  });
}

/** Separa o corpo do orçamento (o que é enviado a /payment/*) da forma de pagamento. */
export function toQuotePayload(order: CheckoutOrder | QuotePayload): QuotePayload {
  return {
    items: order.items,
    type: order.type,
    ...(order.addressId ? { addressId: order.addressId } : {}),
  };
}

/** Vencimento do PIX em ms (o do servidor; sem ele, o prazo padrão). */
export function pixExpiresAt(data: Pick<PixPaymentResponse, 'expires_at'>): number {
  const parsed = data.expires_at ? Date.parse(data.expires_at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now() + DEFAULT_PIX_EXPIRATION_MS;
}

/** POST /orders/quote com o tempo longo dos pedidos. */
export async function fetchQuote(payload: QuotePayload): Promise<Quote> {
  const { data } = await api.post<Quote>('/orders/quote', payload, { timeout: LONG_TIMEOUT_MS });
  return data;
}

/**
 * Mensagem para o usuário: erros da API passam por getErrorMessage (mensagem do backend);
 * erros do próprio pagamento (ex.: cartão inválido) mostram o texto do Error.
 */
export function checkoutErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error) || !(error instanceof Error)) return getErrorMessage(error, fallback);
  return error.message || fallback;
}

/** Falha sem resposta definitiva (rede, tempo esgotado ou erro 5xx): a cobrança pode ter acontecido. */
export function isUncertainFailure(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  return !error.response || error.response.status >= 500;
}

/** Alerta com "voltar" e "continuar" (true = continuar). */
export function confirmAlert(title: string, message: string, confirmLabel: string, cancelLabel = 'Cancelar'): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: cancelLabel, style: 'cancel', onPress: () => resolve(false) },
        { text: confirmLabel, onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

// --- Idempotência: a mesma tentativa de pagamento reenviada nunca vira duas cobranças ---

/** uuid v4 da tentativa (identifica a tentativa; não é segredo). */
export function newIdempotencyKey(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    return (char === 'x' ? random : (random % 4) + 8).toString(16);
  });
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

// --- Recusas do cartão ---

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
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
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
        timeout: LONG_TIMEOUT_MS,
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

/** Consulta única do status (null = sem resposta). */
export async function fetchPaymentStatus(paymentId: number): Promise<PaymentStatusResponse | null> {
  try {
    const { data } = await api.get<PaymentStatusResponse>(`/payment/status/${paymentId}`, { timeout: LONG_TIMEOUT_MS });
    return data;
  } catch (error) {
    // Pagamento desconhecido (ex.: de outra conta): não há o que acompanhar
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    return status === 404 || status === 403 ? { id: paymentId, status: 'cancelled' } : null;
  }
}

export function isFailedPaymentStatus(status: string): boolean {
  return FAILED_STATUSES.includes(status);
}

/** POST /payment/:id/cancel — o PIX deixa de valer e nunca vira pedido. 409 = já foi pago. */
export async function cancelPayment(paymentId: number): Promise<void> {
  await api.post(`/payment/${paymentId}/cancel`, undefined, { timeout: LONG_TIMEOUT_MS });
}

// --- Depois do pagamento ---

type AppNavigation = NativeStackNavigationProp<AppStackParamList>;

/** Pedido registrado: abre os detalhes dele, com Meus Pedidos e a Home por baixo (sem as telas de pagamento). */
export function showCreatedOrder(navigation: AppNavigation, orderId: number) {
  navigation.reset({
    index: 2,
    routes: [{ name: 'Home' }, { name: 'MyOrders' }, { name: 'OrderDetails', params: { order_id: orderId } }],
  });
}

// --- PIX em andamento, guardado no aparelho (por usuário) ---
// Sair da tela, fechar o app ou ele ser encerrado pelo sistema não perde o código: o checkout
// mostra o PIX pendente e reabre o mesmo código em vez de gerar outro.

export interface StoredPix {
  /** Pedido (corpo do orçamento) que o PIX paga. */
  payloadKey: string;
  params: PaymentPixParams;
}

const activePixKey = (userId: number) => `@${BRAND.slug}:activePix:${userId}`;

export async function loadActivePix(userId: number): Promise<StoredPix | null> {
  try {
    const raw = await AsyncStorage.getItem(activePixKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPix> | null;
    const params = parsed?.params;
    const valid =
      !!params &&
      typeof parsed?.payloadKey === 'string' &&
      typeof params.payment_id === 'number' &&
      typeof params.qr_code === 'string' &&
      typeof params.expires_at === 'number';
    if (!valid || params.expires_at + PIX_WATCH_GRACE_MS < Date.now()) {
      await AsyncStorage.removeItem(activePixKey(userId));
      return null;
    }
    return parsed as StoredPix;
  } catch {
    return null;
  }
}

export async function storeActivePix(userId: number, value: StoredPix | null): Promise<void> {
  try {
    if (value) await AsyncStorage.setItem(activePixKey(userId), JSON.stringify(value));
    else await AsyncStorage.removeItem(activePixKey(userId));
  } catch {
    // Armazenamento indisponível: o PIX segue só na tela
  }
}
