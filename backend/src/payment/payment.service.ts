import { randomUUID } from 'crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  type FindOptionsWhere,
  In,
  IsNull,
  MoreThan,
  Repository,
} from 'typeorm';
import type { AuthUser } from '../auth/auth-user';
import { AuditService } from '../audit/audit.service';
import { PlanLimitsService } from '../billing/plan-limits.service';
import { BRAND } from '../config/brand';
import { isDevOrTest } from '../config/env';
// isCheckViolation: gatilho do banco que recusa misturar dados de lojas diferentes
import { isCheckViolation, isUniqueViolation } from '../common/database-errors';
import { decryptStoreSecret, sha256Hex } from '../common/crypto/secret-box';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { Order } from '../orders/entities/order.entity';
import { Store } from '../store/entities/store.entity';
import { User } from '../users/entities/user.entity';
import { TenantService } from '../tenancy/tenant.service';
import type { TenantContext } from '../tenancy/tenant-context';
import type { StoreAccessState } from '../tenancy/store-access';
import { OrderStatus, PaymentStatus } from '../orders/order.enums';
import {
  OrderPricingService,
  STORE_CLOSED_MESSAGE,
  type PricedOrder,
} from '../orders/order-pricing.service';
import { CreateOrderDto, QuoteOrderDto } from '../orders/dto/create-order.dto';
import {
  MONTHLY_ORDERS_LIMIT_MESSAGE,
  formatBRL,
  isOrderManager,
  isStaffRole,
  toCents,
} from '../orders/order-rules';
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
  MAX_PENDING_CHARGES_PER_CUSTOMER,
  ONLINE_PAYMENT_NOT_IN_PLAN_MESSAGE,
  ONLINE_PAYMENT_UNAVAILABLE_MESSAGE,
  PAYMENT_ALREADY_USED_MESSAGE,
  PAYMENT_NOT_FOUND_MESSAGE,
  PAYMENT_NOT_FOUND_OR_EXPIRED_MESSAGE,
  PAYMENT_ORDER_CANCELED_MESSAGE,
  PENDING_PAYMENT_STATUSES,
  SIMULATED_ID_BASE,
  STORE_CANNOT_SELL_REASON,
  TOO_MANY_PENDING_CHARGES_MESSAGE,
  amountMatches,
  canonicalJson,
  cardOrderMethod,
  describeMercadoPagoError,
  externalReferenceFor,
  isFinalPaymentStatus,
  isSimulatedPaymentId,
  isTestAccessToken,
  mercadoPagoDate,
  mercadoPagoIdempotencyKey,
  parseExternalReference,
  parseWebhookPaymentId,
  paymentKindFor,
  pixMinutesFor,
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

/** Quem pediu o estorno e por quê (auditoria). */
export interface RefundOptions {
  /** Registro já carregado (evita reler o banco). */
  known?: Payment | null;
  actor?: AuthUser | null;
  reason?: 'order_canceled' | 'order_not_created';
  orderId?: number | null;
}

type NewPayment = Omit<Payment, 'created_at' | 'updated_at' | 'store'>;

interface RefreshOptions {
  /** Polling do cliente: respeita STATUS_POLL_RECHECK_MS (dentro dele, vale o status gravado). */
  poll?: boolean;
  /** Webhook: reconsulta também o 'approved' (estorno, contestação ou cancelamento feitos no MP). */
  followApproved?: boolean;
}

/** Status do Mercado Pago que desfazem um pagamento aprovado (o dinheiro voltou ao cliente). */
const REVERSED_PAYMENT_STATUSES = ['refunded', 'charged_back', 'cancelled'];
type PaymentChanges = Partial<
  Pick<
    Payment,
    'status' | 'status_detail' | 'amount' | 'order_id' | 'finalize_error'
  >
>;

const APPROVED_CANNOT_CANCEL_MESSAGE =
  'Este pagamento já foi aprovado e não pode mais ser cancelado. O pedido aparece em Meus Pedidos.';
const ORDER_PENDING_MESSAGE =
  'Pagamento aprovado, mas o pedido ainda não foi registrado. Ele aparece em Meus Pedidos em instantes; não pague de novo.';
const CONFIRM_FAILED_MESSAGE =
  'Não foi possível confirmar o pagamento com o Mercado Pago. Tente novamente.';
/** Pagamentos sem pedido revistos pela conciliação (PIX vence em minutos; cartão em análise pode levar dias). */
const RECONCILE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/**
 * PIX com prazo longo (PIX_EXPIRATION_MINUTES acima de 2 dias): a janela vai até o fim do prazo mais
 * esta margem, para o PIX pago no último dia ainda virar pedido sem depender do webhook.
 */
const PIX_DEADLINE_MARGIN_MS = 24 * 60 * 60 * 1000;
/** Pagamentos por rodada da conciliação e o máximo de uma mesma loja na rodada (rodízio entre as lojas). */
export const RECONCILE_BATCH = 50;
export const RECONCILE_PER_STORE = 10;
/** Problema de credencial de uma loja: um aviso por hora (a conciliação roda a cada minuto). */
const CREDENTIAL_WARNING_INTERVAL_MS = 60 * 60 * 1000;
/** Notificações (webhook) do mesmo pagamento: no máximo uma reconsulta no Mercado Pago por intervalo. */
export const NOTIFICATION_RECHECK_MS = 15_000;
/**
 * Polling do cliente (GET /payment/status/:id): no máximo uma consulta ao Mercado Pago por pagamento
 * neste intervalo (as consultas dentro dele respondem com o status gravado, que o webhook e a
 * conciliação continuam atualizando). Sem isso, um cliente repetindo a consulta em paralelo dispara
 * centenas de chamadas por segundo com a credencial da loja.
 */
export const STATUS_POLL_RECHECK_MS = 5_000;
/** Acima disto, as marcas de notificações antigas são descartadas (memória limitada). */
const NOTIFICATION_TRACK_LIMIT = 1000;
/**
 * Notificações processadas ao mesmo tempo e as que esperam a vez: com a fila cheia a notificação é
 * descartada (a conciliação confere o pagamento do mesmo jeito).
 */
export const NOTIFICATION_CONCURRENCY = 8;
export const NOTIFICATION_QUEUE_LIMIT = 500;
/**
 * Trava da finalização de um pagamento entre instâncias (transação; o id vira uma chave bigint própria
 * deste uso, para não colidir com outras travas consultivas).
 */
const FINALIZE_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('payment-finalize:' || $1::text, 0))`;
/**
 * Finalizações com a trava ao mesmo tempo, por instância. A transação da trava ocupa uma conexão do
 * pool enquanto o trabalho usa outra: sem teto, 10 finalizações simultâneas (pool padrão do pg = 10,
 * sem prazo para obter conexão) ocupariam todas as conexões esperando uma segunda — a API travaria.
 */
export const FINALIZE_CONCURRENCY = 4;
/** PIX pendente do mesmo carrinho só é reaproveitado com pelo menos este prazo para pagar. */
const PIX_REUSE_MIN_REMAINING_MS = 5 * 60 * 1000;

/**
 * Seleção da conciliação, feita no banco (a coluna updated_at marca a última conferência):
 * - aprovados sem pedido primeiro (só falta criar o pedido), depois os pendentes;
 * - no máximo $3 por loja na rodada (ROW_NUMBER por loja), intercalando as lojas (posição 1 de
 *   cada loja, depois a 2...);
 * - dentro de cada grupo, os nunca conferidos (updated_at = created_at) e depois os conferidos há
 *   mais tempo: um pagamento que não pode ser reconsultado vai para o fim da fila e não trava os outros.
 */
const RECONCILE_CANDIDATES_SQL = `
  SELECT "id" FROM (
    SELECT "id", "approved", "checked", "updated_at",
           ROW_NUMBER() OVER (
             PARTITION BY "store_id"
             ORDER BY "approved" DESC, "checked" ASC, "updated_at" ASC, "id" ASC
           ) AS "position"
      FROM (
        SELECT "id", "store_id", "updated_at",
               ("status" = 'approved') AS "approved",
               ("updated_at" > "created_at") AS "checked"
          FROM "payments"
         WHERE "order_id" IS NULL
           AND "created_at" > $1
           AND (("status" = 'approved' AND "finalize_error" IS NULL)
                OR "status" = ANY($2::varchar[]))
      ) AS "open_payments"
  ) AS "ranked"
  WHERE "position" <= $3
  ORDER BY "approved" DESC, "position" ASC, "checked" ASC, "updated_at" ASC, "id" ASC
  LIMIT $4`;

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : describeMercadoPagoError(error).message;
}

/**
 * Pagamentos online do DELIVERY (consumidor → loja), sempre na conta Mercado Pago da loja do pedido.
 * A cobrança da assinatura SaaS (loja → plataforma) é outro fluxo (módulo billing).
 */
@Injectable()
export class PaymentService implements OnModuleDestroy {
  private readonly logger = new Logger(PaymentService.name);
  /** Sandbox, prazos do PIX e URL de notificação: globais, por ambiente. */
  private readonly mode: PaymentMode;
  /** Produção (inclusive NODE_ENV vazio/desconhecido): credenciais de teste são recusadas. */
  private readonly production: boolean;
  /** Gateways por loja, chave "<storeId>:<hash do token>": credencial trocada → gateway novo. */
  private readonly gateways = new Map<string, PaymentGateway>();
  /** Cria o gateway de um Access Token (os testes trocam por um dublê). */
  gatewayFactory: (accessToken: string) => PaymentGateway = (accessToken) =>
    new MercadoPagoGateway(accessToken);
  private readonly credentialWarnings = new Map<string, number>();
  private lastSimulatedId = 0;
  /** Tentativas com a mesma chave de idempotência (loja + cliente + chave) em andamento neste processo. */
  private readonly creating = new Map<string, Promise<Payment>>();
  /** Pedidos sendo criados por pagamento (status, webhook e conciliação podem chegar juntos). */
  private readonly finalizing = new Map<number, Promise<number | null>>();
  /** Vagas livres e a fila das finalizações com a trava do banco (FINALIZE_CONCURRENCY). */
  private finalizeSlots = FINALIZE_CONCURRENCY;
  private readonly finalizeWaiters: Array<() => void> = [];
  /** Consultas ao Mercado Pago em andamento por pagamento: chamadas simultâneas usam a mesma. */
  private readonly lookups = new Map<
    number,
    Promise<Awaited<ReturnType<PaymentGateway['getPayment']>>>
  >();
  /** Última consulta ao Mercado Pago de cada pagamento (intervalo mínimo do polling do cliente). */
  private readonly remoteChecks = new Map<number, number>();
  /** Última notificação processada de cada pagamento e a reconsulta adiada (uma por pagamento). */
  private readonly notified = new Map<number, number>();
  private readonly deferredNotifications = new Map<number, NodeJS.Timeout>();
  /** Fila das notificações (concorrência limitada em vez de uma promessa solta por requisição). */
  private readonly notificationQueue: number[] = [];
  private notificationsRunning = 0;

  constructor(
    private readonly pricing: OrderPricingService,
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(Store)
    private readonly storeRepository: Repository<Store>,
    private readonly tenants: TenantService,
    private readonly planLimits: PlanLimitsService,
    private readonly audit: AuditService,
    config: ConfigService,
    private readonly rateLimit: RateLimitService,
  ) {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: config.get<string>('NODE_ENV'),
      MP_ACCESS_TOKEN: config.get<string>('MP_ACCESS_TOKEN'),
      PAYMENT_SANDBOX: config.get<string>('PAYMENT_SANDBOX'),
      PIX_SANDBOX_APPROVAL_SECONDS: config.get<string>(
        'PIX_SANDBOX_APPROVAL_SECONDS',
      ),
      PIX_EXPIRATION_MINUTES: config.get<string>('PIX_EXPIRATION_MINUTES'),
      MP_NOTIFICATION_URL: config.get<string>('MP_NOTIFICATION_URL'),
    };
    this.mode = resolvePaymentMode(env);
    this.production = !isDevOrTest(env);

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
    if (
      this.production &&
      this.mode.accessToken &&
      isTestAccessToken(this.mode.accessToken)
    ) {
      this.logger.error(
        'MP_ACCESS_TOKEN é uma credencial de TESTE: em produção ela é recusada (a loja padrão fica sem pagamento online).',
      );
    }
    if (this.mode.sandbox) {
      this.logger.warn(
        `Pagamentos em modo SANDBOX: recusas/falhas do Mercado Pago viram aprovações simuladas e PIX é aprovado após ${this.mode.pixApprovalSeconds}s. ` +
          'Lojas sem credencial do Mercado Pago têm os pagamentos simulados.',
      );
    } else {
      this.logger.log(
        'Pagamentos em modo PRODUÇÃO: cada loja recebe na própria conta do Mercado Pago' +
          (this.mode.accessToken
            ? ' (MP_ACCESS_TOKEN vale só para a loja padrão sem credencial própria).'
            : '; lojas sem credencial não aceitam pagamento online.'),
      );
    }
  }

  /** Desligamento (app.close, testes): descarta as reconsultas de notificações adiadas. */
  onModuleDestroy(): void {
    for (const timer of this.deferredNotifications.values())
      clearTimeout(timer);
    this.deferredNotifications.clear();
  }

  // ---------------------------------------------------------------------------
  // Cartão
  // ---------------------------------------------------------------------------

  /**
   * Cobra o cartão na conta da loja; aprovado na hora → o pedido já é criado e volta em orderId.
   * clientIp: limite de cobranças por IP (PAYMENT_CREATE_IP).
   */
  async createCardPayment(
    dto: CreateCardPaymentDto,
    actor: AuthUser,
    tenant: TenantContext,
    clientIp?: string | null,
  ): Promise<CardPaymentResult> {
    const record = await this.once(
      tenant.storeId,
      actor.id,
      dto.idempotencyKey,
      'CARD',
      () => this.chargeCard(dto, actor, tenant, clientIp),
    );
    if (record.status === 'approved') await this.finalizeSafely(record);
    return cardResult(record);
  }

  private async chargeCard(
    dto: CreateCardPaymentDto,
    actor: AuthUser,
    tenant: TenantContext,
    clientIp?: string | null,
  ): Promise<Payment> {
    const gateway = await this.prepareCharge(tenant);
    const priced = await this.priceForCharge(dto.order, actor.id, tenant);
    await this.assertCanCharge(tenant.storeId, actor.id, clientIp);
    const base = this.newRecord(tenant, actor.id, 'CARD', dto, priced, {
      orderPaymentMethod: cardOrderMethod(dto.paymentMethodId),
      paymentMethodId: dto.paymentMethodId,
    });

    // Sem gateway só chega aqui no sandbox (prepareCharge recusa em produção)
    if (!gateway)
      return this.saveSimulatedCard(
        base,
        'loja sem credencial do Mercado Pago',
      );

    let result: Awaited<ReturnType<PaymentGateway['createPayment']>>;
    try {
      result = await gateway.createPayment(
        {
          transaction_amount: base.amount,
          token: dto.token,
          description: this.description(tenant),
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
        this.idempotencyKeyFor(tenant.storeId, actor.id, dto.idempotencyKey),
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

  /**
   * Gera o PIX na conta da loja (vence em PIX_EXPIRATION_MINUTES). O pedido é criado quando for pago.
   * O mesmo carrinho com um PIX ainda pendente devolve esse mesmo PIX (nenhuma cobrança nova).
   */
  async createPixPayment(
    dto: CreatePixPaymentDto,
    actor: AuthUser,
    tenant: TenantContext,
    clientIp?: string | null,
  ): Promise<PixPaymentResult> {
    const record = await this.once(
      tenant.storeId,
      actor.id,
      dto.idempotencyKey,
      'PIX',
      () => this.chargePix(dto, actor, tenant, clientIp),
    );
    return pixResult(record);
  }

  private async chargePix(
    dto: CreatePixPaymentDto,
    actor: AuthUser,
    tenant: TenantContext,
    clientIp?: string | null,
  ): Promise<Payment> {
    const gateway = await this.prepareCharge(tenant);
    const priced = await this.priceForCharge(dto.order, actor.id, tenant);
    const pending = await this.reusablePix(tenant, actor.id, dto, priced);
    if (pending) return pending;
    await this.assertCanCharge(tenant.storeId, actor.id, clientIp);
    const base = this.newRecord(tenant, actor.id, 'PIX', dto, priced, {
      orderPaymentMethod: 'PIX',
      paymentMethodId: 'pix',
    });
    const expiresAt = new Date(
      Date.now() + pixMinutesFor(this.mode, !!gateway) * 60_000,
    );

    // Sem gateway só chega aqui no sandbox (prepareCharge recusa em produção)
    if (!gateway)
      return this.saveMockPix(
        base,
        expiresAt,
        'loja sem credencial do Mercado Pago',
      );

    let result: Awaited<ReturnType<PaymentGateway['createPayment']>>;
    try {
      const payerName = splitPayerName(
        actor.name || (await this.lookupUserName(actor.id)),
      );
      result = await gateway.createPayment(
        {
          transaction_amount: base.amount,
          description: this.description(tenant),
          payment_method_id: 'pix',
          external_reference: base.external_reference ?? undefined,
          date_of_expiration: mercadoPagoDate(expiresAt),
          ...this.notification(),
          payer: { email: actor.email, ...payerName },
        },
        this.idempotencyKeyFor(tenant.storeId, actor.id, dto.idempotencyKey),
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

  /**
   * GET /payment/status/:id — o pagador ou ADMIN/EMPLOYEE DA LOJA do pagamento; qualquer outro caso → 404.
   * Aprovado → o pedido é criado aqui.
   */
  async getStatusFor(
    paymentId: number,
    actor: AuthUser,
    storeSlug?: string,
  ): Promise<PaymentStatusResult> {
    const record = await this.findRecord(paymentId);
    if (
      !record ||
      !(await this.canView(record, actor)) ||
      !(await this.isRouteStore(record, storeSlug))
    )
      throw new NotFoundException(PAYMENT_NOT_FOUND_MESSAGE);

    await this.refresh(record, false, undefined, { poll: true });
    if (record.status === 'approved') await this.finalizeSafely(record);
    return statusResult(record);
  }

  /** POST /payment/:id/cancel — só o pagador desiste de um pagamento pendente (o PIX deixa de valer). */
  async cancelFor(
    paymentId: number,
    actor: AuthUser,
    storeSlug?: string,
  ): Promise<{ id: number; status: string }> {
    const record = await this.findRecord(paymentId);
    if (
      !record ||
      record.user_id !== actor.id ||
      !(await this.isRouteStore(record, storeSlug))
    )
      throw new NotFoundException(PAYMENT_NOT_FOUND_MESSAGE);

    const gateway = record.simulated
      ? null
      : await this.gatewayFor(record.store_id);
    await this.refresh(record, false, gateway);
    if (record.status === 'approved' || record.order_id !== null) {
      await this.finalizeSafely(record);
      throw new ConflictException(APPROVED_CANNOT_CANCEL_MESSAGE);
    }
    // Já cancelado, recusado ou vencido: nada a fazer
    if (!PENDING_PAYMENT_STATUSES.includes(record.status)) {
      return { id: record.id, status: record.status };
    }

    if (!record.simulated && gateway) {
      try {
        const remote = await gateway.cancelPayment(
          record.id,
          `cancel-${record.id}`,
        );
        record.status = remote.status ?? 'cancelled';
        record.status_detail = remote.status_detail ?? 'by_payer';
      } catch (error) {
        // Pode ter sido pago no mesmo instante: confere antes de responder
        await this.refresh(record, true, gateway).catch(() => undefined);
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
    } else if (!record.simulated && !this.mode.sandbox) {
      // Pagamento real e a loja está sem credencial agora: não dá para cancelar no Mercado Pago
      // (marcar só aqui deixaria um PIX pagável que nunca viraria pedido)
      throw new BadGatewayException(
        'Não foi possível cancelar o pagamento no Mercado Pago agora. Tente novamente em instantes.',
      );
    } else {
      record.status = 'cancelled';
      record.status_detail = 'by_payer';
    }

    await this.updateRecord(record, {
      status: record.status,
      status_detail: record.status_detail,
    });
    if (record.status === 'approved') {
      await this.finalizeSafely(record);
      throw new ConflictException(APPROVED_CANNOT_CANCEL_MESSAGE);
    }
    this.logger.log(`Pagamento #${record.id} cancelado pelo cliente.`);
    return { id: record.id, status: record.status };
  }

  /**
   * POST /payment/webhook: o corpo NÃO é confiável — serve só para saber qual pagamento reconsultar
   * no Mercado Pago, com a credencial da loja do pagamento (pagamentos que não são deste servidor são
   * ignorados). Responde na hora. Rota pública:
   * - limite por IP (PAYMENT_WEBHOOK → 429) antes de qualquer acesso ao banco;
   * - cada pagamento é reconsultado no máximo uma vez a cada NOTIFICATION_RECHECK_MS: as notificações
   *   repetidas dentro do intervalo viram UMA reconsulta no fim dele (nenhuma atualização se perde);
   * - processamento numa fila com concorrência limitada (NOTIFICATION_CONCURRENCY/QUEUE_LIMIT).
   */
  handleNotification(
    body: unknown,
    query: Record<string, unknown>,
    clientIp?: string | null,
  ): void {
    if (clientIp !== undefined)
      this.rateLimit.consume('PAYMENT_WEBHOOK', clientIp ?? 'desconhecido');
    const paymentId = parseWebhookPaymentId(body, query);
    if (!paymentId) return;
    this.scheduleNotification(paymentId);
  }

  private scheduleNotification(paymentId: number): void {
    if (this.deferredNotifications.has(paymentId)) return; // já marcada
    const now = Date.now();
    const last = this.notified.get(paymentId);
    if (last !== undefined && now - last < NOTIFICATION_RECHECK_MS) {
      const timer = setTimeout(
        () => {
          this.deferredNotifications.delete(paymentId);
          this.scheduleNotification(paymentId);
        },
        last + NOTIFICATION_RECHECK_MS - now,
      );
      timer.unref?.();
      this.deferredNotifications.set(paymentId, timer);
      return;
    }
    // Reinsere para o Map ficar em ordem de horário: a limpeza para no primeiro recente
    this.notified.delete(paymentId);
    this.notified.set(paymentId, now);
    if (this.notified.size > NOTIFICATION_TRACK_LIMIT) {
      for (const [id, at] of this.notified) {
        if (now - at < NOTIFICATION_RECHECK_MS) break;
        this.notified.delete(id);
      }
    }
    if (this.notificationQueue.length >= NOTIFICATION_QUEUE_LIMIT) {
      this.warnCredential(
        'webhook:fila',
        `Fila de notificações do Mercado Pago cheia (${NOTIFICATION_QUEUE_LIMIT}): notificações descartadas; a conciliação confere esses pagamentos.`,
      );
      return;
    }
    this.notificationQueue.push(paymentId);
    this.drainNotifications();
  }

  private drainNotifications(): void {
    while (
      this.notificationsRunning < NOTIFICATION_CONCURRENCY &&
      this.notificationQueue.length > 0
    ) {
      const paymentId = this.notificationQueue.shift() as number;
      this.notificationsRunning++;
      void this.processNotification(paymentId)
        .catch((error: unknown) =>
          this.logger.warn(
            `Notificação do pagamento #${paymentId} não processada: ${errorText(error)}`,
          ),
        )
        .finally(() => {
          this.notificationsRunning--;
          this.drainNotifications();
        });
    }
  }

  private async processNotification(paymentId: number): Promise<void> {
    const record = await this.findRecord(paymentId);
    if (!record) return;
    const previous = record.status;
    // O aprovado também é reconsultado: estorno pelo painel do MP, contestação (chargeback) ou
    // cancelamento chegam por aqui (no máximo uma vez a cada NOTIFICATION_RECHECK_MS por pagamento)
    await this.refresh(record, false, undefined, { followApproved: true });
    if (record.status === 'approved') await this.finalizeSafely(record);
    else if (
      previous === 'approved' &&
      REVERSED_PAYMENT_STATUSES.includes(record.status)
    )
      await this.onReversed(record);
  }

  /**
   * Pagamento aprovado desfeito no Mercado Pago (estornado fora do sistema, contestado ou cancelado):
   * o pedido dele (se existir e ainda constar como pago ou com estorno pendente) passa a REFUNDED, para
   * a equipe ver no quadro que não vai receber e para o cancelamento não tentar estornar de novo.
   * Sem pedido, o pagamento deixa de ser "aprovado" e nunca vira pedido. Sempre auditado.
   */
  private async onReversed(record: Payment): Promise<void> {
    let orderUpdated = false;
    if (record.order_id !== null) {
      const result = await this.orderRepository.update(
        {
          id: record.order_id,
          store_id: record.store_id,
          payment_status: In([
            PaymentStatus.PAID,
            PaymentStatus.REFUND_PENDING,
          ]),
        },
        { payment_status: PaymentStatus.REFUNDED },
      );
      orderUpdated = (result.affected ?? 0) > 0;
    }
    this.logger.error(
      `Pagamento #${record.id} (loja #${record.store_id}, ${formatBRL(record.amount)}) aprovado e depois ${record.status} no Mercado Pago${record.order_id !== null ? `: pedido #${record.order_id}${orderUpdated ? ' marcado como estornado' : ''}` : ''}.`,
    );
    await this.audit.record({
      scope: 'SYSTEM',
      storeId: record.store_id,
      action: 'payment.reversed',
      targetType: 'payment',
      targetId: record.id,
      result: 'FAILURE',
      metadata: {
        status: record.status,
        status_detail: record.status_detail,
        amount: record.amount,
        order_id: record.order_id,
        order_updated: orderUpdated,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Pedido do pagamento
  // ---------------------------------------------------------------------------

  /**
   * POST /orders com paymentId (apps antigos e repetições após perda da resposta): devolve o pedido
   * do pagamento, criando-o com o retrato guardado na hora do pagamento quando ainda não existe.
   * Idempotente para o mesmo cliente; o corpo enviado não muda o pedido. O pagamento precisa ser
   * da loja da rota (de outra loja = não encontrado).
   */
  async orderIdForPayment(
    dto: CreateOrderDto,
    actor: AuthUser,
    tenant: TenantContext,
  ): Promise<number> {
    const paymentId = Number(dto.paymentId);
    let record = await this.findRecord(paymentId);

    if (!record) {
      // Pedido de um pagamento anterior a esta versão (registro em memória)
      const legacy = await this.orderRepository.findOne({
        where: {
          payment_id: paymentId,
          store_id: tenant.storeId,
          user: { id: actor.id },
        },
        select: { id: true, status: true },
      });
      if (legacy) return usableOrderId(legacy);
      record = await this.recoverFromMercadoPago(dto, actor, tenant);
    }
    // Pagamento de outra loja ou de outro cliente: a mesma resposta de inexistente (não confirma que existe)
    if (
      !record ||
      record.store_id !== tenant.storeId ||
      record.user_id !== actor.id
    )
      throw new BadRequestException(PAYMENT_NOT_FOUND_OR_EXPIRED_MESSAGE);
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
      where: { id: orderId, store_id: tenant.storeId },
      select: { id: true, status: true },
    });
    if (!order) throw new BadRequestException(PAYMENT_ALREADY_USED_MESSAGE);
    return usableOrderId(order);
  }

  /**
   * Cria (uma única vez) o pedido de um pagamento aprovado, na loja do pagamento, com o pedido e os
   * preços guardados na hora do pagamento — mesmo que a loja tenha FECHADO ou os preços tenham mudado
   * depois. A loja que deixou de vender (suspensa, desativada, assinatura bloqueada) não recebe o
   * pedido: o valor é estornado. Idempotente: orders.payment_id é único. Devolve o id do pedido ou
   * null (não aprovado/falhou).
   */
  async finalize(record: Payment): Promise<number | null> {
    if (record.order_id !== null) return record.order_id;
    if (record.status !== 'approved') return null;
    // Falha definitiva já registrada (estornado ou estorno pendente com a equipe): notificações e
    // consultas repetidas não refazem o estorno nem a auditoria
    if (record.finalize_error) return null;

    const running = this.finalizing.get(record.id);
    if (running) {
      const orderId = await running;
      if (orderId !== null) record.order_id = orderId;
      return orderId;
    }
    const task = this.finalizeLocked(record).finally(() =>
      this.finalizing.delete(record.id),
    );
    this.finalizing.set(record.id, task);
    return task;
  }

  /**
   * Entre instâncias da API: a decisão (criar o pedido ou estornar) é tomada com a trava do banco do
   * pagamento (pg_advisory_xact_lock, solta no fim da transação), relendo order_id e finalize_error
   * depois de obtê-la. Sem ela, uma instância podia estornar (a loja acabou de deixar de vender)
   * enquanto outra criava o pedido, e o vínculo apagava o finalize_error: pedido PAGO com o valor
   * devolvido. A transação só segura a trava; as gravações seguem pelos repositórios de sempre.
   */
  private async finalizeLocked(record: Payment): Promise<number | null> {
    if (this.finalizeSlots > 0) this.finalizeSlots--;
    else
      await new Promise<void>((resolve) => this.finalizeWaiters.push(resolve));
    try {
      return await this.decideUnderLock(record);
    } finally {
      const next = this.finalizeWaiters.shift();
      if (next) next();
      else this.finalizeSlots++;
    }
  }

  private async decideUnderLock(record: Payment): Promise<number | null> {
    return this.paymentRepository.manager.transaction(async (manager) => {
      await manager.query(FINALIZE_LOCK_SQL, [String(record.id)]);
      const current = await this.findRecord(record.id);
      if (!current || current.store_id !== record.store_id) return null;
      if (current.order_id !== null) {
        record.order_id = current.order_id;
        record.finalize_error = null;
        return current.order_id;
      }
      if (current.finalize_error) {
        record.finalize_error = current.finalize_error;
        return null;
      }
      // Desfeito no Mercado Pago enquanto esperava a trava (webhook de outra instância): sem pedido
      if (REVERSED_PAYMENT_STATUSES.includes(current.status)) {
        record.status = current.status;
        record.status_detail = current.status_detail;
        return null;
      }
      return this.createOrderFor(record);
    });
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
      where: { payment_id: record.id, store_id: record.store_id },
      select: { id: true },
    });
    if (existing) return this.linkOrder(record, existing.id);

    // Situação ATUAL da loja e da assinatura (o pagamento pode ter começado antes do bloqueio)
    const { access } = await this.tenants.contextForStoreId(record.store_id);
    if (!access.canSell) {
      await this.failPermanently(record, STORE_CANNOT_SELL_REASON, {
        availability: access.availability,
      });
      return null;
    }

    const snapshot = record.price_snapshot;
    let problem: string | null = null;
    if (!isOrderSnapshot(snapshot)) problem = 'dados do pedido inválidos';
    // Retratos antigos não têm storeId: vale a loja do pagamento
    else if (
      snapshot.storeId !== undefined &&
      snapshot.storeId !== record.store_id
    )
      problem = 'o pedido pago é de outra loja';
    else if (!amountMatches(record.amount, snapshot.total))
      problem = `valor pago (${formatBRL(record.amount)}) diferente do total do pedido (${formatBRL(snapshot.total)})`;
    else if (!(await this.userExists(record.user_id)))
      problem = 'a conta do cliente não existe mais';
    if (problem !== null) {
      await this.failPermanently(record, problem);
      return null;
    }

    const references = await this.pricing.existingReferences({
      storeId: record.store_id,
      productIds: snapshot.items.map((item) => item.productId),
      addonIds: snapshot.items.flatMap((item) =>
        item.addons.map((addon) => addon.id),
      ),
      addressId: snapshot.addressId,
      userId: record.user_id,
    });
    const order = this.orderRepository.create(
      buildOrder(
        snapshot,
        {
          storeId: record.store_id,
          userId: record.user_id,
          paymentId: record.id,
          paymentMethod: record.order_payment_method,
          paymentStatus: PaymentStatus.PAID,
          changeFor: null,
        },
        references,
      ),
    );

    let saved: Order;
    try {
      saved = await this.orderRepository.save(order);
    } catch (error) {
      // Índice único em orders.payment_id: outra chamada criou o pedido ao mesmo tempo
      if (isUniqueViolation(error)) {
        const winner = await this.orderRepository.findOne({
          where: { payment_id: record.id, store_id: record.store_id },
          select: { id: true },
        });
        if (winner) return this.linkOrder(record, winner.id);
      }
      // Gatilho de loja do banco (item/adicional/entregador de outra loja): nunca vai dar certo
      if (isCheckViolation(error)) {
        await this.failPermanently(
          record,
          'o pedido tem itens que não pertencem à loja do pagamento',
        );
        return null;
      }
      throw error;
    }
    this.logger.log(
      `Pedido #${saved.id} criado pelo pagamento #${record.id} (${formatBRL(record.amount)}, loja #${record.store_id}).`,
    );
    return this.linkOrder(record, saved.id);
  }

  private async linkOrder(record: Payment, orderId: number): Promise<number> {
    record.order_id = orderId;
    record.finalize_error = null;
    await this.updateRecord(record, {
      order_id: orderId,
      finalize_error: null,
    });
    return orderId;
  }

  /** Pagamento aprovado que não pode virar pedido: estorna e guarda o motivo (fica para a equipe). */
  private async failPermanently(
    record: Payment,
    reason: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    this.logger.error(
      `Pagamento #${record.id} aprovado não pôde virar pedido: ${reason}. Estornando.`,
    );
    const refunded = await this.refund(record.id, record.store_id, {
      known: record,
      reason: 'order_not_created',
    });
    record.finalize_error = `${reason} (${refunded ? 'valor estornado' : 'estorno pendente'})`;
    await this.updateRecord(record, { finalize_error: record.finalize_error });
    await this.audit.record({
      scope: 'SYSTEM',
      storeId: record.store_id,
      action: 'payment.order_not_created',
      targetType: 'payment',
      targetId: record.id,
      result: 'FAILURE',
      metadata: { reason, refunded, amount: record.amount, ...details },
    });
  }

  // ---------------------------------------------------------------------------
  // Estorno
  // ---------------------------------------------------------------------------

  /**
   * Estorna um pagamento online (pedido pago e cancelado) com a credencial da loja informada, que
   * precisa ser a loja do pagamento. true = estornado (sandbox: simulado); false = falhou e o estorno
   * fica pendente para a equipe. Nunca lança erro. Sempre auditado.
   */
  async refund(
    paymentId: number,
    storeId: number,
    options: RefundOptions = {},
  ): Promise<boolean> {
    const outcome = await this.attemptRefund(paymentId, storeId, options.known);
    const actor = options.actor ?? null;
    await this.audit.record({
      actor,
      // Estorno pedido pela equipe = ação da loja; pelo cliente ou pela rotina = executado pelo sistema
      scope: actor && isStaffRole(actor.role) ? 'STORE' : 'SYSTEM',
      storeId,
      action: 'payment.refund',
      targetType: 'payment',
      targetId: paymentId,
      result: outcome.refunded ? 'SUCCESS' : 'FAILURE',
      metadata: {
        reason: options.reason ?? null,
        order_id: options.orderId ?? null,
        simulated: outcome.simulated,
        ...(outcome.problem ? { problem: outcome.problem } : {}),
      },
    });
    return outcome.refunded;
  }

  private async attemptRefund(
    paymentId: number,
    storeId: number,
    known?: Payment | null,
  ): Promise<{ refunded: boolean; simulated: boolean; problem?: string }> {
    let simulated = false;
    try {
      const record = known ?? (await this.findRecord(paymentId));
      if (record && record.store_id !== storeId) {
        this.logger.error(
          `Estorno do pagamento #${paymentId} recusado: ele não é da loja #${storeId}.`,
        );
        return {
          refunded: false,
          simulated,
          problem: 'pagamento de outra loja',
        };
      }
      simulated = record ? record.simulated : isSimulatedPaymentId(paymentId);

      if (this.mode.sandbox || simulated) {
        this.logger.warn(
          `Estorno do pagamento #${paymentId} SIMULADO (sandbox): nenhum valor real foi movimentado.`,
        );
        await this.markRefunded(record);
        return { refunded: true, simulated: true };
      }
      const gateway = await this.gatewayFor(storeId);
      if (!gateway) {
        this.logger.error(
          `Estorno do pagamento #${paymentId} pendente: a loja #${storeId} está sem credencial do Mercado Pago.`,
        );
        return {
          refunded: false,
          simulated,
          problem: 'loja sem credencial do Mercado Pago',
        };
      }

      try {
        await gateway.refundPayment(paymentId, `refund-${paymentId}`);
      } catch (error) {
        // Já estornado (ex.: pelo painel do Mercado Pago)?
        const remote = await gateway.getPayment(paymentId).catch(() => null);
        if (remote?.status !== 'refunded') {
          const problem = describeMercadoPagoError(error).message;
          this.logger.error(
            `Estorno do pagamento #${paymentId} falhou: ${problem}`,
          );
          return { refunded: false, simulated, problem };
        }
      }
      await this.markRefunded(record);
      this.logger.log(`Pagamento #${paymentId} estornado no Mercado Pago.`);
      return { refunded: true, simulated };
    } catch (error) {
      const problem = errorText(error);
      this.logger.error(
        `Estorno do pagamento #${paymentId} falhou: ${problem}`,
      );
      return { refunded: false, simulated, problem };
    }
  }

  private async markRefunded(record: Payment | null): Promise<void> {
    if (!record) return;
    record.status = 'refunded';
    record.status_detail = 'refunded';
    await this.updateRecord(record, {
      status: record.status,
      status_detail: record.status_detail,
    });
  }

  // ---------------------------------------------------------------------------
  // Conciliação (a cada 60 s, ver PaymentReconciler)
  // ---------------------------------------------------------------------------

  /**
   * Revê os pagamentos sem pedido dos últimos dias, de TODAS as lojas (rotina do sistema): pendentes
   * são reconsultados com a credencial da loja de cada um (Mercado Pago real) ou aprovados pelo prazo
   * do sandbox; aprovados viram pedido. Cobre o cliente que fechou o app, a notificação que não chegou
   * e a falha passageira ao criar o pedido. Justa entre as lojas (ver RECONCILE_CANDIDATES_SQL): uma
   * loja, um cliente ou pagamentos que não podem ser reconsultados não seguram a fila das outras.
   * Pendentes de loja que não pode mais vender são cancelados no Mercado Pago.
   */
  async reconcile(now: Date = new Date()): Promise<{ finalized: number }> {
    const candidates = await this.reconcileCandidates(now);
    if (!candidates.length) return { finalized: 0 };

    // Uma consulta de credencial e da situação de cada loja nesta rodada
    const gatewayOf = memoize((storeId: number) => this.gatewayFor(storeId));
    const accessOf = memoize((storeId: number) =>
      this.tenants.contextForStoreId(storeId).then((context) => context.access),
    );

    let finalized = 0;
    for (const record of candidates) {
      try {
        const gateway = record.simulated
          ? null
          : await gatewayOf(record.store_id);
        await this.refresh(record, false, gateway);
        if (record.status === 'approved') {
          if ((await this.finalize(record)) !== null) finalized++;
        } else if (PENDING_PAYMENT_STATUSES.includes(record.status)) {
          const access = await accessOf(record.store_id);
          if (!access.canSell)
            await this.cancelForUnavailableStore(record, gateway, access);
        }
      } catch (error) {
        this.logger.warn(
          `Conciliação do pagamento #${record.id} (loja #${record.store_id}) falhou: ${errorText(error)}`,
        );
      }
    }

    // Conferidos nesta rodada vão para o fim da fila (updated_at = última conferência)
    await this.paymentRepository
      .update(
        { id: In(candidates.map((record) => record.id)) },
        { updated_at: () => 'CURRENT_TIMESTAMP' },
      )
      .catch((error: unknown) =>
        this.logger.warn(
          `Conciliação: não foi possível marcar os pagamentos conferidos: ${errorText(error)}`,
        ),
      );
    if (finalized > 0)
      this.logger.log(
        `Conciliação: ${finalized} pedido(s) criado(s) a partir de pagamentos aprovados.`,
      );
    return { finalized };
  }

  /**
   * Janela dos pagamentos sem pedido ainda acompanhados (conciliação, reservas do limite do mês e teto
   * de cobranças pendentes): RECONCILE_WINDOW_MS ou, com PIX de prazo maior, o prazo + 1 dia.
   */
  private reconcileWindowMs(): number {
    return Math.max(
      RECONCILE_WINDOW_MS,
      this.mode.pixExpirationMinutes * 60_000 + PIX_DEADLINE_MARGIN_MS,
    );
  }

  /** Candidatos da rodada (ver RECONCILE_CANDIDATES_SQL), na ordem de processamento. */
  private async reconcileCandidates(now: Date): Promise<Payment[]> {
    const since = new Date(now.getTime() - this.reconcileWindowMs());
    const rows: Array<{ id: string | number }> =
      await this.paymentRepository.query(RECONCILE_CANDIDATES_SQL, [
        since,
        PENDING_PAYMENT_STATUSES,
        RECONCILE_PER_STORE,
        RECONCILE_BATCH,
      ]);
    const ids = rows.map((row) => Number(row.id));
    if (!ids.length) return [];
    const records = await this.paymentRepository.find({
      where: { id: In(ids) },
    });
    const byId = new Map(records.map((record) => [record.id, record]));
    return ids
      .map((id) => byId.get(id))
      .filter((record): record is Payment => record !== undefined);
  }

  /**
   * Pagamento ainda pendente numa loja que não pode mais vender: cancela no Mercado Pago (com a
   * credencial da loja) para o PIX deixar de valer. Se não der agora, a próxima rodada tenta de novo;
   * se ele for pago antes, o pedido não nasce e o valor é estornado (finalize).
   */
  private async cancelForUnavailableStore(
    record: Payment,
    gateway: PaymentGateway | null,
    access: StoreAccessState,
  ): Promise<void> {
    if (!record.simulated && gateway) {
      try {
        const remote = await gateway.cancelPayment(
          record.id,
          `cancel-${record.id}`,
        );
        record.status = remote.status ?? 'cancelled';
        record.status_detail = remote.status_detail ?? 'by_collector';
      } catch (error) {
        this.logger.warn(
          `Pagamento #${record.id} da loja #${record.store_id} (sem vender: ${access.availability}) não pôde ser cancelado no Mercado Pago agora: ${describeMercadoPagoError(error).message}`,
        );
        return;
      }
    } else if (!record.simulated && !this.mode.sandbox) {
      // Pagamento real e a loja está sem credencial: não há como cancelar no Mercado Pago
      this.warnCredential(
        `${record.store_id}:cancelar`,
        `Loja #${record.store_id} (sem vender: ${access.availability}) tem pagamentos pendentes que não podem ser cancelados: está sem credencial do Mercado Pago.`,
      );
      return;
    } else {
      record.status = 'cancelled';
      record.status_detail = 'by_collector';
    }

    await this.updateRecord(record, {
      status: record.status,
      status_detail: record.status_detail,
    });
    if (record.status === 'approved') {
      // Pago no mesmo instante: não vira pedido (loja sem vender) e o valor é estornado
      await this.finalize(record);
      return;
    }
    this.logger.warn(
      `Pagamento #${record.id} cancelado: a loja #${record.store_id} não está vendendo (${access.availability}).`,
    );
    await this.audit.record({
      scope: 'SYSTEM',
      storeId: record.store_id,
      action: 'payment.cancel',
      targetType: 'payment',
      targetId: record.id,
      result: 'SUCCESS',
      metadata: {
        reason: 'store_cannot_sell',
        availability: access.availability,
        status: record.status,
        simulated: record.simulated,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Credenciais do Mercado Pago por loja
  // ---------------------------------------------------------------------------

  /**
   * A loja aceita pagamento online agora? (perfil público da vitrine: payments.online_enabled)
   * Plano com o recurso online_payments e credencial do Mercado Pago utilizável — ou o sandbox de
   * development/test, que simula. Não diz nada sobre a credencial além de sim/não.
   */
  async onlinePaymentsAvailable(storeId: number): Promise<boolean> {
    if (!(await this.planLimits.hasFeature(storeId, 'online_payments')))
      return false;
    if (this.mode.sandbox) return true;
    return (await this.gatewayFor(storeId)) !== null;
  }

  /**
   * Gateway do Mercado Pago da loja: a credencial da própria loja (cifrada no banco) ou, só para a
   * loja padrão sem credencial própria, o MP_ACCESS_TOKEN do ambiente (compatibilidade com a versão de
   * loja única). Sem credencial utilizável → null. Cache por (loja, hash do token): trocar a
   * credencial cria um gateway novo e descarta o antigo.
   */
  private async gatewayFor(storeId: number): Promise<PaymentGateway | null> {
    const token = await this.accessTokenFor(storeId);
    if (!token) {
      this.dropGateways(storeId);
      return null;
    }
    const key = `${storeId}:${sha256Hex(token)}`;
    const cached = this.gateways.get(key);
    if (cached) return cached;
    this.dropGateways(storeId);
    const gateway = this.gatewayFactory(token);
    this.gateways.set(key, gateway);
    return gateway;
  }

  private dropGateways(storeId: number): void {
    const prefix = `${storeId}:`;
    for (const key of [...this.gateways.keys()]) {
      if (key.startsWith(prefix)) this.gateways.delete(key);
    }
  }

  /** Access Token da loja (nunca vai para log, auditoria ou resposta). Em produção, TEST- é recusado. */
  private async accessTokenFor(storeId: number): Promise<string | null> {
    // A coluna é select:false: o token cifrado só é lido aqui, pedido explicitamente
    const store = await this.storeRepository.findOne({
      where: { id: storeId },
      select: { id: true, mp_access_token_encrypted: true },
    });
    if (!store) return null;

    let token: string | null = null;
    let source = 'credencial da loja';
    if (store.mp_access_token_encrypted) {
      try {
        // Presa à loja (v2 com AAD); o formato antigo (v1) continua legível até ser regravado
        token =
          decryptStoreSecret(storeId, store.mp_access_token_encrypted).trim() ||
          null;
      } catch (error) {
        this.warnCredential(
          `${storeId}:ilegivel`,
          `Credencial do Mercado Pago da loja #${storeId} não pôde ser lida (${errorText(error)}): pagamentos online da loja indisponíveis.`,
        );
        return null;
      }
    } else if (this.mode.accessToken && (await this.isDefaultStore(storeId))) {
      token = this.mode.accessToken;
      source = 'MP_ACCESS_TOKEN';
    }

    if (token && this.production && isTestAccessToken(token)) {
      this.warnCredential(
        `${storeId}:teste`,
        `Loja #${storeId}: credencial de TESTE do Mercado Pago (${source}) recusada em produção.`,
      );
      return null;
    }
    return token;
  }

  private async isDefaultStore(storeId: number): Promise<boolean> {
    const store = await this.tenants.defaultStore();
    return store?.id === storeId;
  }

  private warnCredential(key: string, message: string): void {
    const now = Date.now();
    const last = this.credentialWarnings.get(key);
    if (last !== undefined && now - last < CREDENTIAL_WARNING_INTERVAL_MS)
      return;
    this.credentialWarnings.set(key, now);
    this.logger.error(message);
  }

  // ---------------------------------------------------------------------------
  // Internos
  // ---------------------------------------------------------------------------

  /**
   * Antes de cobrar: loja vendendo, plano com pagamento online e credencial do Mercado Pago da loja
   * (sem ela, só o sandbox de development/test simula). Devolve o gateway (null = simulação).
   */
  private async prepareCharge(
    tenant: TenantContext,
  ): Promise<PaymentGateway | null> {
    this.tenants.assertCanSell(tenant);
    if (!(await this.planLimits.hasFeature(tenant.storeId, 'online_payments')))
      throw new ForbiddenException(ONLINE_PAYMENT_NOT_IN_PLAN_MESSAGE);
    const gateway = await this.gatewayFor(tenant.storeId);
    if (!gateway && !this.mode.sandbox)
      throw new ServiceUnavailableException(ONLINE_PAYMENT_UNAVAILABLE_MESSAGE);
    return gateway;
  }

  /** Valor cobrado = total calculado pelo servidor com o cardápio da loja; valida o pedido ANTES de cobrar. */
  private async priceForCharge(
    order: QuoteOrderDto,
    userId: number,
    tenant: TenantContext,
  ): Promise<PricedOrder> {
    const priced = await this.pricing.price(order, userId, tenant);
    if (!priced.store_open) throw new BadRequestException(STORE_CLOSED_MESSAGE);
    if (priced.totalCents <= 0)
      throw new BadRequestException(
        'Este pedido não tem valor a pagar online.',
      );
    return priced;
  }

  /**
   * Antes de criar uma cobrança nova no Mercado Pago (depois de validar o pedido):
   * 1. limite de pedidos do mês do plano, contando os pagamentos online da loja ainda em andamento
   *    (cada um pode virar pedido) — 403 com a mensagem para o cliente;
   * 2. teto de cobranças pendentes do cliente na loja (MAX_PENDING_CHARGES_PER_CUSTOMER) — 429;
   * 3. limite de cobranças por cliente na loja (PAYMENT_CREATE) e por IP (PAYMENT_CREATE_IP) — 429.
   */
  private async assertCanCharge(
    storeId: number,
    userId: number,
    clientIp?: string | null,
  ): Promise<void> {
    const now = new Date();
    const reserved = await this.reservedOrderSlots(storeId, userId, now);
    try {
      await this.planLimits.assertWithinLimit(
        storeId,
        'monthly_orders',
        1 + reserved,
      );
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      // O 403 do plano fala com a equipe (nome do plano): o cliente recebe a mensagem neutra
      this.logger.warn(
        `Loja #${storeId}: nova cobrança recusada (${error.message}; ${reserved} pagamento(s) online em andamento).`,
      );
      throw new ForbiddenException(MONTHLY_ORDERS_LIMIT_MESSAGE);
    }

    const since = new Date(now.getTime() - this.reconcileWindowMs());
    const mine = {
      store_id: storeId,
      user_id: userId,
      order_id: IsNull(),
      status: In(PENDING_PAYMENT_STATUSES),
      created_at: MoreThan(since),
    };
    const pending = await this.paymentRepository.count({
      where: [
        { ...mine, expires_at: IsNull() },
        { ...mine, expires_at: MoreThan(now) },
      ],
    });
    if (pending >= MAX_PENDING_CHARGES_PER_CUSTOMER) {
      this.logger.warn(
        `Cliente #${userId} com ${pending} cobranças pendentes na loja #${storeId}: nova cobrança recusada.`,
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: TOO_MANY_PENDING_CHARGES_MESSAGE,
          error: 'Too Many Requests',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Só conta o que vai mesmo virar cobrança (confere os dois limites antes de registrar)
    const customerKey = `loja:${storeId}:cliente:${userId}`;
    try {
      this.rateLimit.assertNotLimited('PAYMENT_CREATE', customerKey);
      if (clientIp)
        this.rateLimit.assertNotLimited('PAYMENT_CREATE_IP', clientIp);
    } catch (error) {
      this.logger.warn(
        `Limite de cobranças atingido (cliente #${userId}, loja #${storeId}, IP ${clientIp ?? 'desconhecido'}).`,
      );
      throw error;
    }
    this.rateLimit.hit('PAYMENT_CREATE', customerKey);
    if (clientIp) this.rateLimit.hit('PAYMENT_CREATE_IP', clientIp);
  }

  /**
   * Pedidos do mês que os pagamentos online em andamento ainda podem gerar, para o limite do plano:
   * - da loja inteira, só o que já é obrigação: aprovados que ainda não viraram pedido e cartões em
   *   análise (não vencidos);
   * - PIX pendentes (não vencidos) só os do próprio cliente (userId). Gerar um PIX não custa nada:
   *   se os de qualquer cliente contassem, contas descartáveis ocupariam as vagas do mês e a loja
   *   deixaria de vender sem ninguém pagar. PIX de clientes diferentes pagos no limite exato passam
   *   como os demais limites "suaves" (o pagamento aprovado sempre vira pedido).
   */
  async reservedOrderSlots(
    storeId: number,
    userId: number | null = null,
    now: Date = new Date(),
  ): Promise<number> {
    const since = new Date(now.getTime() - this.reconcileWindowMs());
    const open = {
      store_id: storeId,
      order_id: IsNull(),
      created_at: MoreThan(since),
    };
    const pending = { ...open, status: In(PENDING_PAYMENT_STATUSES) };
    const card = { ...pending, method: 'CARD' as const };
    const where: FindOptionsWhere<Payment>[] = [
      { ...card, expires_at: IsNull() },
      { ...card, expires_at: MoreThan(now) },
      { ...open, status: 'approved', finalize_error: IsNull() },
    ];
    if (userId !== null) {
      const pix = { ...pending, method: 'PIX' as const, user_id: userId };
      where.push(
        { ...pix, expires_at: IsNull() },
        { ...pix, expires_at: MoreThan(now) },
      );
    }
    return this.paymentRepository.count({ where });
  }

  /**
   * PIX ainda pendente do mesmo cliente, na mesma loja, com o mesmo carrinho e o mesmo valor (e prazo
   * para pagar): o app que gera o PIX de novo recebe o mesmo código em vez de outra cobrança.
   */
  private async reusablePix(
    tenant: TenantContext,
    userId: number,
    dto: CreatePixPaymentDto,
    priced: PricedOrder,
  ): Promise<Payment | null> {
    const now = new Date();
    const candidates = await this.paymentRepository.find({
      where: {
        store_id: tenant.storeId,
        user_id: userId,
        method: 'PIX',
        status: 'pending',
        order_id: IsNull(),
        finalize_error: IsNull(),
        expires_at: MoreThan(
          new Date(now.getTime() + PIX_REUSE_MIN_REMAINING_MS),
        ),
      },
      order: { created_at: 'DESC' },
      take: MAX_PENDING_CHARGES_PER_CUSTOMER,
    });
    const cart = canonicalJson(requestPayload(dto.order));
    const same = candidates.find(
      (record) =>
        toCents(record.amount) === priced.totalCents &&
        !!record.pix_data?.qr_code &&
        canonicalJson(record.order_payload) === cart &&
        // PIX do sandbox já no prazo de aprovação automática conta como pago
        (!record.simulated || simulatedPixProgress(record, now) === null),
    );
    if (same)
      this.logger.log(
        `PIX #${same.id} pendente reaproveitado (mesmo carrinho do cliente #${userId}, loja #${tenant.storeId}).`,
      );
    return same ?? null;
  }

  /**
   * A mesma chave de idempotência do mesmo cliente NA MESMA LOJA devolve o pagamento já criado (nunca
   * cobra duas vezes); pedidos simultâneos com a mesma chave esperam o primeiro.
   */
  private async once(
    storeId: number,
    userId: number,
    key: string | undefined,
    kind: PaymentKind,
    create: () => Promise<Payment>,
  ): Promise<Payment> {
    if (!key) return create();

    const existing = await this.paymentRepository.findOne({
      where: { store_id: storeId, user_id: userId, idempotency_key: key },
    });
    if (existing) return sameKind(existing, kind);

    const flight = `${storeId}:${userId}:${key}`;
    const running = this.creating.get(flight);
    if (running) return sameKind(await running, kind);

    const task = create().finally(() => this.creating.delete(flight));
    this.creating.set(flight, task);
    return task;
  }

  private newRecord(
    tenant: TenantContext,
    userId: number,
    method: PaymentKind,
    dto: CreatePixPaymentDto,
    priced: PricedOrder,
    extra: { orderPaymentMethod: string; paymentMethodId: string },
  ): NewPayment {
    return {
      id: 0,
      store_id: tenant.storeId,
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
      external_reference: externalReferenceFor(
        BRAND.slug,
        tenant.storeId,
        userId,
        Date.now(),
      ),
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
              store_id: current.store_id,
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
        if (
          same &&
          same.user_id === current.user_id &&
          same.store_id === current.store_id
        )
          return same;
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
      `Pagamento com cartão #${record.id} APROVADO POR SIMULAÇÃO (${formatBRL(record.amount)}, loja #${record.store_id}): ${reason}. Apenas sandbox.`,
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
      `PIX #${record.id} SIMULADO (${formatBRL(record.amount)}, loja #${record.store_id}): ${reason}. Aprovação automática em ${this.mode.pixApprovalSeconds}s (sandbox).`,
    );
    return record;
  }

  /**
   * Pagamento que não está na tabela, mas é real: confere no Mercado Pago (conta da loja da rota) se é
   * deste cliente e desta loja (external_reference), se está aprovado, se a forma bate e se o valor é
   * o total do pedido enviado.
   */
  private async recoverFromMercadoPago(
    dto: CreateOrderDto,
    actor: AuthUser,
    tenant: TenantContext,
  ): Promise<Payment | null> {
    const paymentId = Number(dto.paymentId);
    const kind = paymentKindFor(dto.paymentMethod);
    if (!kind || isSimulatedPaymentId(paymentId)) return null;
    const gateway = await this.gatewayFor(tenant.storeId);
    if (!gateway) return null;
    // Cada id desconhecido é uma consulta ao Mercado Pago com a credencial da loja: limitada por
    // cliente na loja (mesma política das cobranças, contador próprio)
    this.rateLimit.consume(
      'PAYMENT_CREATE',
      `consulta:loja:${tenant.storeId}:cliente:${actor.id}`,
    );

    let remote: Awaited<ReturnType<PaymentGateway['getPayment']>>;
    try {
      remote = await gateway.getPayment(paymentId);
    } catch {
      return null;
    }
    // Formato antigo (sem loja): o pagamento está na conta desta loja, então é dela
    const reference = parseExternalReference(remote.external_reference);
    if (
      !reference ||
      reference.userId !== actor.id ||
      (reference.storeId !== null && reference.storeId !== tenant.storeId)
    )
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

    // Já foi pago: a loja fechada e o bloqueio do cliente pela loja não impedem (a loja pode cancelar e
    // estornar); o resto do pedido é validado normalmente
    const priced = await this.pricing.price(dto, actor.id, tenant, {
      alreadyPaid: true,
    });
    const paid = Number(remote.transaction_amount ?? 0);
    if (!amountMatches(paid, priced.total)) {
      throw new BadRequestException(
        `O valor pago (${formatBRL(paid)}) não confere com o total do pedido (${formatBRL(priced.total)}).`,
      );
    }

    this.logger.warn(
      `Pagamento #${paymentId} recuperado do Mercado Pago (não estava registrado neste servidor; loja #${tenant.storeId}).`,
    );
    return this.saveRecord({
      id: paymentId,
      store_id: tenant.storeId,
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
   * reconsultados no Mercado Pago com a credencial da loja do pagamento (strict = sempre reconsulta
   * e, em produção, falha se não conseguir). knownGateway: já resolvido por quem chama (null = sem).
   */
  private async refresh(
    record: Payment,
    strict: boolean,
    knownGateway?: PaymentGateway | null,
    options: RefreshOptions = {},
  ): Promise<void> {
    const before = `${record.status}|${record.status_detail}|${record.amount}`;

    const gateway = record.simulated
      ? null
      : knownGateway !== undefined
        ? knownGateway
        : await this.gatewayFor(record.store_id);

    if (record.simulated || (!gateway && this.mode.sandbox)) {
      const next = simulatedPixProgress(record);
      if (next) {
        record.status = next.status;
        record.status_detail = next.status_detail;
        if (next.status === 'approved')
          this.logger.warn(
            `PIX #${record.id} aprovado automaticamente (SIMULAÇÃO de sandbox).`,
          );
      }
    } else if (!gateway) {
      // Pagamento real e a loja está sem credencial agora: não há como conferir (nada muda). Um
      // aprovado já confirmado vale (a conciliação criaria o pedido dele do mesmo jeito); o resto
      // não pode ser confirmado às cegas.
      if (strict && record.status !== 'approved')
        throw new BadGatewayException(CONFIRM_FAILED_MESSAGE);
    } else if (
      (strict ||
        !isFinalPaymentStatus(record.status) ||
        (options.followApproved && record.status === 'approved')) &&
      !(options.poll && !strict && this.recentlyChecked(record.id))
    ) {
      try {
        // Estrita: consulta própria, agora; as demais (polling, webhook, conciliação) dividem a
        // consulta que já estiver em andamento para o mesmo pagamento
        this.markRemoteCheck(record.id);
        const remote = strict
          ? await gateway.getPayment(record.id)
          : await this.lookupShared(gateway, record.id);
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
          throw new BadGatewayException(CONFIRM_FAILED_MESSAGE);
        }
        this.logger.warn(
          `Não foi possível consultar o pagamento #${record.id} no Mercado Pago: ${reason.message}`,
        );
      }
    }

    if (
      `${record.status}|${record.status_detail}|${record.amount}` !== before
    ) {
      await this.updateRecord(record, {
        status: record.status,
        status_detail: record.status_detail,
        amount: record.amount,
      });
    }
  }

  /**
   * O polling pode pular a consulta ao Mercado Pago? Sim se outra (de qualquer origem) começou há menos
   * de STATUS_POLL_RECHECK_MS e não está mais em andamento (em andamento, o polling usa a mesma).
   */
  private recentlyChecked(paymentId: number): boolean {
    if (this.lookups.has(paymentId)) return false;
    const last = this.remoteChecks.get(paymentId);
    return last !== undefined && Date.now() - last < STATUS_POLL_RECHECK_MS;
  }

  /** Marca a consulta ao Mercado Pago (Map em ordem de horário e limitado, como o das notificações). */
  private markRemoteCheck(paymentId: number): void {
    const now = Date.now();
    this.remoteChecks.delete(paymentId);
    this.remoteChecks.set(paymentId, now);
    if (this.remoteChecks.size > NOTIFICATION_TRACK_LIMIT) {
      for (const [id, at] of this.remoteChecks) {
        if (now - at < STATUS_POLL_RECHECK_MS) break;
        this.remoteChecks.delete(id);
      }
    }
  }

  /** Uma consulta ao Mercado Pago por pagamento de cada vez (as simultâneas recebem a mesma resposta). */
  private lookupShared(
    gateway: PaymentGateway,
    paymentId: number,
  ): Promise<Awaited<ReturnType<PaymentGateway['getPayment']>>> {
    const running = this.lookups.get(paymentId);
    if (running) return running;
    const task = gateway
      .getPayment(paymentId)
      .finally(() => this.lookups.delete(paymentId));
    this.lookups.set(paymentId, task);
    return task;
  }

  /** Grava pelo critério composto { id, store_id } (nunca altera pagamento de outra loja). */
  private async updateRecord(
    record: Payment,
    changes: PaymentChanges,
  ): Promise<void> {
    const result = await this.paymentRepository.update(
      { id: record.id, store_id: record.store_id },
      changes,
    );
    if (result.affected === 0) {
      this.logger.warn(
        `Pagamento #${record.id} não foi atualizado: registro não encontrado na loja #${record.store_id}.`,
      );
    }
  }

  /** Busca pelo id do Mercado Pago (único); quem chama confere a loja e o dono. */
  private findRecord(paymentId: number): Promise<Payment | null> {
    return this.paymentRepository.findOne({ where: { id: paymentId } });
  }

  /**
   * Pagador, ou quem conduz os pedidos da loja do pagamento (ADMIN/EMPLOYEE, com a leitura liberada na
   * situação da loja). Cozinha e entregador não acompanham cobranças: 404 como os demais.
   */
  private async canView(record: Payment, actor: AuthUser): Promise<boolean> {
    if (record.user_id === actor.id) return true;
    if (
      !isOrderManager(actor.role) ||
      !actor.storeId ||
      actor.storeId !== record.store_id
    )
      return false;
    await this.tenants.staffContext(actor, 'read');
    return true;
  }

  /** Rotas /stores/:storeSlug/payment/...: o pagamento precisa ser da loja da URL. */
  private async isRouteStore(
    record: Payment,
    storeSlug?: string,
  ): Promise<boolean> {
    if (storeSlug === undefined) return true;
    const store = await this.tenants.findStoreBySlug(storeSlug);
    return store?.id === record.store_id;
  }

  /** Chave da tentativa no Mercado Pago: derivada de loja + cliente + chave do app; sem chave, uma nova. */
  private idempotencyKeyFor(
    storeId: number,
    userId: number,
    key?: string,
  ): string {
    return key ? mercadoPagoIdempotencyKey(storeId, userId, key) : randomUUID();
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

  /** Descrição da cobrança no Mercado Pago (aparece para o pagador): o nome da loja. */
  private description(tenant: TenantContext): string {
    return `Pedido ${tenant.store.name}`.slice(0, 200);
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

/** Uma chamada por chave (as repetidas recebem a mesma promessa): consultas por loja numa rodada. */
function memoize<K, V>(load: (key: K) => Promise<V>): (key: K) => Promise<V> {
  const cache = new Map<K, Promise<V>>();
  return (key) => {
    let value = cache.get(key);
    if (!value) {
      value = load(key);
      cache.set(key, value);
    }
    return value;
  };
}

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
