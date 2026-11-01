import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ServeStaticModule } from '@nestjs/serve-static';

// Configuração central
import { uploadsStaticOptions } from './config/app-setup';
import { uploadsDir } from './config/paths';
import {
  apiTypeOrmOptions,
  runStartupMigrations,
} from './database/typeorm.config';

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
import { TenancyModule } from './tenancy/tenancy.module';
import { AuditModule } from './audit/audit.module';
import { SharedModule } from './common/shared.module';
import { BillingModule } from './billing/billing.module';
import { PlatformModule } from './platform/platform.module';
import { InvitationsModule } from './invitations/invitations.module';
import { AccountModule } from './account/account.module';

// Controllers Globais
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UploadController } from './common/upload.controller';

@Module({
  imports: [
    // Carrega o .env para process.env (variáveis já definidas no ambiente têm prioridade)
    ConfigModule.forRoot({ isGlobal: true }),

    // Imagens enviadas (produtos, adicionais, logos das lojas e avatares) servidas em /uploads.
    // Arquivo inexistente → 404 padrão da API ("Cannot GET /uploads/..."), sem caminho do servidor:
    // o exclude tira /uploads/* do "fallback de SPA" do módulo, que tentaria enviar <pasta>/index.html
    // e devolveria no 404 a mensagem do ENOENT com o caminho absoluto. Pasta não vira índice nem
    // redirecionamento. (O padrão não cobre "/uploads" sozinho: o POST /uploads segue com os erros
    // normais da API, ex.: 400 de JSON inválido.) Teste: common/uploads/serve-uploads.spec.ts.
    // Cache-Control de 30 dias, imutável (nomes únicos). Opções em config/app-setup.ts.
    ServeStaticModule.forRoot(uploadsStaticOptions(uploadsDir())),

    // Conexão, entidades e migrations: src/database/typeorm.config.ts (a mesma do CLI de migrations).
    // Migrations pendentes rodam na subida (DB_MIGRATIONS_RUN), numa conexão própria sem o
    // statement_timeout da API; synchronize só em development/test. Pool: DB_POOL_SIZE.
    TypeOrmModule.forRootAsync({
      useFactory: async () => ({
        ...(await runStartupMigrations().then(() => apiTypeOrmOptions())),
        // Entidades registradas com TypeOrmModule.forFeature() nos módulos entram automaticamente
        autoLoadEntities: true,
      }),
    }),

    // Infraestrutura multi-tenant (globais): loja de cada requisição, auditoria, limites e e-mail
    TenancyModule,
    AuditModule,
    SharedModule,

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

    // SaaS: cobrança da plataforma, superpainel e convites
    BillingModule,
    PlatformModule,
    InvitationsModule,
    // Segurança da própria conta: /account (senha, troca e verificação do e-mail)
    AccountModule,
  ],
  controllers: [AppController, UploadController],
  providers: [AppService],
})
export class AppModule {}
