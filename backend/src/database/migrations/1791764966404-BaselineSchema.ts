import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Schema da versão de loja única (antes do SaaS multi-tenant), exatamente como o TypeORM
 * synchronize o criava — inclusive os nomes de constraints e índices.
 *
 * - Banco novo (vazio): cria as tabelas.
 * - Banco existente, criado pelo synchronize das versões anteriores: não faz nada (as tabelas já existem).
 *   As próximas migrations partem deste ponto e preservam os dados.
 *
 * Irreversível de propósito: desfazê-la apagaria todas as tabelas e os dados.
 */
export class BaselineSchema1791764966404 implements MigrationInterface {
  name = 'BaselineSchema1791764966404';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('users')) return;

    await queryRunner.query(
      `CREATE TABLE "addons" ("id" SERIAL NOT NULL, "name" character varying NOT NULL, "description" text, "price" numeric(10,2) NOT NULL, "image" character varying, "available" boolean NOT NULL DEFAULT true, "category" character varying NOT NULL DEFAULT 'geral', "deleted_at" TIMESTAMP, CONSTRAINT "PK_cd49fb3dc0558f02cb6fe6cc138" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."products_category_enum" AS ENUM('hamburgueres', 'entradas', 'acompanhamentos', 'bebidas', 'sobremesas', 'molhos', 'adicionais', 'combos')`,
    );
    await queryRunner.query(
      `CREATE TABLE "products" ("id" SERIAL NOT NULL, "name" character varying NOT NULL, "description" text NOT NULL, "price" numeric(10,2) NOT NULL, "promotion_price" numeric(10,2), "is_highlight" boolean NOT NULL DEFAULT false, "image" character varying, "category" "public"."products_category_enum" NOT NULL DEFAULT 'hamburgueres', "ingredients" text, "available" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP, CONSTRAINT "PK_0806c755e0aca124e67c0cf6d7d" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "order_items" ("id" SERIAL NOT NULL, "quantity" integer NOT NULL, "observation" text, "meat_point" character varying, "removed_ingredients" text, "product_name" character varying, "unit_price" numeric(10,2), "addons_snapshot" jsonb, "orderId" integer, "productId" integer, CONSTRAINT "PK_005269d8574e6fac0493715c308" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."orders_status_enum" AS ENUM('PENDING', 'PREPARING', 'READY_FOR_PICKUP', 'DELIVERING', 'DONE', 'CANCELED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."orders_payment_status_enum" AS ENUM('PENDING', 'PAID', 'FAILED', 'REFUNDED', 'REFUND_PENDING')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."orders_type_enum" AS ENUM('DELIVERY', 'TAKEOUT')`,
    );
    await queryRunner.query(
      `CREATE TABLE "orders" ("id" SERIAL NOT NULL, "status" "public"."orders_status_enum" NOT NULL DEFAULT 'PENDING', "payment_status" "public"."orders_payment_status_enum" NOT NULL DEFAULT 'PENDING', "type" "public"."orders_type_enum" NOT NULL DEFAULT 'DELIVERY', "total_price" numeric(10,2) NOT NULL, "delivery_fee" numeric(10,2) NOT NULL DEFAULT '0', "payment_method" character varying NOT NULL, "change_for" character varying, "payment_id" bigint, "estimated_delivery_time" character varying, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "delivery_address" text, "user_id" integer, "driver_id" integer, "address_id" integer, CONSTRAINT "UQ_5b3e94bd2aedc184f9ad8c10439" UNIQUE ("payment_id"), CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."users_role_enum" AS ENUM('CLIENT', 'ADMIN', 'KITCHEN', 'COURIER', 'EMPLOYEE')`,
    );
    await queryRunner.query(
      `CREATE TABLE "users" ("id" SERIAL NOT NULL, "name" character varying NOT NULL, "email" character varying NOT NULL, "password_hash" character varying NOT NULL, "phone" character varying(20), "avatar" character varying, "role" "public"."users_role_enum" NOT NULL DEFAULT 'CLIENT', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP, CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "addresses" ("id" SERIAL NOT NULL, "zipCode" character varying NOT NULL, "street" character varying NOT NULL, "number" character varying NOT NULL, "complement" character varying, "neighborhood" character varying NOT NULL, "city" character varying NOT NULL, "state" character varying(2) NOT NULL, "nickname" character varying, "latitude" double precision, "longitude" double precision, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP, "user_id" integer, CONSTRAINT "PK_745d8f43d3af10ab8247465e450" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "payments" ("id" bigint NOT NULL, "user_id" integer NOT NULL, "method" character varying(10) NOT NULL, "order_payment_method" character varying(20) NOT NULL, "payment_method_id" character varying(40), "amount" numeric(10,2) NOT NULL, "status" character varying(30) NOT NULL, "status_detail" character varying(80), "simulated" boolean NOT NULL DEFAULT false, "order_payload" jsonb NOT NULL, "price_snapshot" jsonb NOT NULL, "pix_data" jsonb, "expires_at" TIMESTAMP WITH TIME ZONE, "auto_approve_at" TIMESTAMP WITH TIME ZONE, "order_id" integer, "idempotency_key" character varying(64), "external_reference" character varying(120), "finalize_error" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_197ab7af18c93fbb0c9b28b4a59" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_427785468fb7d2733f59e7d7d3" ON "payments" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_32b41cdb985a296213e9a928b5" ON "payments" ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b2f7b823a21562eeca20e72b00" ON "payments" ("order_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_payments_user_idempotency_key" ON "payments" ("user_id", "idempotency_key") `,
    );
    await queryRunner.query(
      `CREATE TABLE "store_config" ("id" SERIAL NOT NULL, "is_open" boolean NOT NULL DEFAULT false, "opening_message" character varying, "closing_message" character varying, CONSTRAINT "PK_5c595867ae59a54fc907c570700" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "product_allowed_addons" ("product_id" integer NOT NULL, "addon_id" integer NOT NULL, CONSTRAINT "PK_d3019da2d9b646bed12fef06511" PRIMARY KEY ("product_id", "addon_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_800aa6036d40295231593edf17" ON "product_allowed_addons" ("product_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_2d1e05ba2d2809e7714d54e5c0" ON "product_allowed_addons" ("addon_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "order_item_addons" ("orderItemsId" integer NOT NULL, "addonsId" integer NOT NULL, CONSTRAINT "PK_9dd1342e6d165425468b69c6606" PRIMARY KEY ("orderItemsId", "addonsId"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d067ea302570c7fb334d8445f4" ON "order_item_addons" ("orderItemsId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_bbc920977f51e1346b992b1675" ON "order_item_addons" ("addonsId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD CONSTRAINT "FK_f1d359a55923bb45b057fbdab0d" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_items" ADD CONSTRAINT "FK_cdb99c05982d5191ac8465ac010" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_a922b820eeef29ac1c6800e826a" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_222cd7bf166a2d7a6aad9cdebee" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_d39c53244703b8534307adcd073" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "addresses" ADD CONSTRAINT "FK_16aac8a9f6f9c1dd6bcb75ec023" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_allowed_addons" ADD CONSTRAINT "FK_800aa6036d40295231593edf174" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_allowed_addons" ADD CONSTRAINT "FK_2d1e05ba2d2809e7714d54e5c0b" FOREIGN KEY ("addon_id") REFERENCES "addons"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_item_addons" ADD CONSTRAINT "FK_d067ea302570c7fb334d8445f45" FOREIGN KEY ("orderItemsId") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "order_item_addons" ADD CONSTRAINT "FK_bbc920977f51e1346b992b16751" FOREIGN KEY ("addonsId") REFERENCES "addons"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
    );
  }

  public down(): Promise<void> {
    return Promise.reject(
      new Error(
        'A migration de base (BaselineSchema) não pode ser desfeita: isso apagaria todas as tabelas e os dados.',
      ),
    );
  }
}
