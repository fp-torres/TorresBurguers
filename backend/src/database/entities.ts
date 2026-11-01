import { Address } from '../addresses/entities/address.entity';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { AccountEmailToken } from '../account/entities/account-email-token.entity';
import { AuthSession } from '../auth/entities/auth-session.entity';
import { PasswordResetToken } from '../auth/entities/password-reset-token.entity';
import { BillingWebhookEvent } from '../billing/entities/billing-webhook-event.entity';
import { Plan } from '../billing/entities/plan.entity';
import { SubscriptionEvent } from '../billing/entities/subscription-event.entity';
import { SubscriptionInvoice } from '../billing/entities/subscription-invoice.entity';
import { Subscription } from '../billing/entities/subscription.entity';
import { MaintenanceJob } from '../common/entities/maintenance-job.entity';
import { Invitation } from '../invitations/entities/invitation.entity';
import { Order } from '../orders/entities/order.entity';
import { OrderItem } from '../orders/entities/order-item.entity';
import { Payment } from '../payment/entities/payment.entity';
import { PlatformSettings } from '../platform/entities/platform-settings.entity';
import { SupportSession } from '../platform/entities/support-session.entity';
import { Addon } from '../products/entities/addon.entity';
import { Product } from '../products/entities/product.entity';
import { Store } from '../store/entities/store.entity';
import { StoreCustomerBlock } from '../store/entities/store-customer-block.entity';
import { StoreSlugHistory } from '../store/entities/store-slug-history.entity';
import { User } from '../users/entities/user.entity';

/**
 * Todas as entidades do banco. Lista única usada pela API (AppModule) e pelo CLI de migrations
 * (data-source.ts): o que não estiver aqui não entra nas migrations geradas.
 *
 * A antiga tabela store_config (loja única) foi migrada para stores e não tem mais entidade;
 * ela continua no banco, intocada, até ser removida manualmente (ver docs/saas).
 */
export const ENTITIES = [
  // Plataforma e tenants
  Store,
  Plan,
  Subscription,
  SubscriptionEvent,
  SubscriptionInvoice,
  BillingWebhookEvent,
  PlatformSettings,
  SupportSession,
  AuditLog,
  MaintenanceJob,
  // Identidade
  User,
  Address,
  Invitation,
  PasswordResetToken,
  AuthSession,
  AccountEmailToken,
  // Operação das lojas
  Product,
  Addon,
  Order,
  OrderItem,
  Payment,
  StoreCustomerBlock,
  StoreSlugHistory,
];
