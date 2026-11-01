import api, { cookieAuthConfig, normalizePaginated, toQuery, type Paginated } from './api';
import type { Addon, Product } from './productService';
import type { StoreStatus } from './storeService';

// Vitrine pública e cadastro de estabelecimentos (docs/saas/arquitetura.md §5.4).
// Toda resposta é lida sem confiar no formato: campos ausentes ou inválidos viram valores seguros.

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Loja no diretório (GET /stores): só dados públicos; o slug identifica a loja (/loja/:slug). */
export interface PublicStoreSummary {
  slug: string;
  name: string;
  description?: string | null;
  logo: string | null;
  primary_color?: string | null;
  address_city?: string | null;
  address_state?: string | null;
  is_open?: boolean;
}

export interface StoreDirectoryParams {
  page: number;
  pageSize: number;
  search?: string;
}

/** Horário de funcionamento de um dia (0 = domingo). close menor que open = vira a madrugada. */
export interface OpeningHoursEntry {
  day: number;
  open: string;
  close: string;
}

export interface StoreAddress {
  zip_code: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
}

/** Pagamento online da loja: liberado pelo plano + credencial; a chave pública tokeniza o cartão. */
export interface StorePaymentsInfo {
  online_enabled: boolean;
  mp_public_key: string | null;
}

/** Perfil público da loja (GET /stores/:slug e GET /stores/default). */
export interface PublicStoreProfile {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  logo: string | null;
  primary_color: string | null;
  phone: string | null;
  email: string | null;
  address: StoreAddress;
  opening_hours: OpeningHoursEntry[];
  /** Fuso IANA da loja (o "hoje" da vitrine). */
  time_zone: string;
  is_open: boolean;
  opening_message: string | null;
  closing_message: string | null;
  delivery_enabled: boolean;
  /**
   * A loja entrega fora das zonas (com a taxa padrão)? false: endereço fora da área é recusado no orçamento,
   * antes de pagar ("Este endereço está fora da área de entrega da loja.").
   */
  delivers_outside_zones: boolean;
  takeout_enabled: boolean;
  /** Prazo da retirada exibido (ex.: "15-20 min"). */
  takeout_estimate: string | null;
  /** false: loja suspensa ou assinatura sem venda — cardápio só para consulta. */
  ordering_available: boolean;
  unavailable_message: string | null;
  payments: StorePaymentsInfo;
  /** Pedido mínimo e frete grátis da loja (sem a informação: nenhum). */
  order_rules: StoreOrderRules;
  /** Entrega cobrada por distância: raio máximo em km (null = por bairro/CEP, o padrão). */
  delivery_distance: { max_km: number } | null;
}

/** Pedido mínimo e frete grátis anunciados na vitrine (o carrinho usa sempre o orçamento do servidor). */
export interface StoreOrderRules {
  /** Pedido mínimo para entrega (null = sem mínimo). */
  min_order: number | null;
  /** O pedido mínimo vale também na retirada. */
  min_order_takeout: boolean;
  /** Frete grátis a partir deste subtotal (null = sem frete grátis). */
  free_delivery_above: number | null;
  /** Algum bairro/região tem valores diferentes. */
  varies_by_zone: boolean;
}

/** Produto da vitrine: o do cardápio mais o destaque marcado pela loja. */
export type StorefrontProduct = Product & { is_highlight?: boolean };

export type BillingInterval = 'MONTHLY' | 'YEARLY';

/** Plano público (GET /plans). Limites nulos = ilimitado. */
export interface PublicPlan {
  id: number;
  code: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  billing_interval: BillingInterval | string;
  /** Preço por mês (anual ÷ 12), para comparar planos. */
  monthly_price: number | null;
  trial_days: number;
  max_staff_users: number | null;
  max_products: number | null;
  max_monthly_orders: number | null;
  /** Recursos liberados (online_payments, advanced_reports, custom_branding...). */
  features: Record<string, boolean>;
}

/** Corpo de POST /stores/signup (autoatendimento de um novo estabelecimento). */
export interface StoreSignupPayload {
  store: { name: string; slug: string };
  owner: { name: string; email: string; password: string; phone?: string };
  accept_terms: true;
}

// ---------------------------------------------------------------------------
// Leitura defensiva
// ---------------------------------------------------------------------------

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Texto sem espaços nas pontas; vazio ou outro tipo → null. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Número finito (aceita texto numérico, como os decimais do Postgres) ou null. */
function num(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveId(value: unknown): number | null {
  const parsed = num(value);
  return parsed !== null && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';

/** Fuso aceito pelo navegador; senão, o padrão da plataforma. */
function timeZone(value: unknown): string {
  const zone = text(value);
  if (!zone) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

function openingHours(value: unknown): OpeningHoursEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((entry) => ({ day: num(entry.day), open: text(entry.open), close: text(entry.close) }))
    .filter((entry): entry is OpeningHoursEntry =>
      entry.day !== null && Number.isInteger(entry.day) && entry.day >= 0 && entry.day <= 6
      && !!entry.open && HH_MM.test(entry.open) && !!entry.close && HH_MM.test(entry.close))
    .sort((a, b) => a.day - b.day || a.open.localeCompare(b.open));
}

function address(value: unknown): StoreAddress {
  const raw = isRecord(value) ? value : {};
  return {
    zip_code: text(raw.zip_code),
    street: text(raw.street),
    number: text(raw.number),
    complement: text(raw.complement),
    neighborhood: text(raw.neighborhood),
    city: text(raw.city),
    state: text(raw.state),
  };
}

/** Perfil público lido sem confiar no formato. Lança erro se faltar o essencial (id, slug ou nome). */
export function toPublicStoreProfile(data: unknown): PublicStoreProfile {
  const raw = isRecord(data) ? data : {};
  const id = positiveId(raw.id);
  const slug = text(raw.slug);
  const name = text(raw.name);
  if (id === null || !slug || !name) throw new Error('Resposta da loja inválida.');

  const payments = isRecord(raw.payments) ? raw.payments : {};
  return {
    id,
    slug,
    name,
    description: text(raw.description),
    logo: text(raw.logo),
    primary_color: text(raw.primary_color),
    phone: text(raw.phone),
    email: text(raw.email),
    address: address(raw.address),
    opening_hours: openingHours(raw.opening_hours),
    time_zone: timeZone(raw.time_zone),
    is_open: raw.is_open === true,
    opening_message: text(raw.opening_message),
    closing_message: text(raw.closing_message),
    delivery_enabled: bool(raw.delivery_enabled, true),
    // Sem a informação (API antiga), vale o comportamento de sempre: entrega fora das zonas com a taxa padrão
    delivers_outside_zones: bool(raw.delivers_outside_zones, true),
    takeout_enabled: bool(raw.takeout_enabled, true),
    takeout_estimate: text(raw.takeout_estimate),
    // Sem a informação, a vitrine deixa comprar: quem decide é sempre a API (que recusa a venda)
    ordering_available: bool(raw.ordering_available, true),
    unavailable_message: text(raw.unavailable_message),
    payments: {
      // Sem a informação, nada de pagamento online (o pagamento na entrega continua)
      online_enabled: payments.online_enabled === true,
      mp_public_key: text(payments.mp_public_key),
    },
    order_rules: orderRules(raw.order_rules),
    delivery_distance: deliveryDistance(raw.delivery_distance),
  };
}

/** Raio da entrega por distância (API antiga ou valor estranho: null). */
function deliveryDistance(value: unknown): { max_km: number } | null {
  const raw = isRecord(value) ? value : null;
  const maxKm = raw ? num(raw.max_km) : null;
  return maxKm !== null && maxKm > 0 ? { max_km: maxKm } : null;
}

/** "Entrega até 8 km" (loja que cobra por distância e está entregando); senão null. */
export function deliveryDistanceLabel(store: Pick<PublicStoreProfile, 'delivery_enabled' | 'delivery_distance'>): string | null {
  if (!store.delivery_enabled || !store.delivery_distance) return null;
  return `Entrega até ${store.delivery_distance.max_km.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km`;
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Selos da vitrine: "Pedido mínimo R$ 30,00" (com "na entrega" quando a retirada não tem mínimo) e "Frete grátis
 * acima de R$ 60,00", só para as formas de atendimento ativas; e o aviso quando os valores variam por bairro.
 */
export function orderRulesLabels(
  store: Pick<PublicStoreProfile, 'delivery_enabled' | 'takeout_enabled' | 'order_rules'> & Partial<Pick<PublicStoreProfile, 'delivery_distance'>>,
): { minOrder: string | null; freeDelivery: string | null; variesNote: string | null } {
  const rules = store.order_rules;
  const takeoutMin = store.takeout_enabled && rules.min_order_takeout;
  let minOrder: string | null = null;
  if (rules.min_order !== null && (store.delivery_enabled || takeoutMin)) {
    const scope = store.delivery_enabled && store.takeout_enabled && !takeoutMin ? ' na entrega' : !store.delivery_enabled ? ' na retirada' : '';
    minOrder = `Pedido mínimo ${brl.format(rules.min_order)}${scope}`;
  }
  let freeDelivery: string | null = null;
  if (store.delivery_enabled && rules.free_delivery_above !== null) {
    freeDelivery = rules.free_delivery_above > 0 ? `Frete grátis acima de ${brl.format(rules.free_delivery_above)}` : 'Frete grátis';
  }
  const variesNote = store.delivery_enabled && rules.varies_by_zone
    ? `O pedido mínimo e o frete grátis podem variar conforme ${store.delivery_distance ? 'a distância' : 'o bairro'} de entrega.`
    : null;
  return { minOrder, freeDelivery, variesNote };
}

/** Pedido mínimo e frete grátis do perfil (API antiga ou valor estranho: nenhum). */
function orderRules(value: unknown): StoreOrderRules {
  const raw = isRecord(value) ? value : {};
  const money = (amount: unknown) => {
    const parsed = num(amount);
    return parsed !== null && parsed >= 0 ? parsed : null;
  };
  const minOrder = money(raw.min_order);
  return {
    min_order: minOrder !== null && minOrder > 0 ? minOrder : null,
    min_order_takeout: raw.min_order_takeout === true,
    free_delivery_above: money(raw.free_delivery_above),
    varies_by_zone: raw.varies_by_zone === true,
  };
}

/** Status da loja (GET /stores/:slug/status): { id, is_open, opening_message, closing_message }. */
export function toStoreStatus(data: unknown): StoreStatus {
  const raw = isRecord(data) ? data : {};
  if (typeof raw.is_open !== 'boolean') throw new Error('Resposta de status inválida.');
  return {
    id: positiveId(raw.id) ?? undefined,
    is_open: raw.is_open,
    opening_message: text(raw.opening_message),
    closing_message: text(raw.closing_message),
  };
}

function toAddon(value: unknown): Addon | null {
  if (!isRecord(value)) return null;
  const id = positiveId(value.id);
  const name = text(value.name);
  const price = num(value.price);
  if (id === null || !name || price === null) return null;
  return {
    id,
    name,
    price,
    description: text(value.description),
    category: text(value.category) ?? undefined,
    available: value.available !== false,
  };
}

function toProduct(value: unknown): StorefrontProduct | null {
  if (!isRecord(value)) return null;
  const id = positiveId(value.id);
  const name = text(value.name);
  const price = num(value.price);
  if (id === null || !name || price === null) return null;
  const promotion = num(value.promotion_price);
  return {
    id,
    name,
    description: typeof value.description === 'string' ? value.description : '',
    price,
    promotion_price: promotion,
    image: text(value.image),
    category: text(value.category) ?? '',
    available: value.available !== false,
    ingredients: Array.isArray(value.ingredients)
      ? value.ingredients.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      : [],
    allowed_addons: Array.isArray(value.allowed_addons)
      ? value.allowed_addons.map(toAddon).filter((addon): addon is Addon => addon !== null)
      : [],
    is_highlight: value.is_highlight === true,
  };
}

function toPlan(value: unknown): PublicPlan | null {
  if (!isRecord(value)) return null;
  const id = positiveId(value.id);
  const name = text(value.name);
  if (id === null || !name) return null;
  const features = isRecord(value.features)
    ? Object.fromEntries(Object.entries(value.features).map(([key, enabled]) => [key, enabled === true]))
    : {};
  const limit = (field: unknown) => {
    const parsed = num(field);
    return parsed !== null && parsed >= 0 ? Math.floor(parsed) : null;
  };
  return {
    id,
    code: text(value.code) ?? String(id),
    name,
    description: text(value.description),
    price: num(value.price) ?? 0,
    currency: text(value.currency) ?? 'BRL',
    billing_interval: text(value.billing_interval) ?? 'MONTHLY',
    monthly_price: num(value.monthly_price),
    trial_days: Math.max(0, Math.floor(num(value.trial_days) ?? 0)),
    max_staff_users: limit(value.max_staff_users),
    max_products: limit(value.max_products),
    max_monthly_orders: limit(value.max_monthly_orders),
    features,
  };
}

/** Loja do diretório: sem slug ou nome válidos, descartada. */
function toStoreSummary(value: unknown): PublicStoreSummary | null {
  if (!isRecord(value)) return null;
  const slug = text(value.slug);
  const name = text(value.name);
  if (!slug || !name) return null;
  return {
    slug,
    name,
    description: text(value.description),
    logo: text(value.logo),
    primary_color: text(value.primary_color),
    address_city: text(value.address_city),
    address_state: text(value.address_state),
    ...(typeof value.is_open === 'boolean' ? { is_open: value.is_open } : {}),
  };
}

function storePath(slug: string): string {
  return `/stores/${encodeURIComponent(slug)}`;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export const publicStoreService = {
  /** GET /stores?page&pageSize&search: diretório de lojas que estão vendendo (abertas primeiro). */
  list: async (params: StoreDirectoryParams, signal?: AbortSignal): Promise<Paginated<PublicStoreSummary>> => {
    const response = await api.get<unknown>(`/stores${toQuery({ ...params })}`, { signal });
    const page = normalizePaginated<unknown>(response.data, params.page, params.pageSize);
    return { ...page, items: page.items.map(toStoreSummary).filter((store): store is PublicStoreSummary => store !== null) };
  },

  /** GET /stores/:slug: perfil público (404 se a loja não existe ou foi desativada). */
  get: async (slug: string, signal?: AbortSignal) => {
    const response = await api.get<unknown>(storePath(slug), { signal });
    return toPublicStoreProfile(response.data);
  },

  /** GET /stores/default: perfil da loja padrão das rotas antigas (404 se não houver). */
  getDefault: async (signal?: AbortSignal) => {
    const response = await api.get<unknown>('/stores/default', { signal });
    return toPublicStoreProfile(response.data);
  },

  /** GET /stores/:slug/status: aberta/fechada e mensagens da loja. */
  getStatus: async (slug: string, signal?: AbortSignal) => {
    const response = await api.get<unknown>(`${storePath(slug)}/status`, { signal });
    return toStoreStatus(response.data);
  },

  /** GET /stores/:slug/products: cardápio (inclui indisponíveis; a vitrine filtra). */
  getProducts: async (slug: string, signal?: AbortSignal) => {
    const response = await api.get<unknown>(`${storePath(slug)}/products`, { signal });
    if (!Array.isArray(response.data)) throw new Error('Resposta do cardápio inválida.');
    return response.data.map(toProduct).filter((product): product is StorefrontProduct => product !== null);
  },

  /** GET /stores/:slug/addons: adicionais da loja (com a disponibilidade atual). */
  getAddons: async (slug: string, signal?: AbortSignal) => {
    const response = await api.get<unknown>(`${storePath(slug)}/addons`, { signal });
    if (!Array.isArray(response.data)) throw new Error('Resposta dos adicionais inválida.');
    return response.data.map(toAddon).filter((addon): addon is Addon => addon !== null);
  },

  /** GET /plans: planos ativos e públicos (lista simples ou paginada). */
  listPlans: async (signal?: AbortSignal) => {
    const response = await api.get<unknown>('/plans', { signal });
    const items = Array.isArray(response.data) ? response.data : normalizePaginated<unknown>(response.data).items;
    return items.map(toPlan).filter((plan): plan is PublicPlan => plan !== null);
  },

  /** POST /stores/signup: cria a loja e o Administrador responsável → { access_token, user }. */
  signup: async (payload: StoreSignupPayload) => {
    // Abre a sessão do Administrador como o login: em cookie quando a API permite (ver cookieAuthConfig)
    const response = await api.post<unknown>('/stores/signup', payload, cookieAuthConfig());
    return response.data;
  },
};
