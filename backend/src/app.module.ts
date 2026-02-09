import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServeStaticModule } from '@nestjs/serve-static'; 
import { join } from 'path'; 

// Módulos
import { UsersModule } from './users/users.module';
import { ProductsModule } from './products/products.module';
import { OrdersModule } from './orders/orders.module';
import { AuthModule } from './auth/auth.module';
import { AddressesModule } from './addresses/addresses.module';

// Entidades (Tabelas do Banco)
import { User } from './users/entities/user.entity';
import { Product } from './products/entities/product.entity';
import { Order } from './orders/entities/order.entity';
import { OrderItem } from './orders/entities/order-item.entity';
import { Address } from './addresses/entities/address.entity';
import { Addon } from './products/entities/addon.entity'; // <--- 1. Import do Adicional

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    
    // Configura a pasta pública de imagens
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'uploads'), 
      serveRoot: '/uploads',
    }),

    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      username: process.env.DB_USERNAME || 'postgres',
      password: process.env.DB_PASSWORD || '0000',
      database: process.env.DB_DATABASE || 'torresburgers',
      // 2. ADICIONEI 'Addon' NA LISTA ABAIXO:
      entities: [User, Product, Order, OrderItem, Address, Addon], 
      synchronize: true,
    }),

    UsersModule,
    ProductsModule,
    OrdersModule,
    AuthModule,
    AddressesModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}