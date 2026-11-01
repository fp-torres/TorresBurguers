import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import {
  And,
  Brackets,
  In,
  IsNull,
  LessThan,
  MoreThanOrEqual,
  Not,
  Repository,
  type SelectQueryBuilder,
} from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { isSuperAdmin, type AuthUser } from '../auth/auth-user';
import { expirePendingResetLinksOfStoreTeam } from '../auth/reset-links';
import {
  presentPlan,
  presentStorageUsage,
  presentSubscription,
} from '../billing/billing-presenter';
import {
  Subscription,
  SubscriptionStatus,
} from '../billing/entities/subscription.entity';
import { PlanLimitsService } from '../billing/plan-limits.service';
import { limitsOf } from '../billing/plan-rules';
import { SubscriptionsService } from '../billing/subscriptions.service';
import type { CreateInvitationDto } from '../invitations/dto/create-invitation.dto';
import type { ListInvitationsQueryDto } from '../invitations/dto/list-invitations.dto';
import {
  InvitationsService,
  type CreatedInvitation,
} from '../invitations/invitations.service';
import { Order } from '../orders/entities/order.entity';
import { buildOrdersReport } from '../orders/order-reports';
import {
  addDaysToKey,
  parseReportRange,
  resolveTimeZone,
  startOfDayInZone,
} from '../orders/order-rules';
import { OrderStatus, PaymentStatus } from '../orders/order.enums';
import { likeContains, pageRequest } from '../store/dto/store-list-query.dto';
import { StoreSlugHistory } from '../store/entities/store-slug-history.entity';
import { Store, StoreAccountStatus } from '../store/entities/store.entity';
import type { Paginated } from '../store/store-presenter';
import {
  featuresOf,
  platformAccessTokenConfigured,
} from '../store/store-rules';
import { storeAccessState } from '../tenancy/store-access';
import {
  configuredDefaultStoreSlug,
  STORE_NOT_FOUND_MESSAGE,
  TenantService,
} from '../tenancy/tenant.service';
import { normalizeEmail } from '../users/email';
import { User, UserRole } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  STORE_PROFILE_FIELDS,
  type CreatePlatformStoreDto,
  type PlatformStoreListQueryDto,
  type PlatformStoreTeamQueryDto,
  type StoreMetricsQueryDto,
  type StoreSortField,
  type UpdatePlatformStoreDto,
} from './dto/platform-stores.dto';
import { DAY_MS, toCount, toMoney } from './metrics';
import { numericSearchDigits } from './platform-filters';
import {
  presentPlatformStore,
  presentPlatformUser,
  storeRef,
  userRef,
  type PlatformUserView,
  type StoreRef,
  type UserRef,
} from './platform-presenter';
import { CUSTOM_DOMAIN_NOT_ROUTED_NOTICE } from './store-identity-rules';
import {
  assertCustomDomainAvailable,
  assertSlugAvailable,
  insertNewStore,
  previousSlugOwner,
  profileFrom,
  rethrowStoreConflict,
  retireStoreSlug,
} from './store-provisioning';
import {
  planStoreStatusChange,
  STORE_STATUS_TRANSITIONS,
  storeStatusWarnings,
  type StoreStatusAction,
} from './store-status-rules';

export const PLATFORM_ONLY_MESSAGE =
  'Área exclusiva da administração da plataforma.';
export const OWNER_EMAIL_IN_USE_MESSAGE =
  'Já existe uma conta com o e-mail do responsável. Use outro e-mail: a conta do responsável é criada quando ele aceita o convite.';
export const OWNER_NOT_ELIGIBLE_MESSAGE =
  'O responsável precisa ser um administrador (ADMIN) ativo desta loja: fora da lixeira e não bloqueado.';
export const OWNER_ROLE_REQUIRED_MESSAGE =
  'Quem vai ser o responsável pela loja precisa ter o perfil ADMIN.';
export const STATUS_CHANGED_CONCURRENTLY_MESSAGE =
  'A situação da loja mudou durante a operação. Atualize a página e tente de novo.';

/** Janela dos indicadores recentes da lista e do detalhe. */
export const RECENT_METRICS_DAYS = 30;

export const STORE_METRICS_METHODOLOGY =
  'Pedidos: não cancelados. GMV: pedidos pagos e não cancelados (dinheiro do consumidor para a loja; não é receita da plataforma). "30d": últimos 30 dias contados de agora. Clientes: contas distintas com pedido na loja. Equipe ativa: fora da lixeira e não bloqueada.';

export const STORE_REPORT_METHODOLOGY =
  'Dias do calendário da loja (stores.time_zone). Pedidos: todos os feitos no dia (os cancelados aparecem em by_status). GMV: pedidos pagos e não cancelados — não é receita da plataforma.';

const SORT_COLUMNS: Record<StoreSortField, string> = {
  created_at: 'store.created_at',
  name: 'store.name',
  slug: 'store.slug',
};

/** Campos que o PATCH do superpainel pode alterar (lista de permitidos). */
const EDITABLE_FIELDS = [
  'name',
  'slug',
  ...STORE_PROFILE_FIELDS,
  'custom_domain',
  'owner_user_id',
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];

export interface PlatformStoreListItem {
  id: number;
  slug: string;
  name: string;
  logo: string | null;
  account_status: Store['account_status'];
  is_open: boolean;
  created_at: Date;
  owner: UserRef | null;
  plan: { id: number; code: string; name: string } | null;
  subscription: {
    id: number;
    status: SubscriptionStatus;
    trial_ends_at: Date | null;
    current_period_end: Date | null;
    cancel_at_period_end: boolean;
  } | null;
  /** Equipe fora da lixeira. */
  staff_count: number;
  /** Pedidos não cancelados nos últimos 30 dias. */
  orders_30d: number;
  /** Pedidos pagos e não cancelados nos últimos 30 dias. */
  gmv_30d: number;
}

interface OrderStatsRow {
  orders_total: number | string | null;
  orders_30d: number | string | null;
  canceled_total: number | string | null;
  gmv_total: number | string | null;
  gmv_30d: number | string | null;
  customers: number | string | null;
  last_order_at: Date | string | null;
}

interface StaffStatsRow {
  staff: number | string | null;
  active_staff: number | string | null;
  active_admins: number | string | null;
}

/**
 * Assinatura exibida de cada loja: a vigente (não cancelada) ou, sem ela, a mais recente.
 * `rows` em ordem de id decrescente.
 */
export function displaySubscriptions(
  rows: readonly Subscription[],
): Map<number, Subscription> {
  const result = new Map<number, Subscription>();
  for (const row of rows) {
    const chosen = result.get(row.store_id);
    if (!chosen) {
      result.set(row.store_id, row);
    } else if (
      chosen.status === SubscriptionStatus.CANCELED &&
      row.status !== SubscriptionStatus.CANCELED
    ) {
      result.set(row.store_id, row);
    }
  }
  return result;
}

/** Aviso do superpainel: o endereço escolhido já foi de outra loja (os links antigos dela abrem esta). */
function slugUsedBeforeWarning(
  slug: string,
  previous: Pick<StoreSlugHistory, 'store_id'>,
): string {
  return `O endereço /loja/${slug} já foi de outro estabelecimento (#${previous.store_id}): links e QR codes antigos dele passam a abrir esta loja.`;
}

function messageOf(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'string') return response;
    const message = (response as { message?: unknown }).message;
    if (Array.isArray(message)) return message.join(' ');
    if (typeof message === 'string') return message;
  }
  return 'erro inesperado';
}

/**
 * Estabelecimentos no superpainel (somente SUPER_ADMIN; toda alteração auditada com ações platform.*):
 * lista com indicadores, cadastro (loja + assinatura numa transação + convite do responsável),
 * detalhe, edição, situação (suspender/reativar/desativar/restaurar — nada é apagado), equipe,
 * relatório de vendas e convites. A loja-alvo vem SEMPRE do id da rota.
 */
@Injectable()
export class PlatformStoresService {
  private readonly logger = new Logger(PlatformStoresService.name);

  constructor(
    @InjectRepository(Store)
    private readonly stores: Repository<Store>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    private readonly tenants: TenantService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly planLimits: PlanLimitsService,
    private readonly invitations: InvitationsService,
    private readonly usersService: UsersService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Lista
  // ---------------------------------------------------------------------------

  /** GET /platform/stores: paginada no banco; indicadores da página em consultas agregadas (sem N+1). */
  async list(
    query: PlatformStoreListQueryDto,
    now: Date = new Date(),
  ): Promise<Paginated<PlatformStoreListItem>> {
    const { search, page, pageSize, offset } = pageRequest(query);
    const sort = query.sort ?? 'created_at';
    // Padrão: mais novas primeiro; nome e slug em ordem alfabética
    const order: 'ASC' | 'DESC' =
      query.order === 'asc'
        ? 'ASC'
        : query.order === 'desc'
          ? 'DESC'
          : sort === 'created_at'
            ? 'DESC'
            : 'ASC';

    const qb = this.stores.createQueryBuilder('store');
    this.applyListFilters(qb, query, search);
    const [stores, total] = await qb
      .orderBy(SORT_COLUMNS[sort], order)
      .addOrderBy('store.id', order)
      .offset(offset)
      .limit(pageSize)
      .getManyAndCount();
    if (!stores.length) return { items: [], total, page, pageSize };

    const ids = stores.map((store) => store.id);
    const ownerIds = [
      ...new Set(
        stores
          .map((store) => store.owner_user_id)
          .filter((id): id is number => typeof id === 'number'),
      ),
    ];
    const since = new Date(now.getTime() - RECENT_METRICS_DAYS * DAY_MS);

    const [subscriptions, staffRows, orderRows, owners] = await Promise.all([
      this.subscriptions.find({
        where: { store_id: In(ids) },
        relations: { plan: true },
        order: { id: 'DESC' },
      }),
      this.users
        .createQueryBuilder('u')
        .select('u.store_id', 'store_id')
        .addSelect('COUNT(*)', 'count')
        .where('u.store_id IN (:...ids)', { ids })
        .andWhere('u.role <> :client', { client: UserRole.CLIENT })
        .groupBy('u.store_id')
        .getRawMany<{ store_id: number | string; count: number | string }>(),
      this.orders
        .createQueryBuilder('o')
        .select('o.store_id', 'store_id')
        .addSelect('COUNT(*) FILTER (WHERE o.status <> :canceled)', 'orders')
        .addSelect(
          'COALESCE(SUM(o.total_price) FILTER (WHERE o.status <> :canceled AND o.payment_status = :paid), 0)',
          'gmv',
        )
        .where('o.store_id IN (:...ids)', { ids })
        .andWhere('o.created_at >= CAST(:since AS timestamptz)', { since })
        .setParameters({
          canceled: OrderStatus.CANCELED,
          paid: PaymentStatus.PAID,
        })
        .groupBy('o.store_id')
        .getRawMany<{
          store_id: number | string;
          orders: number | string;
          gmv: number | string | null;
        }>(),
      ownerIds.length
        ? this.users.find({
            where: { id: In(ownerIds) },
            withDeleted: true,
            select: { id: true, name: true, email: true },
          })
        : Promise.resolve([] as User[]),
    ]);

    const display = displaySubscriptions(subscriptions);
    const staff = new Map(
      staffRows.map((row) => [Number(row.store_id), toCount(row.count)]),
    );
    const recent = new Map(orderRows.map((row) => [Number(row.store_id), row]));
    const ownersById = new Map(owners.map((owner) => [owner.id, owner]));

    const items = stores.map((store): PlatformStoreListItem => {
      const subscription = display.get(store.id) ?? null;
      const plan = subscription?.plan ?? null;
      const stats = recent.get(store.id);
      return {
        id: store.id,
        slug: store.slug,
        name: store.name,
        logo: store.logo ?? null,
        account_status: store.account_status,
        is_open: store.is_open,
        created_at: store.created_at,
        owner: userRef(
          store.owner_user_id ? ownersById.get(store.owner_user_id) : null,
        ),
        plan: plan ? { id: plan.id, code: plan.code, name: plan.name } : null,
        subscription: subscription
          ? {
              id: subscription.id,
              status: subscription.status,
              trial_ends_at: subscription.trial_ends_at ?? null,
              current_period_end: subscription.current_period_end ?? null,
              cancel_at_period_end: subscription.cancel_at_period_end,
            }
          : null,
        staff_count: staff.get(store.id) ?? 0,
        orders_30d: toCount(stats?.orders),
        gmv_30d: toMoney(stats?.gmv),
      };
    });
    return { items, total, page, pageSize };
  }

  private applyListFilters(
    qb: SelectQueryBuilder<Store>,
    query: PlatformStoreListQueryDto,
    search: string | null,
  ): void {
    if (search) {
      // Só termo com cara de documento procura nos dígitos do CNPJ/CPF ("Loja 219" não procura "219")
      const digits = numericSearchDigits(search);
      qb.andWhere(
        new Brackets((match) => {
          match
            .where('store.name ILIKE :term')
            .orWhere('store.slug ILIKE :term')
            .orWhere('store.legal_name ILIKE :term')
            .orWhere('store.email ILIKE :term')
            .orWhere('store.custom_domain ILIKE :term')
            .orWhere(
              'EXISTS (SELECT 1 FROM "users" "owner_search" WHERE "owner_search"."id" = store.owner_user_id AND "owner_search"."email" ILIKE :term)',
            );
          // CNPJ/CPF digitado com pontuação encontra o documento gravado só com dígitos
          if (digits) match.orWhere('store.document LIKE :digits');
        }),
        { term: likeContains(search), digits: `%${digits ?? ''}%` },
      );
    }
    if (query.account_status) {
      qb.andWhere('store.account_status = :accountStatus', {
        accountStatus: query.account_status,
      });
    }
    if (query.plan_id !== undefined) {
      qb.andWhere(
        'EXISTS (SELECT 1 FROM "subscriptions" "plan_filter" WHERE "plan_filter"."store_id" = store.id AND "plan_filter"."status" <> :canceledSubscription AND "plan_filter"."plan_id" = :planId)',
        {
          planId: query.plan_id,
          canceledSubscription: SubscriptionStatus.CANCELED,
        },
      );
    }

    const status = query.subscription_status;
    if (status === 'NONE') {
      qb.andWhere(
        'NOT EXISTS (SELECT 1 FROM "subscriptions" "sub_filter" WHERE "sub_filter"."store_id" = store.id)',
      );
    } else if (status === 'CANCELED') {
      // Última assinatura cancelada e nenhuma vigente
      qb.andWhere(
        'NOT EXISTS (SELECT 1 FROM "subscriptions" "sub_filter" WHERE "sub_filter"."store_id" = store.id AND "sub_filter"."status" <> :canceledSubscription)',
        { canceledSubscription: SubscriptionStatus.CANCELED },
      ).andWhere(
        'EXISTS (SELECT 1 FROM "subscriptions" "sub_canceled" WHERE "sub_canceled"."store_id" = store.id)',
      );
    } else if (status) {
      // No máximo uma assinatura não cancelada por loja (índice único parcial)
      qb.andWhere(
        'EXISTS (SELECT 1 FROM "subscriptions" "sub_filter" WHERE "sub_filter"."store_id" = store.id AND "sub_filter"."status" = :subscriptionStatus)',
        { subscriptionStatus: status },
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Cadastro
  // ---------------------------------------------------------------------------

  /**
   * POST /platform/stores: loja + assinatura do plano inicial na MESMA transação; depois, o convite do
   * responsável (ADMIN, torna-se o responsável ao aceitar). O link do convite aparece só nesta
   * resposta. Se o convite falhar, a loja continua criada e a resposta traz o aviso.
   */
  async create(
    dto: CreatePlatformStoreDto,
    actor: AuthUser,
    request?: Request | null,
  ) {
    this.assertPlatformOperator(actor);
    await assertSlugAvailable(this.stores, dto.slug);
    const previousOwner = await previousSlugOwner(this.stores, dto.slug);
    const ownerEmail = normalizeEmail(dto.owner.email);
    if (await this.usersService.emailInUse(ownerEmail)) {
      throw new ConflictException(OWNER_EMAIL_IN_USE_MESSAGE);
    }

    const { store, subscription } = await this.stores.manager.transaction(
      async (manager) => {
        const created = await insertNewStore(manager, {
          name: dto.name,
          slug: dto.slug,
          profile: profileFrom(dto),
        });
        // Com o manager, a assinatura entra na transação (e a auditoria fica a cargo daqui)
        const createdSubscription =
          await this.subscriptionsService.createForStore(
            created.id,
            dto.plan_id,
            {
              actor,
              request,
              manager,
              allowInactivePlan: dto.allow_inactive_plan === true,
              reason: 'Estabelecimento cadastrado pelo superpainel.',
            },
          );
        return { store: created, subscription: createdSubscription };
      },
    );

    const warnings: string[] = [];
    if (previousOwner) {
      warnings.push(slugUsedBeforeWarning(dto.slug, previousOwner));
    }
    let invitation: CreatedInvitation | null = null;
    try {
      invitation = await this.invitations.create({
        storeId: store.id,
        email: ownerEmail,
        role: UserRole.ADMIN,
        makeOwner: true,
        invitedBy: actor,
        request,
        // Com SMTP, o link vai só para o responsável (url null + delivered); falha no envio → aviso abaixo
        deliverOnlyByEmail: true,
      });
    } catch (error) {
      // No log vai o erro real; na resposta, só a mensagem pública (HttpException) ou uma genérica
      this.logger.warn(
        `Loja ${store.id} criada sem o convite do responsável: ${error instanceof Error ? error.message : String(error)}`,
      );
      warnings.push(
        `O estabelecimento foi criado, mas o convite do responsável não pôde ser gerado (${messageOf(error)}). Gere um novo convite na área de convites da loja.`,
      );
    }

    const plan = subscription.plan ?? null;
    await this.audit.record({
      actor,
      storeId: store.id,
      action: 'platform.store.create',
      targetType: 'store',
      targetId: store.id,
      // Nunca o link do convite (ele contém o token de uso único)
      metadata: {
        slug: store.slug,
        name: store.name,
        plan_id: subscription.plan_id,
        plan_code: plan?.code ?? null,
        subscription_id: subscription.id,
        subscription_status: subscription.status,
        owner_email: ownerEmail,
        owner_name: dto.owner.name ?? null,
        invitation_id: invitation?.invitation.id ?? null,
      },
      request,
    });
    // createForStore com manager não audita: o registro da assinatura fica aqui
    await this.audit.record({
      actor,
      storeId: store.id,
      action: 'subscription.create',
      targetType: 'subscription',
      targetId: subscription.id,
      metadata: {
        plan_id: subscription.plan_id,
        plan_code: plan?.code ?? null,
        status: subscription.status,
        provider: subscription.billing_provider,
        via: 'platform.store.create',
      },
      request,
    });

    return {
      store: presentPlatformStore(store),
      subscription: {
        ...presentSubscription(subscription),
        plan: plan ? presentPlan(plan) : null,
      },
      invitation: invitation
        ? {
            ...invitation.invitation,
            /**
             * Link de uso único: exibido só agora (o banco guarda apenas o hash do token). null quando
             * o convite foi entregue por e-mail (SMTP configurado): delivered e message dizem para onde.
             */
            url: invitation.url,
            delivered: invitation.delivered,
            ...(invitation.message ? { message: invitation.message } : {}),
          }
        : null,
      warnings,
    };
  }

  // ---------------------------------------------------------------------------
  // Detalhe e edição
  // ---------------------------------------------------------------------------

  async findStoreOrFail(id: number): Promise<Store> {
    const store = await this.stores.findOne({ where: { id } });
    if (!store) throw new NotFoundException(STORE_NOT_FOUND_MESSAGE);
    return store;
  }

  /** 404 se a loja não existe (rotas por loja que delegam a outros serviços). */
  async assertExists(id: number): Promise<void> {
    if (!(await this.stores.exists({ where: { id } }))) {
      throw new NotFoundException(STORE_NOT_FOUND_MESSAGE);
    }
  }

  /**
   * GET /platform/stores/:id: cadastro (sem segredos), pagamentos (configurados ou não), responsável,
   * assinatura com o plano, uso e limites, indicadores, situação efetiva e se é a loja padrão.
   */
  async detail(id: number, now: Date = new Date()) {
    const store = await this.findStoreOrFail(id);
    const since = new Date(now.getTime() - RECENT_METRICS_DAYS * DAY_MS);

    const [
      defaultStore,
      subscription,
      usage,
      storage,
      hasCredentials,
      orderStats,
      staffStats,
      owner,
    ] = await Promise.all([
      this.tenants.defaultStore(),
      this.tenants.currentSubscription(id),
      this.planLimits.usage(id, now),
      this.planLimits.storageUsage(id),
      this.stores.exists({
        where: { id, mp_access_token_encrypted: Not(IsNull()) },
      }),
      this.orders
        .createQueryBuilder('o')
        .select('COUNT(*) FILTER (WHERE o.status <> :canceled)', 'orders_total')
        .addSelect(
          'COUNT(*) FILTER (WHERE o.status <> :canceled AND o.created_at >= CAST(:since AS timestamptz))',
          'orders_30d',
        )
        .addSelect(
          'COUNT(*) FILTER (WHERE o.status = :canceled)',
          'canceled_total',
        )
        .addSelect(
          'COALESCE(SUM(o.total_price) FILTER (WHERE o.status <> :canceled AND o.payment_status = :paid), 0)',
          'gmv_total',
        )
        .addSelect(
          'COALESCE(SUM(o.total_price) FILTER (WHERE o.status <> :canceled AND o.payment_status = :paid AND o.created_at >= CAST(:since AS timestamptz)), 0)',
          'gmv_30d',
        )
        .addSelect('COUNT(DISTINCT o.user_id)', 'customers')
        .addSelect('MAX(o.created_at)', 'last_order_at')
        .where('o.store_id = :storeId', { storeId: id })
        .setParameters({
          canceled: OrderStatus.CANCELED,
          paid: PaymentStatus.PAID,
          since,
        })
        .getRawOne<OrderStatsRow>(),
      this.users
        .createQueryBuilder('u')
        .select('COUNT(*)', 'staff')
        .addSelect(
          'COUNT(*) FILTER (WHERE u.blocked_at IS NULL)',
          'active_staff',
        )
        .addSelect(
          'COUNT(*) FILTER (WHERE u.role = :admin AND u.blocked_at IS NULL)',
          'active_admins',
        )
        .where('u.store_id = :storeId', { storeId: id })
        .andWhere('u.role <> :client', { client: UserRole.CLIENT })
        .setParameter('admin', UserRole.ADMIN)
        .getRawOne<StaffStatsRow>(),
      store.owner_user_id
        ? this.users.findOne({
            where: { id: store.owner_user_id },
            withDeleted: true,
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
              store_id: true,
              blocked_at: true,
              deleted_at: true,
            },
          })
        : Promise.resolve(null),
    ]);

    const isDefault = defaultStore?.id === id;
    const current =
      subscription && subscription.status !== SubscriptionStatus.CANCELED
        ? subscription
        : null;
    const plan = subscription?.plan ?? null;
    const features = featuresOf(subscription);
    const lastOrderAt = orderStats?.last_order_at ?? null;

    return {
      ...presentPlatformStore(store),
      is_default_store: isDefault,
      owner: owner
        ? {
            ...(userRef(owner) as UserRef),
            role: owner.role,
            blocked: !!owner.blocked_at,
            deleted: !!owner.deleted_at,
            /** Ainda pertence a esta loja como ADMIN ativo. */
            eligible:
              owner.store_id === id &&
              owner.role === UserRole.ADMIN &&
              !owner.blocked_at &&
              !owner.deleted_at,
          }
        : null,
      subscription: subscription
        ? {
            ...presentSubscription(subscription),
            plan: plan ? presentPlan(plan) : null,
          }
        : null,
      features,
      usage,
      /** Limites do plano vigente (null = sem assinatura vigente; limite null = ilimitado). */
      limits: current && plan ? limitsOf(plan) : null,
      /** Armazenamento das imagens da loja × limite do plano vigente (max_storage_mb). */
      storage: presentStorageUsage(
        storage,
        current && plan ? (plan.max_storage_mb ?? null) : null,
      ),
      payments: {
        /** A loja gravou a própria credencial do Mercado Pago (o token nunca sai daqui). */
        configured: hasCredentials,
        mp_public_key: store.mp_public_key ?? null,
        /** Loja padrão sem credencial própria usando o MP_ACCESS_TOKEN do ambiente. */
        using_platform_credentials:
          isDefault && !hasCredentials && platformAccessTokenConfigured(),
        online_payments_in_plan: features.online_payments,
      },
      metrics: {
        orders_total: toCount(orderStats?.orders_total),
        orders_30d: toCount(orderStats?.orders_30d),
        canceled_orders_total: toCount(orderStats?.canceled_total),
        gmv_total: toMoney(orderStats?.gmv_total),
        gmv_30d: toMoney(orderStats?.gmv_30d),
        customers: toCount(orderStats?.customers),
        staff: toCount(staffStats?.staff),
        active_staff: toCount(staffStats?.active_staff),
        active_admins: toCount(staffStats?.active_admins),
        last_order_at: lastOrderAt ? new Date(lastOrderAt) : null,
        currency: 'BRL',
        methodology: STORE_METRICS_METHODOLOGY,
      },
      access: storeAccessState(store, subscription, now),
    };
  }

  /**
   * PATCH /platform/stores/:id: só o que foi enviado e mudou. Slug e domínio únicos (409), responsável
   * precisa ser ADMIN ativo da loja. Auditado (slug, domínio e responsável com o antigo e o novo).
   */
  async update(
    id: number,
    dto: UpdatePlatformStoreDto,
    actor: AuthUser,
    request?: Request | null,
  ) {
    this.assertPlatformOperator(actor);
    const current = await this.findStoreOrFail(id);

    const changes: Partial<Pick<Store, EditableField>> = {};
    for (const field of EDITABLE_FIELDS) {
      const value = dto[field];
      if (value !== undefined && (value ?? null) !== (current[field] ?? null)) {
        Object.assign(changes, { [field]: value });
      }
    }
    const fields = Object.keys(changes) as EditableField[];
    if (!fields.length) return { ...(await this.detail(id)), warnings: [] };

    let previousOwner: Pick<StoreSlugHistory, 'store_id'> | null = null;
    if (changes.slug !== undefined) {
      await assertSlugAvailable(this.stores, changes.slug, id);
      previousOwner = await previousSlugOwner(this.stores, changes.slug);
    }
    if (changes.custom_domain) {
      await assertCustomDomainAvailable(this.stores, changes.custom_domain, id);
    }
    if (changes.owner_user_id !== undefined && changes.owner_user_id !== null) {
      await this.assertOwnerCandidate(id, changes.owner_user_id);
    }
    // O endereço antigo fica reservado ANTES da troca: links e QR codes antigos nunca ficam livres para
    // o autoatendimento (se a troca falhar, reservar o endereço que a loja ainda usa não muda nada)
    if (changes.slug !== undefined) {
      await retireStoreSlug(this.stores, id, current.slug);
    }

    try {
      const result = await this.stores.update({ id }, changes);
      if (!result.affected)
        throw new NotFoundException(STORE_NOT_FOUND_MESSAGE);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      rethrowStoreConflict(error);
    }

    const fromTo = (field: 'slug' | 'custom_domain' | 'owner_user_id') =>
      field in changes
        ? {
            [field]: {
              from: current[field] ?? null,
              to: changes[field] ?? null,
            },
          }
        : {};
    await this.audit.record({
      actor,
      storeId: id,
      action: 'platform.store.update',
      targetType: 'store',
      targetId: id,
      // Nomes dos campos; valores só do que não é dado pessoal (endereço da loja, domínio, responsável)
      metadata: {
        fields,
        ...fromTo('slug'),
        ...fromTo('custom_domain'),
        ...fromTo('owner_user_id'),
      },
      request,
    });

    const warnings: string[] = [];
    if (changes.slug !== undefined) {
      warnings.push(
        `O endereço da loja mudou de /loja/${current.slug} para /loja/${changes.slug}: links e QR codes com o endereço antigo deixam de funcionar.`,
      );
      if (current.slug === configuredDefaultStoreSlug()) {
        warnings.push(
          `Esta é a loja padrão das rotas antigas e do app mobile (DEFAULT_STORE_SLUG=${current.slug}): com o endereço novo, elas deixam de encontrá-la até o DEFAULT_STORE_SLUG do servidor ser atualizado. O endereço antigo continua reservado (o autoatendimento não pode cadastrá-lo).`,
        );
      }
      if (previousOwner && previousOwner.store_id !== id) {
        warnings.push(slugUsedBeforeWarning(changes.slug, previousOwner));
      }
    }
    if (changes.custom_domain) warnings.push(CUSTOM_DOMAIN_NOT_ROUTED_NOTICE);
    return { ...(await this.detail(id)), warnings };
  }

  /** Responsável: conta ADMIN desta loja, fora da lixeira e não bloqueada. */
  private async assertOwnerCandidate(
    storeId: number,
    userId: number,
  ): Promise<void> {
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, role: true, store_id: true, blocked_at: true },
    });
    if (
      !user ||
      user.store_id !== storeId ||
      user.role !== UserRole.ADMIN ||
      user.blocked_at
    ) {
      throw new BadRequestException(OWNER_NOT_ELIGIBLE_MESSAGE);
    }
  }

  // ---------------------------------------------------------------------------
  // Situação na plataforma
  // ---------------------------------------------------------------------------

  /**
   * suspend / reactivate / deactivate / restore (regras em store-status-rules.ts). A linha da loja é
   * travada durante a mudança; nada é apagado. Desativar ou suspender a loja padrão não é bloqueado:
   * a resposta traz o aviso (as rotas antigas mudam de comportamento).
   */
  async changeStatus(
    id: number,
    action: StoreStatusAction,
    reason: string | null | undefined,
    actor: AuthUser,
    request?: Request | null,
    now: Date = new Date(),
  ) {
    this.assertPlatformOperator(actor);
    const plan = await this.stores.manager.transaction(async (manager) => {
      const repository = manager.getRepository(Store);
      const store = await repository.findOne({
        where: { id },
        select: { id: true, account_status: true },
        lock: { mode: 'pessimistic_write' },
      });
      if (!store) throw new NotFoundException(STORE_NOT_FOUND_MESSAGE);

      const planned = planStoreStatusChange(
        store.account_status,
        action,
        reason,
      );
      if (!planned.ok) throw new ConflictException(planned.message);

      const result = await repository.update(
        { id, account_status: store.account_status },
        {
          account_status: planned.to,
          status_reason: planned.statusReason,
          status_changed_at: now,
        },
      );
      if (!result.affected) {
        throw new ConflictException(STATUS_CHANGED_CONCURRENTLY_MESSAGE);
      }
      // Loja desativada: as sessões abertas da equipe caem na hora (token_version + 1), na mesma
      // transação. A leitura já seria recusada pelo guard; assim nenhum token antigo continua válido.
      if (planned.to === StoreAccountStatus.INACTIVE) {
        await manager
          .getRepository(User)
          .update(
            { store_id: id, role: Not(UserRole.CLIENT) },
            { token_version: () => '"token_version" + 1' },
          );
        // Links de redefinição pendentes da equipe também vencem: numa reativação, um link antigo
        // devolveria o acesso a quem o tivesse (expirePendingResetLinks da equipe inteira)
        await expirePendingResetLinksOfStoreTeam(manager, id, now);
      }
      return planned;
    });

    const isDefaultStore = (await this.tenants.defaultStore())?.id === id;
    await this.audit.record({
      actor,
      storeId: id,
      action: STORE_STATUS_TRANSITIONS[action].auditAction,
      targetType: 'store',
      targetId: id,
      metadata: {
        from: plan.from,
        to: plan.to,
        reason: reason?.trim() || null,
        is_default_store: isDefaultStore,
      },
      request,
    });
    return {
      ...(await this.detail(id, now)),
      warnings: storeStatusWarnings(action, { isDefaultStore }),
    };
  }

  // ---------------------------------------------------------------------------
  // Equipe e relatório de vendas
  // ---------------------------------------------------------------------------

  /**
   * GET /platform/stores/:id/users: equipe (inclusive a lixeira), com último acesso e bloqueio. Com o
   * operador (rota), a leitura entra na auditoria (platform.store.team.view, filtros e quantidade).
   */
  async team(
    id: number,
    query: PlatformStoreTeamQueryDto,
    actor?: AuthUser | null,
    request?: Request | null,
  ): Promise<Paginated<PlatformUserView>> {
    const store = await this.findStoreOrFail(id);
    const { search, page, pageSize, offset } = pageRequest(query);

    const qb = this.users
      .createQueryBuilder('u')
      .withDeleted()
      .where('u.store_id = :storeId', { storeId: id })
      .andWhere('u.role <> :client', { client: UserRole.CLIENT });
    if (query.include_deleted === false) qb.andWhere('u.deleted_at IS NULL');
    if (search) {
      qb.andWhere(
        new Brackets((match) => {
          match.where('u.name ILIKE :term').orWhere('u.email ILIKE :term');
        }),
        { term: likeContains(search) },
      );
    }
    const [rows, total] = await qb
      .orderBy('u.deleted_at', 'DESC', 'NULLS FIRST')
      .addOrderBy('u.name', 'ASC')
      .addOrderBy('u.id', 'ASC')
      .offset(offset)
      .limit(pageSize)
      .getManyAndCount();

    const summary = {
      id: store.id,
      slug: store.slug,
      name: store.name,
      account_status: store.account_status,
    };
    if (actor) {
      await this.audit.record({
        actor,
        storeId: store.id,
        action: 'platform.store.team.view',
        targetType: 'store',
        targetId: store.id,
        metadata: {
          search: search ?? null,
          include_deleted: query.include_deleted !== false,
          page,
          page_size: pageSize,
          returned: rows.length,
          total,
        },
        request,
      });
    }
    return {
      items: rows.map((user) =>
        presentPlatformUser(user, {
          store: summary,
          is_owner: user.id === store.owner_user_id,
        }),
      ),
      total,
      page,
      pageSize,
    };
  }

  /**
   * GET /platform/stores/:id/metrics?from=&to=: vendas por dia no calendário da loja, por situação e
   * por forma de pagamento (mesma regra do relatório da própria loja; até 366 dias).
   */
  async metrics(
    id: number,
    query: StoreMetricsQueryDto,
    now: Date = new Date(),
  ) {
    const store = await this.findStoreOrFail(id);
    const timeZone = resolveTimeZone(store.time_zone);
    const range = parseReportRange(query.from, query.to, now, timeZone);
    if (!range.ok) throw new BadRequestException(range.message);

    const start = startOfDayInZone(range.from, timeZone);
    const end = startOfDayInZone(addDaysToKey(range.to, 1), timeZone);
    const rows = await this.orders.find({
      select: {
        id: true,
        created_at: true,
        status: true,
        payment_status: true,
        payment_method: true,
        total_price: true,
      },
      where: {
        store_id: id,
        created_at: And(MoreThanOrEqual(start), LessThan(end)),
      },
      order: { created_at: 'ASC' },
    });
    const report = buildOrdersReport(rows, range, timeZone);

    return {
      store: storeRef(store) as StoreRef,
      period: {
        from: report.period.from,
        to: report.period.to,
        days: report.period.days,
        time_zone: report.period.timeZone,
      },
      currency: 'BRL',
      summary: {
        orders: report.summary.orders,
        canceled_orders: report.summary.canceledOrders,
        paid_orders: report.summary.paidOrders,
        gmv: report.summary.revenue,
        average_ticket: report.summary.averageTicket,
      },
      daily: report.revenueByDay.map((day) => ({
        date: day.date,
        orders: day.orders,
        paid_orders: day.paidOrders,
        gmv: day.revenue,
      })),
      by_status: report.ordersByStatus,
      by_payment_method: report.paymentMethods.map((method) => ({
        method: method.method,
        orders: method.orders,
        paid_orders: method.paidOrders,
        gmv: method.revenue,
      })),
      methodology: STORE_REPORT_METHODOLOGY,
    };
  }

  // ---------------------------------------------------------------------------
  // Convites da equipe
  // ---------------------------------------------------------------------------

  async listInvitations(id: number, query: ListInvitationsQueryDto) {
    await this.assertExists(id);
    return this.invitations.listByStore(id, query);
  }

  /**
   * POST /platform/stores/:id/invitations: { invitation, url, delivered, warnings } (+ message quando
   * entregue). Com o SMTP configurado, o link vai SÓ para o convidado (url null, delivered true; falha
   * no envio → 503 e o convite é cancelado); sem SMTP, o link aparece só aqui (delivered false). Sem vaga
   * no plano, o convite é criado com aviso (o aceite confere o limite de novo).
   */
  async createInvitation(
    id: number,
    dto: CreateInvitationDto,
    actor: AuthUser,
    request?: Request | null,
  ) {
    this.assertPlatformOperator(actor);
    await this.assertExists(id);
    if (dto.make_owner === true && dto.role !== UserRole.ADMIN) {
      throw new BadRequestException(OWNER_ROLE_REQUIRED_MESSAGE);
    }
    const created = await this.invitations.create({
      storeId: id,
      email: dto.email,
      role: dto.role,
      makeOwner: dto.make_owner === true,
      invitedBy: actor,
      request,
      deliverOnlyByEmail: true,
    });

    const warnings: string[] = [];
    const plan = await this.planLimits.currentPlan(id);
    if (!plan) {
      warnings.push(
        'A loja não tem assinatura vigente: o convite só poderá ser aceito depois que a loja tiver um plano.',
      );
    } else if (
      plan.max_staff_users !== null &&
      plan.max_staff_users !== undefined
    ) {
      const usage = await this.planLimits.usage(id);
      if (usage.staff_users >= plan.max_staff_users) {
        warnings.push(
          `O plano ${plan.name} já está no limite de ${plan.max_staff_users} usuários da equipe: o convite só poderá ser aceito se houver vaga.`,
        );
      }
    }
    return {
      invitation: created.invitation,
      url: created.url,
      delivered: created.delivered === true,
      ...(created.message ? { message: created.message } : {}),
      warnings,
    };
  }

  /** DELETE /platform/invitations/:id (auditado pelo InvitationsService como invitation.revoke). */
  revokeInvitation(id: number, actor: AuthUser, request?: Request | null) {
    this.assertPlatformOperator(actor);
    return this.invitations.revokeAsPlatform(id, actor, request);
  }

  // ---------------------------------------------------------------------------

  /** Além do @PlatformRoute na rota: defesa em profundidade contra uso indevido do serviço. */
  private assertPlatformOperator(actor: AuthUser | null | undefined): void {
    if (!isSuperAdmin(actor)) {
      throw new ForbiddenException(PLATFORM_ONLY_MESSAGE);
    }
  }
}

export type PlatformStoreDetail = Awaited<
  ReturnType<PlatformStoresService['detail']>
>;
