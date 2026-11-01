import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  In,
  IsNull,
  LessThan,
  LessThanOrEqual,
  MoreThan,
  Not,
  Repository,
} from 'typeorm';
import { SubscriptionInvoice } from './entities/subscription-invoice.entity';
import {
  Subscription,
  SubscriptionStatus,
} from './entities/subscription.entity';
import { UNPAID_INVOICE_STATUSES } from './subscription-rules';
import {
  SubscriptionsService,
  type LifecycleStepResult,
} from './subscriptions.service';

/** Intervalo padrão da rotina de assinaturas (5 min). */
export const DEFAULT_LIFECYCLE_INTERVAL_MS = 300_000;
/** Menor intervalo aceito (evita martelar o banco com um valor errado no .env). */
export const MIN_LIFECYCLE_INTERVAL_MS = 10_000;
/** Assinaturas por passo e por rodada; o restante fica para a rodada seguinte. */
export const LIFECYCLE_BATCH_SIZE = 200;

const logger = new Logger('SubscriptionLifecycle');
let invalidIntervalWarned = false;

/** SAAS_BILLING_INTERVAL_MS (ms; padrão 300000, mínimo 10000). Inválido → padrão com aviso. */
export function lifecycleIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.SAAS_BILLING_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_LIFECYCLE_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    if (!invalidIntervalWarned) {
      invalidIntervalWarned = true;
      logger.warn(
        `SAAS_BILLING_INTERVAL_MS="${raw}" inválido: usando ${DEFAULT_LIFECYCLE_INTERVAL_MS} ms.`,
      );
    }
    return DEFAULT_LIFECYCLE_INTERVAL_MS;
  }
  return Math.max(value, MIN_LIFECYCLE_INTERVAL_MS);
}

export type LifecycleSummary = Record<
  Exclude<LifecycleStepResult, null> | 'errors',
  number
>;

function emptySummary(): LifecycleSummary {
  return {
    activated: 0,
    renewed: 0,
    canceled: 0,
    past_due: 0,
    suspended: 0,
    restored: 0,
    provider_canceled: 0,
    errors: 0,
  };
}

/**
 * Rotina periódica das assinaturas (como o PaymentReconciler): a cada SAAS_BILLING_INTERVAL_MS,
 * 1. fim do teste grátis → ACTIVE (gratuito) ou fatura OPEN do 1º período + ACTIVE;
 * 2. fim do período → CANCELED (cancelamento agendado) ou fatura OPEN do próximo período + avanço;
 * 3. fatura vencida em aberto → PAST_DUE (tolerância = vencimento + platform_settings.grace_period_days);
 * 4. fim da tolerância → SUSPENDED;
 * 5. assinatura cancelada com a cobrança recorrente ainda ativa no provedor (o cancelamento lá falhou)
 *    → nova tentativa de interrompê-la, com intervalo crescente entre as falhas.
 * Cada assinatura é processada na própria transação, travada e conferida de novo: rodar duas vezes
 * (ou em várias instâncias da API) não duplica faturas nem eventos. Uma rodada por vez por instância.
 */
@Injectable()
export class SubscriptionLifecycleService
  implements OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown
{
  private readonly logger = new Logger(SubscriptionLifecycleService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Rodízio dos cancelamentos pendentes no provedor: último id do lote anterior (0 = do começo). */
  private providerCancelCursor = 0;

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(SubscriptionInvoice)
    private readonly invoices: Repository<SubscriptionInvoice>,
    private readonly billing: SubscriptionsService,
  ) {}

  onApplicationBootstrap(): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), lifecycleIntervalMs());
    // Não segura o processo aberto (seed, testes e desligamento)
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  onApplicationShutdown(): void {
    this.stop();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Rodada do timer: erros vão para o log (a próxima rodada tenta de novo). */
  async tick(): Promise<void> {
    try {
      const summary = await this.runOnce();
      const changed = summary
        ? Object.entries(summary).filter(([, count]) => count > 0)
        : [];
      if (changed.length) {
        this.logger.log(
          `Rotina de assinaturas: ${changed.map(([key, count]) => `${key}=${count}`).join(', ')}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Rotina de assinaturas falhou: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Uma rodada completa. null = já havia uma rodada em andamento nesta instância. */
  async runOnce(now: Date = new Date()): Promise<LifecycleSummary | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const summary = emptySummary();
      const graceDays = await this.billing.graceDays();
      await this.each(
        await this.trialCandidates(now),
        (id) => this.billing.processTrialEnd(id, now),
        summary,
      );
      await this.each(
        await this.periodEndCandidates(now),
        (id) => this.billing.processPeriodEnd(id, now),
        summary,
      );
      await this.each(
        await this.overdueCandidates(now),
        (id) => this.billing.processOverdue(id, now, graceDays),
        summary,
      );
      await this.each(
        await this.graceCandidates(now),
        (id) => this.billing.processGraceEnd(id, now),
        summary,
      );
      await this.each(
        await this.providerCancelCandidates(),
        (id) => this.billing.retryProviderCancellation(id, now),
        summary,
      );
      return summary;
    } finally {
      this.running = false;
    }
  }

  /** Uma assinatura com erro não impede as outras (fica no log e volta na próxima rodada). */
  private async each(
    ids: number[],
    step: (id: number) => Promise<LifecycleStepResult>,
    summary: LifecycleSummary,
  ): Promise<void> {
    for (const id of ids) {
      try {
        const result = await step(id);
        if (result) summary[result] += 1;
      } catch (error) {
        summary.errors += 1;
        this.logger.warn(
          `Assinatura #${id}: passo da rotina falhou: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async trialCandidates(now: Date): Promise<number[]> {
    const rows = await this.subscriptions.find({
      where: {
        status: SubscriptionStatus.TRIALING,
        trial_ends_at: LessThanOrEqual(now),
      },
      select: { id: true },
      order: { id: 'ASC' },
      take: LIFECYCLE_BATCH_SIZE,
    });
    return rows.map((row) => row.id);
  }

  private async periodEndCandidates(now: Date): Promise<number[]> {
    const rows = await this.subscriptions.find({
      where: [
        {
          status: In([SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE]),
          current_period_end: LessThanOrEqual(now),
        },
        // Suspensa não renova; só o cancelamento agendado é concluído
        {
          status: SubscriptionStatus.SUSPENDED,
          cancel_at_period_end: true,
          current_period_end: LessThanOrEqual(now),
        },
      ],
      select: { id: true },
      order: { id: 'ASC' },
      take: LIFECYCLE_BATCH_SIZE,
    });
    return rows.map((row) => row.id);
  }

  private async overdueCandidates(now: Date): Promise<number[]> {
    const rows = await this.invoices.find({
      where: {
        status: In(UNPAID_INVOICE_STATUSES),
        due_at: LessThan(now),
        subscription: { status: SubscriptionStatus.ACTIVE },
      },
      // Com join (filtro pela assinatura) + take, o TypeORM pagina por subconsulta DISTINCT e
      // ordena por ela: as colunas do ORDER BY precisam estar no select
      select: { id: true, subscription_id: true, due_at: true },
      order: { due_at: 'ASC', id: 'ASC' },
      take: LIFECYCLE_BATCH_SIZE,
    });
    return [...new Set(rows.map((row) => row.subscription_id))];
  }

  /**
   * Canceladas no Mercado Pago com a autorização ainda não cancelada lá, em rodízio: cada rodada continua
   * depois do último id da anterior e, no fim da lista, completa o lote pelo começo. Sem isso, 200 ou mais
   * falhas permanentes (ainda no intervalo entre tentativas) ocupariam todo lote, e uma assinatura
   * cancelada depois, ainda cobrando, nunca seria tentada.
   */
  private async providerCancelCandidates(): Promise<number[]> {
    const base = {
      status: SubscriptionStatus.CANCELED,
      billing_provider: 'MERCADO_PAGO' as const,
      provider_subscription_id: Not(IsNull()),
    };
    const page = (after: number) =>
      this.subscriptions.find({
        where: [
          { ...base, provider_status: IsNull(), id: MoreThan(after) },
          { ...base, provider_status: Not('cancelled'), id: MoreThan(after) },
        ],
        select: { id: true },
        order: { id: 'ASC' },
        take: LIFECYCLE_BATCH_SIZE,
      });
    const cursor = this.providerCancelCursor;
    const ids = (await page(cursor)).map((row) => row.id);
    if (cursor > 0 && ids.length < LIFECYCLE_BATCH_SIZE) {
      for (const row of await page(0)) {
        if (row.id > cursor || ids.length >= LIFECYCLE_BATCH_SIZE) break;
        ids.push(row.id);
      }
    }
    // Lote cheio: a próxima rodada segue depois do último; senão todas couberam e ela recomeça
    this.providerCancelCursor =
      ids.length >= LIFECYCLE_BATCH_SIZE ? ids[ids.length - 1] : 0;
    return ids;
  }

  private async graceCandidates(now: Date): Promise<number[]> {
    const rows = await this.subscriptions.find({
      where: {
        status: SubscriptionStatus.PAST_DUE,
        grace_period_ends_at: LessThanOrEqual(now),
      },
      select: { id: true },
      order: { id: 'ASC' },
      take: LIFECYCLE_BATCH_SIZE,
    });
    return rows.map((row) => row.id);
  }
}
