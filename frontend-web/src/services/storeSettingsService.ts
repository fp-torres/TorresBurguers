import api from './api';
import {
  asRecord, isRecord, readArray, readBoolean, readDate, readId, readNullableText, readNumber, readText, readTextList,
} from './panelParsers';
import { toFeatures, toStoreAccess, type StoreAccess, type StoreFeatures } from './storeAccess';
import { lookupCep } from './cepService';
import type { StoreAccountStatus } from '../types/saas';

// Configurações da loja no painel do Administrador (docs/saas/arquitetura.md §5.3):
// GET/PATCH /store/settings, POST/DELETE /store/logo e PUT/DELETE /store/settings/payments.
// A loja é sempre a do usuário autenticado: nenhuma chamada envia store_id.

/** Taxa (R$) e prazo exibido ("40-50 min") de uma entrega. */
export interface DeliveryEstimate {
  fee: number;
  time: string;
}

/** Faixa de CEP atendida (8 dígitos, início ≤ fim, inclusive). */
export interface ZipRange {
  from: string;
  to: string;
}

/**
 * Zona de entrega: bairros atendidos (e, opcionalmente, só nestas cidades) e/ou faixas de CEP, com taxa e
 * prazo. O bairro do cliente é o confirmado pelo CEP do endereço (ou o digitado, quando o CEP não confirma).
 */
/**
 * Pedido mínimo e frete grátis (R$, sobre o subtotal dos itens com as promoções, sem a taxa). Na zona,
 * ausente = vale o da loja; 0 = sem mínimo / frete sempre grátis só nesta zona.
 */
export interface OrderValueRules {
  min_order?: number;
  free_delivery_above?: number;
}

export interface DeliveryZone extends DeliveryEstimate, OrderValueRules {
  neighborhoods: string[];
  cities?: string[];
  zip_ranges?: ZipRange[];
}

/** Endereço fora das zonas: "fallback" (entrega com a taxa padrão) ou "refuse" (a loja recusa a entrega). */
export type OutsideZonesPolicy = 'fallback' | 'refuse';

/**
 * Zonas próprias da loja: a primeira zona com o bairro ou o CEP vale; fora delas, o "fallback" — ou a
 * recusa (outside_zones = "refuse"; aí o "fallback" é opcional e fica null quando a API não o tem).
 * Opcionais da loja: pedido mínimo da entrega (min_order; min_order_takeout = vale também na retirada) e
 * frete grátis a partir de um subtotal (free_delivery_above). Ausentes = sem regra (o padrão).
 */
export interface DeliveryZonesConfig extends OrderValueRules {
  zones: DeliveryZone[];
  fallback: DeliveryEstimate | null;
  outside_zones: OutsideZonesPolicy;
  min_order_takeout?: boolean;
  /** Cobrança por distância (ausente = por zonas, o padrão). As zonas continuam guardadas. */
  mode?: 'distance';
  /** Faixas de distância (guardadas também no modo por zonas, para quando a loja trocar de modo). */
  distance?: DistanceSettings;
}

/** Faixa "até up_to_km km" com taxa, prazo e, como as zonas, pedido mínimo e frete grátis próprios. */
export interface DistanceBand extends DeliveryEstimate, OrderValueRules {
  up_to_km: number;
}

/**
 * Entrega por distância: faixas em ordem crescente; raio além da última faixa só com taxa por km adicional;
 * fator de rota sobre a linha reta (padrão 1,3); distância por rua quando a plataforma oferece.
 */
export interface DistanceSettings {
  bands: DistanceBand[];
  max_km?: number;
  extra_km_fee?: number;
  route_factor: number;
  road_distance?: true;
}

/** Fator de rota padrão (as ruas nunca vão em linha reta). */
export const DEFAULT_ROUTE_FACTOR = 1.3;

/** POST /store/settings/geocode: ponto encontrado para o endereço (não é gravado). */
export interface StoreGeocodeResult {
  latitude: number;
  longitude: number;
  /** ADDRESS (rua e número) ou ZIP_CENTER (centro do CEP: aproximado). */
  precision: 'ADDRESS' | 'ZIP_CENTER';
}

/** POST /store/settings/delivery-simulation: resultado do "teste um endereço". */
export interface DeliverySimulation {
  mode: 'zones' | 'distance';
  located: boolean;
  store_located: boolean;
  precision: 'ADDRESS' | 'ZIP_CENTER' | null;
  distance_km: number | null;
  max_km: number | null;
  band: number | null;
  extra_km: number;
  zone: number | null;
  outside: boolean;
  refused: boolean;
  delivery_fee: number | null;
  estimated_delivery_time: string | null;
  min_order: number | null;
  free_delivery_above: number | null;
  message: string;
}

/** Endereço testado no simulador e configuração em edição (ausentes = as salvas). */
export interface DeliverySimulationInput {
  zip_code: string;
  number?: string;
  delivery_zones?: DeliveryZonesConfig | null;
  latitude?: number | null;
  longitude?: number | null;
}

/** Horário de funcionamento (informativo): day 0 = domingo; fechar antes de abrir = vira a madrugada. */
export interface OpeningHoursEntry {
  day: number;
  open: string;
  close: string;
}

/** Credenciais do Mercado Pago da loja: o Access Token nunca volta, só uma dica mascarada. */
export interface StorePaymentsSettings {
  mp_public_key: string | null;
  access_token_configured: boolean;
  /** Começo e fim do token (ex.: "APP_USR-12…cd34"), para conferência. */
  access_token_hint: string | null;
  /** Loja padrão sem credencial própria usando a conta Mercado Pago da plataforma. */
  using_platform_credentials: boolean;
}

export interface StoreSettings {
  id: number;
  slug: string;
  name: string;
  legal_name: string | null;
  document: string | null;
  email: string | null;
  phone: string | null;
  description: string | null;
  logo: string | null;
  primary_color: string | null;
  address_zip_code: string | null;
  address_street: string | null;
  address_number: string | null;
  address_complement: string | null;
  address_neighborhood: string | null;
  address_city: string | null;
  address_state: string | null;
  /** Local da loja no mapa (entrega por distância); null = não informado. */
  latitude: number | null;
  longitude: number | null;
  account_status: StoreAccountStatus;
  status_reason: string | null;
  is_open: boolean;
  opening_message: string | null;
  closing_message: string | null;
  delivery_enabled: boolean;
  takeout_enabled: boolean;
  delivery_zones: DeliveryZonesConfig | null;
  takeout_estimate: string | null;
  opening_hours: OpeningHoursEntry[] | null;
  time_zone: string;
  custom_domain: string | null;
  /** Responsável principal pela loja (stores.owner_user_id, definido pela plataforma); null = não definido. */
  owner_user_id: number | null;
  is_default_store: boolean;
  payments: StorePaymentsSettings;
  access: StoreAccess | null;
  features: StoreFeatures;
  updated_at: string | null;
  /** A plataforma oferece a distância real por rua (Google). */
  road_distance_available: boolean;
}

/** Campos aceitos no PATCH /store/settings (envie só o que mudou; null limpa os opcionais). */
export interface StoreSettingsUpdate {
  name?: string;
  legal_name?: string | null;
  document?: string | null;
  email?: string | null;
  phone?: string | null;
  description?: string | null;
  address_zip_code?: string | null;
  address_street?: string | null;
  address_number?: string | null;
  address_complement?: string | null;
  address_neighborhood?: string | null;
  address_city?: string | null;
  address_state?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  opening_message?: string | null;
  closing_message?: string | null;
  delivery_enabled?: boolean;
  takeout_enabled?: boolean;
  delivery_zones?: DeliveryZonesConfig | null;
  takeout_estimate?: string | null;
  opening_hours?: OpeningHoursEntry[] | null;
  time_zone?: string;
  primary_color?: string | null;
}

/** Credenciais enviadas no PUT /store/settings/payments (o token é só de escrita). */
export interface StorePaymentCredentials {
  mp_public_key: string;
  mp_access_token: string;
}

const ACCOUNT_STATUSES: readonly StoreAccountStatus[] = ['ACTIVE', 'SUSPENDED', 'INACTIVE'];

function toEstimate(value: unknown): DeliveryEstimate {
  const raw = asRecord(value);
  return { fee: readNumber(raw.fee, 0), time: readText(raw.time) };
}

function toZipRanges(value: unknown): ZipRange[] {
  return readArray(value)
    .filter(isRecord)
    .map((range) => ({ from: readText(range.from).replace(/\D/g, ''), to: readText(range.to).replace(/\D/g, '') }))
    .filter((range) => /^\d{8}$/.test(range.from) && /^\d{8}$/.test(range.to));
}

/** Pedido mínimo e frete grátis (só os informados, em número ≥ 0), na ordem de chaves do rascunho da tela. */
function toOrderValueRules(raw: Record<string, unknown>): OrderValueRules {
  const money = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);
  const minOrder = money(raw.min_order);
  const freeAbove = money(raw.free_delivery_above);
  return {
    ...(minOrder !== undefined ? { min_order: minOrder } : {}),
    ...(freeAbove !== undefined ? { free_delivery_above: freeAbove } : {}),
  };
}

/** Faixas de distância (mesma ordem de chaves da API e do rascunho da tela); inválido → undefined. */
function toDistance(value: unknown): DistanceSettings | undefined {
  if (!isRecord(value)) return undefined;
  const bands = readArray(value.bands)
    .filter(isRecord)
    .map((band): DistanceBand => ({
      up_to_km: readNumber(band.up_to_km, 0),
      ...toEstimate(band),
      ...toOrderValueRules(band),
    }))
    .filter((band) => band.up_to_km > 0);
  if (!bands.length) return undefined;
  const maxKm = readNumber(value.max_km, 0);
  const extraFee = readNumber(value.extra_km_fee, 0);
  const factor = readNumber(value.route_factor, DEFAULT_ROUTE_FACTOR);
  return {
    bands,
    ...(maxKm > 0 && extraFee > 0 ? { max_km: maxKm, extra_km_fee: extraFee } : {}),
    route_factor: factor > 0 ? factor : DEFAULT_ROUTE_FACTOR,
    ...(value.road_distance === true ? { road_distance: true as const } : {}),
  };
}

/** Mesma ordem de chaves do rascunho da tela (DeliverySection), para comparar com o salvo. */
function toZones(value: unknown): DeliveryZonesConfig | null {
  if (!isRecord(value)) return null;
  const zones = readArray(value.zones).filter(isRecord).map((zone): DeliveryZone => {
    const cities = readTextList(zone.cities);
    const zipRanges = toZipRanges(zone.zip_ranges);
    return {
      neighborhoods: readTextList(zone.neighborhoods),
      ...(cities.length ? { cities } : {}),
      ...(zipRanges.length ? { zip_ranges: zipRanges } : {}),
      ...toEstimate(zone),
      ...toOrderValueRules(zone),
    };
  });
  const storeRules = toOrderValueRules(value);
  const distance = toDistance(value.distance);
  // A API só guarda um mínimo maior que zero (e "vale na retirada" só junto dele)
  const minOrder = storeRules.min_order ? storeRules.min_order : undefined;
  return {
    zones,
    fallback: isRecord(value.fallback) ? toEstimate(value.fallback) : null,
    outside_zones: value.outside_zones === 'refuse' ? 'refuse' : 'fallback',
    ...(minOrder !== undefined ? { min_order: minOrder } : {}),
    ...(storeRules.free_delivery_above !== undefined ? { free_delivery_above: storeRules.free_delivery_above } : {}),
    ...(minOrder !== undefined && value.min_order_takeout === true ? { min_order_takeout: true } : {}),
    // Entrega por distância: o modo (só "distance" é gravado) e as faixas — sem elas aqui, salvar apagaria
    ...(value.mode === 'distance' ? { mode: 'distance' as const } : {}),
    ...(distance ? { distance } : {}),
  };
}

function toOpeningHours(value: unknown): OpeningHoursEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries = value
    .filter(isRecord)
    .map((entry) => ({ day: readNumber(entry.day, -1), open: readText(entry.open), close: readText(entry.close) }))
    .filter((entry) => Number.isInteger(entry.day) && entry.day >= 0 && entry.day <= 6 && entry.open && entry.close)
    // Mesma ordem que a API grava (dia e horário): comparações com o rascunho ficam estáveis
    .sort((a, b) => a.day - b.day || a.open.localeCompare(b.open));
  return entries.length ? entries : null;
}

export function toPaymentsSettings(value: unknown): StorePaymentsSettings {
  const raw = asRecord(value);
  return {
    mp_public_key: readNullableText(raw.mp_public_key),
    access_token_configured: readBoolean(raw.access_token_configured),
    access_token_hint: readNullableText(raw.access_token_hint),
    using_platform_credentials: readBoolean(raw.using_platform_credentials),
  };
}

/** Lê a resposta de GET/PATCH /store/settings sem confiar no formato. */
export function toStoreSettings(value: unknown): StoreSettings {
  const raw = asRecord(value);
  return {
    id: readId(raw.id),
    slug: readText(raw.slug),
    name: readText(raw.name),
    legal_name: readNullableText(raw.legal_name),
    document: readNullableText(raw.document),
    email: readNullableText(raw.email),
    phone: readNullableText(raw.phone),
    description: readNullableText(raw.description),
    logo: readNullableText(raw.logo),
    primary_color: readNullableText(raw.primary_color),
    address_zip_code: readNullableText(raw.address_zip_code),
    address_street: readNullableText(raw.address_street),
    address_number: readNullableText(raw.address_number),
    address_complement: readNullableText(raw.address_complement),
    address_neighborhood: readNullableText(raw.address_neighborhood),
    address_city: readNullableText(raw.address_city),
    address_state: readNullableText(raw.address_state),
    latitude: readCoordinate(raw.latitude, 90),
    longitude: readCoordinate(raw.longitude, 180),
    account_status: ACCOUNT_STATUSES.find((status) => status === raw.account_status) ?? 'ACTIVE',
    status_reason: readNullableText(raw.status_reason),
    is_open: readBoolean(raw.is_open),
    opening_message: readNullableText(raw.opening_message),
    closing_message: readNullableText(raw.closing_message),
    delivery_enabled: readBoolean(raw.delivery_enabled),
    takeout_enabled: readBoolean(raw.takeout_enabled),
    delivery_zones: toZones(raw.delivery_zones),
    takeout_estimate: readNullableText(raw.takeout_estimate),
    opening_hours: toOpeningHours(raw.opening_hours),
    time_zone: readText(raw.time_zone) || 'America/Sao_Paulo',
    custom_domain: readNullableText(raw.custom_domain),
    owner_user_id: readId(raw.owner_user_id) || null,
    is_default_store: readBoolean(raw.is_default_store),
    payments: toPaymentsSettings(raw.payments),
    access: toStoreAccess(raw.access),
    features: toFeatures(raw.features),
    updated_at: readDate(raw.updated_at),
    road_distance_available: readBoolean(raw.road_distance_available),
  };
}

/** Latitude/longitude em graus (número finito dentro do limite) ou null. */
function readCoordinate(value: unknown, limit: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

function toSimulation(value: unknown): DeliverySimulation {
  const raw = asRecord(value);
  const numberOrNull = (item: unknown) => (typeof item === 'number' && Number.isFinite(item) ? item : null);
  const precision = raw.precision === 'ADDRESS' || raw.precision === 'ZIP_CENTER' ? raw.precision : null;
  return {
    mode: raw.mode === 'distance' ? 'distance' : 'zones',
    located: readBoolean(raw.located),
    store_located: readBoolean(raw.store_located),
    precision,
    distance_km: numberOrNull(raw.distance_km),
    max_km: numberOrNull(raw.max_km),
    band: numberOrNull(raw.band),
    extra_km: numberOrNull(raw.extra_km) ?? 0,
    zone: numberOrNull(raw.zone),
    outside: readBoolean(raw.outside),
    refused: readBoolean(raw.refused),
    delivery_fee: numberOrNull(raw.delivery_fee),
    estimated_delivery_time: readNullableText(raw.estimated_delivery_time),
    min_order: numberOrNull(raw.min_order),
    free_delivery_above: numberOrNull(raw.free_delivery_above),
    message: readText(raw.message),
  };
}

const MULTIPART = { headers: { 'Content-Type': 'multipart/form-data' } };

export const storeSettingsService = {
  /** GET /store/settings: configurações (sem segredos), situação da loja (access) e recursos do plano. */
  get: async (signal?: AbortSignal) => {
    const response = await api.get<unknown>('/store/settings', { signal });
    return toStoreSettings(response.data);
  },

  /** PATCH /store/settings: devolve as configurações completas já atualizadas. */
  update: async (changes: StoreSettingsUpdate) => {
    const response = await api.patch<unknown>('/store/settings', changes);
    return toStoreSettings(response.data);
  },

  /** POST /store/logo (campo "file"; JPG, PNG ou WebP até 5 MB, convertido para WebP). */
  uploadLogo: async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    const response = await api.post<unknown>('/store/logo', formData, MULTIPART);
    return readNullableText(asRecord(response.data).logo);
  },

  /** DELETE /store/logo. */
  removeLogo: async () => {
    await api.delete('/store/logo');
  },

  /** PUT /store/settings/payments: grava as credenciais (a resposta traz só a dica do token). */
  setPaymentCredentials: async (credentials: StorePaymentCredentials) => {
    const response = await api.put<unknown>('/store/settings/payments', credentials);
    return toPaymentsSettings(response.data);
  },

  /** DELETE /store/settings/payments: remove as credenciais da loja. */
  removePaymentCredentials: async () => {
    const response = await api.delete<unknown>('/store/settings/payments');
    return toPaymentsSettings(response.data);
  },

  /** GET /addresses/cep/:cep (8 dígitos): endereço do CEP (services/cepService). */
  lookupCep,

  /** POST /store/settings/geocode: localiza no mapa o endereço salvo da loja (nada é gravado). */
  geocodeStore: async (): Promise<StoreGeocodeResult> => {
    const response = await api.post<unknown>('/store/settings/geocode', {});
    const raw = asRecord(response.data);
    return {
      latitude: readNumber(raw.latitude, 0),
      longitude: readNumber(raw.longitude, 0),
      precision: raw.precision === 'ZIP_CENTER' ? 'ZIP_CENTER' : 'ADDRESS',
    };
  },

  /** POST /store/settings/delivery-simulation: "teste um endereço" com a configuração em edição. */
  simulateDelivery: async (input: DeliverySimulationInput): Promise<DeliverySimulation> => {
    const response = await api.post<unknown>('/store/settings/delivery-simulation', input);
    return toSimulation(response.data);
  },
};
