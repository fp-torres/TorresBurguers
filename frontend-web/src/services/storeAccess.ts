import { isRecord, readBoolean, readNullableText } from './panelParsers';

// Situação da loja e recursos do plano, como vêm em GET /store/settings e GET /store/subscription
// (docs/saas/arquitetura.md §4.2 e §6).

/** Situação efetiva da loja (storeAccessState no backend). */
export type StoreAvailability =
  | 'OPERATIONAL'
  | 'PAST_DUE'
  | 'SUSPENDED'
  | 'SUBSCRIPTION_SUSPENDED'
  | 'SUBSCRIPTION_CANCELED'
  | 'NO_SUBSCRIPTION'
  | 'INACTIVE';

export const STORE_AVAILABILITIES: readonly StoreAvailability[] = [
  'OPERATIONAL', 'PAST_DUE', 'SUSPENDED', 'SUBSCRIPTION_SUSPENDED', 'SUBSCRIPTION_CANCELED', 'NO_SUBSCRIPTION', 'INACTIVE',
];

/** O que a loja pode fazer agora (vender, alterar, cobrança...) e o aviso para a equipe. */
export interface StoreAccess {
  availability: StoreAvailability;
  /** Aceita pedidos e pagamentos novos pela vitrine. */
  canSell: boolean;
  canRead: boolean;
  /** Andar com os pedidos que já existem. */
  canOperate: boolean;
  /** Alterar cardápio, equipe, configurações e abrir a loja. */
  canManage: boolean;
  canManageBilling: boolean;
  publicVisible: boolean;
  /** Aviso para a equipe (null quando está tudo em ordem). */
  message: string | null;
}

/** Situações em que a loja não vende (bloqueio). PAST_DUE ainda vende, com aviso. */
export function isBlockedAvailability(availability: StoreAvailability): boolean {
  return availability !== 'OPERATIONAL' && availability !== 'PAST_DUE';
}

/** Situações resolvidas pela assinatura (o Administrador regulariza em /subscription); as demais, com o suporte. */
const BILLING_AVAILABILITIES: readonly StoreAvailability[] = ['PAST_DUE', 'SUBSCRIPTION_SUSPENDED', 'SUBSCRIPTION_CANCELED', 'NO_SUBSCRIPTION'];

export function isBillingAvailability(availability: StoreAvailability): boolean {
  return BILLING_AVAILABILITIES.includes(availability);
}

export function toStoreAccess(value: unknown): StoreAccess | null {
  if (!isRecord(value)) return null;
  const canSell = readBoolean(value.canSell, true);
  const canManage = readBoolean(value.canManage, true);
  const known = STORE_AVAILABILITIES.find((item) => item === value.availability);
  // Situação desconhecida: deduz pelo que a loja pode fazer (a API continua decidindo o acesso)
  const availability: StoreAvailability = known ?? (canSell && canManage ? 'OPERATIONAL' : 'SUSPENDED');
  return {
    availability,
    canSell,
    canRead: readBoolean(value.canRead, true),
    canOperate: readBoolean(value.canOperate, true),
    canManage,
    canManageBilling: readBoolean(value.canManageBilling, true),
    publicVisible: readBoolean(value.publicVisible, true),
    message: readNullableText(value.message),
  };
}

// --- RECURSOS DO PLANO ---

export const PLAN_FEATURE_KEYS = ['online_payments', 'advanced_reports', 'custom_branding'] as const;
export type PlanFeatureKey = (typeof PLAN_FEATURE_KEYS)[number];
export type StoreFeatures = Record<PlanFeatureKey, boolean>;

/** Nome de cada recurso (mesmos textos das mensagens da API). */
export const PLAN_FEATURE_LABELS: Record<PlanFeatureKey, string> = {
  online_payments: 'Pagamentos online (PIX e cartão)',
  advanced_reports: 'Relatórios e gráficos',
  custom_branding: 'Identidade visual própria (logo e cor)',
};

/** Recursos com true/false explícito (chave ausente = não incluído no plano). */
export function toFeatures(value: unknown): StoreFeatures {
  const raw = isRecord(value) ? value : {};
  return {
    online_payments: raw.online_payments === true,
    advanced_reports: raw.advanced_reports === true,
    custom_branding: raw.custom_branding === true,
  };
}
