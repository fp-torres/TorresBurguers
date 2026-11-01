import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Correções da revisão de segurança (rodada 2), lojas e assinaturas:
 *
 * 1. subscriptions.cancel_scheduled_by (PLATFORM | STORE): quem agendou o cancelamento no fim do período.
 *    O agendamento feito pelo superadmin só é desfeito por ele (POST /store/subscription/resume → 409),
 *    como já acontece com a suspensão (suspended_by). Os agendamentos em aberto recebem a origem pelo
 *    histórico: último evento CANCEL_SCHEDULED feito por uma conta da plataforma → PLATFORM; o resto →
 *    STORE (a regra antiga: a loja podia desfazer).
 * 2. store_slug_history: endereços (slugs) que uma loja deixou de usar quando o superpainel trocou o
 *    endereço dela. O autoatendimento nunca os aceita (links, QR codes e a última loja guardada no
 *    navegador continuam apontando para eles). Um por endereço, com o último dono (store_id muda quando
 *    outra loja deixa de usar o mesmo endereço: sem o gatilho de store_id imutável). As trocas de
 *    endereço já registradas na auditoria (platform.store.update com slug.from) entram na tabela.
 *
 * down() remove a coluna e a tabela: a origem dos agendamentos e a reserva dos endereços antigos se
 * perdem (a API anterior não as usa: a loja volta a poder desfazer qualquer agendamento e o
 * autoatendimento volta a aceitar endereços antigos).
 */
export class StoreSlugHistoryAndCancelOrigin1793485300000 implements MigrationInterface {
  name = 'StoreSlugHistoryAndCancelOrigin1793485300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Origem do cancelamento agendado
    await queryRunner.query(
      `ALTER TABLE "subscriptions" ADD "cancel_scheduled_by" character varying(20)`,
    );
    await queryRunner.query(`
      UPDATE "subscriptions" "s" SET "cancel_scheduled_by" = CASE WHEN EXISTS (
        SELECT 1 FROM "users" "u"
         WHERE "u"."platform_role" IS NOT NULL AND "u"."id" = (
           SELECT "e"."actor_user_id" FROM "subscription_events" "e"
            WHERE "e"."subscription_id" = "s"."id" AND "e"."type" = 'CANCEL_SCHEDULED'
            ORDER BY "e"."created_at" DESC, "e"."id" DESC LIMIT 1
         )
      ) THEN 'PLATFORM' ELSE 'STORE' END
      WHERE "s"."cancel_at_period_end" = true`);
    await queryRunner.query(
      `ALTER TABLE "subscriptions" ADD CONSTRAINT "CHK_subscriptions_cancel_scheduled_by" CHECK ("cancel_scheduled_by" IS NULL OR "cancel_scheduled_by" IN ('PLATFORM', 'STORE'))`,
    );

    // 2. Endereços antigos das lojas
    await queryRunner.query(
      `CREATE TABLE "store_slug_history" ("id" SERIAL NOT NULL, "store_id" integer NOT NULL, "slug" character varying(60) NOT NULL, "released_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_store_slug_history" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_store_slug_history_store_id" ON "store_slug_history" ("store_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_store_slug_history_slug" ON "store_slug_history" ("slug") `,
    );
    await queryRunner.query(
      `ALTER TABLE "store_slug_history" ADD CONSTRAINT "FK_store_slug_history_store" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    // Trocas já feitas pelo superpainel (auditoria): o último dono de cada endereço antigo
    await queryRunner.query(`
      INSERT INTO "store_slug_history" ("store_id", "slug", "released_at")
      SELECT DISTINCT ON ("a"."metadata" -> 'slug' ->> 'from')
             "a"."store_id", "a"."metadata" -> 'slug' ->> 'from', "a"."created_at"
        FROM "audit_logs" "a"
        JOIN "stores" "st" ON "st"."id" = "a"."store_id"
       WHERE "a"."action" = 'platform.store.update' AND "a"."result" = 'SUCCESS'
         AND length("a"."metadata" -> 'slug' ->> 'from') BETWEEN 1 AND 60
       ORDER BY "a"."metadata" -> 'slug' ->> 'from', "a"."created_at" DESC, "a"."id" DESC
      ON CONFLICT ("slug") DO NOTHING`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "store_slug_history" DROP CONSTRAINT "FK_store_slug_history_store"`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_store_slug_history_slug"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_store_slug_history_store_id"`,
    );
    await queryRunner.query(`DROP TABLE "store_slug_history"`);
    await queryRunner.query(
      `ALTER TABLE "subscriptions" DROP CONSTRAINT "CHK_subscriptions_cancel_scheduled_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscriptions" DROP COLUMN "cancel_scheduled_by"`,
    );
  }
}
