import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { AddonsController } from './addons.controller';
import { Product } from './entities/product.entity';
import { Addon } from './entities/addon.entity';

/**
 * Cardápio por loja. Loja da requisição (TenancyModule), limites do plano (BillingModule) e
 * auditoria (AuditModule) vêm de módulos globais.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Product, Addon])],
  controllers: [ProductsController, AddonsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
