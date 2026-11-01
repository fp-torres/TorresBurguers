import { Global, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditService } from '../audit/audit.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { Order } from '../orders/entities/order.entity';
import { PlatformSettings } from '../platform/entities/platform-settings.entity';
import { Product } from '../products/entities/product.entity';
import { Store } from '../store/entities/store.entity';
import { TenantService } from '../tenancy/tenant.service';
import { User } from '../users/entities/user.entity';
import { BillingQueriesService } from './billing-queries.service';
import { BillingWebhookService } from './billing-webhook.service';
import { BillingModule } from './billing.module';
import { BillingWebhookEvent } from './entities/billing-webhook-event.entity';
import { Plan } from './entities/plan.entity';
import { SubscriptionEvent } from './entities/subscription-event.entity';
import { SubscriptionInvoice } from './entities/subscription-invoice.entity';
import { Subscription } from './entities/subscription.entity';
import { PlanLimitsService } from './plan-limits.service';
import { PlansService } from './plans.service';
import { BillingProvidersService } from './providers/billing-providers.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { SubscriptionsService } from './subscriptions.service';

/** Serviços globais da aplicação (TenancyModule, AuditModule, SharedModule) substituídos por dublês. */
@Global()
@Module({
  providers: [
    { provide: TenantService, useValue: {} },
    { provide: AuditService, useValue: {} },
    { provide: RateLimitService, useValue: {} },
  ],
  exports: [TenantService, AuditService, RateLimitService],
})
class FakeGlobalsModule {}

const ENTITIES = [
  Plan,
  Subscription,
  SubscriptionEvent,
  SubscriptionInvoice,
  BillingWebhookEvent,
  PlatformSettings,
  Store,
  User,
  Product,
  Order,
];

describe('BillingModule (injeção de dependências)', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it('monta serviços, controllers e guards sem banco; a rotina para quando a aplicação fecha', async () => {
    let builder = Test.createTestingModule({
      imports: [FakeGlobalsModule, BillingModule],
    });
    for (const entity of ENTITIES) {
      builder = builder
        .overrideProvider(getRepositoryToken(entity))
        .useValue({ manager: {} });
    }
    const moduleRef = await builder.compile();

    for (const service of [
      PlanLimitsService,
      PlansService,
      SubscriptionsService,
      BillingQueriesService,
      BillingProvidersService,
      BillingWebhookService,
      SubscriptionLifecycleService,
    ]) {
      expect(moduleRef.get(service)).toBeInstanceOf(service);
    }

    jest.useFakeTimers();
    try {
      const app = moduleRef.createNestApplication();
      await app.init();
      // Timer da rotina de assinaturas ligado na subida...
      expect(jest.getTimerCount()).toBe(1);
      await app.close();
      // ...e desligado no fechamento (seed e testes não ficam presos)
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
