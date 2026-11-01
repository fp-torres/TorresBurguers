import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sessões de acesso (logout por sessão):
 * - auth_sessions: uma linha por token emitido (claim "jti", UUID único), da conta (user_id, apagada junto com
 *   ela), com o tipo (USER | SUPPORT — a sessão de suporte do token em support_session_id, apagada junto com
 *   ela), a versão das sessões da conta na emissão (token_version), criação, expiração (= "exp" do token),
 *   revogação, IP e navegador (cortado em 255 caracteres);
 * - índices: jti único (a conferência de cada requisição), conta + criação (lista e limpeza das sessões da
 *   conta), sessão de suporte (chave estrangeira) e expiração (limpeza das sessões vencidas).
 * Tabela nova, sem dados antigos: os tokens emitidos antes dela não têm "jti" e continuam valendo até expirar.
 * down() encerra as sessões de todas as contas (token_version + 1) e apaga a tabela: a API antiga ignora o
 * "jti", então sem isso os tokens encerrados por logout voltariam a valer; depois de reverter, quem estava
 * conectado entra de novo.
 */
export class AuthSessions1792964108700 implements MigrationInterface {
  name = 'AuthSessions1792964108700';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "auth_sessions" ("id" SERIAL NOT NULL, "jti" uuid NOT NULL, "user_id" integer NOT NULL, "kind" character varying(16) NOT NULL DEFAULT 'USER', "support_session_id" integer, "token_version" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "revoked_at" TIMESTAMP WITH TIME ZONE, "ip" character varying(64), "user_agent" character varying(255), CONSTRAINT "CHK_auth_sessions_support" CHECK (("kind" = 'SUPPORT') = ("support_session_id" IS NOT NULL)), CONSTRAINT "CHK_auth_sessions_kind" CHECK ("kind" IN ('USER', 'SUPPORT')), CONSTRAINT "PK_auth_sessions" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_auth_sessions_jti" ON "auth_sessions" ("jti") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_auth_sessions_user_created" ON "auth_sessions" ("user_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_auth_sessions_support_session" ON "auth_sessions" ("support_session_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_auth_sessions_expires" ON "auth_sessions" ("expires_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" ADD CONSTRAINT "FK_auth_sessions_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" ADD CONSTRAINT "FK_auth_sessions_support_session" FOREIGN KEY ("support_session_id") REFERENCES "support_sessions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // A API anterior IGNORA o "jti" (confere só sub, tv, bloqueio e sid): sem esta linha, o token de um
    // aparelho encerrado por logout ou "encerrar sessão" voltaria a valer até expirar. As sessões
    // revogadas podem até já ter sido limpas da tabela, então a única forma segura é encerrar TODAS as
    // sessões emitidas até aqui (token_version + 1): depois de reverter, todo mundo entra de novo.
    await queryRunner.query(
      `UPDATE "users" SET "token_version" = "token_version" + 1`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" DROP CONSTRAINT "FK_auth_sessions_support_session"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_sessions" DROP CONSTRAINT "FK_auth_sessions_user"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_auth_sessions_expires"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_auth_sessions_support_session"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_auth_sessions_user_created"`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_auth_sessions_jti"`);
    await queryRunner.query(`DROP TABLE "auth_sessions"`);
  }
}
