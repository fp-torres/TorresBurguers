import {
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type EntityManager, MoreThanOrEqual, Not, Repository } from 'typeorm';
import {
  registerStoreStorageLimits,
  unregisterStoreStorageLimits,
  type StoreStorageLimit,
  type StoreStorageLimitProvider,
} from '../common/uploads/storage-quota';
import {
  storeStorageUsage,
  type StoreStorageUsage,
} from '../common/uploads/storage-usage';
import { Order } from '../orders/entities/order.entity';
import { OrderStatus } from '../orders/order.enums';
import { dateKeyInZone, startOfDayInZone } from '../orders/order-rules';
import { Product } from '../products/entities/product.entity';
import { Store } from '../store/entities/store.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { advisoryXactLock } from './advisory-lock';
import { Plan } from './entities/plan.entity';
import {
  Subscription,
  SubscriptionStatus,
} from './entities/subscription.entity';
import {
  FEATURE_LABELS,
  PLAN_LIMIT_COLUMN,
  PLAN_LIMIT_LABEL,
  type PlanFeatureKey,
  type PlanLimitKey,
  type PlanUsage,
} from './plan-rules';

// Metadados movidos para plan-rules.ts (sem Nest/banco); reexportados para manter os imports antigos
export { FEATURE_LABELS };
export type { PlanFeatureKey, PlanLimitKey, PlanUsage };

/**
 * Instante (UTC) da meia-noite do dia 1 do mês atual no fuso da loja. Usa os formatadores em cache
 * por fuso de orders/order-rules.ts (criar um Intl.DateTimeFormat por chamada custa ~100 µs).
 * Fuso inválido → America/Sao_Paulo.
 */
export function startOfMonthInZone(now: Date, timeZone: string): Date {
  let zone = timeZone;
  let today: string;
  try {
    today = dateKeyInZone(now, zone);
  } catch {
    zone = 'America/Sao_Paulo';
    today = dateKeyInZone(now, zone);
  }
  return startOfDayInZone(`${today.slice(0, 8)}01`, zone);
}

/**
 * Limites e recursos do plano da loja. Planos com limite nulo são ilimitados.
 * Loja sem assinatura vigente não ganha nada (fail closed).
 *
 * Armazenamento (max_storage_mb): o uso é medido na pasta de uploads (common/uploads/storage-usage.ts) e a
 * cota é conferida antes de gravar cada imagem da loja (OptimizeImagePipe). Este serviço informa o limite
 * do plano a essa conferência (registerStoreStorageLimits, na subida da API).
 */
@Injectable()
export class PlanLimitsService
  implements StoreStorageLimitProvider, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PlanLimitsService.name);

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Product)
    private readonly products: Repository<Product>,
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
    @InjectRepository(Store)
    private readonly stores: Repository<Store>,
  ) {}

  onModuleInit(): void {
    registerStoreStorageLimits(this);
  }

  onModuleDestroy(): void {
    unregisterStoreStorageLimits(this);
  }

  /**
   * Limite de armazenamento do plano vigente (conferido antes de gravar as imagens da loja).
   * null = sem limite: plano ilimitado ou loja sem assinatura vigente (a situação da loja já bloqueia as
   * alterações do painel; a cota não recusa por isso).
   */
  async storageLimit(storeId: number): Promise<StoreStorageLimit | null> {
    const plan = await this.currentPlan(storeId);
    const limitMb = plan?.max_storage_mb;
    if (!plan || limitMb === null || limitMb === undefined) return null;
    return { planName: plan.name, limitMb };
  }

  /**
   * Uso de armazenamento da loja (arquivos s<storeId>- da pasta de uploads, com cache de alguns minutos).
   * null se a pasta não pôde ser lida (as telas mostram o uso como indisponível; nada falha por isso).
   */
  async storageUsage(storeId: number): Promise<StoreStorageUsage | null> {
    try {
      return await storeStorageUsage.usage(storeId);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      this.logger.warn(
        `Não foi possível medir o armazenamento da loja ${storeId}${code ? ` (${code})` : ''}.`,
      );
      return null;
    }
  }

  /** Repositórios da consulta: os da transação de quem chama, quando houver. */
  private repos(manager?: EntityManager) {
    if (!manager) {
      return {
        subscriptions: this.subscriptions,
        users: this.users,
        products: this.products,
        orders: this.orders,
        stores: this.stores,
      };
    }
    return {
      subscriptions: manager.getRepository(Subscription),
      users: manager.getRepository(User),
      products: manager.getRepository(Product),
      orders: manager.getRepository(Order),
      stores: manager.getRepository(Store),
    };
  }

  /** Plano da assinatura vigente (não cancelada), ou null. */
  async currentPlan(
    storeId: number,
    manager?: EntityManager,
  ): Promise<Plan | null> {
    const subscription = await this.repos(manager).subscriptions.findOne({
      where: { store_id: storeId, status: Not(SubscriptionStatus.CANCELED) },
      relations: { plan: true },
      order: { id: 'DESC' },
    });
    return subscription?.plan ?? null;
  }

  async usage(
    storeId: number,
    now: Date = new Date(),
    manager?: EntityManager,
  ): Promise<PlanUsage> {
    const repos = this.repos(manager);
    const store = await repos.stores.findOne({
      where: { id: storeId },
      select: { id: true, time_zone: true },
    });
    const monthStart = startOfMonthInZone(
      now,
      store?.time_zone ?? 'America/Sao_Paulo',
    );
    const [staff_users, products, monthly_orders] = await Promise.all([
      // Equipe ativa (a lixeira não conta)
      repos.users.count({
        where: { store_id: storeId, role: Not(UserRole.CLIENT) },
      }),
      // Cardápio fora da lixeira (inclusive indisponíveis)
      repos.products.count({ where: { store_id: storeId } }),
      repos.orders.count({
        where: {
          store_id: storeId,
          status: Not(OrderStatus.CANCELED),
          created_at: MoreThanOrEqual(monthStart),
        },
      }),
    ]);
    return { staff_users, products, monthly_orders };
  }

  /**
   * 403 se adicionar `adding` itens passaria do limite do plano. Sozinho é só uma conferência (aviso
   * antecipado): requisições simultâneas leem o mesmo uso. Para um limite rígido, confira e grave com
   * withinLimit (ou lockAndAssert na transação de quem grava).
   */
  async assertWithinLimit(
    storeId: number,
    key: PlanLimitKey,
    adding = 1,
    manager?: EntityManager,
  ): Promise<void> {
    const plan = await this.requirePlan(storeId, manager);
    const limit = plan[PLAN_LIMIT_COLUMN[key]];
    if (limit === null || limit === undefined) return;

    const used = (await this.usage(storeId, new Date(), manager))[key];
    if (used + adding > limit) {
      throw new ForbiddenException(
        `Limite do plano ${plan.name} atingido: ${limit} ${PLAN_LIMIT_LABEL[key]}. ` +
          'Fale com a administração da plataforma para mudar de plano.',
      );
    }
  }

  /**
   * Na transação de quem vai gravar: trava consultiva por loja e limite (solta no fim da transação) e
   * só então confere o uso, contando na própria transação. Uma requisição simultânea da mesma loja espera
   * esta gravar e terminar e conta de novo: o limite não é ultrapassado numa rajada paralela. A espera
   * tem teto (ADVISORY_LOCK_WAIT_MS, depois 409): quem espera ocupa uma conexão do pool.
   */
  async lockAndAssert(
    manager: EntityManager,
    storeId: number,
    key: PlanLimitKey,
    adding = 1,
  ): Promise<void> {
    await advisoryXactLock(manager, `plan-limit:${storeId}:${key}`);
    await this.assertWithinLimit(storeId, key, adding, manager);
  }

  /**
   * Confere o limite e grava numa transação só (lockAndAssert + `work`, que grava com o manager
   * recebido). Recusa → 403 e nada é gravado.
   */
  async withinLimit<T>(
    storeId: number,
    key: PlanLimitKey,
    work: (manager: EntityManager) => Promise<T>,
    adding = 1,
  ): Promise<T> {
    return this.stores.manager.transaction(async (manager) => {
      await this.lockAndAssert(manager, storeId, key, adding);
      return work(manager);
    });
  }

  async hasFeature(storeId: number, feature: PlanFeatureKey): Promise<boolean> {
    const plan = await this.currentPlan(storeId);
    return plan?.features?.[feature] === true;
  }

  /** 403 se o plano da loja não inclui o recurso. */
  async assertFeature(storeId: number, feature: PlanFeatureKey): Promise<void> {
    const plan = await this.requirePlan(storeId);
    if (plan.features?.[feature] !== true) {
      throw new ForbiddenException(
        `O plano ${plan.name} não inclui ${FEATURE_LABELS[feature]}.`,
      );
    }
  }

  private async requirePlan(
    storeId: number,
    manager?: EntityManager,
  ): Promise<Plan> {
    const plan = await this.currentPlan(storeId, manager);
    if (!plan) {
      throw new ForbiddenException(
        'A loja não tem uma assinatura ativa. Fale com a administração da plataforma.',
      );
    }
    return plan;
  }
}
