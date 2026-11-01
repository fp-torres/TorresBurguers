import { DataSource, type DataSourceOptions } from 'typeorm';
import { BRAND } from '../config/brand';
import {
  dbMigrationsRun,
  dbPoolAcquireTimeoutMs,
  dbPoolSize,
  dbStatementTimeoutMs,
  dbSynchronize,
} from '../config/env';
import { ENTITIES } from './entities';
import { MIGRATIONS } from './migrations';

/**
 * Conexão com o PostgreSQL: a mesma para a API (AppModule) e para o CLI de migrations (data-source.ts).
 * Ordem na subida da API: primeiro as migrations pendentes (DB_MIGRATIONS_RUN), depois o synchronize
 * (DB_SYNCHRONIZE, ligado só em development/test), que não encontra diferenças quando o schema está em dia.
 */
export function typeOrmOptions(
  env: NodeJS.ProcessEnv = process.env,
): DataSourceOptions {
  return {
    type: 'postgres',
    host: env.DB_HOST || 'localhost',
    port: Number(env.DB_PORT) || 5432,
    username: env.DB_USERNAME || 'postgres',
    password: env.DB_PASSWORD ?? '',
    database: env.DB_DATABASE || BRAND.slug,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    migrationsTableName: 'migrations',
    // Cada migration roda na própria transação: uma falha desfaz só ela e interrompe a subida
    migrationsTransactionMode: 'each',
    migrationsRun: dbMigrationsRun(env),
    synchronize: dbSynchronize(env),
    // Isolamento entre lojas: por padrão o TypeORM IGNORA filtros null/undefined no where de find(),
    // então { store_id: undefined } devolveria dados de todas as lojas. Aqui isso vira erro (fail closed).
    // Para comparar com NULL use IsNull().
    invalidWhereValuesBehavior: { null: 'throw', undefined: 'throw' },
  };
}

/**
 * Conexão da API: a de typeOrmOptions com o tamanho do pool (DB_POOL_SIZE) e o tempo máximo de cada
 * consulta (DB_STATEMENT_TIMEOUT_MS): uma leitura pesada de uma loja não prende as conexões de todas.
 * As migrations pendentes NÃO rodam nesta conexão (migrationsRun: false): runStartupMigrations as
 * aplica antes, numa conexão própria e sem o limite (índices em tabelas grandes e migrations de dados
 * podem passar dele). O CLI de migrations (data-source.ts) também não tem o limite.
 */
export function apiTypeOrmOptions(
  env: NodeJS.ProcessEnv = process.env,
): DataSourceOptions {
  const timeout = dbStatementTimeoutMs(env);
  const acquire = dbPoolAcquireTimeoutMs(env);
  return {
    ...typeOrmOptions(env),
    migrationsRun: false,
    // Repassado ao pool do driver pg (max = conexões; statement_timeout vai na abertura da conexão;
    // connectionTimeoutMillis = espera máxima por uma conexão livre, DB_POOL_ACQUIRE_TIMEOUT_MS)
    extra: {
      max: dbPoolSize(env),
      ...(timeout > 0 ? { statement_timeout: timeout } : {}),
      ...(acquire > 0 ? { connectionTimeoutMillis: acquire } : {}),
    },
  };
}

/**
 * Migrations pendentes na subida da API (DB_MIGRATIONS_RUN), antes de abrir o pool da API: numa
 * conexão única, sem statement_timeout, uma transação por migration (como no CLI). Uma falha
 * interrompe a subida, como antes.
 */
export async function runStartupMigrations(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!dbMigrationsRun(env)) return;
  const dataSource = new DataSource({
    ...typeOrmOptions(env),
    migrationsRun: false,
    synchronize: false,
    extra: { max: 1 },
  });
  await dataSource.initialize();
  try {
    await dataSource.runMigrations({ transaction: 'each' });
  } finally {
    await dataSource.destroy();
  }
}
