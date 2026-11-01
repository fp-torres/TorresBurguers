import { ConflictException } from '@nestjs/common';
import {
  Not,
  QueryFailedError,
  type EntityManager,
  type Repository,
} from 'typeorm';
import { isUniqueViolation } from '../common/database-errors';
import { StoreSlugHistory } from '../store/entities/store-slug-history.entity';
import { Store, StoreAccountStatus } from '../store/entities/store.entity';
import { configuredDefaultStoreSlug } from '../tenancy/tenant.service';
import {
  STORE_PROFILE_FIELDS,
  type StoreProfileField,
} from './dto/platform-stores.dto';
import {
  CUSTOM_DOMAIN_TAKEN_MESSAGE,
  SLUG_RESERVED_MESSAGE,
  SLUG_TAKEN_MESSAGE,
} from './store-identity-rules';

/**
 * Criação de estabelecimentos (superpainel e autoatendimento): conferências de unicidade e a gravação
 * da loja nova dentro da transação de quem chama (a assinatura e a conta do dono entram na mesma).
 */

export type StoreProfile = Partial<Pick<Store, StoreProfileField>>;

/** Só os dados cadastrais enviados (undefined = não enviado; null = limpar). */
export function profileFrom(
  input: Partial<Record<StoreProfileField, unknown>>,
): StoreProfile {
  const profile: Record<string, unknown> = {};
  for (const field of STORE_PROFILE_FIELDS) {
    if (input[field] !== undefined) profile[field] = input[field];
  }
  return profile;
}

/** Constraint violada num erro do PostgreSQL (ex.: UQ_stores_slug). */
export function violatedConstraint(error: unknown): string | null {
  if (!(error instanceof QueryFailedError)) return null;
  const { driverError } = error as QueryFailedError<
    Error & { constraint?: string }
  >;
  return driverError?.constraint ?? null;
}

/**
 * Corrida entre duas gravações com o mesmo slug ou domínio: o índice único do banco decide e vira 409
 * (em vez de 500). Outros erros seguem como vieram.
 */
export function rethrowStoreConflict(error: unknown): never {
  if (isUniqueViolation(error)) {
    const constraint = violatedConstraint(error);
    if (constraint === 'UQ_stores_custom_domain') {
      throw new ConflictException(CUSTOM_DOMAIN_TAKEN_MESSAGE);
    }
    if (constraint === 'UQ_stores_slug') {
      throw new ConflictException(SLUG_TAKEN_MESSAGE);
    }
  }
  throw error;
}

/** 409 se outra loja já usa o slug. */
export async function assertSlugAvailable(
  stores: Repository<Store>,
  slug: string,
  ignoreStoreId?: number,
): Promise<void> {
  const taken = await stores.exists({
    where: {
      slug,
      ...(ignoreStoreId !== undefined ? { id: Not(ignoreStoreId) } : {}),
    },
  });
  if (taken) throw new ConflictException(SLUG_TAKEN_MESSAGE);
}

/**
 * Autoatendimento (POST /stores/signup): além de livre agora (assertSlugAvailable), o endereço não pode ser
 * - o DEFAULT_STORE_SLUG do ambiente: a loja padrão das rotas antigas (app mobile) é resolvida por ele a
 *   cada requisição, então quem o registrasse viraria a loja padrão (pedidos, clientes e pagamentos do
 *   app) — reservado mesmo quando nenhuma loja o usa (renomeada, digitado errado, ainda não criada);
 * - um endereço que já foi de outra loja (store_slug_history): QR codes, links e a última loja guardada
 *   no navegador dos clientes levariam a um impostor. Mesma mensagem de "em uso".
 * O superpainel (criar e trocar endereço) não passa por aqui: ele decide, com aviso.
 */
export async function assertSlugAvailableForSignup(
  stores: Repository<Store>,
  slug: string,
): Promise<void> {
  await assertSlugAvailable(stores, slug);
  if (slug === configuredDefaultStoreSlug()) {
    throw new ConflictException(SLUG_RESERVED_MESSAGE);
  }
  const retired = await stores.manager
    .getRepository(StoreSlugHistory)
    .exists({ where: { slug } });
  if (retired) throw new ConflictException(SLUG_TAKEN_MESSAGE);
}

/** Último dono de um endereço que deixou de ser usado (null se nunca foi de nenhuma loja). */
export function previousSlugOwner(
  stores: Repository<Store>,
  slug: string,
): Promise<Pick<StoreSlugHistory, 'store_id' | 'slug'> | null> {
  return stores.manager.getRepository(StoreSlugHistory).findOne({
    where: { slug },
    select: { store_id: true, slug: true },
  });
}

/** Reserva o endereço que a loja deixa de usar (fica gravado o último dono e quando). */
export async function retireStoreSlug(
  stores: Repository<Store>,
  storeId: number,
  slug: string,
  now: Date = new Date(),
): Promise<void> {
  await stores.manager
    .getRepository(StoreSlugHistory)
    .upsert({ store_id: storeId, slug, released_at: now }, ['slug']);
}

/** 409 se outra loja já usa o domínio próprio. */
export async function assertCustomDomainAvailable(
  stores: Repository<Store>,
  domain: string,
  ignoreStoreId: number,
): Promise<void> {
  const taken = await stores.exists({
    where: { custom_domain: domain, id: Not(ignoreStoreId) },
  });
  if (taken) throw new ConflictException(CUSTOM_DOMAIN_TAKEN_MESSAGE);
}

export interface NewStoreInput {
  name: string;
  slug: string;
  profile?: StoreProfile;
  ownerUserId?: number | null;
}

/**
 * Grava a loja nova: ATIVA na plataforma, FECHADA para pedidos (a equipe abre quando estiver pronta),
 * entrega desligada (ainda sem zonas e taxas) e retirada no balcão ligada. Nada de credenciais.
 */
export async function insertNewStore(
  manager: EntityManager,
  input: NewStoreInput,
): Promise<Store> {
  const stores = manager.getRepository(Store);
  try {
    return await stores.save(
      stores.create({
        ...(input.profile ?? {}),
        name: input.name,
        slug: input.slug,
        account_status: StoreAccountStatus.ACTIVE,
        status_reason: null,
        status_changed_at: null,
        is_open: false,
        delivery_enabled: false,
        takeout_enabled: true,
        owner_user_id: input.ownerUserId ?? null,
      }),
    );
  } catch (error) {
    rethrowStoreConflict(error);
  }
}
