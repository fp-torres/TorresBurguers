import api from '../api';
import { asRecord, readBoolean, readDate, readEnum, readId, readNullableText, readNumber, readText, readTextList } from '../panelParsers';
import type { StoreAccountStatus } from '../../types/saas';
import { STORE_ACCOUNT_STATUSES } from './insightsParsers';

// Superpainel › Configurações globais (linha única de platform_settings): GET/PATCH /platform/settings.
// Contrato: backend/src/platform/platform-settings.service.ts e dto/platform-settings.dto.ts.
// O PATCH recebe só o que mudou (auditado: platform.settings.update) e devolve as configurações + warnings.
// E-mail transacional: `mail` no GET (driver e SMTP, sem segredos) e POST /platform/settings/test-email.

export interface SettingsStoreSummary {
  id: number;
  slug: string;
  name: string;
  account_status: StoreAccountStatus;
}

export interface SettingsPlanSummary {
  id: number;
  code: string;
  name: string;
  /** ACTIVE ou INACTIVE. */
  status: string;
  is_public: boolean;
}

export interface NumberRange {
  min: number;
  max: number;
}

/** Drivers de e-mail da API (MAIL_DRIVER): log não envia nada; smtp envia pelo servidor configurado. */
export const MAIL_DRIVERS = ['log', 'smtp'] as const;
export type MailDriver = (typeof MAIL_DRIVERS)[number];

/** E-mail transacional (vem do ambiente da API; nunca traz usuário nem senha do SMTP). */
export interface MailStatus {
  driver: MailDriver;
  /** SMTP_HOST, a porta, MAIL_FROM e as credenciais (quando usadas) estão completos e válidos. */
  smtp_configured: boolean;
  /** Remetente (MAIL_FROM). */
  from: string | null;
  smtp: { host: string; port: number; secure: boolean; auth: boolean } | null;
  /** Avisos de configuração (os mesmos do log da subida da API). */
  issues: string[];
}

/** Resultado de POST /platform/settings/test-email. */
export interface TestEmailResult {
  to: string;
  driver: MailDriver;
  /** O servidor SMTP aceitou a mensagem (sempre false no driver de log). */
  delivered: boolean;
  message_id: string | null;
  /** Motivo do não envio pelo SMTP (sem segredos). */
  error: string | null;
  message: string;
}

export interface PlatformSettings {
  /** Loja padrão das rotas antigas (app mobile e integrações); null = nenhuma (rotas antigas respondem 404). */
  default_store_id: number | null;
  /** Dias de tolerância da inadimplência antes da suspensão automática. */
  grace_period_days: number;
  /** Duração das sessões de suporte (minutos). */
  support_session_minutes: number;
  /** Cadastro de estabelecimentos pela página pública (/cadastrar-loja). */
  store_self_signup_enabled: boolean;
  self_signup_plan_id: number | null;
  default_store: SettingsStoreSummary | null;
  /** DEFAULT_STORE_SLUG do ambiente: quando definido, tem prioridade sobre default_store_id. */
  default_store_env_override: string | null;
  /** Loja padrão que as rotas antigas usam agora (ambiente ou configuração). */
  effective_default_store: SettingsStoreSummary | null;
  self_signup_plan: SettingsPlanSummary | null;
  /** POST /stores/signup aceita cadastros agora (habilitado e com plano ativo e público). */
  self_signup_available: boolean;
  limits: { grace_period_days: NumberRange; support_session_minutes: NumberRange };
  updated_by: { id: number; name: string; email: string } | null;
  updated_at: string | null;
  /** Driver de e-mail ativo e situação do SMTP. */
  mail: MailStatus;
}

/** Campos editáveis (envie só o que mudou). */
export type PlatformSettingsChanges = Partial<Pick<
  PlatformSettings,
  'default_store_id' | 'grace_period_days' | 'support_session_minutes' | 'store_self_signup_enabled' | 'self_signup_plan_id'
>>;

/** Faixas aceitas pela API (backend/src/platform/dto/platform-settings.dto.ts). */
export const DEFAULT_SETTINGS_LIMITS: PlatformSettings['limits'] = {
  grace_period_days: { min: 0, max: 60 },
  support_session_minutes: { min: 5, max: 240 },
};

function parseStore(value: unknown): SettingsStoreSummary | null {
  const raw = asRecord(value);
  const id = readId(raw.id);
  if (!id) return null;
  return {
    id,
    slug: readText(raw.slug),
    name: readText(raw.name) || `Loja #${id}`,
    account_status: readEnum(raw.account_status, STORE_ACCOUNT_STATUSES, 'ACTIVE'),
  };
}

function parsePlan(value: unknown): SettingsPlanSummary | null {
  const raw = asRecord(value);
  const id = readId(raw.id);
  if (!id) return null;
  return {
    id,
    code: readText(raw.code),
    name: readText(raw.name) || readText(raw.code) || `Plano #${id}`,
    status: readText(raw.status),
    is_public: raw.is_public === true,
  };
}

export function parseMailStatus(value: unknown): MailStatus {
  const raw = asRecord(value);
  const smtp = asRecord(raw.smtp);
  const host = readText(smtp.host);
  return {
    driver: readEnum(raw.driver, MAIL_DRIVERS, 'log'),
    smtp_configured: readBoolean(raw.smtp_configured, false),
    from: readNullableText(raw.from),
    smtp: host
      ? { host, port: readNumber(smtp.port, 587), secure: readBoolean(smtp.secure, false), auth: readBoolean(smtp.auth, false) }
      : null,
    issues: readTextList(raw.issues),
  };
}

function parseTestEmailResult(value: unknown): TestEmailResult {
  const raw = asRecord(value);
  return {
    to: readText(raw.to),
    driver: readEnum(raw.driver, MAIL_DRIVERS, 'log'),
    delivered: readBoolean(raw.delivered, false),
    message_id: readNullableText(raw.message_id),
    error: readNullableText(raw.error),
    message: readText(raw.message),
  };
}

function parseRange(value: unknown, fallback: NumberRange): NumberRange {
  const raw = asRecord(value);
  const min = readNumber(raw.min, fallback.min);
  const max = readNumber(raw.max, fallback.max);
  return min <= max ? { min, max } : fallback;
}

export function parsePlatformSettings(value: unknown): PlatformSettings {
  const raw = asRecord(value);
  const limits = asRecord(raw.limits);
  const updatedBy = asRecord(raw.updated_by);
  const updatedById = readId(updatedBy.id);
  return {
    default_store_id: readId(raw.default_store_id) || null,
    grace_period_days: readNumber(raw.grace_period_days, 7),
    support_session_minutes: readNumber(raw.support_session_minutes, 30),
    store_self_signup_enabled: readBoolean(raw.store_self_signup_enabled, false),
    self_signup_plan_id: readId(raw.self_signup_plan_id) || null,
    default_store: parseStore(raw.default_store),
    default_store_env_override: readNullableText(raw.default_store_env_override),
    effective_default_store: parseStore(raw.effective_default_store),
    self_signup_plan: parsePlan(raw.self_signup_plan),
    self_signup_available: readBoolean(raw.self_signup_available, false),
    limits: {
      grace_period_days: parseRange(limits.grace_period_days, DEFAULT_SETTINGS_LIMITS.grace_period_days),
      support_session_minutes: parseRange(limits.support_session_minutes, DEFAULT_SETTINGS_LIMITS.support_session_minutes),
    },
    updated_by: updatedById
      ? { id: updatedById, name: readText(updatedBy.name), email: readText(updatedBy.email) }
      : null,
    updated_at: readDate(raw.updated_at),
    mail: parseMailStatus(raw.mail),
  };
}

export const platformSettingsService = {
  /** GET /platform/settings */
  async get(signal?: AbortSignal): Promise<PlatformSettings> {
    const { data } = await api.get<unknown>('/platform/settings', { signal });
    return parsePlatformSettings(data);
  },

  /** PATCH /platform/settings (só os campos alterados) → configurações atualizadas + avisos. */
  async update(changes: PlatformSettingsChanges): Promise<{ settings: PlatformSettings; warnings: string[] }> {
    const { data } = await api.patch<unknown>('/platform/settings', changes);
    return { settings: parsePlatformSettings(data), warnings: readTextList(asRecord(data).warnings) };
  },

  /**
   * POST /platform/settings/test-email (auditado; limite de envios por operador → 429). Falha do SMTP
   * não é erro HTTP: volta com delivered=false e o motivo em `error`.
   */
  async sendTestEmail(to: string): Promise<TestEmailResult> {
    const { data } = await api.post<unknown>('/platform/settings/test-email', { to });
    return parseTestEmailResult(data);
  },
};
