import { Global, Logger, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { PasswordResetToken } from '../auth/entities/password-reset-token.entity';
import { AccountEmailToken } from '../account/entities/account-email-token.entity';
import { SessionTokenService } from '../auth/session-token.service';
import { Plan } from '../billing/entities/plan.entity';
import { SubscriptionEvent } from '../billing/entities/subscription-event.entity';
import { SubscriptionInvoice } from '../billing/entities/subscription-invoice.entity';
import { Subscription } from '../billing/entities/subscription.entity';
import { PlanLimitsService } from '../billing/plan-limits.service';
import { SubscriptionsService } from '../billing/subscriptions.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { Invitation } from '../invitations/entities/invitation.entity';
import { MailService } from '../notifications/mail.service';
import { Order } from '../orders/entities/order.entity';
import { Store } from '../store/entities/store.entity';
import { TenantService } from '../tenancy/tenant.service';
import { User } from '../users/entities/user.entity';
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
import { PlatformModule } from './platform.module';
import { StoreSignupController } from './store-signup.controller';
import { StoreSignupService } from './store-signup.service';
import { SupportSessionsService } from './support-sessions.service';

/** Serviços globais da aplicação (Tenancy, Audit, Shared, Billing) substituídos por dublês. */
@Global()
@Module({
  providers: [
    { provide: TenantService, useValue: {} },
    { provide: AuditService, useValue: {} },
    { provide: RateLimitService, useValue: {} },
    { provide: MailService, useValue: {} },
    { provide: PlanLimitsService, useValue: {} },
    { provide: SubscriptionsService, useValue: {} },
  ],
  exports: [
    TenantService,
    AuditService,
    RateLimitService,
    MailService,
    PlanLimitsService,
    SubscriptionsService,
  ],
})
class FakeGlobalsModule {}

const ENTITIES = [
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
  PasswordResetToken,
  Invitation,
  AccountEmailToken,
];

describe('PlatformModule (injeção de dependências)', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it('monta serviços e controllers do superpainel e do autoatendimento sem banco', async () => {
    let builder = Test.createTestingModule({
      imports: [FakeGlobalsModule, PlatformModule],
    });
    for (const entity of ENTITIES) {
      builder = builder
        .overrideProvider(getRepositoryToken(entity))
        .useValue({ manager: {} });
    }
    const moduleRef = await builder.compile();

    for (const service of [
      PlatformAuditService,
      PlatformStoresService,
      SupportSessionsService,
      PlatformUsersService,
      PlatformInsightsService,
      PlatformSettingsService,
      StoreSignupService,
    ]) {
      expect(moduleRef.get(service)).toBeInstanceOf(service);
    }
    for (const controller of [
      PlatformStoresController,
      PlatformSupportSessionsController,
      PlatformUsersController,
      PlatformInsightsController,
      PlatformSettingsController,
      StoreSignupController,
    ]) {
      expect(moduleRef.get(controller)).toBeInstanceOf(controller);
    }
    // Token da sessão de suporte: o mesmo JwtService/SessionTokenService do login (via AuthModule)
    expect(moduleRef.get(JwtService, { strict: false })).toBeInstanceOf(
      JwtService,
    );
    expect(
      moduleRef.get(SessionTokenService, { strict: false }),
    ).toBeInstanceOf(SessionTokenService);

    const app = moduleRef.createNestApplication();
    await app.init();
    await app.close();
  });
});
