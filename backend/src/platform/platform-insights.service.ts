import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Plan } from '../billing/entities/plan.entity';
import { SubscriptionEvent } from '../billing/entities/subscription-event.entity';
import {
  InvoiceStatus,
  SubscriptionInvoice,
} from '../billing/entities/subscription-invoice.entity';
import {
  Subscription,
  SubscriptionStatus,
} from '../billing/entities/subscription.entity';
import { UNPAID_INVOICE_STATUSES } from '../billing/subscription-rules';
import { Order } from '../orders/entities/order.entity';
import { storeTimeZone } from '../orders/order-rules';
import { OrderStatus, PaymentStatus } from '../orders/order.enums';
import { Store, StoreAccountStatus } from '../store/entities/store.entity';
import { platformAccessTokenConfigured } from '../store/store-rules';
import { TenantService } from '../tenancy/tenant.service';
import { UserRole } from '../users/entities/user.entity';
import type { FinanceQueryDto } from './dto/platform-finance.dto';
import {
  ALERT_WINDOWS,
  buildAlerts,
  buildPlatformMoney,
  CHURN_METHODOLOGY,
  computeArr,
  computeMonthlyChurn,
  computeMrr,
  countByKey,
  DAY_MS,
  invoicesByStatus,
  lastMonthBuckets,
  monthlyCounts,
  parseFinancePeriod,
  planDistribution,
  summarizeDelinquency,
  topStoresByGmv,
  type AlertSourceRows,
  type DelinquentStoreRow,
  type MonthBucket,
  type MonthCountRow,
  type OrdersMonthRow,
  type OrdersTotalsRow,
  type PlanStatusRow,
  type RevenueMonthRow,
  type RevenueTotalsRow,
  type StoreGmvRow,
  type StoreRefRow,
  type SubscriptionHistoryEvent,
} from './metrics';

/** Meses das séries do dashboard e do churn. */
export const DASHBOARD_MONTHS = 12;
export const CHURN_MONTHS = 6;
/** Linhas por tipo de alerta (o dashboard não vira uma lista sem fim). */
export const ALERT_ROWS_LIMIT = 50;
export const TOP_STORES_LIMIT = 10;
/** Assinatura cancelada com a autorização do Mercado Pago ainda não cancelada lá (segue cobrando). */
const PROVIDER_STILL_ACTIVE_SQL = `(sub.billing_provider = 'MERCADO_PAGO' AND sub.provider_subscription_id IS NOT NULL AND sub.provider_status IS DISTINCT FROM 'cancelled')`;

const STORE_STATUSES = Object.values(StoreAccountStatus);
const SUBSCRIPTION_STATUSES = Object.values(SubscriptionStatus);

/** Mês ("AAAA-MM") de uma coluna timestamptz no fuso da plataforma. */
const monthOf = (column: string) =>
  `to_char(${column} AT TIME ZONE CAST(:tz AS text), 'YYYY-MM')`;

/**
 * orders.created_at é "timestamp sem fuso" (schema da versão de loja única): o valor gravado é o
 * relógio da sessão do PostgreSQL. ::timestamptz o interpreta nesse mesmo fuso, como na gravação.
 */
const ORDER_CREATED_AT = 'o.created_at::timestamptz';

/**
 * Indicadores do superpainel: dashboard e financeiro. As consultas só agregam no banco (sem N+1);
 * todos os cálculos (MRR, ARR, churn, séries, alertas) ficam nas funções puras de metrics.ts.
 * O volume das lojas (GMV, tabela orders) e a receita da plataforma (subscription_invoices) vêm de
 * consultas e blocos SEPARADOS e nunca são somados.
 */
@Injectable()
export class PlatformInsightsService {
  constructor(
    @InjectRepository(Store)
    private readonly stores: Repository<Store>,
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(SubscriptionEvent)
    private readonly events: Repository<SubscriptionEvent>,
    @InjectRepository(SubscriptionInvoice)
    private readonly invoices: Repository<SubscriptionInvoice>,
    @InjectRepository(Plan)
    private readonly plans: Repository<Plan>,
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
    private readonly tenants: TenantService,
  ) {}

  /** GET /platform/dashboard */
  async dashboard(now: Date = new Date()) {
    const timeZone = storeTimeZone();
    const buckets = lastMonthBuckets(now, timeZone, DASHBOARD_MONTHS);
    const months = buckets.map((bucket) => bucket.month);
    const churnBuckets = buckets.slice(-CHURN_MONTHS);
    const windowStart = buckets[0].start;

    const [
      storeRows,
      newStoreRows,
      subscriptionRows,
      planRows,
      orderTotals,
      orderMonths,
      revenueTotals,
      revenueMonths,
      churn,
      alerts,
    ] = await Promise.all([
      this.stores
        .createQueryBuilder('s')
        .select('s.account_status', 'key')
        .addSelect('COUNT(*)', 'count')
        .groupBy('s.account_status')
        .getRawMany<{ key: string; count: string }>(),
      this.stores
        .createQueryBuilder('s')
        .select(monthOf('s.created_at'), 'month')
        .addSelect('COUNT(*)', 'count')
        .where('s.created_at >= :start', { start: windowStart })
        .setParameter('tz', timeZone)
        .groupBy('month')
        .getRawMany<MonthCountRow>(),
      this.subscriptions
        .createQueryBuilder('sub')
        .select('sub.status', 'key')
        .addSelect('COUNT(*)', 'count')
        .groupBy('sub.status')
        .getRawMany<{ key: string; count: string }>(),
      this.planStatusRows(),
      this.orderTotals(),
      this.ordersByMonth(
        windowStart,
        buckets[buckets.length - 1].end,
        timeZone,
      ),
      this.revenueTotals(),
      this.revenueByMonth(
        windowStart,
        buckets[buckets.length - 1].end,
        timeZone,
      ),
      this.churn(churnBuckets, now),
      this.alerts(now, timeZone),
    ]);

    const byStatus = countByKey(STORE_STATUSES, storeRows);
    const mrr = computeMrr(planRows);
    const money = buildPlatformMoney({
      months,
      orders: { totals: orderTotals, byMonth: orderMonths },
      invoices: { totals: revenueTotals, byMonth: revenueMonths },
    });
    const subscriptionsByStatus = countByKey(
      SUBSCRIPTION_STATUSES,
      subscriptionRows,
    );

    return {
      generated_at: now,
      time_zone: timeZone,
      currency: 'BRL',
      stores: {
        total: STORE_STATUSES.reduce(
          (sum, status) => sum + byStatus[status],
          0,
        ),
        by_status: byStatus,
        new_by_month: monthlyCounts(months, newStoreRows),
      },
      subscriptions: {
        by_status: subscriptionsByStatus,
        /** Não canceladas. */
        current: SUBSCRIPTION_STATUSES.filter(
          (status) => status !== SubscriptionStatus.CANCELED,
        ).reduce((sum, status) => sum + subscriptionsByStatus[status], 0),
      },
      mrr,
      arr: computeArr(mrr),
      churn: { months: churn, methodology: CHURN_METHODOLOGY },
      orders: money.orders,
      gmv: money.gmv,
      platform_revenue: money.platform_revenue,
      plans: planDistribution(planRows),
      alerts,
    };
  }

  /** GET /platform/finance?from=&to= (padrão: os últimos 12 meses do calendário). */
  async finance(query: FinanceQueryDto, now: Date = new Date()) {
    const timeZone = storeTimeZone();
    const period = parseFinancePeriod(query.from, query.to, now, timeZone);
    if (!period.ok) throw new BadRequestException(period.message);
    const { start, end } = period;

    const [
      revenueTotals,
      revenueMonths,
      invoiceStatusRows,
      planRows,
      orderTotals,
      orderMonths,
      topStores,
      delinquentRows,
    ] = await Promise.all([
      this.revenueTotals(start, end),
      this.revenueByMonth(start, end, timeZone),
      this.invoices
        .createQueryBuilder('i')
        .select('i.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .addSelect('COALESCE(SUM(i.amount), 0)', 'amount')
        .where('i.due_at >= :start AND i.due_at < :end', { start, end })
        .groupBy('i.status')
        .getRawMany<{ status: string; count: string; amount: string }>(),
      this.planStatusRows(),
      this.orderTotals(start, end),
      this.ordersByMonth(start, end, timeZone),
      this.orders
        .createQueryBuilder('o')
        .innerJoin(Store, 'st', 'st.id = o.store_id')
        .select('st.id', 'store_id')
        .addSelect('st.slug', 'slug')
        .addSelect('st.name', 'name')
        .addSelect('COALESCE(SUM(o.total_price), 0)', 'gmv')
        .addSelect('COUNT(*)', 'paid_orders')
        .where('o.status <> :canceled', { canceled: OrderStatus.CANCELED })
        .andWhere('o.payment_status = :paid', { paid: PaymentStatus.PAID })
        .andWhere(`${ORDER_CREATED_AT} >= CAST(:start AS timestamptz)`, {
          start,
        })
        .andWhere(`${ORDER_CREATED_AT} < CAST(:end AS timestamptz)`, { end })
        .groupBy('st.id')
        .orderBy('COALESCE(SUM(o.total_price), 0)', 'DESC')
        .addOrderBy('st.id', 'ASC')
        .limit(TOP_STORES_LIMIT)
        .getRawMany<StoreGmvRow>(),
      this.invoices
        .createQueryBuilder('i')
        .innerJoin(Store, 'st', 'st.id = i.store_id')
        .select('st.id', 'store_id')
        .addSelect('st.slug', 'slug')
        .addSelect('st.name', 'name')
        .addSelect('COUNT(*)', 'invoices')
        .addSelect('COALESCE(SUM(i.amount), 0)', 'amount')
        .addSelect('MIN(i.due_at)', 'oldest_due_at')
        .where('i.status IN (:...unpaid)', {
          unpaid: [...UNPAID_INVOICE_STATUSES],
        })
        .andWhere('i.due_at < :now', { now })
        .groupBy('st.id')
        .getRawMany<DelinquentStoreRow>(),
    ]);

    const mrr = computeMrr(planRows);
    const money = buildPlatformMoney({
      months: period.months,
      orders: { totals: orderTotals, byMonth: orderMonths },
      invoices: { totals: revenueTotals, byMonth: revenueMonths },
      period: true,
    });

    return {
      generated_at: now,
      time_zone: timeZone,
      currency: 'BRL',
      period: { from: period.from, to: period.to, days: period.days },
      platform_revenue: money.platform_revenue,
      invoices_by_status: {
        items: invoicesByStatus(invoiceStatusRows),
        methodology:
          'Faturas da assinatura com vencimento (due_at) dentro do período, por situação.',
      },
      mrr,
      arr: computeArr(mrr),
      gmv: money.gmv,
      top_stores_by_gmv: topStoresByGmv(topStores),
      delinquency: summarizeDelinquency(delinquentRows),
    };
  }

  // ---------------------------------------------------------------------------
  // Consultas
  // ---------------------------------------------------------------------------

  /** Assinaturas não canceladas por plano e situação (MRR e distribuição por plano). */
  private planStatusRows(): Promise<PlanStatusRow[]> {
    return this.subscriptions
      .createQueryBuilder('sub')
      .innerJoin('sub.plan', 'p')
      .select('p.id', 'plan_id')
      .addSelect('p.code', 'code')
      .addSelect('p.name', 'name')
      .addSelect('p.price', 'price')
      .addSelect('p.billing_interval', 'billing_interval')
      .addSelect('sub.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('sub.status <> :canceled', {
        canceled: SubscriptionStatus.CANCELED,
      })
      .groupBy('p.id')
      .addGroupBy('sub.status')
      .getRawMany<PlanStatusRow>();
  }

  /** Pedidos não cancelados, pagos e GMV (desde o início ou no período). */
  private async orderTotals(
    start?: Date,
    end?: Date,
  ): Promise<OrdersTotalsRow | null> {
    const qb = this.orders
      .createQueryBuilder('o')
      .select('COUNT(*)', 'orders')
      .addSelect(
        'COUNT(*) FILTER (WHERE o.payment_status = :paid)',
        'paid_orders',
      )
      .addSelect(
        'COALESCE(SUM(o.total_price) FILTER (WHERE o.payment_status = :paid), 0)',
        'gmv',
      )
      .where('o.status <> :canceled', { canceled: OrderStatus.CANCELED })
      .setParameter('paid', PaymentStatus.PAID);
    if (start && end) {
      qb.andWhere(`${ORDER_CREATED_AT} >= CAST(:start AS timestamptz)`, {
        start,
      }).andWhere(`${ORDER_CREATED_AT} < CAST(:end AS timestamptz)`, { end });
    }
    return (await qb.getRawOne<OrdersTotalsRow>()) ?? null;
  }

  private ordersByMonth(
    start: Date,
    end: Date,
    timeZone: string,
  ): Promise<OrdersMonthRow[]> {
    return this.orders
      .createQueryBuilder('o')
      .select(monthOf(ORDER_CREATED_AT), 'month')
      .addSelect('COUNT(*)', 'orders')
      .addSelect(
        'COUNT(*) FILTER (WHERE o.payment_status = :paid)',
        'paid_orders',
      )
      .addSelect(
        'COALESCE(SUM(o.total_price) FILTER (WHERE o.payment_status = :paid), 0)',
        'gmv',
      )
      .where('o.status <> :canceled', { canceled: OrderStatus.CANCELED })
      .andWhere(`${ORDER_CREATED_AT} >= CAST(:start AS timestamptz)`, {
        start,
      })
      .andWhere(`${ORDER_CREATED_AT} < CAST(:end AS timestamptz)`, { end })
      .setParameters({ paid: PaymentStatus.PAID, tz: timeZone })
      .groupBy('month')
      .getRawMany<OrdersMonthRow>();
  }

  /** Faturas da assinatura PAGAS (receita da plataforma), pela data do pagamento. */
  private async revenueTotals(
    start?: Date,
    end?: Date,
  ): Promise<RevenueTotalsRow | null> {
    const qb = this.invoices
      .createQueryBuilder('i')
      .select('COUNT(*)', 'invoices')
      .addSelect('COALESCE(SUM(i.amount), 0)', 'revenue')
      .where('i.status = :paidInvoice', { paidInvoice: InvoiceStatus.PAID });
    if (start && end) {
      qb.andWhere('i.paid_at >= :start AND i.paid_at < :end', { start, end });
    }
    return (await qb.getRawOne<RevenueTotalsRow>()) ?? null;
  }

  private revenueByMonth(
    start: Date,
    end: Date,
    timeZone: string,
  ): Promise<RevenueMonthRow[]> {
    return this.invoices
      .createQueryBuilder('i')
      .select(monthOf('i.paid_at'), 'month')
      .addSelect('COUNT(*)', 'invoices')
      .addSelect('COALESCE(SUM(i.amount), 0)', 'revenue')
      .where('i.status = :paidInvoice', { paidInvoice: InvoiceStatus.PAID })
      .andWhere('i.paid_at >= :start AND i.paid_at < :end', { start, end })
      .setParameter('tz', timeZone)
      .groupBy('month')
      .getRawMany<RevenueMonthRow>();
  }

  /**
   * Churn dos últimos meses: histórico de situação/plano (subscription_events) das assinaturas que
   * ainda existiam no início da janela (as canceladas antes dela não influenciam).
   */
  private async churn(buckets: MonthBucket[], now: Date) {
    const start = buckets[0].start;
    const end = buckets[buckets.length - 1].end;
    const [events, plans] = await Promise.all([
      this.events
        .createQueryBuilder('e')
        .select('e.id', 'id')
        .addSelect('e.subscription_id', 'subscription_id')
        .addSelect('e.type', 'type')
        .addSelect('e.from_status', 'from_status')
        .addSelect('e.to_status', 'to_status')
        .addSelect('e.to_plan_id', 'to_plan_id')
        .addSelect('e.created_at', 'created_at')
        .where('(e.to_status IS NOT NULL OR e.to_plan_id IS NOT NULL)')
        .andWhere('e.created_at < :end', { end })
        .andWhere(
          'e.subscription_id IN (SELECT "live"."id" FROM "subscriptions" "live" WHERE "live"."canceled_at" IS NULL OR "live"."canceled_at" >= :start)',
          { start },
        )
        .orderBy('e.created_at', 'ASC')
        .addOrderBy('e.id', 'ASC')
        .getRawMany<SubscriptionHistoryEvent>(),
      this.plans.find({ select: { id: true, price: true } }),
    ]);
    const prices = new Map(
      plans.map((plan) => [plan.id, Number(plan.price) || 0]),
    );
    return computeMonthlyChurn(
      events.map((event) => ({
        ...event,
        id: Number(event.id),
        subscription_id: Number(event.subscription_id),
        to_plan_id:
          event.to_plan_id === null || event.to_plan_id === undefined
            ? null
            : Number(event.to_plan_id),
      })),
      prices,
      buckets,
      now,
    );
  }

  /** Fontes dos alertas (uma consulta agregada por tipo, limitada). */
  private async alerts(now: Date, timeZone: string) {
    const graceLimit = new Date(
      now.getTime() + ALERT_WINDOWS.graceEndingDays * DAY_MS,
    );
    const trialLimit = new Date(
      now.getTime() + ALERT_WINDOWS.trialEndingDays * DAY_MS,
    );
    const inactive = StoreAccountStatus.INACTIVE;

    const subscriptionAlerts = () =>
      this.subscriptions
        .createQueryBuilder('sub')
        .innerJoin(Store, 'st', 'st.id = sub.store_id')
        .select('st.id', 'store_id')
        .addSelect('st.slug', 'slug')
        .addSelect('st.name', 'name')
        .where('st.account_status <> :inactive', { inactive });

    const [
      graceEnding,
      suspendedSubscriptions,
      trialsEnding,
      suspendedStores,
      refundPending,
      failedInvoices,
      storesWithoutAdmin,
      onlinePaymentsWithoutCredentials,
      defaultStore,
      inactiveStoresBilled,
      canceledStillBilled,
    ] = await Promise.all([
      subscriptionAlerts()
        .addSelect('sub.grace_period_ends_at', 'grace_period_ends_at')
        .andWhere('sub.status = :pastDue', {
          pastDue: SubscriptionStatus.PAST_DUE,
        })
        .andWhere('sub.grace_period_ends_at IS NOT NULL')
        .andWhere('sub.grace_period_ends_at <= :graceLimit', { graceLimit })
        .orderBy('sub.grace_period_ends_at', 'ASC')
        .limit(ALERT_ROWS_LIMIT)
        .getRawMany<StoreRefRow & { grace_period_ends_at: Date }>(),
      subscriptionAlerts()
        .addSelect('sub.suspended_at', 'suspended_at')
        .addSelect('sub.suspended_by', 'suspended_by')
        .andWhere('sub.status = :suspended', {
          suspended: SubscriptionStatus.SUSPENDED,
        })
        .orderBy('sub.suspended_at', 'ASC', 'NULLS LAST')
        .limit(ALERT_ROWS_LIMIT)
        .getRawMany<
          StoreRefRow & {
            suspended_at: Date | null;
            suspended_by: string | null;
          }
        >(),
      subscriptionAlerts()
        .addSelect('sub.trial_ends_at', 'trial_ends_at')
        .andWhere('sub.status = :trialing', {
          trialing: SubscriptionStatus.TRIALING,
        })
        .andWhere('sub.trial_ends_at IS NOT NULL')
        .andWhere('sub.trial_ends_at <= :trialLimit', { trialLimit })
        .orderBy('sub.trial_ends_at', 'ASC')
        .limit(ALERT_ROWS_LIMIT)
        .getRawMany<StoreRefRow & { trial_ends_at: Date }>(),
      this.stores
        .createQueryBuilder('st')
        .select('st.id', 'store_id')
        .addSelect('st.slug', 'slug')
        .addSelect('st.name', 'name')
        .addSelect('st.status_reason', 'status_reason')
        .where('st.account_status = :suspendedStore', {
          suspendedStore: StoreAccountStatus.SUSPENDED,
        })
        .orderBy('st.status_changed_at', 'DESC', 'NULLS LAST')
        .limit(ALERT_ROWS_LIMIT)
        .getRawMany<StoreRefRow & { status_reason: string | null }>(),
      // Estorno pendente é dinheiro do cliente: entra mesmo em loja desativada
      this.orders
        .createQueryBuilder('o')
        .innerJoin(Store, 'st', 'st.id = o.store_id')
        .select('st.id', 'store_id')
        .addSelect('st.slug', 'slug')
        .addSelect('st.name', 'name')
        .addSelect('COUNT(*)', 'orders')
        .where('o.payment_status = :refundPending', {
          refundPending: PaymentStatus.REFUND_PENDING,
        })
        .groupBy('st.id')
        .orderBy('COUNT(*)', 'DESC')
        .addOrderBy('st.id', 'ASC')
        .limit(ALERT_ROWS_LIMIT)
        .getRawMany<StoreRefRow & { orders: string }>(),
      this.invoices
        .createQueryBuilder('i')
        .innerJoin(Store, 'st', 'st.id = i.store_id')
        .select('st.id', 'store_id')
        .addSelect('st.slug', 'slug')
        .addSelect('st.name', 'name')
        .addSelect('COUNT(*)', 'invoices')
        .addSelect('COALESCE(SUM(i.amount), 0)', 'amount')
        .where('i.status = :failed', { failed: InvoiceStatus.FAILED })
        .andWhere('st.account_status <> :inactive', { inactive })
        .groupBy('st.id')
        .orderBy('COALESCE(SUM(i.amount), 0)', 'DESC')
        .addOrderBy('st.id', 'ASC')
        .limit(ALERT_ROWS_LIMIT)
        .getRawMany<StoreRefRow & { invoices: string; amount: string }>(),
      this.stores
        .createQueryBuilder('st')
        .select('st.id', 'store_id')
        .addSelect('st.slug', 'slug')
        .addSelect('st.name', 'name')
        .addSelect(
          'EXISTS (SELECT 1 FROM "invitations" "inv" WHERE "inv"."store_id" = st.id AND "inv"."role" = :inviteRole AND "inv"."accepted_at" IS NULL AND "inv"."revoked_at" IS NULL AND "inv"."expires_at" > :now)',
          'pending_invitation',
        )
        .where('st.account_status <> :inactive', { inactive })
        .andWhere(
          'NOT EXISTS (SELECT 1 FROM "users" "admin" WHERE "admin"."store_id" = st.id AND "admin"."role" = :adminRole AND "admin"."deleted_at" IS NULL AND "admin"."blocked_at" IS NULL)',
        )
        // Nomes diferentes: o TypeORM reaproveita o mesmo $n para o mesmo nome, e invitations.role é
        // varchar enquanto users.role é enum (um parâmetro só teria tipos inconsistentes no PostgreSQL)
        .setParameters({
          inviteRole: UserRole.ADMIN,
          adminRole: UserRole.ADMIN,
          now,
        })
        .orderBy('st.name', 'ASC')
        .limit(ALERT_ROWS_LIMIT)
        .getRawMany<StoreRefRow & { pending_invitation: boolean }>(),
      this.stores
        .createQueryBuilder('st')
        .innerJoin(
          Subscription,
          'sub',
          'sub.store_id = st.id AND sub.status <> :canceled',
          { canceled: SubscriptionStatus.CANCELED },
        )
        .innerJoin(Plan, 'p', 'p.id = sub.plan_id')
        .select('st.id', 'store_id')
        .addSelect('st.slug', 'slug')
        .addSelect('st.name', 'name')
        .where('st.account_status <> :inactive', { inactive })
        .andWhere(`(p.features ->> 'online_payments') = 'true'`)
        .andWhere('st.mp_access_token_encrypted IS NULL')
        .orderBy('st.name', 'ASC')
        .limit(ALERT_ROWS_LIMIT)
        .getRawMany<StoreRefRow>(),
      this.tenants.defaultStore(),
      // Loja desativada continua com a assinatura (a desativação não cancela nada): com plano pago,
      // a rotina segue cobrando e ela conta nos indicadores. O alerta pede a decisão do operador.
      this.stores
        .createQueryBuilder('st')
        .innerJoin(
          Subscription,
          'sub',
          'sub.store_id = st.id AND sub.status <> :canceledSub',
          { canceledSub: SubscriptionStatus.CANCELED },
        )
        .innerJoin(Plan, 'p', 'p.id = sub.plan_id')
        .select('st.id', 'store_id')
        .addSelect('st.slug', 'slug')
        .addSelect('st.name', 'name')
        .addSelect('sub.status', 'subscription_status')
        .addSelect('p.name', 'plan_name')
        .where('st.account_status = :inactiveStore', {
          inactiveStore: inactive,
        })
        .andWhere('p.price > 0')
        .orderBy('st.status_changed_at', 'DESC', 'NULLS LAST')
        .addOrderBy('st.id', 'ASC')
        .limit(ALERT_ROWS_LIMIT)
        .getRawMany<
          StoreRefRow & {
            subscription_status: string;
            plan_name: string | null;
          }
        >(),
      // Cancelada e ainda cobrada (dinheiro da loja: entra mesmo com a loja desativada): autorização
      // ainda ativa no Mercado Pago e/ou cobranças recebidas depois do cancelamento (últimos 90 dias)
      this.subscriptions
        .createQueryBuilder('sub')
        .innerJoin(Store, 'st', 'st.id = sub.store_id')
        .select('st.id', 'store_id')
        .addSelect('st.slug', 'slug')
        .addSelect('st.name', 'name')
        .addSelect('sub.id', 'subscription_id')
        .addSelect(PROVIDER_STILL_ACTIVE_SQL, 'provider_active')
        .addSelect(
          `(SELECT COUNT(*) FROM "subscription_events" "e" WHERE "e"."subscription_id" = sub.id AND "e"."type" = :afterCancel AND "e"."created_at" >= :reviewSince)`,
          'payments',
        )
        .addSelect(
          `(SELECT COALESCE(SUM(CASE WHEN ("e"."metadata" ->> 'amount') ~ '^[0-9]+(\\.[0-9]+)?$' THEN ("e"."metadata" ->> 'amount')::numeric ELSE 0 END), 0) FROM "subscription_events" "e" WHERE "e"."subscription_id" = sub.id AND "e"."type" = :afterCancel AND "e"."created_at" >= :reviewSince)`,
          'amount',
        )
        .where('sub.status = :canceledStatus', {
          canceledStatus: SubscriptionStatus.CANCELED,
        })
        .andWhere(
          `(${PROVIDER_STILL_ACTIVE_SQL} OR EXISTS (SELECT 1 FROM "subscription_events" "e" WHERE "e"."subscription_id" = sub.id AND "e"."type" = :afterCancel AND "e"."created_at" >= :reviewSince))`,
        )
        .setParameters({
          afterCancel: 'PAYMENT_AFTER_CANCEL',
          reviewSince: new Date(now.getTime() - 90 * DAY_MS),
        })
        .orderBy('sub.canceled_at', 'DESC', 'NULLS LAST')
        .addOrderBy('sub.id', 'DESC')
        .limit(ALERT_ROWS_LIMIT)
        .getRawMany<
          StoreRefRow & {
            subscription_id: number;
            provider_active: boolean;
            payments: string;
            amount: string;
          }
        >(),
    ]);

    const rows: AlertSourceRows = {
      graceEnding,
      suspendedStores,
      suspendedSubscriptions,
      refundPending,
      failedInvoices,
      storesWithoutAdmin,
      trialsEnding,
      onlinePaymentsWithoutCredentials,
      inactiveStoresBilled,
      canceledStillBilled,
      defaultStoreId: defaultStore?.id ?? null,
      platformCredentialsConfigured: platformAccessTokenConfigured(),
    };
    return buildAlerts(rows, now, timeZone);
  }
}
