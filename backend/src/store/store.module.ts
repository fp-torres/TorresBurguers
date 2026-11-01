import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from '../orders/entities/order.entity';
import { Store } from './entities/store.entity';
import { StoreCustomersController } from './store-customers.controller';
import { StoreCustomersService } from './store-customers.service';
import { StoreDirectoryService } from './store-directory.service';
import { StoreSettingsService } from './store-settings.service';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import { StoresController } from './stores.controller';

/**
 * Loja (tenant): status, configurações, logo, credenciais de pagamento, clientes da loja e vitrine
 * pública (/stores). A loja de cada requisição vem dos guards do TenancyModule (global); limites do
 * plano (BillingModule) e auditoria (AuditModule) também são globais.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Store, Order])],
  controllers: [StoreController, StoreCustomersController, StoresController],
  providers: [
    StoreService,
    StoreSettingsService,
    StoreCustomersService,
    StoreDirectoryService,
  ],
  exports: [StoreService],
})
export class StoreModule {}
