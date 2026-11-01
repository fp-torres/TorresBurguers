import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pedidos por loja:
 *
 * 1. Número do pedido NA LOJA (orders.number: 1, 2, 3...). O id é global e sequencial: mostrado ao
 *    cliente, revelava o volume de pedidos das outras lojas. O id continua sendo a chave das rotas
 *    (e do app mobile); o número é o que as telas mostram.
 *    - Backfill: por loja, na ordem de criação (empate: id), então os pedidos antigos ficam 1..N.
 *    - Depois: NOT NULL e UQ_orders_store_number (loja + número).
 *    - Contador por loja em store_order_counters (last_number = último número usado). Fica numa tabela
 *      própria (e não em stores) para que a trava de linha da numeração não dispute com as escritas da
 *      própria loja (configurações, status, assinatura). A tabela não tem entidade: só o gatilho a usa
 *      (o synchronize do TypeORM nunca mexe em tabelas sem entidade).
 *    - TRG_orders_assign_number (BEFORE INSERT): TODO caminho que cria pedido (pago na entrega, criado
 *      pelo pagamento aprovado, SQL de suporte) recebe o próximo número. O INSERT ... ON CONFLICT DO
 *      UPDATE trava a linha do contador da loja até o fim da transação do pedido: pedidos simultâneos da
 *      mesma loja esperam a vez (sem número repetido) e um pedido desfeito (rollback) devolve o número
 *      (sem buraco). Lojas diferentes não se esperam. Um número enviado no INSERT é ignorado.
 *    - TRG_orders_number_immutable: o número nunca muda depois de gravado.
 * 2. store_customer_blocks: cliente bloqueado por uma loja (PK loja + cliente; motivo, quem bloqueou,
 *    quando). O cliente continua comprando nas outras lojas. store_id imutável (tenant_store_id_immutable
 *    da MultiTenantFoundation).
 *
 * down() remove tudo: os números dos pedidos e os bloqueios se perdem (os bloqueios continuam na auditoria).
 * Com bloqueios gravados, a reversão é recusada, a menos que DB_ALLOW_DESTRUCTIVE_REVERT=true (como na
 * MultiTenantFoundation): clientes bloqueados voltariam a comprar sem ninguém perceber.
 */
const DESTRUCTIVE_REVERT_FLAG = 'DB_ALLOW_DESTRUCTIVE_REVERT';

function destructiveRevertAllowed(env: NodeJS.ProcessEnv): boolean {
  const raw = env[DESTRUCTIVE_REVERT_FLAG]?.trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'sim';
}

export class OrderNumbersAndCustomerBlocks1792963851057 implements MigrationInterface {
  name = 'OrderNumbersAndCustomerBlocks1792963851057';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.addOrderNumbers(queryRunner);
    await this.createCustomerBlocks(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [row] = (await queryRunner.query(
      `SELECT COUNT(*)::int AS "blocks" FROM "store_customer_blocks"`,
    )) as { blocks: number }[];
    const blocks = Number(row?.blocks ?? 0);
    if (blocks > 0 && !destructiveRevertAllowed(process.env)) {
      throw new Error(
        `Reversão recusada: ela apagaria ${blocks} bloqueio(s) de clientes (store_customer_blocks) e os números dos pedidos. ` +
          'Os clientes bloqueados voltariam a comprar nas lojas que os bloquearam. ' +
          `Faça um backup do banco e, se for mesmo para perder esses dados, rode de novo com ${DESTRUCTIVE_REVERT_FLAG}=true.`,
      );
    }
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "TRG_store_customer_blocks_store_immutable" ON "store_customer_blocks"`,
    );
    await queryRunner.query(
      `ALTER TABLE "store_customer_blocks" DROP CONSTRAINT "FK_store_customer_blocks_blocked_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "store_customer_blocks" DROP CONSTRAINT "FK_store_customer_blocks_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "store_customer_blocks" DROP CONSTRAINT "FK_store_customer_blocks_store"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_store_customer_blocks_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "store_customer_blocks"`);

    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "TRG_orders_number_immutable" ON "orders"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "orders_number_immutable"()`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "TRG_orders_assign_number" ON "orders"`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS "orders_assign_number"()`);
    await queryRunner.query(`DROP TABLE IF EXISTS "store_order_counters"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_orders_store_number"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "number"`);
  }

  private async addOrderNumbers(queryRunner: QueryRunner): Promise<void> {
    // IF EXISTS/IF NOT EXISTS: tolera um banco de desenvolvimento em que o DB_SYNCHRONIZE=true já
    // tenha criado a coluna ou o índice (o índice é recriado depois do backfill)
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "number" integer`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_orders_store_number"`,
    );

    // Pedidos existentes: 1..N por loja, na ordem de criação (empate: id)
    await queryRunner.query(
      `UPDATE "orders" AS "o" SET "number" = "ranked"."position"
         FROM (SELECT "id", ROW_NUMBER() OVER (PARTITION BY "store_id" ORDER BY "created_at", "id") AS "position"
                 FROM "orders") AS "ranked"
        WHERE "o"."id" = "ranked"."id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ALTER COLUMN "number" SET NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_orders_store_number" ON "orders" ("store_id", "number")`,
    );

    // Contador por loja (último número usado), já no ponto do backfill
    await queryRunner.query(
      `CREATE TABLE "store_order_counters" ("store_id" integer NOT NULL, "last_number" integer NOT NULL DEFAULT 0, CONSTRAINT "CHK_store_order_counters_last_number" CHECK ("last_number" >= 0), CONSTRAINT "PK_store_order_counters" PRIMARY KEY ("store_id"), CONSTRAINT "FK_store_order_counters_store" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    );
    await queryRunner.query(
      `INSERT INTO "store_order_counters" ("store_id", "last_number")
       SELECT "store_id", MAX("number") FROM "orders" GROUP BY "store_id"`,
    );

    // Número na inserção: a linha do contador fica travada até o fim da transação do pedido
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "orders_assign_number"() RETURNS trigger AS $$
      BEGIN
        INSERT INTO "store_order_counters" AS "counter" ("store_id", "last_number")
          VALUES (NEW."store_id", 1)
          ON CONFLICT ("store_id") DO UPDATE SET "last_number" = "counter"."last_number" + 1
          RETURNING "last_number" INTO NEW."number";
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(
      `CREATE TRIGGER "TRG_orders_assign_number" BEFORE INSERT ON "orders" FOR EACH ROW EXECUTE FUNCTION "orders_assign_number"()`,
    );

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "orders_number_immutable"() RETURNS trigger AS $$
      BEGIN
        IF NEW."number" IS DISTINCT FROM OLD."number" THEN
          RAISE EXCEPTION 'O número do pedido % não pode ser alterado.', OLD."id"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(
      `CREATE TRIGGER "TRG_orders_number_immutable" BEFORE UPDATE OF "number" ON "orders" FOR EACH ROW EXECUTE FUNCTION "orders_number_immutable"()`,
    );
  }

  private async createCustomerBlocks(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "store_customer_blocks" ("store_id" integer NOT NULL, "user_id" integer NOT NULL, "reason" character varying(300) NOT NULL, "blocked_by_user_id" integer, "blocked_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_store_customer_blocks" PRIMARY KEY ("store_id", "user_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_store_customer_blocks_user_id" ON "store_customer_blocks" ("user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "store_customer_blocks" ADD CONSTRAINT "FK_store_customer_blocks_store" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "store_customer_blocks" ADD CONSTRAINT "FK_store_customer_blocks_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "store_customer_blocks" ADD CONSTRAINT "FK_store_customer_blocks_blocked_by" FOREIGN KEY ("blocked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "TRG_store_customer_blocks_store_immutable" BEFORE UPDATE OF "store_id" ON "store_customer_blocks" FOR EACH ROW EXECUTE FUNCTION "tenant_store_id_immutable"()`,
    );
  }
}
