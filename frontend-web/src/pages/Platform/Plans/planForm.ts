import { PLAN_RULES, type PlanPayload } from '../../../services/platform/plansService';
import type { BillingInterval, PlanLimitKey, PlanStatus, PlatformPlan } from '../../../services/platform/billingParsers';
import type { StoreFeatures } from '../../../services/storeAccess';
import { PLAN_LIMIT_LABELS } from '../Subscriptions/billingDisplay';
import { moneyToInput, parseMoneyInput } from '../Subscriptions/formRules';

// Formulário de plano (criar/editar): valores digitados, validação igual à do CreatePlanDto e montagem do
// corpo do POST/PATCH (no PATCH, só o que mudou).

export interface LimitInput {
  unlimited: boolean;
  value: string;
}

/** Limites editados no formulário: os do uso contado (PlanLimitKey) + o armazenamento em MB. */
export type PlanFormLimitKey = PlanLimitKey | 'storage_mb';
export const PLAN_FORM_LIMIT_KEYS: readonly PlanFormLimitKey[] = ['staff_users', 'products', 'monthly_orders', 'storage_mb'];
export const PLAN_FORM_LIMIT_LABELS: Record<PlanFormLimitKey, string> = {
  ...PLAN_LIMIT_LABELS,
  storage_mb: 'Armazenamento (MB)',
};

export interface PlanFormValues {
  code: string;
  name: string;
  description: string;
  price: string;
  billing_interval: BillingInterval;
  trial_days: string;
  limits: Record<PlanFormLimitKey, LimitInput>;
  features: StoreFeatures;
  status: PlanStatus;
  is_public: boolean;
  sort_order: string;
}

export type PlanFormErrors = Partial<Record<'code' | 'name' | 'description' | 'price' | 'trial_days' | 'sort_order' | PlanFormLimitKey, string>>;

export function emptyPlanForm(): PlanFormValues {
  return {
    code: '',
    name: '',
    description: '',
    price: '',
    billing_interval: 'MONTHLY',
    trial_days: '0',
    limits: {
      staff_users: { unlimited: true, value: '' },
      products: { unlimited: true, value: '' },
      monthly_orders: { unlimited: true, value: '' },
      storage_mb: { unlimited: true, value: '' },
    },
    features: { online_payments: false, advanced_reports: false, custom_branding: false },
    status: 'ACTIVE',
    is_public: true,
    sort_order: '0',
  };
}

function limitInput(limit: number | null): LimitInput {
  return limit === null ? { unlimited: true, value: '' } : { unlimited: false, value: String(limit) };
}

export function planToForm(plan: PlatformPlan): PlanFormValues {
  return {
    code: plan.code,
    name: plan.name,
    description: plan.description ?? '',
    price: moneyToInput(plan.price),
    billing_interval: plan.billing_interval,
    trial_days: String(plan.trial_days),
    limits: {
      staff_users: limitInput(plan.max_staff_users),
      products: limitInput(plan.max_products),
      monthly_orders: limitInput(plan.max_monthly_orders),
      storage_mb: limitInput(plan.max_storage_mb),
    },
    features: { ...plan.features },
    status: plan.status,
    is_public: plan.is_public,
    sort_order: String(plan.sort_order),
  };
}

/** Inteiro de um campo (vazio → fallback; inválido → NaN). */
function parseInteger(value: string, fallback: number): number {
  const text = value.trim();
  if (!text) return fallback;
  return /^\d+$/.test(text) ? Number(text) : Number.NaN;
}

/** Valida e monta o corpo completo (erros por campo; payload só quando não há erros). */
export function buildPlanPayload(values: PlanFormValues): { payload: PlanPayload | null; errors: PlanFormErrors } {
  const errors: PlanFormErrors = {};
  const code = values.code.trim().toLowerCase();
  if (!code) errors.code = 'Informe o código do plano.';
  else if (code.length > PLAN_RULES.codeMaxLength) errors.code = `Use no máximo ${PLAN_RULES.codeMaxLength} caracteres.`;
  else if (!PLAN_RULES.codePattern.test(code)) errors.code = 'Use letras minúsculas, números e hífens, sem hífen nas pontas (ex.: essencial, pro-anual).';

  const name = values.name.trim();
  if (!name) errors.name = 'Informe o nome do plano.';
  else if (name.length > PLAN_RULES.nameMaxLength) errors.name = `Use no máximo ${PLAN_RULES.nameMaxLength} caracteres.`;

  const description = values.description.trim();
  if (description.length > PLAN_RULES.descriptionMaxLength) errors.description = `Use no máximo ${PLAN_RULES.descriptionMaxLength} caracteres.`;

  const price = parseMoneyInput(values.price);
  if (price === null) errors.price = 'Informe o preço (0 para plano gratuito).';
  else if (Number.isNaN(price)) errors.price = 'Informe um preço válido (ex.: 99,90).';
  else if (price < 0) errors.price = 'O preço não pode ser negativo.';
  else if (price > PLAN_RULES.maxPrice) errors.price = 'Preço acima do limite permitido.';

  const trialDays = parseInteger(values.trial_days, 0);
  if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > PLAN_RULES.maxTrialDays) {
    errors.trial_days = `Use um número inteiro de 0 a ${PLAN_RULES.maxTrialDays}.`;
  }

  const sortOrder = parseInteger(values.sort_order, 0);
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > PLAN_RULES.maxSortOrder) {
    errors.sort_order = `Use um número inteiro de 0 a ${PLAN_RULES.maxSortOrder}.`;
  }

  const limits = {} as Record<PlanFormLimitKey, number | null>;
  PLAN_FORM_LIMIT_KEYS.forEach((key) => {
    const input = values.limits[key];
    if (input.unlimited) {
      limits[key] = null;
      return;
    }
    const limit = parseInteger(input.value, Number.NaN);
    if (!Number.isInteger(limit) || limit < 1 || limit > PLAN_RULES.maxLimit) {
      errors[key] = 'Informe um número inteiro a partir de 1 (ou marque "Ilimitado").';
      limits[key] = null;
    } else {
      limits[key] = limit;
    }
  });

  if (Object.keys(errors).length > 0 || price === null || Number.isNaN(price)) return { payload: null, errors };
  return {
    errors,
    payload: {
      code,
      name,
      description: description || null,
      price,
      billing_interval: values.billing_interval,
      trial_days: trialDays,
      max_staff_users: limits.staff_users,
      max_products: limits.products,
      max_monthly_orders: limits.monthly_orders,
      max_storage_mb: limits.storage_mb,
      features: { ...values.features },
      status: values.status,
      is_public: values.is_public,
      sort_order: sortOrder,
    },
  };
}

/** Só os campos que mudaram em relação ao plano (corpo do PATCH). */
export function planChanges(plan: PlatformPlan, payload: PlanPayload): Partial<PlanPayload> {
  const changes: Partial<PlanPayload> = {};
  const set = <K extends keyof PlanPayload>(key: K, value: PlanPayload[K]) => {
    changes[key] = value;
  };
  if (payload.code !== plan.code) set('code', payload.code);
  if (payload.name !== plan.name) set('name', payload.name);
  if ((payload.description ?? null) !== (plan.description ?? null)) set('description', payload.description);
  if (payload.price !== plan.price) set('price', payload.price);
  if (payload.billing_interval !== plan.billing_interval) set('billing_interval', payload.billing_interval);
  if (payload.trial_days !== plan.trial_days) set('trial_days', payload.trial_days);
  if (payload.max_staff_users !== plan.max_staff_users) set('max_staff_users', payload.max_staff_users);
  if (payload.max_products !== plan.max_products) set('max_products', payload.max_products);
  if (payload.max_monthly_orders !== plan.max_monthly_orders) set('max_monthly_orders', payload.max_monthly_orders);
  if (payload.max_storage_mb !== plan.max_storage_mb) set('max_storage_mb', payload.max_storage_mb);
  if ((Object.keys(payload.features) as (keyof StoreFeatures)[]).some((key) => payload.features[key] !== plan.features[key])) {
    set('features', payload.features);
  }
  if (payload.status !== plan.status) set('status', payload.status);
  if (payload.is_public !== plan.is_public) set('is_public', payload.is_public);
  if (payload.sort_order !== plan.sort_order) set('sort_order', payload.sort_order);
  return changes;
}

/** Mudanças que afetam quem já assina o plano (pedem confirmação quando há assinaturas ativas). */
export function impactfulChanges(changes: Partial<PlanPayload>): string[] {
  const notes: string[] = [];
  if (changes.price !== undefined || changes.billing_interval !== undefined) {
    notes.push('O preço/periodicidade novo vale a partir da próxima fatura de cada assinatura (sem proporcionalidade).');
  }
  if (changes.max_staff_users !== undefined || changes.max_products !== undefined || changes.max_monthly_orders !== undefined) {
    notes.push('Os limites novos valem na hora: lojas acima de um limite reduzido não conseguem cadastrar mais (o que já existe continua).');
  }
  if (changes.max_storage_mb !== undefined && changes.max_storage_mb !== null) {
    notes.push('Lojas acima do armazenamento novo não conseguem enviar novas imagens (as que já existem continuam).');
  }
  if (changes.features !== undefined) notes.push('Recursos desligados deixam de funcionar na hora para as lojas deste plano.');
  if (changes.status === 'INACTIVE') notes.push('O plano sai de venda: não aparece para novas contratações; as assinaturas atuais continuam nele.');
  if (changes.code !== undefined) notes.push('O código é o identificador estável do plano (usado em integrações e relatórios).');
  if (changes.trial_days !== undefined) notes.push('Os dias de teste grátis novos valem só para novas assinaturas.');
  return notes;
}
