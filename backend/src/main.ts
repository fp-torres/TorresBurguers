import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
// Importar o AppModule já carrega o .env (ConfigModule.forRoot) para process.env
import { AppModule } from './app.module';
import { setupApp } from './config/app-setup';
import { BRAND } from './config/brand';
import { environmentWarnings, runtimeEnv } from './config/env';
import { jwtSecret } from './config/jwt';
import { APP_VERSION } from './config/version';

const logger = new Logger('Bootstrap');

async function bootstrap() {
  // 0. Ambiente: em produção (inclusive NODE_ENV vazio ou desconhecido) a API não sobe sem um
  //    JWT_SECRET forte. A conferência acontece antes de tudo para o erro sair claro no log.
  logger.log(`Ambiente: ${runtimeEnv()}`);
  environmentWarnings().forEach((warning) => logger.warn(warning));
  try {
    jwtSecret();
  } catch (error) {
    logger.error(`A API não foi iniciada. ${(error as Error).message}`);
    process.exit(1);
  }

  const app = await NestFactory.create(AppModule);

  // 1. Validação global, formato dos 401 e CORS (mesma configuração usada nos testes E2E)
  setupApp(app);

  // 2. Documentação interativa (Swagger) em /api
  const swaggerConfig = new DocumentBuilder()
    .setTitle(`${BRAND.name} API`)
    .setDescription(
      'API do sistema de delivery: cardápio, pedidos, pagamentos, entregas, endereços e gestão da loja. ' +
        'Rotas protegidas exigem o token obtido em POST /auth/login (botão "Authorize").',
    )
    .setVersion(APP_VERSION)
    .addBearerAuth()
    .build();
  SwaggerModule.setup(
    'api',
    app,
    SwaggerModule.createDocument(app, swaggerConfig),
  );

  // 3. Sobe o servidor (0.0.0.0 permite acesso pela rede local, ex.: app no celular)
  const port = Number(process.env.PORT) || 3000;
  await app.listen(port, '0.0.0.0');

  logger.log(`API ${BRAND.name} rodando em http://localhost:${port}`);
  logger.log(`Swagger disponível em http://localhost:${port}/api`);
}

void bootstrap();
