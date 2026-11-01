import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isSuperAdmin } from '../auth/auth-user';
import { isStaffRole } from '../orders/order-rules';
import type { StoreCapability } from './store-access';
import type { TenantRequest } from './tenant-context';
import { TenantService } from './tenant.service';

export const STORE_CAPABILITY_KEY = 'tenancy:capability';
export const REQUIRE_SELLABLE_STORE_KEY = 'tenancy:sellable';

const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

function isReadMethod(method: string | undefined): boolean {
  return READ_METHODS.includes((method ?? 'GET').toUpperCase());
}

/**
 * Painel da equipe (use depois do AuthGuard('jwt')): a loja é a do usuário autenticado
 * (users.store_id do banco). Também confere:
 * - a capacidade exigida pela rota (@RequireStoreCapability; padrão: leitura em GET, "manage" no resto)
 *   contra a situação da loja (suspensa, desativada, assinatura...);
 * - sessão de suporte: somente leitura;
 * - rota com :storeSlug de outra loja → 403 (nunca troca o tenant pelo que veio na URL).
 * Preenche req.tenant (use @CurrentTenant()).
 */
@Injectable()
export class StoreStaffGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenants: TenantService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TenantRequest>();
    const user = request.user;
    if (!user) {
      throw new UnauthorizedException(
        'Sessão inválida ou expirada. Faça login novamente.',
      );
    }

    if (user.supportSession && !isReadMethod(request.method)) {
      throw new ForbiddenException(
        'Sessão de suporte é somente leitura: nenhuma alteração pode ser feita na loja.',
      );
    }

    const capability =
      this.reflector.getAllAndOverride<StoreCapability | undefined>(
        STORE_CAPABILITY_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? (isReadMethod(request.method) ? 'read' : 'manage');

    const tenant = await this.tenants.staffContext(user, capability);

    const slug = (request.params as Record<string, string | undefined>)
      ?.storeSlug;
    if (slug !== undefined && slug !== tenant.store.slug) {
      throw new ForbiddenException(
        'Você só pode administrar a loja à qual a sua conta pertence.',
      );
    }

    request.tenant = tenant;
    return true;
  }
}

/** Superpainel: só superadministrador (e nunca um token de sessão de suporte). Use depois do AuthGuard('jwt'). */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest<TenantRequest>();
    if (!user) {
      throw new UnauthorizedException(
        'Sessão inválida ou expirada. Faça login novamente.',
      );
    }
    if (!isSuperAdmin(user)) {
      throw new ForbiddenException(
        'Área exclusiva da administração da plataforma.',
      );
    }
    return true;
  }
}

/**
 * Vitrine e compra: resolve a loja pelo :storeSlug da rota. Nas rotas antigas (sem slug), a loja é a
 * da EQUIPE autenticada (o painel e o app da equipe leem o próprio cardápio/status por elas; loja
 * desativada → 403, como no painel) ou, para visitantes e clientes, a loja padrão. Loja inexistente ou
 * desativada → 404.
 * Com @RequireSellableStore(), recusa (403) loja que não pode vender (suspensa, assinatura
 * suspensa/cancelada). Preenche req.publicStore (@PublicStore()).
 */
@Injectable()
export class PublicStoreGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenants: TenantService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TenantRequest>();
    const slug = (request.params as Record<string, string | undefined>)
      ?.storeSlug;
    const staffStoreId =
      slug === undefined &&
      request.user?.storeId &&
      isStaffRole(request.user.role)
        ? request.user.storeId
        : null;
    const store = staffStoreId
      ? await this.tenants.contextForStoreId(staffStoreId)
      : await this.tenants.publicContext(slug);
    // Equipe na própria loja: mesma regra de leitura do painel (loja desativada → 403, como em
    // StoreStaffGuard; um token emitido antes da desativação não continua lendo cardápio e status)
    if (staffStoreId) this.tenants.assertCapability(store, 'read');

    const sellable = this.reflector.getAllAndOverride<boolean | undefined>(
      REQUIRE_SELLABLE_STORE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (sellable) this.tenants.assertCanSell(store);

    request.publicStore = store;
    return true;
  }
}
