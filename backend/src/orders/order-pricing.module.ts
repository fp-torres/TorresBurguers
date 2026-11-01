import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product } from '../products/entities/product.entity';
import { Addon } from '../products/entities/addon.entity';
import { Address } from '../addresses/entities/address.entity';
import { AddressesModule } from '../addresses/addresses.module';
import { StoreCustomerBlock } from '../store/entities/store-customer-block.entity';
import { OrderPricingService } from './order-pricing.service';

/**
 * Cálculo do pedido (orçamento) compartilhado por Pedidos e Pagamentos.
 * Fica num módulo próprio para Pagamentos não depender do OrdersModule (sem import circular).
 * A loja (aberta, entrega/retirada, zonas, prazos) chega pronta do PublicStoreGuard: não depende do StoreModule.
 * StoreCustomerBlock: o cliente bloqueado pela loja não orça, não pede e não paga nela.
 * AddressesModule: AddressLocationService confere pelo CEP o bairro dos endereços antigos (zona de entrega).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Product, Addon, Address, StoreCustomerBlock]),
    AddressesModule,
  ],
  providers: [OrderPricingService],
  exports: [OrderPricingService],
})
export class OrderPricingModule {}
