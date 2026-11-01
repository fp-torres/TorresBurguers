/**
 * Coordenadas de endereços (funções puras, sem banco nem Nest; cobertas por geocoding.spec.ts).
 *
 * Usadas SÓ pela entrega por distância (orders/delivery-distance.ts). Cadeia de provedores configurável
 * (GEOCODING_PROVIDERS): Google Geocoding (só com GOOGLE_MAPS_API_KEY), Nominatim/OpenStreetMap (sem chave;
 * User-Agent identificado com contato, no máximo 1 requisição por segundo) e o CEP com coordenadas da AwesomeAPI
 * (sem chave; centro do CEP). O resultado fica guardado no endereço (geo_*), com a origem e a precisão.
 */
import { cepDigits, formatCep } from './cep-lookup.service';

/** Precisão das coordenadas: o endereço (rua e número), o centro do CEP ou marcadas à mão. */
export type GeoPrecision = 'ADDRESS' | 'ZIP_CENTER' | 'MANUAL';
export const GEO_PRECISIONS: readonly GeoPrecision[] = [
  'ADDRESS',
  'ZIP_CENTER',
  'MANUAL',
];

/** Resultado da última tentativa: encontrado, inexistente nos provedores ou provedores fora do ar. */
export type GeoStatus = 'FOUND' | 'NOT_FOUND' | 'UNAVAILABLE';
export const GEO_STATUSES: readonly GeoStatus[] = [
  'FOUND',
  'NOT_FOUND',
  'UNAVAILABLE',
];

export type GeoProvider = 'google' | 'nominatim' | 'awesomeapi';
export const GEO_PROVIDERS: readonly GeoProvider[] = [
  'google',
  'nominatim',
  'awesomeapi',
];
/** Ordem padrão: precisão de endereço primeiro; o centro do CEP por último. */
export const DEFAULT_GEO_PROVIDERS: readonly GeoProvider[] = GEO_PROVIDERS;

/** De onde vieram as coordenadas (gravado em geo_source). */
export type GeoSource = 'GOOGLE' | 'NOMINATIM' | 'AWESOMEAPI' | 'FAKE';
export const GEO_SOURCES: readonly GeoSource[] = [
  'GOOGLE',
  'NOMINATIM',
  'AWESOMEAPI',
  'FAKE',
];

/** Endereço a localizar (o que o cliente digitou; o CEP é obrigatório). */
export interface GeocodeQuery {
  zipCode: string;
  street?: string | null;
  number?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
}

export type GeocodeOutcome =
  | {
      status: 'found';
      lat: number;
      lng: number;
      precision: Exclude<GeoPrecision, 'MANUAL'>;
      source: GeoSource;
    }
  | { status: 'not_found' }
  | { status: 'unavailable' };

/** Colunas geo_* do endereço. */
export interface AddressGeoFields {
  geo_latitude: number | null;
  geo_longitude: number | null;
  geo_precision: GeoPrecision | null;
  geo_source: GeoSource | null;
  geo_status: GeoStatus | null;
  geo_checked_at: Date | null;
}

/** Endereço com o que importa para as coordenadas (entidade Address ou equivalente). */
export interface GeoLocatableAddress {
  geo_latitude?: number | null;
  geo_longitude?: number | null;
  geo_status?: GeoStatus | null;
  geo_checked_at?: Date | string | null;
}

/** Provedores fora do ar no cadastro: o orçamento tenta de novo depois deste tempo (como o CEP). */
export const GEO_RETRY_MS = 60 * 60 * 1000;

/** Campos "vazios" (endereço que mudou: as coordenadas antigas não valem mais). */
export const EMPTY_GEO_FIELDS: Readonly<AddressGeoFields> = {
  geo_latitude: null,
  geo_longitude: null,
  geo_precision: null,
  geo_source: null,
  geo_status: null,
  geo_checked_at: null,
};

/** Campos geo_* a gravar a partir do resultado da cadeia de provedores. */
export function geoFieldsFromOutcome(
  outcome: GeocodeOutcome,
  checkedAt: Date,
): AddressGeoFields {
  if (outcome.status === 'found') {
    return {
      geo_latitude: outcome.lat,
      geo_longitude: outcome.lng,
      geo_precision: outcome.precision,
      geo_source: outcome.source,
      geo_status: 'FOUND',
      geo_checked_at: checkedAt,
    };
  }
  return {
    ...EMPTY_GEO_FIELDS,
    geo_status: outcome.status === 'not_found' ? 'NOT_FOUND' : 'UNAVAILABLE',
    geo_checked_at: checkedAt,
  };
}

/**
 * O orçamento por distância localiza o endereço de novo quando ele nunca foi localizado (cadastrado antes, ou
 * quando nenhuma loja cobrava por distância) ou quando os provedores estavam fora do ar há GEO_RETRY_MS ou mais.
 */
export function needsGeoRefresh(
  address: GeoLocatableAddress,
  now: Date,
): boolean {
  if (!address.geo_status) return true;
  if (address.geo_status !== 'UNAVAILABLE') return false;
  const checked = address.geo_checked_at
    ? new Date(address.geo_checked_at).getTime()
    : 0;
  return !Number.isFinite(checked) || now.getTime() - checked >= GEO_RETRY_MS;
}

/** Campos do endereço que mudam as coordenadas (a edição de um deles apaga as antigas). */
export const GEO_ADDRESS_FIELDS = [
  'zipCode',
  'street',
  'number',
  'neighborhood',
  'city',
  'state',
] as const;

/** GEOCODING_PROVIDERS="nominatim,awesomeapi" → lista na ordem (desconhecidos são ignorados; vazio = padrão). */
export function parseGeoProviders(raw?: string | null): {
  providers: GeoProvider[];
  ignored: string[];
} {
  const items = (raw ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!items.length)
    return { providers: [...DEFAULT_GEO_PROVIDERS], ignored: [] };
  const providers: GeoProvider[] = [];
  const ignored: string[] = [];
  for (const item of items) {
    if ((GEO_PROVIDERS as readonly string[]).includes(item)) {
      if (!providers.includes(item as GeoProvider))
        providers.push(item as GeoProvider);
    } else ignored.push(item);
  }
  return { providers, ignored };
}

/**
 * A distância real por rua pode ser usada? Só com GOOGLE_MAPS_API_KEY e fora dos testes (NODE_ENV=test nunca
 * vai à internet). O painel mostra a opção só quando ela funciona.
 */
export function roadDistanceConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.NODE_ENV !== 'test' && !!env.GOOGLE_MAPS_API_KEY?.trim();
}

/** User-Agent da política do Nominatim: identifica a aplicação e, quando configurado, um contato. */
export function geocodingUserAgent(
  appName: string,
  contact?: string | null,
): string {
  const clean = (contact ?? '').replace(/[\r\n()]/g, ' ').trim();
  return clean
    ? `${appName}-delivery-geocoder/1.0 (${clean})`
    : `${appName}-delivery-geocoder/1.0`;
}

/** Valor do mapa falso que simula os provedores fora do ar. */
const FAKE_UNAVAILABLE = 'unavailable';

const validLatLng = (lat: unknown, lng: unknown): boolean =>
  typeof lat === 'number' &&
  typeof lng === 'number' &&
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  lat >= -90 &&
  lat <= 90 &&
  lng >= -180 &&
  lng <= 180 &&
  !(lat === 0 && lng === 0);

/**
 * GEOCODING_FAKE (só NODE_ENV=test): { "<CEP>": { "lat", "lng", "precision"? ("ADDRESS" | "ZIP_CENTER") } |
 * "unavailable" | null }. CEP fora do mapa = não encontrado. Inválido → Error com a explicação.
 */
export function parseFakeGeoMap(raw: string): Map<string, GeocodeOutcome> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('o valor não é um JSON válido.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('use um objeto { "<CEP>": { "lat", "lng" } }.');
  }
  const entries = new Map<string, GeocodeOutcome>();
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const digits = cepDigits(key);
    if (!digits) throw new Error(`"${key}" não é um CEP com 8 dígitos.`);
    if (
      typeof value === 'string' &&
      value.trim().toLowerCase() === FAKE_UNAVAILABLE
    ) {
      entries.set(digits, { status: 'unavailable' });
      continue;
    }
    if (value === null) {
      entries.set(digits, { status: 'not_found' });
      continue;
    }
    const entry = (value && typeof value === 'object' ? value : {}) as {
      lat?: unknown;
      lng?: unknown;
      precision?: unknown;
    };
    if (!validLatLng(entry.lat, entry.lng)) {
      throw new Error(
        `o CEP ${key} precisa de { "lat", "lng" } válidos, null (não encontrado) ou "${FAKE_UNAVAILABLE}".`,
      );
    }
    entries.set(digits, {
      status: 'found',
      lat: entry.lat as number,
      lng: entry.lng as number,
      precision: entry.precision === 'ZIP_CENTER' ? 'ZIP_CENTER' : 'ADDRESS',
      source: 'FAKE',
    });
  }
  return entries;
}

const text = (value?: string | null) =>
  (value ?? '').replace(/\s+/g, ' ').trim();

/** Chave do cache: o endereço normalizado (sem acentos nem maiúsculas). */
export function geocodeCacheKey(query: GeocodeQuery): string {
  return [
    cepDigits(query.zipCode) ?? '',
    query.street,
    query.number,
    query.neighborhood,
    query.city,
    query.state,
  ]
    .map((part) =>
      text(part).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(),
    )
    .join('|');
}

/** Número de imóvel útil para a busca ("S/N" e afins não ajudam). */
function houseNumber(value?: string | null): string {
  const clean = text(value);
  return /\d/.test(clean) ? clean : '';
}

/** Texto do endereço para o Google: "Rua X, 10 - Bairro, Cidade - UF, 22041-001, Brasil". */
export function googleAddressText(query: GeocodeQuery): string {
  const digits = cepDigits(query.zipCode);
  const streetPart = [text(query.street), houseNumber(query.number)]
    .filter(Boolean)
    .join(', ');
  const cityPart = [text(query.city), text(query.state)]
    .filter(Boolean)
    .join(' - ');
  return [
    [streetPart, text(query.neighborhood)].filter(Boolean).join(' - '),
    cityPart,
    digits ? formatCep(digits) : '',
    'Brasil',
  ]
    .filter(Boolean)
    .join(', ');
}

/** Parâmetros da busca estruturada do Nominatim (sem o CEP: o OpenStreetMap raramente tem CEP no Brasil). */
export function nominatimParams(query: GeocodeQuery): URLSearchParams | null {
  const street = text(query.street);
  const city = text(query.city);
  if (!street || !city) return null;
  const params = new URLSearchParams({
    street: [houseNumber(query.number), street].filter(Boolean).join(' '),
    city,
    country: 'Brasil',
    format: 'jsonv2',
    limit: '1',
    countrycodes: 'br',
  });
  const state = text(query.state);
  if (state) params.set('state', state);
  return params;
}

const toNumber = (value: unknown): number =>
  typeof value === 'number' ? value : Number(value);

/**
 * Resposta do Google Geocoding: OK com local de rua/endereço → ADDRESS; só o CEP → ZIP_CENTER; resultado vago
 * (bairro, cidade) ou ZERO_RESULTS → não encontrado; outros status (cota, chave) → fora do ar.
 */
export function readGoogleGeocode(data: unknown): GeocodeOutcome {
  const body = (data && typeof data === 'object' ? data : {}) as {
    status?: unknown;
    results?: unknown;
  };
  if (body.status === 'ZERO_RESULTS') return { status: 'not_found' };
  if (body.status !== 'OK' || !Array.isArray(body.results))
    return { status: 'unavailable' };
  for (const item of body.results as unknown[]) {
    const result = (item && typeof item === 'object' ? item : {}) as {
      geometry?: {
        location?: { lat?: unknown; lng?: unknown };
        location_type?: unknown;
      };
      types?: unknown;
    };
    const lat = toNumber(result.geometry?.location?.lat);
    const lng = toNumber(result.geometry?.location?.lng);
    if (!validLatLng(lat, lng)) continue;
    const types = Array.isArray(result.types)
      ? (result.types as unknown[])
      : [];
    const kind = result.geometry?.location_type;
    const streetLevel = [
      'street_address',
      'premise',
      'subpremise',
      'route',
    ].some((type) => types.includes(type));
    if (kind === 'ROOFTOP' || kind === 'RANGE_INTERPOLATED' || streetLevel)
      return {
        status: 'found',
        lat,
        lng,
        precision: 'ADDRESS',
        source: 'GOOGLE',
      };
    if (types.includes('postal_code'))
      return {
        status: 'found',
        lat,
        lng,
        precision: 'ZIP_CENTER',
        source: 'GOOGLE',
      };
  }
  return { status: 'not_found' };
}

/** Nominatim (jsonv2): só resultados no nível da rua ou mais precisos (place_rank ≥ 26) valem. */
export function readNominatim(data: unknown): GeocodeOutcome {
  if (!Array.isArray(data)) return { status: 'unavailable' };
  for (const item of data as unknown[]) {
    const result = (item && typeof item === 'object' ? item : {}) as {
      lat?: unknown;
      lon?: unknown;
      place_rank?: unknown;
    };
    const lat = toNumber(result.lat);
    const lng = toNumber(result.lon);
    const rank = toNumber(result.place_rank);
    if (validLatLng(lat, lng) && rank >= 26)
      return {
        status: 'found',
        lat,
        lng,
        precision: 'ADDRESS',
        source: 'NOMINATIM',
      };
  }
  return { status: 'not_found' };
}

/** AwesomeAPI (cep.awesomeapi.com.br/json/<CEP>): 200 com "lat"/"lng" → centro do CEP; 404/400 → não encontrado. */
export function readAwesomeApi(
  httpStatus: number,
  data: unknown,
): GeocodeOutcome {
  if (httpStatus === 404 || httpStatus === 400) return { status: 'not_found' };
  if (httpStatus !== 200) return { status: 'unavailable' };
  const body = (data && typeof data === 'object' ? data : {}) as {
    lat?: unknown;
    lng?: unknown;
  };
  const lat = toNumber(body.lat);
  const lng = toNumber(body.lng);
  if (!validLatLng(lat, lng)) return { status: 'not_found' };
  return {
    status: 'found',
    lat,
    lng,
    precision: 'ZIP_CENTER',
    source: 'AWESOMEAPI',
  };
}

/** Google Routes (directions/v2:computeRoutes): metros da primeira rota (null = sem rota ou resposta inesperada). */
export function readRoutesDistanceMeters(data: unknown): number | null {
  const body = (data && typeof data === 'object' ? data : {}) as {
    routes?: { distanceMeters?: unknown }[];
  };
  const route = Array.isArray(body.routes) ? body.routes[0] : undefined;
  if (!route) return null;
  const meters = toNumber(route.distanceMeters);
  return Number.isFinite(meters) && meters >= 0 ? meters : null;
}
