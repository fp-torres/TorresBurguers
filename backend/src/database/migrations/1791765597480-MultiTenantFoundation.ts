import { MigrationInterface, QueryRunner } from 'typeorm';

/** Tabelas da versão de loja única que recebem a coluna store_id. */
const TENANT_TABLES = ['addons', 'products', 'orders', 'payments'] as const;

/** Colunas que a versão de loja única já precisava ter (o synchronize das versões recentes as criou). */
const REQUIRED_LEGACY_COLUMNS: Record<string, string[]> = {
  users: ['id', 'email', 'role', 'deleted_at'],
  products: ['id', 'deleted_at'],
  addons: ['id', 'deleted_at'],
  orders: ['id', 'payment_status', 'delivery_address', 'driver_id'],
  order_items: ['id', 'unit_price', 'product_name', 'addons_snapshot'],
  payments: ['id', 'order_id', 'price_snapshot'],
  addresses: ['id', 'deleted_at'],
  product_allowed_addons: ['product_id', 'addon_id'],
  order_item_addons: ['orderItemsId', 'addonsId'],
};

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;
const DEFAULT_INITIAL_STORE_NAME = 'Loja principal';
const DEFAULT_INITIAL_STORE_SLUG = 'loja-principal';
const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';

/** Dados que a vitrine web exibia fixos (frontend-web/src/config/brand.ts → STORE_INFO) até esta versão. */
const LEGACY_STOREFRONT_INFO = {
  address_zip_code: '20040003',
  address_street: 'Av. Rio Branco',
  address_number: '156',
  address_complement: 'Loja B',
  address_neighborhood: 'Centro',
  address_city: 'Rio de Janeiro',
  address_state: 'RJ',
  phone: '21999999999',
  // Terça a domingo, das 12h às 4h (madrugada)
  opening_hours: [2, 3, 4, 5, 6, 0].map((day) => ({
    day,
    open: '12:00',
    close: '04:00',
  })),
};

function validTimeZone(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: value });
    return value;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * Fundação do SaaS multi-tenant.
 *
 * 1. Cria lojas (stores), planos, assinaturas, faturas SaaS, eventos de cobrança, auditoria, convites,
 *    redefinição de senha, configurações da plataforma e sessões de suporte.
 * 2. Adiciona store_id a produtos, adicionais, pedidos e pagamentos, e loja/papel global/bloqueio/versão
 *    de sessão aos usuários.
 * 3. Banco com dados (instalação de loja única): cria a LOJA INICIAL (INITIAL_STORE_NAME/INITIAL_STORE_SLUG,
 *    padrão "Loja principal"/"loja-principal") com o status e as mensagens de store_config, associa a ela
 *    TODO o cardápio, pedidos e pagamentos e a equipe (perfis diferentes de CLIENT), e dá a ela uma
 *    assinatura ACTIVE do plano interno "legado" (sem cobrança e sem limites). Clientes continuam globais.
 * 4. Só então torna store_id obrigatório e cria chaves estrangeiras, índices, o CHECK de vínculo da
 *    equipe e triggers que impedem relacionar dados de lojas diferentes.
 *
 * A tabela store_config não é alterada nem apagada (fica como histórico; pode ser removida manualmente).
 *
 * down() (reversão para a loja única) é DESTRUTIVO e só roda com uma loja. Ele apaga a auditoria
 * (audit_logs), o histórico da cobrança SaaS (subscription_invoices, subscription_events), as sessões
 * de suporte, os convites e as redefinições de senha, e remove blocked_at/token_version dos usuários:
 * contas bloqueadas voltam a entrar e sessões revogadas voltam a valer. Se houver qualquer um desses
 * dados, a reversão é recusada, a menos que DB_ALLOW_DESTRUCTIVE_REVERT=true (faça um backup antes).
 */
const DESTRUCTIVE_REVERT_FLAG = 'DB_ALLOW_DESTRUCTIVE_REVERT';

function destructiveRevertAllowed(env: NodeJS.ProcessEnv): boolean {
  const raw = env[DESTRUCTIVE_REVERT_FLAG]?.trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'sim';
}

export class MultiTenantFoundation1791765597480 implements MigrationInterface {
  name = 'MultiTenantFoundation1791765597480';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.assertLegacySchema(queryRunner);
    await this.createPlatformTables(queryRunner);
    await this.addTenantColumns(queryRunner);
    await this.migrateExistingData(queryRunner);
    await this.enforceTenantColumns(queryRunner);
    await this.createConstraints(queryRunner);
    await this.createTenantTriggers(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ stores }] = (await queryRunner.query(
      `SELECT COUNT(*)::int AS "stores" FROM "stores"`,
    )) as { stores: number }[];
    if (stores > 1) {
      throw new Error(
        `Reversão recusada: existem ${stores} lojas. Voltar ao schema de loja única misturaria os dados de estabelecimentos diferentes.`,
      );
    }
    const losses = await this.destructiveRevertLosses(queryRunner);
    if (losses.length && !destructiveRevertAllowed(process.env)) {
      throw new Error(
        `Reversão recusada: ela apagaria ${losses.join('; ')}. Esses dados não voltam (trilha de auditoria, ` +
          'histórico financeiro e de suporte) e contas bloqueadas ou com sessões revogadas voltariam a entrar. ' +
          `Faça um backup do banco e, se for mesmo para perder esses dados, rode de novo com ${DESTRUCTIVE_REVERT_FLAG}=true.`,
      );
    }

    // A loja única volta a ler store_config: leva para lá o status e as mensagens atuais
    if (await queryRunner.hasTable('store_config')) {
      const [store] = (await queryRunner.query(
        `SELECT "is_open", "opening_message", "closing_message" FROM "stores" ORDER BY "id" ASC LIMIT 1`,
      )) as {
        is_open: boolean;
        opening_message: string | null;
        closing_message: string | null;
      }[];
      if (store) {
        const [config] = (await queryRunner.query(
          `SELECT "id" FROM "store_config" ORDER BY "id" ASC LIMIT 1`,
        )) as { id: number }[];
        if (config) {
          await queryRunner.query(
            `UPDATE "store_config" SET "is_open" = $1, "opening_message" = $2, "closing_message" = $3 WHERE "id" = $4`,
            [
              store.is_open,
              store.opening_message,
              store.closing_message,
              config.id,
            ],
          );
        } else {
          await queryRunner.query(
            `INSERT INTO "store_config" ("is_open", "opening_message", "closing_message") VALUES ($1, $2, $3)`,
            [store.is_open, store.opening_message, store.closing_message],
          );
        }
      }
    }

    await this.dropTenantTriggers(queryRunner);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_subscriptions_store_current"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_payments_store_user_idempotency_key"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_payments_user_idempotency_key" ON "payments" ("user_id", "idempotency_key") `,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_settings" DROP CONSTRAINT "FK_platform_settings_default_store"`,
    );

    await queryRunner.query(
      `ALTER TABLE "support_sessions" DROP CONSTRAINT "FK_support_sessions_store"`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_sessions" DROP CONSTRAINT "FK_support_sessions_platform_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_settings" DROP CONSTRAINT "FK_platform_settings_updated_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_settings" DROP CONSTRAINT "FK_platform_settings_self_signup_plan"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT "FK_payments_store"`,
    );
    await queryRunner.query(
      `ALTER TABLE "invitations" DROP CONSTRAINT "FK_invitations_invited_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "invitations" DROP CONSTRAINT "FK_invitations_accepted_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "invitations" DROP CONSTRAINT "FK_invitations_store"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscription_invoices" DROP CONSTRAINT "FK_subscription_invoices_plan"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscription_invoices" DROP CONSTRAINT "FK_subscription_invoices_store"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscription_invoices" DROP CONSTRAINT "FK_subscription_invoices_subscription"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscription_events" DROP CONSTRAINT "FK_subscription_events_actor"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscription_events" DROP CONSTRAINT "FK_subscription_events_store"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscription_events" DROP CONSTRAINT "FK_subscription_events_subscription"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscriptions" DROP CONSTRAINT "FK_subscriptions_plan"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscriptions" DROP CONSTRAINT "FK_subscriptions_store"`,
    );
    await queryRunner.query(
      `ALTER TABLE "password_reset_tokens" DROP CONSTRAINT "FK_password_reset_tokens_created_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "password_reset_tokens" DROP CONSTRAINT "FK_password_reset_tokens_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" DROP CONSTRAINT "FK_audit_logs_store"`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" DROP CONSTRAINT "FK_audit_logs_actor"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT "FK_users_store"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "FK_orders_store"`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" DROP CONSTRAINT "FK_products_store"`,
    );
    await queryRunner.query(
      `ALTER TABLE "addons" DROP CONSTRAINT "FK_addons_store"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stores" DROP CONSTRAINT "FK_stores_owner_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT "CHK_users_store_membership"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_payments_store_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_users_store_id"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_orders_store_created_at"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_orders_store_status"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_products_store_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_addons_store_id"`);
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "store_id"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "last_login_at"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "token_version"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "blocked_reason"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "blocked_at"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "platform_role"`);
    await queryRunner.query(`DROP TYPE "public"."users_platform_role_enum"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "store_id"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN "store_id"`);
    await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "store_id"`);
    await queryRunner.query(`ALTER TABLE "addons" DROP COLUMN "store_id"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_support_sessions_store_started"`,
    );
    await queryRunner.query(`DROP TABLE "support_sessions"`);
    await queryRunner.query(`DROP TABLE "platform_settings"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_invitations_token_hash"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_invitations_email"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_invitations_store_id"`);
    await queryRunner.query(`DROP TABLE "invitations"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_subscription_invoices_store_created"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_subscription_invoices_provider_payment_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_subscription_invoices_status"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_subscription_invoices_subscription_id"`,
    );
    await queryRunner.query(`DROP TABLE "subscription_invoices"`);
    await queryRunner.query(
      `DROP TYPE "public"."subscription_invoices_status_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_subscription_events_store_created"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_subscription_events_subscription_id"`,
    );
    await queryRunner.query(`DROP TABLE "subscription_events"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_subscriptions_provider_subscription_id"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_subscriptions_status"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_subscriptions_plan_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_subscriptions_store_id"`);
    await queryRunner.query(`DROP TABLE "subscriptions"`);
    await queryRunner.query(`DROP TYPE "public"."subscriptions_status_enum"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_plans_code"`);
    await queryRunner.query(`DROP TABLE "plans"`);
    await queryRunner.query(`DROP TYPE "public"."plans_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."plans_billing_interval_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_billing_webhook_events_key"`,
    );
    await queryRunner.query(`DROP TABLE "billing_webhook_events"`);
    await queryRunner.query(
      `DROP INDEX "public"."UQ_password_reset_tokens_token_hash"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_password_reset_tokens_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "password_reset_tokens"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_audit_logs_store_created"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_audit_logs_actor_created"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_audit_logs_action_created"`,
    );
    await queryRunner.query(`DROP TABLE "audit_logs"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_stores_custom_domain"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_stores_slug"`);
    await queryRunner.query(`DROP TABLE "stores"`);
    await queryRunner.query(`DROP TYPE "public"."stores_account_status_enum"`);
  }

  // ---------------------------------------------------------------------------
  // 0. Pré-requisito: schema completo da versão de loja única
  // ---------------------------------------------------------------------------

  private async assertLegacySchema(queryRunner: QueryRunner): Promise<void> {
    const missing: string[] = [];
    for (const [table, columns] of Object.entries(REQUIRED_LEGACY_COLUMNS)) {
      if (!(await queryRunner.hasTable(table))) {
        missing.push(table);
        continue;
      }
      for (const column of columns) {
        if (!(await queryRunner.hasColumn(table, column))) {
          missing.push(`${table}.${column}`);
        }
      }
    }
    if (missing.length) {
      throw new Error(
        `O banco está numa versão anterior do schema de loja única (faltam: ${missing.join(', ')}). ` +
          'Suba uma vez a versão anterior da API com DB_SYNCHRONIZE=true (com backup do banco) e rode as migrations de novo.',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Tabelas novas (plataforma, cobrança SaaS, identidade, auditoria)
  // ---------------------------------------------------------------------------

  private async createPlatformTables(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."stores_account_status_enum" AS ENUM('ACTIVE', 'SUSPENDED', 'INACTIVE')`,
    );
    await queryRunner.query(
      `CREATE TABLE "stores" ("id" SERIAL NOT NULL, "slug" character varying(60) NOT NULL, "name" character varying(120) NOT NULL, "legal_name" character varying(160), "document" character varying(14), "email" character varying(160), "phone" character varying(20), "description" character varying(300), "logo" character varying(255), "primary_color" character varying(7), "address_zip_code" character varying(8), "address_street" character varying(160), "address_number" character varying(20), "address_complement" character varying(80), "address_neighborhood" character varying(80), "address_city" character varying(80), "address_state" character varying(2), "account_status" "public"."stores_account_status_enum" NOT NULL DEFAULT 'ACTIVE', "status_reason" character varying(300), "status_changed_at" TIMESTAMP WITH TIME ZONE, "is_open" boolean NOT NULL DEFAULT false, "opening_message" character varying(200), "closing_message" character varying(200), "delivery_enabled" boolean NOT NULL DEFAULT true, "takeout_enabled" boolean NOT NULL DEFAULT true, "delivery_zones" jsonb, "takeout_estimate" character varying(20), "opening_hours" jsonb, "time_zone" character varying(64) NOT NULL DEFAULT 'America/Sao_Paulo', "mp_public_key" character varying(120), "mp_access_token_encrypted" text, "custom_domain" character varying(253), "owner_user_id" integer, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_7aa6e7d71fa7acdd7ca43d7c9cb" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_stores_slug" ON "stores" ("slug") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_stores_custom_domain" ON "stores" ("custom_domain") `,
    );

    await queryRunner.query(
      `CREATE TABLE "audit_logs" ("id" SERIAL NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "actor_user_id" integer, "actor_email" character varying(160), "actor_scope" character varying(20) NOT NULL, "store_id" integer, "action" character varying(80) NOT NULL, "target_type" character varying(40), "target_id" character varying(64), "result" character varying(20) NOT NULL, "ip" character varying(64), "user_agent" character varying(300), "metadata" jsonb, CONSTRAINT "PK_1bb179d048bbc581caa3b013439" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_logs_action_created" ON "audit_logs" ("action", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_logs_actor_created" ON "audit_logs" ("actor_user_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_logs_store_created" ON "audit_logs" ("store_id", "created_at") `,
    );

    await queryRunner.query(
      `CREATE TABLE "password_reset_tokens" ("id" SERIAL NOT NULL, "user_id" integer NOT NULL, "token_hash" character varying(64) NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "used_at" TIMESTAMP WITH TIME ZONE, "created_by_user_id" integer, "requested_ip" character varying(64), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_d16bebd73e844c48bca50ff8d3d" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_password_reset_tokens_user_id" ON "password_reset_tokens" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_password_reset_tokens_token_hash" ON "password_reset_tokens" ("token_hash") `,
    );

    await queryRunner.query(
      `CREATE TABLE "billing_webhook_events" ("id" SERIAL NOT NULL, "provider" character varying(20) NOT NULL, "event_key" character varying(200) NOT NULL, "topic" character varying(60), "resource_id" character varying(80), "status" character varying(20) NOT NULL DEFAULT 'RECEIVED', "error" text, "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "processed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_a4c2d2eae68da905a0b6063d0ea" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_billing_webhook_events_key" ON "billing_webhook_events" ("provider", "event_key") `,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."plans_billing_interval_enum" AS ENUM('MONTHLY', 'YEARLY')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."plans_status_enum" AS ENUM('ACTIVE', 'INACTIVE')`,
    );
    await queryRunner.query(
      `CREATE TABLE "plans" ("id" SERIAL NOT NULL, "code" character varying(40) NOT NULL, "name" character varying(80) NOT NULL, "description" text, "price" numeric(10,2) NOT NULL DEFAULT '0', "currency" character varying(3) NOT NULL DEFAULT 'BRL', "billing_interval" "public"."plans_billing_interval_enum" NOT NULL DEFAULT 'MONTHLY', "trial_days" integer NOT NULL DEFAULT '0', "max_staff_users" integer, "max_products" integer, "max_monthly_orders" integer, "features" jsonb NOT NULL, "status" "public"."plans_status_enum" NOT NULL DEFAULT 'ACTIVE', "is_public" boolean NOT NULL DEFAULT true, "sort_order" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_3720521a81c7c24fe9b7202ba61" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_plans_code" ON "plans" ("code") `,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."subscriptions_status_enum" AS ENUM('TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELED')`,
    );
    await queryRunner.query(
      `CREATE TABLE "subscriptions" ("id" SERIAL NOT NULL, "store_id" integer NOT NULL, "plan_id" integer NOT NULL, "status" "public"."subscriptions_status_enum" NOT NULL, "trial_ends_at" TIMESTAMP WITH TIME ZONE, "current_period_start" TIMESTAMP WITH TIME ZONE, "current_period_end" TIMESTAMP WITH TIME ZONE, "cancel_at_period_end" boolean NOT NULL DEFAULT false, "canceled_at" TIMESTAMP WITH TIME ZONE, "past_due_since" TIMESTAMP WITH TIME ZONE, "grace_period_ends_at" TIMESTAMP WITH TIME ZONE, "suspended_at" TIMESTAMP WITH TIME ZONE, "billing_provider" character varying(20) NOT NULL DEFAULT 'MANUAL', "provider_subscription_id" character varying(80), "provider_status" character varying(40), "provider_checkout_url" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_a87248d73155605cf782be9ee5e" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_subscriptions_store_id" ON "subscriptions" ("store_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_subscriptions_plan_id" ON "subscriptions" ("plan_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_subscriptions_status" ON "subscriptions" ("status") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_subscriptions_provider_subscription_id" ON "subscriptions" ("provider_subscription_id") `,
    );
    // Uma única assinatura não cancelada por loja (as canceladas ficam como histórico)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_subscriptions_store_current" ON "subscriptions" ("store_id") WHERE "status" <> 'CANCELED'`,
    );

    await queryRunner.query(
      `CREATE TABLE "subscription_events" ("id" SERIAL NOT NULL, "subscription_id" integer NOT NULL, "store_id" integer NOT NULL, "type" character varying(40) NOT NULL, "from_status" character varying(20), "to_status" character varying(20), "from_plan_id" integer, "to_plan_id" integer, "actor_user_id" integer, "reason" character varying(300), "metadata" jsonb, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_7eb5647aa3071cffad0124bceee" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_subscription_events_subscription_id" ON "subscription_events" ("subscription_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_subscription_events_store_created" ON "subscription_events" ("store_id", "created_at") `,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."subscription_invoices_status_enum" AS ENUM('OPEN', 'PAID', 'FAILED', 'VOID')`,
    );
    await queryRunner.query(
      `CREATE TABLE "subscription_invoices" ("id" SERIAL NOT NULL, "subscription_id" integer NOT NULL, "store_id" integer NOT NULL, "plan_id" integer NOT NULL, "amount" numeric(10,2) NOT NULL, "currency" character varying(3) NOT NULL DEFAULT 'BRL', "status" "public"."subscription_invoices_status_enum" NOT NULL DEFAULT 'OPEN', "period_start" TIMESTAMP WITH TIME ZONE NOT NULL, "period_end" TIMESTAMP WITH TIME ZONE NOT NULL, "due_at" TIMESTAMP WITH TIME ZONE NOT NULL, "paid_at" TIMESTAMP WITH TIME ZONE, "billing_provider" character varying(20) NOT NULL DEFAULT 'MANUAL', "provider_payment_id" character varying(80), "payment_method" character varying(40), "notes" character varying(300), "failure_reason" character varying(300), "attempts" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_7050ae7d81f0f0207b8f1cd2efc" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_subscription_invoices_subscription_id" ON "subscription_invoices" ("subscription_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_subscription_invoices_status" ON "subscription_invoices" ("status") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_subscription_invoices_provider_payment_id" ON "subscription_invoices" ("provider_payment_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_subscription_invoices_store_created" ON "subscription_invoices" ("store_id", "created_at") `,
    );

    await queryRunner.query(
      `CREATE TABLE "invitations" ("id" SERIAL NOT NULL, "store_id" integer NOT NULL, "email" character varying(160) NOT NULL, "role" character varying(20) NOT NULL, "make_owner" boolean NOT NULL DEFAULT false, "token_hash" character varying(64) NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "accepted_at" TIMESTAMP WITH TIME ZONE, "accepted_user_id" integer, "revoked_at" TIMESTAMP WITH TIME ZONE, "invited_by_user_id" integer, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_5dec98cfdfd562e4ad3648bbb07" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_invitations_store_id" ON "invitations" ("store_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_invitations_email" ON "invitations" ("email") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_invitations_token_hash" ON "invitations" ("token_hash") `,
    );

    await queryRunner.query(
      `CREATE TABLE "platform_settings" ("id" integer NOT NULL, "default_store_id" integer, "grace_period_days" integer NOT NULL DEFAULT '7', "support_session_minutes" integer NOT NULL DEFAULT '30', "store_self_signup_enabled" boolean NOT NULL DEFAULT false, "self_signup_plan_id" integer, "updated_by_user_id" integer, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_2934aeb70ec285196dcab4a2e96" PRIMARY KEY ("id"))`,
    );
    // Linha única com os padrões (7 dias de tolerância, sessões de suporte de 30 min, sem autoatendimento)
    await queryRunner.query(
      `INSERT INTO "platform_settings" ("id") VALUES (1)`,
    );

    await queryRunner.query(
      `CREATE TABLE "support_sessions" ("id" SERIAL NOT NULL, "platform_user_id" integer, "store_id" integer NOT NULL, "reason" character varying(300) NOT NULL, "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "ended_at" TIMESTAMP WITH TIME ZONE, "ip" character varying(64), CONSTRAINT "PK_3f42d6581b7be63ce898b1d0f65" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_support_sessions_store_started" ON "support_sessions" ("store_id", "started_at") `,
    );
  }

  // ---------------------------------------------------------------------------
  // 2. Colunas novas (store_id ainda opcional, para receber os dados existentes)
  // ---------------------------------------------------------------------------

  private async addTenantColumns(queryRunner: QueryRunner): Promise<void> {
    for (const table of TENANT_TABLES) {
      await queryRunner.query(`ALTER TABLE "${table}" ADD "store_id" integer`);
    }
    await queryRunner.query(`ALTER TABLE "users" ADD "store_id" integer`);
    await queryRunner.query(
      `CREATE TYPE "public"."users_platform_role_enum" AS ENUM('SUPER_ADMIN')`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "platform_role" "public"."users_platform_role_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "blocked_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "blocked_reason" character varying(300)`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "token_version" integer NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "last_login_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  // ---------------------------------------------------------------------------
  // 3. Dados existentes → loja inicial
  // ---------------------------------------------------------------------------

  private async migrateExistingData(queryRunner: QueryRunner): Promise<void> {
    const [counts] = (await queryRunner.query(`
      SELECT
        (SELECT COUNT(*) FROM "users")::int AS "users",
        (SELECT COUNT(*) FROM "users" WHERE "role" <> 'CLIENT')::int AS "staff",
        (SELECT COUNT(*) FROM "products")::int AS "products",
        (SELECT COUNT(*) FROM "addons")::int AS "addons",
        (SELECT COUNT(*) FROM "orders")::int AS "orders",
        (SELECT COUNT(*) FROM "payments")::int AS "payments"
    `)) as Record<
      'users' | 'staff' | 'products' | 'addons' | 'orders' | 'payments',
      number
    >[];
    const hasStoreConfig = await queryRunner.hasTable('store_config');
    const [config] = hasStoreConfig
      ? ((await queryRunner.query(
          `SELECT "is_open", "opening_message", "closing_message" FROM "store_config" ORDER BY "id" ASC LIMIT 1`,
        )) as {
          is_open: boolean;
          opening_message: string | null;
          closing_message: string | null;
        }[])
      : [];

    const hasLegacyData =
      !!config || Object.values(counts).some((count) => count > 0);
    // Banco novo: nenhuma loja é criada aqui (o superadmin cadastra; em development/test o seed cria a loja demo)
    if (!hasLegacyData) return;

    const name =
      process.env.INITIAL_STORE_NAME?.trim().slice(0, 120) ||
      DEFAULT_INITIAL_STORE_NAME;
    const requestedSlug = process.env.INITIAL_STORE_SLUG?.trim().toLowerCase();
    const slug =
      requestedSlug && SLUG_PATTERN.test(requestedSlug)
        ? requestedSlug
        : DEFAULT_INITIAL_STORE_SLUG;

    const [{ id: storeId }] = (await queryRunner.query(
      `INSERT INTO "stores" ("slug", "name", "phone", "address_zip_code", "address_street", "address_number",
         "address_complement", "address_neighborhood", "address_city", "address_state", "opening_hours",
         "is_open", "opening_message", "closing_message", "time_zone")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING "id"`,
      [
        slug,
        name,
        LEGACY_STOREFRONT_INFO.phone,
        LEGACY_STOREFRONT_INFO.address_zip_code,
        LEGACY_STOREFRONT_INFO.address_street,
        LEGACY_STOREFRONT_INFO.address_number,
        LEGACY_STOREFRONT_INFO.address_complement,
        LEGACY_STOREFRONT_INFO.address_neighborhood,
        LEGACY_STOREFRONT_INFO.address_city,
        LEGACY_STOREFRONT_INFO.address_state,
        JSON.stringify(LEGACY_STOREFRONT_INFO.opening_hours),
        // Sem configuração gravada, a versão anterior criava a loja aberta
        config ? config.is_open : true,
        // Versões antigas não limitavam o tamanho das mensagens: stores aceita até 200
        config?.opening_message?.slice(0, 200) ?? null,
        config?.closing_message?.slice(0, 200) ?? null,
        validTimeZone(process.env.STORE_TIME_ZONE),
      ],
    )) as { id: number }[];

    // A loja inicial é a das rotas antigas (app mobile e integrações da versão de loja única)
    await queryRunner.query(
      `UPDATE "platform_settings" SET "default_store_id" = $1 WHERE "id" = 1`,
      [storeId],
    );

    // Pedidos de entrega anteriores ao retrato do endereço passam a guardar o endereço como está hoje:
    // a equipe deixa de depender do endereço "vivo" do cliente, que é global (vale para todas as lojas)
    const [{ pending: snapshotted }] = (await queryRunner.query(
      `SELECT COUNT(*)::int AS "pending" FROM "orders" o JOIN "addresses" a ON a."id" = o."address_id"
       WHERE o."type" = 'DELIVERY' AND o."delivery_address" IS NULL`,
    )) as { pending: number }[];
    await queryRunner.query(
      `UPDATE "orders" o SET "delivery_address" = json_build_object(
         'street', a."street", 'number', a."number", 'complement', NULLIF(a."complement", ''),
         'neighborhood', a."neighborhood", 'city', a."city", 'state', a."state",
         'zipCode', a."zipCode", 'nickname', NULLIF(a."nickname", '')
       )::text
       FROM "addresses" a
       WHERE o."address_id" = a."id" AND o."type" = 'DELIVERY' AND o."delivery_address" IS NULL`,
    );

    for (const table of TENANT_TABLES) {
      await queryRunner.query(`UPDATE "${table}" SET "store_id" = $1`, [
        storeId,
      ]);
    }
    // A equipe (inclusive a que está na lixeira) passa a pertencer à loja inicial; clientes seguem globais
    await queryRunner.query(
      `UPDATE "users" SET "store_id" = $1 WHERE "role" <> 'CLIENT'`,
      [storeId],
    );
    // Responsável principal: o administrador ativo mais antigo
    await queryRunner.query(
      `UPDATE "stores" SET "owner_user_id" = (
         SELECT "id" FROM "users" WHERE "role" = 'ADMIN' AND "deleted_at" IS NULL ORDER BY "id" ASC LIMIT 1
       ) WHERE "id" = $1`,
      [storeId],
    );

    // Plano interno da loja que já operava: sem cobrança, sem limites, indisponível para novas contratações
    const [{ id: planId }] = (await queryRunner.query(
      `INSERT INTO "plans" ("code", "name", "description", "price", "billing_interval", "trial_days", "features", "status", "is_public", "sort_order")
       VALUES ('legado', 'Plano legado', $1, 0, 'MONTHLY', 0, $2, 'INACTIVE', false, 999)
       RETURNING "id"`,
      [
        'Plano interno criado na migração para a loja que já operava antes do SaaS multi-tenant. Sem cobrança e sem limites. Troque por um plano comercial quando quiser.',
        JSON.stringify({
          online_payments: true,
          advanced_reports: true,
          custom_branding: true,
        }),
      ],
    )) as { id: number }[];

    const [{ id: subscriptionId }] = (await queryRunner.query(
      `INSERT INTO "subscriptions" ("store_id", "plan_id", "status", "current_period_start", "billing_provider")
       VALUES ($1, $2, 'ACTIVE', now(), 'MANUAL')
       RETURNING "id"`,
      [storeId, planId],
    )) as { id: number }[];
    await queryRunner.query(
      `INSERT INTO "subscription_events" ("subscription_id", "store_id", "type", "to_status", "to_plan_id", "reason")
       VALUES ($1, $2, 'CREATED', 'ACTIVE', $3, $4)`,
      [
        subscriptionId,
        storeId,
        planId,
        'Migração da instalação de loja única para o SaaS multi-tenant',
      ],
    );

    await queryRunner.query(
      `INSERT INTO "audit_logs" ("actor_scope", "store_id", "action", "target_type", "target_id", "result", "metadata")
       VALUES ('SYSTEM', $1, 'platform.migration.initial_store', 'store', $2, 'SUCCESS', $3)`,
      [
        storeId,
        String(storeId),
        JSON.stringify({
          slug,
          migrated: counts,
          store_config_found: !!config,
          delivery_addresses_snapshotted: snapshotted,
          // Endereço, telefone e horários vieram dos valores fixos da vitrine antiga: revisar no painel
          storefront_info_source: 'frontend-web STORE_INFO',
        }),
      ],
    );
  }

  // ---------------------------------------------------------------------------
  // 4. store_id obrigatório, chaves, índices e CHECK
  // ---------------------------------------------------------------------------

  private async enforceTenantColumns(queryRunner: QueryRunner): Promise<void> {
    for (const table of TENANT_TABLES) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "store_id" SET NOT NULL`,
      );
    }
  }

  private async createConstraints(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_addons_store_id" ON "addons" ("store_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_products_store_id" ON "products" ("store_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_store_status" ON "orders" ("store_id", "status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_store_created_at" ON "orders" ("store_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_users_store_id" ON "users" ("store_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_payments_store_id" ON "payments" ("store_id") `,
    );
    // Idempotência dos pagamentos por loja: a mesma chave do mesmo cliente em outra loja é outro pagamento
    await queryRunner.query(
      `DROP INDEX "public"."UQ_payments_user_idempotency_key"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_payments_store_user_idempotency_key" ON "payments" ("store_id", "user_id", "idempotency_key") `,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "CHK_users_store_membership" CHECK (("role" = 'CLIENT' AND "store_id" IS NULL) OR ("role" <> 'CLIENT' AND "store_id" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_settings" ADD CONSTRAINT "FK_platform_settings_default_store" FOREIGN KEY ("default_store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stores" ADD CONSTRAINT "FK_stores_owner_user" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "addons" ADD CONSTRAINT "FK_addons_store" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" ADD CONSTRAINT "FK_products_store" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_orders_store" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "FK_users_store" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ADD CONSTRAINT "FK_audit_logs_actor" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ADD CONSTRAINT "FK_audit_logs_store" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "FK_password_reset_tokens_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "FK_password_reset_tokens_created_by" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscriptions" ADD CONSTRAINT "FK_subscriptions_store" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscriptions" ADD CONSTRAINT "FK_subscriptions_plan" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscription_events" ADD CONSTRAINT "FK_subscription_events_subscription" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscription_events" ADD CONSTRAINT "FK_subscription_events_store" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscription_events" ADD CONSTRAINT "FK_subscription_events_actor" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscription_invoices" ADD CONSTRAINT "FK_subscription_invoices_subscription" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscription_invoices" ADD CONSTRAINT "FK_subscription_invoices_store" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscription_invoices" ADD CONSTRAINT "FK_subscription_invoices_plan" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "invitations" ADD CONSTRAINT "FK_invitations_store" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "invitations" ADD CONSTRAINT "FK_invitations_accepted_user" FOREIGN KEY ("accepted_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "invitations" ADD CONSTRAINT "FK_invitations_invited_by" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "FK_payments_store" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_settings" ADD CONSTRAINT "FK_platform_settings_self_signup_plan" FOREIGN KEY ("self_signup_plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_settings" ADD CONSTRAINT "FK_platform_settings_updated_by" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_sessions" ADD CONSTRAINT "FK_support_sessions_platform_user" FOREIGN KEY ("platform_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "support_sessions" ADD CONSTRAINT "FK_support_sessions_store" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  // ---------------------------------------------------------------------------
  // 5. Triggers: o banco recusa relacionar dados de lojas diferentes
  //    (defesa extra: a API já valida tudo isso antes de gravar)
  // ---------------------------------------------------------------------------

  private async createTenantTriggers(queryRunner: QueryRunner): Promise<void> {
    // Produto só aceita adicionais da própria loja
    await queryRunner.query(`
      CREATE FUNCTION "tenant_check_product_allowed_addon"() RETURNS trigger AS $$
      BEGIN
        IF (SELECT "store_id" FROM "products" WHERE "id" = NEW."product_id")
           IS DISTINCT FROM (SELECT "store_id" FROM "addons" WHERE "id" = NEW."addon_id") THEN
          RAISE EXCEPTION 'O adicional % não pertence à loja do produto %.', NEW."addon_id", NEW."product_id"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(
      `CREATE TRIGGER "TRG_product_allowed_addons_same_store" BEFORE INSERT OR UPDATE ON "product_allowed_addons" FOR EACH ROW EXECUTE FUNCTION "tenant_check_product_allowed_addon"()`,
    );

    // Item de pedido só com produto da loja do pedido (produto apagado de vez = só o retrato)
    await queryRunner.query(`
      CREATE FUNCTION "tenant_check_order_item"() RETURNS trigger AS $$
      BEGIN
        IF NEW."productId" IS NOT NULL AND
           (SELECT "store_id" FROM "products" WHERE "id" = NEW."productId")
           IS DISTINCT FROM (SELECT "store_id" FROM "orders" WHERE "id" = NEW."orderId") THEN
          RAISE EXCEPTION 'O produto % não pertence à loja do pedido %.', NEW."productId", NEW."orderId"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(
      `CREATE TRIGGER "TRG_order_items_same_store" BEFORE INSERT OR UPDATE OF "productId", "orderId" ON "order_items" FOR EACH ROW EXECUTE FUNCTION "tenant_check_order_item"()`,
    );

    // Adicional de item só da loja do pedido
    await queryRunner.query(`
      CREATE FUNCTION "tenant_check_order_item_addon"() RETURNS trigger AS $$
      BEGIN
        IF (SELECT "store_id" FROM "addons" WHERE "id" = NEW."addonsId")
           IS DISTINCT FROM (
             SELECT o."store_id" FROM "order_items" i JOIN "orders" o ON o."id" = i."orderId"
             WHERE i."id" = NEW."orderItemsId"
           ) THEN
          RAISE EXCEPTION 'O adicional % não pertence à loja do pedido.', NEW."addonsId"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(
      `CREATE TRIGGER "TRG_order_item_addons_same_store" BEFORE INSERT OR UPDATE ON "order_item_addons" FOR EACH ROW EXECUTE FUNCTION "tenant_check_order_item_addon"()`,
    );

    // Entregador do pedido precisa ser da equipe da mesma loja
    await queryRunner.query(`
      CREATE FUNCTION "tenant_check_order_driver"() RETURNS trigger AS $$
      BEGIN
        IF NEW."driver_id" IS NOT NULL AND
           (SELECT "store_id" FROM "users" WHERE "id" = NEW."driver_id") IS DISTINCT FROM NEW."store_id" THEN
          RAISE EXCEPTION 'O entregador % não pertence à loja do pedido.', NEW."driver_id"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(
      `CREATE TRIGGER "TRG_orders_driver_same_store" BEFORE INSERT OR UPDATE OF "driver_id", "store_id" ON "orders" FOR EACH ROW EXECUTE FUNCTION "tenant_check_order_driver"()`,
    );

    // Pagamento só quita pedido da mesma loja
    await queryRunner.query(`
      CREATE FUNCTION "tenant_check_payment_order"() RETURNS trigger AS $$
      BEGIN
        IF NEW."order_id" IS NOT NULL AND
           (SELECT "store_id" FROM "orders" WHERE "id" = NEW."order_id") IS DISTINCT FROM NEW."store_id" THEN
          RAISE EXCEPTION 'O pedido % não pertence à loja do pagamento %.', NEW."order_id", NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(
      `CREATE TRIGGER "TRG_payments_order_same_store" BEFORE INSERT OR UPDATE OF "order_id", "store_id" ON "payments" FOR EACH ROW EXECUTE FUNCTION "tenant_check_payment_order"()`,
    );

    // Um registro nunca muda de loja (mover um produto/pedido levaria junto vínculos de outra loja)
    await queryRunner.query(`
      CREATE FUNCTION "tenant_store_id_immutable"() RETURNS trigger AS $$
      BEGIN
        IF NEW."store_id" IS DISTINCT FROM OLD."store_id" THEN
          RAISE EXCEPTION 'A loja de um registro de % não pode ser alterada.', TG_TABLE_NAME
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql`);
    for (const table of TENANT_TABLES) {
      await queryRunner.query(
        `CREATE TRIGGER "TRG_${table}_store_immutable" BEFORE UPDATE OF "store_id" ON "${table}" FOR EACH ROW EXECUTE FUNCTION "tenant_store_id_immutable"()`,
      );
    }
  }

  /** O que o down() apagaria ou desfaria (vazio = nada a perder: pode reverter sem autorização). */
  private async destructiveRevertLosses(
    queryRunner: QueryRunner,
  ): Promise<string[]> {
    const [counts] = (await queryRunner.query(
      `SELECT
         (SELECT COUNT(*)::int FROM "audit_logs") AS "audit_logs",
         (SELECT COUNT(*)::int FROM "subscription_invoices") AS "invoices",
         (SELECT COUNT(*)::int FROM "subscription_events") AS "events",
         (SELECT COUNT(*)::int FROM "support_sessions") AS "support_sessions",
         (SELECT COUNT(*)::int FROM "invitations") AS "invitations",
         (SELECT COUNT(*)::int FROM "password_reset_tokens") AS "reset_tokens",
         (SELECT COUNT(*)::int FROM "users" WHERE "blocked_at" IS NOT NULL) AS "blocked",
         (SELECT COUNT(*)::int FROM "users" WHERE "token_version" > 0) AS "revoked"`,
    )) as Record<string, number>[];
    const items: [number, string][] = [
      [counts.audit_logs, 'registro(s) de auditoria'],
      [counts.invoices, 'fatura(s) da cobrança SaaS'],
      [counts.events, 'evento(s) do histórico das assinaturas'],
      [counts.support_sessions, 'sessão(ões) de suporte'],
      [counts.invitations, 'convite(s)'],
      [counts.reset_tokens, 'pedido(s) de redefinição de senha'],
      [counts.blocked, 'bloqueio(s) de conta (voltariam a entrar)'],
      [counts.revoked, 'revogação(ões) de sessões de conta'],
    ];
    return items
      .filter(([count]) => Number(count) > 0)
      .map(([count, label]) => `${count} ${label}`);
  }

  private async dropTenantTriggers(queryRunner: QueryRunner): Promise<void> {
    for (const table of TENANT_TABLES) {
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS "TRG_${table}_store_immutable" ON "${table}"`,
      );
    }
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "tenant_store_id_immutable"()`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "TRG_payments_order_same_store" ON "payments"`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "TRG_orders_driver_same_store" ON "orders"`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "TRG_order_item_addons_same_store" ON "order_item_addons"`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "TRG_order_items_same_store" ON "order_items"`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "TRG_product_allowed_addons_same_store" ON "product_allowed_addons"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "tenant_check_payment_order"()`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "tenant_check_order_driver"()`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "tenant_check_order_item_addon"()`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "tenant_check_order_item"()`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "tenant_check_product_allowed_addon"()`,
    );
  }
}
