import {
  applyDecorators,
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth } from '@nestjs/swagger';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import type { UserRole } from '../users/entities/user.entity';
import {
  PlatformAdminGuard,
  PublicStoreGuard,
  REQUIRE_SELLABLE_STORE_KEY,
  STORE_CAPABILITY_KEY,
  StoreStaffGuard,
} from './guards';
import type { StoreCapability as Capability } from './store-access';
import type { TenantContext, TenantRequest } from './tenant-context';

/** Capacidade que a rota da equipe exige da loja (padrão: "read" em GET, "manage" nos demais). */
export const RequireStoreCapability = (capability: Capability) =>
  SetMetadata(STORE_CAPABILITY_KEY, capability);

/** A rota pública só funciona em loja que pode vender (orçamento, pedido, pagamento). */
export const RequireSellableStore = () =>
  SetMetadata(REQUIRE_SELLABLE_STORE_KEY, true);

/** Loja da equipe autenticada (preenchida pelo StoreStaffGuard). */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantContext => {
    const { tenant } = context.switchToHttp().getRequest<TenantRequest>();
    if (!tenant) {
      throw new InternalServerErrorException(
        'Contexto da loja ausente: a rota precisa do StoreStaffGuard.',
      );
    }
    return tenant;
  },
);

/** Loja da vitrine (preenchida pelo PublicStoreGuard). */
export const PublicStore = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantContext => {
    const { publicStore } = context.switchToHttp().getRequest<TenantRequest>();
    if (!publicStore) {
      throw new InternalServerErrorException(
        'Loja da vitrine ausente: a rota precisa do PublicStoreGuard.',
      );
    }
    return publicStore;
  },
);

/**
 * Rota do painel da equipe: JWT + loja do usuário (StoreStaffGuard) + perfis (RolesGuard).
 * Sem perfis: qualquer perfil da equipe. Em controllers que já aplicam AuthGuard('jwt') na classe,
 * use StaffOnly() para não validar o token duas vezes.
 */
export function StaffRoute(...roles: (UserRole | string)[]) {
  return applyDecorators(
    ApiBearerAuth(),
    UseGuards(AuthGuard('jwt'), StoreStaffGuard, RolesGuard),
    ...(roles.length ? [Roles(...roles)] : []),
  );
}

/** Igual a StaffRoute, para controllers que já têm @UseGuards(AuthGuard('jwt')) na classe. */
export function StaffOnly(...roles: (UserRole | string)[]) {
  return applyDecorators(
    UseGuards(StoreStaffGuard, RolesGuard),
    ...(roles.length ? [Roles(...roles)] : []),
  );
}

/** Rota do superpainel: JWT + superadministrador. */
export function PlatformRoute() {
  return applyDecorators(
    ApiBearerAuth(),
    UseGuards(AuthGuard('jwt'), PlatformAdminGuard),
  );
}

/**
 * Rota da vitrine: resolve a loja do :storeSlug (ou, nas rotas antigas, a loja da equipe autenticada
 * ou a loja padrão). sellable: exige loja vendendo.
 * auth: 'optional' (padrão) lê o token se houver, para a equipe ver a própria loja nas rotas antigas;
 * use 'none' quando a rota já autentica (ex.: compras do cliente com AuthGuard('jwt') + ClientOnlyGuard,
 * que devem vir ANTES deste decorator).
 */
export function PublicStoreRoute(
  options: { sellable?: boolean; auth?: 'optional' | 'none' } = {},
) {
  return applyDecorators(
    ...(options.auth === 'none'
      ? [UseGuards(PublicStoreGuard)]
      : [UseGuards(OptionalJwtAuthGuard, PublicStoreGuard)]),
    ...(options.sellable ? [RequireSellableStore()] : []),
  );
}
