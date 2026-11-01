import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import {
  FindOptionsRelations,
  FindOptionsWhere,
  In,
  IsNull,
  MoreThanOrEqual,
  Not,
  Repository,
} from 'typeorm';
import type { AuthUser } from '../auth/auth-user';
import { AuditService } from '../audit/audit.service';
import { PlanLimitsService } from '../billing/plan-limits.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { clientIpKey } from '../auth/link-token';
import { Store } from '../store/entities/store.entity';
import { TenantService } from '../tenancy/tenant.service';
import type { TenantContext } from '../tenancy/tenant-context';
import { User, UserRole } from '../users/entities/user.entity';
import { PaymentService } from '../payment/payment.service';
import { CreateOrderDto, QuoteOrderDto } from './dto/create-order.dto';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderStatus, OrderType, PaymentStatus } from './order.enums';
import {
  assertCanTakeNewOrder,
  maxPendingOrdersPerCustomer,
  pendingOrdersLimitMessage,
} from './order-limits';
import {
  OrderPricingService,
  STORE_CLOSED_MESSAGE,
  toQuoteResponse,
} from './order-pricing.service';
import {
  orderDeliveryAddress,
  orderStoreSummary,
  presentOrder,
  type OrderStoreSummary,
  type PresentedOrder,
} from './order-presenter';
import {
  REPORT_TOP_PRODUCTS,
  buildOrdersReport,
  type OrdersReport,
  type ReportOrderRow,
  type ReportTopProduct,
} from './order-reports';
import { buildOrder, toOrderSnapshot } from './order-snapshot';
import {
  ACTIVE_ORDERS_LIMIT,
  ORDERS_PAGE_MAX_SIZE,
  TERMINAL_STATUSES,
  activeScopeSince,
  addDaysToKey,
  canStaffSeeOrder,
  checkAssign,
  checkCancel,
  checkStatusChange,
  dateKeyInZone,
  dayKeyInZone,
  fromCents,
  isSameDeliveryArea,
  isStaffRole,
  lastDayKeys,
  needsRefundOnCancel,
  parseReportRange,
  paymentStatusAfterRefund,
  resolveChangeFor,
  resolveTimeZone,
  shouldMarkPaidOnStatus,
  staffOrderScopes,
  staffOrderView,
  startOfDayInZone,
  toCents,
  type ListPage,
  type OrderActor,
  type OrdersScope,
  type StaffOrderScope,
} from './order-rules';

/** Sem ?page/?pageSize: os pedidos mais recentes (a resposta continua sendo uma lista). */
const FIRST_PAGE: ListPage = { skip: 0, take: ORDERS_PAGE_MAX_SIZE };

// Relações de um pedido completo. withDeleted: produtos, adicionais, cliente e entregador que foram
// para a lixeira continuam aparecendo no histórico. A relação "store" nunca entra (só o resumo).
const ORDER_RELATIONS: FindOptionsRelations<Order> = {
  items: { product: true, addons: true },
  user: true,
  address: true,
  driver: true,
};

/**
 * Quadro de pedidos (scope=active, cozinha e entregador), consultado a cada 5 s pelo web e pelo app:
 * a resposta montada fica em memória por loja e perfil e só é remontada quando muda a lista (ids,
 * updated_at, status ou pagamento dos pedidos, conferidos numa consulta só de colunas de orders) ou
 * depois de BOARD_CACHE_TTL_MS (limita o atraso de dados de outras tabelas, ex.: nome do cliente).
 * Teto de BOARD_CACHE_MAX_ORDERS pedidos guardados no total (os quadros mais antigos saem primeiro).
 */
export const BOARD_CACHE_TTL_MS = 30_000;

/** Gráficos do Dashboard: os últimos 7 dias e os 5 mais vendidos. */
const CHART_DAYS = 7;
const CHART_TOP_PRODUCTS = 5;
const BOARD_CACHE_MAX_ORDERS = 20_000;

interface BoardCacheEntry {
  fingerprint: string;
  orders: PresentedOrder[];
  expiresAt: number;
}

/** Colunas da primeira etapa de uma página de pedidos (os ids e o que muda a resposta). */
type OrderHead = Pick<
  Order,
  'id' | 'created_at' | 'updated_at' | 'status' | 'payment_status'
>;

/** 404 uniforme: pedido inexistente, de outra loja ou de outro cliente (nunca 403 que confirme a existência). */
export const ORDER_NOT_FOUND_MESSAGE = 'Pedido não encontrado.';
export const DRIVER_NOT_FOUND_MESSAGE = 'Entregador não encontrado ou inativo.';
const SUPPORT_READ_ONLY_MESSAGE =
  'Sessão de suporte é somente leitura: nenhuma alteração pode ser feita na loja.';
const OTHER_STORE_MESSAGE =
  'Você só pode administrar a loja à qual a sua conta pertence.';

type OrderChanges = {
  status: OrderStatus;
  driver?: { id: number };
  payment_status?: PaymentStatus;
};

/** Dados da rota de origem do cancelamento. */
export interface OrderRequestContext {
  /** :storeSlug das rotas /stores/:storeSlug/orders/... (o pedido precisa ser daquela loja). */
  storeSlug?: string;
  /** Requisição (IP e navegador gravados na auditoria). */
  request?: Request;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private readonly boardCache = new Map<string, BoardCacheEntry>();
  private boardCachedOrders = 0;

  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Store)
    private readonly storeRepository: Repository<Store>,
    private readonly pricing: OrderPricingService,
    private readonly payments: PaymentService,
    private readonly planLimits: PlanLimitsService,
    private readonly tenants: TenantService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
  ) {}

  // ---------------------------------------------------------------------------
  // Cliente (a loja vem do PublicStoreGuard: :storeSlug ou a loja padrão nas rotas antigas)
  // ---------------------------------------------------------------------------

  /**
   * POST /orders/quote — valores calculados pelo servidor (loja fechada → store_open:false). Abaixo do pedido
   * mínimo não recusa: devolve quanto falta (missing_for_min_order) para a tela avisar; o pedido e as
   * cobranças recusam (400 ORDER_BELOW_MINIMUM).
   */
  async quote(dto: QuoteOrderDto, actor: AuthUser, store: TenantContext) {
    return toQuoteResponse(
      await this.pricing.price(dto, actor.id, store, {
        allowBelowMinimum: true,
      }),
    );
  }

  async create(
    dto: CreateOrderDto,
    actor: AuthUser,
    store: TenantContext,
    request?: Request,
  ) {
    // Pago online: o servidor cria o pedido quando o pagamento é aprovado (com o pedido e os preços
    // da hora do pagamento). Aqui só devolvemos esse pedido — idempotente para o mesmo cliente.
    // O limite do plano já foi conferido ao criar o pagamento (o cliente já pagou).
    // Limite por IP também aqui (429): um paymentId desconhecido leva a uma consulta ao Mercado Pago,
    // que o PaymentService já limita por cliente + loja.
    if (dto.paymentId !== undefined && dto.paymentId !== null) {
      this.rateLimit.consume('ORDER_CREATE_IP', clientIpKey(request));
      const orderId = await this.payments.orderIdForPayment(dto, actor, store);
      return this.presentForCustomer(
        await this.getOrderOrFail(orderId, store.storeId),
      );
    }

    // Pago na entrega: limite de tentativas por cliente na loja e por IP (429), antes de qualquer consulta
    this.rateLimit.consume('ORDER_CREATE', `${store.storeId}:${actor.id}`);
    // IP do cliente como nos outros limites por IP (IPv6 pela rede /64: clientIpKey)
    this.rateLimit.consume('ORDER_CREATE_IP', clientIpKey(request));

    const priced = await this.pricing.price(dto, actor.id, store);
    if (!priced.store_open) throw new BadRequestException(STORE_CLOSED_MESSAGE);

    const change = resolveChangeFor(
      dto.paymentMethod,
      dto.changeFor,
      priced.totalCents,
    );
    if (!change.ok) throw new BadRequestException(change.message);

    await this.assertPendingOrdersBelowLimit(store.storeId, actor.id);
    // Os pagamentos online em andamento ainda podem virar pedido neste mês: contam no limite (da loja,
    // os aprovados sem pedido e os cartões em análise; PIX pendentes, só os deste cliente)
    await assertCanTakeNewOrder(
      this.planLimits,
      store.storeId,
      this.logger,
      await this.payments.reservedOrderSlots(store.storeId, actor.id),
    );

    // Pago na entrega/retirada: pagamento pendente até a entrega
    const order = this.orderRepository.create(
      buildOrder(toOrderSnapshot(priced), {
        storeId: store.storeId,
        userId: actor.id,
        paymentMethod: dto.paymentMethod,
        paymentStatus: PaymentStatus.PENDING,
        paymentId: null,
        changeFor: change.value,
      }),
    );
    const saved = await this.orderRepository.save(order);
    return this.presentForCustomer(
      await this.getOrderOrFail(saved.id, store.storeId),
    );
  }

  /**
   * Pedidos do próprio usuário em TODAS as lojas (clientes são globais), mais recentes primeiro,
   * cada um com a loja { id, slug, name, logo }. Em /stores/:storeSlug/orders/my-orders, só os daquela loja.
   * Uma página por vez (padrão: os ORDERS_PAGE_MAX_SIZE mais recentes), sempre no formato de lista.
   */
  async findMyOrders(
    userId: number,
    storeSlug?: string,
    page: ListPage = FIRST_PAGE,
  ) {
    const where: FindOptionsWhere<Order> = { user: { id: userId } };
    // Mesma regra da vitrine (publicContext): loja inexistente ou desativada → o mesmo 404. Os pedidos
    // de uma loja desativada continuam em GET /orders/my-orders (sem a loja na rota).
    if (storeSlug !== undefined) {
      where.store_id = (await this.tenants.publicContext(storeSlug)).storeId;
    }
    const orders = await this.findOrdersPage(where, page);
    const stores = await this.storeSummaries(
      orders.map((order) => order.store_id),
    );
    return orders.map((order) =>
      presentOrder(order, { store: stores.get(order.store_id) ?? null }),
    );
  }

  /**
   * GET /orders/:id — equipe: só pedidos da própria loja (cozinha e entregador, só os da própria
   * etapa: staffOrderScopes); cliente: só os próprios pedidos.
   * Qualquer outro caso (outra loja, outro cliente, outra etapa, inexistente) → 404 uniforme.
   */
  async findOneFor(id: number, actor: AuthUser, storeSlug?: string) {
    if (isStaffRole(actor.role)) {
      const tenant = await this.staffTenant(actor, 'read', storeSlug);
      const order = await this.getStaffOrderOrFail(id, tenant.storeId, actor);
      return presentForStaff(order, actor);
    }
    return this.presentForCustomer(
      await this.getCustomerOrderOrFail(id, actor.id, storeSlug),
    );
  }

  /**
   * PATCH /orders/:id/cancel — dono: só enquanto PENDING; ADMIN/EMPLOYEE da loja do pedido: enquanto
   * não for final. Pago online → estorno com a credencial da loja (REFUNDED; se falhar, REFUND_PENDING
   * para a equipe resolver). Sessão de suporte é somente leitura.
   */
  async cancel(id: number, actor: AuthUser, context: OrderRequestContext = {}) {
    if (actor.supportSession)
      throw new ForbiddenException(SUPPORT_READ_ONLY_MESSAGE);

    const staff = isStaffRole(actor.role)
      ? await this.staffTenant(actor, 'operate', context.storeSlug)
      : null;
    const order = staff
      ? await this.getStaffOrderOrFail(id, staff.storeId, actor)
      : await this.getCustomerOrderOrFail(id, actor.id, context.storeSlug);

    const decision = checkCancel({
      role: actor.role,
      isOwner: order.user?.id === actor.id,
      status: order.status,
    });
    if (!decision.ok) throw ruleError(decision);

    await this.cancelOrder(
      order.store_id,
      order,
      actor,
      'cancel',
      context.request,
    );
    const updated = await this.getOrderOrFail(id, order.store_id);
    return staff
      ? presentForStaff(updated, actor)
      : this.presentForCustomer(updated);
  }

  // ---------------------------------------------------------------------------
  // Equipe (a loja vem do StoreStaffGuard: users.store_id da conta autenticada)
  // ---------------------------------------------------------------------------

  /**
   * Lista da equipe, mais novos primeiro, sempre só a loja da equipe.
   * - ADMIN/EMPLOYEE, scope "active" (quadros): pedidos em andamento, os concluídos/cancelados nas
   *   últimas 24 h e os com estorno pendente (de qualquer data), até ACTIVE_ORDERS_LIMIT. Mesma regra
   *   de isInActiveScope (order-rules.ts). Sem scope: o histórico, uma página por vez (padrão: os
   *   ORDERS_PAGE_MAX_SIZE mais recentes).
   * - KITCHEN/COURIER: com ou sem scope, só os pedidos da própria etapa (staffOrderScopes), até
   *   ACTIVE_ORDERS_LIMIT, sem os dados que a etapa não usa (presentOrder view).
   */
  async findAll(
    storeId: number,
    actor: OrderActor,
    options: { scope?: OrdersScope; page?: ListPage } = {},
  ) {
    const scopes = staffOrderScopes(actor.role);
    const board: ListPage = { skip: 0, take: ACTIVE_ORDERS_LIMIT };
    let where: FindOptionsWhere<Order> | FindOptionsWhere<Order>[];
    let page: ListPage;
    if (scopes !== null) {
      where = scopes.map((scope) => scopeWhere(storeId, scope, actor.id));
      page = board;
    } else if (options.scope === 'active') {
      where = [
        { store_id: storeId, status: Not(In([...TERMINAL_STATUSES])) },
        { store_id: storeId, updated_at: MoreThanOrEqual(activeScopeSince()) },
        { store_id: storeId, payment_status: PaymentStatus.REFUND_PENDING },
      ];
      page = board;
    } else {
      where = { store_id: storeId };
      page = options.page ?? FIRST_PAGE;
    }
    if (Array.isArray(where) && !where.length) return [];

    const heads = await this.findOrderHeads(where, page);
    if (page !== board) {
      const orders = await this.loadOrders(heads);
      return orders.map((order) => presentForStaff(order, actor));
    }

    // Quadro: a mesma lista de antes reaproveita a resposta montada
    // (o entregador vê os próprios pedidos: a chave inclui a conta)
    const key = `${storeId}|${actor.role}|${staffOrderView(actor.role) === 'courier' ? actor.id : ''}`;
    const fingerprint = heads
      .map(
        (head) =>
          `${head.id}:${new Date(head.updated_at).getTime()}:${head.status}:${head.payment_status}`,
      )
      .join(',');
    const cached = this.boardCache.get(key);
    if (
      cached &&
      cached.fingerprint === fingerprint &&
      cached.expiresAt > Date.now()
    )
      return cached.orders;
    const presented = (await this.loadOrders(heads)).map((order) =>
      presentForStaff(order, actor),
    );
    this.rememberBoard(key, { fingerprint, orders: presented });
    return presented;
  }

  /** PATCH /orders/:id {status} — regras de transição por perfil em order-rules.ts. */
  async updateStatus(
    id: number,
    status: OrderStatus,
    actor: AuthUser,
    storeId: number,
    request?: Request,
  ) {
    const order = await this.getStaffOrderOrFail(id, storeId, actor);
    const decision = checkStatusChange({
      role: actor.role,
      actorId: actor.id,
      from: order.status,
      to: status,
      type: order.type,
      driverId: order.driver?.id ?? null,
    });
    if (!decision.ok) throw ruleError(decision);

    // Cancelado pelo quadro (ADMIN/EMPLOYEE): mesmo caminho de /cancel (estorno e auditoria)
    if (status === OrderStatus.CANCELED) {
      await this.cancelOrder(storeId, order, actor, 'status', request);
      return presentForStaff(await this.getOrderOrFail(id, storeId), actor);
    }

    const changes: OrderChanges = { status };
    // Entregador que pega um pedido sem responsável passa a ser o responsável (da mesma loja: é quem
    // está autenticado na loja do pedido)
    if (decision.assignDriverId)
      changes.driver = { id: decision.assignDriverId };
    // Pago na entrega/retirada: concluir o pedido quita o pagamento
    if (shouldMarkPaidOnStatus(status, order.payment_id))
      changes.payment_status = PaymentStatus.PAID;

    await this.applyChanges(storeId, order, changes, {
      requireNoDriver: !!decision.assignDriverId,
    });
    // Quem mudou recebe o pedido no formato do próprio perfil (mesmo que ele saia da etapa)
    return presentForStaff(await this.getOrderOrFail(id, storeId), actor);
  }

  /** PATCH /orders/:id/assign — entregador ativo DA MESMA LOJA; o pedido vai para DELIVERING. */
  async assignDriver(id: number, driverId: number, storeId: number) {
    const order = await this.getOrderOrFail(id, storeId);
    const decision = checkAssign({ status: order.status, type: order.type });
    if (!decision.ok) throw ruleError(decision);

    // Só a equipe da loja (clientes e equipe de outra loja → 404 uniforme); lixeira e bloqueados não
    const driver = await this.userRepository.findOne({
      where: { id: driverId, store_id: storeId, blocked_at: IsNull() },
      select: { id: true, role: true },
    });
    if (!driver) throw new NotFoundException(DRIVER_NOT_FOUND_MESSAGE);
    if (driver.role !== UserRole.COURIER)
      throw new BadRequestException(
        'O usuário selecionado não é um entregador.',
      );

    await this.applyChanges(storeId, order, {
      status: OrderStatus.DELIVERING,
      driver: { id: driver.id },
    });
    return presentOrder(await this.getOrderOrFail(id, storeId));
  }

  /** Entregadores ativos da loja (dados de contato apenas). */
  getAvailableDrivers(storeId: number) {
    return this.userRepository.find({
      where: {
        role: UserRole.COURIER,
        store_id: storeId,
        blocked_at: IsNull(),
      },
      select: { id: true, name: true, phone: true, avatar: true },
      order: { name: 'ASC' },
    });
  }

  /**
   * Pedidos prontos, sem entregador, da mesma loja e no mesmo bairro do pedido informado (para
   * agrupar entregas). O bairro é o do retrato do endereço de entrega (pedidos antigos: o endereço ligado).
   */
  async getNearbyOrders(id: number, storeId: number) {
    const target = await this.orderRepository.findOne({
      where: { id, store_id: storeId },
      relations: { address: true },
    });
    if (!target) throw new NotFoundException(ORDER_NOT_FOUND_MESSAGE);
    const area = orderDeliveryAddress(target);
    if (target.type !== OrderType.DELIVERY || !area) return [];

    const candidates = await this.orderRepository.find({
      where: {
        id: Not(id),
        store_id: storeId,
        status: OrderStatus.READY_FOR_PICKUP,
        type: OrderType.DELIVERY,
        driver: IsNull(),
      },
      relations: { address: true, user: true },
      withDeleted: true,
      order: { created_at: 'ASC' },
    });

    return candidates
      .filter((order) => isSameDeliveryArea(area, orderDeliveryAddress(order)))
      .map((order) => presentOrder(order));
  }

  // ---------------------------------------------------------------------------
  // Dashboard e relatórios (somente ADMIN, só a própria loja, no fuso da loja)
  // Faturamento conta apenas pedidos PAGOS e não cancelados.
  // ---------------------------------------------------------------------------

  async getDashboardSummary(storeId: number) {
    const [
      totalOrders,
      pendingOrders,
      preparingOrders,
      pendingPayments,
      revenueRow,
    ] = await Promise.all([
      this.orderRepository.count({
        where: { store_id: storeId, status: Not(OrderStatus.CANCELED) },
      }),
      this.orderRepository.count({
        where: { store_id: storeId, status: OrderStatus.PENDING },
      }),
      this.orderRepository.count({
        where: { store_id: storeId, status: OrderStatus.PREPARING },
      }),
      // Pedidos em andamento ainda sem pagamento
      this.orderRepository
        .createQueryBuilder('o')
        .where('o.store_id = :storeId', { storeId })
        .andWhere('o.payment_status = :pending', {
          pending: PaymentStatus.PENDING,
        })
        .andWhere('o.status NOT IN (:...closed)', {
          closed: [OrderStatus.CANCELED, OrderStatus.DONE],
        })
        .getCount(),
      this.orderRepository
        .createQueryBuilder('o')
        .select('COALESCE(SUM(o.total_price), 0)', 'total')
        .where('o.store_id = :storeId', { storeId })
        .andWhere('o.payment_status = :paid', { paid: PaymentStatus.PAID })
        .andWhere('o.status != :canceled', { canceled: OrderStatus.CANCELED })
        .getRawOne<{ total: string }>(),
    ]);

    return {
      totalOrders,
      revenue: Number(revenueRow?.total ?? 0),
      pendingOrders,
      preparingOrders,
      pendingPayments,
    };
  }

  /**
   * Faturamento dos últimos 7 dias (pedidos pagos) e os 5 produtos mais vendidos no período.
   * Os dias são os do calendário da loja (stores.time_zone), não do servidor.
   * Recurso do plano: relatórios (advanced_reports).
   */
  async getChartData(storeId: number, now: Date = new Date()) {
    await this.planLimits.assertFeature(storeId, 'advanced_reports');
    const timeZone = await this.storeTimeZone(storeId);
    const days = lastDayKeys(now, timeZone, CHART_DAYS);
    // Do primeiro dos 7 dias (meia-noite no fuso da loja) até o fim de hoje
    const today = dateKeyInZone(now, timeZone);
    const start = startOfDayInZone(
      addDaysToKey(today, -(CHART_DAYS - 1)),
      timeZone,
    );
    const end = startOfDayInZone(addDaysToKey(today, 1), timeZone);

    // Só o necessário, sem montar entidades (antes: todos os pedidos da semana com itens e produtos,
    // centenas de ms de CPU a cada 60 s por Dashboard aberto): os pagos, crus, para o faturamento, e
    // os mais vendidos somados no banco (como no relatório)
    const [paid, productsChart] = await Promise.all([
      this.orderRepository
        .createQueryBuilder('o')
        .select('o.created_at', 'created_at')
        .addSelect('o.total_price', 'total_price')
        .where('o.store_id = :storeId', { storeId })
        .andWhere('o.created_at >= :start', { start })
        .andWhere('o.created_at < :end', { end })
        .andWhere('o.status != :canceled', { canceled: OrderStatus.CANCELED })
        .andWhere('o.payment_status = :paid', { paid: PaymentStatus.PAID })
        .getRawMany<{ created_at: Date; total_price: string | number }>(),
      this.topProducts(storeId, start, end, CHART_TOP_PRODUCTS),
    ]);

    // Dias com zero também aparecem no gráfico
    const revenueCents = new Map<string, number>(days.map((day) => [day, 0]));
    for (const order of paid) {
      const key = dayKeyInZone(new Date(order.created_at), timeZone);
      const cents = revenueCents.get(key);
      if (cents === undefined) continue;
      revenueCents.set(key, cents + toCents(order.total_price));
    }

    const revenueChart = [...revenueCents.entries()].map(([date, cents]) => ({
      date,
      total: fromCents(cents),
    }));

    return { revenueChart, productsChart };
  }

  /**
   * GET /orders/reports?from=AAAA-MM-DD&to=AAAA-MM-DD — vendas da loja no período (até 366 dias,
   * datas do calendário da loja): faturamento por dia, pedidos por status e por forma de pagamento,
   * ticket médio e os 10 produtos mais vendidos. Recurso do plano: relatórios (advanced_reports).
   */
  async getReport(
    storeId: number,
    query: { from?: unknown; to?: unknown },
    now: Date = new Date(),
  ): Promise<OrdersReport> {
    await this.planLimits.assertFeature(storeId, 'advanced_reports');
    const timeZone = await this.storeTimeZone(storeId);
    const range = parseReportRange(query.from, query.to, now, timeZone);
    if (!range.ok) throw new BadRequestException(range.message);

    const start = startOfDayInZone(range.from, timeZone);
    const end = startOfDayInZone(addDaysToKey(range.to, 1), timeZone);
    // Linhas cruas (sem montar entidades): um ano de uma loja grande tem centenas de milhares de
    // pedidos, e montar uma entidade por linha travava o event loop de todas as lojas
    const [rows, topProducts] = await Promise.all([
      this.orderRepository
        .createQueryBuilder('o')
        .select('o.id', 'id')
        .addSelect('o.created_at', 'created_at')
        .addSelect('o.status', 'status')
        .addSelect('o.payment_status', 'payment_status')
        .addSelect('o.payment_method', 'payment_method')
        .addSelect('o.total_price', 'total_price')
        .where('o.store_id = :storeId', { storeId })
        .andWhere('o.created_at >= :start', { start })
        .andWhere('o.created_at < :end', { end })
        .orderBy('o.created_at', 'ASC')
        .getRawMany<ReportOrderRow>(),
      this.topProducts(storeId, start, end),
    ]);
    return buildOrdersReport(rows, range, timeZone, topProducts);
  }

  // ---------------------------------------------------------------------------
  // Internos
  // ---------------------------------------------------------------------------

  /** Pedido da loja informada (de outra loja ou inexistente → 404 uniforme). */
  private async getOrderOrFail(id: number, storeId: number): Promise<Order> {
    const order = await this.orderRepository.findOne({
      where: { id, store_id: storeId },
      relations: ORDER_RELATIONS,
      withDeleted: true,
      order: { items: { id: 'ASC' } },
    });
    if (!order) throw new NotFoundException(ORDER_NOT_FOUND_MESSAGE);
    return order;
  }

  /**
   * Pedido da loja que este perfil da equipe enxerga (cozinha e entregador: só os da própria etapa,
   * staffOrderScopes). Fora da etapa → o mesmo 404 de um pedido inexistente, também nas escritas
   * (PATCH de status e cancelamento): as mensagens das regras não revelam status, tipo nem entregador
   * de pedidos que o perfil não lê. Todas as mudanças permitidas a esses perfis são dentro da etapa.
   */
  private async getStaffOrderOrFail(
    id: number,
    storeId: number,
    actor: AuthUser,
  ): Promise<Order> {
    const order = await this.getOrderOrFail(id, storeId);
    if (!canStaffSeeOrder(visibilityOf(order), actor))
      throw new NotFoundException(ORDER_NOT_FOUND_MESSAGE);
    return order;
  }

  /**
   * Uma página de pedidos com as relações, mais novos primeiro, em duas etapas: primeiro só os ids da
   * página (consulta nos índices de orders, sem juntar itens), depois as relações desses pedidos. Com
   * relações e skip/take numa consulta só, o TypeORM juntava itens e adicionais de TODOS os pedidos
   * da loja antes do LIMIT (páginas fundas do histórico e o quadro liam o histórico inteiro).
   */
  private async findOrdersPage(
    where: FindOptionsWhere<Order> | FindOptionsWhere<Order>[],
    page: ListPage,
  ): Promise<Order[]> {
    return this.loadOrders(await this.findOrderHeads(where, page));
  }

  /** Primeira etapa: ids (e o que muda a resposta) da página, mais novos primeiro. */
  private findOrderHeads(
    where: FindOptionsWhere<Order> | FindOptionsWhere<Order>[],
    page: ListPage,
  ): Promise<OrderHead[]> {
    return this.orderRepository.find({
      select: {
        id: true,
        created_at: true,
        updated_at: true,
        status: true,
        payment_status: true,
      },
      where,
      withDeleted: true,
      order: { created_at: 'DESC', id: 'DESC' },
      skip: page.skip,
      take: page.take,
    });
  }

  /**
   * Segunda etapa: os pedidos com as relações, na ordem da primeira. Os itens são ordenados aqui (e
   * não no ORDER BY): ordenar por uma coluna dos itens faria o LIMIT contar linhas de itens.
   */
  private async loadOrders(heads: readonly OrderHead[]): Promise<Order[]> {
    if (!heads.length) return [];
    const found = await this.orderRepository.find({
      where: { id: In(heads.map((head) => head.id)) },
      relations: ORDER_RELATIONS,
      withDeleted: true,
    });
    const byId = new Map(found.map((order) => [order.id, order]));
    const orders: Order[] = [];
    for (const head of heads) {
      const order = byId.get(head.id);
      if (!order) continue;
      order.items?.sort((a, b) => a.id - b.id);
      orders.push(order);
    }
    return orders;
  }

  /** Guarda a resposta de um quadro (teto de pedidos guardados: os quadros mais antigos saem). */
  private rememberBoard(
    key: string,
    entry: Omit<BoardCacheEntry, 'expiresAt'>,
  ) {
    const previous = this.boardCache.get(key);
    if (previous) {
      this.boardCache.delete(key);
      this.boardCachedOrders -= previous.orders.length;
    }
    if (entry.orders.length > BOARD_CACHE_MAX_ORDERS) return;
    for (const [oldKey, old] of this.boardCache) {
      if (
        this.boardCachedOrders + entry.orders.length <=
        BOARD_CACHE_MAX_ORDERS
      )
        break;
      this.boardCache.delete(oldKey);
      this.boardCachedOrders -= old.orders.length;
    }
    this.boardCache.set(key, {
      ...entry,
      expiresAt: Date.now() + BOARD_CACHE_TTL_MS,
    });
    this.boardCachedOrders += entry.orders.length;
  }

  /**
   * Teto de pedidos pagos na entrega que um cliente deixa esperando a confirmação (PENDING) numa loja
   * (maxPendingOrdersPerCustomer): sem ele, um só cliente enche o quadro e consome a cota mensal do
   * plano da loja. 429 até a loja confirmar ou ele cancelar algum.
   */
  private async assertPendingOrdersBelowLimit(storeId: number, userId: number) {
    const limit = maxPendingOrdersPerCustomer();
    if (limit === null) return;
    const pending = await this.orderRepository.count({
      where: {
        store_id: storeId,
        user: { id: userId },
        status: OrderStatus.PENDING,
        payment_id: IsNull(),
      },
    });
    if (pending >= limit) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: pendingOrdersLimitMessage(limit),
          error: 'Too Many Requests',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Pedido do próprio cliente (de qualquer loja; na rota com :storeSlug, só daquela loja). */
  private async getCustomerOrderOrFail(
    id: number,
    userId: number,
    storeSlug?: string,
  ): Promise<Order> {
    const where: FindOptionsWhere<Order> = { id, user: { id: userId } };
    if (storeSlug !== undefined) {
      const store = await this.tenants.findStoreBySlug(storeSlug);
      if (!store) throw new NotFoundException(ORDER_NOT_FOUND_MESSAGE);
      where.store_id = store.id;
    }
    const order = await this.orderRepository.findOne({
      where,
      relations: ORDER_RELATIONS,
      withDeleted: true,
      order: { items: { id: 'ASC' } },
    });
    if (!order) throw new NotFoundException(ORDER_NOT_FOUND_MESSAGE);
    return order;
  }

  /**
   * Loja da equipe autenticada com a capacidade pedida (rotas que atendem cliente e equipe resolvem
   * aqui, sem o StoreStaffGuard). :storeSlug de outra loja → 403, como no guard.
   */
  private async staffTenant(
    actor: AuthUser,
    capability: 'read' | 'operate',
    storeSlug?: string,
  ): Promise<TenantContext> {
    const tenant = await this.tenants.staffContext(actor, capability);
    if (storeSlug !== undefined && storeSlug !== tenant.store.slug)
      throw new ForbiddenException(OTHER_STORE_MESSAGE);
    return tenant;
  }

  /** Resumo público das lojas (lista de campos permitidos, nunca a entidade inteira). */
  private async storeSummaries(
    ids: number[],
  ): Promise<Map<number, OrderStoreSummary>> {
    const unique = [...new Set(ids)].filter((id) => Number.isInteger(id));
    if (!unique.length) return new Map();
    const stores = await this.storeRepository.find({
      where: { id: In(unique) },
      select: { id: true, slug: true, name: true, logo: true },
    });
    return new Map(stores.map((store) => [store.id, orderStoreSummary(store)]));
  }

  /** Pedido do cliente com a loja em que foi feito (o cliente compra em várias lojas). */
  private async presentForCustomer(order: Order) {
    const stores = await this.storeSummaries([order.store_id]);
    return presentOrder(order, { store: stores.get(order.store_id) ?? null });
  }

  private async storeTimeZone(storeId: number): Promise<string> {
    const store = await this.storeRepository.findOne({
      where: { id: storeId },
      select: { id: true, time_zone: true },
    });
    return resolveTimeZone(store?.time_zone);
  }

  /**
   * Produtos mais vendidos (quantidade) dos pedidos não cancelados do período, pelo nome do retrato.
   * Empate na quantidade: ordem alfabética.
   */
  private async topProducts(
    storeId: number,
    start: Date,
    end: Date,
    limit: number = REPORT_TOP_PRODUCTS,
  ): Promise<ReportTopProduct[]> {
    const name = `COALESCE(item.product_name, product.name, 'Item removido')`;
    const rows = await this.orderRepository.manager
      .createQueryBuilder(OrderItem, 'item')
      .withDeleted()
      .innerJoin('item.order', 'o')
      .leftJoin('item.product', 'product')
      .select(name, 'name')
      .addSelect('SUM(item.quantity)', 'quantity')
      .where('o.store_id = :storeId', { storeId })
      .andWhere('o.created_at >= :start', { start })
      .andWhere('o.created_at < :end', { end })
      .andWhere('o.status != :canceled', { canceled: OrderStatus.CANCELED })
      .groupBy(name)
      .orderBy('quantity', 'DESC')
      .addOrderBy('name', 'ASC')
      .limit(limit)
      .getRawMany<{ name: string; quantity: string | number }>();
    return rows.map((row) => ({
      name: row.name,
      quantity: Number(row.quantity),
    }));
  }

  /**
   * Cancela (pedido já validado pelas regras): grava CANCELED — com REFUND_PENDING junto quando há
   * estorno, para a equipe ver se algo falhar no meio —, estorna e audita quando é a equipe.
   * Devolve a situação do pagamento depois do estorno (null quando não havia o que estornar).
   */
  private async cancelOrder(
    storeId: number,
    order: Order,
    actor: AuthUser,
    via: 'cancel' | 'status',
    request?: Request,
  ): Promise<PaymentStatus | null> {
    const changes: OrderChanges = { status: OrderStatus.CANCELED };
    const refund = needsRefundOnCancel(order);
    if (refund) changes.payment_status = PaymentStatus.REFUND_PENDING;
    await this.applyChanges(storeId, order, changes);
    const paymentStatus = refund
      ? await this.refundCanceled(storeId, order, actor)
      : null;

    if (isStaffRole(actor.role)) {
      await this.audit.record({
        actor,
        storeId,
        action: 'order.cancel',
        targetType: 'order',
        targetId: order.id,
        metadata: {
          from_status: order.status,
          via,
          payment_method: order.payment_method,
          total: Number(order.total_price),
          refund: paymentStatus,
        },
        request,
      });
    }
    return paymentStatus;
  }

  /**
   * Grava a mudança só se o pedido continua no status que foi lido (e, ao assumir uma entrega, ainda sem
   * entregador): se outra pessoa mexeu no meio do caminho, responde 409 em vez de sobrescrever.
   * Critério composto { id, store_id }: nunca altera pedido de outra loja.
   */
  private async applyChanges(
    storeId: number,
    order: Order,
    changes: OrderChanges,
    options: { requireNoDriver?: boolean } = {},
  ) {
    const query = this.orderRepository
      .createQueryBuilder()
      .update(Order)
      .set(changes)
      .where('id = :id', { id: order.id })
      .andWhere('store_id = :storeId', { storeId })
      .andWhere('status = :current', { current: order.status });
    if (options.requireNoDriver) query.andWhere('driver_id IS NULL');

    const result = await query.execute();
    if (!result.affected) {
      throw new ConflictException(
        'O pedido acabou de ser atualizado por outra pessoa. Atualize a lista e tente novamente.',
      );
    }
  }

  /**
   * Estorna o pagamento online de um pedido que acabou de ser cancelado (já gravado como
   * REFUND_PENDING), com a credencial da loja do pedido: deu certo → REFUNDED; falhou → continua
   * REFUND_PENDING, visível para a equipe.
   */
  private async refundCanceled(
    storeId: number,
    order: Order,
    actor: AuthUser,
  ): Promise<PaymentStatus> {
    const refunded = await this.payments.refund(
      Number(order.payment_id),
      storeId,
      { actor, reason: 'order_canceled', orderId: order.id },
    );
    const status = paymentStatusAfterRefund(refunded);
    if (status === PaymentStatus.REFUND_PENDING) return status;
    await this.orderRepository.update(
      {
        id: order.id,
        store_id: storeId,
        payment_status: PaymentStatus.REFUND_PENDING,
      },
      { payment_status: status },
    );
    return status;
  }
}

/** Campos da regra de visibilidade da equipe (canStaffSeeOrder). */
function visibilityOf(order: Order) {
  return {
    status: order.status,
    type: order.type,
    driverId: order.driver?.id ?? null,
    updated_at: order.updated_at,
  };
}

/** Pedido no formato do perfil da equipe (gestão completa; cozinha e entregador, só o que usam). */
function presentForStaff(order: Order, actor: Pick<OrderActor, 'role'>) {
  return presentOrder(order, { view: staffOrderView(actor.role) });
}

/** Condição do TypeORM de um conjunto de pedidos visíveis a um perfil (staffOrderScopes). */
function scopeWhere(
  storeId: number,
  scope: StaffOrderScope,
  actorId: number,
): FindOptionsWhere<Order> {
  const where: FindOptionsWhere<Order> = {
    store_id: storeId,
    status: In([...scope.statuses]),
  };
  if (scope.type) where.type = scope.type;
  if (scope.driver === 'none') where.driver = IsNull();
  if (scope.driver === 'self') where.driver = { id: actorId };
  if (scope.recent) where.updated_at = MoreThanOrEqual(activeScopeSince());
  return where;
}

function ruleError(decision: { status: 400 | 403; message: string }) {
  return decision.status === 403
    ? new ForbiddenException(decision.message)
    : new BadRequestException(decision.message);
}
