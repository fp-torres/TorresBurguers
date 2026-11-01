import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Índices de desempenho (revisão de desempenho, leva 9). Nenhuma mudança de dados nem de contrato.
 * - users(LOWER(email)): login, cadastro, "esqueci a senha" e sessões buscam por LOWER(email); o
 *   UNIQUE(email) diferencia maiúsculas. NÃO é único: contas antigas podem diferir só na caixa;
 * - addresses(user_id): lista de endereços e checkout (e a FK vinda de users);
 * - payments abertos (order_id IS NULL), por loja e no geral: reservedOrderSlots (todo checkout),
 *   cobranças pendentes do cliente e a seleção da conciliação (a cada minuto);
 * - audit_logs(created_at, id): página da auditoria e eventos de login do superpainel;
 * - orders(store_id, updated_at) e o parcial dos pedidos abertos (store_id, created_at): o quadro de
 *   pedidos (polling de 5 s) e o alerta de estorno pendente do superpainel, sem ler o histórico;
 * - orders(driver_id, updated_at): quadro do entregador e a FK (purge da equipe);
 * - order_items("productId"): a FK (exclusão de produto e isInOrders);
 * - busca de contas do superpainel (ILIKE '%termo%' em nome e e-mail): índices GIN de trigramas,
 *   SÓ quando a extensão pg_trgm já existe ou pode ser criada por este usuário (superusuário, ou
 *   extensão "trusted" com permissão CREATE no banco). Sem isso a migration segue sem eles (a busca
 *   continua funcionando, só mais lenta) e avisa no log. down() não apaga a extensão.
 *
 * CREATE INDEX CONCURRENTLY (sem travar escritas em tabelas grandes) não roda dentro de transação:
 * esta migration tem transaction = false. IF NOT EXISTS: rodar de novo depois de uma falha no meio
 * continua de onde parou; um índice inválido (CONCURRENTLY interrompido) é apagado e recriado.
 * down() apaga os índices (sem CONCURRENTLY: a reversão roda numa transação).
 * Os índices simples também estão nas entidades; os de expressão, os parciais e os de trigramas
 * aparecem lá com synchronize:false (o TypeORM não compara expressão nem WHERE de forma estável).
 */
interface IndexSpec {
  name: string;
  definition: string;
}

const INDEXES: IndexSpec[] = [
  {
    name: 'IDX_users_email_lower',
    definition: `"users" (LOWER("email"))`,
  },
  {
    name: 'IDX_addresses_user_id',
    definition: `"addresses" ("user_id")`,
  },
  {
    name: 'IDX_payments_store_open',
    definition: `"payments" ("store_id", "created_at") WHERE "order_id" IS NULL`,
  },
  {
    name: 'IDX_payments_open_created',
    definition: `"payments" ("created_at") WHERE "order_id" IS NULL`,
  },
  {
    name: 'IDX_audit_logs_created',
    definition: `"audit_logs" ("created_at", "id")`,
  },
  {
    name: 'IDX_orders_store_updated_at',
    definition: `"orders" ("store_id", "updated_at")`,
  },
  {
    name: 'IDX_orders_store_open',
    definition: `"orders" ("store_id", "created_at") WHERE "status" NOT IN ('DONE', 'CANCELED') OR "payment_status" = 'REFUND_PENDING'`,
  },
  {
    name: 'IDX_orders_driver_updated_at',
    definition: `"orders" ("driver_id", "updated_at")`,
  },
  {
    name: 'IDX_order_items_product_id',
    definition: `"order_items" ("productId")`,
  },
];

/** Busca do superpainel por nome e e-mail (GET /platform/users?search=), com pg_trgm. */
const TRIGRAM_INDEXES: IndexSpec[] = [
  {
    name: 'IDX_users_name_trgm',
    definition: `"users" USING gin ("name" gin_trgm_ops)`,
  },
  {
    name: 'IDX_users_email_trgm',
    definition: `"users" USING gin ("email" gin_trgm_ops)`,
  },
];

const TRIGRAM_STATE_SQL = `
  SELECT
    EXISTS (SELECT 1 FROM "pg_extension" WHERE "extname" = 'pg_trgm') AS "installed",
    EXISTS (
      SELECT 1 FROM "pg_available_extension_versions" "v"
       WHERE "v"."name" = 'pg_trgm'
         AND (
           (SELECT "rolsuper" FROM "pg_roles" WHERE "rolname" = current_user)
           OR ("v"."trusted" AND has_database_privilege(current_database(), 'CREATE'))
         )
    ) AS "creatable"`;

export const TRIGRAM_UNAVAILABLE_WARNING =
  'PerformanceIndexes: extensão pg_trgm indisponível ou sem permissão para criá-la; a busca de contas do superpainel segue sem os índices de trigramas.';

export class PerformanceIndexes1793490000000 implements MigrationInterface {
  name = 'PerformanceIndexes1793490000000';
  /** CREATE INDEX CONCURRENTLY não pode rodar dentro de uma transação. */
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const index of INDEXES) await createIndex(queryRunner, index);
    if (await trigramReady(queryRunner)) {
      for (const index of TRIGRAM_INDEXES)
        await createIndex(queryRunner, index);
    } else {
      queryRunner.connection.logger.log('warn', TRIGRAM_UNAVAILABLE_WARNING);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const { name } of [...INDEXES, ...TRIGRAM_INDEXES].reverse()) {
      await queryRunner.query(`DROP INDEX IF EXISTS "public"."${name}"`);
    }
  }
}

/** pg_trgm instalada, ou instalada agora quando este usuário pode (superusuário ou "trusted" + CREATE). */
async function trigramReady(queryRunner: QueryRunner): Promise<boolean> {
  const [state] = (await queryRunner.query(TRIGRAM_STATE_SQL)) as {
    installed: boolean;
    creatable: boolean;
  }[];
  if (state?.installed) return true;
  if (!state?.creatable) return false;
  await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);
  return true;
}

async function createIndex(
  queryRunner: QueryRunner,
  { name, definition }: IndexSpec,
): Promise<void> {
  // Sobra de um CONCURRENTLY interrompido: existe, mas inválido (o IF NOT EXISTS pularia)
  const invalid = (await queryRunner.query(
    `SELECT 1 FROM "pg_index" "i" JOIN "pg_class" "c" ON "c"."oid" = "i"."indexrelid"
      WHERE "c"."relname" = $1 AND NOT "i"."indisvalid"`,
    [name],
  )) as unknown[];
  if (invalid.length) {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS "public"."${name}"`,
    );
  }
  await queryRunner.query(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${name}" ON ${definition}`,
  );
}
