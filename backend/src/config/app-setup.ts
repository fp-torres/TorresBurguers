import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import compression from 'compression';
import type {
  CorsOptions,
  CorsOptionsDelegate,
} from '@nestjs/common/interfaces/external/cors-options.interface';
import { json } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { UnauthorizedExceptionFilter } from '../common/filters/unauthorized-exception.filter';
import { authSessionWarnings, credentialOrigins } from './auth-session';
import { isProduction } from './env';

/** Documentação interativa (Swagger em /api): precisa de scripts e estilos próprios. */
function isDocsPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/') || path === '/api-json';
}

/**
 * Cabeçalhos de segurança de TODA resposta (sem dependência nova), inclusive dos arquivos de
 * /uploads (pasta compartilhada por todas as lojas):
 * - nosniff: o navegador nunca "adivinha" outro tipo de conteúdo;
 * - a API e os arquivos enviados não são páginas: CSP sem scripts, sem molduras (frame-ancestors) e,
 *   em /uploads, com sandbox (um arquivo que não fosse imagem não rodaria nada);
 * - Referrer-Policy sem vazar URLs; HSTS em produção (o navegador ignora em HTTP).
 */
export function securityHeaders(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // As imagens de /uploads são exibidas pelo site e pelo app em outra origem
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  const path = req.path ?? '';
  if (path.startsWith('/uploads/')) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox",
    );
  } else if (isDocsPath(path)) {
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  } else {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'",
    );
  }
  if (isProduction()) {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=15552000; includeSubDomains',
    );
  }
  next();
}

/**
 * Sem TRUST_PROXY, req.ip é o IP da conexão. Atrás de um túnel ou proxy (ngrok, Nginx, balanceador)
 * todas as requisições chegam com o MESMO IP: os limites por IP (ex.: falhas de login) viram um balde
 * único e poucas tentativas erradas bloqueiam o login de todo mundo. Avisa uma vez no log quando
 * chega um X-Forwarded-For/Forwarded com o TRUST_PROXY vazio.
 */
export function trustProxyWarning(
  logger: Pick<Logger, 'warn'> = new Logger('TrustProxy'),
): (req: Request, res: Response, next: NextFunction) => void {
  let warned = false;
  return (req, _res, next) => {
    if (
      !warned &&
      (req.headers['x-forwarded-for'] !== undefined ||
        req.headers.forwarded !== undefined)
    ) {
      warned = true;
      logger.warn(
        'A API recebeu X-Forwarded-For/Forwarded, mas TRUST_PROXY está vazio: atrás de túnel ou ' +
          'proxy todos os clientes parecem ter o mesmo IP e os limites por IP (login, cadastro) ' +
          'passam a ser compartilhados. Defina TRUST_PROXY (ex.: 1) quando houver um proxy de verdade na frente.',
      );
    }
    next();
  };
}

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

const CORS_METHODS = 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS';
/** Cache do preflight no navegador (Access-Control-Max-Age), em segundos. */
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * CORS por requisição:
 * - origens de credencial (credentialOrigins: AUTH_COOKIE_ORIGINS ou o CORS_ORIGINS explícito mais a origem
 *   de APP_WEB_URL) → Access-Control-Allow-Origin exato e Access-Control-Allow-Credentials: true (a sessão
 *   do site em cookie);
 * - as demais → a regra de sempre (corsOrigins), SEM credenciais. Nunca credenciais para "qualquer origem".
 * Preflight em cache por 10 min. Os cabeçalhos pedidos no preflight são refletidos (inclui X-Auth-Transport).
 */
export function corsOptionsDelegate(
  env: NodeJS.ProcessEnv = process.env,
): CorsOptionsDelegate<Request> {
  const origin = corsOrigins(env);
  const credentialed = new Set(credentialOrigins(env));
  const regular: CorsOptions = {
    origin,
    methods: CORS_METHODS,
    credentials: false,
    maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
  };
  return (req, callback) => {
    const requestOrigin = req.headers?.origin;
    if (typeof requestOrigin === 'string' && credentialed.has(requestOrigin)) {
      callback(null, {
        origin: requestOrigin,
        methods: CORS_METHODS,
        credentials: true,
        maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
      });
      return;
    }
    callback(null, regular);
  };
}

/**
 * TRUST_PROXY: atrás de proxy/túnel/balanceador, o IP real do cliente vem do X-Forwarded-For.
 * Aceita número de saltos (ex.: 1), uma lista de IPs/sub-redes dos proxies (ex.: loopback,10.0.0.0/8)
 * ou false. Vazio = desligado (req.ip é o IP da conexão). Usado na auditoria e nos limites de
 * tentativas: ligar sem um proxy de verdade na frente deixa o cliente forjar o IP.
 * "true" vira 1 salto: no Express, true confia no X-Forwarded-For INTEIRO e usa a entrada mais à
 * esquerda, que é a que o cliente escreveu (Nginx, balanceadores e túneis só ACRESCENTAM o IP real
 * ao valor recebido). Com 1, vale o IP acrescentado pelo proxy da frente.
 */
export function trustProxySetting(
  env: NodeJS.ProcessEnv = process.env,
): false | number | string | undefined {
  const raw = env.TRUST_PROXY?.trim();
  if (!raw) return undefined;
  if (/^true$/i.test(raw)) return 1;
  if (/^false$/i.test(raw)) return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

const TRUST_PROXY_TRUE_WARNING =
  'TRUST_PROXY=true confiaria no X-Forwarded-For inteiro (o cliente escolheria o próprio IP e furaria ' +
  'os limites por IP): usando 1 salto. Informe o número de proxies na frente da API (ex.: 1) ou os ' +
  'IPs/sub-redes deles.';

/**
 * Tamanho máximo do corpo JSON (depois de descomprimido). O padrão (100 KB, o mesmo do Express) cobre
 * todas as rotas: um pedido no limite (50 linhas × 50 adicionais, observações) fica em ~30 KB. O maior
 * JSON legítimo é o das configurações da loja com as zonas de entrega: até 50 zonas × 200 bairros de
 * até 80 caracteres, mais cidades e faixas de CEP, ~1 MB no limite da validação (até ~2 MB com
 * acentos, 2 bytes cada em UTF-8). Por isso /store/settings tem o próprio teto.
 */
export const JSON_BODY_LIMIT = '100kb';
export const STORE_SETTINGS_JSON_BODY_LIMIT = '2mb';

export const BODY_TOO_LARGE_MESSAGE =
  'O corpo da requisição passa do tamanho permitido.';
export const BODY_INVALID_MESSAGE =
  'Corpo da requisição inválido: JSON malformado ou compressão inválida.';
export const BODY_ENCODING_UNSUPPORTED_MESSAGE =
  'Codificação ou charset do corpo da requisição não suportado.';

const BODY_ERRORS: Record<number, { message: string; error: string }> = {
  400: { message: BODY_INVALID_MESSAGE, error: 'Bad Request' },
  413: { message: BODY_TOO_LARGE_MESSAGE, error: 'Payload Too Large' },
  415: {
    message: BODY_ENCODING_UNSUPPORTED_MESSAGE,
    error: 'Unsupported Media Type',
  },
};

/**
 * Erros dos parsers do corpo (body-parser: corpo grande demais, JSON malformado, compressão inválida,
 * codificação ou charset não suportado). São erros do cliente: mesmo status (400, 413 ou 415), formato
 * { statusCode, message, error } em português e nada no log. Sem isto caíam no ExceptionsHandler do
 * Nest, que registra ERROR com stack a cada corpo ruim (e a mensagem saía em inglês). Fica logo depois
 * dos parsers: só os erros deles chegam aqui; os demais seguem adiante.
 */
export function bodyParserErrors(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const error = err as { status?: unknown; expose?: unknown } | null;
  const status = typeof error?.status === 'number' ? error.status : null;
  const known = status !== null ? BODY_ERRORS[status] : undefined;
  if (!known || error?.expose !== true || res.headersSent) {
    next(err);
    return;
  }
  res.status(status as number).json({ statusCode: status, ...known });
}

/** Cache das imagens de /uploads no navegador (30 dias, imutável). */
export const UPLOADS_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Opções do /uploads estático (ServeStaticModule do AppModule; os testes usam as mesmas).
 * - exclude: sem ele, o "fallback de SPA" do @nestjs/serve-static responde o 404 de
 *   /uploads/<inexistente> com o caminho absoluto do servidor (ENOENT de <pasta>/index.html);
 * - nomes únicos (data + aleatório, gravados com a flag wx: nunca sobrescritos) → cache longo e
 *   imutável no navegador; trocar uma imagem sempre gera um nome novo.
 */
export function uploadsStaticOptions(rootPath: string) {
  return {
    rootPath,
    serveRoot: '/uploads',
    exclude: ['/uploads/*path'],
    serveStaticOptions: {
      index: false,
      redirect: false,
      fallthrough: true,
      maxAge: UPLOADS_CACHE_MAX_AGE_MS,
      immutable: true,
    },
  };
}

/**
 * Compressão das respostas (gzip/deflate/br conforme o Accept-Encoding): o quadro de pedidos, pedido
 * a cada 5 s, tem centenas de KB de JSON. Só acima de 1 KB e só tipos compressíveis (o filtro padrão
 * olha o Content-Type: as imagens de /uploads, já comprimidas, passam direto). Sem risco de BREACH:
 * a API se autentica pelo cabeçalho Authorization; o único cookie (refresh da sessão do site) só é
 * lido em /auth/web/* e nas emissões de sessão, exige o cabeçalho X-Auth-Transport (preflight só para
 * as origens de credencial) e essas respostas não refletem nada enviado por outro site.
 */
export function compressionMiddleware() {
  return compression({ threshold: 1024 });
}

/**
 * Configuração HTTP comum à API em execução (main.ts) e aos testes E2E,
 * para que os testes validem exatamente as mesmas regras de produção.
 */
export function setupApp<T extends INestApplication>(app: T): T {
  const express = app.getHttpAdapter().getInstance() as {
    set?: (key: string, value: unknown) => void;
    disable?: (key: string) => void;
  };
  // Não anuncia o servidor (X-Powered-By: Express)
  express.disable?.('x-powered-by');

  const trustProxy = trustProxySetting();
  if (/^true$/i.test(process.env.TRUST_PROXY?.trim() ?? '')) {
    new Logger('TrustProxy').warn(TRUST_PROXY_TRUE_WARNING);
  }
  if (trustProxy !== undefined) {
    express.set?.('trust proxy', trustProxy);
  } else {
    app.use(trustProxyWarning());
  }

  // Cabeçalhos de segurança (antes do /uploads estático, registrado na inicialização dos módulos)
  app.use(securityHeaders);

  // Respostas comprimidas e teto do corpo JSON (registrados antes dos parsers padrão do Nest, que
  // então não são adicionados de novo: o da rota de configurações vem antes do geral)
  app.use(compressionMiddleware());
  app.use('/store/settings', json({ limit: STORE_SETTINGS_JSON_BODY_LIMIT }));
  app.use(json({ limit: JSON_BODY_LIMIT }));
  app.use(bodyParserErrors);

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
  // A autenticação vai no cabeçalho Authorization; só a sessão do site em cookie (/auth/web/*) usa
  // credenciais, e só para as origens de credencial
  for (const warning of authSessionWarnings()) {
    new Logger('SessaoWeb').warn(warning);
  }
  app.enableCors(corsOptionsDelegate());

  return app;
}
