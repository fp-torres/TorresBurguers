import { MigrationInterface, QueryRunner } from 'typeorm';

/** Tabelas da plataforma cuja loja (store_id) nunca muda depois de gravada. */
const IMMUTABLE_STORE_TABLES = [
  'subscriptions',
  'subscription_events',
  'subscription_invoices',
  'invitations',
  'support_sessions',
] as const;

/** Linhas da assinatura que repetem a loja dela (store_id precisa ser o da assinatura). */
const SUBSCRIPTION_CHILD_TABLES = [
  'subscription_events',
  'subscription_invoices',
] as const;

const PLATFORM_ROLE_CHECK = `"platform_role" IS NULL OR ("role" = 'CLIENT' AND "store_id" IS NULL)`;

/**
 * Garantias no banco que antes dependiam só da aplicação (a API já grava tudo de forma coerente; isto é
 * a defesa contra um bug futuro ou um SQL manual de suporte):
 *
 * 1. subscriptions.suspended_by (PLATFORM | BILLING): origem da suspensão. A suspensão decidida pelo
 *    superadmin (PLATFORM) só é desfeita por ele; um pagamento aprovado regulariza apenas a inadimplência
 *    (BILLING). As assinaturas já suspensas recebem a origem pelo histórico (último STATUS_CHANGED para
 *    SUSPENDED com trigger platform.suspend → PLATFORM; o resto → BILLING, a regra antiga).
 * 2. CHK_users_platform_role: papel global (SUPER_ADMIN) só em conta CLIENT sem loja — papéis da
 *    plataforma e da loja separados (antes, só o comando platform:superadmin garantia). Criado NOT VALID
 *    e validado em seguida; contas que já violam a regra impedem a migration com a lista delas.
 * 3. Triggers de mesma loja (erro check_violation), conferidos só quando a ligação muda (linhas antigas
 *    nunca travam escritas em outras colunas):
 *    - orders.payment_id: o pagamento existe e é da loja do pedido;
 *    - subscription_events/subscription_invoices: store_id = o da assinatura;
 *    - stores.owner_user_id: o responsável é da equipe da própria loja;
 *    - invitations.accepted_user_id: a conta criada no aceite é da loja do convite.
 * 4. store_id imutável também em subscriptions, subscription_events, subscription_invoices, invitations e
 *    support_sessions (a função tenant_store_id_immutable da MultiTenantFoundation), e conta da equipe
 *    nunca passa de uma loja para outra (users.store_id A → B; virar cliente/equipe segue o CHECK de vínculo).
 *
 * down() desfaz tudo; a origem das suspensões (suspended_by) se perde.
 */
export class PlatformIntegrity1792800000000 implements MigrationInterface {
  name = 'PlatformIntegrity1792800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.addSuspensionSource(queryRunner);
    await this.addPlatformRoleCheck(queryRunner);
    await this.createSameStoreTriggers(queryRunner);
    await this.createImmutabilityTriggers(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "TRG_users_store_no_transfer" ON "users"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "tenant_user_store_no_transfer"()`,
    );
    for (const table of IMMUTABLE_STORE_TABLES) {
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS "TRG_${table}_store_immutable" ON "${table}"`,
      );
    }
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "TRG_invitations_accepted_user_same_store" ON "invitations"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "tenant_check_invitation_user"()`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "TRG_stores_owner_same_store" ON "stores"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "tenant_check_store_owner"()`,
    );
    for (const table of SUBSCRIPTION_CHILD_TABLES) {
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS "TRG_${table}_subscription_same_store" ON "${table}"`,
      );
    }
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "tenant_check_subscription_child"()`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "TRG_orders_payment_same_store" ON "orders"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "tenant_check_order_payment"()`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "CHK_users_platform_role"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "CHK_subscriptions_suspended_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "suspended_by"`,
    );
  }

  // ---------------------------------------------------------------------------
  // 1. Origem da suspensão
  // ---------------------------------------------------------------------------

  private async addSuspensionSource(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subscriptions" ADD "suspended_by" character varying(20)`,
    );
    await queryRunner.query(`
      UPDATE "subscriptions" "s" SET "suspended_by" = CASE WHEN (
        SELECT "e"."metadata" ->> 'trigger' FROM "subscription_events" "e"
         WHERE "e"."subscription_id" = "s"."id" AND "e"."type" = 'STATUS_CHANGED' AND "e"."to_status" = 'SUSPENDED'
         ORDER BY "e"."created_at" DESC, "e"."id" DESC LIMIT 1
      ) = 'platform.suspend' THEN 'PLATFORM' ELSE 'BILLING' END
      WHERE "s"."status" = 'SUSPENDED'`);
    await queryRunner.query(
      `ALTER TABLE "subscriptions" ADD CONSTRAINT "CHK_subscriptions_suspended_by" CHECK ("suspended_by" IS NULL OR "suspended_by" IN ('PLATFORM', 'BILLING'))`,
    );
  }

  // ---------------------------------------------------------------------------
  // 2. Papel global só em conta de cliente sem loja
  // ---------------------------------------------------------------------------

  private async addPlatformRoleCheck(queryRunner: QueryRunner): Promise<void> {
    const offending = (await queryRunner.query(
      `SELECT "id", "email", "role", "store_id" FROM "users"
        WHERE "platform_role" IS NOT NULL AND NOT (${PLATFORM_ROLE_CHECK})
        ORDER BY "id" LIMIT 20`,
    )) as {
      id: number;
      email: string;
      role: string;
      store_id: number | null;
    }[];
    if (offending.length) {
      const list = offending
        .map(
          (row) =>
            `#${row.id} ${row.email} (${row.role}, loja ${row.store_id ?? '—'})`,
        )
        .join('; ');
      throw new Error(
        `Migration recusada: ${offending.length === 20 ? 'pelo menos 20 contas' : `${offending.length} conta(s)`} com papel global ` +
          `(platform_role) também pertence(m) à equipe de uma loja: ${list}. Papéis da plataforma e da loja são ` +
          'separados: remova o papel global (npm run platform:superadmin -- --email=<e-mail> --revoke) ou tire a ' +
          'conta da equipe e rode as migrations de novo.',
      );
    }
    // NOT VALID + VALIDATE: a validação das linhas existentes não bloqueia escritas na tabela
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "CHK_users_platform_role" CHECK (${PLATFORM_ROLE_CHECK}) NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" VALIDATE CONSTRAINT "CHK_users_platform_role"`,
    );
  }

  // ---------------------------------------------------------------------------
  // 3. Ligações entre tabelas sempre na mesma loja
  // ---------------------------------------------------------------------------

  private async createSameStoreTriggers(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // Pedido pago online: o pagamento existe e é da loja do pedido (o sentido payments.order_id já
    // era conferido pela MultiTenantFoundation)
    await queryRunner.query(`
      CREATE FUNCTION "tenant_check_order_payment"() RETURNS trigger AS $$
      BEGIN
        IF NEW."payment_id" IS NULL THEN
          RETURN NEW;
        END IF;
        IF TG_OP = 'UPDATE' THEN
          IF NEW."payment_id" IS NOT DISTINCT FROM OLD."payment_id"
             AND NEW."store_id" IS NOT DISTINCT FROM OLD."store_id" THEN
            RETURN NEW;
          END IF;
        END IF;
        IF (SELECT "store_id" FROM "payments" WHERE "id" = NEW."payment_id") IS DISTINCT FROM NEW."store_id" THEN
          RAISE EXCEPTION 'O pagamento % não pertence à loja do pedido.', NEW."payment_id"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(
      `CREATE TRIGGER "TRG_orders_payment_same_store" BEFORE INSERT OR UPDATE OF "payment_id", "store_id" ON "orders" FOR EACH ROW EXECUTE FUNCTION "tenant_check_order_payment"()`,
    );

    // Evento e fatura da assinatura repetem a loja da assinatura
    await queryRunner.query(`
      CREATE FUNCTION "tenant_check_subscription_child"() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF NEW."subscription_id" IS NOT DISTINCT FROM OLD."subscription_id"
             AND NEW."store_id" IS NOT DISTINCT FROM OLD."store_id" THEN
            RETURN NEW;
          END IF;
        END IF;
        IF (SELECT "store_id" FROM "subscriptions" WHERE "id" = NEW."subscription_id") IS DISTINCT FROM NEW."store_id" THEN
          RAISE EXCEPTION 'A assinatura % não pertence à loja % (%).', NEW."subscription_id", NEW."store_id", TG_TABLE_NAME
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql`);
    for (const table of SUBSCRIPTION_CHILD_TABLES) {
      await queryRunner.query(
        `CREATE TRIGGER "TRG_${table}_subscription_same_store" BEFORE INSERT OR UPDATE OF "subscription_id", "store_id" ON "${table}" FOR EACH ROW EXECUTE FUNCTION "tenant_check_subscription_child"()`,
      );
    }

    // Responsável pela loja: conta da equipe da própria loja
    await queryRunner.query(`
      CREATE FUNCTION "tenant_check_store_owner"() RETURNS trigger AS $$
      BEGIN
        IF NEW."owner_user_id" IS NULL THEN
          RETURN NEW;
        END IF;
        IF TG_OP = 'UPDATE' THEN
          IF NEW."owner_user_id" IS NOT DISTINCT FROM OLD."owner_user_id" THEN
            RETURN NEW;
          END IF;
        END IF;
        IF (SELECT "store_id" FROM "users" WHERE "id" = NEW."owner_user_id") IS DISTINCT FROM NEW."id" THEN
          RAISE EXCEPTION 'O responsável % não pertence à equipe da loja %.', NEW."owner_user_id", NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(
      `CREATE TRIGGER "TRG_stores_owner_same_store" BEFORE INSERT OR UPDATE OF "owner_user_id" ON "stores" FOR EACH ROW EXECUTE FUNCTION "tenant_check_store_owner"()`,
    );

    // Convite aceito: a conta criada no aceite é da loja do convite
    await queryRunner.query(`
      CREATE FUNCTION "tenant_check_invitation_user"() RETURNS trigger AS $$
      BEGIN
        IF NEW."accepted_user_id" IS NULL THEN
          RETURN NEW;
        END IF;
        IF TG_OP = 'UPDATE' THEN
          IF NEW."accepted_user_id" IS NOT DISTINCT FROM OLD."accepted_user_id"
             AND NEW."store_id" IS NOT DISTINCT FROM OLD."store_id" THEN
            RETURN NEW;
          END IF;
        END IF;
        IF (SELECT "store_id" FROM "users" WHERE "id" = NEW."accepted_user_id") IS DISTINCT FROM NEW."store_id" THEN
          RAISE EXCEPTION 'A conta % não pertence à loja do convite %.', NEW."accepted_user_id", NEW."id"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(
      `CREATE TRIGGER "TRG_invitations_accepted_user_same_store" BEFORE INSERT OR UPDATE OF "accepted_user_id", "store_id" ON "invitations" FOR EACH ROW EXECUTE FUNCTION "tenant_check_invitation_user"()`,
    );
  }

  // ---------------------------------------------------------------------------
  // 4. store_id imutável (e conta da equipe sem troca de loja)
  // ---------------------------------------------------------------------------

  private async createImmutabilityTriggers(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // Mesma função das tabelas operacionais (MultiTenantFoundation)
    for (const table of IMMUTABLE_STORE_TABLES) {
      await queryRunner.query(
        `CREATE TRIGGER "TRG_${table}_store_immutable" BEFORE UPDATE OF "store_id" ON "${table}" FOR EACH ROW EXECUTE FUNCTION "tenant_store_id_immutable"()`,
      );
    }

    // Conta da equipe nunca muda de loja (levaria junto pedidos atribuídos, convites e auditoria de
    // outra loja). Virar cliente (sem loja) ou equipe (com loja) continua sob o CHK_users_store_membership.
    await queryRunner.query(`
      CREATE FUNCTION "tenant_user_store_no_transfer"() RETURNS trigger AS $$
      BEGIN
        IF OLD."store_id" IS NOT NULL AND NEW."store_id" IS NOT NULL
           AND NEW."store_id" <> OLD."store_id" THEN
          RAISE EXCEPTION 'A conta % não pode passar da loja % para a loja %.', OLD."id", OLD."store_id", NEW."store_id"
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(
      `CREATE TRIGGER "TRG_users_store_no_transfer" BEFORE UPDATE OF "store_id" ON "users" FOR EACH ROW EXECUTE FUNCTION "tenant_user_store_no_transfer"()`,
    );
  }
}
