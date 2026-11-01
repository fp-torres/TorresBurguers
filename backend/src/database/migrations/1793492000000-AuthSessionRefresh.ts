import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sessão do site em cookie (refresh com rotação), aditiva:
 * - auth_sessions.transport: BEARER (padrão: todas as linhas existentes, sem backfill; ADD COLUMN com
 *   default constante é só metadado no PostgreSQL 11+) ou COOKIE (uma linha = uma família de refresh);
 * - refresh_selector (único, parcial), refresh_hash e refresh_prev_hash (SHA-256 do validador atual e do
 *   anterior), refresh_rotated_at e refresh_generation;
 * - parent_session_id: na sessão de suporte, a sessão do superadmin que a abriu (o refresh dela responde
 *   409 enquanto o suporte estiver aberto). Apagar a sessão pai deixa o campo null.
 * CHECKs: transport válido; COOKIE ⇔ seletor e hash presentes; sessão de suporte sempre BEARER. Criados
 * NOT VALID e validados em seguida (a validação não bloqueia as gravações da tabela).
 *
 * down() não é destrutivo para contas nem pedidos: remove a FK, os índices, os CHECKs e as colunas. As
 * sessões em cookie perdem o refresh (o token de acesso, de 15 min, vale até expirar) e as pessoas entram
 * de novo.
 */
export class AuthSessionRefresh1793492000000 implements MigrationInterface {
  name = 'AuthSessionRefresh1793492000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" ADD "transport" character varying(16) NOT NULL DEFAULT 'BEARER'`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" ADD "refresh_selector" character varying(32)`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" ADD "refresh_hash" character(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" ADD "refresh_prev_hash" character(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" ADD "refresh_rotated_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" ADD "refresh_generation" integer NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" ADD "parent_session_id" integer`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_auth_sessions_refresh_selector" ON "auth_sessions" ("refresh_selector") WHERE "refresh_selector" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_auth_sessions_parent" ON "auth_sessions" ("parent_session_id") WHERE "parent_session_id" IS NOT NULL`,
    );
    const checks: [string, string][] = [
      ['CHK_auth_sessions_transport', `"transport" IN ('BEARER', 'COOKIE')`],
      [
        'CHK_auth_sessions_refresh',
        `("transport" = 'COOKIE') = ("refresh_selector" IS NOT NULL AND "refresh_hash" IS NOT NULL)`,
      ],
      [
        'CHK_auth_sessions_support_bearer',
        `"kind" <> 'SUPPORT' OR "transport" = 'BEARER'`,
      ],
    ];
    for (const [name, expression] of checks) {
      await queryRunner.query(
        `ALTER TABLE "auth_sessions" ADD CONSTRAINT "${name}" CHECK (${expression}) NOT VALID`,
      );
      await queryRunner.query(
        `ALTER TABLE "auth_sessions" VALIDATE CONSTRAINT "${name}"`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" ADD CONSTRAINT "FK_auth_sessions_parent" FOREIGN KEY ("parent_session_id") REFERENCES "auth_sessions"("id") ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" VALIDATE CONSTRAINT "FK_auth_sessions_parent"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" DROP CONSTRAINT "FK_auth_sessions_parent"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" DROP CONSTRAINT "CHK_auth_sessions_support_bearer"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" DROP CONSTRAINT "CHK_auth_sessions_refresh"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" DROP CONSTRAINT "CHK_auth_sessions_transport"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_auth_sessions_parent"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_auth_sessions_refresh_selector"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" DROP COLUMN "parent_session_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" DROP COLUMN "refresh_generation"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" DROP COLUMN "refresh_rotated_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" DROP COLUMN "refresh_prev_hash"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" DROP COLUMN "refresh_hash"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" DROP COLUMN "refresh_selector"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" DROP COLUMN "transport"`,
    );
  }
}
