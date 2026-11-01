import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Entrega por distância em km (orders/delivery-distance.ts):
 * - stores.latitude e stores.longitude: local da loja no mapa (ponto de partida da distância);
 * - addresses.geo_*: coordenadas do endereço do cliente obtidas pelo SERVIDOR (cadeia de provedores, ver
 *   addresses/geocoding.ts), com a precisão (ADDRESS, ZIP_CENTER ou MANUAL), o provedor, o resultado (FOUND,
 *   NOT_FOUND, UNAVAILABLE) e o momento. As colunas antigas addresses.latitude/longitude (enviadas pelo app)
 *   continuam como estão e nunca entram no cálculo do frete.
 * Colunas novas, todas opcionais: lojas e endereços existentes ficam sem coordenadas (o modo por distância é
 * opcional; o padrão continua por zonas) e os endereços são localizados no primeiro orçamento por distância.
 * Tolera as colunas já criadas pelo DB_SYNCHRONIZE=true num banco de desenvolvimento (IF NOT EXISTS).
 * down() remove tudo (uma loja no modo distância volta a cobrar pelas zonas guardadas no JSON).
 */
export class DeliveryDistance1793501000000 implements MigrationInterface {
  name = 'DeliveryDistance1793501000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "latitude" double precision`,
    );
    await queryRunner.query(
      `ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "longitude" double precision`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "geo_latitude" double precision`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "geo_longitude" double precision`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "geo_precision" character varying(12)`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "geo_source" character varying(12)`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "geo_status" character varying(12)`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" ADD COLUMN IF NOT EXISTS "geo_checked_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" DROP CONSTRAINT IF EXISTS "CHK_addresses_geo_precision"`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" ADD CONSTRAINT "CHK_addresses_geo_precision" CHECK ("geo_precision" IN ('ADDRESS', 'ZIP_CENTER', 'MANUAL'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" DROP CONSTRAINT IF EXISTS "CHK_addresses_geo_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" ADD CONSTRAINT "CHK_addresses_geo_status" CHECK ("geo_status" IN ('FOUND', 'NOT_FOUND', 'UNAVAILABLE'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "addresses" DROP CONSTRAINT IF EXISTS "CHK_addresses_geo_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" DROP CONSTRAINT IF EXISTS "CHK_addresses_geo_precision"`,
    );
    for (const column of [
      'geo_checked_at',
      'geo_status',
      'geo_source',
      'geo_precision',
      'geo_longitude',
      'geo_latitude',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "addresses" DROP COLUMN IF EXISTS "${column}"`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "stores" DROP COLUMN IF EXISTS "longitude"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stores" DROP COLUMN IF EXISTS "latitude"`,
    );
  }
}
