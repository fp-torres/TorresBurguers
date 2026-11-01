import api, { normalizePaginated, toQuery, type Paginated } from '../api';
import {
  asRecord, isRecord, readArray, readBoolean, readDate, readId, readNullableText, readNumber, readText, readTextList,
} from '../panelParsers';
import { toFeatures, toStoreAccess, type StoreAccess, type StoreFeatures } from '../storeAccess';
import { lookupCep } from '../cepService';
import type { StoreAccountStatus, SubscriptionStatus } from '../../types/saas';
import {
  readCode, readOptionalId, toPlanLimits, toPlanUsage, toPlatformPlan, toPlatformSubscription,
  type PlanLimits, type PlanUsage, type PlatformPlan, type PlatformSubscription,
} from './billingParsers';

// Superpainel › Estabelecimentos (backend: platform/platform-stores.controller.ts, platform-stores.service.ts e
// dto/platform-stores.dto.ts). A loja-alvo vem sempre do id na rota; nenhuma chamada envia store_id no corpo.

// --- REGRAS DO CADASTRO (iguais às do backend: store-identity-rules.ts e store-status-rules.ts) ---

// Endereço (slug) e domínio próprio: regras em utils/validation (comuns ao cadastro de loja e à vitrine).

/** Motivo de suspender/desativar (obrigatório) e observação de reativar/restaurar (opcional). */
export const STATUS_REASON_MAX_LENGTH = 300;

export type StoreStatusAction = 'suspend' | 'reactivate' | 'deactivate' | 'restore';

/** Transições da situação cadastral (stores.account_status). */
export const STORE_STATUS_TRANSITIONS: Record<StoreStatusAction, { from: StoreAccountStatus[]; to: StoreAccountStatus; requiresReason: boolean }> = {
  suspend: { from: ['ACTIVE'], to: 'SUSPENDED', requiresReason: true },
  reactivate: { from: ['SUSPENDED'], to: 'ACTIVE', requiresReason: false },
  deactivate: { from: ['ACTIVE', 'SUSPENDED'], to: 'INACTIVE', requiresReason: true },
  restore: { from: ['INACTIVE'], to: 'ACTIVE', requiresReason: false },
};

// --- LISTA ---

export type StoreSortField = 'created_at' | 'name' | 'slug';
export type SortOrder = 'asc' | 'desc';
/** Situação da assinatura nos filtros: as da assinatura + NONE (loja sem assinatura). */
export type StoreSubscriptionFilter = SubscriptionStatus | 'NONE';

export interface StoreListParams {
  page: number;
  pageSize: number;
  /** Nome, slug, razão social, e-mail, domínio, e-mail do responsável ou documento. */
  search?: string;
  account_status?: StoreAccountStatus;
  /** Plano da assinatura vigente (não cancelada). */
  plan_id?: number;
  subscription_status?: StoreSubscriptionFilter;
  sort?: StoreSortField;
  order?: SortOrder;
}

export interface PlatformStoreListItem {
  id: number;
  slug: string;
  name: string;
  logo: string | null;
  account_status: StoreAccountStatus;
  is_open: boolean;
  created_at: string | null;
  owner: { id: number; name: string; email: string } | null;
  /** Plano da assinatura exibida (a vigente ou, sem ela, a mais recente). */
  plan: { id: number; code: string; name: string } | null;
  subscription: {
    id: number;
    status: SubscriptionStatus;
    trial_ends_at: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
  } | null;
  /** Equipe fora da lixeira. */
  staff_count: number;
  /** Pedidos não cancelados nos últimos 30 dias. */
  orders_30d: number;
  /** Pedidos pagos e não cancelados nos últimos 30 dias (dinheiro da loja, não receita da plataforma). */
  gmv_30d: number;
}

function toListItem(value: unknown): PlatformStoreListItem {
  const raw = asRecord(value);
  const owner = isRecord(raw.owner) ? raw.owner : null;
  const plan = isRecord(raw.plan) ? raw.plan : null;
  const subscription = isRecord(raw.subscription) ? raw.subscription : null;
  return {
    id: readId(raw.id),
    slug: readText(raw.slug),
    name: readText(raw.name, 'Estabelecimento'),
    logo: readNullableText(raw.logo),
    account_status: readCode<StoreAccountStatus>(raw.account_status),
    is_open: readBoolean(raw.is_open, false),
    created_at: readDate(raw.created_at),
    owner: owner ? { id: readId(owner.id), name: readText(owner.name), email: readText(owner.email) } : null,
    plan: plan ? { id: readId(plan.id), code: readText(plan.code), name: readText(plan.name, 'Plano') } : null,
    subscription: subscription
      ? {
        id: readId(subscription.id),
        status: readCode<SubscriptionStatus>(subscription.status),
        trial_ends_at: readDate(subscription.trial_ends_at),
        current_period_end: readDate(subscription.current_period_end),
        cancel_at_period_end: readBoolean(subscription.cancel_at_period_end, false),
      }
      : null,
    staff_count: readNumber(raw.staff_count, 0),
    orders_30d: readNumber(raw.orders_30d, 0),
    gmv_30d: readNumber(raw.gmv_30d, 0),
  };
}

// --- DETALHE ---

/** Dados cadastrais que o superpainel informa na criação e na edição (vazio/null limpa o campo). */
export interface StoreProfilePayload {
  legal_name: string | null;
  /** CPF/CNPJ sem pontuação (a API normaliza e confere os dígitos verificadores). */
  document: string | null;
  email: string | null;
  /** Só dígitos (DDD + número). */
  phone: string | null;
  address_zip_code: string | null;
  address_street: string | null;
  address_number: string | null;
  address_complement: string | null;
  address_neighborhood: string | null;
  address_city: string | null;
  address_state: string | null;
}

export const STORE_PROFILE_FIELDS: readonly (keyof StoreProfilePayload)[] = [
  'legal_name', 'document', 'email', 'phone', 'address_zip_code', 'address_street', 'address_number',
  'address_complement', 'address_neighborhood', 'address_city', 'address_state',
];

export interface StoreOwnerInfo {
  id: number;
  name: string;
  email: string;
  role: string;
  blocked: boolean;
  deleted: boolean;
  /** Ainda é ADMIN ativo desta loja. */
  eligible: boolean;
}

export interface StorePaymentsInfo {
  /** A loja gravou a própria credencial do Mercado Pago (o token nunca sai da API). */
  configured: boolean;
  mp_public_key: string | null;
  /** Loja padrão sem credencial própria usando a credencial do ambiente. */
  using_platform_credentials: boolean;
  online_payments_in_plan: boolean;
}

export interface StoreDetailMetrics {
  orders_total: number;
  orders_30d: number;
  canceled_orders_total: number;
  gmv_total: number;
  gmv_30d: number;
  customers: number;
  staff: number;
  active_staff: number;
  active_admins: number;
  last_order_at: string | null;
  currency: string;
  /** Como a API calcula os indicadores (texto exibido na tela). */
  methodology: string | null;
}

export interface StoreDetailSubscription extends PlatformSubscription {
  plan: PlatformPlan | null;
}

export interface PlatformStoreDetail extends StoreProfilePayload {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  logo: string | null;
  primary_color: string | null;
  account_status: StoreAccountStatus;
  /** Motivo da suspensão/desativação (exibido à equipe da loja). */
  status_reason: string | null;
  status_changed_at: string | null;
  is_open: boolean;
  delivery_enabled: boolean;
  takeout_enabled: boolean;
  time_zone: string;
  /** Registrado, mas ainda não roteado automaticamente. */
  custom_domain: string | null;
  owner_user_id: number | null;
  created_at: string | null;
  updated_at: string | null;
  /** Loja padrão das rotas antigas (app mobile e integrações da versão de loja única). */
  is_default_store: boolean;
  owner: StoreOwnerInfo | null;
  /** A vigente ou, sem ela, a última cancelada (null = nunca teve assinatura). */
  subscription: StoreDetailSubscription | null;
  features: StoreFeatures;
  usage: PlanUsage;
  /** Limites do plano vigente (null = sem assinatura vigente; limite null = ilimitado). */
  limits: PlanLimits | null;
  payments: StorePaymentsInfo;
  metrics: StoreDetailMetrics;
  access: StoreAccess | null;
}

function toProfile(raw: Record<string, unknown>): StoreProfilePayload {
  return {
    legal_name: readNullableText(raw.legal_name),
    document: readNullableText(raw.document),
    email: readNullableText(raw.email),
    phone: readNullableText(raw.phone),
    address_zip_code: readNullableText(raw.address_zip_code),
    address_street: readNullableText(raw.address_street),
    address_number: readNullableText(raw.address_number),
    address_complement: readNullableText(raw.address_complement),
    address_neighborhood: readNullableText(raw.address_neighborhood),
    address_city: readNullableText(raw.address_city),
    address_state: readNullableText(raw.address_state),
  };
}

function toOwner(value: unknown): StoreOwnerInfo | null {
  if (!isRecord(value)) return null;
  return {
    id: readId(value.id),
    name: readText(value.name),
    email: readText(value.email),
    role: readText(value.role),
    blocked: readBoolean(value.blocked, false),
    deleted: readBoolean(value.deleted, false),
    eligible: readBoolean(value.eligible, false),
  };
}

function toDetailMetrics(value: unknown): StoreDetailMetrics {
  const raw = asRecord(value);
  return {
    orders_total: readNumber(raw.orders_total, 0),
    orders_30d: readNumber(raw.orders_30d, 0),
    canceled_orders_total: readNumber(raw.canceled_orders_total, 0),
    gmv_total: readNumber(raw.gmv_total, 0),
    gmv_30d: readNumber(raw.gmv_30d, 0),
    customers: readNumber(raw.customers, 0),
    staff: readNumber(raw.staff, 0),
    active_staff: readNumber(raw.active_staff, 0),
    active_admins: readNumber(raw.active_admins, 0),
    last_order_at: readDate(raw.last_order_at),
    currency: readText(raw.currency, 'BRL'),
    methodology: readNullableText(raw.methodology),
  };
}

export function toStoreDetail(value: unknown): PlatformStoreDetail {
  const raw = asRecord(value);
  const payments = asRecord(raw.payments);
  const subscription = isRecord(raw.subscription) ? raw.subscription : null;
  return {
    ...toProfile(raw),
    id: readId(raw.id),
    slug: readText(raw.slug),
    name: readText(raw.name, 'Estabelecimento'),
    description: readNullableText(raw.description),
    logo: readNullableText(raw.logo),
    primary_color: readNullableText(raw.primary_color),
    account_status: readCode<StoreAccountStatus>(raw.account_status),
    status_reason: readNullableText(raw.status_reason),
    status_changed_at: readDate(raw.status_changed_at),
    is_open: readBoolean(raw.is_open, false),
    delivery_enabled: readBoolean(raw.delivery_enabled, false),
    takeout_enabled: readBoolean(raw.takeout_enabled, false),
    time_zone: readText(raw.time_zone, 'America/Sao_Paulo'),
    custom_domain: readNullableText(raw.custom_domain),
    owner_user_id: readOptionalId(raw.owner_user_id),
    created_at: readDate(raw.created_at),
    updated_at: readDate(raw.updated_at),
    is_default_store: readBoolean(raw.is_default_store, false),
    owner: toOwner(raw.owner),
    subscription: subscription
      ? { ...toPlatformSubscription(subscription), plan: isRecord(subscription.plan) ? toPlatformPlan(subscription.plan) : null }
      : null,
    features: toFeatures(raw.features),
    usage: toPlanUsage(raw.usage),
    limits: toPlanLimits(raw.limits),
    payments: {
      configured: readBoolean(payments.configured, false),
      mp_public_key: readNullableText(payments.mp_public_key),
      using_platform_credentials: readBoolean(payments.using_platform_credentials, false),
      online_payments_in_plan: readBoolean(payments.online_payments_in_plan, false),
    },
    metrics: toDetailMetrics(raw.metrics),
    access: toStoreAccess(raw.access),
  };
}

/** Respostas do PATCH e das mudanças de situação: o detalhe atualizado + avisos (nunca bloqueiam). */
export interface StoreMutationResult {
  store: PlatformStoreDetail;
  warnings: string[];
}

function toMutationResult(value: unknown): StoreMutationResult {
  return { store: toStoreDetail(value), warnings: readTextList(asRecord(value).warnings) };
}

// --- CADASTRO ---

export interface CreateStorePayload extends Partial<StoreProfilePayload> {
  name: string;
  slug: string;
  /** Plano inicial: a assinatura é criada junto com a loja. */
  plan_id: number;
  /** Permite um plano indisponível (INACTIVE), ex.: interno ou negociado. */
  allow_inactive_plan?: boolean;
  /** Responsável: recebe um convite de ADMIN e vira o responsável ao aceitar. */
  owner: { email: string; name?: string };
}

export interface CreatedStore {
  store: { id: number; slug: string; name: string; account_status: StoreAccountStatus };
  subscription: (PlatformSubscription & { plan: PlatformPlan | null }) | null;
  /**
   * Convite do responsável: o link (url) aparece só nesta resposta. Com o envio de e-mails configurado na
   * plataforma, o link vai só para o responsável: url null, delivered true e message (e-mail mascarado).
   */
  invitation: {
    id: number; email: string; role: string; expires_at: string | null;
    url: string | null; delivered: boolean; message: string | null;
  } | null;
  warnings: string[];
}

function toCreatedStore(value: unknown): CreatedStore {
  const raw = asRecord(value);
  const store = asRecord(raw.store);
  const subscription = isRecord(raw.subscription) ? raw.subscription : null;
  const invitation = isRecord(raw.invitation) ? raw.invitation : null;
  return {
    store: {
      id: readId(store.id),
      slug: readText(store.slug),
      name: readText(store.name, 'Estabelecimento'),
      account_status: readCode<StoreAccountStatus>(store.account_status),
    },
    subscription: subscription
      ? { ...toPlatformSubscription(subscription), plan: isRecord(subscription.plan) ? toPlatformPlan(subscription.plan) : null }
      : null,
    invitation: invitation
      ? {
        id: readId(invitation.id),
        email: readText(invitation.email),
        role: readText(invitation.role),
        expires_at: readDate(invitation.expires_at),
        url: readNullableText(invitation.url),
        delivered: readBoolean(invitation.delivered, false),
        message: readNullableText(invitation.message),
      }
      : null,
    warnings: readTextList(raw.warnings),
  };
}

// --- EQUIPE ---

export interface StoreTeamParams {
  page: number;
  pageSize: number;
  search?: string;
  /** Inclui quem está na lixeira (padrão da API: true). */
  include_deleted?: boolean;
}

export interface PlatformStoreMember {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  avatar: string | null;
  role: string;
  platform_role: string | null;
  /** É o responsável principal da loja. */
  is_owner: boolean;
  blocked_at: string | null;
  blocked_reason: string | null;
  last_login_at: string | null;
  created_at: string | null;
  /** Na lixeira desde (null = ativo na equipe). */
  deleted_at: string | null;
}

function toMember(value: unknown): PlatformStoreMember {
  const raw = asRecord(value);
  return {
    id: readId(raw.id),
    name: readText(raw.name),
    email: readText(raw.email),
    phone: readNullableText(raw.phone),
    avatar: readNullableText(raw.avatar),
    role: readText(raw.role),
    platform_role: readNullableText(raw.platform_role),
    is_owner: readBoolean(raw.is_owner, false),
    blocked_at: readDate(raw.blocked_at),
    blocked_reason: readNullableText(raw.blocked_reason),
    last_login_at: readDate(raw.last_login_at),
    created_at: readDate(raw.created_at),
    deleted_at: readDate(raw.deleted_at),
  };
}

// --- RELATÓRIO DE VENDAS ---

export interface StoreMetricsParams {
  /** AAAA-MM-DD (calendário da loja). Padrão da API: 30 dias até "to". */
  from?: string;
  /** AAAA-MM-DD. Padrão da API: hoje no fuso da loja. */
  to?: string;
}

export interface StoreMetricsReport {
  period: { from: string; to: string; days: number; time_zone: string };
  currency: string;
  summary: { orders: number; canceled_orders: number; paid_orders: number; gmv: number; average_ticket: number };
  /** Um item por dia do período (dias sem pedidos vêm zerados). Pedidos: não cancelados. */
  daily: { date: string; orders: number; paid_orders: number; gmv: number }[];
  by_status: { status: string; count: number }[];
  by_payment_method: { method: string; orders: number; paid_orders: number; gmv: number }[];
  methodology: string | null;
}

function toMetricsReport(value: unknown): StoreMetricsReport {
  const raw = asRecord(value);
  const period = asRecord(raw.period);
  const summary = asRecord(raw.summary);
  return {
    period: {
      from: readText(period.from),
      to: readText(period.to),
      days: readNumber(period.days, 0),
      time_zone: readText(period.time_zone),
    },
    currency: readText(raw.currency, 'BRL'),
    summary: {
      orders: readNumber(summary.orders, 0),
      canceled_orders: readNumber(summary.canceled_orders, 0),
      paid_orders: readNumber(summary.paid_orders, 0),
      gmv: readNumber(summary.gmv, 0),
      average_ticket: readNumber(summary.average_ticket, 0),
    },
    daily: readArray(raw.daily).filter(isRecord).map((day) => ({
      date: readText(day.date),
      orders: readNumber(day.orders, 0),
      paid_orders: readNumber(day.paid_orders, 0),
      gmv: readNumber(day.gmv, 0),
    })),
    by_status: readArray(raw.by_status).filter(isRecord).map((item) => ({
      status: readText(item.status),
      count: readNumber(item.count, 0),
    })),
    by_payment_method: readArray(raw.by_payment_method).filter(isRecord).map((item) => ({
      method: readText(item.method),
      orders: readNumber(item.orders, 0),
      paid_orders: readNumber(item.paid_orders, 0),
      gmv: readNumber(item.gmv, 0),
    })),
    methodology: readNullableText(raw.methodology),
  };
}

// A auditoria da loja (GET /platform/stores/:id/audit) usa o mesmo formato e o mesmo parser da auditoria
// geral: platformAuditService.listForStore (auditService.ts).

export const platformStoresService = {
  /** GET /platform/stores?search&account_status&plan_id&subscription_status&sort&order&page&pageSize. */
  list: async (params: StoreListParams, signal?: AbortSignal): Promise<Paginated<PlatformStoreListItem>> => {
    const response = await api.get<unknown>(`/platform/stores${toQuery({ ...params })}`, { signal });
    const page = normalizePaginated<unknown>(response.data, params.page, params.pageSize);
    return { ...page, items: page.items.map(toListItem) };
  },

  /** GET /platform/stores/:id: cadastro, situação, responsável, assinatura, uso × limites, pagamentos e indicadores. */
  get: async (id: number, signal?: AbortSignal): Promise<PlatformStoreDetail> => {
    const response = await api.get<unknown>(`/platform/stores/${id}`, { signal });
    return toStoreDetail(response.data);
  },

  /**
   * POST /platform/stores: loja + assinatura do plano inicial + convite do responsável.
   * 409 = slug em uso ou e-mail do responsável já tem conta; 400 = dados inválidos (a API explica).
   */
  create: async (payload: CreateStorePayload): Promise<CreatedStore> => {
    const response = await api.post<unknown>('/platform/stores', payload);
    return toCreatedStore(response.data);
  },

  /** PATCH /platform/stores/:id: envie só o que mudou (nome, slug, cadastro, domínio próprio, responsável). */
  update: async (
    id: number,
    changes: Partial<StoreProfilePayload> & { name?: string; slug?: string; custom_domain?: string | null; owner_user_id?: number | null },
  ): Promise<StoreMutationResult> => {
    const response = await api.patch<unknown>(`/platform/stores/${id}`, changes);
    return toMutationResult(response.data);
  },

  /**
   * POST /platform/stores/:id/{suspend,reactivate,deactivate,restore}. Suspender e desativar exigem o motivo
   * (aparece para a equipe da loja); reativar e restaurar aceitam uma observação (só na auditoria).
   */
  changeStatus: async (id: number, action: StoreStatusAction, reason?: string | null): Promise<StoreMutationResult> => {
    const text = reason?.trim() || undefined;
    const response = await api.post<unknown>(`/platform/stores/${id}/${action}`, text ? { reason: text } : {});
    return toMutationResult(response.data);
  },

  /** GET /platform/stores/:id/users: equipe (inclusive a lixeira), com último acesso e bloqueio. */
  team: async (id: number, params: StoreTeamParams, signal?: AbortSignal): Promise<Paginated<PlatformStoreMember>> => {
    const response = await api.get<unknown>(`/platform/stores/${id}/users${toQuery({ ...params })}`, { signal });
    const page = normalizePaginated<unknown>(response.data, params.page, params.pageSize);
    return { ...page, items: page.items.map(toMember) };
  },

  /** GET /platform/stores/:id/metrics?from&to: vendas por dia (calendário da loja), por situação e forma de pagamento. */
  metrics: async (id: number, params: StoreMetricsParams, signal?: AbortSignal): Promise<StoreMetricsReport> => {
    const response = await api.get<unknown>(`/platform/stores/${id}/metrics${toQuery({ ...params })}`, { signal });
    return toMetricsReport(response.data);
  },

  /** GET /addresses/cep/:cep (8 dígitos): endereço do CEP (services/cepService). 404 = CEP inexistente. */
  lookupCep,
};
