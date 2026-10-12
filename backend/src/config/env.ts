import { Logger } from '@nestjs/common';

/**
 * Leitura das variáveis de ambiente que mudam o comportamento de segurança da API.
 *
 * Regra geral (fail closed): só NODE_ENV=development ou NODE_ENV=test liberam as facilidades de
 * desenvolvimento: usuários de demonstração, segredo JWT padrão, sandbox automático de pagamentos
 * e DB_SYNCHRONIZE ligado por padrão. Vazio, ausente ou qualquer outro valor ("prod", "staging",
 * erro de digitação...) é tratado como produção.
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
 * TypeORM synchronize (cria/ajusta as tabelas a partir das entidades).
 * Padrão: ligado em development/test e desligado em produção. DB_SYNCHRONIZE=true|false decide.
 */
export function dbSynchronize(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag('DB_SYNCHRONIZE', isDevOrTest(env), env);
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
  return warnings;
}
