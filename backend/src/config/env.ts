import { Logger } from '@nestjs/common';

/**
 * Leitura das variáveis de ambiente que mudam o comportamento de segurança da API.
 *
 * Regra geral (fail closed): só NODE_ENV=development ou NODE_ENV=test liberam as facilidades de
 * desenvolvimento: usuários de demonstração, segredo JWT padrão e sandbox automático de pagamentos.
 * Vazio, ausente ou qualquer outro valor ("prod", "staging", erro de digitação...) é tratado como produção.
 */
export type RuntimeEnv = 'development' | 'test' | 'production';

const logger = new Logger('Ambiente');

const TRUE_VALUES = ['true', '1', 'yes', 'sim', 'on'];
const FALSE_VALUES = ['false', '0', 'no', 'nao', 'não', 'off'];

// Um aviso por variável/valor desconhecido (a mesma flag pode ser lida várias vezes)
const warnedFlags = new Set<string>();

/**
 * Leitura tolerante de variáveis de ambiente booleanas.
 * Aceita true/false, 1/0, yes/no, sim/não, on/off (sem diferenciar maiúsculas).
 * Vazia → usa o padrão informado. Valor desconhecido (ex.: "fasle") → aviso no log e usa o padrão.
 */
export function envFlag(
  name: string,
  fallback: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (TRUE_VALUES.includes(raw)) return true;
  if (FALSE_VALUES.includes(raw)) return false;

  const key = `${name}=${raw}`;
  if (!warnedFlags.has(key)) {
    warnedFlags.add(key);
    logger.warn(
      `${name}="${env[name]?.trim()}" não é um valor reconhecido (use true ou false). Usando o padrão: ${fallback}.`,
    );
  }
  return fallback;
}

/** Ambiente de execução: development ou test só quando escritos assim; o resto conta como produção. */
export function runtimeEnv(env: NodeJS.ProcessEnv = process.env): RuntimeEnv {
  const value = env.NODE_ENV?.trim().toLowerCase();
  return value === 'development' || value === 'test' ? value : 'production';
}

/** NODE_ENV=development ou test: as facilidades de desenvolvimento podem ser usadas. */
export function isDevOrTest(env: NodeJS.ProcessEnv = process.env): boolean {
  return runtimeEnv(env) !== 'production';
}

/** Produção, inclusive com NODE_ENV vazio ou desconhecido. */
export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return runtimeEnv(env) === 'production';
}

/**
 * TypeORM synchronize (cria/ajusta as tabelas a partir das entidades, sem migration).
 * Padrão: DESLIGADO em todos os ambientes — o schema vem das migrations (src/database/migrations),
 * as mesmas em desenvolvimento, testes e produção. DB_SYNCHRONIZE=true só para experimentos locais
 * (roda depois das migrations e pode esconder uma migration esquecida).
 */
export function dbSynchronize(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag('DB_SYNCHRONIZE', false, env);
}

/**
 * Migrations pendentes (src/database/migrations) aplicadas na subida da API, antes do synchronize.
 * Padrão: ligado em todos os ambientes. Com várias instâncias da API, deixe DB_MIGRATIONS_RUN=false
 * nelas e rode "npm run migration:run:prod" uma única vez no deploy.
 */
export function dbMigrationsRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag('DB_MIGRATIONS_RUN', true, env);
}

/** Inteiro de min a max na variável; vazio ou inválido → o padrão. */
function envInteger(
  name: string,
  fallback: number,
  min: number,
  max: number,
  env: NodeJS.ProcessEnv,
): number {
  const raw = env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return value >= min && value <= max ? value : fallback;
}

/** Conexões no pool da API (DB_POOL_SIZE, de 1 a 200). Padrão: 10, o mesmo do driver pg. */
export function dbPoolSize(env: NodeJS.ProcessEnv = process.env): number {
  return envInteger('DB_POOL_SIZE', 10, 1, 200, env);
}

/**
 * Tempo máximo de uma consulta da API, em ms (DB_STATEMENT_TIMEOUT_MS; 0 desliga). Padrão: 60 s.
 * Vale só para as conexões da API: as migrations (na subida e no CLI) rodam sem esse limite.
 */
export function dbStatementTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return envInteger('DB_STATEMENT_TIMEOUT_MS', 60_000, 0, 86_400_000, env);
}

/**
 * Espera máxima, em ms, por uma conexão livre do pool da API (DB_POOL_ACQUIRE_TIMEOUT_MS, até 10 min;
 * 0 = sem limite, o padrão do driver pg). Padrão: 30 s. Com o pool esgotado, a requisição falha em vez
 * de esperar para sempre (abaixo dos 60 s do proxy_read_timeout do Nginx do Docker).
 */
export function dbPoolAcquireTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return envInteger('DB_POOL_ACQUIRE_TIMEOUT_MS', 30_000, 0, 600_000, env);
}

/**
 * Por quanto tempo (ms) o dashboard e o financeiro do superpainel reaproveitam o último resultado
 * (PLATFORM_INSIGHTS_CACHE_MS; 0 desliga). Padrão: 30 s.
 */
export function platformInsightsCacheMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return envInteger('PLATFORM_INSIGHTS_CACHE_MS', 30_000, 0, 3_600_000, env);
}

/**
 * Documentação interativa (Swagger) em /api. Padrão: ligada em development/test e desligada em
 * produção (expõe todas as rotas e DTOs, inclusive as do superpainel). SWAGGER_ENABLED=true|false decide.
 */
export function swaggerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag('SWAGGER_ENABLED', isDevOrTest(env), env);
}

/**
 * Usuários padrão (senhas públicas, documentadas no README) na subida da API:
 * - 'seed': criar os que faltam (development/test, a menos que SEED_DEMO_USERS=false);
 * - 'off': não criar;
 * - 'refused': SEED_DEMO_USERS=true em produção. Nunca cria; a subida registra um erro no log.
 */
export function demoUsersSeedMode(
  env: NodeJS.ProcessEnv = process.env,
): 'seed' | 'off' | 'refused' {
  if (!envFlag('SEED_DEMO_USERS', isDevOrTest(env), env)) return 'off';
  return isDevOrTest(env) ? 'seed' : 'refused';
}

/**
 * Superadmin de DEMONSTRAÇÃO (senha pública, papel global sobre todas as lojas) entre os usuários padrão:
 * - test: incluído (a suíte E2E entra com ele), a menos que SEED_DEMO_SUPERADMIN=false;
 * - development: só com SEED_DEMO_SUPERADMIN=true (opção explícita: a API de desenvolvimento costuma
 *   ficar acessível na rede ou pelo túnel do app mobile);
 * - produção: nunca (o primeiro superadmin vem do comando platform:superadmin, com senha aleatória).
 */
export function demoSuperadminSeedAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const mode = runtimeEnv(env);
  if (mode === 'production') return false;
  return envFlag('SEED_DEMO_SUPERADMIN', mode === 'test', env);
}

/** Avisos de configuração exibidos na subida da API (nenhum valor secreto aparece). */
export function environmentWarnings(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (isDevOrTest(env)) return [];

  const warnings: string[] = [];
  const raw = env.NODE_ENV?.trim();
  if (!raw) {
    warnings.push(
      'NODE_ENV não definido: a API segue as regras de produção. Em máquinas de desenvolvimento use NODE_ENV=development.',
    );
  } else if (raw.toLowerCase() !== 'production') {
    warnings.push(
      `NODE_ENV="${raw}" não é reconhecido (use development, test ou production): a API segue as regras de produção.`,
    );
  }
  if (dbSynchronize(env)) {
    warnings.push(
      'DB_SYNCHRONIZE ligado em produção: o TypeORM altera o schema sozinho e pode apagar colunas. Prefira migrations com DB_SYNCHRONIZE=false.',
    );
  }
  const credentialsKey = env.CREDENTIALS_ENCRYPTION_KEY?.trim();
  if (!credentialsKey) {
    warnings.push(
      'CREDENTIALS_ENCRYPTION_KEY não definida: as lojas não conseguirão gravar nem usar credenciais próprias do Mercado Pago. Defina uma chave de 32 bytes (base64 ou hex).',
    );
  } else if (!isCredentialsKeyFormat(credentialsKey)) {
    warnings.push(
      'CREDENTIALS_ENCRYPTION_KEY inválida: use 32 bytes em base64 (44 caracteres) ou hex (64 caracteres). As credenciais das lojas ficarão indisponíveis.',
    );
  }
  return warnings;
}

/** 32 bytes em hex (64 caracteres) ou base64 — mesma regra de common/crypto/secret-box.ts. */
function isCredentialsKeyFormat(raw: string): boolean {
  if (/^[0-9a-f]{64}$/i.test(raw)) return true;
  return (
    /^[A-Za-z0-9+/]+={0,2}$/.test(raw) &&
    Buffer.from(raw, 'base64').length === 32
  );
}
