import {
  dbPoolAcquireTimeoutMs,
  dbPoolSize,
  dbStatementTimeoutMs,
} from '../config/env';
import { apiTypeOrmOptions, typeOrmOptions } from './typeorm.config';

const extraOf = (options: object) =>
  (options as { extra?: Record<string, unknown> }).extra;

describe('Conexão com o banco: pool e statement_timeout só na API', () => {
  it('API: pool de DB_POOL_SIZE (padrão 10), statement_timeout de DB_STATEMENT_TIMEOUT_MS (padrão 60 s) e espera por conexão de DB_POOL_ACQUIRE_TIMEOUT_MS (padrão 30 s)', () => {
    const defaults = apiTypeOrmOptions({});
    expect(extraOf(defaults)).toEqual({
      max: 10,
      statement_timeout: 60_000,
      connectionTimeoutMillis: 30_000,
    });
    // As migrations da subida rodam antes, numa conexão própria (runStartupMigrations)
    expect(defaults.migrationsRun).toBe(false);

    const tuned = apiTypeOrmOptions({
      DB_POOL_SIZE: '25',
      DB_STATEMENT_TIMEOUT_MS: '15000',
      DB_POOL_ACQUIRE_TIMEOUT_MS: '5000',
    });
    expect(extraOf(tuned)).toEqual({
      max: 25,
      statement_timeout: 15_000,
      connectionTimeoutMillis: 5_000,
    });

    // 0 desliga cada limite
    expect(
      extraOf(
        apiTypeOrmOptions({
          DB_STATEMENT_TIMEOUT_MS: '0',
          DB_POOL_ACQUIRE_TIMEOUT_MS: '0',
        }),
      ),
    ).toEqual({ max: 10 });
  });

  it('CLI de migrations (typeOrmOptions): sem statement_timeout', () => {
    const cli = typeOrmOptions({ DB_STATEMENT_TIMEOUT_MS: '1000' });
    expect(extraOf(cli)).toBeUndefined();
    expect(cli.migrationsTransactionMode).toBe('each');
  });

  it('valores inválidos ou fora da faixa → o padrão', () => {
    for (const raw of ['', 'muitos', '-1', '0', '1000', '2.5'])
      expect(dbPoolSize({ DB_POOL_SIZE: raw })).toBe(10);
    expect(dbPoolSize({ DB_POOL_SIZE: '1' })).toBe(1);
    expect(dbPoolSize({ DB_POOL_SIZE: '200' })).toBe(200);
    for (const raw of ['', 'rapido', '-5', '1.5'])
      expect(dbStatementTimeoutMs({ DB_STATEMENT_TIMEOUT_MS: raw })).toBe(
        60_000,
      );
    for (const raw of ['', 'logo', '-5', '1.5', '999999999'])
      expect(dbPoolAcquireTimeoutMs({ DB_POOL_ACQUIRE_TIMEOUT_MS: raw })).toBe(
        30_000,
      );
  });
});
