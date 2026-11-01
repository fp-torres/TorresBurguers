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
export interface DeliveryZone extends DeliveryEstimate {
  neighborhoods: string[];
  cities?: string[];
  zip_ranges?: ZipRange[];
}

/** Endereço fora das zonas: "fallback" (entrega com a taxa padrão) ou "refuse" (a loja recusa a entrega). */
export type OutsideZonesPolicy = 'fallback' | 'refuse';

/**
 * Zonas próprias da loja: a primeira zona com o bairro ou o CEP vale; fora delas, o "fallback" — ou a
 * recusa (outside_zones = "refuse"; aí o "fallback" é opcional e fica null quando a API não o tem).
 */
export interface DeliveryZonesConfig {
  zones: DeliveryZone[];
  fallback: DeliveryEstimate | null;
  outside_zones: OutsideZonesPolicy;
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
    };
  });
  return {
    zones,
    fallback: isRecord(value.fallback) ? toEstimate(value.fallback) : null,
    outside_zones: value.outside_zones === 'refuse' ? 'refuse' : 'fallback',
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
};
