/**
 * Respostas do superpainel montadas por LISTA DE CAMPOS PERMITIDOS: entidades nunca saem inteiras.
 * Nunca saem: stores.mp_access_token_encrypted, users.password_hash, users.token_version e hashes de
 * tokens (convites e redefinição de senha).
 */
import type { AuditLog } from '../audit/entities/audit-log.entity';
import type { Store } from '../store/entities/store.entity';
import type { User } from '../users/entities/user.entity';
import type { SupportSession } from './entities/support-session.entity';

export interface StoreRef {
  id: number;
  slug: string;
  name: string;
}

export interface StoreSummary extends StoreRef {
  account_status: Store['account_status'];
}

export interface UserRef {
  id: number;
  name: string;
  email: string;
}

export function storeRef(
  store: Pick<Store, 'id' | 'slug' | 'name'> | null | undefined,
): StoreRef | null {
  return store ? { id: store.id, slug: store.slug, name: store.name } : null;
}

export function storeSummary(
  store:
    | Pick<Store, 'id' | 'slug' | 'name' | 'account_status'>
    | null
    | undefined,
): StoreSummary | null {
  return store
    ? {
        id: store.id,
        slug: store.slug,
        name: store.name,
        account_status: store.account_status,
      }
    : null;
}

export function userRef(
  user: Pick<User, 'id' | 'name' | 'email'> | null | undefined,
): UserRef | null {
  return user ? { id: user.id, name: user.name, email: user.email } : null;
}

/** Loja no superpainel: cadastro, situação e operação (sem o Access Token cifrado do Mercado Pago). */
export function presentPlatformStore(store: Store) {
  return {
    id: store.id,
    slug: store.slug,
    name: store.name,
    legal_name: store.legal_name ?? null,
    document: store.document ?? null,
    email: store.email ?? null,
    phone: store.phone ?? null,
    description: store.description ?? null,
    logo: store.logo ?? null,
    primary_color: store.primary_color ?? null,
    address_zip_code: store.address_zip_code ?? null,
    address_street: store.address_street ?? null,
    address_number: store.address_number ?? null,
    address_complement: store.address_complement ?? null,
    address_neighborhood: store.address_neighborhood ?? null,
    address_city: store.address_city ?? null,
    address_state: store.address_state ?? null,
    account_status: store.account_status,
    status_reason: store.status_reason ?? null,
    status_changed_at: store.status_changed_at ?? null,
    is_open: store.is_open,
    opening_message: store.opening_message ?? null,
    closing_message: store.closing_message ?? null,
    delivery_enabled: store.delivery_enabled,
    takeout_enabled: store.takeout_enabled,
    delivery_zones: store.delivery_zones ?? null,
    takeout_estimate: store.takeout_estimate ?? null,
    opening_hours: store.opening_hours ?? null,
    time_zone: store.time_zone,
    custom_domain: store.custom_domain ?? null,
    owner_user_id: store.owner_user_id ?? null,
    created_at: store.created_at,
    updated_at: store.updated_at,
  };
}

export type PlatformStoreView = ReturnType<typeof presentPlatformStore>;

/**
 * Conta no superpainel: perfil, vínculo, papel global, bloqueio, último acesso e lixeira.
 * Nunca o hash da senha nem a versão das sessões.
 */
export function presentPlatformUser(
  user: User,
  extras: { store?: StoreSummary | null; is_owner?: boolean } = {},
) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone ?? null,
    avatar: user.avatar ?? null,
    role: user.role,
    platform_role: user.platform_role ?? null,
    store_id: user.store_id ?? null,
    store: extras.store ?? null,
    ...(extras.is_owner !== undefined ? { is_owner: extras.is_owner } : {}),
    blocked_at: user.blocked_at ?? null,
    blocked_reason: user.blocked_reason ?? null,
    last_login_at: user.last_login_at ?? null,
    created_at: user.created_at,
    updated_at: user.updated_at,
    deleted_at: user.deleted_at ?? null,
  };
}

export type PlatformUserView = ReturnType<typeof presentPlatformUser>;

/** Registro da auditoria com o ator e a loja resumidos (metadados já foram sanitizados na gravação). */
export function presentAuditLog(log: AuditLog) {
  const hasActor =
    log.actor_user_id !== null && log.actor_user_id !== undefined;
  return {
    id: log.id,
    created_at: log.created_at,
    action: log.action,
    result: log.result,
    actor_scope: log.actor_scope,
    actor:
      hasActor || log.actor_email
        ? {
            id: log.actor_user_id ?? null,
            name: log.actor?.name ?? null,
            email: log.actor_email ?? log.actor?.email ?? null,
          }
        : null,
    store_id: log.store_id ?? null,
    store: storeRef(log.store),
    target_type: log.target_type ?? null,
    target_id: log.target_id ?? null,
    ip: log.ip ?? null,
    user_agent: log.user_agent ?? null,
    metadata: log.metadata ?? null,
  };
}

export type AuditLogView = ReturnType<typeof presentAuditLog>;

export type SupportSessionStatus = 'ACTIVE' | 'ENDED' | 'EXPIRED';

export function supportSessionStatus(
  session: Pick<SupportSession, 'ended_at' | 'expires_at'>,
  now: Date = new Date(),
): SupportSessionStatus {
  if (session.ended_at) return 'ENDED';
  return new Date(session.expires_at).getTime() > now.getTime()
    ? 'ACTIVE'
    : 'EXPIRED';
}

/** Sessão de suporte (nunca o token: ele só aparece na resposta que abre a sessão). */
export function presentSupportSession(
  session: SupportSession,
  now: Date = new Date(),
) {
  const status = supportSessionStatus(session, now);
  return {
    id: session.id,
    store_id: session.store_id,
    store: storeRef(session.store),
    platform_user_id: session.platform_user_id ?? null,
    platform_user: userRef(session.platform_user),
    reason: session.reason,
    started_at: session.started_at,
    expires_at: session.expires_at,
    ended_at: session.ended_at ?? null,
    ip: session.ip ?? null,
    status,
    active: status === 'ACTIVE',
  };
}

export type SupportSessionView = ReturnType<typeof presentSupportSession>;
