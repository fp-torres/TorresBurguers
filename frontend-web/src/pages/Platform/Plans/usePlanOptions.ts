import { useMemo } from 'react';
import { platformPlansService } from '../../../services/platform/plansService';
import type { PlatformPlan } from '../../../services/platform/billingParsers';
import { useResource } from '../../../hooks/useResource';

export interface PlanOptions {
  /** Todos os planos (disponíveis e indisponíveis), na ordem de exibição. */
  plans: PlatformPlan[];
  byId: Map<number, PlatformPlan>;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/** Planos para seletores e filtros (GET /platform/plans, todas as páginas). */
export function usePlanOptions(enabled = true): PlanOptions {
  const resource = useResource((signal) => platformPlansService.listAll(signal), {
    enabled,
    errorMessage: 'Não foi possível carregar os planos.',
  });
  const plans = useMemo(() => resource.data ?? [], [resource.data]);
  const byId = useMemo(() => new Map(plans.map((plan) => [plan.id, plan])), [plans]);
  const { reload } = resource;
  return {
    plans,
    byId,
    loading: resource.loading,
    error: resource.error,
    reload: () => reload(),
  };
}
