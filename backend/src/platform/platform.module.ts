import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { AuthModule } from '../auth/auth.module';
import { Plan } from '../billing/entities/plan.entity';
import { SubscriptionEvent } from '../billing/entities/subscription-event.entity';
import { SubscriptionInvoice } from '../billing/entities/subscription-invoice.entity';
import { Subscription } from '../billing/entities/subscription.entity';
import { InvitationsModule } from '../invitations/invitations.module';
import { Order } from '../orders/entities/order.entity';
import { Store } from '../store/entities/store.entity';
import { User } from '../users/entities/user.entity';
import { UsersModule } from '../users/users.module';
import { PlatformSettings } from './entities/platform-settings.entity';
import { SupportSession } from './entities/support-session.entity';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformInsightsController } from './platform-insights.controller';
import { PlatformInsightsService } from './platform-insights.service';
import { PlatformSettingsController } from './platform-settings.controller';
import { PlatformSettingsService } from './platform-settings.service';
import { PlatformStoresController } from './platform-stores.controller';
import { PlatformStoresService } from './platform-stores.service';
import { PlatformSupportSessionsController } from './platform-support-sessions.controller';
import { PlatformUsersController } from './platform-users.controller';
import { PlatformUsersService } from './platform-users.service';
import { StoreSignupController } from './store-signup.controller';
import { StoreSignupService } from './store-signup.service';
import { SupportSessionsService } from './support-sessions.service';

/**
 * Superpainel da Comestra (somente SUPER_ADMIN fora de sessão de suporte, via @PlatformRoute() em
 * todos os controllers de /platform): estabelecimentos, sessões de suporte, usuários e eventos de
 * autenticação, dashboard, financeiro, auditoria e configurações globais. Também o autoatendimento
 * público de lojas (POST /stores/signup).
 *
 * Planos, assinaturas e faturas (/platform/plans, /platform/subscriptions, /platform/invoices,
 * POST /platform/stores/:id/subscription) ficam no BillingModule; a manutenção de imagens
 * (/platform/maintenance/optimize-images), no CommonModule.
 *
 * Globais usados aqui: TenancyModule (TenantService, PlatformAdminGuard), AuditModule (AuditService),
 * SharedModule (RateLimitService) e BillingModule (SubscriptionsService, PlanLimitsService).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      PlatformSettings,
      SupportSession,
      Store,
      User,
      Order,
      AuditLog,
      Plan,
      Subscription,
      SubscriptionEvent,
      SubscriptionInvoice,
    ]),
    // PasswordResetService e, reexportados, SessionTokenService + JwtService (token da sessão de suporte)
    AuthModule,
    // UsersService: bloqueio, sessões, conta do dono no autoatendimento
    UsersModule,
    // InvitationsService: convite do responsável e convites da equipe pelo superpainel
    InvitationsModule,
  ],
  controllers: [
    PlatformStoresController,
    PlatformSupportSessionsController,
    PlatformUsersController,
    PlatformInsightsController,
    PlatformSettingsController,
    StoreSignupController,
  ],
  providers: [
    PlatformAuditService,
    PlatformStoresService,
    SupportSessionsService,
    PlatformUsersService,
    PlatformInsightsService,
    PlatformSettingsService,
    StoreSignupService,
  ],
})
export class PlatformModule {}
