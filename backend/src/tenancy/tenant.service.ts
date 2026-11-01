import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import type { AuthUser } from '../auth/auth-user';
import {
  Subscription,
  SubscriptionStatus,
} from '../billing/entities/subscription.entity';
import {
  PLATFORM_SETTINGS_ID,
  PlatformSettings,
} from '../platform/entities/platform-settings.entity';
import { Store } from '../store/entities/store.entity';
import { isStaffRole } from '../orders/order-rules';
import {
  STORE_UNAVAILABLE_MESSAGE,
  capabilityDeniedMessage,
  hasCapability,
  storeAccessState,
  type StoreCapability,
} from './store-access';
import type { TenantContext } from './tenant-context';

export const STORE_NOT_FOUND_MESSAGE = 'Loja não encontrada.';
export const NO_DEFAULT_STORE_MESSAGE =
  'Nenhuma loja está configurada nesta plataforma ainda.';

/** Slug da URL: minúsculas, números e hífens (3 a 60 caracteres). */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;

export function isValidStoreSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SLUG_PATTERN.test(slug);
}

/**
 * DEFAULT_STORE_SLUG do ambiente (sem espaços, em minúsculas) ou null. Enquanto definido, ele decide a
 * loja padrão a cada requisição; por isso o autoatendimento nunca o aceita como endereço de loja nova.
 */
export function configuredDefaultStoreSlug(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return env.DEFAULT_STORE_SLUG?.trim().toLowerCase() || null;
}

/**
 * Resolução centralizada do tenant. Nenhum serviço deve descobrir "qual loja" por conta própria:
 * a equipe recebe a loja pelo StoreStaffGuard, a vitrine pelo PublicStoreGuard, e os serviços
 * recebem o storeId já validado como parâmetro explícito de cada consulta.
 */
@Injectable()
export class TenantService {
  constructor(
    @InjectRepository(Store)
    private readonly stores: Repository<Store>,
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    @InjectRepository(PlatformSettings)
    private readonly settings: Repository<PlatformSettings>,
  ) {}

  findStoreById(id: number): Promise<Store | null> {
    return this.stores.findOne({ where: { id } });
  }

  findStoreBySlug(slug: string): Promise<Store | null> {
    if (!isValidStoreSlug(slug)) return Promise.resolve(null);
    return this.stores.findOne({ where: { slug } });
  }

  /**
   * Loja padrão das rotas antigas sem slug (/products, /store/status, /orders...), usadas pelo app
   * mobile e por integrações da versão de loja única: DEFAULT_STORE_SLUG (se definido) ou a loja
   * escolhida no superpainel (platform_settings.default_store_id, preenchida pela migração da loja
   * inicial ou pelo seed de demonstração). Sem nenhuma das duas, não há loja padrão (falha fechada).
   */
  async defaultStore(): Promise<Store | null> {
    const configured = configuredDefaultStoreSlug();
    if (configured) return this.findStoreBySlug(configured);

    const settings = await this.settings.findOne({
      where: { id: PLATFORM_SETTINGS_ID },
      select: { id: true, default_store_id: true },
    });
    return settings?.default_store_id
      ? this.findStoreById(settings.default_store_id)
      : null;
  }

  /** Assinatura vigente (não cancelada) ou, se não houver, a última cancelada. */
  async currentSubscription(storeId: number): Promise<Subscription | null> {
    const current = await this.subscriptions.findOne({
      where: { store_id: storeId, status: Not(SubscriptionStatus.CANCELED) },
      relations: { plan: true },
      order: { id: 'DESC' },
    });
    if (current) return current;
    return this.subscriptions.findOne({
      where: { store_id: storeId },
      relations: { plan: true },
      order: { id: 'DESC' },
    });
  }

  async contextFor(store: Store): Promise<TenantContext> {
    const subscription = await this.currentSubscription(store.id);
    return {
      storeId: store.id,
      store,
      subscription,
      access: storeAccessState(store, subscription),
    };
  }

  async contextForStoreId(storeId: number): Promise<TenantContext> {
    const store = await this.findStoreById(storeId);
    if (!store) throw new NotFoundException(STORE_NOT_FOUND_MESSAGE);
    return this.contextFor(store);
  }

  /**
   * Loja da vitrine: pelo slug (quando a rota tem :storeSlug) ou a loja padrão.
   * Inexistente ou desativada → 404 (a loja desativada não aparece para o público).
   */
  async publicContext(slug?: string | null): Promise<TenantContext> {
    const store =
      slug === undefined || slug === null
        ? await this.defaultStore()
        : await this.findStoreBySlug(slug);
    if (!store) {
      throw new NotFoundException(
        slug === undefined || slug === null
          ? NO_DEFAULT_STORE_MESSAGE
          : STORE_NOT_FOUND_MESSAGE,
      );
    }
    const context = await this.contextFor(store);
    if (!context.access.publicVisible) {
      throw new NotFoundException(STORE_NOT_FOUND_MESSAGE);
    }
    return context;
  }

  /**
   * Contexto da equipe autenticada (inclusive sessão de suporte) com a capacidade exigida.
   * Usuário sem loja (cliente ou superadmin fora de sessão de suporte) → 403.
   */
  async staffContext(
    user: AuthUser,
    capability: StoreCapability,
  ): Promise<TenantContext> {
    if (!user.storeId || !isStaffRole(user.role)) {
      throw new ForbiddenException(
        'Esta área é exclusiva da equipe de uma loja.',
      );
    }
    const context = await this.contextForStoreId(user.storeId);
    this.assertCapability(context, capability);
    return context;
  }

  assertCapability(context: TenantContext, capability: StoreCapability): void {
    if (!hasCapability(context.access, capability)) {
      throw new ForbiddenException(
        capabilityDeniedMessage(context.access, capability),
      );
    }
  }

  /**
   * Compra na vitrine (orçamento, pedido, pagamento): só em loja que pode vender. O cliente recebe a
   * mesma mensagem genérica do perfil público (unavailable_message): o motivo (suspensão com o texto
   * do superadmin, cobrança da assinatura) é assunto da loja com a plataforma e aparece só para a
   * equipe (access.message no painel).
   */
  assertCanSell(context: TenantContext): void {
    if (!context.access.canSell) {
      throw new ForbiddenException(STORE_UNAVAILABLE_MESSAGE);
    }
  }
}
