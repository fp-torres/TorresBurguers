import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from './users/users.module';
import { ProductsModule } from './products/products.module';
import { OrdersModule } from './orders/orders.module';
import { User } from './users/entities/user.entity';
import { Product } from './products/entities/product.entity';
import { Order } from './orders/entities/order.entity';
import { OrderItem } from './orders/entities/order-item.entity';

@Module({
  imports: [
    // 1. Carrega as variáveis do .env
    ConfigModule.forRoot({ isGlobal: true }),

    // 2. Configura a conexão com o PostgreSQL
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'), // <--- Correção aqui (valor padrão)
      username: process.env.DB_USERNAME || 'postgres',
      password: process.env.DB_PASSWORD || '0000',
      database: process.env.DB_DATABASE || 'torresburgers',
      // Carrega as entidades explicitamente para evitar erros de leitura automática em alguns ambientes
      entities: [User, Product, Order, OrderItem],
      synchronize: true, // Cria as tabelas automaticamente (apenas para DEV)
    }),

    UsersModule,
    ProductsModule,
    OrdersModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}