import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import {
  EntityManager,
  In,
  LessThan,
  MoreThanOrEqual,
  Not,
  Repository,
} from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { sanitizeForAudit } from '../audit/audit-sanitize';
import { isSuperAdmin, type AuthUser } from '../auth/auth-user';
import { isUniqueViolation } from '../common/database-errors';
import {
  PLATFORM_SETTINGS_ID,
  PlatformSettings,
} from '../platform/entities/platform-settings.entity';
import { Store } from '../store/entities/store.entity';
import type { TenantContext } from '../tenancy/tenant-context';
import { STORE_NOT_FOUND_MESSAGE } from '../tenancy/tenant.service';
import { auditScopeOf, SYSTEM_ACTOR, type BillingActor } from './billing-actor';
import { CANCEL_REASON_REQUIRED_MESSAGE } from './dto/subscription.dto';
import { Plan, PlanStatus } from './entities/plan.entity';
import { SubscriptionEvent } from './entities/subscription-event.entity';
import {
  InvoiceStatus,
  SubscriptionInvoice,
} from './entities/subscription-invoice.entity';
import { tryAdvisoryXactLock } from './advisory-lock';
import {
  Subscription,
  SubscriptionStatus,
  type BillingProviderCode,
  type CancelScheduleSource,
} from './entities/subscription.entity';
import { PlanLimitsService } from './plan-limits.service';
import { describeProviderError } from './providers/billing-provider';
import { BillingProvidersService } from './providers/billing-providers.service';
import {
  assertTransition,
  canDowngrade,
  describeViolations,
  graceEnd,
  isPaidPlan,
  isPlatformSuspension,
  periodFrom,
  SubscriptionEventType,
  trialEnd,
  UNPAID_INVOICE_STATUSES,
  type BillingPeriod,
} from './subscription-rules';

export const SUBSCRIPTION_NOT_FOUND_MESSAGE = 'Assinatura não encontrada.';
export const INVOICE_NOT_FOUND_MESSAGE = 'Fatura não encontrada.';
export const PLAN_NOT_FOUND_FOR_SUBSCRIPTION_MESSAGE = 'Plano não encontrado.';
export const SUBSCRIPTION_EXISTS_MESSAGE =
  'A loja já tem uma assinatura vigente. Mude o plano ou cancele a assinatura atual antes de criar outra.';
export const NO_CURRENT_SUBSCRIPTION_MESSAGE =
  'A loja não tem uma assinatura vigente. Fale com a administração da plataforma.';
export const PLAN_UNAVAILABLE_MESSAGE =
  'Este plano não está disponível para novas contratações.';
export const SAME_PLAN_MESSAGE = 'A assinatura já está neste plano.';
export const SUBSCRIPTION_CANCELED_MESSAGE =
  'A assinatura está cancelada e não pode mais ser alterada. Uma nova contratação cria outra assinatura.';
export const NOTHING_TO_RESUME_MESSAGE =
  'Não há cancelamento agendado para desfazer.';
export const PERIOD_ALREADY_ENDED_MESSAGE =
  'O período da assinatura já terminou: o cancelamento não pode mais ser desfeito.';
export const REACTIVATE_ONLY_BLOCKED_MESSAGE =
  'Só assinaturas suspensas ou com pagamento em atraso podem ser reativadas.';
export const OVERDUE_INVOICES_MESSAGE =
  'Há faturas vencidas em aberto. Registre o pagamento ou reative com force e um motivo.';
export const FORCE_REASON_REQUIRED_MESSAGE =
  'Informe o motivo para reativar sem o pagamento das faturas vencidas.';
export const FREE_PLAN_INVOICE_MESSAGE =
  'O plano desta assinatura é gratuito: informe o valor da fatura.';
export const INVOICE_PERIOD_REQUIRED_MESSAGE =
  'Informe o início e o fim do período da fatura (period_start e period_end).';
export const INVOICE_PERIOD_INVALID_MESSAGE =
  'O fim do período da fatura deve ser depois do início.';
export const INVOICE_PERIOD_EXISTS_MESSAGE =
  'Já existe uma fatura para este período.';
export const INVOICE_VOID_MESSAGE =
  'Esta fatura foi anulada e não pode mais ser paga nem recusada.';
export const INVOICE_ALREADY_PAID_MESSAGE = 'Esta fatura já foi paga.';
export const PAID_AT_IN_FUTURE_MESSAGE =
  'A data do pagamento (paid_at) não pode estar no futuro.';
/** Folga para relógios levemente adiantados no registro manual do pagamento. */
export const PAID_AT_CLOCK_SKEW_MS = 5 * 60_000;
export const INVOICE_PAID_VOID_MESSAGE =
  'Fatura paga não pode ser anulada (estorno não é feito pela plataforma).';
export const PROVIDER_PAYMENT_USED_MESSAGE =
  'Este pagamento já foi usado para quitar outra fatura.';
export const PAID_WITH_OTHER_PAYMENT_MESSAGE =
  'Esta fatura já foi paga com outro pagamento.';
export const FREE_PLAN_CHECKOUT_MESSAGE =
  'O plano atual é gratuito: não há cobrança a pagar.';
export const CHECKOUT_ALREADY_AUTHORIZED_MESSAGE =
  'A cobrança automática desta assinatura já está ativa no provedor de pagamento.';
export const PAYER_EMAIL_REQUIRED_MESSAGE =
  'Informe o e-mail da conta que vai pagar a assinatura.';
export const PLATFORM_ONLY_MESSAGE =
  'Área exclusiva da administração da plataforma.';
export const CONCURRENT_CHANGE_MESSAGE =
  'A assinatura mudou durante a operação. Atualize a página e tente de novo.';
export const CHECKOUT_IN_PROGRESS_MESSAGE =
  'O link de pagamento desta assinatura já está sendo gerado. Aguarde alguns segundos e tente de novo.';
/**
 * Checkout com a trava da loja ocupada (outro checkout falando com o provedor): novas tentativas, cada
 * uma numa transação curta, com a espera FORA da transação (sem segurar conexão do pool). ~3 s no total.
 */
export const CHECKOUT_LOCK_ATTEMPTS = 12;
export const CHECKOUT_LOCK_RETRY_MS = 250;
export const PLATFORM_SUSPENSION_CHECKOUT_MESSAGE =
  'A assinatura foi suspensa pela administração da plataforma. Fale com o suporte para regularizar.';
export const IMMEDIATE_CANCEL_OWNER_ONLY_MESSAGE =
  'Sem período pago a terminar, o cancelamento é imediato e não pode ser desfeito: só o responsável pela loja pode fazê-lo.';
export const CANCEL_SCHEDULED_BY_PLATFORM_MESSAGE =
  'O cancelamento da assinatura foi agendado pela administração da plataforma. Fale com o suporte para mantê-la.';
export { CANCEL_REASON_REQUIRED_MESSAGE };

/** Tolerância padrão (dias) quando platform_settings não tem o valor. */
export const DEFAULT_GRACE_PERIOD_DAYS = 7;

type SubscriptionPatch = Partial<
  Pick<
    Subscription,
    | 'status'
    | 'plan_id'
    | 'trial_ends_at'
    | 'current_period_start'
    | 'current_period_end'
    | 'cancel_at_period_end'
    | 'cancel_scheduled_by'
    | 'canceled_at'
    | 'past_due_since'
    | 'grace_period_ends_at'
    | 'suspended_at'
    | 'suspended_by'
    | 'billing_provider'
    | 'provider_subscription_id'
    | 'provider_status'
    | 'provider_checkout_url'
  >
>;

/** Repositórios de uma transação (ou do manager de quem chamou). */
interface BillingTx {
  manager: EntityManager;
  subscriptions: Repository<Subscription>;
  invoices: Repository<SubscriptionInvoice>;
  events: Repository<SubscriptionEvent>;
  plans: Repository<Plan>;
  stores: Repository<Store>;
}

function txOf(manager: EntityManager): BillingTx {
  return {
    manager,
    subscriptions: manager.getRepository(Subscription),
    invoices: manager.getRepository(SubscriptionInvoice),
    events: manager.getRepository(SubscriptionEvent),
    plans: manager.getRepository(Plan),
    stores: manager.getRepository(Store),
  };
}

interface EventFields {
  from_status?: SubscriptionStatus | null;
  to_status?: SubscriptionStatus | null;
  from_plan_id?: number | null;
  to_plan_id?: number | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CreateSubscriptionOptions {
  /** Quem contratou (superadmin, a própria loja no autoatendimento) ou null (sistema). */
  actor?: AuthUser | null;
  request?: Request | null;
  /** Padrão: MANUAL (o checkout online troca para o provedor quando a loja autoriza). */
  provider?: BillingProviderCode;
  /** Plano INACTIVE (interno/negociado): só vale quando o ator é superadmin. */
  allowInactivePlan?: boolean;
  reason?: string | null;
  /**
   * Manager de uma transação aberta por quem chama (ex.: criação da loja + assinatura juntas).
   * Nesse caso quem chama audita a operação (a auditoria não participa da transação).
   */
  manager?: EntityManager;
  now?: Date;
}

/** Ação do superpainel/loja com o "agora" injetável (testes e rotina). */
export type BillingContext = BillingActor & { now?: Date };

export interface StatusChange {
  from: SubscriptionStatus;
  to: SubscriptionStatus;
}

export type LifecycleStepResult =
  | 'activated'
  | 'canceled'
  | 'renewed'
  | 'past_due'
  | 'suspended'
  | 'restored'
  | 'provider_canceled'
  | null;

/**
 * Nova tentativa de interromper no provedor a cobrança de uma assinatura cancelada: intervalo de
 * 1 h, 2 h, 4 h... (dobra a cada falha registrada) até 24 h entre as tentativas.
 */
export const PROVIDER_CANCEL_RETRY_BASE_MS = 60 * 60_000;
export const PROVIDER_CANCEL_RETRY_MAX_MS = 24 * 60 * 60_000;
/** Falhas consideradas no intervalo (as mais recentes). */
const PROVIDER_CANCEL_RETRY_WINDOW = 10;

export type ProviderPaymentResult =
  | 'paid'
  | 'duplicate'
  | 'amount_mismatch'
  | 'subscription_canceled'
  | 'free_plan';

const reasonText = (reason?: string | null) =>
  reason?.trim() ? reason.trim().slice(0, 300) : null;

/**
 * Assinaturas SaaS (loja → plataforma): contratação, troca de plano, cancelamento, suspensão,
 * reativação, faturas e pagamentos. Toda mudança roda em transação com a assinatura travada
 * (FOR UPDATE), valida a transição (subscription-rules), grava o histórico (subscription_events) e é
 * auditada. Escritas sempre por critério composto ({ id, store_id, ... }) conferindo affected.
 *
 * Sem proporcionalidade (proration): a troca de plano vale na hora e o preço novo entra na próxima
 * fatura; cancelamento não gera reembolso.
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(SubscriptionInvoice)
    private readonly invoices: Repository<SubscriptionInvoice>,
    @InjectRepository(SubscriptionEvent)
    private readonly events: Repository<SubscriptionEvent>,
    @InjectRepository(PlatformSettings)
    private readonly settings: Repository<PlatformSettings>,
    private readonly planLimits: PlanLimitsService,
    private readonly providers: BillingProvidersService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Consultas simples
  // ---------------------------------------------------------------------------

  /** Assinatura vigente (não cancelada) da loja, com o plano, ou null. */
  currentForStore(storeId: number): Promise<Subscription | null> {
    return this.subscriptions.findOne({
      where: { store_id: storeId, status: Not(SubscriptionStatus.CANCELED) },
      relations: { plan: true },
      order: { id: 'DESC' },
    });
  }

  /** Dias de tolerância da inadimplência (platform_settings.grace_period_days). */
  async graceDays(): Promise<number> {
    const settings = await this.settings.findOne({
      where: { id: PLATFORM_SETTINGS_ID },
      select: { id: true, grace_period_days: true },
    });
    const days = Number(settings?.grace_period_days);
    return Number.isInteger(days) && days >= 0
      ? Math.min(days, 365)
      : DEFAULT_GRACE_PERIOD_DAYS;
  }

  // ---------------------------------------------------------------------------
  // Contratação
  // ---------------------------------------------------------------------------

  /**
   * Cria a assinatura da loja (que não pode ter outra não cancelada → 409):
   * - plano com teste grátis → TRIALING até trial_ends_at (o período atual é o teste);
   * - plano gratuito → ACTIVE sem vencimento (current_period_end nulo);
   * - plano pago → ACTIVE com o período atual e uma fatura OPEN dele (vencimento = início).
   */
  async createForStore(
    storeId: number,
    planId: number,
    options: CreateSubscriptionOptions = {},
  ): Promise<Subscription> {
    const actor = options.actor ?? null;
    const now = options.now ?? new Date();
    const provider = options.provider ?? 'MANUAL';
    const allowInactive =
      options.allowInactivePlan === true && isSuperAdmin(actor);
    const ctx: BillingContext = { user: actor, request: options.request, now };

    const created = await this.run(async (tx) => {
      const store = await tx.stores.findOne({
        where: { id: storeId },
        select: { id: true, slug: true, name: true },
      });
      if (!store) throw new NotFoundException(STORE_NOT_FOUND_MESSAGE);
      const plan = await this.loadPlan(tx, planId);
      this.assertPlanAvailable(plan, allowInactive);

      const current = await tx.subscriptions.findOne({
        where: { store_id: storeId, status: Not(SubscriptionStatus.CANCELED) },
        select: { id: true },
      });
      if (current) throw new ConflictException(SUBSCRIPTION_EXISTS_MESSAGE);

      let fields: SubscriptionPatch;
      let firstPeriod: BillingPeriod | null = null;
      if (plan.trial_days > 0) {
        const trialEndsAt = trialEnd(now, plan.trial_days);
        fields = {
          status: SubscriptionStatus.TRIALING,
          trial_ends_at: trialEndsAt,
          current_period_start: now,
          current_period_end: trialEndsAt,
        };
      } else if (!isPaidPlan(plan)) {
        fields = {
          status: SubscriptionStatus.ACTIVE,
          trial_ends_at: null,
          current_period_start: now,
          current_period_end: null,
        };
      } else {
        firstPeriod = periodFrom(now, plan.billing_interval);
        fields = {
          status: SubscriptionStatus.ACTIVE,
          trial_ends_at: null,
          current_period_start: firstPeriod.start,
          current_period_end: firstPeriod.end,
        };
      }

      let subscription: Subscription;
      try {
        subscription = await tx.subscriptions.save(
          tx.subscriptions.create({
            store_id: storeId,
            plan_id: plan.id,
            cancel_at_period_end: false,
            canceled_at: null,
            past_due_since: null,
            grace_period_ends_at: null,
            suspended_at: null,
            suspended_by: null,
            billing_provider: provider,
            provider_subscription_id: null,
            provider_status: null,
            provider_checkout_url: null,
            ...fields,
          }),
        );
      } catch (error) {
        // Índice parcial: uma assinatura não cancelada por loja (corrida entre duas contratações)
        if (isUniqueViolation(error)) {
          throw new ConflictException(SUBSCRIPTION_EXISTS_MESSAGE);
        }
        throw error;
      }

      await this.recordEvent(
        tx,
        subscription,
        SubscriptionEventType.CREATED,
        {
          to_status: subscription.status,
          to_plan_id: plan.id,
          reason: reasonText(options.reason),
          metadata: {
            provider,
            price: Number(plan.price),
            billing_interval: plan.billing_interval,
            trial_days: plan.trial_days,
          },
        },
        actor,
      );
      const invoice = firstPeriod
        ? await this.createInvoiceRow(
            tx,
            subscription,
            plan,
            {
              amount: Number(plan.price),
              period: firstPeriod,
              dueAt: firstPeriod.start,
            },
            ctx,
            'subscription.create',
          )
        : null;
      subscription.plan = plan;
      return { subscription, plan, invoice, store };
    }, options.manager);

    if (!options.manager) {
      await this.audit.record({
        actor,
        scope: auditScopeOf(ctx),
        storeId,
        action: 'subscription.create',
        targetType: 'subscription',
        targetId: created.subscription.id,
        metadata: {
          plan_id: created.plan.id,
          plan_code: created.plan.code,
          status: created.subscription.status,
          provider,
          invoice_id: created.invoice?.id ?? null,
        },
        request: options.request,
      });
    }
    return created.subscription;
  }

  // ---------------------------------------------------------------------------
  // Troca de plano
  // ---------------------------------------------------------------------------

  /**
   * Upgrade/downgrade imediato, sem proporcionalidade: o período atual continua e o preço novo vale
   * a partir da próxima fatura. Downgrade só se o uso atual couber no plano novo (409 com a lista do
   * que excede). Assinatura sem período (gratuita) que vai para um plano pago começa um período agora,
   * com fatura. No teste grátis, o teste segue até a data original e o plano novo vale no fim dele.
   */
  async changePlan(
    subscriptionId: number,
    planId: number,
    options: BillingContext & {
      reason?: string | null;
      allowInactivePlan?: boolean;
    },
  ): Promise<Subscription> {
    this.assertPlatformOperator(options.user);
    const now = options.now ?? new Date();
    const allowInactive =
      options.allowInactivePlan === true && isSuperAdmin(options.user);
    const preview = await this.findPreview(subscriptionId);
    // Contagens (equipe, produtos, pedidos do mês) e armazenamento lidos antes da transação: o limite é
    // conferido de novo a cada novo cadastro (PlanLimitsService) e a cada imagem gravada (OptimizeImagePipe)
    const usage = await this.planLimits.usage(preview.store_id, now);
    const storage = await this.planLimits.storageUsage(preview.store_id);

    const outcome = await this.run(async (tx) => {
      const subscription = await this.lockSubscription(tx, {
        id: subscriptionId,
        store_id: preview.store_id,
      });
      if (subscription.status === SubscriptionStatus.CANCELED) {
        throw new ConflictException(SUBSCRIPTION_CANCELED_MESSAGE);
      }
      if (subscription.plan_id === planId) {
        throw new BadRequestException(SAME_PLAN_MESSAGE);
      }
      const from = await this.loadPlan(tx, subscription.plan_id);
      const to = await this.loadPlan(tx, planId);
      this.assertPlanAvailable(to, allowInactive);

      const violations = canDowngrade(usage, to, storage?.bytes ?? null);
      if (violations.length) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: `O uso atual da loja não cabe no plano ${to.name}: ${describeViolations(violations)}. Reduza o uso antes de mudar de plano.`,
          violations,
        });
      }

      const changes: SubscriptionPatch = { plan_id: to.id };
      // Link de pagamento ainda não autorizado ficou com o valor antigo: o próximo checkout cria outro
      if (
        subscription.billing_provider === 'MERCADO_PAGO' &&
        subscription.provider_status !== 'authorized'
      ) {
        changes.provider_checkout_url = null;
      }
      const startsPeriod =
        subscription.status !== SubscriptionStatus.TRIALING &&
        isPaidPlan(to) &&
        subscription.current_period_end === null;
      const period = startsPeriod ? periodFrom(now, to.billing_interval) : null;
      if (period) {
        changes.current_period_start = period.start;
        changes.current_period_end = period.end;
      }

      await this.applyChanges(tx, subscription, changes);
      await this.recordEvent(
        tx,
        subscription,
        SubscriptionEventType.PLAN_CHANGED,
        {
          from_plan_id: from.id,
          to_plan_id: to.id,
          reason: reasonText(options.reason),
          metadata: {
            from_price: Number(from.price),
            to_price: Number(to.price),
            from_interval: from.billing_interval,
            to_interval: to.billing_interval,
            proration: false,
          },
        },
        options.user,
      );
      const invoice = period
        ? await this.createInvoiceRow(
            tx,
            subscription,
            to,
            { amount: Number(to.price), period, dueAt: now },
            { ...options, now },
            'subscription.change_plan',
          )
        : null;
      subscription.plan = to;
      return { subscription, from, to, invoice };
    });

    await this.audit.record({
      actor: options.user,
      scope: auditScopeOf(options),
      storeId: outcome.subscription.store_id,
      action: 'subscription.change_plan',
      targetType: 'subscription',
      targetId: subscriptionId,
      metadata: {
        from_plan_id: outcome.from.id,
        to_plan_id: outcome.to.id,
        invoice_id: outcome.invoice?.id ?? null,
        reason: reasonText(options.reason),
      },
      request: options.request,
    });
    await this.syncProviderPlan(
      outcome.subscription,
      outcome.from,
      outcome.to,
      options,
    );
    return outcome.subscription;
  }

  // ---------------------------------------------------------------------------
  // Cancelamento
  // ---------------------------------------------------------------------------

  /**
   * Cancela agora ou agenda para o fim do período pago (a loja usa até lá). Sem período a vencer
   * (plano gratuito/interno) o cancelamento é imediato. A cobrança recorrente no provedor é
   * interrompida na hora (o período atual já foi cobrado). Com storeId, só acha assinatura da loja
   * (404 uniforme para as demais).
   */
  async cancel(
    subscriptionId: number,
    options: BillingContext & {
      atPeriodEnd: boolean;
      reason?: string | null;
      storeId?: number;
      /**
       * Pela loja: responsável (stores.owner_user_id). Com ele definido, o cancelamento IMEDIATO
       * (irreversível: sem período a vencer) é só dele; outro ADMIN → 403. O agendamento segue livre.
       */
      storeOwnerId?: number | null;
    },
  ): Promise<{ subscription: Subscription; scheduled: boolean }> {
    if (options.storeId === undefined)
      this.assertPlatformOperator(options.user);
    const now = options.now ?? new Date();
    const origin: CancelScheduleSource =
      options.storeId === undefined ? 'PLATFORM' : 'STORE';
    const outcome = await this.run(async (tx) => {
      const subscription = await this.lockSubscription(
        tx,
        this.scope(subscriptionId, options.storeId),
      );
      if (subscription.status === SubscriptionStatus.CANCELED) {
        throw new ConflictException(SUBSCRIPTION_CANCELED_MESSAGE);
      }
      const periodEnd = subscription.current_period_end;
      if (
        options.atPeriodEnd &&
        periodEnd !== null &&
        periodEnd.getTime() > now.getTime()
      ) {
        if (subscription.cancel_at_period_end) {
          // Agendado pela loja e confirmado pela plataforma: passa a ser decisão da plataforma (a loja
          // deixa de poder desfazê-lo); nos demais casos, repetir não muda nada
          if (
            origin !== 'PLATFORM' ||
            subscription.cancel_scheduled_by === 'PLATFORM'
          ) {
            return { subscription, scheduled: true, changed: false };
          }
        }
        const previousOrigin = subscription.cancel_at_period_end
          ? (subscription.cancel_scheduled_by ?? null)
          : undefined;
        await this.applyChanges(tx, subscription, {
          cancel_at_period_end: true,
          cancel_scheduled_by: origin,
        });
        await this.recordEvent(
          tx,
          subscription,
          SubscriptionEventType.CANCEL_SCHEDULED,
          {
            reason: reasonText(options.reason),
            metadata: {
              cancel_at: periodEnd,
              scheduled_by: origin,
              ...(previousOrigin !== undefined
                ? { from_scheduled_by: previousOrigin }
                : {}),
            },
          },
          options.user,
        );
        return { subscription, scheduled: true, changed: true };
      }
      // Cancelamento imediato pela plataforma (inclusive "no fim do período" sem período a vencer):
      // a loja deixa de vender e faturas futuras são anuladas, então o motivo é obrigatório
      if (options.storeId === undefined && !reasonText(options.reason)) {
        throw new BadRequestException(CANCEL_REASON_REQUIRED_MESSAGE);
      }
      // Pela loja, imediato = irreversível (o resume não desfaz CANCELED): só o responsável
      if (
        options.storeId !== undefined &&
        options.storeOwnerId !== undefined &&
        options.storeOwnerId !== null &&
        options.storeOwnerId !== options.user?.id
      ) {
        throw new ForbiddenException(IMMEDIATE_CANCEL_OWNER_ONLY_MESSAGE);
      }
      await this.finalizeCancel(tx, subscription, now, {
        ...options,
        reason: reasonText(options.reason),
        trigger: options.atPeriodEnd ? 'cancel.no_period' : 'cancel.now',
      });
      return { subscription, scheduled: false, changed: true };
    });

    if (outcome.changed) {
      await this.audit.record({
        actor: options.user,
        scope: auditScopeOf(options),
        storeId: outcome.subscription.store_id,
        action: outcome.scheduled
          ? 'subscription.cancel_scheduled'
          : 'subscription.cancel',
        targetType: 'subscription',
        targetId: subscriptionId,
        metadata: {
          at_period_end: outcome.scheduled,
          cancel_at: outcome.scheduled
            ? outcome.subscription.current_period_end
            : null,
          ...(outcome.scheduled ? { scheduled_by: origin } : {}),
          reason: reasonText(options.reason),
        },
        request: options.request,
      });
      await this.syncProviderCancellation(outcome.subscription, options);
    }
    return { subscription: outcome.subscription, scheduled: outcome.scheduled };
  }

  /** Desfaz o cancelamento agendado enquanto o período ainda não terminou. */
  async resume(
    subscriptionId: number,
    options: BillingContext & { storeId?: number },
  ): Promise<Subscription> {
    if (options.storeId === undefined)
      this.assertPlatformOperator(options.user);
    const now = options.now ?? new Date();
    const subscription = await this.run(async (tx) => {
      const found = await this.lockSubscription(
        tx,
        this.scope(subscriptionId, options.storeId),
      );
      if (found.status === SubscriptionStatus.CANCELED) {
        throw new ConflictException(SUBSCRIPTION_CANCELED_MESSAGE);
      }
      if (!found.cancel_at_period_end) {
        throw new ConflictException(NOTHING_TO_RESUME_MESSAGE);
      }
      if (
        found.current_period_end !== null &&
        found.current_period_end.getTime() <= now.getTime()
      ) {
        throw new ConflictException(PERIOD_ALREADY_ENDED_MESSAGE);
      }
      // Encerramento decidido pela plataforma: a loja não desfaz (como a suspensão da plataforma)
      if (
        options.storeId !== undefined &&
        found.cancel_scheduled_by === 'PLATFORM'
      ) {
        throw new ConflictException(CANCEL_SCHEDULED_BY_PLATFORM_MESSAGE);
      }
      await this.applyChanges(tx, found, {
        cancel_at_period_end: false,
        cancel_scheduled_by: null,
      });
      await this.recordEvent(
        tx,
        found,
        SubscriptionEventType.CANCEL_REVERTED,
        {},
        options.user,
      );
      return found;
    });

    await this.audit.record({
      actor: options.user,
      scope: auditScopeOf(options),
      storeId: subscription.store_id,
      action: 'subscription.resume',
      targetType: 'subscription',
      targetId: subscriptionId,
      metadata: {
        // A cobrança recorrente foi interrompida no agendamento: a loja autoriza de novo no checkout
        provider_status: subscription.provider_status ?? null,
      },
      request: options.request,
    });
    return subscription;
  }

  // ---------------------------------------------------------------------------
  // Suspensão e reativação (superpainel)
  // ---------------------------------------------------------------------------

  async suspend(
    subscriptionId: number,
    options: BillingContext & { reason: string },
  ): Promise<Subscription> {
    this.assertPlatformOperator(options.user);
    const now = options.now ?? new Date();
    const reason = reasonText(options.reason);
    const outcome = await this.run(async (tx) => {
      const subscription = await this.lockSubscription(tx, {
        id: subscriptionId,
      });
      // Já suspensa pela inadimplência (BILLING): a suspensão passa a ser da plataforma (só o superadmin
      // reativa; pagar as faturas vencidas deixa de reativar). Suspensa pela plataforma: 409 como antes.
      if (
        subscription.status === SubscriptionStatus.SUSPENDED &&
        subscription.suspended_by !== 'PLATFORM'
      ) {
        const fromSuspendedBy = subscription.suspended_by ?? 'BILLING';
        await this.applyChanges(tx, subscription, { suspended_by: 'PLATFORM' });
        await this.recordEvent(
          tx,
          subscription,
          SubscriptionEventType.STATUS_CHANGED,
          {
            from_status: SubscriptionStatus.SUSPENDED,
            to_status: SubscriptionStatus.SUSPENDED,
            reason,
            metadata: {
              trigger: 'platform.suspend',
              from_suspended_by: fromSuspendedBy,
            },
          },
          options.user,
        );
        const change: StatusChange = {
          from: SubscriptionStatus.SUSPENDED,
          to: SubscriptionStatus.SUSPENDED,
        };
        return {
          subscription,
          change,
          extra: { from_suspended_by: fromSuspendedBy },
        };
      }
      // suspended_by = PLATFORM: só a reativação pelo superadmin desfaz (um pagamento aprovado, inclusive
      // a cobrança automática ou um checkout novo da loja, quita a fatura mas não reativa)
      const change = await this.changeStatus(
        tx,
        subscription,
        SubscriptionStatus.SUSPENDED,
        { suspended_at: now, suspended_by: 'PLATFORM' },
        { actor: options.user, reason, trigger: 'platform.suspend' },
      );
      return { subscription, change, extra: {} };
    });

    await this.audit.record({
      actor: options.user,
      scope: auditScopeOf(options),
      storeId: outcome.subscription.store_id,
      action: 'subscription.suspend',
      targetType: 'subscription',
      targetId: subscriptionId,
      metadata: { ...outcome.change, ...outcome.extra, reason },
      request: options.request,
    });
    return outcome.subscription;
  }

  /**
   * SUSPENDED/PAST_DUE → ACTIVE. Sem force, só sem fatura vencida em aberto (409). Com force (motivo
   * obrigatório), as faturas vencidas continuam devidas, mas com novo vencimento agora: a rotina volta
   * a contar a tolerância a partir daí. Assinatura suspensa com o período já encerrado começa um
   * período novo (com fatura, se o plano for pago).
   */
  async reactivate(
    subscriptionId: number,
    options: BillingContext & { force?: boolean; reason?: string | null },
  ): Promise<Subscription> {
    this.assertPlatformOperator(options.user);
    const now = options.now ?? new Date();
    const reason = reasonText(options.reason);
    const force = options.force === true;
    if (force && !reason) {
      throw new BadRequestException(FORCE_REASON_REQUIRED_MESSAGE);
    }

    const outcome = await this.run(async (tx) => {
      const subscription = await this.lockSubscription(tx, {
        id: subscriptionId,
      });
      if (
        subscription.status !== SubscriptionStatus.SUSPENDED &&
        subscription.status !== SubscriptionStatus.PAST_DUE
      ) {
        if (subscription.status === SubscriptionStatus.CANCELED) {
          throw new ConflictException(SUBSCRIPTION_CANCELED_MESSAGE);
        }
        // A situação atual (ativa/teste grátis) não permite: 409, como as demais transições inválidas
        throw new ConflictException(REACTIVATE_ONLY_BLOCKED_MESSAGE);
      }
      const overdue = await this.overdueUnpaid(tx, subscription, now);
      if (overdue.length && !force) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: OVERDUE_INVOICES_MESSAGE,
          overdue_invoices: overdue.map((invoice) => invoice.id),
        });
      }
      for (const invoice of overdue) {
        await this.rescheduleInvoice(tx, subscription, invoice, now, {
          actor: options.user,
          reason,
        });
      }

      const wasSuspended = subscription.status === SubscriptionStatus.SUSPENDED;
      const change = await this.changeStatus(
        tx,
        subscription,
        SubscriptionStatus.ACTIVE,
        {
          past_due_since: null,
          grace_period_ends_at: null,
          suspended_at: null,
          suspended_by: null,
        },
        {
          actor: options.user,
          reason,
          trigger: force ? 'platform.reactivate_forced' : 'platform.reactivate',
          metadata: force
            ? { forced: true, rescheduled_invoices: overdue.map((i) => i.id) }
            : null,
        },
      );
      if (wasSuspended) {
        await this.restartPeriodIfEnded(tx, subscription, now, {
          ...options,
          now,
        });
      }
      return { subscription, change, rescheduled: overdue.length };
    });

    await this.audit.record({
      actor: options.user,
      scope: auditScopeOf(options),
      storeId: outcome.subscription.store_id,
      action: 'subscription.reactivate',
      targetType: 'subscription',
      targetId: subscriptionId,
      metadata: {
        ...outcome.change,
        forced: force,
        rescheduled_invoices: outcome.rescheduled,
        reason,
      },
      request: options.request,
    });
    return outcome.subscription;
  }

  // ---------------------------------------------------------------------------
  // Faturas (superpainel)
  // ---------------------------------------------------------------------------

  /**
   * Fatura avulsa da assinatura. Período padrão: o atual (se ainda não tiver fatura) ou o seguinte;
   * no teste grátis, o primeiro período depois do teste; sem período vigente, a partir de agora.
   * Valor padrão: o preço do plano. Vencimento padrão: o início do período (ou agora, se já começou).
   */
  async createInvoice(
    subscriptionId: number,
    input: {
      amount?: number;
      period_start?: Date;
      period_end?: Date;
      due_at?: Date;
      notes?: string | null;
    },
    ctx: BillingContext,
  ): Promise<SubscriptionInvoice> {
    this.assertPlatformOperator(ctx.user);
    const now = ctx.now ?? new Date();
    if (
      (input.period_start === undefined) !==
      (input.period_end === undefined)
    ) {
      throw new BadRequestException(INVOICE_PERIOD_REQUIRED_MESSAGE);
    }
    if (
      input.period_start &&
      input.period_end &&
      input.period_end.getTime() <= input.period_start.getTime()
    ) {
      throw new BadRequestException(INVOICE_PERIOD_INVALID_MESSAGE);
    }

    const invoice = await this.run(async (tx) => {
      const subscription = await this.lockSubscription(tx, {
        id: subscriptionId,
      });
      if (subscription.status === SubscriptionStatus.CANCELED) {
        throw new ConflictException(SUBSCRIPTION_CANCELED_MESSAGE);
      }
      const plan = await this.loadPlan(tx, subscription.plan_id);
      const amount = input.amount ?? Number(plan.price);
      if (!(amount > 0)) {
        throw new BadRequestException(FREE_PLAN_INVOICE_MESSAGE);
      }
      const period =
        input.period_start && input.period_end
          ? { start: input.period_start, end: input.period_end }
          : await this.defaultInvoicePeriod(tx, subscription, plan, now);
      if (await this.invoiceForPeriod(tx, subscription, period.start)) {
        throw new ConflictException(INVOICE_PERIOD_EXISTS_MESSAGE);
      }
      const dueAt =
        input.due_at ??
        new Date(Math.max(period.start.getTime(), now.getTime()));
      return this.createInvoiceRow(
        tx,
        subscription,
        plan,
        { amount, period, dueAt, notes: input.notes ?? null },
        { ...ctx, now },
        'platform.invoice',
      );
    });

    await this.audit.record({
      actor: ctx.user,
      scope: auditScopeOf(ctx),
      storeId: invoice.store_id,
      action: 'subscription.invoice.create',
      targetType: 'subscription_invoice',
      targetId: invoice.id,
      metadata: {
        subscription_id: subscriptionId,
        amount: invoice.amount,
        period_start: invoice.period_start,
        period_end: invoice.period_end,
        due_at: invoice.due_at,
      },
      request: ctx.request,
    });
    return invoice;
  }

  /**
   * Registra o pagamento da fatura (idempotente: fatura já paga é devolvida como está). O mesmo
   * provider_payment_id nunca quita duas faturas. Pagamento confirmado: fatura do período seguinte
   * já iniciado avança o período; sem outra fatura vencida em aberto, PAST_DUE/SUSPENDED → ACTIVE
   * (limpa atraso, tolerância e suspensão).
   */
  async markInvoicePaid(
    invoiceId: number,
    input: {
      paidAt?: Date;
      paymentMethod?: string | null;
      providerPaymentId?: string | null;
      notes?: string | null;
    },
    ctx: BillingContext,
  ): Promise<SubscriptionInvoice> {
    this.assertPlatformOperator(ctx.user);
    const now = ctx.now ?? new Date();
    if (
      input.paidAt &&
      input.paidAt.getTime() > now.getTime() + PAID_AT_CLOCK_SKEW_MS
    ) {
      throw new BadRequestException(PAID_AT_IN_FUTURE_MESSAGE);
    }
    const preview = await this.findInvoicePreview(invoiceId);
    const outcome = await this.run(async (tx) => {
      const subscription = await this.lockSubscription(tx, {
        id: preview.subscription_id,
        store_id: preview.store_id,
      });
      const invoice = await this.lockInvoice(tx, subscription, invoiceId);
      return this.payInvoiceTx(tx, subscription, invoice, input, {
        ...ctx,
        now,
      });
    });

    if (outcome.changed) {
      await this.audit.record({
        actor: ctx.user,
        scope: auditScopeOf(ctx),
        storeId: outcome.invoice.store_id,
        action: 'subscription.invoice.mark_paid',
        targetType: 'subscription_invoice',
        targetId: invoiceId,
        metadata: {
          subscription_id: outcome.invoice.subscription_id,
          amount: outcome.invoice.amount,
          provider_payment_id: outcome.invoice.provider_payment_id,
          payment_method: outcome.invoice.payment_method,
          status_change: outcome.statusChange,
        },
        request: ctx.request,
      });
      return this.reloadInvoice(outcome.invoice);
    }
    return outcome.invoice;
  }

  /**
   * A linha como ficou gravada: o objeto alterado em memória ainda tem o updated_at de antes (o
   * banco preenche o novo no UPDATE). Sem a linha (não deveria acontecer), devolve o da memória.
   */
  private async reloadInvoice(
    invoice: SubscriptionInvoice,
  ): Promise<SubscriptionInvoice> {
    const fresh = await this.invoices.findOne({
      where: { id: invoice.id, store_id: invoice.store_id },
    });
    return fresh ?? invoice;
  }

  /** Pagamento recusado: a fatura continua devida (FAILED) e conta mais uma tentativa. */
  async markInvoiceFailed(
    invoiceId: number,
    input: { reason?: string | null },
    ctx: BillingContext,
  ): Promise<SubscriptionInvoice> {
    this.assertPlatformOperator(ctx.user);
    const preview = await this.findInvoicePreview(invoiceId);
    const invoice = await this.run(async (tx) => {
      const subscription = await this.lockSubscription(tx, {
        id: preview.subscription_id,
        store_id: preview.store_id,
      });
      const locked = await this.lockInvoice(tx, subscription, invoiceId);
      return this.failInvoiceTx(
        tx,
        subscription,
        locked,
        reasonText(input.reason),
        ctx.user,
        { source: 'platform' },
      );
    });

    await this.audit.record({
      actor: ctx.user,
      scope: auditScopeOf(ctx),
      storeId: invoice.store_id,
      action: 'subscription.invoice.mark_failed',
      targetType: 'subscription_invoice',
      targetId: invoiceId,
      metadata: {
        subscription_id: invoice.subscription_id,
        attempts: invoice.attempts,
        reason: invoice.failure_reason,
      },
      request: ctx.request,
    });
    return this.reloadInvoice(invoice);
  }

  /**
   * Anula a fatura (OPEN/FAILED → VOID; idempotente). Paga não pode ser anulada. Assinatura em
   * atraso sem outra fatura vencida volta a ACTIVE.
   */
  async voidInvoice(
    invoiceId: number,
    input: { reason?: string | null },
    ctx: BillingContext,
  ): Promise<SubscriptionInvoice> {
    this.assertPlatformOperator(ctx.user);
    const now = ctx.now ?? new Date();
    const reason = reasonText(input.reason);
    const preview = await this.findInvoicePreview(invoiceId);
    const outcome = await this.run(async (tx) => {
      const subscription = await this.lockSubscription(tx, {
        id: preview.subscription_id,
        store_id: preview.store_id,
      });
      const invoice = await this.lockInvoice(tx, subscription, invoiceId);
      if (invoice.status === InvoiceStatus.VOID) {
        return { invoice, changed: false, statusChange: null };
      }
      if (invoice.status === InvoiceStatus.PAID) {
        throw new ConflictException(INVOICE_PAID_VOID_MESSAGE);
      }
      await this.voidInvoiceRow(tx, subscription, invoice, {
        actor: ctx.user,
        reason,
        trigger: 'platform.void',
      });

      let statusChange: StatusChange | null = null;
      if (
        subscription.status === SubscriptionStatus.PAST_DUE &&
        !(await this.overdueUnpaid(tx, subscription, now)).length
      ) {
        statusChange = await this.changeStatus(
          tx,
          subscription,
          SubscriptionStatus.ACTIVE,
          { past_due_since: null, grace_period_ends_at: null },
          {
            actor: ctx.user,
            reason,
            trigger: 'invoice.void',
            metadata: { invoice_id: invoice.id },
          },
        );
      }
      return { invoice, changed: true, statusChange };
    });

    if (outcome.changed) {
      await this.audit.record({
        actor: ctx.user,
        scope: auditScopeOf(ctx),
        storeId: outcome.invoice.store_id,
        action: 'subscription.invoice.void',
        targetType: 'subscription_invoice',
        targetId: invoiceId,
        metadata: {
          subscription_id: outcome.invoice.subscription_id,
          amount: outcome.invoice.amount,
          reason,
          status_change: outcome.statusChange,
        },
        request: ctx.request,
      });
      return this.reloadInvoice(outcome.invoice);
    }
    return outcome.invoice;
  }

  // ---------------------------------------------------------------------------
  // Painel da loja
  // ---------------------------------------------------------------------------

  /** POST /store/subscription/cancel: sempre no fim do período (sem período: na hora). */
  async cancelForStore(
    tenant: TenantContext,
    reason: string | null | undefined,
    ctx: BillingContext,
  ): Promise<{ subscription: Subscription; scheduled: boolean }> {
    const current = await this.requireCurrent(tenant.storeId);
    return this.cancel(current.id, {
      ...ctx,
      atPeriodEnd: true,
      reason,
      storeId: tenant.storeId,
      storeOwnerId: tenant.store?.owner_user_id ?? null,
    });
  }

  async resumeForStore(
    tenant: TenantContext,
    ctx: BillingContext,
  ): Promise<Subscription> {
    const current = await this.requireCurrent(tenant.storeId);
    return this.resume(current.id, { ...ctx, storeId: tenant.storeId });
  }

  /**
   * POST /store/subscription/checkout: link para a loja autorizar a cobrança recorrente no provedor
   * (Mercado Pago). Reaproveita o link pendente; recusa plano gratuito e cobrança já autorizada.
   * Sem provedor online configurado → 409.
   */
  async checkoutForStore(
    tenant: TenantContext,
    ctx: BillingContext,
    payerEmail?: string | null,
  ): Promise<{
    checkout_url: string;
    provider: BillingProviderCode;
    provider_status: string | null;
  }> {
    // Um checkout por vez na loja: dois pedidos simultâneos (duas abas, dois ADMINs) criariam duas
    // autorizações no provedor, e a que não ficasse gravada continuaria cobrando. A trava consultiva
    // vale até gravar o link. Quem a encontra ocupada NÃO espera dentro da transação (seguraria uma
    // conexão do pool durante a chamada ao provedor, até 15 s, e uma fila assim esgotaria o pool de
    // todas as lojas): solta a conexão, espera fora dela e tenta de novo, já relendo a assinatura e
    // reaproveitando o link pendente gravado pelo outro. Ocupada por mais de ~3 s → 409.
    const attempt = () =>
      this.subscriptions.manager.transaction(async (manager) => {
        if (
          !(await tryAdvisoryXactLock(
            manager,
            `subscription-checkout:${tenant.storeId}`,
          ))
        ) {
          return { kind: 'busy' as const };
        }
        const tx = txOf(manager);
        const subscription = await tx.subscriptions.findOne({
          where: {
            store_id: tenant.storeId,
            status: Not(SubscriptionStatus.CANCELED),
          },
          relations: { plan: true },
          order: { id: 'DESC' },
        });
        if (!subscription) {
          throw new ConflictException(NO_CURRENT_SUBSCRIPTION_MESSAGE);
        }
        // Suspensa pela plataforma: pagar não reativa (só o superadmin), então não abre cobrança nova
        if (isPlatformSuspension(subscription)) {
          throw new ConflictException(PLATFORM_SUSPENSION_CHECKOUT_MESSAGE);
        }
        const provider = this.providers.checkoutProvider();
        const plan = subscription.plan;
        if (!plan)
          throw new NotFoundException(PLAN_NOT_FOUND_FOR_SUBSCRIPTION_MESSAGE);
        if (!isPaidPlan(plan)) {
          throw new BadRequestException(FREE_PLAN_CHECKOUT_MESSAGE);
        }
        const sameProvider = subscription.billing_provider === provider.code;
        if (sameProvider && subscription.provider_status === 'authorized') {
          throw new ConflictException(CHECKOUT_ALREADY_AUTHORIZED_MESSAGE);
        }
        if (
          sameProvider &&
          subscription.provider_status === 'pending' &&
          subscription.provider_checkout_url
        ) {
          return {
            kind: 'reused' as const,
            reused: {
              checkout_url: subscription.provider_checkout_url,
              provider: provider.code,
              provider_status: subscription.provider_status,
            },
          };
        }

        const email = (payerEmail ?? ctx.user?.email ?? '')
          .trim()
          .toLowerCase();
        if (!email) throw new BadRequestException(PAYER_EMAIL_REQUIRED_MESSAGE);

        // Com fatura em aberto o provedor cobra ao autorizar; senão, a partir do fim do teste/período pago
        const unpaid = await tx.invoices.count({
          where: {
            subscription_id: subscription.id,
            store_id: tenant.storeId,
            status: In(UNPAID_INVOICE_STATUSES),
          },
        });
        const startDate = unpaid
          ? null
          : subscription.status === SubscriptionStatus.TRIALING
            ? subscription.trial_ends_at
            : subscription.current_period_end;

        const checkout = await provider.createCheckout(
          subscription,
          plan,
          tenant.store,
          email,
          { startDate },
        );
        const result = await tx.subscriptions.update(
          {
            id: subscription.id,
            store_id: tenant.storeId,
            status: Not(SubscriptionStatus.CANCELED),
          },
          {
            billing_provider: provider.code,
            provider_subscription_id: checkout.provider_subscription_id,
            provider_status: checkout.provider_status ?? 'pending',
            provider_checkout_url: checkout.checkout_url,
          },
        );
        if (!result.affected)
          throw new ConflictException(CONCURRENT_CHANGE_MESSAGE);
        return {
          kind: 'created' as const,
          subscription,
          provider,
          plan,
          checkout,
          startDate,
        };
      });
    let created = await attempt();
    for (let tries = 1; created.kind === 'busy'; tries++) {
      if (tries >= CHECKOUT_LOCK_ATTEMPTS) {
        throw new ConflictException(CHECKOUT_IN_PROGRESS_MESSAGE);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, CHECKOUT_LOCK_RETRY_MS),
      );
      created = await attempt();
    }
    if (created.kind === 'reused') return created.reused;
    const { subscription, provider, plan, checkout, startDate } = created;

    await this.recordEventNow(
      subscription,
      SubscriptionEventType.CHECKOUT_CREATED,
      {
        metadata: {
          provider: provider.code,
          provider_subscription_id: checkout.provider_subscription_id,
          amount: Number(plan.price),
          start_date: startDate,
        },
      },
      ctx.user,
    );
    await this.audit.record({
      actor: ctx.user,
      scope: auditScopeOf(ctx),
      storeId: tenant.storeId,
      action: 'subscription.checkout',
      targetType: 'subscription',
      targetId: subscription.id,
      metadata: {
        provider: provider.code,
        provider_subscription_id: checkout.provider_subscription_id,
      },
      request: ctx.request,
    });
    return {
      checkout_url: checkout.checkout_url,
      provider: provider.code,
      provider_status: checkout.provider_status ?? 'pending',
    };
  }

  // ---------------------------------------------------------------------------
  // Rotina de cobrança (SubscriptionLifecycleService): cada passo trava e confere de novo a
  // assinatura, então rodar duas vezes (ou em duas instâncias) não duplica nada.
  // ---------------------------------------------------------------------------

  /** Fim do teste: gratuito → ACTIVE sem período; pago → fatura do 1º período (vence no fim do teste) + ACTIVE. */
  async processTrialEnd(
    subscriptionId: number,
    now: Date,
  ): Promise<LifecycleStepResult> {
    const ctx: BillingContext = { ...SYSTEM_ACTOR, now };
    const outcome = await this.run(async (tx) => {
      const subscription = await this.lockSubscription(tx, {
        id: subscriptionId,
      });
      const endsAt = subscription.trial_ends_at;
      if (
        subscription.status !== SubscriptionStatus.TRIALING ||
        !endsAt ||
        endsAt.getTime() > now.getTime()
      ) {
        return null;
      }
      if (subscription.cancel_at_period_end) {
        await this.finalizeCancel(tx, subscription, endsAt, {
          ...ctx,
          trigger: 'lifecycle.trial_end',
        });
        return { subscription, result: 'canceled' as const };
      }

      const plan = await this.loadPlan(tx, subscription.plan_id);
      if (!isPaidPlan(plan)) {
        const change = await this.changeStatus(
          tx,
          subscription,
          SubscriptionStatus.ACTIVE,
          { current_period_start: endsAt, current_period_end: null },
          { actor: null, trigger: 'lifecycle.trial_end' },
        );
        return { subscription, result: 'activated' as const, change };
      }
      const period = periodFrom(endsAt, plan.billing_interval);
      const change = await this.changeStatus(
        tx,
        subscription,
        SubscriptionStatus.ACTIVE,
        { current_period_start: period.start, current_period_end: period.end },
        { actor: null, trigger: 'lifecycle.trial_end' },
      );
      if (!(await this.invoiceForPeriod(tx, subscription, period.start))) {
        await this.createInvoiceRow(
          tx,
          subscription,
          plan,
          { amount: Number(plan.price), period, dueAt: endsAt },
          ctx,
          'lifecycle.trial_end',
        );
      }
      return { subscription, result: 'activated' as const, change };
    });
    if (!outcome) return null;
    await this.auditLifecycle(outcome.subscription, outcome.result);
    if (outcome.result === 'canceled') {
      await this.syncProviderCancellation(outcome.subscription, SYSTEM_ACTOR);
    }
    return outcome.result;
  }

  /**
   * Fim do período: cancelamento agendado → CANCELED; plano pago → fatura OPEN do próximo período
   * (vence no início dele; reaproveita fatura já existente do período) e o período avança; plano
   * gratuito → deixa de ter vencimento. Assinatura suspensa não renova (fica congelada até reativar).
   */
  async processPeriodEnd(
    subscriptionId: number,
    now: Date,
  ): Promise<LifecycleStepResult> {
    const ctx: BillingContext = { ...SYSTEM_ACTOR, now };
    const outcome = await this.run(async (tx) => {
      const subscription = await this.lockSubscription(tx, {
        id: subscriptionId,
      });
      const end = subscription.current_period_end;
      const renewable =
        subscription.status === SubscriptionStatus.ACTIVE ||
        subscription.status === SubscriptionStatus.PAST_DUE ||
        subscription.status === SubscriptionStatus.SUSPENDED;
      if (!renewable || !end || end.getTime() > now.getTime()) return null;

      if (subscription.cancel_at_period_end) {
        await this.finalizeCancel(tx, subscription, end, {
          ...ctx,
          trigger: 'lifecycle.period_end',
        });
        return { subscription, result: 'canceled' as const };
      }
      if (subscription.status === SubscriptionStatus.SUSPENDED) return null;

      const plan = await this.loadPlan(tx, subscription.plan_id);
      if (!isPaidPlan(plan)) {
        await this.applyChanges(tx, subscription, {
          current_period_start: end,
          current_period_end: null,
        });
        await this.recordEvent(
          tx,
          subscription,
          SubscriptionEventType.PERIOD_RENEWED,
          { metadata: { period_start: end, period_end: null, free: true } },
          null,
        );
        return { subscription, result: 'renewed' as const };
      }

      const period = periodFrom(end, plan.billing_interval);
      const existing = await this.invoiceForPeriod(
        tx,
        subscription,
        period.start,
      );
      const invoice =
        existing ??
        (await this.createInvoiceRow(
          tx,
          subscription,
          plan,
          { amount: Number(plan.price), period, dueAt: period.start },
          ctx,
          'lifecycle.renewal',
        ));
      await this.applyChanges(tx, subscription, {
        current_period_start: period.start,
        current_period_end: period.end,
      });
      await this.recordEvent(
        tx,
        subscription,
        SubscriptionEventType.PERIOD_RENEWED,
        {
          metadata: {
            period_start: period.start,
            period_end: period.end,
            invoice_id: invoice.id,
            prepaid: invoice.status === InvoiceStatus.PAID,
          },
        },
        null,
      );
      return { subscription, result: 'renewed' as const };
    });
    if (!outcome) return null;
    if (outcome.result === 'canceled') {
      await this.auditLifecycle(outcome.subscription, 'canceled');
      await this.syncProviderCancellation(outcome.subscription, SYSTEM_ACTOR);
    }
    return outcome.result;
  }

  /** Fatura vencida em aberto: ACTIVE → PAST_DUE (tolerância = vencimento + dias da plataforma). */
  async processOverdue(
    subscriptionId: number,
    now: Date,
    graceDays: number,
  ): Promise<LifecycleStepResult> {
    const outcome = await this.run(async (tx) => {
      const subscription = await this.lockSubscription(tx, {
        id: subscriptionId,
      });
      if (subscription.status !== SubscriptionStatus.ACTIVE) return null;
      const [oldest] = await this.overdueUnpaid(tx, subscription, now);
      if (!oldest) return null;
      await this.changeStatus(
        tx,
        subscription,
        SubscriptionStatus.PAST_DUE,
        {
          past_due_since: oldest.due_at,
          grace_period_ends_at: graceEnd(oldest.due_at, graceDays),
        },
        {
          actor: null,
          trigger: 'lifecycle.invoice_overdue',
          metadata: { invoice_id: oldest.id, grace_days: graceDays },
        },
      );
      return subscription;
    });
    if (!outcome) return null;
    await this.auditLifecycle(outcome, 'past_due');
    return 'past_due';
  }

  /** Fim da tolerância: PAST_DUE → SUSPENDED (ou volta a ACTIVE se não há mais fatura vencida). */
  async processGraceEnd(
    subscriptionId: number,
    now: Date,
  ): Promise<LifecycleStepResult> {
    const outcome = await this.run(async (tx) => {
      const subscription = await this.lockSubscription(tx, {
        id: subscriptionId,
      });
      const graceEndsAt = subscription.grace_period_ends_at;
      if (
        subscription.status !== SubscriptionStatus.PAST_DUE ||
        !graceEndsAt ||
        graceEndsAt.getTime() > now.getTime()
      ) {
        return null;
      }
      if (!(await this.overdueUnpaid(tx, subscription, now)).length) {
        await this.changeStatus(
          tx,
          subscription,
          SubscriptionStatus.ACTIVE,
          { past_due_since: null, grace_period_ends_at: null },
          { actor: null, trigger: 'lifecycle.no_overdue_invoice' },
        );
        return { subscription, result: 'restored' as const };
      }
      // Suspensão por inadimplência: o pagamento das faturas vencidas reativa sozinho
      await this.changeStatus(
        tx,
        subscription,
        SubscriptionStatus.SUSPENDED,
        { suspended_at: now, suspended_by: 'BILLING' },
        { actor: null, trigger: 'lifecycle.grace_ended' },
      );
      return { subscription, result: 'suspended' as const };
    });
    if (!outcome) return null;
    await this.auditLifecycle(outcome.subscription, outcome.result);
    return outcome.result;
  }

  // ---------------------------------------------------------------------------
  // Provedor (webhook): o recurso já foi reconsultado no provedor antes de chegar aqui
  // ---------------------------------------------------------------------------

  /** Situação da cobrança recorrente no provedor (pending, authorized, paused, cancelled...). */
  async applyProviderStatus(
    subscriptionId: number,
    input: { providerSubscriptionId: string; providerStatus: string | null },
  ): Promise<'updated' | 'unchanged' | 'ignored'> {
    const status = input.providerStatus?.trim().slice(0, 40) || null;
    const outcome = await this.run(async (tx) => {
      const subscription = await this.lockSubscription(tx, {
        id: subscriptionId,
      });
      const current = subscription.provider_subscription_id;
      const replacing = !!current && current !== input.providerSubscriptionId;
      // Outra autorização da mesma assinatura (link antigo): só é assumida se foi autorizada e a atual não
      if (
        replacing &&
        (status !== 'authorized' ||
          subscription.provider_status === 'authorized')
      ) {
        return { subscription, result: 'ignored' as const };
      }
      if (
        !replacing &&
        current === input.providerSubscriptionId &&
        subscription.provider_status === status &&
        subscription.billing_provider === 'MERCADO_PAGO'
      ) {
        return { subscription, result: 'unchanged' as const };
      }
      const previous = subscription.provider_status;
      await this.applyChanges(tx, subscription, {
        billing_provider: 'MERCADO_PAGO',
        provider_subscription_id: input.providerSubscriptionId,
        provider_status: status,
      });
      await this.recordEvent(
        tx,
        subscription,
        SubscriptionEventType.PROVIDER_STATUS_CHANGED,
        {
          metadata: {
            from: previous,
            to: status,
            provider_subscription_id: input.providerSubscriptionId,
            ...(replacing
              ? { replaced_provider_subscription_id: current }
              : {}),
          },
        },
        null,
      );
      return { subscription, result: 'updated' as const };
    });

    // Autorizada depois do cancelamento: a cobrança recorrente é interrompida na hora
    if (
      outcome.subscription.status === SubscriptionStatus.CANCELED &&
      outcome.subscription.provider_status === 'authorized'
    ) {
      await this.syncProviderCancellation(outcome.subscription, SYSTEM_ACTOR);
    }
    return outcome.result;
  }

  /**
   * Pagamento aprovado no provedor: quita a fatura em aberto mais antiga (ou cria e quita a do
   * próximo período, quando o provedor cobra antes da rotina gerar a fatura). Idempotente pelo
   * provider_payment_id. Valor menor que a fatura não quita (fica para conferência no superpainel).
   */
  async applyProviderPayment(
    subscriptionId: number,
    input: {
      providerPaymentId: string;
      amount?: number | null;
      paidAt?: Date | null;
      provider?: BillingProviderCode;
      /** Autorização (preapproval) que gerou a cobrança, quando o provedor informa. */
      providerSubscriptionId?: string | null;
    },
    now: Date = new Date(),
  ): Promise<{ result: ProviderPaymentResult; invoiceId: number | null }> {
    const provider = input.provider ?? 'MERCADO_PAGO';
    const ctx: BillingContext = { ...SYSTEM_ACTOR, now };
    const outcome = await this.run(async (tx) => {
      const subscription = await this.lockSubscription(tx, {
        id: subscriptionId,
      });
      const already = await tx.invoices.findOne({
        where: { provider_payment_id: input.providerPaymentId },
        select: { id: true, store_id: true },
      });
      if (already) {
        return {
          subscription,
          result: 'duplicate' as const,
          invoice: null,
          statusChange: null,
        };
      }
      if (subscription.status === SubscriptionStatus.CANCELED) {
        await this.recordEvent(
          tx,
          subscription,
          SubscriptionEventType.PAYMENT_AFTER_CANCEL,
          {
            metadata: {
              provider,
              provider_payment_id: input.providerPaymentId,
              amount: input.amount ?? null,
            },
          },
          null,
        );
        return {
          subscription,
          result: 'subscription_canceled' as const,
          invoice: null,
          statusChange: null,
        };
      }

      let target = await tx.invoices.findOne({
        where: {
          subscription_id: subscription.id,
          store_id: subscription.store_id,
          status: In(UNPAID_INVOICE_STATUSES),
        },
        order: { due_at: 'ASC', id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      if (!target) {
        const plan = await this.loadPlan(tx, subscription.plan_id);
        if (!isPaidPlan(plan)) {
          return {
            subscription,
            result: 'free_plan' as const,
            invoice: null,
            statusChange: null,
          };
        }
        const period = await this.nextUnbilledPeriod(
          tx,
          subscription,
          plan,
          now,
        );
        target = await this.createInvoiceRow(
          tx,
          subscription,
          plan,
          { amount: Number(plan.price), period, dueAt: period.start },
          ctx,
          'provider.payment',
        );
      }

      const amount = Number(input.amount);
      if (
        input.amount !== undefined &&
        input.amount !== null &&
        Number.isFinite(amount) &&
        amount + 0.005 < Number(target.amount)
      ) {
        await this.recordEvent(
          tx,
          subscription,
          SubscriptionEventType.PAYMENT_AMOUNT_MISMATCH,
          {
            metadata: {
              invoice_id: target.id,
              invoice_amount: Number(target.amount),
              amount_paid: amount,
              provider_payment_id: input.providerPaymentId,
            },
          },
          null,
        );
        return {
          subscription,
          result: 'amount_mismatch' as const,
          invoice: target,
          statusChange: null,
        };
      }

      const paid = await this.payInvoiceTx(
        tx,
        subscription,
        target,
        {
          providerPaymentId: input.providerPaymentId,
          paidAt: input.paidAt ?? now,
          paymentMethod: provider === 'MERCADO_PAGO' ? 'MERCADO_PAGO' : null,
          provider,
        },
        ctx,
      );
      return {
        subscription,
        result: 'paid' as const,
        invoice: paid.invoice,
        statusChange: paid.statusChange,
      };
    });

    if (outcome.result !== 'duplicate' && outcome.result !== 'free_plan') {
      const failure =
        outcome.result === 'amount_mismatch' ||
        outcome.result === 'subscription_canceled';
      await this.audit.record({
        actor: null,
        scope: 'SYSTEM',
        storeId: outcome.subscription.store_id,
        action: failure
          ? 'subscription.provider_payment_review'
          : 'subscription.invoice.mark_paid',
        targetType: outcome.invoice ? 'subscription_invoice' : 'subscription',
        targetId: outcome.invoice?.id ?? outcome.subscription.id,
        result: failure ? 'FAILURE' : 'SUCCESS',
        metadata: {
          source: 'webhook',
          provider,
          provider_payment_id: input.providerPaymentId,
          amount: input.amount ?? null,
          outcome: outcome.result,
          status_change: outcome.statusChange,
        },
      });
    }
    if (provider === 'MERCADO_PAGO' && outcome.result !== 'duplicate') {
      await this.stopStrayProviderCharges(
        outcome.subscription,
        input.providerSubscriptionId?.trim() || null,
      );
    }
    return { result: outcome.result, invoiceId: outcome.invoice?.id ?? null };
  }

  /**
   * Cobrança que não deveria existir (depois do pagamento já registrado): assinatura cancelada com a
   * cobrança recorrente ainda ativa no provedor (o cancelamento lá falhou) → tenta de novo agora; e
   * cobrança de outra autorização da mesma assinatura (órfã de um checkout repetido) enquanto a
   * registrada está autorizada → a órfã é cancelada no provedor. Melhor esforço (falha vira evento).
   */
  private async stopStrayProviderCharges(
    subscription: Subscription,
    chargedFrom: string | null,
  ): Promise<void> {
    const canceled = subscription.status === SubscriptionStatus.CANCELED;
    if (canceled) {
      await this.syncProviderCancellation(subscription, SYSTEM_ACTOR);
    }
    const orphan =
      chargedFrom !== null &&
      chargedFrom !== subscription.provider_subscription_id;
    if (orphan && (canceled || subscription.provider_status === 'authorized')) {
      await this.cancelOrphanAuthorization(subscription, chargedFrom);
    }
  }

  /** Cancela no provedor uma autorização da assinatura que não é a registrada. */
  private async cancelOrphanAuthorization(
    subscription: Subscription,
    providerSubscriptionId: string,
  ): Promise<void> {
    try {
      const provider = this.providers.forCode('MERCADO_PAGO');
      if (!provider?.online) {
        throw new Error('MP_SAAS_ACCESS_TOKEN não configurado');
      }
      await provider.cancelSubscription(providerSubscriptionId);
      await this.recordEventNow(
        subscription,
        SubscriptionEventType.PROVIDER_STATUS_CHANGED,
        {
          metadata: {
            from: null,
            to: 'cancelled',
            provider_subscription_id: providerSubscriptionId,
            orphan: true,
          },
        },
        null,
      );
    } catch (error) {
      await this.providerSyncFailed(
        subscription,
        'cancel_orphan',
        error,
        SYSTEM_ACTOR,
      );
    }
  }

  /**
   * Rotina: assinatura cancelada com a cobrança recorrente ainda ativa no provedor (o cancelamento lá
   * falhou) → nova tentativa, com intervalo crescente a partir da última falha (1 h, 2 h, 4 h... até
   * 24 h). Sem credencial do provedor configurada, não tenta (nada mudaria). 'provider_canceled' quando
   * a cobrança foi interrompida.
   */
  async retryProviderCancellation(
    subscriptionId: number,
    now: Date = new Date(),
  ): Promise<LifecycleStepResult> {
    const subscription = await this.subscriptions.findOne({
      where: { id: subscriptionId },
    });
    if (
      !subscription ||
      subscription.status !== SubscriptionStatus.CANCELED ||
      subscription.billing_provider !== 'MERCADO_PAGO' ||
      !subscription.provider_subscription_id ||
      subscription.provider_status === 'cancelled'
    ) {
      return null;
    }
    if (!this.providers.forCode('MERCADO_PAGO')?.online) return null;

    const failures = await this.events.find({
      where: {
        subscription_id: subscription.id,
        store_id: subscription.store_id,
        type: SubscriptionEventType.PROVIDER_SYNC_FAILED,
      },
      select: { id: true, created_at: true },
      order: { created_at: 'DESC', id: 'DESC' },
      take: PROVIDER_CANCEL_RETRY_WINDOW,
    });
    if (failures.length) {
      const wait = Math.min(
        PROVIDER_CANCEL_RETRY_BASE_MS * 2 ** (failures.length - 1),
        PROVIDER_CANCEL_RETRY_MAX_MS,
      );
      const last = new Date(failures[0].created_at).getTime();
      if (now.getTime() - last < wait) return null;
    }

    await this.syncProviderCancellation(subscription, SYSTEM_ACTOR);
    if (subscription.provider_status !== 'cancelled') return null;
    await this.auditLifecycle(subscription, 'provider_canceled');
    return 'provider_canceled';
  }

  /** Cobrança recusada no provedor: a fatura em aberto mais antiga vira FAILED (+1 tentativa). */
  async applyProviderFailure(
    subscriptionId: number,
    input: { providerPaymentId?: string | null; reason?: string | null },
  ): Promise<'failed' | 'duplicate' | 'ignored'> {
    const outcome = await this.run(async (tx) => {
      const subscription = await this.lockSubscription(tx, {
        id: subscriptionId,
      });
      if (subscription.status === SubscriptionStatus.CANCELED) return null;
      if (input.providerPaymentId) {
        // A mesma recusa notificada de novo não conta duas tentativas
        const previous = await tx.events.find({
          where: {
            subscription_id: subscription.id,
            store_id: subscription.store_id,
            type: SubscriptionEventType.PAYMENT_FAILED,
          },
          order: { id: 'DESC' },
          take: 50,
        });
        if (
          previous.some(
            (event) =>
              event.metadata?.provider_payment_id === input.providerPaymentId,
          )
        ) {
          return 'duplicate' as const;
        }
      }
      const target = await tx.invoices.findOne({
        where: {
          subscription_id: subscription.id,
          store_id: subscription.store_id,
          status: In(UNPAID_INVOICE_STATUSES),
        },
        order: { due_at: 'ASC', id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      if (!target) return null;
      return this.failInvoiceTx(
        tx,
        subscription,
        target,
        reasonText(input.reason) ?? 'Pagamento recusado pelo provedor.',
        null,
        {
          source: 'webhook',
          provider_payment_id: input.providerPaymentId ?? null,
        },
      );
    });
    if (outcome === 'duplicate') return 'duplicate';
    if (!outcome) return 'ignored';
    await this.audit.record({
      actor: null,
      scope: 'SYSTEM',
      storeId: outcome.store_id,
      action: 'subscription.invoice.mark_failed',
      targetType: 'subscription_invoice',
      targetId: outcome.id,
      metadata: {
        source: 'webhook',
        attempts: outcome.attempts,
        provider_payment_id: input.providerPaymentId ?? null,
      },
    });
    return 'failed';
  }

  // ---------------------------------------------------------------------------
  // Internos
  // ---------------------------------------------------------------------------

  private run<T>(
    work: (tx: BillingTx) => Promise<T>,
    manager?: EntityManager,
  ): Promise<T> {
    if (manager) return work(txOf(manager));
    return this.subscriptions.manager.transaction((transactional) =>
      work(txOf(transactional)),
    );
  }

  /**
   * Operações do superpainel: além do PlatformRoute na rota, o serviço recusa um usuário que não seja
   * superadmin (defesa em profundidade). null = sistema (rotina, webhook, fluxos internos).
   */
  private assertPlatformOperator(user: AuthUser | null | undefined): void {
    if (user && !isSuperAdmin(user)) {
      throw new ForbiddenException(PLATFORM_ONLY_MESSAGE);
    }
  }

  private scope(
    id: number,
    storeId?: number,
  ): { id: number; store_id?: number } {
    return storeId === undefined ? { id } : { id, store_id: storeId };
  }

  private async findPreview(
    subscriptionId: number,
  ): Promise<Pick<Subscription, 'id' | 'store_id'>> {
    const preview = await this.subscriptions.findOne({
      where: { id: subscriptionId },
      select: { id: true, store_id: true },
    });
    if (!preview) throw new NotFoundException(SUBSCRIPTION_NOT_FOUND_MESSAGE);
    return preview;
  }

  private async findInvoicePreview(
    invoiceId: number,
  ): Promise<Pick<SubscriptionInvoice, 'id' | 'subscription_id' | 'store_id'>> {
    const preview = await this.invoices.findOne({
      where: { id: invoiceId },
      select: { id: true, subscription_id: true, store_id: true },
    });
    if (!preview) throw new NotFoundException(INVOICE_NOT_FOUND_MESSAGE);
    return preview;
  }

  private async requireCurrent(storeId: number): Promise<Subscription> {
    const current = await this.currentForStore(storeId);
    if (!current) throw new ConflictException(NO_CURRENT_SUBSCRIPTION_MESSAGE);
    return current;
  }

  /** Trava a assinatura (FOR UPDATE, sem relações: o Postgres não trava o lado opcional de um LEFT JOIN). */
  private async lockSubscription(
    tx: BillingTx,
    where: { id: number; store_id?: number },
  ): Promise<Subscription> {
    const subscription = await tx.subscriptions.findOne({
      where,
      lock: { mode: 'pessimistic_write' },
    });
    if (!subscription) {
      throw new NotFoundException(SUBSCRIPTION_NOT_FOUND_MESSAGE);
    }
    return subscription;
  }

  private async lockInvoice(
    tx: BillingTx,
    subscription: Subscription,
    invoiceId: number,
  ): Promise<SubscriptionInvoice> {
    const invoice = await tx.invoices.findOne({
      where: {
        id: invoiceId,
        subscription_id: subscription.id,
        store_id: subscription.store_id,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (!invoice) throw new NotFoundException(INVOICE_NOT_FOUND_MESSAGE);
    return invoice;
  }

  private async loadPlan(tx: BillingTx, planId: number): Promise<Plan> {
    const plan = await tx.plans.findOne({ where: { id: planId } });
    if (!plan) {
      throw new NotFoundException(PLAN_NOT_FOUND_FOR_SUBSCRIPTION_MESSAGE);
    }
    return plan;
  }

  private assertPlanAvailable(plan: Plan, allowInactive: boolean): void {
    if (plan.status !== PlanStatus.ACTIVE && !allowInactive) {
      throw new BadRequestException(PLAN_UNAVAILABLE_MESSAGE);
    }
  }

  /** Grava as mudanças pela chave composta (id, loja, situação esperada) e confere affected. */
  private async applyChanges(
    tx: BillingTx,
    subscription: Subscription,
    changes: SubscriptionPatch,
    expectedStatus: SubscriptionStatus = subscription.status,
  ): Promise<void> {
    const result = await tx.subscriptions.update(
      {
        id: subscription.id,
        store_id: subscription.store_id,
        status: expectedStatus,
      },
      changes,
    );
    if (!result.affected)
      throw new ConflictException(CONCURRENT_CHANGE_MESSAGE);
    Object.assign(subscription, changes);
  }

  /** Muda a situação validando a transição e registra o evento STATUS_CHANGED. */
  private async changeStatus(
    tx: BillingTx,
    subscription: Subscription,
    to: SubscriptionStatus,
    patch: SubscriptionPatch,
    info: {
      actor: AuthUser | null | undefined;
      reason?: string | null;
      trigger: string;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<StatusChange> {
    const from = subscription.status;
    assertTransition(from, to);
    await this.applyChanges(tx, subscription, { ...patch, status: to }, from);
    await this.recordEvent(
      tx,
      subscription,
      SubscriptionEventType.STATUS_CHANGED,
      {
        from_status: from,
        to_status: to,
        reason: info.reason ?? null,
        metadata: { trigger: info.trigger, ...(info.metadata ?? {}) },
      },
      info.actor ?? null,
    );
    return { from, to };
  }

  /** → CANCELED: faturas em aberto de períodos que ainda não começaram deixam de valer. */
  private async finalizeCancel(
    tx: BillingTx,
    subscription: Subscription,
    at: Date,
    info: BillingContext & { reason?: string | null; trigger: string },
  ): Promise<void> {
    await this.changeStatus(
      tx,
      subscription,
      SubscriptionStatus.CANCELED,
      { canceled_at: at },
      { actor: info.user, reason: info.reason, trigger: info.trigger },
    );
    const future = await tx.invoices.find({
      where: {
        subscription_id: subscription.id,
        store_id: subscription.store_id,
        status: In(UNPAID_INVOICE_STATUSES),
        period_start: MoreThanOrEqual(at),
      },
    });
    for (const invoice of future) {
      await this.voidInvoiceRow(tx, subscription, invoice, {
        actor: info.user,
        reason: 'Assinatura cancelada antes do início do período.',
        trigger: info.trigger,
      });
    }
  }

  private async voidInvoiceRow(
    tx: BillingTx,
    subscription: Subscription,
    invoice: SubscriptionInvoice,
    info: {
      actor: AuthUser | null | undefined;
      reason: string | null;
      trigger: string;
    },
  ): Promise<void> {
    const changes = {
      status: InvoiceStatus.VOID,
      notes: info.reason ?? invoice.notes ?? null,
    };
    const result = await tx.invoices.update(
      {
        id: invoice.id,
        store_id: subscription.store_id,
        status: In(UNPAID_INVOICE_STATUSES),
      },
      changes,
    );
    if (!result.affected)
      throw new ConflictException(CONCURRENT_CHANGE_MESSAGE);
    Object.assign(invoice, changes);
    await this.recordEvent(
      tx,
      subscription,
      SubscriptionEventType.INVOICE_VOIDED,
      {
        reason: info.reason,
        metadata: {
          invoice_id: invoice.id,
          amount: Number(invoice.amount),
          trigger: info.trigger,
        },
      },
      info.actor ?? null,
    );
  }

  /** Reativação forçada: a fatura vencida continua devida, com vencimento novo (agora). */
  private async rescheduleInvoice(
    tx: BillingTx,
    subscription: Subscription,
    invoice: SubscriptionInvoice,
    now: Date,
    info: { actor: AuthUser | null | undefined; reason: string | null },
  ): Promise<void> {
    const previousDue = invoice.due_at;
    const result = await tx.invoices.update(
      {
        id: invoice.id,
        store_id: subscription.store_id,
        status: In(UNPAID_INVOICE_STATUSES),
      },
      { due_at: now },
    );
    if (!result.affected)
      throw new ConflictException(CONCURRENT_CHANGE_MESSAGE);
    invoice.due_at = now;
    await this.recordEvent(
      tx,
      subscription,
      SubscriptionEventType.INVOICE_RESCHEDULED,
      {
        reason: info.reason,
        metadata: {
          invoice_id: invoice.id,
          previous_due_at: previousDue,
          due_at: now,
        },
      },
      info.actor ?? null,
    );
  }

  private async payInvoiceTx(
    tx: BillingTx,
    subscription: Subscription,
    invoice: SubscriptionInvoice,
    input: {
      paidAt?: Date;
      paymentMethod?: string | null;
      providerPaymentId?: string | null;
      notes?: string | null;
      provider?: BillingProviderCode;
    },
    ctx: BillingContext,
  ): Promise<{
    invoice: SubscriptionInvoice;
    changed: boolean;
    statusChange: StatusChange | null;
  }> {
    const now = ctx.now ?? new Date();
    const providerPaymentId = input.providerPaymentId ?? null;

    if (invoice.status === InvoiceStatus.PAID) {
      if (
        providerPaymentId &&
        invoice.provider_payment_id &&
        invoice.provider_payment_id !== providerPaymentId
      ) {
        throw new ConflictException(PAID_WITH_OTHER_PAYMENT_MESSAGE);
      }
      return { invoice, changed: false, statusChange: null };
    }
    if (invoice.status === InvoiceStatus.VOID) {
      throw new ConflictException(INVOICE_VOID_MESSAGE);
    }
    if (providerPaymentId) {
      const other = await tx.invoices.findOne({
        where: { provider_payment_id: providerPaymentId },
        select: { id: true },
      });
      if (other && other.id !== invoice.id) {
        throw new ConflictException(PROVIDER_PAYMENT_USED_MESSAGE);
      }
    }

    const changes = {
      status: InvoiceStatus.PAID,
      paid_at: input.paidAt ?? now,
      provider_payment_id:
        providerPaymentId ?? invoice.provider_payment_id ?? null,
      payment_method: input.paymentMethod ?? invoice.payment_method ?? null,
      notes: input.notes ?? invoice.notes ?? null,
      billing_provider: input.provider ?? invoice.billing_provider,
    };
    try {
      const result = await tx.invoices.update(
        {
          id: invoice.id,
          store_id: subscription.store_id,
          status: In(UNPAID_INVOICE_STATUSES),
        },
        changes,
      );
      if (!result.affected)
        throw new ConflictException(CONCURRENT_CHANGE_MESSAGE);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(PROVIDER_PAYMENT_USED_MESSAGE);
      }
      throw error;
    }
    Object.assign(invoice, changes);
    await this.recordEvent(
      tx,
      subscription,
      SubscriptionEventType.PAYMENT_SUCCEEDED,
      {
        metadata: {
          invoice_id: invoice.id,
          amount: Number(invoice.amount),
          provider: changes.billing_provider,
          provider_payment_id: changes.provider_payment_id,
          payment_method: changes.payment_method,
        },
      },
      ctx.user,
    );

    if (subscription.status === SubscriptionStatus.CANCELED) {
      return { invoice, changed: true, statusChange: null };
    }

    // Fatura de um período seguinte que já começou: o período da assinatura avança para ela
    const periodEnd = subscription.current_period_end;
    const patch: SubscriptionPatch =
      subscription.status !== SubscriptionStatus.TRIALING &&
      invoice.period_start.getTime() <= now.getTime() &&
      (periodEnd === null ||
        invoice.period_start.getTime() >= periodEnd.getTime())
        ? {
            current_period_start: invoice.period_start,
            current_period_end: invoice.period_end,
          }
        : {};

    let statusChange: StatusChange | null = null;
    // Só a inadimplência é regularizada pelo pagamento: a suspensão decidida pelo superadmin
    // (suspended_by = PLATFORM) continua até ele reativar, mesmo com tudo pago
    if (
      subscription.status === SubscriptionStatus.PAST_DUE ||
      (subscription.status === SubscriptionStatus.SUSPENDED &&
        !isPlatformSuspension(subscription))
    ) {
      const stillOverdue = await this.overdueUnpaid(tx, subscription, now);
      if (!stillOverdue.length) {
        const wasSuspended =
          subscription.status === SubscriptionStatus.SUSPENDED;
        statusChange = await this.changeStatus(
          tx,
          subscription,
          SubscriptionStatus.ACTIVE,
          {
            ...patch,
            past_due_since: null,
            grace_period_ends_at: null,
            suspended_at: null,
            suspended_by: null,
          },
          {
            actor: ctx.user,
            trigger: 'invoice.paid',
            metadata: { invoice_id: invoice.id },
          },
        );
        if (wasSuspended) {
          await this.restartPeriodIfEnded(tx, subscription, now, ctx);
        }
        return { invoice, changed: true, statusChange };
      }
    }
    if (Object.keys(patch).length) {
      await this.applyChanges(tx, subscription, patch);
    }
    return { invoice, changed: true, statusChange };
  }

  private async failInvoiceTx(
    tx: BillingTx,
    subscription: Subscription,
    invoice: SubscriptionInvoice,
    reason: string | null,
    actor: AuthUser | null | undefined,
    metadata: Record<string, unknown>,
  ): Promise<SubscriptionInvoice> {
    if (invoice.status === InvoiceStatus.PAID) {
      throw new ConflictException(INVOICE_ALREADY_PAID_MESSAGE);
    }
    if (invoice.status === InvoiceStatus.VOID) {
      throw new ConflictException(INVOICE_VOID_MESSAGE);
    }
    const changes = {
      status: InvoiceStatus.FAILED,
      attempts: (invoice.attempts ?? 0) + 1,
      failure_reason: reason ?? 'Pagamento recusado.',
    };
    const result = await tx.invoices.update(
      {
        id: invoice.id,
        store_id: subscription.store_id,
        status: In(UNPAID_INVOICE_STATUSES),
      },
      changes,
    );
    if (!result.affected)
      throw new ConflictException(CONCURRENT_CHANGE_MESSAGE);
    Object.assign(invoice, changes);
    await this.recordEvent(
      tx,
      subscription,
      SubscriptionEventType.PAYMENT_FAILED,
      {
        reason: changes.failure_reason,
        metadata: {
          invoice_id: invoice.id,
          attempts: changes.attempts,
          ...metadata,
        },
      },
      actor ?? null,
    );
    return invoice;
  }

  /** Suspensa com o período já encerrado volta com um período novo a partir de agora. */
  private async restartPeriodIfEnded(
    tx: BillingTx,
    subscription: Subscription,
    now: Date,
    ctx: BillingContext,
  ): Promise<void> {
    const end = subscription.current_period_end;
    if (
      end === null ||
      end.getTime() > now.getTime() ||
      subscription.cancel_at_period_end
    ) {
      return;
    }
    const plan = await this.loadPlan(tx, subscription.plan_id);
    if (!isPaidPlan(plan)) {
      await this.applyChanges(tx, subscription, {
        current_period_start: now,
        current_period_end: null,
      });
      return;
    }
    const period = periodFrom(now, plan.billing_interval);
    await this.applyChanges(tx, subscription, {
      current_period_start: period.start,
      current_period_end: period.end,
    });
    await this.recordEvent(
      tx,
      subscription,
      SubscriptionEventType.PERIOD_RENEWED,
      {
        metadata: {
          period_start: period.start,
          period_end: period.end,
          trigger: 'reactivation',
        },
      },
      ctx.user,
    );
    if (!(await this.invoiceForPeriod(tx, subscription, period.start))) {
      await this.createInvoiceRow(
        tx,
        subscription,
        plan,
        { amount: Number(plan.price), period, dueAt: now },
        ctx,
        'reactivation',
      );
    }
  }

  /** Faturas devidas (OPEN/FAILED) com vencimento já passado, da mais antiga para a mais nova. */
  private overdueUnpaid(
    tx: BillingTx,
    subscription: Subscription,
    now: Date,
  ): Promise<SubscriptionInvoice[]> {
    return tx.invoices.find({
      where: {
        subscription_id: subscription.id,
        store_id: subscription.store_id,
        status: In(UNPAID_INVOICE_STATUSES),
        due_at: LessThan(now),
      },
      order: { due_at: 'ASC', id: 'ASC' },
    });
  }

  /** Fatura (não anulada) que já cobre o período que começa em `start`. */
  private invoiceForPeriod(
    tx: BillingTx,
    subscription: Subscription,
    start: Date,
  ): Promise<SubscriptionInvoice | null> {
    return tx.invoices.findOne({
      where: {
        subscription_id: subscription.id,
        store_id: subscription.store_id,
        period_start: start,
        status: Not(InvoiceStatus.VOID),
      },
      order: { id: 'DESC' },
    });
  }

  private async defaultInvoicePeriod(
    tx: BillingTx,
    subscription: Subscription,
    plan: Plan,
    now: Date,
  ): Promise<BillingPeriod> {
    if (
      subscription.status === SubscriptionStatus.TRIALING &&
      subscription.trial_ends_at
    ) {
      return periodFrom(subscription.trial_ends_at, plan.billing_interval);
    }
    const start = subscription.current_period_start;
    const end = subscription.current_period_end;
    if (start && end && end.getTime() > now.getTime()) {
      return (await this.invoiceForPeriod(tx, subscription, start))
        ? periodFrom(end, plan.billing_interval)
        : { start, end };
    }
    return periodFrom(now, plan.billing_interval);
  }

  /** Primeiro período sem fatura a partir do atual (pagamento antecipado do provedor). */
  private async nextUnbilledPeriod(
    tx: BillingTx,
    subscription: Subscription,
    plan: Plan,
    now: Date,
  ): Promise<BillingPeriod> {
    let start =
      subscription.status === SubscriptionStatus.TRIALING &&
      subscription.trial_ends_at
        ? subscription.trial_ends_at
        : (subscription.current_period_end ?? now);
    // Pagamentos repetidos do provedor (períodos já pagos) caem no período seguinte
    for (let guard = 0; guard < 24; guard += 1) {
      if (!(await this.invoiceForPeriod(tx, subscription, start))) break;
      start = periodFrom(start, plan.billing_interval).end;
    }
    return periodFrom(start, plan.billing_interval);
  }

  private async createInvoiceRow(
    tx: BillingTx,
    subscription: Subscription,
    plan: Plan,
    input: {
      amount: number;
      period: BillingPeriod;
      dueAt: Date;
      notes?: string | null;
    },
    ctx: BillingContext,
    trigger: string,
  ): Promise<SubscriptionInvoice> {
    const invoice = await tx.invoices.save(
      tx.invoices.create({
        subscription_id: subscription.id,
        store_id: subscription.store_id,
        plan_id: plan.id,
        amount: input.amount,
        currency: plan.currency || 'BRL',
        status: InvoiceStatus.OPEN,
        period_start: input.period.start,
        period_end: input.period.end,
        due_at: input.dueAt,
        paid_at: null,
        billing_provider: subscription.billing_provider,
        provider_payment_id: null,
        payment_method: null,
        notes: input.notes ?? null,
        failure_reason: null,
        attempts: 0,
      }),
    );
    await this.recordEvent(
      tx,
      subscription,
      SubscriptionEventType.INVOICE_CREATED,
      {
        metadata: {
          invoice_id: invoice.id,
          amount: input.amount,
          period_start: input.period.start,
          period_end: input.period.end,
          due_at: input.dueAt,
          trigger,
        },
      },
      ctx.user,
    );
    return invoice;
  }

  private async recordEvent(
    tx: Pick<BillingTx, 'events'>,
    subscription: Pick<Subscription, 'id' | 'store_id'>,
    type: SubscriptionEventType,
    fields: EventFields,
    actor: AuthUser | null | undefined,
  ): Promise<void> {
    await tx.events.save(
      tx.events.create({
        subscription_id: subscription.id,
        store_id: subscription.store_id,
        type,
        from_status: fields.from_status ?? null,
        to_status: fields.to_status ?? null,
        from_plan_id: fields.from_plan_id ?? null,
        to_plan_id: fields.to_plan_id ?? null,
        actor_user_id: actor?.id ?? null,
        reason: fields.reason?.slice(0, 300) ?? null,
        // Mesmo filtro da auditoria: nada de tokens/segredos no histórico
        metadata: fields.metadata
          ? (sanitizeForAudit(fields.metadata) as Record<string, unknown>)
          : null,
      }),
    );
  }

  /** Evento fora de transação (sincronização com o provedor, checkout). */
  private recordEventNow(
    subscription: Pick<Subscription, 'id' | 'store_id'>,
    type: SubscriptionEventType,
    fields: EventFields,
    actor: AuthUser | null | undefined,
  ): Promise<void> {
    return this.recordEvent(
      { events: this.events },
      subscription,
      type,
      fields,
      actor,
    );
  }

  private async auditLifecycle(
    subscription: Subscription,
    result: Exclude<LifecycleStepResult, null>,
  ): Promise<void> {
    await this.audit.record({
      actor: null,
      scope: 'SYSTEM',
      storeId: subscription.store_id,
      action: `subscription.lifecycle.${result}`,
      targetType: 'subscription',
      targetId: subscription.id,
      metadata: { status: subscription.status },
    });
  }

  /**
   * Interrompe a cobrança recorrente no provedor (cancelamento agendado ou concluído). Melhor
   * esforço: falha vira evento PROVIDER_SYNC_FAILED + auditoria, e a rotina tenta de novo quando a
   * assinatura for cancelada no fim do período.
   */
  private async syncProviderCancellation(
    subscription: Subscription,
    ctx: BillingActor,
  ): Promise<void> {
    const providerId = subscription.provider_subscription_id;
    if (
      subscription.billing_provider !== 'MERCADO_PAGO' ||
      !providerId ||
      subscription.provider_status === 'cancelled'
    ) {
      return;
    }
    try {
      const provider = this.providers.forCode('MERCADO_PAGO');
      if (!provider?.online) {
        throw new Error('MP_SAAS_ACCESS_TOKEN não configurado');
      }
      await provider.cancelSubscription(providerId);
      const previous = subscription.provider_status;
      await this.subscriptions.update(
        {
          id: subscription.id,
          store_id: subscription.store_id,
          provider_subscription_id: providerId,
        },
        { provider_status: 'cancelled' },
      );
      subscription.provider_status = 'cancelled';
      await this.recordEventNow(
        subscription,
        SubscriptionEventType.PROVIDER_STATUS_CHANGED,
        {
          metadata: {
            from: previous,
            to: 'cancelled',
            provider_subscription_id: providerId,
          },
        },
        ctx.user,
      );
    } catch (error) {
      await this.providerSyncFailed(subscription, 'cancel', error, ctx);
    }
  }

  /** Troca de plano com cobrança automática ativa: novo valor ou (outra periodicidade/gratuito) nova autorização. */
  private async syncProviderPlan(
    subscription: Subscription,
    from: Plan,
    to: Plan,
    ctx: BillingActor,
  ): Promise<void> {
    const providerId = subscription.provider_subscription_id;
    if (
      subscription.billing_provider !== 'MERCADO_PAGO' ||
      !providerId ||
      subscription.provider_status !== 'authorized'
    ) {
      return;
    }
    if (!isPaidPlan(to) || to.billing_interval !== from.billing_interval) {
      await this.syncProviderCancellation(subscription, ctx);
      return;
    }
    if (Number(to.price) === Number(from.price)) return;
    try {
      const provider = this.providers.forCode('MERCADO_PAGO');
      if (!provider?.online) {
        throw new Error('MP_SAAS_ACCESS_TOKEN não configurado');
      }
      await provider.updateAmount(
        providerId,
        Number(to.price),
        to.currency || 'BRL',
      );
    } catch (error) {
      await this.providerSyncFailed(subscription, 'update_amount', error, ctx);
    }
  }

  private async providerSyncFailed(
    subscription: Subscription,
    action: string,
    error: unknown,
    ctx: BillingActor,
  ): Promise<void> {
    const { message } = describeProviderError(error);
    this.logger.warn(
      `Assinatura #${subscription.id}: falha ao sincronizar com o Mercado Pago (${action}): ${message}`,
    );
    try {
      await this.recordEventNow(
        subscription,
        SubscriptionEventType.PROVIDER_SYNC_FAILED,
        { metadata: { action, error: message } },
        ctx.user,
      );
    } catch (recordError) {
      this.logger.error(
        `Assinatura #${subscription.id}: evento de falha não gravado: ${(recordError as Error).message}`,
      );
    }
    await this.audit.record({
      actor: ctx.user,
      scope: auditScopeOf(ctx),
      storeId: subscription.store_id,
      action: 'subscription.provider_sync',
      targetType: 'subscription',
      targetId: subscription.id,
      result: 'FAILURE',
      metadata: { action, error: message },
      request: ctx.request,
    });
  }
}
