import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Repository } from 'typeorm';
import type { AuthUser } from '../auth/auth-user';
import {
  SubscriptionStatus,
  type Subscription,
} from '../billing/entities/subscription.entity';
import type { PlatformSettings } from '../platform/entities/platform-settings.entity';
import { StoreAccountStatus, type Store } from '../store/entities/store.entity';
import { UserRole } from '../users/entities/user.entity';
import { PublicStoreGuard, REQUIRE_SELLABLE_STORE_KEY } from './guards';
import { STORE_UNAVAILABLE_MESSAGE } from './store-access';
import type { TenantRequest } from './tenant-context';
import { TenantService } from './tenant.service';

const REASON = 'Fraude em investigação (texto interno do superadmin)';

function setup(store: Partial<Store>) {
  const row = {
    id: 4,
    slug: 'loja-4',
    name: 'Loja 4',
    account_status: StoreAccountStatus.ACTIVE,
    ...store,
  } as Store;
  const stores = {
    findOne: jest.fn(() => Promise.resolve(row)),
  };
  const subscriptions = {
    findOne: jest.fn(() =>
      Promise.resolve({
        id: 1,
        store_id: 4,
        status: SubscriptionStatus.ACTIVE,
      } as Subscription),
    ),
  };
  const settings = { findOne: jest.fn(() => Promise.resolve(null)) };
  const tenants = new TenantService(
    stores as unknown as Repository<Store>,
    subscriptions as unknown as Repository<Subscription>,
    settings as unknown as Repository<PlatformSettings>,
  );
  return { guard: new PublicStoreGuard(new Reflector(), tenants) };
}

function context(
  request: Partial<TenantRequest>,
  sellable = false,
): ExecutionContext {
  const handler = () => undefined;
  if (sellable)
    Reflect.defineMetadata(REQUIRE_SELLABLE_STORE_KEY, true, handler);
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

const staff = (role: UserRole): AuthUser =>
  ({ id: 9, role, storeId: 4, platformRole: null }) as unknown as AuthUser;
const customer = {
  id: 7,
  role: UserRole.CLIENT,
  storeId: null,
} as unknown as AuthUser;

describe('PublicStoreGuard', () => {
  it('rotas antigas sem slug: equipe de loja DESATIVADA não lê cardápio/status (403, como no painel)', async () => {
    const { guard } = setup({
      account_status: StoreAccountStatus.INACTIVE,
      status_reason: 'Encerramento',
    });
    for (const role of [UserRole.ADMIN, UserRole.KITCHEN, UserRole.COURIER]) {
      const request = { params: {}, user: staff(role) } as never;
      const failure = guard.canActivate(context(request));
      await expect(failure).rejects.toBeInstanceOf(ForbiddenException);
      await expect(failure).rejects.toThrow(
        'Esta loja foi desativada na plataforma. Fale com o suporte.',
      );
    }
  });

  it('equipe de loja suspensa continua lendo pelas rotas antigas (leitura liberada)', async () => {
    const { guard } = setup({
      account_status: StoreAccountStatus.SUSPENDED,
      status_reason: REASON,
    });
    const request = {
      params: {},
      user: staff(UserRole.ADMIN),
    } as Partial<TenantRequest>;
    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request.publicStore?.storeId).toBe(4);
  });

  it('compra em loja que não vende: o cliente recebe a mensagem genérica da vitrine, nunca o motivo interno', async () => {
    const { guard } = setup({
      account_status: StoreAccountStatus.SUSPENDED,
      status_reason: REASON,
    });
    const request = {
      params: { storeSlug: 'loja-4' },
      user: customer,
    } as never;
    const failure = guard.canActivate(context(request, true));
    await expect(failure).rejects.toBeInstanceOf(ForbiddenException);
    await expect(failure).rejects.toThrow(STORE_UNAVAILABLE_MESSAGE);
    await expect(failure).rejects.not.toThrow(/Fraude|suspensa/);
  });
});
