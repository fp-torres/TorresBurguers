import type { Request } from 'express';
import type { AuthUser } from '../auth/auth-user';
import type { Subscription } from '../billing/entities/subscription.entity';
import type { Store } from '../store/entities/store.entity';
import type { StoreAccessState } from './store-access';

/**
 * Loja em que a requisição atua, resolvida SEMPRE no servidor:
 * - painel da equipe: a loja do usuário autenticado (users.store_id, recarregado a cada requisição);
 * - vitrine/compra: a loja do slug da URL (/stores/:storeSlug/...) ou a loja padrão nas rotas antigas.
 */
export interface TenantContext {
  storeId: number;
  store: Store;
  /** Assinatura vigente (não cancelada) ou a última cancelada; null se nunca houve. */
  subscription: Subscription | null;
  access: StoreAccessState;
}

export type TenantRequest = Request & {
  user?: AuthUser | null;
  /** Preenchido pelo StoreStaffGuard (painel da equipe). */
  tenant?: TenantContext;
  /** Preenchido pelo PublicStoreGuard (vitrine e compra). */
  publicStore?: TenantContext;
};
