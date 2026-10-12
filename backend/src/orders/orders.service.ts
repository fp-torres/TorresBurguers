import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  FindOptionsRelations,
  In,
  IsNull,
  MoreThanOrEqual,
  Not,
  Repository,
} from 'typeorm';
import { CreateOrderDto, QuoteOrderDto } from './dto/create-order.dto';
import { Order } from './entities/order.entity';
import { OrderStatus, OrderType, PaymentStatus } from './order.enums';
import { User, UserRole } from '../users/entities/user.entity';
import { PaymentService } from '../payment/payment.service';
import {
  OrderPricingService,
  STORE_CLOSED_MESSAGE,
  toQuoteResponse,
} from './order-pricing.service';
import { presentOrder } from './order-presenter';
import { buildOrder, toOrderSnapshot } from './order-snapshot';
import {
  TERMINAL_STATUSES,
  activeScopeSince,
  chartWindowStart,
  checkAssign,
  checkCancel,
  checkStatusChange,
  dayKeyInZone,
  fromCents,
  isStaffRole,
  lastDayKeys,
  needsRefundOnCancel,
  normalizeText,
  paymentStatusAfterRefund,
  resolveChangeFor,
  shouldMarkPaidOnStatus,
  storeTimeZone,
  toCents,
  type OrderActor,
  type OrdersScope,
} from './order-rules';

// Relações de um pedido completo. withDeleted: produtos, adicionais, cliente e entregador que foram
// para a lixeira continuam aparecendo no histórico.
const ORDER_RELATIONS: FindOptionsRelations<Order> = {
  items: { product: true, addons: true },
  user: true,
  address: true,
  driver: true,
};

type OrderChanges = {
  status: OrderStatus;
  driver?: { id: number };
  payment_status?: PaymentStatus;
};

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly pricing: OrderPricingService,
    private readonly payments: PaymentService,
  ) {}

  // ---------------------------------------------------------------------------
  // Cliente
  // ---------------------------------------------------------------------------

  /** POST /orders/quote — valores calculados pelo servidor (loja fechada → store_open:false). */
  async quote(dto: QuoteOrderDto, actor: OrderActor) {
    return toQuoteResponse(await this.pricing.price(dto, actor.id));
  }

  async create(dto: CreateOrderDto, actor: OrderActor) {
    // Pago online: o servidor cria o pedido quando o pagamento é aprovado (com o pedido e os preços
    // da hora do pagamento). Aqui só devolvemos esse pedido — idempotente para o mesmo cliente.
    if (dto.paymentId !== undefined && dto.paymentId !== null) {
      const orderId = await this.payments.orderIdForPayment(dto, actor);
      return presentOrder(await this.getOrderOrFail(orderId));
    }

    const priced = await this.pricing.price(dto, actor.id);
    if (!priced.store_open) throw new BadRequestException(STORE_CLOSED_MESSAGE);

    const change = resolveChangeFor(
      dto.paymentMethod,
      dto.changeFor,
      priced.totalCents,
    );
    if (!change.ok) throw new BadRequestException(change.message);

    // Pago na entrega/retirada: pagamento pendente até a entrega
    const order = this.orderRepository.create(
      buildOrder(toOrderSnapshot(priced), {
        userId: actor.id,
        paymentMethod: dto.paymentMethod,
        paymentStatus: PaymentStatus.PENDING,
        paymentId: null,
        changeFor: change.value,
      }),
    );
    const saved = await this.orderRepository.save(order);
    return presentOrder(await this.getOrderOrFail(saved.id));
  }

  /** Pedidos do próprio usuário, mais recentes primeiro. */
  async findMyOrders(userId: number) {
    const orders = await this.orderRepository.find({
      where: { user: { id: userId } },
      relations: ORDER_RELATIONS,
      withDeleted: true,
      order: { created_at: 'DESC', id: 'DESC', items: { id: 'ASC' } },
    });
    return orders.map(presentOrder);
  }

  /** Dono do pedido ou equipe; outro cliente → 403; inexistente → 404. */
  async findOneFor(id: number, actor: OrderActor) {
    const order = await this.getOrderOrFail(id);
    if (!isStaffRole(actor.role) && order.user?.id !== actor.id) {
      throw new ForbiddenException(
        'Você não tem permissão para ver este pedido.',
      );
    }
    return presentOrder(order);
  }

  /**
   * Dono: só enquanto PENDING. ADMIN/EMPLOYEE: enquanto não for final.
   * Pago online → estorno (REFUNDED; se falhar, REFUND_PENDING para a equipe resolver).
   */
  async cancel(id: number, actor: OrderActor) {
    const order = await this.getOrderOrFail(id);
    const decision = checkCancel({
      role: actor.role,
      isOwner: order.user?.id === actor.id,
      status: order.status,
    });
    if (!decision.ok) throw ruleError(decision);

    const changes: OrderChanges = { status: OrderStatus.CANCELED };
    const refund = needsRefundOnCancel(order);
    // Marca o estorno como pendente junto com o cancelamento: se algo falhar no meio, a equipe vê
    if (refund) changes.payment_status = PaymentStatus.REFUND_PENDING;
    await this.applyChanges(order, changes);
    if (refund) await this.refundCanceled(order);
    return presentOrder(await this.getOrderOrFail(id));
  }

  // ---------------------------------------------------------------------------
  // Equipe
  // ---------------------------------------------------------------------------

  /**
   * Lista da equipe. scope "active" (quadros): pedidos em andamento, os concluídos/cancelados nas
   * últimas 24 h e os com estorno pendente (de qualquer data), mais novos primeiro. Sem scope: todos.
   * Mesma regra de isInActiveScope (order-rules.ts).
   */
  async findAll(scope: OrdersScope = 'all') {
    const where =
      scope === 'active'
        ? [
            { status: Not(In([...TERMINAL_STATUSES])) },
            { updated_at: MoreThanOrEqual(activeScopeSince()) },
            { payment_status: PaymentStatus.REFUND_PENDING },
          ]
        : undefined;
    const orders = await this.orderRepository.find({
      where,
      relations: ORDER_RELATIONS,
      withDeleted: true,
      order: { created_at: 'DESC', id: 'DESC', items: { id: 'ASC' } },
    });
    return orders.map(presentOrder);
  }

  /** PATCH /orders/:id {status} — regras de transição por perfil em order-rules.ts. */
  async updateStatus(id: number, status: OrderStatus, actor: OrderActor) {
    const order = await this.getOrderOrFail(id);
    const decision = checkStatusChange({
      role: actor.role,
      actorId: actor.id,
      from: order.status,
      to: status,
      type: order.type,
      driverId: order.driver?.id ?? null,
    });
    if (!decision.ok) throw ruleError(decision);

    const changes: OrderChanges = { status };
    // Entregador que pega um pedido sem responsável passa a ser o responsável
    if (decision.assignDriverId)
      changes.driver = { id: decision.assignDriverId };
    // Pago na entrega/retirada: concluir o pedido quita o pagamento
    if (shouldMarkPaidOnStatus(status, order.payment_id))
      changes.payment_status = PaymentStatus.PAID;
    // Cancelado pelo quadro (ADMIN/EMPLOYEE) e pago online: estorno, como em /cancel
    const refund =
      status === OrderStatus.CANCELED && needsRefundOnCancel(order);
    if (refund) changes.payment_status = PaymentStatus.REFUND_PENDING;

    await this.applyChanges(order, changes, {
      requireNoDriver: !!decision.assignDriverId,
    });
    if (refund) await this.refundCanceled(order);
    return presentOrder(await this.getOrderOrFail(id));
  }

  /** PATCH /orders/:id/assign — atribui um entregador ativo e coloca o pedido em DELIVERING. */
  async assignDriver(id: number, driverId: number) {
    const order = await this.getOrderOrFail(id);
    const decision = checkAssign({ status: order.status, type: order.type });
    if (!decision.ok) throw ruleError(decision);

    // Usuários na lixeira não aparecem (entregador precisa estar ativo)
    const driver = await this.userRepository.findOne({
      where: { id: driverId },
    });
    if (!driver)
      throw new NotFoundException('Entregador não encontrado ou inativo.');
    if (driver.role !== UserRole.COURIER)
      throw new BadRequestException(
        'O usuário selecionado não é um entregador.',
      );

    await this.applyChanges(order, {
      status: OrderStatus.DELIVERING,
      driver: { id: driver.id },
    });
    return presentOrder(await this.getOrderOrFail(id));
  }

  /** Entregadores ativos (dados de contato apenas). */
  getAvailableDrivers() {
    return this.userRepository.find({
      where: { role: UserRole.COURIER },
      select: { id: true, name: true, phone: true, avatar: true },
      order: { name: 'ASC' },
    });
  }

  /** Pedidos prontos, sem entregador, no mesmo bairro do pedido informado (para agrupar entregas). */
  async getNearbyOrders(id: number) {
    const target = await this.orderRepository.findOne({
      where: { id },
      relations: { address: true },
    });
    if (!target) throw new NotFoundException('Pedido não encontrado.');
    if (target.type !== OrderType.DELIVERY || !target.address) return [];

    const neighborhood = normalizeText(target.address.neighborhood);
    const candidates = await this.orderRepository.find({
      where: {
        id: Not(id),
        status: OrderStatus.READY_FOR_PICKUP,
        type: OrderType.DELIVERY,
        driver: IsNull(),
      },
      relations: { address: true, user: true },
      withDeleted: true,
      order: { created_at: 'ASC' },
    });

    return candidates
      .filter(
        (order) =>
          order.address &&
          normalizeText(order.address.neighborhood) === neighborhood,
      )
      .map(presentOrder);
  }

  // ---------------------------------------------------------------------------
  // Dashboard (somente ADMIN) — faturamento conta apenas pedidos PAGOS e não cancelados
  // ---------------------------------------------------------------------------

  async getDashboardSummary() {
    const activeStatuses = Not(OrderStatus.CANCELED);
    const [
      totalOrders,
      pendingOrders,
      preparingOrders,
      pendingPayments,
      revenueRow,
    ] = await Promise.all([
      this.orderRepository.count({ where: { status: activeStatuses } }),
      this.orderRepository.count({ where: { status: OrderStatus.PENDING } }),
      this.orderRepository.count({ where: { status: OrderStatus.PREPARING } }),
      // Pedidos em andamento ainda sem pagamento
      this.orderRepository
        .createQueryBuilder('o')
        .where('o.payment_status = :pending', {
          pending: PaymentStatus.PENDING,
        })
        .andWhere('o.status NOT IN (:...closed)', {
          closed: [OrderStatus.CANCELED, OrderStatus.DONE],
        })
        .getCount(),
      this.orderRepository
        .createQueryBuilder('o')
        .select('COALESCE(SUM(o.total_price), 0)', 'total')
        .where('o.payment_status = :paid', { paid: PaymentStatus.PAID })
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
   * Os dias são os do calendário da loja (STORE_TIME_ZONE, padrão America/Sao_Paulo), não do servidor.
   */
  async getChartData(now: Date = new Date()) {
    const timeZone = storeTimeZone();
    const days = lastDayKeys(now, timeZone, 7);

    // Busca com folga e filtra pelo dia no fuso da loja
    const orders = await this.orderRepository.find({
      where: {
        created_at: MoreThanOrEqual(chartWindowStart(now, timeZone, 7)),
        status: Not(OrderStatus.CANCELED),
      },
      relations: { items: { product: true } },
      withDeleted: true,
      order: { created_at: 'ASC' },
    });

    // Dias com zero também aparecem no gráfico
    const revenueCents = new Map<string, number>(days.map((day) => [day, 0]));

    const topProducts = new Map<string, number>();
    for (const order of orders) {
      const key = dayKeyInZone(new Date(order.created_at), timeZone);
      if (!revenueCents.has(key)) continue;
      if (order.payment_status === PaymentStatus.PAID) {
        revenueCents.set(
          key,
          (revenueCents.get(key) ?? 0) + toCents(order.total_price),
        );
      }
      for (const item of order.items ?? []) {
        const name = item.product_name ?? item.product?.name ?? 'Item removido';
        topProducts.set(name, (topProducts.get(name) ?? 0) + item.quantity);
      }
    }

    const revenueChart = [...revenueCents.entries()].map(([date, cents]) => ({
      date,
      total: fromCents(cents),
    }));
    const productsChart = [...topProducts.entries()]
      .map(([name, quantity]) => ({ name, quantity }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 5);

    return { revenueChart, productsChart };
  }

  // ---------------------------------------------------------------------------
  // Internos
  // ---------------------------------------------------------------------------

  private async getOrderOrFail(id: number): Promise<Order> {
    const order = await this.orderRepository.findOne({
      where: { id },
      relations: ORDER_RELATIONS,
      withDeleted: true,
      order: { items: { id: 'ASC' } },
    });
    if (!order) throw new NotFoundException('Pedido não encontrado.');
    return order;
  }

  /**
   * Grava a mudança só se o pedido continua no status que foi lido (e, ao assumir uma entrega, ainda sem
   * entregador): se outra pessoa mexeu no meio do caminho, responde 409 em vez de sobrescrever.
   */
  private async applyChanges(
    order: Order,
    changes: OrderChanges,
    options: { requireNoDriver?: boolean } = {},
  ) {
    const query = this.orderRepository
      .createQueryBuilder()
      .update(Order)
      .set(changes)
      .where('id = :id', { id: order.id })
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
   * REFUND_PENDING): deu certo → REFUNDED; falhou → continua REFUND_PENDING, visível para a equipe.
   */
  private async refundCanceled(order: Order): Promise<void> {
    const refunded = await this.payments.refund(Number(order.payment_id));
    const status = paymentStatusAfterRefund(refunded);
    if (status === PaymentStatus.REFUND_PENDING) return;
    await this.orderRepository.update(
      { id: order.id, payment_status: PaymentStatus.REFUND_PENDING },
      { payment_status: status },
    );
  }
}

function ruleError(decision: { status: 400 | 403; message: string }) {
  return decision.status === 403
    ? new ForbiddenException(decision.message)
    : new BadRequestException(decision.message);
}
