import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity'; // Importante para integridade
import { Product } from '../products/entities/product.entity';
import { Address } from '../addresses/entities/address.entity';
import { Addon } from '../products/entities/addon.entity';
import { User } from '../users/entities/user.entity'; // <--- O QUE FALTAVA
import { StoreModule } from '../store/store.module';

@Module({
  imports: [
    // Adicionei 'User' e 'OrderItem' na lista abaixo
    TypeOrmModule.forFeature([Order, OrderItem, Product, Address, Addon, User]),
    StoreModule 
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService], // Boa prática exportar o serviço
})
export class OrdersModule {}