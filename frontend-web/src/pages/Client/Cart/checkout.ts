import axios, { type AxiosRequestConfig } from 'axios';
import api, { getApiErrorMessage } from '../../../services/api';
import { getMercadoPagoInstance, type MercadoPagoInstance, type MercadoPagoPaymentMethod } from '../../../services/mercadoPago';
import { BRAND } from '../../../config/brand';
import { isDefaultStore } from '../../../utils/legacyStorage';
import { MAX_ITEM_QUANTITY, MAX_OBSERVATION_LENGTH } from '../../../utils/catalog';
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

/** Corpo de POST /stores/:slug/orders/quote — o mesmo "order" enviado aos pagamentos. Sem loja no corpo: ela vem do slug. */
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

/** Corpo de POST /stores/:slug/orders (pagamento na entrega/retirada). */
export interface CreateOrderBody extends OrderPayload {
  paymentMethod: OfflineMethod;
  changeFor?: string;
}

export interface PixPaymentBody {
  order: OrderPayload;
  idempotencyKey: string;
}

export interface CardPaymentBody {
  order: OrderPayload;
  token: string;
  paymentMethodId: string;
  installments: number;
  docType: 'CPF';
  docNumber: string;
  idempotencyKey: string;
}

// Limites do pedido: os mesmos do cardápio (utils/catalog), iguais aos da API
export { MAX_ITEM_QUANTITY, MAX_OBSERVATION_LENGTH };

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

/**
 * Chamadas da compra numa loja. A loja vem SEMPRE do slug da rota (/loja/:slug) e o backend confere se
 * ela pode vender; nada no corpo indica a loja (a API recusa campos extras).
 */
export function storeCheckoutApi(slug: string) {
  const base = `/stores/${encodeURIComponent(slug)}`;
  const withTimeout = (config?: AxiosRequestConfig): AxiosRequestConfig => ({ timeout: PAYMENT_TIMEOUT_MS, ...config });
  return {
    /** POST /stores/:slug/orders/quote: subtotal, taxa, total e prazo calculados pelo servidor. */
    quote: async (payload: OrderPayload, config?: AxiosRequestConfig) =>
      (await api.post<Quote>(`${base}/orders/quote`, payload, withTimeout(config))).data,
    /** POST /stores/:slug/orders: pedido com pagamento na entrega/retirada. */
    createOrder: async (body: CreateOrderBody) =>
      (await api.post<{ id?: number; number?: number | null }>(`${base}/orders`, body, withTimeout())).data,
    /** POST /stores/:slug/payment/pix: QR Code; o servidor cria o pedido quando o PIX for pago. */
    createPix: async (body: PixPaymentBody) =>
      (await api.post<PixPaymentResponse>(`${base}/payment/pix`, body, withTimeout())).data,
    /** POST /stores/:slug/payment/card: cobra o cartão (token do navegador); aprovado → pedido criado. */
    createCard: async (body: CardPaymentBody) =>
      (await api.post<CardPaymentResponse>(`${base}/payment/card`, body, withTimeout())).data,
  };
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

/** "code" do 400 da API quando a loja recusa endereços fora das zonas de entrega (orçamento, pedido e cobranças). */
export const DELIVERY_OUT_OF_AREA_CODE = 'DELIVERY_OUT_OF_AREA';

/** "code" informado no corpo do erro da API (ex.: DELIVERY_OUT_OF_AREA); sem ele, null. */
export function apiErrorCode(error: unknown): string | null {
  if (!axios.isAxiosError(error)) return null;
  const code = (error.response?.data as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : null;
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

// --- PIX em andamento, guardado na aba (por loja e por usuário) para continuar depois de recarregar ou voltar ---

export interface ActivePix {
  id: number;
  /** Loja em que o PIX foi gerado: só é retomado no carrinho dela. */
  storeId: number;
  copyPaste: string;
  amount: number;
  simulation: boolean;
  /** Vencimento (ms). */
  expiresAt: number;
}

const activePixKey = (storeId: number, userId: number) => `${BRAND.slug}.activePix.${storeId}.${userId}`;
/** Formato da versão de loja única (sem a loja na chave): era sempre da loja que virou a loja padrão. */
const legacyActivePixKey = (userId: number) => `${BRAND.slug}.activePix.${userId}`;

function parseActivePix(raw: string | null, storeId: number): ActivePix | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<ActivePix> | null;
  const valid =
    !!parsed &&
    typeof parsed.id === 'number' &&
    typeof parsed.copyPaste === 'string' &&
    typeof parsed.amount === 'number' &&
    typeof parsed.expiresAt === 'number' &&
    (parsed.storeId === undefined || parsed.storeId === storeId);
  if (!valid || (parsed.expiresAt as number) + PIX_WATCH_GRACE_MS < Date.now()) return null;
  return {
    id: parsed.id as number,
    storeId,
    copyPaste: parsed.copyPaste as string,
    amount: parsed.amount as number,
    simulation: !!parsed.simulation,
    expiresAt: parsed.expiresAt as number,
  };
}

/** PIX em andamento desta loja (nunca o de outra loja). Vencido ou inválido é descartado. */
export function readActivePix(storeId: number, userId: number): ActivePix | null {
  const key = activePixKey(storeId, userId);
  try {
    const pix = parseActivePix(sessionStorage.getItem(key), storeId);
    if (!pix) sessionStorage.removeItem(key);
    return pix;
  } catch {
    // Valor corrompido (ou armazenamento bloqueado): descarta
    try {
      sessionStorage.removeItem(key);
    } catch {
      // Sem acesso ao armazenamento: nada a remover
    }
    return null;
  }
}

export function saveActivePix(storeId: number, userId: number, pix: ActivePix | null): void {
  try {
    if (pix) sessionStorage.setItem(activePixKey(storeId, userId), JSON.stringify({ ...pix, storeId }));
    else sessionStorage.removeItem(activePixKey(storeId, userId));
  } catch {
    // Armazenamento indisponível (modo privado): o PIX segue só nesta tela
  }
}

/** Adoções em andamento (chamadas simultâneas, ex.: efeito repetido do StrictMode, recebem o mesmo resultado). */
const runningAdoptions = new Map<string, Promise<ActivePix | null>>();

/**
 * PIX gerado pela versão de loja única (chave sem loja), ainda em andamento nesta aba: pertence à loja
 * padrão. No carrinho da loja padrão ele passa para a chave nova e volta a ser acompanhado — evita que o
 * cliente pague um segundo PIX. Em outra loja, nada muda (ele vence sozinho).
 */
export function adoptLegacyActivePix(storeId: number, userId: number): Promise<ActivePix | null> {
  const key = `${storeId}:${userId}`;
  const running = runningAdoptions.get(key);
  if (running) return running;
  const adoption = runLegacyPixAdoption(storeId, userId).finally(() => runningAdoptions.delete(key));
  runningAdoptions.set(key, adoption);
  return adoption;
}

async function runLegacyPixAdoption(storeId: number, userId: number): Promise<ActivePix | null> {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(legacyActivePixKey(userId));
  } catch {
    return null;
  }
  if (!raw || !(await isDefaultStore(storeId))) return null;

  try {
    const pix = parseActivePix(raw, storeId);
    sessionStorage.removeItem(legacyActivePixKey(userId));
    if (pix) saveActivePix(storeId, userId, pix);
    return pix;
  } catch {
    return null;
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

// --- SDK do Mercado Pago (carregado sob demanda por services/mercadoPago; uma instância por chave pública da loja) ---

export type { MercadoPagoInstance, MercadoPagoPaymentMethod };

/** Instância do SDK para a chave pública da loja (em cache por chave). */
export function getMercadoPago(publicKey: string): Promise<MercadoPagoInstance> {
  return getMercadoPagoInstance(publicKey);
}

/** Pré-carrega o SDK em segundo plano (erros só aparecem quando o cliente tentar pagar). */
export function preloadMercadoPago(publicKey: string): void {
  getMercadoPagoInstance(publicKey).catch(() => undefined);
}

/** Meio de pagamento de crédito que o Mercado Pago informa para o BIN (null = nenhum ou sem resposta). */
export async function lookupCreditMethod(publicKey: string, digits: string): Promise<MercadoPagoPaymentMethod | null> {
  try {
    const mp = await getMercadoPagoInstance(publicKey);
    const response = await mp.getPaymentMethods?.({ bin: digits.slice(0, 8) });
    return response?.results?.find((method) => method.payment_type_id === 'credit_card') ?? null;
  } catch {
    // Sem consulta ao Mercado Pago: quem chama decide pela detecção local
    return null;
  }
}
