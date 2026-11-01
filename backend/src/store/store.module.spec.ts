import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditService } from '../audit/audit.service';
import { PlanLimitsService } from '../billing/plan-limits.service';
import { Order } from '../orders/entities/order.entity';
import { TenantService } from '../tenancy/tenant.service';
import { Store } from './entities/store.entity';
import { StoreCustomersService } from './store-customers.service';
import { StoreDirectoryService } from './store-directory.service';
import { StoreSettingsService } from './store-settings.service';
import { StoreModule } from './store.module';
import { StoreService } from './store.service';

/** Serviços globais da aplicação (TenancyModule, BillingModule, AuditModule) substituídos por dublês. */
@Global()
@Module({
  providers: [
    { provide: TenantService, useValue: {} },
    { provide: PlanLimitsService, useValue: {} },
    { provide: AuditService, useValue: {} },
  ],
  exports: [TenantService, PlanLimitsService, AuditService],
})
class FakeGlobalsModule {}

describe('StoreModule (injeção de dependências)', () => {
  it('monta serviços, controllers, guards e interceptors sem banco', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeGlobalsModule, StoreModule],
    })
      .overrideProvider(getRepositoryToken(Store))
      .useValue({})
      .overrideProvider(getRepositoryToken(Order))
      .useValue({})
      .compile();

    for (const service of [
      StoreService,
      StoreSettingsService,
      StoreCustomersService,
      StoreDirectoryService,
    ]) {
      expect(moduleRef.get(service)).toBeInstanceOf(service);
    }

    // init() instancia os guards (StoreStaffGuard, PublicStoreGuard, RolesGuard) de cada rota
    const app = moduleRef.createNestApplication();
    await expect(app.init()).resolves.toBe(app);
    await app.close();
  });
});
