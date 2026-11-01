import type { Store, StoreAccountStatus } from '../store/entities/store.entity';
import type { PlatformRole, User, UserRole } from './entities/user.entity';

/**
 * Respostas de conta montadas por LISTA DE CAMPOS PERMITIDOS: um campo novo na entidade (ou um
 * segredo carregado por engano, como password_hash) nunca sai na API sem ser incluído aqui.
 */

/** Colunas da loja que a sessão expõe (nunca credenciais, documento ou dados internos). */
export const SESSION_STORE_FIELDS = [
  'id',
  'slug',
  'name',
  'logo',
  'primary_color',
  'account_status',
] as const;

export type SessionStoreField = (typeof SESSION_STORE_FIELDS)[number];

/** select do TypeORM para carregar só o resumo da loja. */
export const SESSION_STORE_SELECT = Object.fromEntries(
  SESSION_STORE_FIELDS.map((field) => [field, true]),
) as Record<SessionStoreField, true>;

export interface SessionStore {
  id: number;
  slug: string;
  name: string;
  logo: string | null;
  primary_color: string | null;
  account_status: StoreAccountStatus;
}

export interface SessionUser {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  avatar: string | null;
  role: UserRole;
  /** Loja da equipe (null para clientes e para a administração da plataforma). */
  store_id: number | null;
  platform_role: PlatformRole | null;
  store: SessionStore | null;
  created_at: Date;
  updated_at: Date;
}

/** Item das listas da equipe e da lixeira: a sessão + quando foi para a lixeira. */
export interface TeamMember extends SessionUser {
  deleted_at: Date | null;
}

export function toSessionStore(
  store: Pick<Store, SessionStoreField> | null | undefined,
): SessionStore | null {
  if (!store) return null;
  return {
    id: store.id,
    slug: store.slug,
    name: store.name,
    logo: store.logo ?? null,
    primary_color: store.primary_color ?? null,
    account_status: store.account_status,
  };
}

export function toSessionUser(
  user: User,
  store: Pick<Store, SessionStoreField> | null = null,
): SessionUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone ?? null,
    avatar: user.avatar ?? null,
    role: user.role,
    store_id: user.store_id ?? null,
    platform_role: user.platform_role ?? null,
    store: toSessionStore(store),
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

export function toTeamMember(
  user: User,
  store: Pick<Store, SessionStoreField> | null = null,
): TeamMember {
  return { ...toSessionUser(user, store), deleted_at: user.deleted_at ?? null };
}
