import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Limite de armazenamento por plano:
 * - plans.max_storage_mb (inteiro, nulo = ilimitado): soma, em MB (1 MB = 1.048.576 bytes), das imagens da loja
 *   na pasta de uploads (arquivos s<storeId>-: produtos, adicionais, logo e POST /uploads). Conferido antes de
 *   gravar cada imagem da loja e na troca de plano (downgrade só se o uso couber).
 * Coluna nova e nula: todos os planos existentes continuam ilimitados (comportamento de antes).
 * down() apaga a coluna (os limites de armazenamento configurados se perdem; nada mais muda).
 */
export class PlanStorageLimit1793477263977 implements MigrationInterface {
  name = 'PlanStorageLimit1793477263977';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "plans" ADD "max_storage_mb" integer`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "plans" DROP COLUMN "max_storage_mb"`);
  }
}
