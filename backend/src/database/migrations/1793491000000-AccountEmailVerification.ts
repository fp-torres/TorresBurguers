import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Verificação e troca do e-mail da conta (plano email-verification, fase 1a):
 * - users.email_verified_at (timestamptz, opcional): quando a pessoa confirmou o endereço. Sem backfill:
 *   todas as contas existentes ficam "não confirmado" (no modo compat nada depende disso).
 * - account_email_tokens: links de uso único por e-mail (VERIFY, CHANGE e REVERT), da conta (user_id,
 *   apagados junto com ela). O banco guarda só o SHA-256 do código (token_hash, único).
 *   - CHECK do propósito e do previous_email (vazio só no VERIFY);
 *   - UQ parcial: um único pedido de troca (CHANGE) em aberto por conta;
 *   - índice parcial por e-mail dos REVERT em aberto: reserva do endereço antigo por 7 dias;
 *   - índices de conta + propósito + criação (consultas da conta) e de expiração (limpeza).
 * down() apaga a tabela e a coluna: perde só as confirmações e os pedidos pendentes (nenhum dado de
 * negócio), então não precisa de guarda destrutiva.
 */
export class AccountEmailVerification1793491000000 implements MigrationInterface {
  name = 'AccountEmailVerification1793491000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "email_verified_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE TABLE "account_email_tokens" ("id" SERIAL NOT NULL, "user_id" integer NOT NULL, "purpose" character varying(16) NOT NULL, "email" character varying(320) NOT NULL, "previous_email" character varying(320), "token_hash" character varying(64) NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "used_at" TIMESTAMP WITH TIME ZONE, "revoked_at" TIMESTAMP WITH TIME ZONE, "requested_ip" character varying(64), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_account_email_tokens_previous" CHECK (("purpose" = 'VERIFY') = ("previous_email" IS NULL)), CONSTRAINT "CHK_account_email_tokens_purpose" CHECK ("purpose" IN ('VERIFY', 'CHANGE', 'REVERT')), CONSTRAINT "PK_account_email_tokens" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_account_email_tokens_token_hash" ON "account_email_tokens" ("token_hash") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_account_email_tokens_user_purpose_created" ON "account_email_tokens" ("user_id", "purpose", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_account_email_tokens_expires" ON "account_email_tokens" ("expires_at") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_account_email_tokens_open_change" ON "account_email_tokens" ("user_id") WHERE "purpose" = 'CHANGE' AND "used_at" IS NULL AND "revoked_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_account_email_tokens_reserved" ON "account_email_tokens" ("email") WHERE "purpose" = 'REVERT' AND "used_at" IS NULL AND "revoked_at" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_email_tokens" ADD CONSTRAINT "FK_account_email_tokens_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "account_email_tokens" DROP CONSTRAINT "FK_account_email_tokens_user"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_account_email_tokens_reserved"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_account_email_tokens_open_change"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_account_email_tokens_expires"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_account_email_tokens_user_purpose_created"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_account_email_tokens_token_hash"`,
    );
    await queryRunner.query(`DROP TABLE "account_email_tokens"`);
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "email_verified_at"`,
    );
  }
}
