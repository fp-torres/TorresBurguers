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
// Entrega: taxa e tempo estimado pelo bairro ou pela faixa de CEP (fonte única — os apps exibem o
// orçamento do servidor). As zonas vêm de stores.delivery_zones ou, na loja padrão sem zonas próprias, de
// delivery-zones.config.ts / DELIVERY_ZONES_JSON / DELIVERY_ZONES_FILE. O bairro e a cidade usados são os
// canônicos do CEP quando o endereço foi conferido (addresses/address-location.ts).
// ---------------------------------------------------------------------------

export interface DeliveryEstimate {
  fee: number;
  time: string;
}

/** Faixa de CEP atendida (8 dígitos, início ≤ fim, inclusive). */
export interface ZipRange {
  from: string;
  to: string;
}

export interface DeliveryZone extends DeliveryEstimate {
  /**
   * Bairros atendidos (nome inteiro, sem diferenciar maiúsculas e acentos). Pode ficar vazio quando a zona
   * tem faixas de CEP.
   */
  neighborhoods: string[];
  /** Opcional: os bairros da zona só valem nestas cidades. */
  cities?: string[];
  /** Opcional: faixas de CEP atendidas (valem em qualquer cidade). */
  zip_ranges?: ZipRange[];
}

/**
 * Endereço fora de todas as zonas: "fallback" (padrão: entrega com a taxa e o prazo de "fallback") ou
 * "refuse" (a loja não entrega: orçamento, pedido e cobranças respondem 400).
 */
export type OutsideZonesPolicy = 'fallback' | 'refuse';
export const OUTSIDE_ZONES_POLICIES: readonly OutsideZonesPolicy[] = [
  'fallback',
  'refuse',
];

export interface DeliveryZonesConfig {
  zones: DeliveryZone[];
  /** Bairro fora de todas as zonas. */
  fallback: DeliveryEstimate;
  /** Ausente = "fallback" (o comportamento de sempre). */
  outside_zones?: OutsideZonesPolicy;
}

/**
 * Zonas próprias da loja como ficam gravadas (stores.delivery_zones): "fallback" só pode faltar com
 * outside_zones = "refuse" (no cálculo, a falta é preenchida com o "fallback" da plataforma).
 */
export type StoreDeliveryZonesConfig = Omit<DeliveryZonesConfig, 'fallback'> & {
  fallback?: DeliveryEstimate;
};

/** Local da entrega usado na escolha da zona. */
export interface DeliveryLocation {
  neighborhood?: string | null;
  city?: string | null;
  /** CEP com ou sem máscara (zonas por faixa de CEP). */
  zipCode?: string | null;
}

/** 400 do orçamento, do pedido e das cobranças quando a loja recusa endereços fora das zonas. */
export const DELIVERY_OUT_OF_AREA_MESSAGE =
  'Este endereço está fora da área de entrega da loja.';
/** Campo "code" do corpo desse 400 (o web mostra a recusa junto do endereço). */
export const DELIVERY_OUT_OF_AREA_CODE = 'DELIVERY_OUT_OF_AREA';

/** Prazo padrão da retirada no balcão (a loja pode definir o próprio em stores.takeout_estimate). */
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

/** CEP com 8 dígitos ("22041-001" → "22041001"); outro formato → null. */
export function zipCodeDigits(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const digits =
    typeof value === 'number'
      ? String(value).padStart(8, '0')
      : value.replace(/\D/g, '');
  return /^\d{8}$/.test(digits) ? digits : null;
}

/**
 * Zona que atende o local: vale a PRIMEIRA zona (na ordem cadastrada) que tiver o bairro com o nome INTEIRO
 * ("Barra Funda" não é "Barra") e, quando a zona lista cidades, a mesma cidade — ou que tiver o CEP numa
 * das faixas de CEP. Nenhuma → undefined (endereço fora das zonas).
 */
export function findDeliveryZone(
  location: DeliveryLocation,
  config: DeliveryZonesConfig,
): DeliveryZone | undefined {
  const name = normalizeText(location.neighborhood);
  const cityName = normalizeText(location.city);
  const zip = zipCodeDigits(location.zipCode);
  return config.zones.find(
    (zone) =>
      (!!name &&
        zone.neighborhoods.some((item) => normalizeText(item) === name) &&
        (!zone.cities?.length ||
          zone.cities.some((item) => normalizeText(item) === cityName))) ||
      (!!zip &&
        (zone.zip_ranges ?? []).some(
          (range) => range.from <= zip && zip <= range.to,
        )),
  );
}

/** Política para endereços fora das zonas (ausente ou desconhecida = "fallback"). */
export function outsideZonesPolicy(
  config?: { outside_zones?: unknown } | null,
): OutsideZonesPolicy {
  return config?.outside_zones === 'refuse' ? 'refuse' : 'fallback';
}

/**
 * Taxa e prazo da entrega no local: os da zona ou, fora das zonas, os de "fallback"; null quando a loja
 * recusa endereços fora das zonas (outside_zones = "refuse").
 */
export function deliveryEstimateAt(
  location: DeliveryLocation,
  config: DeliveryZonesConfig,
): DeliveryEstimate | null {
  const zone = findDeliveryZone(location, config);
  if (!zone && outsideZonesPolicy(config) === 'refuse') return null;
  const estimate = zone ?? config.fallback;
  return { fee: estimate.fee, time: estimate.time };
}

/**
 * Taxa e tempo pelo bairro (e cidade/CEP): a zona ou, fora das zonas, o "fallback" (sem a política de
 * recusa: ver deliveryEstimateAt).
 */
export function deliveryEstimate(
  neighborhood?: string | null,
  city?: string | null,
  config: DeliveryZonesConfig = DEFAULT_DELIVERY_ZONES,
  zipCode?: string | null,
): DeliveryEstimate {
  const estimate =
    findDeliveryZone({ neighborhood, city, zipCode }, config) ??
    config.fallback;
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

/** Faixas de CEP de uma zona: [{ "from": "22010-000", "to": "22099-999" }] → 8 dígitos, início ≤ fim. */
function parseZipRanges(
  value: unknown,
  position: number,
): ZipRange[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value))
    throw new Error(
      `"zip_ranges" da zona ${position} precisa ser uma lista de faixas { "from", "to" }.`,
    );
  return value.map((item: unknown, index): ZipRange => {
    const label = `faixa de CEP ${index + 1} da zona ${position}`;
    const range = (item && typeof item === 'object' ? item : {}) as {
      from?: unknown;
      to?: unknown;
    };
    const from = zipCodeDigits(range.from);
    const to = zipCodeDigits(range.to);
    if (!from || !to)
      throw new Error(
        `a ${label} precisa de "from" e "to" com os 8 dígitos do CEP (ex.: 22010-000).`,
      );
    if (from > to)
      throw new Error(
        `na ${label}, o CEP inicial precisa ser menor ou igual ao final.`,
      );
    return { from, to };
  });
}

/** "outside_zones": "fallback" ou "refuse" (sem diferenciar maiúsculas); ausente/null → undefined. */
export function parseOutsideZones(
  value: unknown,
): OutsideZonesPolicy | undefined {
  if (value === undefined || value === null) return undefined;
  const policy = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if ((OUTSIDE_ZONES_POLICIES as readonly string[]).includes(policy))
    return policy as OutsideZonesPolicy;
  throw new Error(
    '"outside_zones" deve ser "fallback" (entrega fora das zonas com a taxa de "fallback") ou "refuse" (recusa endereços fora das zonas).',
  );
}

/**
 * Lê a configuração de zonas: { fallback?, zones: [...], outside_zones? } ou só a lista de zonas.
 * Cada zona tem bairros ("neighborhoods", com "cities" opcional) e/ou faixas de CEP ("zip_ranges").
 * Sem "fallback" (ou null), vale o da base. Valor inválido → Error com a explicação (quem chama decide se
 * usa o padrão).
 */
export function parseDeliveryZones(
  raw: unknown,
  base: DeliveryZonesConfig = DEFAULT_DELIVERY_ZONES,
): DeliveryZonesConfig {
  const data: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const list: unknown = Array.isArray(data)
    ? data
    : (data as { zones?: unknown } | null)?.zones;
  const object = Array.isArray(data)
    ? null
    : (data as { fallback?: unknown; outside_zones?: unknown } | null);
  const fallback: unknown = object?.fallback ?? undefined;

  if (!Array.isArray(list))
    throw new Error('informe "zones" com a lista de zonas de entrega.');
  if (fallback !== undefined && !isEstimate(fallback))
    throw new Error(
      '"fallback" precisa de "fee" (número ≥ 0) e "time" (texto).',
    );
  const policy = parseOutsideZones(object?.outside_zones);

  const zones = list.map((zone: unknown, index): DeliveryZone => {
    const position = index + 1;
    if (!isEstimate(zone))
      throw new Error(
        `a zona ${position} precisa de "fee" (número ≥ 0) e "time" (texto).`,
      );
    const { neighborhoods, cities } = zone as Partial<DeliveryZone>;
    const ranges = parseZipRanges(
      (zone as { zip_ranges?: unknown }).zip_ranges,
      position,
    );
    // Só com faixas de CEP, a lista de bairros pode faltar ou vir vazia
    const onlyRanges =
      !!ranges?.length &&
      (neighborhoods === undefined ||
        (Array.isArray(neighborhoods) && neighborhoods.length === 0));
    if (!onlyRanges && !isNameList(neighborhoods))
      throw new Error(
        `a zona ${position} precisa de "neighborhoods" (lista de bairros) ou "zip_ranges" (faixas de CEP).`,
      );
    if (cities !== undefined && !isNameList(cities))
      throw new Error(
        `"cities" da zona ${position} precisa ser uma lista de cidades.`,
      );
    return {
      neighborhoods: onlyRanges
        ? []
        : (neighborhoods as string[]).map((name) => name.trim()),
      ...(cities ? { cities: cities.map((name) => name.trim()) } : {}),
      ...(ranges?.length ? { zip_ranges: ranges } : {}),
      fee: fromCents(toCents(zone.fee)),
      time: zone.time.trim(),
    };
  });

  const chosen = fallback ?? base.fallback;
  return {
    zones,
    fallback: { fee: fromCents(toCents(chosen.fee)), time: chosen.time.trim() },
    ...(policy ? { outside_zones: policy } : {}),
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
// Operação da loja: entrega/retirada ligadas, zonas e prazo de retirada próprios
// ---------------------------------------------------------------------------

export const DELIVERY_DISABLED_MESSAGE =
  'Esta loja não está fazendo entregas no momento. Escolha retirar no balcão.';
export const TAKEOUT_DISABLED_MESSAGE =
  'Esta loja não está aceitando retirada no balcão no momento. Escolha a entrega.';
export const DELIVERY_ZONES_MISSING_MESSAGE =
  'Esta loja ainda não configurou as taxas de entrega. Escolha retirar no balcão.';

/**
 * Entrega sem zonas próprias (stores.delivery_zones nulo): só a loja padrão usa as zonas da
 * plataforma (DELIVERY_ZONES_* — compatibilidade com a instalação de loja única). Nas demais lojas,
 * as taxas da plataforma não valem (outra cidade, outros bairros): a entrega fica indisponível
 * até a loja configurar as próprias zonas.
 */
export function deliveryZonesMissing(
  store: { delivery_zones?: unknown },
  isDefaultStore: boolean,
): boolean {
  return (
    (store.delivery_zones === null || store.delivery_zones === undefined) &&
    !isDefaultStore
  );
}

/**
 * Tipo de pedido desligado nas configurações da loja → mensagem do 400 (null = permitido).
 * Só "true" libera (falha fechada se a configuração não vier).
 */
export function orderTypeUnavailableMessage(
  type: OrderType,
  store: {
    delivery_enabled?: boolean | null;
    takeout_enabled?: boolean | null;
  },
): string | null {
  if (type === OrderType.DELIVERY && store.delivery_enabled !== true)
    return DELIVERY_DISABLED_MESSAGE;
  if (type === OrderType.TAKEOUT && store.takeout_enabled !== true)
    return TAKEOUT_DISABLED_MESSAGE;
  return null;
}

/**
 * Zonas de entrega da loja (stores.delivery_zones) ou, sem elas, as da plataforma.
 * Configuração inválida gravada no banco → as da plataforma, com o motivo em "error" (nunca derruba o pedido).
 */
export function storeDeliveryZones(
  storeZones: unknown,
  platform: DeliveryZonesConfig,
): { config: DeliveryZonesConfig; error?: string } {
  if (storeZones === null || storeZones === undefined)
    return { config: platform };
  try {
    return { config: parseDeliveryZones(storeZones, platform) };
  } catch (error) {
    return {
      config: platform,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Retirada no balcão: sem taxa, no prazo da loja (stores.takeout_estimate) ou no padrão. */
export function takeoutEstimateFor(
  storeEstimate?: string | null,
): DeliveryEstimate {
  const time = storeEstimate?.trim();
  return { fee: 0, time: time || TAKEOUT_ESTIMATE.time };
}

/**
 * Mesmo bairro (nome inteiro, sem acentos/maiúsculas) e, quando os dois informam, a mesma cidade.
 * Usado para agrupar entregas ("pedidos próximos").
 */
export function isSameDeliveryArea(
  a: { neighborhood?: string | null; city?: string | null } | null,
  b: { neighborhood?: string | null; city?: string | null } | null,
): boolean {
  if (!a || !b) return false;
  const neighborhood = normalizeText(a.neighborhood);
  if (!neighborhood || neighborhood !== normalizeText(b.neighborhood))
    return false;
  const cityA = normalizeText(a.city);
  const cityB = normalizeText(b.city);
  return !cityA || !cityB || cityA === cityB;
}

/** 403 para o cliente quando a loja atingiu o limite mensal de pedidos do plano. */
export const MONTHLY_ORDERS_LIMIT_MESSAGE =
  'Esta loja atingiu o limite de pedidos do plano neste mês e não está recebendo novos pedidos agora.';

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
 * Teto do troco: o valor informado pode passar do total em até R$ 200,00 (a maior cédula). Quem paga
 * com mais do que isso teria uma cédula sobrando; acima do teto o valor é erro de digitação ou abuso e
 * faria o entregador sair com muito dinheiro em espécie.
 */
export const MAX_CHANGE_ABOVE_TOTAL_CENTS = 20_000;

/**
 * Troco só faz sentido em dinheiro. Guarda sempre no formato "R$ 50,00" (o painel da equipe lê esse formato).
 * Vazio, zero ou texto sem número → sem troco (null). Valor menor que o total ou acima do teto
 * (total + R$ 200,00) → erro.
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
  if (toCents(amount) - totalCents > MAX_CHANGE_ABOVE_TOTAL_CENTS) {
    return {
      ok: false,
      message: `Valor para troco acima do permitido: informe até ${formatBRL(fromCents(totalCents + MAX_CHANGE_ABOVE_TOTAL_CENTS))} (no máximo ${formatBRL(fromCents(MAX_CHANGE_ABOVE_TOTAL_CENTS))} acima do total do pedido).`,
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

/** Teto do quadro (scope=active e as listas da cozinha e do entregador), mais novos primeiro. */
export const ACTIVE_ORDERS_LIMIT = 500;

// ---------------------------------------------------------------------------
// Páginas das listas (GET /orders sem scope e GET /orders/my-orders): a resposta continua sendo
// uma lista; sem parâmetros, os ORDERS_PAGE_MAX_SIZE mais recentes.
// ---------------------------------------------------------------------------

export const ORDERS_PAGE_MAX_SIZE = 100;
/** Evita OFFSET gigantes (cada página pula as anteriores no banco). */
export const ORDERS_PAGE_MAX = 10_000;

export const ORDERS_PAGE_INVALID_MESSAGE = `Paginação inválida: use page de 1 a ${ORDERS_PAGE_MAX} e pageSize de 1 a ${ORDERS_PAGE_MAX_SIZE}.`;

export interface ListPage {
  skip: number;
  take: number;
}

function pageNumber(raw: unknown, fallback: number, max: number) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string' || !/^\d{1,6}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= 1 && value <= max ? value : null;
}

/** ?page=&pageSize= (inteiros; padrão: página 1 com ORDERS_PAGE_MAX_SIZE). Inválido → null (400). */
export function parseListPage(
  rawPage: unknown,
  rawSize: unknown,
): ListPage | null {
  const page = pageNumber(rawPage, 1, ORDERS_PAGE_MAX);
  const size = pageNumber(rawSize, ORDERS_PAGE_MAX_SIZE, ORDERS_PAGE_MAX_SIZE);
  if (page === null || size === null) return null;
  return { skip: (page - 1) * size, take: size };
}

// ---------------------------------------------------------------------------
// O que cada perfil da equipe enxerga (lista, quadro e detalhe de pedidos)
// ---------------------------------------------------------------------------

/**
 * Um conjunto de pedidos visíveis a um perfil: as condições valem juntas e os conjuntos se somam.
 * driver "none" = sem entregador; "self" = o entregador é quem está autenticado. recent = atualizados
 * nas últimas ACTIVE_SCOPE_RECENT_HOURS horas.
 */
export interface StaffOrderScope {
  statuses: readonly OrderStatus[];
  type?: OrderType;
  driver?: 'none' | 'self';
  recent?: boolean;
}

/** Cozinha: os pedidos que esperam o preparo e os em preparo. */
const KITCHEN_ORDER_SCOPES: readonly StaffOrderScope[] = [
  { statuses: [OrderStatus.PENDING, OrderStatus.PREPARING] },
];

/**
 * Entregador: entregas prontas sem entregador, as próprias prontas/em andamento e as próprias
 * concluídas ou canceladas nas últimas 24 h.
 */
const COURIER_ORDER_SCOPES: readonly StaffOrderScope[] = [
  {
    statuses: [OrderStatus.READY_FOR_PICKUP],
    type: OrderType.DELIVERY,
    driver: 'none',
  },
  {
    statuses: [OrderStatus.READY_FOR_PICKUP, OrderStatus.DELIVERING],
    driver: 'self',
  },
  { statuses: TERMINAL_STATUSES, driver: 'self', recent: true },
];

/**
 * Pedidos da loja que o perfil lê: null = todos (ADMIN e EMPLOYEE); cozinha e entregador só os da
 * própria etapa; outro perfil, nenhum. A mesma regra vale para a lista e para o detalhe (fora dela → 404).
 */
export function staffOrderScopes(
  role?: string | null,
): readonly StaffOrderScope[] | null {
  if (isOrderManager(role)) return null;
  if (role === 'KITCHEN') return KITCHEN_ORDER_SCOPES;
  if (role === 'COURIER') return COURIER_ORDER_SCOPES;
  return [];
}

/** O pedido está entre os que o perfil enxerga? (mesma regra da consulta de staffOrderScopes) */
export function canStaffSeeOrder(
  order: {
    status: OrderStatus;
    type: OrderType;
    driverId: number | null;
    updated_at: Date | string;
  },
  actor: { id: number; role: string },
  now: Date = new Date(),
): boolean {
  const scopes = staffOrderScopes(actor.role);
  if (scopes === null) return true;
  return scopes.some(
    (scope) =>
      scope.statuses.includes(order.status) &&
      (!scope.type || order.type === scope.type) &&
      (scope.driver !== 'none' || order.driverId === null) &&
      (scope.driver !== 'self' || order.driverId === actor.id) &&
      (!scope.recent ||
        new Date(order.updated_at).getTime() >=
          activeScopeSince(now).getTime()),
  );
}

/** Como a equipe recebe o pedido: completo (gestão), da cozinha ou do entregador. */
export type StaffOrderView = 'full' | 'kitchen' | 'courier';

export function staffOrderView(role?: string | null): StaffOrderView {
  if (role === 'KITCHEN') return 'kitchen';
  if (role === 'COURIER') return 'courier';
  return 'full';
}

// ---------------------------------------------------------------------------
// Datas no fuso da loja (gráficos, relatórios e "hoje"): stores.time_zone, padrão America/Sao_Paulo
// ---------------------------------------------------------------------------

export const DEFAULT_STORE_TIME_ZONE = 'America/Sao_Paulo';

export function isValidTimeZone(timeZone: string): boolean {
  try {
    zoneFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/*
 * Desempenho: criar um Intl.DateTimeFormat custa ~100 µs, e os relatórios convertem um instante por
 * pedido (200 mil pedidos = 20 s de event loop travado para todas as lojas). Os formatadores ficam em
 * cache por fuso (são imutáveis) e a diferença do fuso para o UTC fica em cache por hora UTC: dentro
 * de uma hora em que ela não muda (conferida no primeiro e no último segundo), o dia sai de uma soma.
 * Horas com troca de horário de verão (ex.: 30 min em Lord Howe) são calculadas instante a instante.
 * Caches limitados: no máximo ZONE_CACHE_LIMIT fusos e OFFSET_CACHE_LIMIT horas (esvaziam ao encher).
 */
const ZONE_CACHE_LIMIT = 100;
const OFFSET_CACHE_LIMIT = 50_000;
const HOUR_MS = 60 * 60 * 1000;
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();
const zoneOffsets = new Map<string, Map<number, number>>();
let cachedOffsets = 0;

/** Formatador (ano a segundo, relógio de 24 h) do fuso; fuso inválido → RangeError (não entra no cache). */
function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    if (zoneFormatters.size >= ZONE_CACHE_LIMIT) {
      zoneFormatters.clear();
      zoneOffsets.clear();
      cachedOffsets = 0;
    }
    zoneFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Diferença exata (ms) entre o relógio do fuso e o UTC no segundo do instante. */
function exactZoneOffsetMs(instant: number, timeZone: string): number {
  const second = Math.floor(instant / 1000) * 1000;
  const values: Record<string, number> = {};
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(second))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    values.year,
    values.month - 1,
    values.day,
    values.hour,
    values.minute,
    values.second,
  );
  return asUtc - second;
}

/** Diferença (ms) entre o relógio do fuso e o UTC num instante (com o cache por hora). */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const hour = Math.floor(instant / HOUR_MS);
  let offsets = zoneOffsets.get(timeZone);
  let offset = offsets?.get(hour);
  if (offset === undefined) {
    const start = hour * HOUR_MS;
    const first = exactZoneOffsetMs(start, timeZone);
    const last = exactZoneOffsetMs(start + HOUR_MS - 1000, timeZone);
    // NaN marca uma hora com troca de fuso: calculada instante a instante
    offset = first === last ? first : NaN;
    if (cachedOffsets >= OFFSET_CACHE_LIMIT) {
      zoneOffsets.clear();
      cachedOffsets = 0;
      offsets = undefined;
    }
    if (!offsets) {
      offsets = new Map();
      zoneOffsets.set(timeZone, offsets);
    }
    offsets.set(hour, offset);
    cachedOffsets++;
  }
  return Number.isNaN(offset) ? exactZoneOffsetMs(instant, timeZone) : offset;
}

/** Fuso informado (ex.: stores.time_zone); vazio ou inválido → America/Sao_Paulo. */
export function resolveTimeZone(zone?: string | null): string {
  const value = zone?.trim();
  return value && isValidTimeZone(value) ? value : DEFAULT_STORE_TIME_ZONE;
}

/**
 * Fuso padrão da plataforma (STORE_TIME_ZONE); vazio ou inválido → America/Sao_Paulo.
 * Cada loja tem o próprio fuso em stores.time_zone (use resolveTimeZone).
 */
export function storeTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  return resolveTimeZone(env.STORE_TIME_ZONE);
}

/** Ano, mês e dia do calendário no fuso informado. */
function calendarDate(date: Date, timeZone: string) {
  const instant = date.getTime();
  const local = new Date(instant + zoneOffsetMs(instant, timeZone));
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
  };
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

// ---------------------------------------------------------------------------
// Relatórios: períodos de datas "AAAA-MM-DD" no calendário da loja
// ---------------------------------------------------------------------------

/** Maior período de um relatório (um ano, inclusive bissexto). */
export const REPORT_MAX_DAYS = 366;
/** Período quando nenhuma data é informada: os últimos 30 dias até hoje. */
export const REPORT_DEFAULT_DAYS = 30;

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function formatDateKey(utcMidnight: number): string {
  const date = new Date(utcMidnight);
  return `${date.getUTCFullYear()}-${twoDigits(date.getUTCMonth() + 1)}-${twoDigits(date.getUTCDate())}`;
}

/** "AAAA-MM-DD" existente no calendário → meia-noite UTC daquele dia; senão null (ex.: 2026-02-30). */
function dateKeyToUtc(value: string): number | null {
  const match = DATE_KEY_PATTERN.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const time = Date.UTC(year, month - 1, day);
  return formatDateKey(time) === value ? time : null;
}

/** "AAAA-MM-DD" do dia em que o instante cai no fuso da loja. */
export function dateKeyInZone(date: Date, timeZone: string): string {
  const { year, month, day } = calendarDate(date, timeZone);
  return `${year}-${twoDigits(month)}-${twoDigits(day)}`;
}

/** Soma (ou subtrai) dias de uma data "AAAA-MM-DD" (calendário puro, sem fuso). */
export function addDaysToKey(key: string, days: number): string {
  const [year, month, day] = key.split('-').map(Number);
  return formatDateKey(Date.UTC(year, month - 1, day + days));
}

/** Todos os dias de from até to (inclusive), em ordem. */
export function dateKeysBetween(from: string, to: string): string[] {
  const keys: string[] = [];
  for (let key = from; key <= to; key = addDaysToKey(key, 1)) keys.push(key);
  return keys;
}

/** Instante da meia-noite do dia "AAAA-MM-DD" no fuso da loja (duas passadas acertam o horário de verão). */
export function startOfDayInZone(key: string, timeZone: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  const localMidnight = Date.UTC(year, month - 1, day);
  let guess = localMidnight - zoneOffsetMs(localMidnight, timeZone);
  guess = localMidnight - zoneOffsetMs(guess, timeZone);
  return new Date(guess);
}

export type ReportRange =
  | { ok: true; from: string; to: string; days: number }
  | { ok: false; message: string };

/**
 * Período de GET /orders/reports (?from=AAAA-MM-DD&to=AAAA-MM-DD, datas do calendário da loja):
 * sem datas = os últimos 30 dias até hoje; só "from" = até hoje; só "to" = os 30 dias até ele.
 * Formato inválido, from depois de to ou mais de 366 dias → mensagem do 400.
 */
export function parseReportRange(
  rawFrom: unknown,
  rawTo: unknown,
  now: Date,
  timeZone: string,
): ReportRange {
  const given = (value: unknown) =>
    value !== undefined && value !== null && value !== '';
  const invalid = {
    ok: false as const,
    message:
      'Período inválido: informe from e to no formato AAAA-MM-DD (ex.: from=2026-10-01&to=2026-10-31).',
  };
  for (const value of [rawFrom, rawTo]) {
    if (
      given(value) &&
      (typeof value !== 'string' || dateKeyToUtc(value) === null)
    )
      return invalid;
  }

  const today = dateKeyInZone(now, timeZone);
  const to = given(rawTo) ? (rawTo as string) : today;
  const from = given(rawFrom)
    ? (rawFrom as string)
    : addDaysToKey(to, -(REPORT_DEFAULT_DAYS - 1));

  const fromTime = dateKeyToUtc(from) as number;
  const toTime = dateKeyToUtc(to) as number;
  if (fromTime > toTime) {
    return {
      ok: false,
      message: 'A data inicial (from) não pode ser depois da data final (to).',
    };
  }
  const days = Math.round((toTime - fromTime) / 86_400_000) + 1;
  if (days > REPORT_MAX_DAYS) {
    return {
      ok: false,
      message: `O período do relatório pode ter no máximo ${REPORT_MAX_DAYS} dias.`,
    };
  }
  return { ok: true, from, to, days };
}
