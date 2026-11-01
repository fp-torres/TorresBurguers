// Tipos do modelo SaaS multi-tenant compartilhados entre sessão, painel da loja, superpainel e vitrine.
// Contratos: docs/saas/arquitetura.md (seções 3, 4 e 5).

/** Situação cadastral do estabelecimento (stores.account_status). */
export type StoreAccountStatus = 'ACTIVE' | 'SUSPENDED' | 'INACTIVE';

/** Situação da assinatura SaaS da loja (subscriptions.status). */
export type SubscriptionStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELED';

/** Situação de uma fatura SaaS (subscription_invoices.status). */
export type InvoiceStatus = 'OPEN' | 'PAID' | 'FAILED' | 'VOID';

/** Referência pública a uma loja, como a API devolve junto de pedidos, convites e perfis: { id, slug, name, logo }. */
export interface StoreRef {
  id: number;
  slug: string;
  name: string;
  logo: string | null;
}

/** Loja da equipe guardada na sessão (SessionUser.store): identidade visual e situação cadastral. */
export interface SessionStore extends StoreRef {
  primary_color: string | null;
  account_status: StoreAccountStatus;
}

/** Sessão de acesso assistido do suporte: o superadmin vê o painel de UMA loja, só para leitura e por tempo limitado. */
export interface SupportSessionInfo {
  id: number;
  store_id: number;
  /** Data/hora ISO em que a sessão expira. */
  expires_at: string;
}
