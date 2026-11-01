import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tarefas de manutenção em segundo plano (ex.: otimização das imagens de uploads), com a trava no banco:
 * - maintenance_jobs: tipo, situação (RUNNING/SUCCEEDED/FAILED), quem iniciou, início, heartbeat, fim,
 *   contagens (summary) e o motivo curto da falha;
 * - índice único parcial (kind) WHERE status = 'RUNNING': uma execução por vez de cada tipo entre TODAS as
 *   instâncias da API (a trava antiga ficava na memória de cada instância).
 * Tabela nova, sem dados antigos. down() a apaga: o histórico das execuções se perde (o início e o fim de
 * cada uma continuam na auditoria).
 */
export class MaintenanceJobs1792299658658 implements MigrationInterface {
  name = 'MaintenanceJobs1792299658658';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "maintenance_jobs" ("id" SERIAL NOT NULL, "kind" character varying(40) NOT NULL, "status" character varying(20) NOT NULL, "started_by_user_id" integer, "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "heartbeat_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "finished_at" TIMESTAMP WITH TIME ZONE, "summary" jsonb, "error" character varying(300), CONSTRAINT "CHK_maintenance_jobs_status" CHECK ("status" IN ('RUNNING', 'SUCCEEDED', 'FAILED')), CONSTRAINT "PK_eeab42a825d840bd95635b5f873" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_maintenance_jobs_kind_running" ON "maintenance_jobs" ("kind") WHERE "status" = 'RUNNING'`,
    );
    await queryRunner.query(
      `ALTER TABLE "maintenance_jobs" ADD CONSTRAINT "FK_maintenance_jobs_started_by" FOREIGN KEY ("started_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "maintenance_jobs" DROP CONSTRAINT "FK_maintenance_jobs_started_by"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_maintenance_jobs_kind_running"`,
    );
    await queryRunner.query(`DROP TABLE "maintenance_jobs"`);
  }
}
