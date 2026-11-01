import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Índices de desempenho e garantias no banco recomendados depois da fundação multi-tenant:
 * - order_items("orderId"): o Postgres não indexa a FK sozinho (listas de pedidos e relatórios fazem join);
 * - orders(user_id, created_at): "Meus pedidos" do cliente global, em todas as lojas;
 * - um único convite em aberto por loja + e-mail (antes garantido só pela aplicação);
 * - uma fatura válida (não anulada) por período da assinatura (antes garantido só pela trava da rotina).
 * IF NOT EXISTS: bancos de desenvolvimento que subiram com DB_SYNCHRONIZE=true já podem ter os dois índices
 * simples (declarados nas entidades); sem isso a migration falharia e a API não subiria.
 */
export class TenancyIndexes1791773437187 implements MigrationInterface {
  name = 'TenancyIndexes1791773437187';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_order_items_order_id" ON "order_items" ("orderId") `,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_orders_user_created_at" ON "orders" ("user_id", "created_at") `,
    );

    // Convites em aberto duplicados (não deveria haver): fica o mais novo, os outros viram revogados
    await queryRunner.query(`
      UPDATE "invitations" SET "revoked_at" = now()
      WHERE "id" IN (
        SELECT "id" FROM (
          SELECT "id", row_number() OVER (PARTITION BY "store_id", "email" ORDER BY "id" DESC) AS "position"
          FROM "invitations" WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL
        ) ranked WHERE "position" > 1
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_invitations_store_email_pending" ON "invitations" ("store_id", "email") WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL`,
    );

    // Faturas válidas duplicadas para o mesmo período são um erro de cobrança: não anula nada sozinha
    const [{ duplicates }] = (await queryRunner.query(`
      SELECT COUNT(*)::int AS "duplicates" FROM (
        SELECT 1 FROM "subscription_invoices" WHERE "status" <> 'VOID'
        GROUP BY "subscription_id", "period_start" HAVING COUNT(*) > 1
      ) repeated`)) as { duplicates: number }[];
    if (duplicates > 0) {
      throw new Error(
        `Há ${duplicates} período(s) de assinatura com mais de uma fatura válida. Anule (VOID) as faturas repetidas pelo superpainel e rode as migrations de novo.`,
      );
    }
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_subscription_invoices_subscription_period" ON "subscription_invoices" ("subscription_id", "period_start") WHERE "status" <> 'VOID'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."UQ_subscription_invoices_subscription_period"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_invitations_store_email_pending"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_orders_user_created_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_order_items_order_id"`);
  }
}
