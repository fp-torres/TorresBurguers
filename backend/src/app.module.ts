import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServeStaticModule } from '@nestjs/serve-static'; 
import { join } from 'path'; 

// Modules
import { UsersModule } from './users/users.module';
import { ProductsModule } from './products/products.module';
import { OrdersModule } from './orders/orders.module';
import { AuthModule } from './auth/auth.module';
import { AddressesModule } from './addresses/addresses.module';
import { StoreModule } from './store/store.module';
import { PromotionsModule } from './promotions/promotions.module';
import { PaymentModule } from './payment/payment.module';

// Entities
import { User } from './users/entities/user.entity';
import { Product } from './products/entities/product.entity';
import { Order } from './orders/entities/order.entity';
import { OrderItem } from './orders/entities/order-item.entity';
import { Address } from './addresses/entities/address.entity';
import { Addon } from './products/entities/addon.entity';
import { StoreConfig } from './store/entities/store-config.entity';

// Controllers Globais (se houver)
import { UploadController } from './common/upload.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    
    // --- CORREÇÃO IMPORTANTE AQUI ---
    // ServeStaticModule: Libera o acesso à pasta /uploads para o navegador
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'uploads'), // Usa process.cwd() para garantir que pega a pasta na raiz do projeto
      serveRoot: '/uploads', // A URL será http://localhost:3000/uploads/arquivo.jpg
    }),

    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      username: process.env.DB_USERNAME || 'postgres',
      password: process.env.DB_PASSWORD || '0000',
      database: process.env.DB_DATABASE || 'torresburgers',
      entities: [User, Product, Order, OrderItem, Address, Addon, StoreConfig], 
      synchronize: true,
    }),
    
    // Módulos da Aplicação
    UsersModule,
    ProductsModule,
    OrdersModule,
    AuthModule,
    AddressesModule,
    StoreModule,
    PromotionsModule,
    PaymentModule, 
  ],
  controllers: [UploadController], // Verifique se este controller realmente existe no seu projeto, senão remova.
  providers: [],
})
export class AppModule {}