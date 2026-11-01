import axios from 'axios';
import api, { normalizePaginated, toQuery, type Paginated } from '../api';
import { asRecord, readArray, readId } from '../panelParsers';
import type { InvoiceStatus, SubscriptionStatus } from '../../types/saas';
import {
  toInvoiceItem, toPlatformInvoice, toSubscriptionDetail, toSubscriptionItem,
  type PlatformInvoice, type PlatformInvoiceItem, type PlatformSubscriptionDetail, type PlatformSubscriptionItem,
} from './billingParsers';

// Superpainel › Assinaturas e faturas SaaS (backend: billing/platform-billing.controller.ts e
// billing/dto/subscription.dto.ts). Ações sobre a assinatura devolvem o detalhe atualizado; sobre a fatura,
// a fatura. Toda alteração é auditada pela API.

/** Motivo opcional das ações (até 300 caracteres; vai para o histórico e para a auditoria). */
export const BILLING_REASON_MAX_LENGTH = 300;
/** Identificador do pagamento (comprovante/transação): letras, números, ponto, hífen, barra, dois-pontos ou sublinhado. */
export const PROVIDER_PAYMENT_ID_PATTERN = /^[\w.:/-]+$/;
export const PROVIDER_PAYMENT_ID_MAX_LENGTH = 80;
export const PAYMENT_METHOD_MAX_LENGTH = 40;
/** Maior valor de fatura aceito (mesmo teto do preço dos planos). */
export const MAX_INVOICE_AMOUNT = 999_999.99;

export interface SubscriptionListParams {
  page: number;
  pageSize: number;
  /** Nome ou slug da loja. */
  search?: string;
  status?: SubscriptionStatus;
  plan_id?: number;
}

export interface InvoiceListParams {
  page: number;
  pageSize: number;
  /** Nome ou slug da loja. */
  search?: string;
  status?: InvoiceStatus;
}

/** POST /platform/stores/:id/subscription e /platform/subscriptions/:id/change-plan. */
export interface PlanChoicePayload {
  plan_id: number;
  /** Permite um plano indisponível (INACTIVE), ex.: interno ou negociado. */
  allow_inactive_plan?: boolean;
  reason?: string | null;
}

export interface CancelPayload {
  /** true = no fim do período pago; false = agora. Sem período a vencer, cancela agora. */
  at_period_end: boolean;
  /** Obrigatório no cancelamento imediato (400 sem ele); opcional no agendado. */
  reason?: string | null;
}

export interface ReactivatePayload {
  /** Reativa mesmo com faturas vencidas em aberto (motivo obrigatório). */
  force?: boolean;
  reason?: string | null;
}

/**
 * POST /platform/subscriptions/:id/invoices. Sem período: o atual (se ainda não tiver fatura) ou o seguinte.
 * Sem valor: o preço do plano. Sem vencimento: o início do período (ou agora). Datas em ISO 8601.
 */
export interface CreateInvoicePayload {
  amount?: number;
  period_start?: string;
  period_end?: string;
  due_at?: string;
  notes?: string | null;
}

/** POST /platform/invoices/:id/mark-paid (idempotente). */
export interface MarkPaidPayload {
  /**
   * Padrão: agora. Não pode estar no futuro: a API tolera 5 minutos de diferença de relógio
   * (PAID_AT_CLOCK_SKEW_MS no backend) e responde 400 depois disso.
   */
  paid_at?: string;
  payment_method?: string | null;
  /** Único: o mesmo pagamento nunca quita duas faturas. */
  provider_payment_id?: string | null;
  notes?: string | null;
}

/**
 * 409 da reativação com faturas vencidas em aberto (sem force): ids das faturas que a API listou.
 * null = o erro é outro.
 */
export function overdueInvoicesOf(error: unknown): number[] | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 409) return null;
  const data = asRecord(error.response.data);
  if (!Array.isArray(data.overdue_invoices)) return null;
  return readArray(data.overdue_invoices).map(readId).filter((id) => id > 0);
}

async function detailFrom(request: Promise<{ data: unknown }>): Promise<PlatformSubscriptionDetail> {
  const response = await request;
  return toSubscriptionDetail(response.data);
}

async function invoiceFrom(request: Promise<{ data: unknown }>): Promise<PlatformInvoice> {
  const response = await request;
  return toPlatformInvoice(response.data);
}

export const platformSubscriptionsService = {
  /** GET /platform/subscriptions?status&plan_id&search&page&pageSize (mais recentes primeiro). */
  list: async (params: SubscriptionListParams, signal?: AbortSignal): Promise<Paginated<PlatformSubscriptionItem>> => {
    const response = await api.get<unknown>(`/platform/subscriptions${toQuery({ ...params })}`, { signal });
    const page = normalizePaginated<unknown>(response.data, params.page, params.pageSize);
    return { ...page, items: page.items.map(toSubscriptionItem) };
  },

  /** GET /platform/subscriptions/:id: loja, plano, uso, limites, situação, eventos e faturas. */
  get: (id: number, signal?: AbortSignal) => detailFrom(api.get<unknown>(`/platform/subscriptions/${id}`, { signal })),

  /** POST /platform/stores/:id/subscription: loja sem assinatura vigente (409 se já houver). */
  createForStore: (storeId: number, payload: PlanChoicePayload) =>
    detailFrom(api.post<unknown>(`/platform/stores/${storeId}/subscription`, payload)),

  /** Mudança imediata, sem proporcionalidade; downgrade só se o uso couber (409 com o que excede). */
  changePlan: (id: number, payload: PlanChoicePayload) =>
    detailFrom(api.post<unknown>(`/platform/subscriptions/${id}/change-plan`, payload)),

  cancel: (id: number, payload: CancelPayload) =>
    detailFrom(api.post<unknown>(`/platform/subscriptions/${id}/cancel`, payload)),

  /**
   * Desfaz o cancelamento agendado (cancel_at_period_end) enquanto o período pago não terminou. 409 (a API explica)
   * se não houver agendamento, se a assinatura estiver cancelada ou se o período já tiver terminado.
   */
  resume: (id: number) =>
    detailFrom(api.post<unknown>(`/platform/subscriptions/${id}/resume`)),

  /** SUSPENDED/PAST_DUE → ACTIVE. 409 com overdue_invoices se houver fatura vencida e não for forçada. */
  reactivate: (id: number, payload: ReactivatePayload) =>
    detailFrom(api.post<unknown>(`/platform/subscriptions/${id}/reactivate`, payload)),

  /** ACTIVE/PAST_DUE → SUSPENDED (motivo obrigatório). */
  suspend: (id: number, reason: string) =>
    detailFrom(api.post<unknown>(`/platform/subscriptions/${id}/suspend`, { reason })),

  /** Fatura avulsa. 400 = plano gratuito sem valor ou período inválido; 409 = já existe fatura do período. */
  createInvoice: (id: number, payload: CreateInvoicePayload) =>
    invoiceFrom(api.post<unknown>(`/platform/subscriptions/${id}/invoices`, payload)),

  /** GET /platform/invoices?status&search&page&pageSize (vencimento mais recente primeiro). */
  listInvoices: async (params: InvoiceListParams, signal?: AbortSignal): Promise<Paginated<PlatformInvoiceItem>> => {
    const response = await api.get<unknown>(`/platform/invoices${toQuery({ ...params })}`, { signal });
    const page = normalizePaginated<unknown>(response.data, params.page, params.pageSize);
    return { ...page, items: page.items.map(toInvoiceItem) };
  },

  /** Registro manual do pagamento (idempotente: fatura já paga volta como está). */
  markInvoicePaid: (invoiceId: number, payload: MarkPaidPayload) =>
    invoiceFrom(api.post<unknown>(`/platform/invoices/${invoiceId}/mark-paid`, payload)),

  /** Pagamento recusado: a fatura continua devida (FAILED) e conta mais uma tentativa. Motivo obrigatório. */
  markInvoiceFailed: (invoiceId: number, reason: string) =>
    invoiceFrom(api.post<unknown>(`/platform/invoices/${invoiceId}/mark-failed`, { reason })),

  /** OPEN/FAILED → VOID. Fatura paga não pode ser anulada (409). Motivo obrigatório. */
  voidInvoice: (invoiceId: number, reason: string) =>
    invoiceFrom(api.post<unknown>(`/platform/invoices/${invoiceId}/void`, { reason })),
};
