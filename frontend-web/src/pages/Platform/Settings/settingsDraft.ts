import type { PlanOption } from '../../../services/platform/insightsLookups';
import type { PlatformSettings, PlatformSettingsChanges } from '../../../services/platform/settingsService';
import type { PickerOption } from '../Audit/pickerOptions';

// Rascunho do formulário de Configurações da plataforma: valores em edição, validação com as mesmas regras
// da API (dto/platform-settings.dto.ts e platform-settings.service.ts) e o que mudou (o PATCH leva só isso).

export interface SettingsDraft {
  defaultStore: PickerOption | null;
  /** Texto dos campos numéricos (validado antes de enviar). */
  graceDays: string;
  supportMinutes: string;
  signupEnabled: boolean;
  signupPlanId: number | null;
}

export type SettingsErrors = Partial<Record<'graceDays' | 'supportMinutes' | 'signupPlanId', string>>;

export function draftFrom(settings: PlatformSettings): SettingsDraft {
  const store = settings.default_store;
  return {
    defaultStore: store ? { id: store.id, label: store.name, description: `/${store.slug}` } : null,
    graceDays: String(settings.grace_period_days),
    supportMinutes: String(settings.support_session_minutes),
    signupEnabled: settings.store_self_signup_enabled,
    signupPlanId: settings.self_signup_plan_id,
  };
}

/** Plano que pode receber lojas do autoatendimento: disponível (ACTIVE) e público. */
export function isSignupPlan(plan: Pick<PlanOption, 'status' | 'is_public'> | null | undefined): boolean {
  return !!plan && plan.status === 'ACTIVE' && plan.is_public;
}

function integerInRange(text: string, range: { min: number; max: number }, field: string, unit: string): string | null {
  const value = Number(text.trim());
  if (text.trim() === '' || !Number.isInteger(value)) return `Informe ${field} em ${unit} (número inteiro).`;
  if (value < range.min || value > range.max) return `Use de ${range.min} a ${range.max} ${unit}.`;
  return null;
}

export function validateDraft(draft: SettingsDraft, settings: PlatformSettings, plans: PlanOption[] | null): SettingsErrors {
  const errors: SettingsErrors = {};
  const grace = integerInRange(draft.graceDays, settings.limits.grace_period_days, 'a tolerância', 'dias');
  if (grace) errors.graceDays = grace;
  const minutes = integerInRange(draft.supportMinutes, settings.limits.support_session_minutes, 'a duração', 'minutos');
  if (minutes) errors.supportMinutes = minutes;
  if (draft.signupEnabled) {
    if (draft.signupPlanId === null) {
      errors.signupPlanId = 'Escolha o plano das lojas do autoatendimento para habilitar o cadastro.';
    } else if (plans) {
      const plan = plans.find((item) => item.id === draft.signupPlanId);
      if (plan && !isSignupPlan(plan)) errors.signupPlanId = 'O plano precisa estar disponível para contratação e ser público.';
    }
  }
  return errors;
}

/** Só os campos alterados, no formato do PATCH /platform/settings. */
export function changesFrom(draft: SettingsDraft, settings: PlatformSettings): PlatformSettingsChanges {
  const changes: PlatformSettingsChanges = {};
  const storeId = draft.defaultStore?.id ?? null;
  if (storeId !== settings.default_store_id) changes.default_store_id = storeId;
  const grace = Number(draft.graceDays.trim());
  if (draft.graceDays.trim() !== '' && grace !== settings.grace_period_days) changes.grace_period_days = grace;
  const minutes = Number(draft.supportMinutes.trim());
  if (draft.supportMinutes.trim() !== '' && minutes !== settings.support_session_minutes) changes.support_session_minutes = minutes;
  if (draft.signupEnabled !== settings.store_self_signup_enabled) changes.store_self_signup_enabled = draft.signupEnabled;
  if (draft.signupPlanId !== settings.self_signup_plan_id) changes.self_signup_plan_id = draft.signupPlanId;
  return changes;
}

export interface ChangeSummary {
  field: string;
  from: string;
  to: string;
}

/** Resumo legível das mudanças (para a confirmação antes de salvar). */
export function summarizeChanges(
  changes: PlatformSettingsChanges,
  settings: PlatformSettings,
  draft: SettingsDraft,
  plans: PlanOption[] | null,
): ChangeSummary[] {
  const planName = (id: number | null) => {
    if (id === null) return 'Nenhum';
    const plan = plans?.find((item) => item.id === id) ?? (settings.self_signup_plan?.id === id ? settings.self_signup_plan : null);
    return plan ? plan.name : `Plano #${id}`;
  };
  const summary: ChangeSummary[] = [];
  if (changes.default_store_id !== undefined) {
    summary.push({
      field: 'Loja padrão',
      from: settings.default_store?.name ?? 'Nenhuma',
      to: draft.defaultStore?.label ?? 'Nenhuma (rotas antigas respondem 404)',
    });
  }
  if (changes.grace_period_days !== undefined) {
    summary.push({ field: 'Tolerância da inadimplência', from: `${settings.grace_period_days} dias`, to: `${changes.grace_period_days} dias` });
  }
  if (changes.support_session_minutes !== undefined) {
    summary.push({
      field: 'Duração da sessão de suporte',
      from: `${settings.support_session_minutes} min`,
      to: `${changes.support_session_minutes} min`,
    });
  }
  if (changes.store_self_signup_enabled !== undefined) {
    summary.push({
      field: 'Autoatendimento de lojas',
      from: settings.store_self_signup_enabled ? 'Ligado' : 'Desligado',
      to: changes.store_self_signup_enabled ? 'Ligado' : 'Desligado',
    });
  }
  if (changes.self_signup_plan_id !== undefined) {
    summary.push({ field: 'Plano do autoatendimento', from: planName(settings.self_signup_plan_id), to: planName(changes.self_signup_plan_id) });
  }
  return summary;
}
