import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Not, Repository, type FindOptionsWhere } from 'typeorm';
import { likeContains, pageRequest } from '../store/dto/store-list-query.dto';
import type { Paginated } from '../store/store-presenter';
import {
  storeAccessState,
  type StoreAccessState,
} from '../tenancy/store-access';
import type { TenantContext } from '../tenancy/tenant-context';
import {
  presentEvent,
  presentInvoice,
  presentPlan,
  presentPublicPlan,
  presentStoreInvoice,
  presentStoreSubscription,
  presentStorageUsage,
  presentStoreSummary,
  presentSubscription,
  type InvoiceView,
  type PlanView,
  type PublicPlanView,
  type StoreInvoiceView,
  type StorageUsageView,
  type StoreSubscriptionView,
  type StoreSummaryView,
  type SubscriptionEventView,
  type SubscriptionView,
} from './billing-presenter';
import type {
  InvoiceListQueryDto,
  SubscriptionListQueryDto,
} from './dto/subscription.dto';
import type { PlanFeatures } from './entities/plan.entity';
import { SubscriptionEvent } from './entities/subscription-event.entity';
import { SubscriptionInvoice } from './entities/subscription-invoice.entity';
import {
  Subscription,
  SubscriptionStatus,
  type BillingProviderCode,
} from './entities/subscription.entity';
import { PlanLimitsService } from './plan-limits.service';
import {
  limitsOf,
  normalizeFeatures,
  type PlanLimits,
  type PlanUsage,
} from './plan-rules';
import { BillingProvidersService } from './providers/billing-providers.service';
import { SUBSCRIPTION_NOT_FOUND_MESSAGE } from './subscriptions.service';

/** Faturas recentes no painel da loja. */
export const STORE_RECENT_INVOICES = 12;
/** Eventos e faturas no detalhe do superpainel. */
export const DETAIL_HISTORY_LIMIT = 100;

/** GET /store/subscription */
export interface StoreSubscriptionOverview {
  plan: PublicPlanView | null;
  /** Assinatura vigente ou, se não houver, a última cancelada (null se nunca houve). */
  subscription: StoreSubscriptionView | null;
  usage: PlanUsage;
  /** Limites do plano vigente (null = sem assinatura vigente; limite null = ilimitado). */
  limits: PlanLimits | null;
  /** Armazenamento das imagens da loja × limite do plano vigente (max_storage_mb). */
  storage: StorageUsageView;
  features: Required<PlanFeatures>;
  invoices: StoreInvoiceView[];
  access: StoreAccessState;
  billing: {
    /** Provedor configurado na plataforma (SAAS_BILLING_PROVIDER). */
    configured_provider: BillingProviderCode;
    /** POST /store/subscription/checkout disponível. */
    online_checkout_available: boolean;
  };
}

export type PlatformSubscriptionItem = SubscriptionView & {
  store: StoreSummaryView | null;
  plan: Pick<
    PlanView,
    'id' | 'code' | 'name' | 'price' | 'billing_interval' | 'status'
  > | null;
};

export type PlatformSubscriptionDetail = SubscriptionView & {
  store: StoreSummaryView | null;
  plan: PlanView | null;
  usage: PlanUsage;
  /** Limites do plano desta assinatura; null quando ela está cancelada (não vale mais para a loja). */
  limits: PlanLimits | null;
  /** Armazenamento das imagens da loja × limite do plano desta assinatura (null se cancelada). */
  storage: StorageUsageView;
  /** Situação efetiva da loja hoje, pela assinatura vigente dela (não pela consultada). */
  access: StoreAccessState | null;
  events: SubscriptionEventView[];
  invoices: InvoiceView[];
};

export type PlatformInvoiceItem = InvoiceView & {
  store: StoreSummaryView | null;
};

/**
 * Leituras da cobrança: painel da loja (sempre da loja do contexto) e listas/detalhes do superpainel.
 * Respostas montadas pelos presenters (lista de campos permitidos).
 */
@Injectable()
export class BillingQueriesService {
  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(SubscriptionInvoice)
    private readonly invoices: Repository<SubscriptionInvoice>,
    @InjectRepository(SubscriptionEvent)
    private readonly events: Repository<SubscriptionEvent>,
    private readonly planLimits: PlanLimitsService,
    private readonly providers: BillingProvidersService,
  ) {}

  /** Plano, assinatura, uso e limites, faturas recentes e situação da loja do contexto. */
  async storeOverview(
    tenant: TenantContext,
    now: Date = new Date(),
  ): Promise<StoreSubscriptionOverview> {
    const storeId = tenant.storeId;
    const subscription = await this.currentOrLast(storeId);
    const [usage, storage, invoices] = await Promise.all([
      this.planLimits.usage(storeId, now),
      this.planLimits.storageUsage(storeId),
      this.invoices.find({
        where: { store_id: storeId },
        order: { created_at: 'DESC', id: 'DESC' },
        take: STORE_RECENT_INVOICES,
      }),
    ]);
    const plan = subscription?.plan ?? null;
    const current =
      subscription && subscription.status !== SubscriptionStatus.CANCELED
        ? subscription
        : null;
    return {
      plan: plan ? presentPublicPlan(plan) : null,
      subscription: subscription
        ? presentStoreSubscription(subscription)
        : null,
      usage,
      limits: current && plan ? limitsOf(plan) : null,
      storage: presentStorageUsage(
        storage,
        current && plan ? (plan.max_storage_mb ?? null) : null,
      ),
      features: normalizeFeatures(current ? plan?.features : null),
      invoices: invoices.map(presentStoreInvoice),
      access: storeAccessState(tenant.store, subscription, now),
      billing: {
        configured_provider: this.providers.configuredCode(),
        online_checkout_available: this.providers.onlineCheckoutAvailable(),
      },
    };
  }

  /** GET /platform/subscriptions: ?status=&plan_id=&search= (nome/slug da loja) &page=&pageSize= */
  async listSubscriptions(
    query: SubscriptionListQueryDto = {},
  ): Promise<Paginated<PlatformSubscriptionItem>> {
    const { search, page, pageSize, offset } = pageRequest(query);
    const base: FindOptionsWhere<Subscription> = {};
    if (query.status) base.status = query.status;
    if (query.plan_id) base.plan_id = query.plan_id;
    const where = search
      ? [
          { ...base, store: { name: ILike(likeContains(search)) } },
          { ...base, store: { slug: ILike(likeContains(search)) } },
        ]
      : base;

    const [rows, total] = await this.subscriptions.findAndCount({
      where,
      relations: { store: true, plan: true },
      order: { id: 'DESC' },
      skip: offset,
      take: pageSize,
    });
    return {
      items: rows.map((row) => ({
        ...presentSubscription(row),
        store: row.store ? presentStoreSummary(row.store) : null,
        plan: row.plan
          ? {
              id: row.plan.id,
              code: row.plan.code,
              name: row.plan.name,
              price: Number(row.plan.price),
              billing_interval: row.plan.billing_interval,
              status: row.plan.status,
            }
          : null,
      })),
      total,
      page,
      pageSize,
    };
  }

  /** GET /platform/subscriptions/:id: loja resumida, plano, uso, situação, eventos e faturas. */
  async subscriptionDetail(
    id: number,
    now: Date = new Date(),
  ): Promise<PlatformSubscriptionDetail> {
    const subscription = await this.subscriptions.findOne({
      where: { id },
      relations: { store: true, plan: true },
    });
    if (!subscription) {
      throw new NotFoundException(SUBSCRIPTION_NOT_FOUND_MESSAGE);
    }
    const storeId = subscription.store_id;
    const [events, invoices, usage, storage, storeCurrent] = await Promise.all([
      this.events.find({
        where: { subscription_id: id, store_id: storeId },
        relations: { actor: true },
        order: { id: 'DESC' },
        take: DETAIL_HISTORY_LIMIT,
      }),
      this.invoices.find({
        where: { subscription_id: id, store_id: storeId },
        order: { period_start: 'DESC', id: 'DESC' },
        take: DETAIL_HISTORY_LIMIT,
      }),
      this.planLimits.usage(storeId, now),
      this.planLimits.storageUsage(storeId),
      // A situação da loja vem da assinatura que vale para ela, não da consultada (pode ser uma antiga)
      this.currentOrLast(storeId),
    ]);
    const plan = subscription.plan ?? null;
    // Só a assinatura vigente (não cancelada; no máximo uma por loja) define os limites em vigor
    const inForce = subscription.status !== SubscriptionStatus.CANCELED;
    return {
      ...presentSubscription(subscription),
      store: subscription.store
        ? presentStoreSummary(subscription.store)
        : null,
      plan: plan ? presentPlan(plan) : null,
      usage,
      limits: inForce && plan ? limitsOf(plan) : null,
      storage: presentStorageUsage(
        storage,
        inForce && plan ? (plan.max_storage_mb ?? null) : null,
      ),
      access: subscription.store
        ? storeAccessState(subscription.store, storeCurrent, now)
        : null,
      events: events.map(presentEvent),
      invoices: invoices.map(presentInvoice),
    };
  }

  /** GET /platform/invoices: ?status=&search= (nome/slug da loja) &page=&pageSize= */
  async listInvoices(
    query: InvoiceListQueryDto = {},
  ): Promise<Paginated<PlatformInvoiceItem>> {
    const { search, page, pageSize, offset } = pageRequest(query);
    const base: FindOptionsWhere<SubscriptionInvoice> = {};
    if (query.status) base.status = query.status;
    const where = search
      ? [
          { ...base, store: { name: ILike(likeContains(search)) } },
          { ...base, store: { slug: ILike(likeContains(search)) } },
        ]
      : base;
    const [rows, total] = await this.invoices.findAndCount({
      where,
      relations: { store: true },
      order: { due_at: 'DESC', id: 'DESC' },
      skip: offset,
      take: pageSize,
    });
    return {
      items: rows.map((row) => ({
        ...presentInvoice(row),
        store: row.store ? presentStoreSummary(row.store) : null,
      })),
      total,
      page,
      pageSize,
    };
  }

  /** Assinatura vigente ou, se não houver, a última cancelada (com o plano). */
  private async currentOrLast(storeId: number): Promise<Subscription | null> {
    const current = await this.subscriptions.findOne({
      where: { store_id: storeId, status: Not(SubscriptionStatus.CANCELED) },
      relations: { plan: true },
      order: { id: 'DESC' },
    });
    if (current) return current;
    return this.subscriptions.findOne({
      where: { store_id: storeId },
      relations: { plan: true },
      order: { id: 'DESC' },
    });
  }
}
