import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Localização da entrega pelo CEP nos endereços (a zona de entrega deixa de depender só do bairro digitado):
 * - canonical_neighborhood, canonical_city e canonical_state: bairro, cidade e UF da busca do CEP;
 * - neighborhood_source: CEP (bairro confirmado pelo CEP) ou MANUAL (bairro informado manualmente: CEP
 *   inexistente, CEP geral sem bairro ou serviço de CEP fora do ar);
 * - cep_status (FOUND, NO_NEIGHBORHOOD, NOT_FOUND, UNAVAILABLE) e cep_checked_at: resultado e momento da
 *   conferência (o orçamento confere de novo quando o serviço estava fora do ar).
 * Colunas novas, todas opcionais: os endereços existentes ficam "não conferidos" (null) e são conferidos no
 * primeiro orçamento de entrega com eles. Tolera as colunas já criadas pelo DB_SYNCHRONIZE=true num banco de
 * desenvolvimento (IF NOT EXISTS). down() remove tudo: o bairro digitado volta a ser o único usado.
 */
export class AddressZoneLocation1793476392120 implements MigrationInterface {
  name = 'AddressZoneLocation1793476392120';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "canonical_neighborhood" character varying(100)`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "canonical_city" character varying(100)`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "canonical_state" character varying(2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "neighborhood_source" character varying(10)`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "cep_status" character varying(16)`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "cep_checked_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" DROP CONSTRAINT IF EXISTS "CHK_addresses_neighborhood_source"`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" ADD CONSTRAINT "CHK_addresses_neighborhood_source" CHECK ("neighborhood_source" IN ('CEP', 'MANUAL'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" DROP CONSTRAINT IF EXISTS "CHK_addresses_cep_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" ADD CONSTRAINT "CHK_addresses_cep_status" CHECK ("cep_status" IN ('FOUND', 'NO_NEIGHBORHOOD', 'NOT_FOUND', 'UNAVAILABLE'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "addresses" DROP CONSTRAINT IF EXISTS "CHK_addresses_cep_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" DROP CONSTRAINT IF EXISTS "CHK_addresses_neighborhood_source"`,
    );
    for (const column of [
      'cep_checked_at',
      'cep_status',
      'neighborhood_source',
      'canonical_state',
      'canonical_city',
      'canonical_neighborhood',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "addresses" DROP COLUMN IF EXISTS "${column}"`,
      );
    }
  }
}
