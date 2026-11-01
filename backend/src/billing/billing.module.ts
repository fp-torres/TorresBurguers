import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from '../orders/entities/order.entity';
import { PlatformSettings } from '../platform/entities/platform-settings.entity';
import { Product } from '../products/entities/product.entity';
import { Store } from '../store/entities/store.entity';
import { User } from '../users/entities/user.entity';
import { BillingQueriesService } from './billing-queries.service';
import { BillingWebhookController } from './billing-webhook.controller';
import { BillingWebhookService } from './billing-webhook.service';
import { BillingWebhookEvent } from './entities/billing-webhook-event.entity';
import { Plan } from './entities/plan.entity';
import { SubscriptionEvent } from './entities/subscription-event.entity';
import { SubscriptionInvoice } from './entities/subscription-invoice.entity';
import { Subscription } from './entities/subscription.entity';
import { PlanLimitsService } from './plan-limits.service';
import { PlansService } from './plans.service';
import { PlatformBillingController } from './platform-billing.controller';
import { BillingProvidersService } from './providers/billing-providers.service';
import {
  PublicPlansController,
  StoreSubscriptionController,
} from './store-subscription.controller';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { SubscriptionsService } from './subscriptions.service';

/**
 * Cobrança SaaS da plataforma (loja → Comestra): planos, assinaturas, faturas, limites dos planos,
 * rotina de cobrança e notificações do provedor. Totalmente separada dos pagamentos do delivery
 * (módulo payment): outras tabelas, outra credencial (MP_SAAS_*) e outro webhook.
 * Global: catálogo, equipe e pedidos consultam os limites do plano (PlanLimitsService); o superpainel
 * de lojas e o autoatendimento criam assinaturas (SubscriptionsService.createForStore).
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
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
    ]),
  ],
  controllers: [
    PublicPlansController,
    StoreSubscriptionController,
    PlatformBillingController,
    BillingWebhookController,
  ],
  providers: [
    PlanLimitsService,
    PlansService,
    SubscriptionsService,
    BillingQueriesService,
    BillingProvidersService,
    BillingWebhookService,
    SubscriptionLifecycleService,
  ],
  exports: [
    PlanLimitsService,
    PlansService,
    SubscriptionsService,
    BillingQueriesService,
    BillingProvidersService,
  ],
})
export class BillingModule {}
