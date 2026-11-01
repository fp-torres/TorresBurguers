import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth/auth-user';
import { ParseIdPipe } from '../common/pipes/parse-id.pipe';
import { PlatformRoute } from '../tenancy/decorators';
import type { BillingActor } from './billing-actor';
import { presentInvoice } from './billing-presenter';
import { BillingQueriesService } from './billing-queries.service';
import { CreatePlanDto, PlanListQueryDto, UpdatePlanDto } from './dto/plan.dto';
import {
  ChangePlanDto,
  CreateInvoiceDto,
  CreateStoreSubscriptionDto,
  InvoiceListQueryDto,
  MarkInvoiceFailedDto,
  MarkInvoicePaidDto,
  PlatformCancelSubscriptionDto,
  ReactivateSubscriptionDto,
  SubscriptionListQueryDto,
  SuspendSubscriptionDto,
  VoidInvoiceDto,
} from './dto/subscription.dto';
import { PlansService } from './plans.service';
import { SubscriptionsService } from './subscriptions.service';

const actorOf = (req: AuthenticatedRequest): BillingActor => ({
  user: req.user,
  request: req,
});

/**
 * Superpainel da cobrança SaaS (somente SUPER_ADMIN; toda alteração é auditada): planos,
 * assinaturas das lojas e faturas. Nenhuma loja é implícita: a loja/assinatura/fatura-alvo vem do
 * id da rota. Ações sobre assinatura devolvem o detalhe atualizado; sobre fatura, a fatura.
 */
@ApiTags('Superpainel — cobrança')
@Controller('platform')
@PlatformRoute()
export class PlatformBillingController {
  constructor(
    private readonly plans: PlansService,
    private readonly subscriptions: SubscriptionsService,
    private readonly queries: BillingQueriesService,
  ) {}

  // --- Planos ---

  @Get('plans')
  listPlans(@Query() query: PlanListQueryDto) {
    return this.plans.list(query);
  }

  @Get('plans/:id')
  getPlan(@Param('id', ParseIdPipe) id: number) {
    return this.plans.detail(id);
  }

  @Post('plans')
  createPlan(@Body() dto: CreatePlanDto, @Req() req: AuthenticatedRequest) {
    return this.plans.create(dto, actorOf(req));
  }

  /** Planos nunca são apagados: para tirar de venda, envie { status: "INACTIVE" }. */
  @Patch('plans/:id')
  updatePlan(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: UpdatePlanDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.plans.update(id, dto, actorOf(req));
  }

  // --- Assinaturas ---

  @Get('subscriptions')
  listSubscriptions(@Query() query: SubscriptionListQueryDto) {
    return this.queries.listSubscriptions(query);
  }

  @Get('subscriptions/:id')
  getSubscription(@Param('id', ParseIdPipe) id: number) {
    return this.queries.subscriptionDetail(id);
  }

  /** Cria a assinatura de uma loja sem assinatura vigente (409 se já houver). */
  @Post('stores/:id/subscription')
  async createStoreSubscription(
    @Param('id', ParseIdPipe) storeId: number,
    @Body() dto: CreateStoreSubscriptionDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const subscription = await this.subscriptions.createForStore(
      storeId,
      dto.plan_id,
      {
        actor: req.user,
        request: req,
        allowInactivePlan: dto.allow_inactive_plan,
        reason: dto.reason,
      },
    );
    return this.queries.subscriptionDetail(subscription.id);
  }

  @Post('subscriptions/:id/change-plan')
  @HttpCode(200)
  async changePlan(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: ChangePlanDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.subscriptions.changePlan(id, dto.plan_id, {
      ...actorOf(req),
      reason: dto.reason,
      allowInactivePlan: dto.allow_inactive_plan,
    });
    return this.queries.subscriptionDetail(id);
  }

  @Post('subscriptions/:id/cancel')
  @HttpCode(200)
  async cancel(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: PlatformCancelSubscriptionDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.subscriptions.cancel(id, {
      ...actorOf(req),
      atPeriodEnd: dto.at_period_end === true,
      reason: dto.reason,
    });
    return this.queries.subscriptionDetail(id);
  }

  /** Desfaz o cancelamento agendado enquanto o período pago não terminou (409 caso contrário). */
  @Post('subscriptions/:id/resume')
  @HttpCode(200)
  async resume(
    @Param('id', ParseIdPipe) id: number,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.subscriptions.resume(id, actorOf(req));
    return this.queries.subscriptionDetail(id);
  }

  @Post('subscriptions/:id/reactivate')
  @HttpCode(200)
  async reactivate(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: ReactivateSubscriptionDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.subscriptions.reactivate(id, {
      ...actorOf(req),
      force: dto.force,
      reason: dto.reason,
    });
    return this.queries.subscriptionDetail(id);
  }

  @Post('subscriptions/:id/suspend')
  @HttpCode(200)
  async suspend(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: SuspendSubscriptionDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.subscriptions.suspend(id, {
      ...actorOf(req),
      reason: dto.reason,
    });
    return this.queries.subscriptionDetail(id);
  }

  /** Fatura avulsa (período/valor/vencimento padrão: ver CreateInvoiceDto). */
  @Post('subscriptions/:id/invoices')
  async createInvoice(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: CreateInvoiceDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return presentInvoice(
      await this.subscriptions.createInvoice(id, dto, actorOf(req)),
    );
  }

  // --- Faturas ---

  @Get('invoices')
  listInvoices(@Query() query: InvoiceListQueryDto) {
    return this.queries.listInvoices(query);
  }

  /** Registro manual do pagamento (idempotente). */
  @Post('invoices/:id/mark-paid')
  @HttpCode(200)
  async markPaid(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: MarkInvoicePaidDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return presentInvoice(
      await this.subscriptions.markInvoicePaid(
        id,
        {
          paidAt: dto.paid_at,
          paymentMethod: dto.payment_method,
          providerPaymentId: dto.provider_payment_id,
          notes: dto.notes,
        },
        actorOf(req),
      ),
    );
  }

  /** Pagamento recusado (motivo obrigatório): a fatura continua devida. */
  @Post('invoices/:id/mark-failed')
  @HttpCode(200)
  async markFailed(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: MarkInvoiceFailedDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return presentInvoice(
      await this.subscriptions.markInvoiceFailed(
        id,
        { reason: dto.reason },
        actorOf(req),
      ),
    );
  }

  /** Anulação (motivo obrigatório): a fatura deixa de ser cobrada. */
  @Post('invoices/:id/void')
  @HttpCode(200)
  async voidInvoice(
    @Param('id', ParseIdPipe) id: number,
    @Body() dto: VoidInvoiceDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return presentInvoice(
      await this.subscriptions.voidInvoice(
        id,
        { reason: dto.reason },
        actorOf(req),
      ),
    );
  }
}
