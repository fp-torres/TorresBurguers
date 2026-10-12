import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServeStaticModule } from '@nestjs/serve-static';

// Configuração central
import { BRAND } from './config/brand';
import { dbSynchronize } from './config/env';
import { uploadsDir } from './config/paths';

// Modules
import { UsersModule } from './users/users.module';
import { ProductsModule } from './products/products.module';
import { OrdersModule } from './orders/orders.module';
import { AuthModule } from './auth/auth.module';
import { AddressesModule } from './addresses/addresses.module';
import { StoreModule } from './store/store.module';
import { PromotionsModule } from './promotions/promotions.module';
import { PaymentModule } from './payment/payment.module';
import { CommonModule } from './common/common.module';
import { DatabaseModule } from './database/database.module';

// Entities
import { User } from './users/entities/user.entity';
import { Product } from './products/entities/product.entity';
import { Order } from './orders/entities/order.entity';
import { OrderItem } from './orders/entities/order-item.entity';
import { Address } from './addresses/entities/address.entity';
import { Addon } from './products/entities/addon.entity';
import { StoreConfig } from './store/entities/store-config.entity';

// Controllers Globais
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UploadController } from './common/upload.controller';

@Module({
  imports: [
    // Carrega o .env para process.env (variáveis já definidas no ambiente têm prioridade)
    ConfigModule.forRoot({ isGlobal: true }),

    // Imagens enviadas (produtos e avatares) servidas em /uploads
    ServeStaticModule.forRoot({
      rootPath: uploadsDir(),
      serveRoot: '/uploads',
    }),

    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        type: 'postgres' as const,
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT) || 5432,
        username: process.env.DB_USERNAME || 'postgres',
        password: process.env.DB_PASSWORD ?? '',
        database: process.env.DB_DATABASE || BRAND.slug,
        entities: [
          User,
          Product,
          Order,
          OrderItem,
          Address,
          Addon,
          StoreConfig,
        ],
        // Entidades registradas com TypeOrmModule.forFeature() nos módulos entram automaticamente
        autoLoadEntities: true,
        // Padrão: ligado só em development/test. Em produção, migrations com DB_SYNCHRONIZE=false
        synchronize: dbSynchronize(),
      }),
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
    CommonModule, // manutenção (otimização de imagens)
    DatabaseModule, // usuários padrão (um por perfil) criados na subida
  ],
  controllers: [AppController, UploadController],
  providers: [AppService],
})
export class AppModule {}
