import api, { MAX_PAGE_SIZE, normalizePaginated, toQuery, type Paginated } from '../api';
import type { StoreFeatures } from '../storeAccess';
import { toPlatformPlan, type BillingInterval, type PlanStatus, type PlatformPlan } from './billingParsers';

// Superpainel › Planos (backend: billing/platform-billing.controller.ts e billing/dto/plan.dto.ts).
// GET/POST /platform/plans, GET/PATCH /platform/plans/:id. Planos nunca são apagados: para tirar de venda,
// PATCH { status: 'INACTIVE' }.

export interface PlanListParams {
  page: number;
  pageSize: number;
  /** Nome ou código. */
  search?: string;
  status?: PlanStatus;
  is_public?: boolean;
}

/** Corpo do POST /platform/plans (o PATCH aceita qualquer subconjunto). Limite null = ilimitado. */
export interface PlanPayload {
  code: string;
  name: string;
  description: string | null;
  price: number;
  billing_interval: BillingInterval;
  trial_days: number;
  max_staff_users: number | null;
  max_products: number | null;
  max_monthly_orders: number | null;
  /** Armazenamento das imagens da loja em MB (null = ilimitado). */
  max_storage_mb: number | null;
  features: StoreFeatures;
  status: PlanStatus;
  is_public: boolean;
  sort_order: number;
}

/** Mesmas regras do CreatePlanDto. */
export const PLAN_RULES = {
  codePattern: /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/,
  codeMaxLength: 40,
  nameMaxLength: 80,
  descriptionMaxLength: 1000,
  maxPrice: 999_999.99,
  maxTrialDays: 365,
  maxSortOrder: 100_000,
  maxLimit: 2_147_483_647,
} as const;

async function listPage(params: PlanListParams, signal?: AbortSignal): Promise<Paginated<PlatformPlan>> {
  const response = await api.get<unknown>(`/platform/plans${toQuery({ ...params })}`, { signal });
  const page = normalizePaginated<unknown>(response.data, params.page, params.pageSize);
  return { ...page, items: page.items.map(toPlatformPlan) };
}

export const platformPlansService = {
  /** GET /platform/plans?search&status&is_public&page&pageSize (ordem de exibição). */
  list: listPage,

  /**
   * Todos os planos (disponíveis e indisponíveis), para os seletores de plano: busca as páginas de 100
   * até completar o total (com um teto de segurança).
   */
  listAll: async (signal?: AbortSignal): Promise<PlatformPlan[]> => {
    const plans: PlatformPlan[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const result = await listPage({ page, pageSize: MAX_PAGE_SIZE }, signal);
      plans.push(...result.items);
      if (result.items.length === 0 || plans.length >= result.total) break;
    }
    return plans;
  },

  /** GET /platform/plans/:id (com o número de assinaturas ativas). */
  get: async (id: number, signal?: AbortSignal): Promise<PlatformPlan> => {
    const response = await api.get<unknown>(`/platform/plans/${id}`, { signal });
    return toPlatformPlan(response.data);
  },

  /** POST /platform/plans. 409 = código já usado por outro plano. */
  create: async (payload: PlanPayload): Promise<PlatformPlan> => {
    const response = await api.post<unknown>('/platform/plans', payload);
    return toPlatformPlan(response.data);
  },

  /**
   * PATCH /platform/plans/:id: envie só o que mudou (recursos são mesclados pela API). Assinaturas existentes
   * continuam no plano; um preço novo vale a partir da próxima fatura.
   */
  update: async (id: number, changes: Partial<PlanPayload>): Promise<PlatformPlan> => {
    const response = await api.patch<unknown>(`/platform/plans/${id}`, changes);
    return toPlatformPlan(response.data);
  },
};
