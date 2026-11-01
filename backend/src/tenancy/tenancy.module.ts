import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Subscription } from '../billing/entities/subscription.entity';
import { PlatformSettings } from '../platform/entities/platform-settings.entity';
import { Store } from '../store/entities/store.entity';
import {
  PlatformAdminGuard,
  PublicStoreGuard,
  StoreStaffGuard,
} from './guards';
import { TenantService } from './tenant.service';

/**
 * Contexto multi-tenant (global): resolução da loja e guards da equipe, da vitrine e do superpainel.
 * Qualquer módulo pode usar @StaffRoute(), @PublicStoreRoute(), @PlatformRoute() e o TenantService.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([Store, Subscription, PlatformSettings])],
  providers: [
    TenantService,
    StoreStaffGuard,
    PlatformAdminGuard,
    PublicStoreGuard,
  ],
  exports: [
    TenantService,
    StoreStaffGuard,
    PlatformAdminGuard,
    PublicStoreGuard,
  ],
})
export class TenancyModule {}
