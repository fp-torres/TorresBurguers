import type { QueryRunner } from 'typeorm';
import {
  PerformanceIndexes1793490000000,
  TRIGRAM_UNAVAILABLE_WARNING,
} from './1793490000000-PerformanceIndexes';
import { MIGRATIONS } from './index';

/**
 * QueryRunner falso: registra o SQL; `invalid` lista os índices que a consulta de inválidos devolve e
 * `trigram` é o estado da extensão pg_trgm.
 */
function fakeRunner(
  invalid: string[] = [],
  trigram = { installed: false, creatable: true },
) {
  const statements: string[] = [];
  const log = jest.fn();
  const runner = {
    connection: { logger: { log } },
    query: jest.fn((sql: string, params?: unknown[]) => {
      statements.push(sql);
      if (sql.includes('"indisvalid"'))
        return Promise.resolve(
          invalid.includes(String(params?.[0])) ? [{ '?column?': 1 }] : [],
        );
      if (sql.includes('"pg_available_extension_versions"'))
        return Promise.resolve([trigram]);
      return Promise.resolve([]);
    }),
  };
  return { runner: runner as unknown as QueryRunner, statements, log };
}

const TRIGRAM_NAMES = ['IDX_users_name_trgm', 'IDX_users_email_trgm'];

const NAMES = [
  'IDX_users_email_lower',
  'IDX_addresses_user_id',
  'IDX_payments_store_open',
  'IDX_payments_open_created',
  'IDX_audit_logs_created',
  'IDX_orders_store_updated_at',
  'IDX_orders_store_open',
  'IDX_orders_driver_updated_at',
  'IDX_order_items_product_id',
];

describe('PerformanceIndexes (índices sem travar tabelas grandes)', () => {
  it('registrada na lista, depois de StoreSlugHistoryAndCancelOrigin', () => {
    const names = MIGRATIONS.map((migration) => migration.name);
    const position = names.indexOf('PerformanceIndexes1793490000000');
    expect(position).toBeGreaterThan(
      names.indexOf('StoreSlugHistoryAndCancelOrigin1793485300000'),
    );
  });

  it('fora de transação, com CREATE INDEX CONCURRENTLY IF NOT EXISTS de cada índice', async () => {
    const migration = new PerformanceIndexes1793490000000();
    expect(migration.transaction).toBe(false);
    const { runner, statements } = fakeRunner();
    await migration.up(runner);
    const creates = statements.filter((sql) => sql.startsWith('CREATE INDEX'));
    expect(creates).toHaveLength(NAMES.length + TRIGRAM_NAMES.length);
    for (const [index, name] of [...NAMES, ...TRIGRAM_NAMES].entries())
      expect(creates[index]).toContain(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${name}" ON`,
      );
    // Nenhum é único (contas antigas podem diferir só na caixa do e-mail)
    expect(creates.join('\n')).not.toContain('UNIQUE');
    expect(creates[0]).toContain('(LOWER("email"))');
    expect(
      creates.find((sql) => sql.includes('IDX_orders_store_open')),
    ).toContain(
      `WHERE "status" NOT IN ('DONE', 'CANCELED') OR "payment_status" = 'REFUND_PENDING'`,
    );
    expect(statements.some((sql) => sql.startsWith('DROP'))).toBe(false);
    // pg_trgm criada (permitida) antes dos índices GIN de trigramas
    const extension = statements.indexOf(
      'CREATE EXTENSION IF NOT EXISTS "pg_trgm"',
    );
    expect(extension).toBeGreaterThan(-1);
    expect(
      statements.findIndex((sql) => sql.includes('IDX_users_name_trgm')),
    ).toBeGreaterThan(extension);
    expect(creates.at(-1)).toContain('USING gin ("email" gin_trgm_ops)');
  });

  it('pg_trgm já instalada: não cria a extensão de novo; sem pg_trgm (ou sem permissão): segue sem os índices de trigramas e avisa', async () => {
    const installed = fakeRunner([], { installed: true, creatable: false });
    await new PerformanceIndexes1793490000000().up(installed.runner);
    expect(installed.statements.join(' ')).not.toContain('CREATE EXTENSION');
    expect(installed.statements.join(' ')).toContain('IDX_users_name_trgm');

    const unavailable = fakeRunner([], { installed: false, creatable: false });
    await new PerformanceIndexes1793490000000().up(unavailable.runner);
    const sql = unavailable.statements.join(' ');
    expect(sql).not.toContain('CREATE EXTENSION');
    expect(sql).not.toContain('gin_trgm_ops');
    // Os outros índices são criados normalmente
    expect(sql).toContain('IDX_order_items_product_id');
    expect(unavailable.log).toHaveBeenCalledWith(
      'warn',
      TRIGRAM_UNAVAILABLE_WARNING,
    );
  });

  it('índice inválido (CONCURRENTLY interrompido) é apagado e recriado; os válidos ficam', async () => {
    const { runner, statements } = fakeRunner(['IDX_orders_store_open']);
    await new PerformanceIndexes1793490000000().up(runner);
    const drops = statements.filter((sql) => sql.startsWith('DROP'));
    expect(drops).toEqual([
      'DROP INDEX CONCURRENTLY IF EXISTS "public"."IDX_orders_store_open"',
    ]);
    const dropAt = statements.indexOf(drops[0]);
    expect(statements[dropAt + 1]).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_orders_store_open"',
    );
  });

  it('down() apaga os índices (sem CONCURRENTLY: a reversão roda numa transação)', async () => {
    const { runner, statements } = fakeRunner();
    await new PerformanceIndexes1793490000000().down(runner);
    expect(statements).toEqual(
      [...NAMES, ...TRIGRAM_NAMES]
        .reverse()
        .map((name) => `DROP INDEX IF EXISTS "public"."${name}"`),
    );
  });
});
