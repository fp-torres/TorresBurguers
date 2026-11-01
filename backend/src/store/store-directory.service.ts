import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import {
  Subscription,
  SubscriptionStatus,
} from '../billing/entities/subscription.entity';
import { readFileSync } from 'fs';
import {
  deliveryZonesMissing,
  outsideZonesPolicy,
  resolveDeliveryZones,
  takeoutEstimateFor,
  type DeliveryZonesConfig,
} from '../orders/order-rules';
import {
  STORE_UNAVAILABLE_MESSAGE,
  storeAccessState,
} from '../tenancy/store-access';
import type { TenantContext } from '../tenancy/tenant-context';
import { TenantService } from '../tenancy/tenant.service';
import {
  likeContains,
  pageRequest,
  type StoreListQueryDto,
} from './dto/store-list-query.dto';
import { Store, StoreAccountStatus } from './entities/store.entity';
import {
  presentPublicStore,
  type Paginated,
  type PublicStoreView,
  type StoreDirectoryItem,
} from './store-presenter';
import {
  credentialEnvironmentOf,
  featuresOf,
  onlinePaymentsEnabled,
  platformPublicKey,
} from './store-rules';
import { StoreService } from './store.service';

interface DirectoryRow {
  slug: string;
  name: string;
  description: string | null;
  logo: string | null;
  primary_color: string | null;
  address_city: string | null;
  address_state: string | null;
  is_open: boolean;
  account_status: StoreAccountStatus;
  subscription_status: SubscriptionStatus;
  cancel_at_period_end: boolean;
  current_period_end: Date | string | null;
  grace_period_ends_at: Date | string | null;
}

/**
 * Vitrine pública da plataforma: diretório das lojas que estão vendendo e o perfil público de cada
 * loja. Só campos públicos (nunca documento, responsável, motivo de suspensão ou credenciais privadas).
 */
@Injectable()
export class StoreDirectoryService {
  private readonly logger = new Logger(StoreDirectoryService.name);
  /** Zonas da plataforma (DELIVERY_ZONES_*), lidas na primeira vez que a loja padrão sem zonas próprias aparece. */
  private platformZones?: DeliveryZonesConfig;

  constructor(
    @InjectRepository(Store)
    private readonly stores: Repository<Store>,
    private readonly tenants: TenantService,
    private readonly storeService: StoreService,
  ) {}

  private platformDeliveryZones(): DeliveryZonesConfig {
    this.platformZones ??= resolveDeliveryZones(process.env, (path) =>
      readFileSync(path, 'utf8'),
    ).config;
    return this.platformZones;
  }

  /**
   * GET /stores: lojas ativas na plataforma com assinatura que permite vender — o mesmo critério de
   * storeAccessState(...).canSell, escrito em SQL para paginar no banco (e conferido de novo aqui).
   */
  async list(
    query: StoreListQueryDto,
    now: Date = new Date(),
  ): Promise<Paginated<StoreDirectoryItem>> {
    const { search, page, pageSize, offset } = pageRequest(query);

    const qb = this.stores
      .createQueryBuilder('store')
      // No máximo uma assinatura não cancelada por loja (índice único parcial)
      .innerJoin(
        Subscription,
        'sub',
        'sub.store_id = store.id AND sub.status <> :canceled',
        { canceled: SubscriptionStatus.CANCELED },
      )
      .where('store.account_status = :active', {
        active: StoreAccountStatus.ACTIVE,
      })
      .andWhere(
        new Brackets((selling) => {
          selling
            // Em teste ou ativa, salvo cancelamento agendado que já passou do fim do período
            .where(
              new Brackets((current) => {
                current
                  .where('sub.status IN (:...currentStatuses)', {
                    currentStatuses: [
                      SubscriptionStatus.TRIALING,
                      SubscriptionStatus.ACTIVE,
                    ],
                  })
                  .andWhere(
                    'NOT (sub.cancel_at_period_end = true AND sub.current_period_end IS NOT NULL AND sub.current_period_end <= :now)',
                  );
              }),
            )
            // Inadimplente ainda dentro da tolerância
            .orWhere(
              new Brackets((pastDue) => {
                pastDue
                  .where('sub.status = :pastDue', {
                    pastDue: SubscriptionStatus.PAST_DUE,
                  })
                  .andWhere(
                    '(sub.grace_period_ends_at IS NULL OR sub.grace_period_ends_at > :now)',
                  );
              }),
            );
        }),
      )
      .setParameter('now', now);

    if (search) {
      qb.andWhere(
        new Brackets((match) => {
          match
            .where('store.name ILIKE :term')
            .orWhere('store.slug ILIKE :term')
            .orWhere('store.description ILIKE :term')
            .orWhere('store.address_city ILIKE :term')
            .orWhere('store.address_neighborhood ILIKE :term');
        }),
        { term: likeContains(search) },
      );
    }

    const [total, rows] = await Promise.all([
      qb.getCount(),
      qb
        .clone()
        .select('store.slug', 'slug')
        .addSelect('store.name', 'name')
        .addSelect('store.description', 'description')
        .addSelect('store.logo', 'logo')
        .addSelect('store.primary_color', 'primary_color')
        .addSelect('store.address_city', 'address_city')
        .addSelect('store.address_state', 'address_state')
        .addSelect('store.is_open', 'is_open')
        .addSelect('store.account_status', 'account_status')
        .addSelect('sub.status', 'subscription_status')
        .addSelect('sub.cancel_at_period_end', 'cancel_at_period_end')
        .addSelect('sub.current_period_end', 'current_period_end')
        .addSelect('sub.grace_period_ends_at', 'grace_period_ends_at')
        .orderBy('store.is_open', 'DESC')
        .addOrderBy('LOWER(store.name)', 'ASC')
        .addOrderBy('store.id', 'ASC')
        .offset(offset)
        .limit(pageSize)
        .getRawMany<DirectoryRow>(),
    ]);

    const items = rows
      .filter((row) => {
        const canSell = storeAccessState(
          { account_status: row.account_status },
          {
            status: row.subscription_status,
            cancel_at_period_end: row.cancel_at_period_end,
            current_period_end: row.current_period_end,
            grace_period_ends_at: row.grace_period_ends_at,
          },
          now,
        ).canSell;
        if (!canSell) {
          this.logger.warn(
            `Loja "${row.slug}" saiu do diretório: o filtro SQL divergiu de storeAccessState.`,
          );
        }
        return canSell;
      })
      .map(
        (row): StoreDirectoryItem => ({
          slug: row.slug,
          name: row.name,
          description: row.description ?? null,
          logo: row.logo ?? null,
          primary_color: row.primary_color ?? null,
          address_city: row.address_city ?? null,
          address_state: row.address_state ?? null,
          is_open: row.is_open === true,
        }),
      );

    return { items, total, page, pageSize };
  }

  /** GET /stores/default: perfil da loja padrão (404 se não houver ou se estiver desativada). */
  async defaultProfile(): Promise<PublicStoreView> {
    const context = await this.tenants.publicContext(null);
    return this.profile(context, { isDefaultStore: true });
  }

  /**
   * Perfil público da loja já resolvida pelo PublicStoreGuard (inexistente/desativada = 404 antes daqui).
   * Pagamento online: recurso do plano + credencial utilizável (da loja; do ambiente, só na loja padrão;
   * ou o sandbox de development/test).
   */
  async profile(
    context: TenantContext,
    hints: { isDefaultStore?: boolean } = {},
  ): Promise<PublicStoreView> {
    const { store, access, subscription } = context;
    const hasCredentials = await this.storeService.hasOwnPaymentCredentials(
      store.id,
    );
    // Ser a loja padrão só importa sem credencial própria (aí valem as do ambiente) ou sem zonas de
    // entrega próprias (aí valem as da plataforma — só para ela)
    const zonesMissing =
      store.delivery_zones === null || store.delivery_zones === undefined;
    const isDefault =
      hints.isDefaultStore ??
      (hasCredentials && !zonesMissing
        ? false
        : await this.storeService.isDefaultStore(store.id));

    const features = featuresOf(subscription);
    const usesPlatformKey = isDefault && !hasCredentials;
    // Política para endereços fora das zonas: a das zonas próprias ou, na loja padrão sem elas, a da plataforma
    const zones = zonesMissing
      ? isDefault
        ? this.platformDeliveryZones()
        : null
      : store.delivery_zones;
    return presentPublicStore(store, {
      delivery_enabled:
        store.delivery_enabled === true &&
        !deliveryZonesMissing(store, isDefault),
      delivers_outside_zones: outsideZonesPolicy(zones) !== 'refuse',
      takeout_estimate: takeoutEstimateFor(store.takeout_estimate).time,
      ordering_available: access.canSell,
      // Mensagem genérica: o motivo de uma suspensão é assunto da loja com a plataforma
      unavailable_message: access.canSell ? null : STORE_UNAVAILABLE_MESSAGE,
      payments: {
        online_enabled: onlinePaymentsEnabled({
          planAllows: features.online_payments,
          // A chave pública e o token são gravados juntos e do mesmo tipo (PUT /store/settings/payments):
          // o prefixo da chave pública indica o ambiente sem decifrar o token
          storeCredential: hasCredentials
            ? (credentialEnvironmentOf(store.mp_public_key) ?? 'PRODUCTION')
            : null,
          isDefaultStore: isDefault,
        }),
        mp_public_key:
          store.mp_public_key ??
          (usesPlatformKey ? platformPublicKey(process.env) : null),
      },
    });
  }
}
