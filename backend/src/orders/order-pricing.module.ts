import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from '../products/entities/product.entity';
import { Addon } from '../products/entities/addon.entity';
import { Address } from '../addresses/entities/address.entity';
import { StoreModule } from '../store/store.module';
import { OrderPricingService } from './order-pricing.service';

/**
 * Cálculo do pedido (orçamento) compartilhado por Pedidos e Pagamentos.
 * Fica num módulo próprio para Pagamentos não depender do OrdersModule (sem import circular).
 */
@Module({
  imports: [TypeOrmModule.forFeature([Product, Addon, Address]), StoreModule],
  providers: [OrderPricingService],
  exports: [OrderPricingService],
})
export class OrderPricingModule {}
