import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { Order } from './entities/order.entity';
import { Product } from '../products/entities/product.entity';
import { Address } from '../addresses/entities/address.entity';
import { Addon } from '../products/entities/addon.entity'; // Import do Adicional

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, Product, Address, Addon]) 
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}