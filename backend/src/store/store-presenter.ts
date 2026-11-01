import { roadDistanceConfigured } from '../addresses/geocoding';
import { publicDeliveryDistance } from '../orders/delivery-distance';
import { publicOrderRules } from '../orders/order-rules';
import type { StoreAccessState } from '../tenancy/store-access';
import type { Store } from './entities/store.entity';
import type { StoreFeatures } from './store-rules';

/**
 * Formatos das respostas da loja, montados por LISTA DE CAMPOS PERMITIDOS: a entidade nunca é
 * devolvida inteira (nem o Access Token cifrado, o responsável ou a relação owner).
 */

/** GET/PATCH /store/status e GET /stores/:storeSlug/status: exatamente estas 4 chaves (contrato do app mobile). */
export interface StoreStatusView {
  id: number;
  is_open: boolean;
  opening_message: string | null;
  closing_message: string | null;
}

export function presentStoreStatus(
  store: Pick<Store, 'id' | 'is_open' | 'opening_message' | 'closing_message'>,
): StoreStatusView {
  return {
    id: store.id,
    is_open: store.is_open,
    opening_message: store.opening_message ?? null,
    closing_message: store.closing_message ?? null,
  };
}

/** Credenciais do Mercado Pago no painel: o Access Token nunca sai, só uma dica mascarada. */
export interface StorePaymentsSettingsView {
  mp_public_key: string | null;
  access_token_configured: boolean;
  /** Começo e fim do token (ex.: "APP_USR-12…cd34"), para conferência. */
  access_token_hint: string | null;
  /** Loja padrão sem credencial própria usando o MP_ACCESS_TOKEN do ambiente. */
  using_platform_credentials: boolean;
}

export interface StoreSettingsExtras {
  is_default_store: boolean;
  payments: StorePaymentsSettingsView;
  access: StoreAccessState;
  features: StoreFeatures;
}

/** GET /store/settings: todos os campos editáveis e informativos da loja, sem segredos. */
export function presentStoreSettings(
  store: Store,
  extras: StoreSettingsExtras,
) {
  return {
    id: store.id,
    slug: store.slug,
    name: store.name,
    legal_name: store.legal_name ?? null,
    document: store.document ?? null,
    email: store.email ?? null,
    phone: store.phone ?? null,
    description: store.description ?? null,
    logo: store.logo ?? null,
    primary_color: store.primary_color ?? null,
    address_zip_code: store.address_zip_code ?? null,
    address_street: store.address_street ?? null,
    address_number: store.address_number ?? null,
    address_complement: store.address_complement ?? null,
    address_neighborhood: store.address_neighborhood ?? null,
    address_city: store.address_city ?? null,
    address_state: store.address_state ?? null,
    // Aditivo: local da loja no mapa (entrega por distância)
    latitude: store.latitude ?? null,
    longitude: store.longitude ?? null,
    account_status: store.account_status,
    status_reason: store.status_reason ?? null,
    status_changed_at: store.status_changed_at ?? null,
    is_open: store.is_open,
    opening_message: store.opening_message ?? null,
    closing_message: store.closing_message ?? null,
    delivery_enabled: store.delivery_enabled,
    takeout_enabled: store.takeout_enabled,
    delivery_zones: store.delivery_zones ?? null,
    takeout_estimate: store.takeout_estimate ?? null,
    opening_hours: store.opening_hours ?? null,
    time_zone: store.time_zone,
    custom_domain: store.custom_domain ?? null,
    owner_user_id: store.owner_user_id ?? null,
    created_at: store.created_at,
    updated_at: store.updated_at,
    is_default_store: extras.is_default_store,
    payments: extras.payments,
    access: extras.access,
    features: extras.features,
    // Aditivo: a distância por rua (Google) está disponível na plataforma (o painel só oferece então)
    road_distance_available: roadDistanceConfigured(),
  };
}

export type StoreSettingsView = ReturnType<typeof presentStoreSettings>;

export interface PublicStoreExtras {
  /** Entrega de fato disponível (ligada e com zonas próprias, ou a loja padrão com as da plataforma). */
  delivery_enabled: boolean;
  /**
   * A loja entrega fora das zonas (com a taxa de "fallback")? false = endereço fora das zonas é recusado
   * (delivery_zones.outside_zones = "refuse").
   */
  delivers_outside_zones: boolean;
  /** Prazo da retirada exibido (o da loja ou o padrão da plataforma). */
  takeout_estimate: string;
  ordering_available: boolean;
  unavailable_message: string | null;
  payments: { online_enabled: boolean; mp_public_key: string | null };
}

/**
 * GET /stores/:storeSlug e /stores/default: perfil público da vitrine. Nunca inclui documento,
 * responsável, situação interna (motivo de suspensão) nem credenciais privadas.
 */
export function presentPublicStore(store: Store, extras: PublicStoreExtras) {
  return {
    id: store.id,
    slug: store.slug,
    name: store.name,
    description: store.description ?? null,
    logo: store.logo ?? null,
    primary_color: store.primary_color ?? null,
    phone: store.phone ?? null,
    email: store.email ?? null,
    address: {
      zip_code: store.address_zip_code ?? null,
      street: store.address_street ?? null,
      number: store.address_number ?? null,
      complement: store.address_complement ?? null,
      neighborhood: store.address_neighborhood ?? null,
      city: store.address_city ?? null,
      state: store.address_state ?? null,
    },
    opening_hours: store.opening_hours ?? null,
    time_zone: store.time_zone,
    is_open: store.is_open,
    opening_message: store.opening_message ?? null,
    closing_message: store.closing_message ?? null,
    delivery_enabled: extras.delivery_enabled,
    delivers_outside_zones: extras.delivers_outside_zones,
    takeout_enabled: store.takeout_enabled,
    takeout_estimate: extras.takeout_estimate,
    ordering_available: extras.ordering_available,
    unavailable_message: extras.unavailable_message,
    payments: extras.payments,
    // Aditivo: pedido mínimo e frete grátis da loja para a vitrine (das zonas próprias; sem elas, nada)
    order_rules: publicOrderRules(store.delivery_zones),
    // Aditivo: "Entrega até X km" na vitrine (modo por distância); null no modo por zonas
    delivery_distance: publicDeliveryDistance(store.delivery_zones),
  };
}

export type PublicStoreView = ReturnType<typeof presentPublicStore>;

/** Item do diretório público (GET /stores). */
export interface StoreDirectoryItem {
  slug: string;
  name: string;
  description: string | null;
  logo: string | null;
  primary_color: string | null;
  address_city: string | null;
  address_state: string | null;
  is_open: boolean;
}

/** Lista paginada das rotas novas: { items, total, page, pageSize }. */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
