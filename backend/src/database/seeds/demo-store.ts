import { EntityManager, Not } from 'typeorm';
import {
  Plan,
  BillingInterval,
  PlanStatus,
} from '../../billing/entities/plan.entity';
import {
  Subscription,
  SubscriptionStatus,
} from '../../billing/entities/subscription.entity';
import { SubscriptionEvent } from '../../billing/entities/subscription-event.entity';
import {
  PLATFORM_SETTINGS_ID,
  PlatformSettings,
} from '../../platform/entities/platform-settings.entity';
import { Store, StoreAccountStatus } from '../../store/entities/store.entity';

/** Loja de demonstração criada em development/test quando o banco ainda não tem nenhuma loja. */
export const DEMO_STORE = {
  slug: 'demo',
  name: 'Lanchonete Demo',
  description: 'Loja de demonstração da plataforma.',
  phone: '21999999999',
  email: 'loja-demo@example.com',
  address_zip_code: '20040003',
  address_street: 'Av. Rio Branco',
  address_number: '156',
  address_complement: 'Loja B',
  address_neighborhood: 'Centro',
  address_city: 'Rio de Janeiro',
  address_state: 'RJ',
};

/** Plano interno da loja demo: sem cobrança, sem limites, indisponível para contratação. */
export const DEMO_PLAN_CODE = 'demo';

/**
 * Loja onde a equipe demo trabalha: a loja padrão (DEFAULT_STORE_SLUG ou platform_settings.default_store_id,
 * ex.: a loja inicial criada pela migration num banco que veio da versão de loja única), ou a loja não
 * desativada mais antiga, ou — num banco sem lojas — a loja demo, que vira a loja padrão.
 */
export async function ensureDemoStore(
  manager: EntityManager,
): Promise<{ store: Store; created: boolean }> {
  const configured = process.env.DEFAULT_STORE_SLUG?.trim().toLowerCase();
  const settings = await manager.findOne(PlatformSettings, {
    where: { id: PLATFORM_SETTINGS_ID },
  });
  const existing =
    (configured
      ? await manager.findOne(Store, { where: { slug: configured } })
      : null) ??
    (settings?.default_store_id
      ? await manager.findOne(Store, {
          where: { id: settings.default_store_id },
        })
      : null) ??
    (await manager.findOne(Store, {
      where: { account_status: Not(StoreAccountStatus.INACTIVE) },
      order: { id: 'ASC' },
    }));
  if (existing) {
    if (settings && !settings.default_store_id && !configured) {
      await manager.update(
        PlatformSettings,
        { id: PLATFORM_SETTINGS_ID },
        { default_store_id: existing.id },
      );
    }
    return { store: existing, created: false };
  }

  return manager.transaction(async (tx) => {
    let plan = await tx.findOne(Plan, { where: { code: DEMO_PLAN_CODE } });
    if (!plan) {
      plan = await tx.save(
        tx.create(Plan, {
          code: DEMO_PLAN_CODE,
          name: 'Plano demonstração',
          description:
            'Plano interno da loja de demonstração (development/test). Sem cobrança e sem limites.',
          price: 0,
          billing_interval: BillingInterval.MONTHLY,
          trial_days: 0,
          max_staff_users: null,
          max_products: null,
          max_monthly_orders: null,
          features: {
            online_payments: true,
            advanced_reports: true,
            custom_branding: true,
          },
          status: PlanStatus.INACTIVE,
          is_public: false,
          sort_order: 999,
        }),
      );
    }

    const store = await tx.save(
      tx.create(Store, {
        ...DEMO_STORE,
        account_status: StoreAccountStatus.ACTIVE,
        is_open: true,
      }),
    );
    const subscription = await tx.save(
      tx.create(Subscription, {
        store_id: store.id,
        plan_id: plan.id,
        status: SubscriptionStatus.ACTIVE,
        current_period_start: new Date(),
        billing_provider: 'MANUAL',
      }),
    );
    await tx.save(
      tx.create(SubscriptionEvent, {
        subscription_id: subscription.id,
        store_id: store.id,
        type: 'CREATED',
        to_status: SubscriptionStatus.ACTIVE,
        to_plan_id: plan.id,
        reason: 'Loja de demonstração (seed de development/test)',
      }),
    );
    if (settings && !settings.default_store_id) {
      await tx.update(
        PlatformSettings,
        { id: PLATFORM_SETTINGS_ID },
        { default_store_id: store.id },
      );
    }
    return { store, created: true };
  });
}
