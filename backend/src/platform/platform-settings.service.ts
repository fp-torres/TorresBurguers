import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { isSuperAdmin, type AuthUser } from '../auth/auth-user';
import { Plan, PlanStatus } from '../billing/entities/plan.entity';
import { envFlag } from '../config/env';
import type { MailDriver, MailStatusView } from '../notifications/mail-config';
import { testMail } from '../notifications/mail-templates';
import { MailService } from '../notifications/mail.service';
import { Store, StoreAccountStatus } from '../store/entities/store.entity';
import { TenantService } from '../tenancy/tenant.service';
import {
  GRACE_PERIOD_DAYS_RANGE,
  SUPPORT_SESSION_MINUTES_RANGE,
  type UpdatePlatformSettingsDto,
} from './dto/platform-settings.dto';
import type { SendTestEmailDto } from './dto/platform-test-email.dto';
import {
  PLATFORM_SETTINGS_ID,
  PlatformSettings,
} from './entities/platform-settings.entity';
import {
  storeSummary,
  userRef,
  type StoreSummary,
  type UserRef,
} from './platform-presenter';

const PLATFORM_ONLY_MESSAGE = 'Área exclusiva da administração da plataforma.';
export const DEFAULT_STORE_NOT_FOUND_MESSAGE =
  'Loja padrão não encontrada: escolha um estabelecimento existente.';
export const DEFAULT_STORE_INACTIVE_MESSAGE =
  'A loja padrão não pode estar desativada. Restaure a loja ou escolha outra.';
export const SIGNUP_PLAN_NOT_FOUND_MESSAGE =
  'Plano do autoatendimento não encontrado.';
export const SIGNUP_PLAN_UNAVAILABLE_MESSAGE =
  'O plano do autoatendimento precisa estar disponível para contratação (ACTIVE) e público.';
export const SIGNUP_PLAN_REQUIRED_MESSAGE =
  'Escolha o plano do autoatendimento (self_signup_plan_id) para habilitar o cadastro de estabelecimentos.';
export const NO_DEFAULT_STORE_WARNING =
  'Sem loja padrão, as rotas antigas sem o endereço da loja (app mobile e integrações da versão de loja única) respondem 404.';
export const TEST_EMAIL_LIMIT_MESSAGE =
  'Muitos e-mails de teste em pouco tempo. Aguarde alguns minutos e tente de novo.';

/**
 * E-mails de teste por operador (memória de cada instância da API, como os demais limites). Sobrescreva
 * com RATE_LIMIT_TEST_EMAIL=limite/segundos; RATE_LIMIT_ENABLED=false desliga.
 */
export const TEST_EMAIL_RATE_LIMIT = Object.freeze({
  limit: 5,
  windowSeconds: 10 * 60,
});

/** Lê RATE_LIMIT_TEST_EMAIL ("limite/segundos", como os demais RATE_LIMIT_*); inválido → padrão. */
export function testEmailRateLimit(env: NodeJS.ProcessEnv = process.env): {
  limit: number;
  windowSeconds: number;
} {
  const match = env.RATE_LIMIT_TEST_EMAIL?.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
  const limit = Number(match?.[1]);
  const windowSeconds = Number(match?.[2]);
  return limit > 0 && windowSeconds > 0
    ? { limit, windowSeconds }
    : { ...TEST_EMAIL_RATE_LIMIT };
}

/** Resposta de POST /platform/settings/test-email (sem usuário nem senha do SMTP). */
export interface TestEmailResult {
  to: string;
  /** Driver que tratou o envio: log (nada sai) ou smtp. */
  driver: MailDriver;
  /** O servidor SMTP aceitou a mensagem? (sempre false no driver de log) */
  delivered: boolean;
  message_id: string | null;
  /** Motivo do não envio pelo SMTP (configuração incompleta ou falha do servidor), sem segredos. */
  error: string | null;
  /** Resumo para o operador. */
  message: string;
}

/** Configurações editáveis (lista de permitidos do PATCH). */
const SETTINGS_FIELDS = [
  'default_store_id',
  'grace_period_days',
  'support_session_minutes',
  'store_self_signup_enabled',
  'self_signup_plan_id',
] as const;

type SettingsField = (typeof SETTINGS_FIELDS)[number];
type SettingsValues = Pick<PlatformSettings, SettingsField>;

/** Valores da migração (linha única criada com estes padrões). */
const DEFAULTS: SettingsValues = {
  default_store_id: null,
  grace_period_days: 7,
  support_session_minutes: 30,
  store_self_signup_enabled: false,
  self_signup_plan_id: null,
};

export interface PlatformSettingsView extends SettingsValues {
  default_store: StoreSummary | null;
  /** DEFAULT_STORE_SLUG do ambiente: quando definido, tem prioridade sobre default_store_id. */
  default_store_env_override: string | null;
  /** Loja padrão que as rotas antigas usam agora (ambiente ou configuração). */
  effective_default_store: StoreSummary | null;
  self_signup_plan: {
    id: number;
    code: string;
    name: string;
    status: PlanStatus;
    is_public: boolean;
  } | null;
  /** POST /stores/signup aceita cadastros agora (habilitado e com plano ativo e público). */
  self_signup_available: boolean;
  limits: {
    grace_period_days: { min: number; max: number };
    support_session_minutes: { min: number; max: number };
  };
  updated_by: UserRef | null;
  updated_at: Date | null;
  /** E-mail transacional: driver ativo e situação do SMTP (vem do ambiente; nunca usuário nem senha). */
  mail: MailStatusView;
}

/** O plano pode receber novas lojas pelo autoatendimento? */
export function isSignupPlan(
  plan: Pick<Plan, 'status' | 'is_public'> | null | undefined,
): boolean {
  return !!plan && plan.status === PlanStatus.ACTIVE && plan.is_public === true;
}

/**
 * Configurações globais (linha única de platform_settings): loja padrão das rotas antigas, tolerância
 * da inadimplência, duração das sessões de suporte e autoatendimento de lojas. Alterações auditadas
 * (platform.settings.update, com o valor antigo e o novo) e com updated_by_user_id.
 */
@Injectable()
export class PlatformSettingsService {
  constructor(
    @InjectRepository(PlatformSettings)
    private readonly settings: Repository<PlatformSettings>,
    @InjectRepository(Store)
    private readonly stores: Repository<Store>,
    @InjectRepository(Plan)
    private readonly plans: Repository<Plan>,
    private readonly tenants: TenantService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  /** Envios de teste recentes por operador (janela deslizante de TEST_EMAIL_RATE_LIMIT). */
  private readonly testEmailSends = new Map<number, number[]>();

  /** GET /platform/settings */
  async get(): Promise<PlatformSettingsView> {
    const [row, effective] = await Promise.all([
      this.settings.findOne({
        where: { id: PLATFORM_SETTINGS_ID },
        relations: {
          default_store: true,
          self_signup_plan: true,
          updated_by: true,
        },
        withDeleted: true,
      }),
      this.tenants.defaultStore(),
    ]);
    const values = this.valuesOf(row);
    const plan = row?.self_signup_plan ?? null;
    return {
      ...values,
      default_store: storeSummary(row?.default_store),
      default_store_env_override:
        process.env.DEFAULT_STORE_SLUG?.trim().toLowerCase() || null,
      effective_default_store: storeSummary(effective),
      self_signup_plan: plan
        ? {
            id: plan.id,
            code: plan.code,
            name: plan.name,
            status: plan.status,
            is_public: plan.is_public,
          }
        : null,
      self_signup_available:
        values.store_self_signup_enabled && isSignupPlan(plan),
      limits: {
        grace_period_days: { ...GRACE_PERIOD_DAYS_RANGE },
        support_session_minutes: { ...SUPPORT_SESSION_MINUTES_RANGE },
      },
      updated_by: userRef(row?.updated_by),
      updated_at: row?.updated_at ?? null,
      mail: this.mail.status(),
    };
  }

  /**
   * POST /platform/settings/test-email: envia um e-mail de teste pelo driver configurado e diz se
   * funcionou. Limitado por operador (429) e auditado (platform.settings.test_email: SUCCESS quando o
   * driver tratou a mensagem, FAILURE quando o SMTP não a aceitou). Falha de envio não é erro HTTP:
   * a resposta traz `delivered: false` e o motivo, sem usuário nem senha do SMTP.
   */
  async sendTestEmail(
    dto: SendTestEmailDto,
    actor: AuthUser,
    request?: Request | null,
  ): Promise<TestEmailResult> {
    if (!isSuperAdmin(actor)) {
      throw new ForbiddenException(PLATFORM_ONLY_MESSAGE);
    }
    this.takeTestEmailSlot(actor.id);

    const result = await this.mail.send(
      testMail({ to: dto.to, operatorName: actor.name, sentAt: new Date() }),
    );
    const error = result.delivered ? null : (result.error ?? null);
    await this.audit.record({
      actor,
      action: 'platform.settings.test_email',
      targetType: 'platform_settings',
      targetId: PLATFORM_SETTINGS_ID,
      result: error ? 'FAILURE' : 'SUCCESS',
      metadata: {
        to: dto.to,
        driver: result.driver,
        delivered: result.delivered,
        ...(error ? { error } : {}),
      },
      request,
    });

    let message: string;
    if (result.delivered) {
      message = `E-mail de teste aceito pelo servidor SMTP para ${dto.to}. Confira a caixa de entrada (e o spam).`;
    } else if (error) {
      message = `O e-mail de teste não foi enviado. ${error}`;
    } else {
      message =
        'Driver de log ativo: nenhum e-mail foi enviado, a mensagem foi só registrada no log da API. Para enviar de verdade, configure MAIL_DRIVER=smtp, SMTP_HOST e MAIL_FROM.';
    }
    return {
      to: dto.to,
      driver: result.driver,
      delivered: result.delivered,
      message_id: result.messageId ?? null,
      error,
      message,
    };
  }

  /**
   * PATCH /platform/settings: valida a loja padrão (existente e não desativada) e o plano do
   * autoatendimento (ACTIVE e público; obrigatório para habilitar). Só grava (e audita) o que mudou.
   */
  async update(
    dto: UpdatePlatformSettingsDto,
    actor: AuthUser,
    request?: Request | null,
  ): Promise<PlatformSettingsView & { warnings: string[] }> {
    if (!isSuperAdmin(actor)) {
      throw new ForbiddenException(PLATFORM_ONLY_MESSAGE);
    }
    const row = await this.settings.findOne({
      where: { id: PLATFORM_SETTINGS_ID },
    });
    const current = this.valuesOf(row);

    const changes: Partial<SettingsValues> = {};
    for (const field of SETTINGS_FIELDS) {
      const value = dto[field];
      if (value !== undefined && value !== current[field]) {
        Object.assign(changes, { [field]: value });
      }
    }
    const next: SettingsValues = { ...current, ...changes };

    if (
      changes.default_store_id !== undefined &&
      changes.default_store_id !== null
    ) {
      await this.assertDefaultStore(changes.default_store_id);
    }
    // O plano é conferido quando muda e sempre que o autoatendimento termina habilitado
    if (next.store_self_signup_enabled && next.self_signup_plan_id === null) {
      throw new BadRequestException(SIGNUP_PLAN_REQUIRED_MESSAGE);
    }
    if (
      next.self_signup_plan_id !== null &&
      (changes.self_signup_plan_id !== undefined ||
        (next.store_self_signup_enabled &&
          changes.store_self_signup_enabled !== undefined))
    ) {
      await this.assertSignupPlan(next.self_signup_plan_id);
    }

    const fields = Object.keys(changes) as SettingsField[];
    if (!fields.length) return { ...(await this.get()), warnings: [] };

    const data = { ...changes, updated_by_user_id: actor.id };
    if (row) {
      await this.settings.update({ id: PLATFORM_SETTINGS_ID }, data);
    } else {
      // Linha única ausente (banco antigo): cria com os padrões da migração
      await this.settings.insert({
        id: PLATFORM_SETTINGS_ID,
        ...DEFAULTS,
        ...data,
      });
    }

    await this.audit.record({
      actor,
      action: 'platform.settings.update',
      targetType: 'platform_settings',
      targetId: PLATFORM_SETTINGS_ID,
      metadata: {
        changes: Object.fromEntries(
          fields.map((field) => [
            field,
            { from: current[field], to: next[field] },
          ]),
        ),
      },
      request,
    });

    const warnings: string[] = [];
    const envSlug = process.env.DEFAULT_STORE_SLUG?.trim();
    if (changes.default_store_id !== undefined) {
      if (envSlug) {
        warnings.push(
          `DEFAULT_STORE_SLUG está definido no ambiente ("${envSlug}") e tem prioridade: a loja padrão das rotas antigas continua sendo a do ambiente.`,
        );
      } else if (changes.default_store_id === null) {
        warnings.push(NO_DEFAULT_STORE_WARNING);
      }
    }
    return { ...(await this.get()), warnings };
  }

  // ---------------------------------------------------------------------------

  /** Conta o envio de teste do operador; 429 quando ele já usou o limite da janela. */
  private takeTestEmailSlot(actorId: number, now = Date.now()): void {
    if (!envFlag('RATE_LIMIT_ENABLED', true)) return;
    const { limit, windowSeconds } = testEmailRateLimit();
    const recent = (this.testEmailSends.get(actorId) ?? []).filter(
      (at) => now - at < windowSeconds * 1000,
    );
    if (recent.length >= limit) {
      this.testEmailSends.set(actorId, recent);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: TEST_EMAIL_LIMIT_MESSAGE,
          error: 'Too Many Requests',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recent.push(now);
    this.testEmailSends.set(actorId, recent);
  }

  private valuesOf(row: PlatformSettings | null): SettingsValues {
    if (!row) return { ...DEFAULTS };
    return {
      default_store_id: row.default_store_id ?? null,
      grace_period_days: row.grace_period_days,
      support_session_minutes: row.support_session_minutes,
      store_self_signup_enabled: row.store_self_signup_enabled === true,
      self_signup_plan_id: row.self_signup_plan_id ?? null,
    };
  }

  private async assertDefaultStore(storeId: number): Promise<void> {
    const store = await this.stores.findOne({
      where: { id: storeId },
      select: { id: true, account_status: true },
    });
    if (!store) throw new BadRequestException(DEFAULT_STORE_NOT_FOUND_MESSAGE);
    if (store.account_status === StoreAccountStatus.INACTIVE) {
      throw new BadRequestException(DEFAULT_STORE_INACTIVE_MESSAGE);
    }
  }

  private async assertSignupPlan(planId: number): Promise<void> {
    const plan = await this.plans.findOne({
      where: { id: planId },
      select: { id: true, status: true, is_public: true },
    });
    if (!plan) throw new BadRequestException(SIGNUP_PLAN_NOT_FOUND_MESSAGE);
    if (!isSignupPlan(plan)) {
      throw new BadRequestException(SIGNUP_PLAN_UNAVAILABLE_MESSAGE);
    }
  }
}
