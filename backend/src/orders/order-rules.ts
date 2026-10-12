/**
 * Regras de negócio dos pedidos em funções puras (sem banco, sem Nest): preço, frete, troco,
 * transições de status, cancelamento, estorno, atribuição de entregador e datas no fuso da loja.
 * Cobertas por order-rules.spec.ts.
 */
import { DEFAULT_DELIVERY_ZONES } from './delivery-zones.config';
import { OrderStatus, OrderType, PaymentStatus } from './order.enums';

// ---------------------------------------------------------------------------
// Perfis
// ---------------------------------------------------------------------------

/** Usuário autenticado que executa a ação (req.user). */
export interface OrderActor {
  id: number;
  role: string;
  email?: string;
  name?: string;
}

/** Equipe da loja: Administrador, Atendente, Cozinha e Entregador. */
export const STAFF_ROLES = ['ADMIN', 'EMPLOYEE', 'KITCHEN', 'COURIER'];

/** Perfis que conduzem o fluxo completo do pedido (qualquer etapa, despacho e cancelamento). */
export const ORDER_MANAGER_ROLES = ['ADMIN', 'EMPLOYEE'];

export function isStaffRole(role?: string | null): boolean {
  return !!role && STAFF_ROLES.includes(role);
}

export function isOrderManager(role?: string | null): boolean {
  return !!role && ORDER_MANAGER_ROLES.includes(role);
}

// ---------------------------------------------------------------------------
// Formas de pagamento e limites
// ---------------------------------------------------------------------------

/** Com paymentId = pago online; sem paymentId = pago na entrega/retirada (CREDIT_CARD = maquininha). */
export const PAYMENT_METHODS = [
  'PIX',
  'CREDIT_CARD',
  'DEBIT_CARD',
  'MONEY',
] as const;
export type PaymentMethodCode = (typeof PAYMENT_METHODS)[number];

export const MAX_ITEM_QUANTITY = 50;
export const MAX_ORDER_LINES = 50;
export const MAX_ADDONS_PER_ITEM = 50;
export const MAX_OBSERVATION_LENGTH = 300;

// ---------------------------------------------------------------------------
// Dinheiro: as contas são feitas em centavos (inteiros) para evitar erros de ponto flutuante
// ---------------------------------------------------------------------------

/** Converte reais (number ou string decimal do Postgres) para centavos inteiros. */
export function toCents(value: unknown): number {
  const amount = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

/** 1234.5 → "R$ 1.234,50" */
export function formatBRL(value: number): string {
  const formatted = value.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `R$ ${formatted}`;
}

/** Maior valor de uma coluna numeric(10,2) (total do pedido, preços): R$ 99.999.999,99. */
export const MAX_MONEY_CENTS = 9_999_999_999;
export const MAX_MONEY_VALUE = fromCents(MAX_MONEY_CENTS);

/** Total acima do que o banco consegue guardar → mensagem de erro (400 antes de qualquer cobrança). */
export function orderTotalLimitError(totalCents: number): string | null {
  if (totalCents <= MAX_MONEY_CENTS) return null;
  return `O total do pedido (${formatBRL(fromCents(totalCents))}) passa do limite de ${formatBRL(MAX_MONEY_VALUE)}. Divida em pedidos menores.`;
}

// ---------------------------------------------------------------------------
// Preço dos itens
// ---------------------------------------------------------------------------

/** Preço unitário cobrado: o promocional quando definido (> 0) e menor que o preço cheio. */
export function effectiveUnitPriceCents(
  price: unknown,
  promotionPrice?: unknown,
): number {
  const full = toCents(price);
  if (
    promotionPrice === null ||
    promotionPrice === undefined ||
    promotionPrice === ''
  )
    return full;
  const promo = toCents(promotionPrice);
  return promo > 0 && promo < full ? promo : full;
}

/** Ids repetidos indicam a quantidade: [3, 3, 5] → [{ id: 3, quantity: 2 }, { id: 5, quantity: 1 }]. */
export function countAddonIds(
  ids?: readonly number[] | null,
): { id: number; quantity: number }[] {
  const counts = new Map<number, number>();
  for (const id of ids ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()].map(([id, quantity]) => ({ id, quantity }));
}

export interface LineAddon {
  priceCents: number;
  quantity: number;
}

export interface LinePrice {
  unitPriceCents: number;
  /** Adicionais de UMA unidade do item. */
  addonsCents: number;
  /** (unitário + adicionais) × quantidade. */
  lineCents: number;
}

export function priceLine(
  unitPriceCents: number,
  addons: readonly LineAddon[],
  quantity: number,
): LinePrice {
  const addonsCents = addons.reduce(
    (sum, addon) => sum + addon.priceCents * addon.quantity,
    0,
  );
  return {
    unitPriceCents,
    addonsCents,
    lineCents: (unitPriceCents + addonsCents) * quantity,
  };
}

// ---------------------------------------------------------------------------
// Entrega: taxa e tempo estimado pelo bairro (fonte única — os apps exibem o orçamento do servidor)
// As zonas vêm de delivery-zones.config.ts ou de DELIVERY_ZONES_JSON / DELIVERY_ZONES_FILE.
// ---------------------------------------------------------------------------

export interface DeliveryEstimate {
  fee: number;
  time: string;
}

export interface DeliveryZone extends DeliveryEstimate {
  /** Bairros atendidos (nome inteiro, sem diferenciar maiúsculas e acentos). */
  neighborhoods: string[];
  /** Opcional: a zona só vale nestas cidades. */
  cities?: string[];
}

export interface DeliveryZonesConfig {
  zones: DeliveryZone[];
  /** Bairro fora de todas as zonas. */
  fallback: DeliveryEstimate;
}

export const TAKEOUT_ESTIMATE: DeliveryEstimate = { fee: 0, time: '15-20 min' };
export const DEFAULT_DELIVERY_ESTIMATE: DeliveryEstimate = {
  ...DEFAULT_DELIVERY_ZONES.fallback,
};

/** Minúsculas, sem acentos e sem espaços extras ("  Maracanã " → "maracana"). */
export function normalizeText(value?: string | null): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Taxa e tempo pelo bairro: vale a primeira zona que tiver o bairro com o nome INTEIRO
 * ("Barra Funda" não é "Barra") e, quando a zona lista cidades, a mesma cidade.
 */
export function deliveryEstimate(
  neighborhood?: string | null,
  city?: string | null,
  config: DeliveryZonesConfig = DEFAULT_DELIVERY_ZONES,
): DeliveryEstimate {
  const name = normalizeText(neighborhood);
  const cityName = normalizeText(city);
  const zone = name
    ? config.zones.find(
        (candidate) =>
          candidate.neighborhoods.some(
            (item) => normalizeText(item) === name,
          ) &&
          (!candidate.cities?.length ||
            candidate.cities.some((item) => normalizeText(item) === cityName)),
      )
    : undefined;
  const estimate = zone ?? config.fallback;
  return { fee: estimate.fee, time: estimate.time };
}

function isEstimate(value: unknown): value is DeliveryEstimate {
  if (!value || typeof value !== 'object') return false;
  const { fee, time } = value as { fee?: unknown; time?: unknown };
  return (
    typeof fee === 'number' &&
    Number.isFinite(fee) &&
    fee >= 0 &&
    toCents(fee) <= MAX_MONEY_CENTS &&
    typeof time === 'string' &&
    time.trim().length > 0
  );
}

function isNameList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.trim().length > 0)
  );
}

/**
 * Lê a configuração de zonas: { fallback?, zones: [...] } ou só a lista de zonas.
 * Valor inválido → Error com a explicação (quem chama decide se usa o padrão).
 */
export function parseDeliveryZones(
  raw: unknown,
  base: DeliveryZonesConfig = DEFAULT_DELIVERY_ZONES,
): DeliveryZonesConfig {
  const data: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const list: unknown = Array.isArray(data)
    ? data
    : (data as { zones?: unknown } | null)?.zones;
  const fallback: unknown = Array.isArray(data)
    ? undefined
    : (data as { fallback?: unknown } | null)?.fallback;

  if (!Array.isArray(list))
    throw new Error('informe "zones" com a lista de zonas de entrega.');
  if (fallback !== undefined && !isEstimate(fallback))
    throw new Error(
      '"fallback" precisa de "fee" (número ≥ 0) e "time" (texto).',
    );

  const zones = list.map((zone: unknown, index): DeliveryZone => {
    const position = index + 1;
    if (!isEstimate(zone))
      throw new Error(
        `a zona ${position} precisa de "fee" (número ≥ 0) e "time" (texto).`,
      );
    const { neighborhoods, cities } = zone as Partial<DeliveryZone>;
    if (!isNameList(neighborhoods))
      throw new Error(
        `a zona ${position} precisa de "neighborhoods" (lista de bairros).`,
      );
    if (cities !== undefined && !isNameList(cities))
      throw new Error(
        `"cities" da zona ${position} precisa ser uma lista de cidades.`,
      );
    return {
      neighborhoods: neighborhoods.map((name) => name.trim()),
      ...(cities ? { cities: cities.map((name) => name.trim()) } : {}),
      fee: fromCents(toCents(zone.fee)),
      time: zone.time.trim(),
    };
  });

  const chosen = fallback ?? base.fallback;
  return {
    zones,
    fallback: { fee: fromCents(toCents(chosen.fee)), time: chosen.time.trim() },
  };
}

export interface ResolvedDeliveryZones {
  config: DeliveryZonesConfig;
  /** De onde veio: "padrão", "DELIVERY_ZONES_JSON" ou o caminho do arquivo. */
  source: string;
  /** Configuração inválida (o padrão foi usado no lugar). */
  error?: string;
}

/**
 * Zonas em uso: DELIVERY_ZONES_JSON (texto) > DELIVERY_ZONES_FILE (arquivo .json) > delivery-zones.config.ts.
 * Nunca derruba a API: configuração inválida volta para o padrão com o motivo em "error".
 */
export function resolveDeliveryZones(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string,
): ResolvedDeliveryZones {
  const inline = env.DELIVERY_ZONES_JSON?.trim();
  const file = env.DELIVERY_ZONES_FILE?.trim();
  const source = inline ? 'DELIVERY_ZONES_JSON' : file;
  if (!source) return { config: DEFAULT_DELIVERY_ZONES, source: 'padrão' };

  try {
    const raw = inline ? inline : readFile(file as string);
    return { config: parseDeliveryZones(raw), source };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      config: DEFAULT_DELIVERY_ZONES,
      source: 'padrão',
      error: `${source}: ${reason}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Troco (pagamento em dinheiro na entrega)
// ---------------------------------------------------------------------------

/** Lê valores digitados: "R$ 50,00", "50", "50.5", "1.234,56". Sem número (ex.: "Sem troco") → null. */
export function parseMoneyInput(raw?: string | null): number | null {
  if (raw === null || raw === undefined) return null;
  let text = String(raw).replace(/[^\d.,]/g, '');
  if (!/\d/.test(text)) return null;

  if (text.includes(',')) {
    // pt-BR: ponto de milhar, vírgula decimal (vale a última vírgula)
    const lastComma = text.lastIndexOf(',');
    text = `${text.slice(0, lastComma).replace(/[.,]/g, '')}.${text.slice(lastComma + 1).replace(/[.,]/g, '')}`;
  } else if (
    (text.match(/\./g) ?? []).length > 1 ||
    /^\d{1,3}\.\d{3}$/.test(text)
  ) {
    text = text.replace(/\./g, ''); // "1.500" ou "1.234.567" → milhar
  }

  const value = Number(text);
  return Number.isFinite(value) ? fromCents(toCents(value)) : null;
}

export type ChangeForResult =
  | { ok: true; value: string | null }
  | { ok: false; message: string };

/**
 * Troco só faz sentido em dinheiro. Guarda sempre no formato "R$ 50,00" (o painel da equipe lê esse formato).
 * Vazio, zero ou texto sem número → sem troco (null). Valor menor que o total → erro.
 */
export function resolveChangeFor(
  paymentMethod: string,
  raw: string | null | undefined,
  totalCents: number,
): ChangeForResult {
  if (paymentMethod !== 'MONEY') return { ok: true, value: null };

  const amount = parseMoneyInput(raw);
  if (amount === null || amount <= 0) return { ok: true, value: null };

  if (toCents(amount) < totalCents) {
    return {
      ok: false,
      message: `O valor para troco (${formatBRL(amount)}) é menor que o total do pedido (${formatBRL(fromCents(totalCents))}).`,
    };
  }
  return { ok: true, value: formatBRL(amount) };
}

// ---------------------------------------------------------------------------
// Transições de status
// ---------------------------------------------------------------------------

export type RuleDecision =
  | { ok: true }
  | { ok: false; status: 400 | 403; message: string };
export type StatusChangeDecision =
  | { ok: true; assignDriverId?: number }
  | { ok: false; status: 400 | 403; message: string };

const allow = (): { ok: true } => ({ ok: true });
const deny = (
  status: 400 | 403,
  message: string,
): { ok: false; status: 400 | 403; message: string } => ({
  ok: false,
  status,
  message,
});

export const TERMINAL_STATUSES: readonly OrderStatus[] = [
  OrderStatus.DONE,
  OrderStatus.CANCELED,
];

export function isTerminalStatus(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function invalidTransitionMessage(
  from: OrderStatus,
  to: OrderStatus,
): string {
  return `Transição inválida: ${from} → ${to}`;
}

/**
 * Transição possível para alguém (independe do perfil): DONE e CANCELED são finais,
 * não existe "mudar para o mesmo status" e pedidos de retirada nunca entram em DELIVERING.
 */
export function isValidTransition(
  from: OrderStatus,
  to: OrderStatus,
  type: OrderType,
): boolean {
  if (isTerminalStatus(from) || from === to) return false;
  if (to === OrderStatus.DELIVERING && type !== OrderType.DELIVERY)
    return false;
  return true;
}

export interface StatusChangeInput {
  role: string;
  actorId: number;
  from: OrderStatus;
  to: OrderStatus;
  type: OrderType;
  /** Entregador atual do pedido (null quando ainda não tem). */
  driverId?: number | null;
}

/**
 * PATCH /orders/:id {status}. Transição impossível → 400 "Transição inválida: X → Y";
 * possível, mas não para este perfil → 403.
 * - ADMIN/EMPLOYEE: qualquer transição válida.
 * - KITCHEN: PENDING → PREPARING e PREPARING → READY_FOR_PICKUP.
 * - COURIER: READY_FOR_PICKUP → DELIVERING (assume a entrega se ninguém assumiu) e
 *   DELIVERING → DONE apenas nas próprias entregas.
 */
export function checkStatusChange(
  input: StatusChangeInput,
): StatusChangeDecision {
  const { role, actorId, from, to, type } = input;
  const driverId = input.driverId ?? null;

  if (!isValidTransition(from, to, type))
    return deny(400, invalidTransitionMessage(from, to));
  if (isOrderManager(role)) return allow();

  if (role === 'KITCHEN') {
    const kitchenMove =
      (from === OrderStatus.PENDING && to === OrderStatus.PREPARING) ||
      (from === OrderStatus.PREPARING && to === OrderStatus.READY_FOR_PICKUP);
    return kitchenMove
      ? allow()
      : deny(
          403,
          'A cozinha só pode iniciar o preparo e marcar o pedido como pronto.',
        );
  }

  if (role === 'COURIER') {
    if (
      from === OrderStatus.READY_FOR_PICKUP &&
      to === OrderStatus.DELIVERING
    ) {
      if (driverId !== null && driverId !== actorId)
        return deny(403, 'Este pedido já está com outro entregador.');
      return driverId === null
        ? { ok: true, assignDriverId: actorId }
        : allow();
    }
    if (from === OrderStatus.DELIVERING && to === OrderStatus.DONE) {
      return driverId === actorId
        ? allow()
        : deny(
            403,
            'Somente o entregador responsável pode concluir esta entrega.',
          );
    }
    return deny(
      403,
      'O entregador só pode retirar pedidos prontos para entrega e concluir as próprias entregas.',
    );
  }

  return deny(
    403,
    'Você não tem permissão para alterar o status deste pedido.',
  );
}

/** Pagamento na entrega/retirada: ao concluir um pedido sem pagamento online, ele passa a PAID. */
export function shouldMarkPaidOnStatus(
  to: OrderStatus,
  paymentId: unknown,
): boolean {
  return (
    to === OrderStatus.DONE && (paymentId === null || paymentId === undefined)
  );
}

// ---------------------------------------------------------------------------
// Cancelamento e atribuição de entregador
// ---------------------------------------------------------------------------

export interface CancelInput {
  role: string;
  isOwner: boolean;
  status: OrderStatus;
}

/** Dono: só enquanto PENDING. ADMIN/EMPLOYEE: enquanto não for final. Demais: 403. */
export function checkCancel({
  role,
  isOwner,
  status,
}: CancelInput): RuleDecision {
  const manager = isOrderManager(role);
  if (!manager && !isOwner)
    return deny(403, 'Você não tem permissão para cancelar este pedido.');
  if (status === OrderStatus.CANCELED)
    return deny(400, 'Este pedido já está cancelado.');
  if (status === OrderStatus.DONE)
    return deny(400, 'Pedidos concluídos não podem ser cancelados.');
  if (manager || status === OrderStatus.PENDING) return allow();
  return deny(
    400,
    'O pedido já está em preparo e não pode mais ser cancelado. Fale com a loja.',
  );
}

export const ASSIGNABLE_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PREPARING,
  OrderStatus.READY_FOR_PICKUP,
  OrderStatus.DELIVERING,
];

/** PATCH /orders/:id/assign: só delivery, e só em PREPARING, READY_FOR_PICKUP ou DELIVERING. */
export function checkAssign({
  status,
  type,
}: {
  status: OrderStatus;
  type: OrderType;
}): RuleDecision {
  if (type !== OrderType.DELIVERY) {
    return deny(
      400,
      'Só pedidos de entrega (delivery) podem receber um entregador.',
    );
  }
  if (!ASSIGNABLE_STATUSES.includes(status)) {
    return deny(
      400,
      `Só é possível atribuir entregador a pedidos em preparo, prontos ou em entrega (status atual: ${status}).`,
    );
  }
  return allow();
}

// ---------------------------------------------------------------------------
// Estorno: pedido pago online e cancelado
// ---------------------------------------------------------------------------

/** Cancelar este pedido exige estornar o pagamento online (tem paymentId e está PAID). */
export function needsRefundOnCancel(order: {
  payment_id?: unknown;
  payment_status?: string | null;
}): boolean {
  return (
    order.payment_id !== null &&
    order.payment_id !== undefined &&
    order.payment_status === PaymentStatus.PAID
  );
}

/** Situação do pagamento depois da tentativa de estorno. */
export function paymentStatusAfterRefund(refunded: boolean): PaymentStatus {
  return refunded ? PaymentStatus.REFUNDED : PaymentStatus.REFUND_PENDING;
}

// ---------------------------------------------------------------------------
// GET /orders?scope=active (quadro da equipe)
// ---------------------------------------------------------------------------

/** Pedidos concluídos/cancelados continuam no quadro por estas horas depois da última mudança. */
export const ACTIVE_SCOPE_RECENT_HOURS = 24;

export type OrdersScope = 'all' | 'active';

/** Lê o parâmetro ?scope (ausente = lista completa). Valor desconhecido → null (400). */
export function parseOrdersScope(raw: unknown): OrdersScope | null {
  if (raw === undefined || raw === null || raw === '') return 'all';
  return raw === 'active' ? 'active' : null;
}

/** Desde quando pedidos finais ainda aparecem no escopo "active". */
export function activeScopeSince(now: Date = new Date()): Date {
  return new Date(now.getTime() - ACTIVE_SCOPE_RECENT_HOURS * 60 * 60 * 1000);
}

/**
 * Regra do escopo "active": pedido em andamento, finalizado nas últimas 24 h ou com estorno pendente
 * (este fica no quadro, de qualquer data, até a equipe resolver).
 */
export function isInActiveScope(
  order: {
    status: OrderStatus;
    updated_at: Date | string;
    payment_status?: string | null;
  },
  now: Date = new Date(),
): boolean {
  if (!isTerminalStatus(order.status)) return true;
  if (order.payment_status === PaymentStatus.REFUND_PENDING) return true;
  return (
    new Date(order.updated_at).getTime() >= activeScopeSince(now).getTime()
  );
}

// ---------------------------------------------------------------------------
// Datas no fuso da loja (gráficos e "hoje"): STORE_TIME_ZONE, padrão America/Sao_Paulo
// ---------------------------------------------------------------------------

export const DEFAULT_STORE_TIME_ZONE = 'America/Sao_Paulo';

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Fuso da loja (STORE_TIME_ZONE); vazio ou inválido → America/Sao_Paulo. */
export function storeTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  const zone = env.STORE_TIME_ZONE?.trim();
  return zone && isValidTimeZone(zone) ? zone : DEFAULT_STORE_TIME_ZONE;
}

/** Ano, mês e dia do calendário no fuso informado. */
function calendarDate(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) =>
    Number(parts.find((item) => item.type === type)?.value);
  return { year: part('year'), month: part('month'), day: part('day') };
}

const twoDigits = (value: number) => String(value).padStart(2, '0');

/** "dd/MM" do dia em que o instante cai no fuso da loja. */
export function dayKeyInZone(date: Date, timeZone: string): string {
  const { month, day } = calendarDate(date, timeZone);
  return `${twoDigits(day)}/${twoDigits(month)}`;
}

/** Os últimos `count` dias do calendário da loja ("dd/MM"), do mais antigo até hoje. */
export function lastDayKeys(now: Date, timeZone: string, count = 7): string[] {
  const today = calendarDate(now, timeZone);
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(
      Date.UTC(today.year, today.month - 1, today.day - (count - 1 - index)),
    );
    return `${twoDigits(day.getUTCDate())}/${twoDigits(day.getUTCMonth() + 1)}`;
  });
}

/**
 * Início seguro da busca no banco para os últimos `count` dias: a meia-noite UTC do primeiro dia
 * menos 14 h (cobre qualquer fuso). O filtro exato é feito depois, pelo dia no fuso da loja.
 */
export function chartWindowStart(now: Date, timeZone: string, count = 7): Date {
  const today = calendarDate(now, timeZone);
  const firstDay = Date.UTC(
    today.year,
    today.month - 1,
    today.day - (count - 1),
  );
  return new Date(firstDay - 14 * 60 * 60 * 1000);
}
