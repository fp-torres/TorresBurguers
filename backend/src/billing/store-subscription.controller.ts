import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth/auth-user';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import {
  CurrentTenant,
  RequireStoreCapability,
  StaffRoute,
} from '../tenancy/decorators';
import type { TenantContext } from '../tenancy/tenant-context';
import { UserRole } from '../users/entities/user.entity';
import type { BillingActor } from './billing-actor';
import { BillingQueriesService } from './billing-queries.service';
import {
  StoreCancelSubscriptionDto,
  SubscriptionCheckoutDto,
} from './dto/subscription.dto';
import { PlansService } from './plans.service';
import { SubscriptionsService } from './subscriptions.service';

const actorOf = (req: AuthenticatedRequest): BillingActor => ({
  user: req.user,
  request: req,
});

/**
 * Assinatura da própria loja (ADMIN). A loja é SEMPRE a do usuário autenticado (StoreStaffGuard →
 * @CurrentTenant()); a capacidade "billing" continua liberada com a loja suspensa ou a assinatura
 * vencida (é por aqui que a loja regulariza). Sessão de suporte: só leitura.
 */
@ApiTags('Assinatura da loja')
@Controller('store/subscription')
@StaffRoute(UserRole.ADMIN)
@RequireStoreCapability('billing')
export class StoreSubscriptionController {
  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly queries: BillingQueriesService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** Plano, assinatura, uso e limites, faturas recentes e situação da loja. */
  @Get()
  overview(@CurrentTenant() tenant: TenantContext) {
    return this.queries.storeOverview(tenant);
  }

  /** Link para autorizar a cobrança automática (provedor online configurado; senão 409). */
  @Post('checkout')
  @HttpCode(200)
  checkout(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: SubscriptionCheckoutDto,
    @Req() req: AuthenticatedRequest,
  ) {
    // Por loja: cada checkout pode chamar o provedor segurando uma conexão do banco até a resposta
    this.rateLimit.consume('SUBSCRIPTION_CHECKOUT', `store:${tenant.storeId}`);
    return this.subscriptions.checkoutForStore(
      tenant,
      actorOf(req),
      dto.payer_email,
    );
  }

  /** Cancela no fim do período pago (plano sem período: na hora). Devolve a visão atualizada. */
  @Post('cancel')
  @HttpCode(200)
  async cancel(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: StoreCancelSubscriptionDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.subscriptions.cancelForStore(tenant, dto.reason, actorOf(req));
    return this.queries.storeOverview(tenant);
  }

  /** Desfaz o cancelamento agendado. Devolve a visão atualizada. */
  @Post('resume')
  @HttpCode(200)
  async resume(
    @CurrentTenant() tenant: TenantContext,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.subscriptions.resumeForStore(tenant, actorOf(req));
    return this.queries.storeOverview(tenant);
  }
}

/** Planos à venda (página pública de planos e autoatendimento): só campos comerciais. */
@ApiTags('Planos')
@Controller('plans')
export class PublicPlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  list() {
    return this.plans.listPublic();
  }
}
