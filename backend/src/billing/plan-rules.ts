/**
 * Metadados dos planos (sem banco, sem Nest): limites, recursos e rótulos usados nas mensagens.
 * Fonte única para o PlanLimitsService, as regras de assinatura e a validação dos DTOs.
 */
import type { Plan, PlanFeatures } from './entities/plan.entity';

export type PlanLimitKey = 'staff_users' | 'products' | 'monthly_orders';
export type PlanFeatureKey = keyof PlanFeatures;

export interface PlanUsage {
  staff_users: number;
  products: number;
  monthly_orders: number;
}

/** Limites de um plano por chave (null = ilimitado). */
export type PlanLimits = Record<PlanLimitKey, number | null>;

export type PlanLimitColumn =
  | 'max_staff_users'
  | 'max_products'
  | 'max_monthly_orders';

export const PLAN_LIMIT_KEYS: readonly PlanLimitKey[] = [
  'staff_users',
  'products',
  'monthly_orders',
];

export const PLAN_LIMIT_COLUMN: Readonly<
  Record<PlanLimitKey, PlanLimitColumn>
> = {
  staff_users: 'max_staff_users',
  products: 'max_products',
  monthly_orders: 'max_monthly_orders',
};

export const PLAN_LIMIT_LABEL: Readonly<Record<PlanLimitKey, string>> = {
  staff_users: 'usuários da equipe',
  products: 'produtos no cardápio',
  monthly_orders: 'pedidos neste mês',
};

export const FEATURE_LABELS: Record<PlanFeatureKey, string> = {
  online_payments: 'pagamentos online (PIX e cartão)',
  advanced_reports: 'relatórios e gráficos',
  custom_branding: 'identidade visual própria (logo e cor)',
};

/** Recursos conhecidos (lista fechada: qualquer outra chave é recusada nos DTOs). */
export const PLAN_FEATURE_KEYS = Object.keys(
  FEATURE_LABELS,
) as PlanFeatureKey[];

/** Todos os recursos com true/false explícito (o jsonb pode ter chaves faltando ou lixo antigo). */
export function normalizeFeatures(
  features: PlanFeatures | null | undefined,
): Required<PlanFeatures> {
  return Object.fromEntries(
    PLAN_FEATURE_KEYS.map((key) => [key, features?.[key] === true]),
  ) as Required<PlanFeatures>;
}

/**
 * Limite de armazenamento (plans.max_storage_mb). Fica fora de PlanLimitKey/PlanUsage de propósito: o uso
 * é medido em bytes na pasta de uploads (não é uma contagem do banco) e sai num campo próprio, `storage`,
 * sem mudar o formato de `usage`/`limits` das respostas.
 */
export const STORAGE_LIMIT_KEY = 'storage_mb';
export const STORAGE_LIMIT_LABEL = 'MB de armazenamento';

/** Limites do plano por chave (null = ilimitado). */
export function limitsOf(plan: Pick<Plan, PlanLimitColumn>): PlanLimits {
  return {
    staff_users: plan.max_staff_users ?? null,
    products: plan.max_products ?? null,
    monthly_orders: plan.max_monthly_orders ?? null,
  };
}
