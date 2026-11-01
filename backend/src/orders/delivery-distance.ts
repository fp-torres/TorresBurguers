/**
 * Entrega cobrada por DISTÂNCIA em km (funções puras, sem banco nem Nest; cobertas por delivery-distance.spec.ts).
 *
 * A loja escolhe o modo de cobrança no JSON de entrega (stores.delivery_zones): "zones" (padrão, por bairro ou
 * faixa de CEP — o de sempre) ou "distance" (por faixas de km a partir do local da loja). No modo distância:
 * - "distance.bands": faixas "até X km" em ordem crescente, cada uma com taxa, prazo e, como as zonas, pedido
 *   mínimo e frete grátis próprios opcionais (ausentes = os da loja);
 * - "distance.max_km" + "distance.extra_km_fee": opcional, cobra R$ por km (iniciado) além da última faixa até o
 *   raio máximo; sem eles, o raio máximo é a última faixa;
 * - "distance.route_factor": a linha reta (haversine) entre a loja e o cliente vezes este fator (padrão 1,3:
 *   as ruas nunca vão em linha reta);
 * - "distance.road_distance": com GOOGLE_MAPS_API_KEY, usa a distância real por rua (queda para a linha reta);
 * - além do raio, ou endereço sem coordenadas, vale a mesma política de fora das zonas ("outside_zones":
 *   taxa de "fallback" ou recusa).
 * As zonas cadastradas continuam guardadas no modo distância (voltar ao modo "zones" as usa de novo).
 */
import {
  MAX_MONEY_CENTS,
  MAX_MONEY_VALUE,
  fromCents,
  parseOrderValueRules,
  toCents,
  type DeliveryEstimate,
  type OrderValueRules,
} from './order-rules';

export type DeliveryMode = 'zones' | 'distance';
export const DELIVERY_MODES: readonly DeliveryMode[] = ['zones', 'distance'];

/** Faixa de distância: "até up_to_km km" (inclusive), com taxa, prazo e regras de valor opcionais. */
export interface DistanceBand extends DeliveryEstimate, OrderValueRules {
  up_to_km: number;
}

export interface DistanceSettings {
  bands: DistanceBand[];
  /** Raio máximo além da última faixa (só com extra_km_fee). Ausente = a última faixa. */
  max_km?: number;
  /** R$ por km iniciado além da última faixa, até max_km. */
  extra_km_fee?: number;
  /** Fator sobre a linha reta (1 a 3). Sempre gravado (padrão 1,3). */
  route_factor: number;
  /** Distância real por rua quando a plataforma tem GOOGLE_MAPS_API_KEY (só gravado como true). */
  road_distance?: true;
}

export const DEFAULT_ROUTE_FACTOR = 1.3;
export const MIN_ROUTE_FACTOR = 1;
export const MAX_ROUTE_FACTOR = 3;
export const MAX_DISTANCE_BANDS = 20;
/** Maior distância aceita numa faixa ou no raio (km). */
export const MAX_DELIVERY_KM = 100;
/** Mesmo limite do prazo das zonas. */
const MAX_TIME_LENGTH = 20;

/** Latitude e longitude em graus decimais. */
export interface Coordinates {
  lat: number;
  lng: number;
}

/** 400 (código DELIVERY_OUT_OF_AREA) quando a loja recusa e o endereço não foi localizado no mapa. */
export const ADDRESS_NOT_LOCATED_MESSAGE =
  'Não conseguimos localizar este endereço no mapa para calcular a entrega. Confira o CEP, a rua e o número ou escolha retirar no balcão.';
/** Campo "reason" aditivo desse 400 (o endereço além do raio usa a mensagem de fora da área, sem "reason"). */
export const ADDRESS_NOT_LOCATED_REASON = 'ADDRESS_NOT_LOCATED';
/** PATCH /store/settings: modo distância sem o local da loja. */
export const STORE_LOCATION_REQUIRED_MESSAGE =
  'Para cobrar a entrega por distância, informe o local da loja no mapa (latitude e longitude) na seção Entrega.';
/** PATCH /store/settings: só uma das coordenadas. */
export const STORE_LOCATION_PAIR_MESSAGE =
  'Informe a latitude e a longitude da loja juntas (ou deixe as duas vazias).';

const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Coordenadas válidas (números finitos dentro dos limites; 0,0 conta como ausente: é o "nada" de muitos serviços). */
export function validCoordinates(
  lat: unknown,
  lng: unknown,
): Coordinates | null {
  if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

/** Distância em linha reta (fórmula de haversine, raio médio da Terra 6371 km), em km sem arredondar. */
export function haversineKm(a: Coordinates, b: Coordinates): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distância usada na cobrança: a linha reta vezes o fator de rota, com 1 casa (a que o cliente vê). */
export function straightDeliveryKm(
  store: Coordinates,
  customer: Coordinates,
  routeFactor: number = DEFAULT_ROUTE_FACTOR,
): number {
  return round1(haversineKm(store, customer) * routeFactor);
}

/** Distância por rua (metros do serviço de rotas) em km com 1 casa. */
export function roadKmFromMeters(meters: number): number {
  return round1(meters / 1000);
}

/** "mode": "zones" ou "distance" (sem diferenciar maiúsculas); ausente/null → undefined (= "zones"). */
export function parseDeliveryMode(value: unknown): DeliveryMode | undefined {
  if (value === undefined || value === null) return undefined;
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if ((DELIVERY_MODES as readonly string[]).includes(mode))
    return mode as DeliveryMode;
  throw new Error(
    '"mode" deve ser "zones" (taxa por bairro ou faixa de CEP) ou "distance" (taxa por distância em km).',
  );
}

function parseKm(value: unknown, label: string): number {
  if (!isFiniteNumber(value) || value <= 0 || value > MAX_DELIVERY_KM) {
    throw new Error(
      `${label} precisa ser uma distância em km maior que 0 e de no máximo ${MAX_DELIVERY_KM} (ex.: 2 ou 3.5).`,
    );
  }
  return round2(value);
}

function parseMoney(value: unknown, label: string): number {
  if (!isFiniteNumber(value) || value < 0 || toCents(value) > MAX_MONEY_CENTS) {
    throw new Error(
      `${label} precisa ser um valor em reais de 0 a ${MAX_MONEY_VALUE}.`,
    );
  }
  return fromCents(toCents(value));
}

/**
 * Lê "distance" do JSON de entrega: faixas em ordem crescente (1 a MAX_DISTANCE_BANDS), raio máximo e taxa por
 * km adicional (juntos), fator de rota (1 a 3; ausente = 1,3) e distância por rua. Devolve a configuração
 * normalizada (aplicar de novo dá o mesmo resultado). Inválido → Error com a explicação.
 */
export function parseDistanceSettings(raw: unknown): DistanceSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      '"distance" precisa ser um objeto { "bands": [{ "up_to_km", "fee", "time" }] }.',
    );
  }
  const data = raw as Record<string, unknown>;
  const list = data.bands;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(
      'cadastre pelo menos uma faixa de distância em "distance.bands" (ex.: até 3 km, R$ 5,00, 30-40 min).',
    );
  }
  if (list.length > MAX_DISTANCE_BANDS) {
    throw new Error(
      `cadastre no máximo ${MAX_DISTANCE_BANDS} faixas de distância.`,
    );
  }

  const bands = list.map((item: unknown, index): DistanceBand => {
    const position = index + 1;
    const band = (item && typeof item === 'object' ? item : {}) as Record<
      string,
      unknown
    >;
    const upTo = parseKm(band.up_to_km, `"up_to_km" da faixa ${position}`);
    const fee = parseMoney(band.fee, `a taxa ("fee") da faixa ${position}`);
    const time = typeof band.time === 'string' ? band.time.trim() : '';
    if (!time)
      throw new Error(
        `informe o prazo ("time") da faixa ${position} (ex.: 30-40 min).`,
      );
    if (time.length > MAX_TIME_LENGTH)
      throw new Error(
        `o prazo da faixa ${position} pode ter no máximo ${MAX_TIME_LENGTH} caracteres.`,
      );
    return {
      up_to_km: upTo,
      fee,
      time,
      ...parseOrderValueRules(band, `da faixa ${position}`),
    };
  });
  bands.forEach((band, index) => {
    const previous = bands[index - 1];
    if (previous && band.up_to_km <= previous.up_to_km) {
      throw new Error(
        `as faixas precisam estar em ordem crescente de distância: a faixa ${index + 1} (até ${band.up_to_km} km) precisa ir além da faixa ${index} (até ${previous.up_to_km} km).`,
      );
    }
  });
  const last = bands[bands.length - 1].up_to_km;

  const hasMax = data.max_km !== undefined && data.max_km !== null;
  const hasExtra =
    data.extra_km_fee !== undefined && data.extra_km_fee !== null;
  const maxKm = hasMax ? parseKm(data.max_km, '"max_km"') : last;
  if (maxKm < last) {
    throw new Error(
      `o raio máximo ("max_km", ${maxKm} km) não pode ser menor que a última faixa (até ${last} km).`,
    );
  }
  const extraFee = hasExtra
    ? parseMoney(data.extra_km_fee, '"extra_km_fee" (taxa por km adicional)')
    : undefined;
  if (maxKm > last && (extraFee === undefined || extraFee <= 0)) {
    throw new Error(
      `para entregar além da última faixa (até ${last} km), informe a taxa por km adicional ("extra_km_fee" maior que 0) ou cadastre uma faixa até ${maxKm} km.`,
    );
  }
  if (extraFee !== undefined && maxKm <= last) {
    throw new Error(
      `a taxa por km adicional só vale com um raio máximo ("max_km") maior que a última faixa (até ${last} km).`,
    );
  }

  let routeFactor = DEFAULT_ROUTE_FACTOR;
  if (data.route_factor !== undefined && data.route_factor !== null) {
    if (
      !isFiniteNumber(data.route_factor) ||
      data.route_factor < MIN_ROUTE_FACTOR ||
      data.route_factor > MAX_ROUTE_FACTOR
    ) {
      throw new Error(
        `"route_factor" (fator de rota) precisa ser um número de ${MIN_ROUTE_FACTOR} a ${MAX_ROUTE_FACTOR} (padrão ${DEFAULT_ROUTE_FACTOR}).`,
      );
    }
    routeFactor = round2(data.route_factor);
  }
  const road = data.road_distance;
  if (road !== undefined && road !== null && typeof road !== 'boolean') {
    throw new Error(
      '"road_distance" deve ser true (distância por rua, quando disponível) ou false (linha reta com o fator de rota).',
    );
  }

  return {
    bands,
    ...(maxKm > last ? { max_km: maxKm, extra_km_fee: extraFee } : {}),
    route_factor: routeFactor,
    ...(road === true ? { road_distance: true as const } : {}),
  };
}

/** Raio máximo de entrega (km): o "max_km" ou a última faixa. */
export function maxDeliveryKm(settings: DistanceSettings): number {
  return settings.max_km ?? settings.bands[settings.bands.length - 1].up_to_km;
}

/** Taxa, prazo e regras de valor para uma distância (dentro do raio). */
export interface DistanceDelivery extends DeliveryEstimate {
  /** Posição da faixa (1 = a primeira). Além da última faixa (km adicional): a última. */
  band: number;
  /** Km cobrados além da última faixa (0 = dentro de uma faixa). */
  extraKm: number;
  /** Pedido mínimo e frete grátis próprios da faixa (ausentes = os da loja). */
  area: OrderValueRules;
}

/**
 * Faixa da distância (km com 1 casa, inclusive: 2,0 km cabe em "até 2 km"). Além da última faixa e dentro do
 * raio: taxa da última faixa + km adicional (cada km iniciado) × "extra_km_fee", com o prazo e as regras da
 * última faixa. Além do raio → null (vale a política de fora da área).
 */
export function distanceDeliveryFor(
  km: number,
  settings: DistanceSettings,
): DistanceDelivery | null {
  if (!Number.isFinite(km) || km < 0) return null;
  const index = settings.bands.findIndex((band) => km <= band.up_to_km);
  if (index >= 0) {
    const band = settings.bands[index];
    return {
      fee: band.fee,
      time: band.time,
      band: index + 1,
      extraKm: 0,
      area: ruleFields(band),
    };
  }
  if (km > maxDeliveryKm(settings) || !settings.extra_km_fee) return null;
  const last = settings.bands[settings.bands.length - 1];
  const extraKm = Math.ceil(round1(km - last.up_to_km) - 1e-9);
  const feeCents = toCents(last.fee) + extraKm * toCents(settings.extra_km_fee);
  return {
    fee: fromCents(Math.min(feeCents, MAX_MONEY_CENTS)),
    time: last.time,
    band: settings.bands.length,
    extraKm,
    area: ruleFields(last),
  };
}

function ruleFields(band: DistanceBand): OrderValueRules {
  return {
    ...(band.min_order !== undefined ? { min_order: band.min_order } : {}),
    ...(band.free_delivery_above !== undefined
      ? { free_delivery_above: band.free_delivery_above }
      : {}),
  };
}

/**
 * Local da loja depois de um PATCH /store/settings: latitude e longitude juntas (ou nenhuma) e obrigatórias no
 * modo distância. null = tudo certo; senão, a mensagem do 400.
 */
export function storeLocationError(next: {
  latitude?: number | null;
  longitude?: number | null;
  delivery_zones?: unknown;
}): string | null {
  const hasLat = next.latitude !== null && next.latitude !== undefined;
  const hasLng = next.longitude !== null && next.longitude !== undefined;
  if (hasLat !== hasLng) return STORE_LOCATION_PAIR_MESSAGE;
  if (
    deliveryModeOf(next.delivery_zones) === 'distance' &&
    !validCoordinates(next.latitude, next.longitude)
  )
    return STORE_LOCATION_REQUIRED_MESSAGE;
  return null;
}

/** Modo de cobrança gravado (ausente ou desconhecido = "zones"). */
export function deliveryModeOf(storeZones: unknown): DeliveryMode {
  return storeZones &&
    typeof storeZones === 'object' &&
    (storeZones as { mode?: unknown }).mode === 'distance'
    ? 'distance'
    : 'zones';
}

/**
 * Configuração de distância EM USO pela loja (modo "distance" e faixas válidas) ou null (modo por zonas, sem
 * configuração própria ou gravada inválida — aí valem as zonas, como sempre). Nunca lança.
 */
export function storeDistanceSettings(
  storeZones: unknown,
): DistanceSettings | null {
  if (deliveryModeOf(storeZones) !== 'distance') return null;
  try {
    return parseDistanceSettings(
      (storeZones as { distance?: unknown }).distance,
    );
  } catch {
    return null;
  }
}

/** Perfil público (vitrine): "Entrega até X km" no modo distância; null no modo por zonas. */
export interface PublicDeliveryDistance {
  max_km: number;
}

export function publicDeliveryDistance(
  storeZones: unknown,
): PublicDeliveryDistance | null {
  const settings = storeDistanceSettings(storeZones);
  return settings ? { max_km: maxDeliveryKm(settings) } : null;
}
