/**
 * Dados e serviços de teste da cobrança sobre o banco em memória (fake-db.helper-spec.ts).
 * Não é um teste: o nome termina em "-spec.ts" só para ficar fora do build.
 */
import { ConflictException } from '@nestjs/common';
import type { AuthUser } from '../../auth/auth-user';
import { PlatformSettings } from '../../platform/entities/platform-settings.entity';
import { Store, StoreAccountStatus } from '../../store/entities/store.entity';
import { PlatformRole, User, UserRole } from '../../users/entities/user.entity';
import { BillingWebhookEvent } from '../entities/billing-webhook-event.entity';
import { BillingInterval, Plan, PlanStatus } from '../entities/plan.entity';
import { SubscriptionEvent } from '../entities/subscription-event.entity';
import {
  InvoiceStatus,
  SubscriptionInvoice,
} from '../entities/subscription-invoice.entity';
import {
  Subscription,
  SubscriptionStatus,
} from '../entities/subscription.entity';
import type { PlanUsage } from '../plan-rules';
import { ONLINE_BILLING_UNAVAILABLE_MESSAGE } from '../providers/billing-provider';
import { SubscriptionsService } from '../subscriptions.service';
import { FakeDb, type Row } from './fake-db.helper-spec';

/** "Agora" padrão dos testes. */
export const NOW = new Date('2026-10-11T12:00:00.000Z');
export const DAY = 24 * 60 * 60 * 1000;
export const at = (iso: string) => new Date(iso);
export const days = (base: Date, count: number) =>
  new Date(base.getTime() + count * DAY);

export function createBillingDb(): FakeDb {
  const subscription = { table: 'subscriptions', column: 'subscription_id' };
  const store = { table: 'stores', column: 'store_id' };
  const plan = { table: 'plans', column: 'plan_id' };
  const db = new FakeDb([
    { entity: Store, name: 'stores', unique: [{ columns: ['slug'] }] },
    { entity: User, name: 'users' },
    {
      entity: PlatformSettings,
      name: 'platform_settings',
      createdColumns: [],
    },
    { entity: Plan, name: 'plans', unique: [{ columns: ['code'] }] },
    {
      entity: Subscription,
      name: 'subscriptions',
      relations: { plan, store },
      unique: [
        // Índice parcial UQ_subscriptions_store_current (migration)
        {
          columns: ['store_id'],
          where: (row: Row) => row.status !== SubscriptionStatus.CANCELED,
        },
        { columns: ['provider_subscription_id'] },
      ],
    },
    {
      entity: SubscriptionInvoice,
      name: 'subscription_invoices',
      relations: { subscription, store, plan },
      unique: [{ columns: ['provider_payment_id'] }],
    },
    {
      entity: SubscriptionEvent,
      name: 'subscription_events',
      relations: {
        subscription,
        store,
        actor: { table: 'users', column: 'actor_user_id' },
      },
      updatedColumn: null,
    },
    {
      entity: BillingWebhookEvent,
      name: 'billing_webhook_events',
      createdColumns: ['received_at'],
      updatedColumn: null,
      unique: [{ columns: ['provider', 'event_key'] }],
    },
  ]);
  db.now = () => NOW;
  return db;
}

export function seedStore(db: FakeDb, overrides: Partial<Store> = {}): Store {
  const id = overrides.id ?? db.nextId('stores');
  return db.seed('stores', {
    slug: `loja-${id}`,
    name: `Loja ${id}`,
    logo: null,
    account_status: StoreAccountStatus.ACTIVE,
    status_reason: null,
    time_zone: 'America/Sao_Paulo',
    // Nunca pode vazar nas respostas
    mp_access_token_encrypted: 'v1:segredo',
    ...overrides,
    id,
  }) as unknown as Store;
}

export function seedSettings(db: FakeDb, graceDays = 7): void {
  db.seed('platform_settings', {
    id: 1,
    default_store_id: null,
    grace_period_days: graceDays,
    support_session_minutes: 30,
    store_self_signup_enabled: false,
    self_signup_plan_id: null,
  });
}

export function seedPlan(db: FakeDb, overrides: Partial<Plan> = {}): Plan {
  const id = overrides.id ?? db.nextId('plans');
  return db.seed('plans', {
    code: `plano-${id}`,
    name: `Plano ${id}`,
    description: null,
    price: 99.9,
    currency: 'BRL',
    billing_interval: BillingInterval.MONTHLY,
    trial_days: 0,
    max_staff_users: null,
    max_products: null,
    max_monthly_orders: null,
    max_storage_mb: null,
    features: {
      online_payments: true,
      advanced_reports: false,
      custom_branding: false,
    },
    status: PlanStatus.ACTIVE,
    is_public: true,
    sort_order: 0,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
    id,
  }) as unknown as Plan;
}

export function seedSubscription(
  db: FakeDb,
  overrides: Partial<Subscription> & { store_id: number; plan_id: number },
): Subscription {
  return db.seed('subscriptions', {
    status: SubscriptionStatus.ACTIVE,
    trial_ends_at: null,
    current_period_start: days(NOW, -10),
    current_period_end: days(NOW, 20),
    cancel_at_period_end: false,
    cancel_scheduled_by: null,
    canceled_at: null,
    past_due_since: null,
    grace_period_ends_at: null,
    suspended_at: null,
    suspended_by: null,
    billing_provider: 'MANUAL',
    provider_subscription_id: null,
    provider_status: null,
    provider_checkout_url: null,
    created_at: days(NOW, -10),
    updated_at: days(NOW, -10),
    ...overrides,
  }) as unknown as Subscription;
}

export function seedInvoice(
  db: FakeDb,
  overrides: Partial<SubscriptionInvoice> & {
    subscription_id: number;
    store_id: number;
    plan_id: number;
  },
): SubscriptionInvoice {
  return db.seed('subscription_invoices', {
    amount: 99.9,
    currency: 'BRL',
    status: InvoiceStatus.OPEN,
    period_start: days(NOW, -10),
    period_end: days(NOW, 20),
    due_at: days(NOW, -10),
    paid_at: null,
    billing_provider: 'MANUAL',
    provider_payment_id: null,
    payment_method: null,
    notes: null,
    failure_reason: null,
    attempts: 0,
    created_at: days(NOW, -10),
    updated_at: days(NOW, -10),
    ...overrides,
  }) as unknown as SubscriptionInvoice;
}

export const SUPER_ADMIN: AuthUser = {
  id: 1,
  email: 'ops@comestra.com.br',
  role: UserRole.CLIENT,
  name: 'Operação',
  storeId: null,
  platformRole: PlatformRole.SUPER_ADMIN,
  supportSession: null,
};

export function storeAdmin(storeId: number, id = 100 + storeId): AuthUser {
  return {
    id,
    email: `admin@loja${storeId}.com`,
    role: UserRole.ADMIN,
    name: `Admin ${storeId}`,
    storeId,
    platformRole: null,
    supportSession: null,
  };
}

/** Uso atual da loja devolvido pelo PlanLimitsService falso. */
export const ZERO_USAGE: PlanUsage = {
  staff_users: 0,
  products: 0,
  monthly_orders: 0,
};

export function fakeProviders() {
  return {
    configuredCode: jest.fn(() => 'MANUAL' as const),
    onlineCheckoutAvailable: jest.fn(() => false),
    mercadoPago: jest.fn((): unknown => null),
    forCode: jest.fn((): unknown => null),
    checkoutProvider: jest.fn((): unknown => {
      throw new ConflictException(ONLINE_BILLING_UNAVAILABLE_MESSAGE);
    }),
  };
}

/** SubscriptionsService real sobre o banco em memória, com auditoria, limites e provedores falsos. */
export function createSubscriptionsService(db: FakeDb) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const planLimits = {
    usage: jest.fn().mockResolvedValue(ZERO_USAGE),
    // Armazenamento medido na pasta de uploads (null = não medido: não bloqueia a troca de plano)
    storageUsage: jest.fn().mockResolvedValue(null),
  };
  const providers = fakeProviders();
  const service = new SubscriptionsService(
    db.repository(Subscription) as never,
    db.repository(SubscriptionInvoice) as never,
    db.repository(SubscriptionEvent) as never,
    db.repository(PlatformSettings) as never,
    planLimits as never,
    providers as never,
    audit as never,
  );
  return { service, audit, planLimits, providers };
}

/** Linhas de uma tabela filtradas (atalho dos testes). */
export function rowsWhere(
  db: FakeDb,
  table: string,
  filter: (row: Row) => boolean = () => true,
): Row[] {
  return db.rows(table).filter(filter);
}

export function eventTypes(db: FakeDb, subscriptionId: number): string[] {
  return rowsWhere(
    db,
    'subscription_events',
    (row) => row.subscription_id === subscriptionId,
  ).map((row) => row.type as string);
}
