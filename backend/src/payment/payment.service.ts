import { randomUUID } from 'crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThan, Repository } from 'typeorm';
import { BRAND } from '../config/brand';
import { isUniqueViolation } from '../common/database-errors';
import { Order } from '../orders/entities/order.entity';
import { User } from '../users/entities/user.entity';
import { OrderStatus, PaymentStatus } from '../orders/order.enums';
import {
  OrderPricingService,
  STORE_CLOSED_MESSAGE,
  type PricedOrder,
} from '../orders/order-pricing.service';
import { CreateOrderDto, QuoteOrderDto } from '../orders/dto/create-order.dto';
import { formatBRL, isStaffRole, type OrderActor } from '../orders/order-rules';
import {
  buildOrder,
  isOrderSnapshot,
  toOrderSnapshot,
} from '../orders/order-snapshot';
import {
  CreateCardPaymentDto,
  CreatePixPaymentDto,
} from './dto/create-payment.dto';
import { Payment, type OrderRequestPayload } from './entities/payment.entity';
import {
  MercadoPagoGateway,
  type MercadoPagoCreateBody,
  type PaymentGateway,
} from './mercado-pago.gateway';
import {
  PAYMENT_ALREADY_USED_MESSAGE,
  PAYMENT_ORDER_CANCELED_MESSAGE,
  PENDING_PAYMENT_STATUSES,
  SIMULATED_ID_BASE,
  amountMatches,
  cardOrderMethod,
  describeMercadoPagoError,
  externalReferenceUserId,
  isFinalPaymentStatus,
  isSimulatedPaymentId,
  mercadoPagoDate,
  parseWebhookPaymentId,
  paymentKindFor,
  resolvePaymentMode,
  simulatedPixProgress,
  splitPayerName,
  type PaymentKind,
  type PaymentMode,
} from './payment-rules';

export interface CardPaymentResult {
  id: number;
  status: string;
  status_detail: string | null;
  amount: number;
  simulation?: true;
  /** Pedido criado pelo servidor (presente quando o pagamento está aprovado). */
  orderId?: number;
}

export interface PixPaymentResult {
  id: number;
  status: string;
  qr_code: string;
  qr_code_base64: string | null;
  ticket_url: string | null;
  amount: number;
  /** Vencimento do código (ISO 8601): os apps fazem a contagem regressiva até ele. */
  expires_at: string | null;
  simulation?: true;
}

export interface PaymentStatusResult {
  id: number;
  status: string;
  status_detail: string | null;
  /** Pedido criado pelo servidor (presente assim que existir). */
  orderId?: number;
}

type NewPayment = Omit<Payment, 'created_at' | 'updated_at'>;

const NOT_CONFIGURED_MESSAGE =
  'Pagamento online indisponível: configure MP_ACCESS_TOKEN no servidor ou escolha pagar na entrega.';
const APPROVED_CANNOT_CANCEL_MESSAGE =
  'Este pagamento já foi aprovado e não pode mais ser cancelado. O pedido aparece em Meus Pedidos.';
const ORDER_PENDING_MESSAGE =
  'Pagamento aprovado, mas o pedido ainda não foi registrado. Ele aparece em Meus Pedidos em instantes; não pague de novo.';
/** Pagamentos sem pedido revistos pela conciliação (PIX vence em minutos; cartão em análise pode levar dias). */
const RECONCILE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const RECONCILE_BATCH = 50;

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : describeMercadoPagoError(error).message;
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  private readonly mode: PaymentMode;
  /** Mercado Pago (null sem MP_ACCESS_TOKEN). Os testes trocam por um dublê. */
  private gateway: PaymentGateway | null;
  private lastSimulatedId = 0;
  /** Tentativas com a mesma chave de idempotência em andamento neste processo. */
  private readonly creating = new Map<string, Promise<Payment>>();
  /** Pedidos sendo criados por pagamento (status, webhook e conciliação podem chegar juntos). */
  private readonly finalizing = new Map<number, Promise<number | null>>();

  constructor(
    private readonly pricing: OrderPricingService,
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    config: ConfigService,
  ) {
    this.mode = resolvePaymentMode({
      NODE_ENV: config.get<string>('NODE_ENV'),
      MP_ACCESS_TOKEN: config.get<string>('MP_ACCESS_TOKEN'),
      PAYMENT_SANDBOX: config.get<string>('PAYMENT_SANDBOX'),
      PIX_SANDBOX_APPROVAL_SECONDS: config.get<string>(
        'PIX_SANDBOX_APPROVAL_SECONDS',
      ),
      PIX_EXPIRATION_MINUTES: config.get<string>('PIX_EXPIRATION_MINUTES'),
      MP_NOTIFICATION_URL: config.get<string>('MP_NOTIFICATION_URL'),
    });

    this.gateway = this.mode.accessToken
      ? new MercadoPagoGateway(this.mode.accessToken)
      : null;

    if (this.mode.sandboxRefused) {
      this.logger.error(
        'PAYMENT_SANDBOX=true foi IGNORADO: o sandbox só funciona com NODE_ENV=development ou test.',
      );
    }
    if (this.mode.pixExpirationAdjusted) {
      this.logger.warn(
        'PIX_EXPIRATION_MINUTES abaixo de 30: o Mercado Pago exige pelo menos 30 minutos (usando 30).',
      );
    }
    if (this.mode.sandbox) {
      this.logger.warn(
        `Pagamentos em modo SANDBOX: recusas/falhas do Mercado Pago viram aprovações simuladas e PIX é aprovado após ${this.mode.pixApprovalSeconds}s.` +
          (this.gateway
            ? ''
            : ' (MP_ACCESS_TOKEN ausente: tudo será simulado)'),
      );
    } else if (!this.gateway) {
      this.logger.error(
        'MP_ACCESS_TOKEN não configurado: pagamentos online ficarão indisponíveis.',
      );
    } else {
      this.logger.log('Pagamentos em modo PRODUÇÃO (Mercado Pago).');
    }
  }

  // ---------------------------------------------------------------------------
  // Cartão
  // ---------------------------------------------------------------------------

  /** Cobra o cartão; aprovado na hora → o pedido já é criado e volta em orderId. */
  async createCardPayment(
    dto: CreateCardPaymentDto,
    actor: OrderActor,
  ): Promise<CardPaymentResult> {
    const record = await this.once(actor.id, dto.idempotencyKey, 'CARD', () =>
      this.chargeCard(dto, actor),
    );
    if (record.status === 'approved') await this.finalizeSafely(record);
    return cardResult(record);
  }

  private async chargeCard(
    dto: CreateCardPaymentDto,
    actor: OrderActor,
  ): Promise<Payment> {
    const priced = await this.priceForCharge(dto.order, actor.id);
    const base = this.newRecord(actor.id, 'CARD', dto, priced, {
      orderPaymentMethod: cardOrderMethod(dto.paymentMethodId),
      paymentMethodId: dto.paymentMethodId,
    });

    if (!this.gateway) {
      if (!this.mode.sandbox)
        throw new ServiceUnavailableException(NOT_CONFIGURED_MESSAGE);
      return this.saveSimulatedCard(base, 'MP_ACCESS_TOKEN não configurado');
    }

    let result: Awaited<ReturnType<PaymentGateway['createPayment']>>;
    try {
      result = await this.gateway.createPayment(
        {
          transaction_amount: base.amount,
          token: dto.token,
          description: this.description(),
          installments: dto.installments ?? 1,
          payment_method_id: dto.paymentMethodId,
          external_reference: base.external_reference ?? undefined,
          ...this.notification(),
          payer: {
            email: dto.email ?? actor.email,
            identification: {
              type:
                dto.docType ?? (dto.docNumber.length === 14 ? 'CNPJ' : 'CPF'),
              number: dto.docNumber,
            },
          },
        },
        // Repassada ao Mercado Pago: a mesma tentativa nunca vira duas cobranças
        dto.idempotencyKey ?? randomUUID(),
      );
    } catch (error) {
      const reason = describeMercadoPagoError(error);
      if (this.mode.sandbox)
        return this.saveSimulatedCard(
          base,
          `falha no Mercado Pago (${reason.message})`,
        );
      throw this.toHttpError(reason, 'Pagamento com cartão não processado');
    }

    const id = Number(result.id);
    const status = result.status ?? 'unknown';
    if (this.mode.sandbox && (status !== 'approved' || !id)) {
      return this.saveSimulatedCard(
        base,
        `cartão "${status}" (${result.status_detail ?? 'sem detalhe'}) no sandbox`,
      );
    }
    if (!id)
      throw new BadGatewayException(
        'O Mercado Pago não confirmou o pagamento. Tente novamente.',
      );

    return this.saveRecord({
      ...base,
      id,
      amount: Number(result.transaction_amount ?? base.amount),
      status,
      status_detail: result.status_detail ?? null,
      order_payment_method: cardOrderMethod(
        dto.paymentMethodId,
        result.payment_type_id,
      ),
    });
  }

  // ---------------------------------------------------------------------------
  // PIX
  // ---------------------------------------------------------------------------

  /** Gera o PIX (vence em PIX_EXPIRATION_MINUTES). O pedido é criado pelo servidor quando for pago. */
  async createPixPayment(
    dto: CreatePixPaymentDto,
    actor: OrderActor,
  ): Promise<PixPaymentResult> {
    const record = await this.once(actor.id, dto.idempotencyKey, 'PIX', () =>
      this.chargePix(dto, actor),
    );
    return pixResult(record);
  }

  private async chargePix(
    dto: CreatePixPaymentDto,
    actor: OrderActor,
  ): Promise<Payment> {
    const priced = await this.priceForCharge(dto.order, actor.id);
    const base = this.newRecord(actor.id, 'PIX', dto, priced, {
      orderPaymentMethod: 'PIX',
      paymentMethodId: 'pix',
    });
    const expiresAt = new Date(
      Date.now() + this.mode.pixExpirationMinutes * 60_000,
    );

    if (!this.gateway) {
      if (!this.mode.sandbox)
        throw new ServiceUnavailableException(NOT_CONFIGURED_MESSAGE);
      return this.saveMockPix(
        base,
        expiresAt,
        'MP_ACCESS_TOKEN não configurado',
      );
    }

    let result: Awaited<ReturnType<PaymentGateway['createPayment']>>;
    try {
      const payerName = splitPayerName(
        actor.name || (await this.lookupUserName(actor.id)),
      );
      result = await this.gateway.createPayment(
        {
          transaction_amount: base.amount,
          description: this.description(),
          payment_method_id: 'pix',
          external_reference: base.external_reference ?? undefined,
          date_of_expiration: mercadoPagoDate(expiresAt),
          ...this.notification(),
          payer: { email: actor.email, ...payerName },
        },
        dto.idempotencyKey ?? randomUUID(),
      );
      if (
        !Number(result.id) ||
        !result.point_of_interaction?.transaction_data?.qr_code
      )
        throw new Error('o Mercado Pago não devolveu o QR Code do PIX');
    } catch (error) {
      const reason = describeMercadoPagoError(error);
      if (this.mode.sandbox)
        return this.saveMockPix(
          base,
          expiresAt,
          `falha no Mercado Pago (${reason.message})`,
        );
      throw this.toHttpError(reason, 'Não foi possível gerar o PIX');
    }

    const data = result.point_of_interaction?.transaction_data;
    const remoteExpiry = result.date_of_expiration
      ? new Date(result.date_of_expiration)
      : null;
    return this.saveRecord({
      ...base,
      id: Number(result.id),
      amount: Number(result.transaction_amount ?? base.amount),
      status: result.status ?? 'pending',
      status_detail: result.status_detail ?? null,
      // Em sandbox ninguém paga o PIX de verdade: a aprovação será simulada
      simulated: this.mode.sandbox,
      auto_approve_at: this.mode.sandbox ? this.autoApproveAt() : null,
      expires_at:
        remoteExpiry && !Number.isNaN(remoteExpiry.getTime())
          ? remoteExpiry
          : expiresAt,
      pix_data: {
        qr_code: data?.qr_code ?? '',
        qr_code_base64: data?.qr_code_base64 ?? null,
        ticket_url: data?.ticket_url ?? null,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Consulta (polling), cancelamento e notificações
  // ---------------------------------------------------------------------------

  /** GET /payment/status/:id — somente o pagador ou a equipe. Aprovado → o pedido é criado aqui. */
  async getStatusFor(
    paymentId: number,
    actor: OrderActor,
  ): Promise<PaymentStatusResult> {
    const record = await this.findRecord(paymentId);
    if (!record) throw new NotFoundException('Pagamento não encontrado.');
    if (record.user_id !== actor.id && !isStaffRole(actor.role)) {
      throw new ForbiddenException(
        'Você não tem permissão para consultar este pagamento.',
      );
    }

    await this.refresh(record, false);
    if (record.status === 'approved') await this.finalizeSafely(record);
    return statusResult(record);
  }

  /** POST /payment/:id/cancel — o pagador desiste de um pagamento pendente (o PIX deixa de valer). */
  async cancelFor(
    paymentId: number,
    actor: OrderActor,
  ): Promise<{ id: number; status: string }> {
    const record = await this.findRecord(paymentId);
    if (!record) throw new NotFoundException('Pagamento não encontrado.');
    if (record.user_id !== actor.id) {
      throw new ForbiddenException(
        'Somente quem fez o pagamento pode cancelá-lo.',
      );
    }

    await this.refresh(record, false);
    if (record.status === 'approved' || record.order_id !== null) {
      await this.finalizeSafely(record);
      throw new ConflictException(APPROVED_CANNOT_CANCEL_MESSAGE);
    }
    // Já cancelado, recusado ou vencido: nada a fazer
    if (!PENDING_PAYMENT_STATUSES.includes(record.status)) {
      return { id: record.id, status: record.status };
    }

    if (!record.simulated && this.gateway) {
      try {
        const remote = await this.gateway.cancelPayment(
          record.id,
          `cancel-${record.id}`,
        );
        record.status = remote.status ?? 'cancelled';
        record.status_detail = remote.status_detail ?? 'by_payer';
      } catch (error) {
        // Pode ter sido pago no mesmo instante: confere antes de responder
        await this.refresh(record, true).catch(() => undefined);
        if (record.status === 'approved') {
          await this.finalizeSafely(record);
          throw new ConflictException(APPROVED_CANNOT_CANCEL_MESSAGE);
        }
        if (!this.mode.sandbox) {
          this.logger.warn(
            `Não foi possível cancelar o pagamento #${record.id}: ${describeMercadoPagoError(error).message}`,
          );
          throw new BadGatewayException(
            'Não foi possível cancelar o pagamento no Mercado Pago agora. Tente novamente em instantes.',
          );
        }
        record.status = 'cancelled';
        record.status_detail = 'by_payer';
      }
    } else {
      record.status = 'cancelled';
      record.status_detail = 'by_payer';
    }

    await this.paymentRepository.update(
      { id: record.id },
      { status: record.status, status_detail: record.status_detail },
    );
    if (record.status === 'approved') {
      await this.finalizeSafely(record);
      throw new ConflictException(APPROVED_CANNOT_CANCEL_MESSAGE);
    }
    this.logger.log(`Pagamento #${record.id} cancelado pelo cliente.`);
    return { id: record.id, status: record.status };
  }

  /**
   * POST /payment/webhook: o corpo NÃO é confiável — serve só para saber qual pagamento reconsultar
   * no Mercado Pago (pagamentos que não são deste servidor são ignorados). Responde na hora.
   */
  handleNotification(body: unknown, query: Record<string, unknown>): void {
    const paymentId = parseWebhookPaymentId(body, query);
    if (!paymentId) return;
    void this.processNotification(paymentId).catch((error: unknown) =>
      this.logger.warn(
        `Notificação do pagamento #${paymentId} não processada: ${errorText(error)}`,
      ),
    );
  }

  private async processNotification(paymentId: number): Promise<void> {
    const record = await this.findRecord(paymentId);
    if (!record) return;
    await this.refresh(record, false);
    if (record.status === 'approved') await this.finalizeSafely(record);
  }

  // ---------------------------------------------------------------------------
  // Pedido do pagamento
  // ---------------------------------------------------------------------------

  /**
   * POST /orders com paymentId (apps antigos e repetições após perda da resposta): devolve o pedido
   * do pagamento, criando-o com o retrato guardado na hora do pagamento quando ainda não existe.
   * Idempotente para o mesmo cliente; o corpo enviado não muda o pedido.
   */
  async orderIdForPayment(
    dto: CreateOrderDto,
    actor: OrderActor,
  ): Promise<number> {
    const paymentId = Number(dto.paymentId);
    let record = await this.findRecord(paymentId);

    if (!record) {
      // Pedido de um pagamento anterior a esta versão (registro em memória)
      const legacy = await this.orderRepository.findOne({
        where: { payment_id: paymentId, user: { id: actor.id } },
        select: { id: true, status: true },
      });
      if (legacy) return usableOrderId(legacy);
      record = await this.recoverFromMercadoPago(dto, actor);
    }
    if (!record)
      throw new BadRequestException(
        'Pagamento não encontrado ou expirado. Faça o pagamento novamente.',
      );
    if (record.user_id !== actor.id)
      throw new BadRequestException('Este pagamento pertence a outro usuário.');
    if (paymentKindFor(dto.paymentMethod) !== record.method) {
      throw new BadRequestException(
        'A forma de pagamento do pedido não corresponde ao pagamento informado.',
      );
    }

    let orderId = record.order_id;
    if (orderId === null) {
      await this.refresh(record, true);
      if (record.status !== 'approved') {
        throw new BadRequestException(
          `O pagamento ainda não foi aprovado (status: ${record.status}).`,
        );
      }
      orderId = await this.finalize(record);
      if (orderId === null) {
        throw record.finalize_error
          ? new BadRequestException(
              `Não foi possível registrar o pedido deste pagamento: ${record.finalize_error}.`,
            )
          : new ServiceUnavailableException(ORDER_PENDING_MESSAGE);
      }
    }

    const order = await this.orderRepository.findOne({
      where: { id: orderId },
      select: { id: true, status: true },
    });
    if (!order) throw new BadRequestException(PAYMENT_ALREADY_USED_MESSAGE);
    return usableOrderId(order);
  }

  /**
   * Cria (uma única vez) o pedido de um pagamento aprovado, com o pedido e os preços guardados na
   * hora do pagamento — mesmo que a loja tenha fechado ou os preços tenham mudado depois.
   * Idempotente: orders.payment_id é único. Devolve o id do pedido ou null (não aprovado/falhou).
   */
  async finalize(record: Payment): Promise<number | null> {
    if (record.order_id !== null) return record.order_id;
    if (record.status !== 'approved') return null;

    const running = this.finalizing.get(record.id);
    if (running) {
      const orderId = await running;
      if (orderId !== null) record.order_id = orderId;
      return orderId;
    }
    const task = this.createOrderFor(record).finally(() =>
      this.finalizing.delete(record.id),
    );
    this.finalizing.set(record.id, task);
    return task;
  }

  /** finalize sem lançar erro: uma falha passageira é tentada de novo pela conciliação. */
  private async finalizeSafely(record: Payment): Promise<number | null> {
    try {
      return await this.finalize(record);
    } catch (error) {
      this.logger.error(
        `Não foi possível criar o pedido do pagamento #${record.id} agora: ${errorText(error)}`,
      );
      return null;
    }
  }

  private async createOrderFor(record: Payment): Promise<number | null> {
    // Outra instância (ou rota) já criou o pedido deste pagamento?
    const existing = await this.orderRepository.findOne({
      where: { payment_id: record.id },
      select: { id: true },
    });
    if (existing) return this.linkOrder(record, existing.id);

    const snapshot = record.price_snapshot;
    let problem: string | null = null;
    if (!isOrderSnapshot(snapshot)) problem = 'dados do pedido inválidos';
    else if (!amountMatches(record.amount, snapshot.total))
      problem = `valor pago (${formatBRL(record.amount)}) diferente do total do pedido (${formatBRL(snapshot.total)})`;
    else if (!(await this.userExists(record.user_id)))
      problem = 'a conta do cliente não existe mais';
    if (problem !== null) {
      await this.failPermanently(record, problem);
      return null;
    }

    const references = await this.pricing.existingReferences({
      productIds: snapshot.items.map((item) => item.productId),
      addonIds: snapshot.items.flatMap((item) =>
        item.addons.map((addon) => addon.id),
      ),
      addressId: snapshot.addressId,
    });
    const order = this.orderRepository.create(
      buildOrder(
        snapshot,
        {
          userId: record.user_id,
          paymentId: record.id,
          paymentMethod: record.order_payment_method,
          paymentStatus: PaymentStatus.PAID,
          changeFor: null,
        },
        references,
      ),
    );

    try {
      const saved = await this.orderRepository.save(order);
      this.logger.log(
        `Pedido #${saved.id} criado pelo pagamento #${record.id} (${formatBRL(record.amount)}).`,
      );
      return await this.linkOrder(record, saved.id);
    } catch (error) {
      // Índice único em orders.payment_id: outra chamada criou o pedido ao mesmo tempo
      if (isUniqueViolation(error)) {
        const winner = await this.orderRepository.findOne({
          where: { payment_id: record.id },
          select: { id: true },
        });
        if (winner) return this.linkOrder(record, winner.id);
      }
      throw error;
    }
  }

  private async linkOrder(record: Payment, orderId: number): Promise<number> {
    record.order_id = orderId;
    record.finalize_error = null;
    await this.paymentRepository.update(
      { id: record.id },
      { order_id: orderId, finalize_error: null },
    );
    return orderId;
  }

  /** Pagamento aprovado que não pode virar pedido: estorna e guarda o motivo (fica para a equipe). */
  private async failPermanently(
    record: Payment,
    reason: string,
  ): Promise<void> {
    this.logger.error(
      `Pagamento #${record.id} aprovado não pôde virar pedido: ${reason}. Estornando.`,
    );
    const refunded = await this.refund(record.id, record);
    record.finalize_error = `${reason} (${refunded ? 'valor estornado' : 'estorno pendente'})`;
    await this.paymentRepository.update(
      { id: record.id },
      { finalize_error: record.finalize_error },
    );
  }

  // ---------------------------------------------------------------------------
  // Estorno
  // ---------------------------------------------------------------------------

  /**
   * Estorna um pagamento online (pedido pago e cancelado). true = estornado (sandbox: simulado);
   * false = falhou e o estorno fica pendente para a equipe. Nunca lança erro.
   */
  async refund(paymentId: number, known?: Payment | null): Promise<boolean> {
    try {
      const record = known ?? (await this.findRecord(paymentId));
      const simulated = record
        ? record.simulated
        : isSimulatedPaymentId(paymentId);

      if (this.mode.sandbox || simulated) {
        this.logger.warn(
          `Estorno do pagamento #${paymentId} SIMULADO (sandbox): nenhum valor real foi movimentado.`,
        );
        await this.markRefunded(record);
        return true;
      }
      if (!this.gateway) {
        this.logger.error(
          `Estorno do pagamento #${paymentId} pendente: MP_ACCESS_TOKEN não configurado.`,
        );
        return false;
      }

      try {
        await this.gateway.refundPayment(paymentId, `refund-${paymentId}`);
      } catch (error) {
        // Já estornado (ex.: pelo painel do Mercado Pago)?
        const remote = await this.gateway
          .getPayment(paymentId)
          .catch(() => null);
        if (remote?.status !== 'refunded') {
          this.logger.error(
            `Estorno do pagamento #${paymentId} falhou: ${describeMercadoPagoError(error).message}`,
          );
          return false;
        }
      }
      await this.markRefunded(record);
      this.logger.log(`Pagamento #${paymentId} estornado no Mercado Pago.`);
      return true;
    } catch (error) {
      this.logger.error(
        `Estorno do pagamento #${paymentId} falhou: ${errorText(error)}`,
      );
      return false;
    }
  }

  private async markRefunded(record: Payment | null): Promise<void> {
    if (!record) return;
    record.status = 'refunded';
    record.status_detail = 'refunded';
    await this.paymentRepository.update(
      { id: record.id },
      { status: record.status, status_detail: record.status_detail },
    );
  }

  // ---------------------------------------------------------------------------
  // Conciliação (a cada 60 s, ver PaymentReconciler)
  // ---------------------------------------------------------------------------

  /**
   * Revê os pagamentos sem pedido dos últimos dias: pendentes são reconsultados (Mercado Pago real)
   * ou aprovados pelo prazo do sandbox; aprovados viram pedido. Cobre o cliente que fechou o app,
   * a notificação que não chegou e a falha passageira ao criar o pedido.
   */
  async reconcile(now: Date = new Date()): Promise<{ finalized: number }> {
    const since = new Date(now.getTime() - RECONCILE_WINDOW_MS);
    const candidates = await this.paymentRepository.find({
      where: [
        {
          order_id: IsNull(),
          status: In(PENDING_PAYMENT_STATUSES),
          created_at: MoreThan(since),
        },
        {
          order_id: IsNull(),
          status: 'approved',
          finalize_error: IsNull(),
          created_at: MoreThan(since),
        },
      ],
      order: { created_at: 'ASC' },
      take: RECONCILE_BATCH,
    });

    let finalized = 0;
    for (const record of candidates) {
      try {
        await this.refresh(record, false);
        if (
          record.status === 'approved' &&
          (await this.finalize(record)) !== null
        )
          finalized++;
      } catch (error) {
        this.logger.warn(
          `Conciliação do pagamento #${record.id} falhou: ${errorText(error)}`,
        );
      }
    }
    if (finalized > 0)
      this.logger.log(
        `Conciliação: ${finalized} pedido(s) criado(s) a partir de pagamentos aprovados.`,
      );
    return { finalized };
  }

  // ---------------------------------------------------------------------------
  // Internos
  // ---------------------------------------------------------------------------

  /** Valor cobrado = total calculado pelo servidor; valida o pedido ANTES de cobrar. */
  private async priceForCharge(
    order: QuoteOrderDto,
    userId: number,
  ): Promise<PricedOrder> {
    const priced = await this.pricing.price(order, userId);
    if (!priced.store_open) throw new BadRequestException(STORE_CLOSED_MESSAGE);
    if (priced.totalCents <= 0)
      throw new BadRequestException(
        'Este pedido não tem valor a pagar online.',
      );
    return priced;
  }

  /**
   * A mesma chave de idempotência do mesmo cliente devolve o pagamento já criado (nunca cobra duas
   * vezes); pedidos simultâneos com a mesma chave esperam o primeiro.
   */
  private async once(
    userId: number,
    key: string | undefined,
    kind: PaymentKind,
    create: () => Promise<Payment>,
  ): Promise<Payment> {
    if (!key) return create();

    const existing = await this.paymentRepository.findOne({
      where: { user_id: userId, idempotency_key: key },
    });
    if (existing) return sameKind(existing, kind);

    const flight = `${userId}:${key}`;
    const running = this.creating.get(flight);
    if (running) return sameKind(await running, kind);

    const task = create().finally(() => this.creating.delete(flight));
    this.creating.set(flight, task);
    return task;
  }

  private newRecord(
    userId: number,
    method: PaymentKind,
    dto: CreatePixPaymentDto,
    priced: PricedOrder,
    extra: { orderPaymentMethod: string; paymentMethodId: string },
  ): NewPayment {
    return {
      id: 0,
      user_id: userId,
      method,
      order_payment_method: extra.orderPaymentMethod,
      payment_method_id: extra.paymentMethodId,
      amount: priced.total,
      status: 'pending',
      status_detail: null,
      simulated: false,
      order_payload: requestPayload(dto.order),
      price_snapshot: toOrderSnapshot(priced),
      pix_data: null,
      expires_at: null,
      auto_approve_at: null,
      order_id: null,
      idempotency_key: dto.idempotencyKey ?? null,
      external_reference: this.externalReference(userId),
      finalize_error: null,
    };
  }

  /**
   * Grava o pagamento (INSERT: nunca sobrescreve outro). Chave de idempotência repetida por outra
   * requisição → devolve o pagamento dela; id simulado repetido → gera outro.
   */
  private async saveRecord(data: NewPayment): Promise<Payment> {
    let current = data;
    for (let attempt = 0; ; attempt++) {
      try {
        const entity = this.paymentRepository.create(current);
        await this.paymentRepository.insert(entity);
        return entity;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        if (current.idempotency_key) {
          const existing = await this.paymentRepository.findOne({
            where: {
              user_id: current.user_id,
              idempotency_key: current.idempotency_key,
            },
          });
          if (existing) return existing;
        }
        if (
          current.simulated &&
          current.id >= SIMULATED_ID_BASE &&
          attempt < 3
        ) {
          current = { ...current, id: this.nextSimulatedId() };
          continue;
        }
        // O mesmo pagamento do Mercado Pago já gravado (mesma tentativa repetida)
        const same = await this.findRecord(current.id);
        if (same && same.user_id === current.user_id) return same;
        throw error;
      }
    }
  }

  private async saveSimulatedCard(
    base: NewPayment,
    reason: string,
  ): Promise<Payment> {
    const record = await this.saveRecord({
      ...base,
      id: this.nextSimulatedId(),
      status: 'approved',
      status_detail: 'accredited',
      simulated: true,
    });
    this.logger.warn(
      `Pagamento com cartão #${record.id} APROVADO POR SIMULAÇÃO (${formatBRL(record.amount)}): ${reason}. Apenas sandbox.`,
    );
    return record;
  }

  /** QR de teste (não é um código PIX válido, nenhum banco consegue pagá-lo). */
  private async saveMockPix(
    base: NewPayment,
    expiresAt: Date,
    reason: string,
  ): Promise<Payment> {
    const id = this.nextSimulatedId();
    const record = await this.saveRecord({
      ...base,
      id,
      status: 'pending',
      status_detail: 'pending_waiting_transfer',
      simulated: true,
      auto_approve_at: this.autoApproveAt(),
      expires_at: expiresAt,
      pix_data: {
        qr_code: `${BRAND.slug.toUpperCase()}-SANDBOX-PIX-${id}`,
        qr_code_base64: null,
        ticket_url: null,
      },
    });
    this.logger.warn(
      `PIX #${record.id} SIMULADO (${formatBRL(record.amount)}): ${reason}. Aprovação automática em ${this.mode.pixApprovalSeconds}s (sandbox).`,
    );
    return record;
  }

  /**
   * Pagamento que não está na tabela, mas é real: confere no Mercado Pago se é deste cliente
   * (external_reference), se está aprovado, se a forma bate e se o valor é o total do pedido enviado.
   */
  private async recoverFromMercadoPago(
    dto: CreateOrderDto,
    actor: OrderActor,
  ): Promise<Payment | null> {
    const paymentId = Number(dto.paymentId);
    const kind = paymentKindFor(dto.paymentMethod);
    if (!this.gateway || !kind || isSimulatedPaymentId(paymentId)) return null;

    let remote: Awaited<ReturnType<PaymentGateway['getPayment']>>;
    try {
      remote = await this.gateway.getPayment(paymentId);
    } catch {
      return null;
    }
    if (externalReferenceUserId(remote.external_reference) !== actor.id)
      return null;

    const remoteKind: PaymentKind =
      remote.payment_method_id === 'pix' ? 'PIX' : 'CARD';
    if (remoteKind !== kind) {
      throw new BadRequestException(
        'A forma de pagamento do pedido não corresponde ao pagamento informado.',
      );
    }
    if (remote.status !== 'approved') {
      throw new BadRequestException(
        `O pagamento ainda não foi aprovado (status: ${remote.status ?? 'desconhecido'}).`,
      );
    }

    // Já foi pago: a loja fechada não impede; o resto do pedido é validado normalmente
    const priced = await this.pricing.price(dto, actor.id);
    const paid = Number(remote.transaction_amount ?? 0);
    if (!amountMatches(paid, priced.total)) {
      throw new BadRequestException(
        `O valor pago (${formatBRL(paid)}) não confere com o total do pedido (${formatBRL(priced.total)}).`,
      );
    }

    this.logger.warn(
      `Pagamento #${paymentId} recuperado do Mercado Pago (não estava registrado neste servidor).`,
    );
    return this.saveRecord({
      id: paymentId,
      user_id: actor.id,
      method: kind,
      order_payment_method:
        kind === 'PIX'
          ? 'PIX'
          : cardOrderMethod(remote.payment_method_id, remote.payment_type_id),
      payment_method_id: remote.payment_method_id ?? null,
      amount: paid,
      status: 'approved',
      status_detail: remote.status_detail ?? null,
      simulated: false,
      order_payload: requestPayload(dto),
      price_snapshot: toOrderSnapshot(priced),
      pix_data: null,
      expires_at: null,
      auto_approve_at: null,
      order_id: null,
      idempotency_key: null,
      external_reference: remote.external_reference ?? null,
      finalize_error: null,
    });
  }

  /**
   * Atualiza o status: PIX de sandbox é aprovado depois do prazo (ou vence); pagamentos reais são
   * reconsultados no Mercado Pago (strict = sempre reconsulta e, em produção, falha se não conseguir).
   */
  private async refresh(record: Payment, strict: boolean): Promise<void> {
    const before = `${record.status}|${record.status_detail}|${record.amount}`;

    if (record.simulated || !this.gateway) {
      const next = simulatedPixProgress(record);
      if (next) {
        record.status = next.status;
        record.status_detail = next.status_detail;
        if (next.status === 'approved')
          this.logger.warn(
            `PIX #${record.id} aprovado automaticamente (SIMULAÇÃO de sandbox).`,
          );
      }
    } else if (strict || !isFinalPaymentStatus(record.status)) {
      try {
        const remote = await this.gateway.getPayment(record.id);
        record.status = remote.status ?? record.status;
        record.status_detail = remote.status_detail ?? record.status_detail;
        if (
          remote.transaction_amount !== undefined &&
          remote.transaction_amount !== null
        ) {
          record.amount = Number(remote.transaction_amount);
        }
      } catch (error) {
        const reason = describeMercadoPagoError(error);
        if (strict && !this.mode.sandbox) {
          throw new BadGatewayException(
            'Não foi possível confirmar o pagamento com o Mercado Pago. Tente novamente.',
          );
        }
        this.logger.warn(
          `Não foi possível consultar o pagamento #${record.id} no Mercado Pago: ${reason.message}`,
        );
      }
    }

    if (
      `${record.status}|${record.status_detail}|${record.amount}` !== before
    ) {
      await this.paymentRepository.update(
        { id: record.id },
        {
          status: record.status,
          status_detail: record.status_detail,
          amount: record.amount,
        },
      );
    }
  }

  private findRecord(paymentId: number): Promise<Payment | null> {
    return this.paymentRepository.findOne({ where: { id: paymentId } });
  }

  private nextSimulatedId(): number {
    this.lastSimulatedId = Math.max(
      SIMULATED_ID_BASE + Date.now(),
      this.lastSimulatedId + 1,
    );
    return this.lastSimulatedId;
  }

  private autoApproveAt(): Date {
    return new Date(Date.now() + this.mode.pixApprovalSeconds * 1000);
  }

  private description(): string {
    return `Pedido ${BRAND.name}`;
  }

  private externalReference(userId: number): string {
    return `${BRAND.slug}-cliente-${userId}-${Date.now()}`;
  }

  private notification(): Pick<MercadoPagoCreateBody, 'notification_url'> {
    return this.mode.notificationUrl
      ? { notification_url: this.mode.notificationUrl }
      : {};
  }

  private async lookupUserName(userId: number): Promise<string | null> {
    const user = await this.orderRepository.manager.findOne(User, {
      where: { id: userId },
      select: { id: true, name: true },
    });
    return user?.name ?? null;
  }

  private userExists(userId: number): Promise<boolean> {
    return this.orderRepository.manager.exists(User, {
      where: { id: userId },
      withDeleted: true,
    });
  }

  private toHttpError(
    reason: { message: string; httpStatus: number | null },
    prefix: string,
  ) {
    if (reason.httpStatus !== null && reason.httpStatus < 500) {
      return new BadRequestException(`${prefix}: ${reason.message}`);
    }
    return new BadGatewayException(
      'Não foi possível contatar o Mercado Pago. Tente novamente em instantes.',
    );
  }
}

// ---------------------------------------------------------------------------
// Respostas e auxiliares
// ---------------------------------------------------------------------------

function sameKind(record: Payment, kind: PaymentKind): Payment {
  if (record.method !== kind) {
    throw new BadRequestException(
      'Esta idempotencyKey já foi usada em outro tipo de pagamento. Gere uma nova chave.',
    );
  }
  return record;
}

/** Pedido devolvido para um paymentId: um pedido cancelado não pode ser "reaproveitado". */
function usableOrderId(order: { id: number; status: OrderStatus }): number {
  if (order.status === OrderStatus.CANCELED)
    throw new BadRequestException(PAYMENT_ORDER_CANCELED_MESSAGE);
  return order.id;
}

/** Corpo do pedido guardado no pagamento (só os campos do orçamento). */
function requestPayload(order: QuoteOrderDto): OrderRequestPayload {
  return {
    items: (order.items ?? []).map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      ...(item.addonIds?.length ? { addonIds: [...item.addonIds] } : {}),
      ...(item.observation ? { observation: item.observation } : {}),
      ...(item.meatPoint ? { meatPoint: item.meatPoint } : {}),
      ...(item.removedIngredients?.length
        ? { removedIngredients: [...item.removedIngredients] }
        : {}),
    })),
    type: order.type,
    ...(order.addressId ? { addressId: order.addressId } : {}),
  };
}

function cardResult(record: Payment): CardPaymentResult {
  return {
    id: record.id,
    status: record.status,
    status_detail: record.status_detail,
    amount: record.amount,
    ...(record.simulated ? { simulation: true as const } : {}),
    ...(record.order_id !== null ? { orderId: record.order_id } : {}),
  };
}

function pixResult(record: Payment): PixPaymentResult {
  return {
    id: record.id,
    status: record.status,
    qr_code: record.pix_data?.qr_code ?? '',
    qr_code_base64: record.pix_data?.qr_code_base64 ?? null,
    ticket_url: record.pix_data?.ticket_url ?? null,
    amount: record.amount,
    expires_at: record.expires_at
      ? new Date(record.expires_at).toISOString()
      : null,
    ...(record.simulated ? { simulation: true as const } : {}),
  };
}

function statusResult(record: Payment): PaymentStatusResult {
  return {
    id: record.id,
    status: record.status,
    status_detail: record.status_detail,
    ...(record.order_id !== null ? { orderId: record.order_id } : {}),
  };
}
