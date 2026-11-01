import type { QueryRunner } from 'typeorm';
import { OrderNumbersAndCustomerBlocks1792963851057 } from './1792963851057-OrderNumbersAndCustomerBlocks';
import { MIGRATIONS } from './index';

/** QueryRunner falso: só registra o SQL (a semântica é conferida no banco real pelo E2E). */
function fakeRunner(blocks = 0) {
  const statements: string[] = [];
  const runner = {
    query: jest.fn((sql: string) => {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      // Contagem do down(): quantos bloqueios de clientes estão gravados
      if (sql.includes('AS "blocks"')) return Promise.resolve([{ blocks }]);
      return Promise.resolve([]);
    }),
  };
  return { runner: runner as unknown as QueryRunner, statements };
}

const indexOf = (statements: string[], fragment: string): number => {
  const index = statements.findIndex((sql) => sql.includes(fragment));
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
};

describe('OrderNumbersAndCustomerBlocks (número do pedido por loja e bloqueio de clientes)', () => {
  const migration = new OrderNumbersAndCustomerBlocks1792963851057();

  it('está registrada por último na lista de migrations', () => {
    expect(MIGRATIONS).toContain(OrderNumbersAndCustomerBlocks1792963851057);
    expect(migration.name).toBe('OrderNumbersAndCustomerBlocks1792963851057');
  });

  it('up: backfill 1..N por loja na ordem de criação ANTES de NOT NULL e do índice único', async () => {
    const { runner, statements } = fakeRunner();
    await migration.up(runner);

    const addColumn = indexOf(
      statements,
      'ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "number" integer',
    );
    const backfill = indexOf(
      statements,
      'ROW_NUMBER() OVER (PARTITION BY "store_id" ORDER BY "created_at", "id")',
    );
    const notNull = indexOf(
      statements,
      'ALTER TABLE "orders" ALTER COLUMN "number" SET NOT NULL',
    );
    const unique = indexOf(
      statements,
      'CREATE UNIQUE INDEX "UQ_orders_store_number" ON "orders" ("store_id", "number")',
    );
    expect(addColumn).toBeLessThan(backfill);
    expect(backfill).toBeLessThan(notNull);
    expect(notNull).toBeLessThan(unique);
    // O backfill atualiza TODAS as linhas (renumera também o que um synchronize tenha deixado)
    expect(statements[backfill]).not.toContain('IS NULL');
  });

  it('up: contador por loja começa no último número do backfill e o gatilho numera todo INSERT', async () => {
    const { runner, statements } = fakeRunner();
    await migration.up(runner);

    const counters = indexOf(statements, 'CREATE TABLE "store_order_counters"');
    const seed = indexOf(
      statements,
      'INSERT INTO "store_order_counters" ("store_id", "last_number") SELECT "store_id", MAX("number") FROM "orders" GROUP BY "store_id"',
    );
    const fn = indexOf(
      statements,
      'CREATE OR REPLACE FUNCTION "orders_assign_number"()',
    );
    const trigger = indexOf(
      statements,
      'CREATE TRIGGER "TRG_orders_assign_number" BEFORE INSERT ON "orders" FOR EACH ROW',
    );
    expect(counters).toBeLessThan(seed);
    expect(seed).toBeLessThan(trigger);
    expect(fn).toBeLessThan(trigger);
    expect(statements[counters]).toContain(
      'FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE',
    );
    // Trava a linha do contador da loja (upsert) e sempre sobrescreve o número enviado
    expect(statements[fn]).toContain(
      'ON CONFLICT ("store_id") DO UPDATE SET "last_number" = "counter"."last_number" + 1',
    );
    expect(statements[fn]).toContain(
      'RETURNING "last_number" INTO NEW."number"',
    );
    expect(statements[fn]).not.toContain('IF NEW."number" IS NULL');

    const immutable = indexOf(
      statements,
      'CREATE TRIGGER "TRG_orders_number_immutable" BEFORE UPDATE OF "number" ON "orders"',
    );
    expect(immutable).toBeGreaterThan(seed);
  });

  it('up: store_customer_blocks com PK loja + cliente, FKs e loja imutável', async () => {
    const { runner, statements } = fakeRunner();
    await migration.up(runner);

    const table =
      statements[indexOf(statements, 'CREATE TABLE "store_customer_blocks"')];
    expect(table).toContain(
      'CONSTRAINT "PK_store_customer_blocks" PRIMARY KEY ("store_id", "user_id")',
    );
    expect(table).toContain('"reason" character varying(300) NOT NULL');
    expect(table).toContain('"blocked_by_user_id" integer,');
    expect(table).toContain(
      '"blocked_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()',
    );
    indexOf(
      statements,
      'FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT',
    );
    indexOf(
      statements,
      'FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE',
    );
    indexOf(
      statements,
      'FOREIGN KEY ("blocked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL',
    );
    indexOf(
      statements,
      'CREATE INDEX "IDX_store_customer_blocks_user_id" ON "store_customer_blocks" ("user_id")',
    );
    indexOf(
      statements,
      'BEFORE UPDATE OF "store_id" ON "store_customer_blocks" FOR EACH ROW EXECUTE FUNCTION "tenant_store_id_immutable"()',
    );
  });

  it('down: desfaz tudo, com os gatilhos antes do contador e a coluna por último', async () => {
    const { runner, statements } = fakeRunner();
    await migration.down(runner);

    const dropBlocks = indexOf(
      statements,
      'DROP TABLE "store_customer_blocks"',
    );
    const dropAssign = indexOf(
      statements,
      'DROP TRIGGER IF EXISTS "TRG_orders_assign_number" ON "orders"',
    );
    const dropImmutable = indexOf(
      statements,
      'DROP TRIGGER IF EXISTS "TRG_orders_number_immutable" ON "orders"',
    );
    const dropCounters = indexOf(
      statements,
      'DROP TABLE IF EXISTS "store_order_counters"',
    );
    const dropIndex = indexOf(
      statements,
      'DROP INDEX "public"."UQ_orders_store_number"',
    );
    const dropColumn = indexOf(
      statements,
      'ALTER TABLE "orders" DROP COLUMN "number"',
    );
    expect(dropBlocks).toBeLessThan(dropCounters);
    expect(dropAssign).toBeLessThan(dropCounters);
    expect(dropImmutable).toBeLessThan(dropColumn);
    expect(dropIndex).toBeLessThan(dropColumn);
    expect(dropColumn).toBe(statements.length - 1);
    indexOf(statements, 'DROP FUNCTION IF EXISTS "orders_assign_number"()');
    indexOf(statements, 'DROP FUNCTION IF EXISTS "orders_number_immutable"()');
  });

  describe('down com bloqueios de clientes gravados', () => {
    const saved = process.env.DB_ALLOW_DESTRUCTIVE_REVERT;
    afterEach(() => {
      if (saved === undefined) delete process.env.DB_ALLOW_DESTRUCTIVE_REVERT;
      else process.env.DB_ALLOW_DESTRUCTIVE_REVERT = saved;
    });

    it('recusa e não apaga nada sem DB_ALLOW_DESTRUCTIVE_REVERT', async () => {
      delete process.env.DB_ALLOW_DESTRUCTIVE_REVERT;
      const { runner, statements } = fakeRunner(3);
      await expect(migration.down(runner)).rejects.toThrow(
        /Reversão recusada: ela apagaria 3 bloqueio\(s\) de clientes.*DB_ALLOW_DESTRUCTIVE_REVERT=true/,
      );
      expect(statements.filter((sql) => /\bDROP\b/.test(sql))).toEqual([]);
    });

    it('com DB_ALLOW_DESTRUCTIVE_REVERT=true a reversão segue', async () => {
      process.env.DB_ALLOW_DESTRUCTIVE_REVERT = 'true';
      const { runner, statements } = fakeRunner(3);
      await migration.down(runner);
      indexOf(statements, 'DROP TABLE "store_customer_blocks"');
    });
  });
});
