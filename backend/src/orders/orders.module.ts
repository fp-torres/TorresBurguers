import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { Order } from './entities/order.entity';
import { Product } from '../products/entities/product.entity';
import { Address } from '../addresses/entities/address.entity'; // <--- Importe Address

@Module({
  imports: [
    // Registre Address aqui para o Service conseguir usar
    TypeOrmModule.forFeature([Order, Product, Address]) 
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}