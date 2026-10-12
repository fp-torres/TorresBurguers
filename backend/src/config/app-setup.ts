import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { UnauthorizedExceptionFilter } from '../common/filters/unauthorized-exception.filter';
import { isProduction } from './env';

/**
 * Origens liberadas no CORS.
 * CORS_ORIGINS com uma lista separada por vírgula (ex.: https://painel.minhaloja.com.br,https://minhaloja.com.br)
 * libera somente essas origens. Vazio (ou "*") reflete qualquer origem — próprio para desenvolvimento.
 */
export function corsOrigins(
  env: NodeJS.ProcessEnv = process.env,
): string[] | true {
  const origins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  return origins.length === 0 || origins.includes('*') ? true : origins;
}

/**
 * Configuração HTTP comum à API em execução (main.ts) e aos testes E2E,
 * para que os testes validem exatamente as mesmas regras de produção.
 */
export function setupApp<T extends INestApplication>(app: T): T {
  // Validação global dos DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // remove chaves que não estão no DTO
      forbidNonWhitelisted: true, // e responde 400 se vierem campos extras
      transform: true, // converte o corpo para a classe do DTO (aplica os @Transform)
    }),
  );

  // Todo 401 no formato {statusCode, message, error}, com mensagem em português
  app.useGlobalFilters(new UnauthorizedExceptionFilter(app.getHttpAdapter()));

  // Libera os front-ends (web e app)
  const origin = corsOrigins();
  if (origin === true && isProduction()) {
    new Logger('CORS').warn(
      'CORS_ORIGINS vazio em produção: qualquer site pode chamar a API pelo navegador. Informe os domínios do site e do painel.',
    );
  }
  app.enableCors({
    origin,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  return app;
}
