import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
// Importar o AppModule já carrega o .env (ConfigModule.forRoot) para process.env
import { AppModule } from './app.module';
import { setupApp } from './config/app-setup';
import { BRAND } from './config/brand';
import { environmentWarnings, runtimeEnv, swaggerEnabled } from './config/env';
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

  // 2. Documentação interativa (Swagger) em /api (desligada em produção, salvo SWAGGER_ENABLED=true)
  const swagger = swaggerEnabled();
  const swaggerConfig = new DocumentBuilder()
    .setTitle(`${BRAND.name} API`)
    .setDescription(
      'API do sistema de delivery: cardápio, pedidos, pagamentos, entregas, endereços e gestão da loja. ' +
        'Rotas protegidas exigem o token obtido em POST /auth/login (botão "Authorize").',
    )
    .setVersion(APP_VERSION)
    .addBearerAuth()
    .build();
  if (swagger) {
    SwaggerModule.setup(
      'api',
      app,
      SwaggerModule.createDocument(app, swaggerConfig),
    );
  }

  // 3. Sobe o servidor. HOST escolhe a interface: padrão 0.0.0.0 (todas as interfaces IPv4, necessário
  //    para o app no celular na rede local); 127.0.0.1 deixa a API só neste computador.
  const port = Number(process.env.PORT) || 3000;
  const host = listenHost(process.env.HOST);
  try {
    await app.listen(port, host);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    logger.error(
      `A API não conseguiu escutar em ${host}:${port}${code ? ` (${code})` : ''}. Confira HOST e PORT.`,
    );
    process.exit(1);
  }

  const baseUrl = `http://${browsableHost(host)}:${port}`;
  logger.log(
    `API ${BRAND.name} escutando em ${host}:${port} (${describeHost(host)})`,
  );
  logger.log(`API ${BRAND.name} rodando em ${baseUrl}`);
  if (swagger) logger.log(`Swagger disponível em ${baseUrl}/api`);
}

/**
 * Interface de escuta: HOST (sem espaços em volta; IPv6 aceito com ou sem colchetes) ou 0.0.0.0, o
 * comportamento de sempre.
 */
function listenHost(raw: string | undefined): string {
  return raw?.trim().replace(/^\[(.+)\]$/, '$1') || '0.0.0.0';
}

const ANY_HOST = new Set(['0.0.0.0', '::']);
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|::1)$/i;

/** Para quem lê o log: o alcance do endereço escolhido. */
function describeHost(host: string): string {
  if (ANY_HOST.has(host))
    return 'todas as interfaces: acessível pela rede local';
  if (LOOPBACK_HOST.test(host)) return 'somente este computador';
  return 'somente esta interface';
}

/** Endereço para abrir no navegador (0.0.0.0 e :: viram localhost; IPv6 entre colchetes). */
function browsableHost(host: string): string {
  if (ANY_HOST.has(host)) return 'localhost';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

void bootstrap();
