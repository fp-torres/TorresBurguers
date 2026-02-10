import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { Order } from './entities/order.entity';
import { Product } from '../products/entities/product.entity';
import { Address } from '../addresses/entities/address.entity';
import { Addon } from '../products/entities/addon.entity';
import { StoreModule } from '../store/store.module'; // <--- IMPORTANTE

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, Product, Address, Addon]),
    StoreModule // <--- ADICIONADO para permitir verificar se a loja está aberta
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}