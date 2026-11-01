import { expect, test } from '@playwright/test';
import {
  Cleanup,
  createPlan,
  createStore,
  defaultSession,
  newApi,
  newCustomer,
  sql,
  type BillingStore,
  type Member,
  type Session,
} from './helpers';

/**
 * Garantias no banco (migration PlatformIntegrity): papel global só em conta de cliente sem loja e
 * ligações entre tabelas da plataforma sempre na mesma loja, mesmo para um SQL manual (a API já grava
 * tudo de forma coerente). Cada tentativa recusada não grava nada; as aceitas são desfeitas no fim.
 */

const cleanup = new Cleanup();
let superadmin: Session;
let storeA: BillingStore;
let storeB: BillingStore;
let client: Member;

test.beforeAll(async () => {
  const api = await newApi();
  superadmin = await defaultSession(api, 'superadmin');
  const plan = await createPlan(api, superadmin, cleanup, { name: 'Integridade E2E', price: 19.9 });
  storeA = await createStore(api, superadmin, cleanup, plan.id, 'Integridade A', { open: false });
  storeB = await createStore(api, superadmin, cleanup, plan.id, 'Integridade B', { open: false });
  client = await newCustomer(api);
  await api.dispose();
});

test.afterAll(async () => {
  await cleanup.run();
});

/** O banco recusa (check_violation/CHECK) e a mensagem explica o porquê. */
async function expectRefused(label: string, text: string, values: unknown[], message: RegExp): Promise<void> {
  let error: unknown = null;
  try {
    await sql(text, values);
  } catch (caught) {
    error = caught;
  }
  expect(error, `${label}: o banco deveria recusar`).not.toBeNull();
  expect(String((error as Error).message), label).toMatch(message);
}

test('papel global (platform_role) só em conta de cliente sem loja: equipe de loja nunca vira superadmin', async () => {
  await expectRefused(
    'ADMIN da loja A com papel global',
    `UPDATE "users" SET "platform_role" = 'SUPER_ADMIN' WHERE "id" = $1`,
    [storeA.owner.user.id],
    /CHK_users_platform_role/,
  );
  await expectRefused(
    'superadmin preso à equipe de uma loja',
    `UPDATE "users" SET "role" = 'ADMIN', "store_id" = $1 WHERE "id" = $2`,
    [storeA.id, superadmin.user.id],
    /CHK_users_platform_role/,
  );
  const [owner] = await sql<{ platform_role: string | null }>('SELECT "platform_role" FROM "users" WHERE "id" = $1', [storeA.owner.user.id]);
  expect(owner.platform_role).toBeNull();
  const [sa] = await sql<{ role: string; store_id: number | null }>('SELECT "role", "store_id" FROM "users" WHERE "id" = $1', [
    superadmin.user.id,
  ]);
  expect(sa).toEqual({ role: 'CLIENT', store_id: null });
});

test('faturas e eventos da assinatura sempre na loja da assinatura; store_id imutável nas tabelas da plataforma', async () => {
  const [invoice] = await sql<{ id: number }>('SELECT "id" FROM "subscription_invoices" WHERE "subscription_id" = $1 LIMIT 1', [
    storeA.subscriptionId,
  ]);
  expect(invoice, 'o plano pago abriu a fatura do 1º período').toBeDefined();

  await expectRefused(
    'evento da assinatura de A gravado na loja B',
    `INSERT INTO "subscription_events" ("subscription_id", "store_id", "type") VALUES ($1, $2, 'NOTE')`,
    [storeA.subscriptionId, storeB.id],
    /A assinatura \d+ não pertence à loja \d+ \(subscription_events\)/,
  );
  await expectRefused(
    'fatura de A apontando para a assinatura de B',
    'UPDATE "subscription_invoices" SET "subscription_id" = $1 WHERE "id" = $2',
    [storeB.subscriptionId, invoice.id],
    /A assinatura \d+ não pertence à loja \d+ \(subscription_invoices\)/,
  );
  for (const [table, id] of [
    ['subscription_invoices', invoice.id],
    ['subscriptions', storeA.subscriptionId],
  ] as const) {
    await expectRefused(
      `${table} #${id} → loja B`,
      `UPDATE "${table}" SET "store_id" = $1 WHERE "id" = $2`,
      [storeB.id, id],
      new RegExp(`A loja de um registro de ${table} não pode ser alterada\\.`),
    );
  }
  const [stored] = await sql<{ store_id: number; subscription_id: number }>(
    'SELECT "store_id", "subscription_id" FROM "subscription_invoices" WHERE "id" = $1',
    [invoice.id],
  );
  expect(stored).toEqual({ store_id: storeA.id, subscription_id: storeA.subscriptionId });
});

test('pedido pago só com pagamento da própria loja; responsável e convite aceito só da equipe da loja; equipe não muda de loja', async () => {
  await expectRefused(
    'pedido com pagamento inexistente',
    `INSERT INTO "orders" ("store_id", "total_price", "payment_method", "payment_id") VALUES ($1, 10, 'PIX', $2)`,
    [storeA.id, 990000000001],
    /O pagamento \d+ não pertence à loja do pedido\./,
  );
  await expectRefused(
    'responsável da loja A = ADMIN da loja B',
    'UPDATE "stores" SET "owner_user_id" = $1 WHERE "id" = $2',
    [storeB.owner.user.id, storeA.id],
    /O responsável \d+ não pertence à equipe da loja \d+\./,
  );
  await expectRefused(
    'responsável da loja A = cliente (sem loja)',
    'UPDATE "stores" SET "owner_user_id" = $1 WHERE "id" = $2',
    [client.user.id, storeA.id],
    /não pertence à equipe da loja/,
  );
  await expectRefused(
    'convite da loja A aceito por conta da loja B',
    `INSERT INTO "invitations" ("store_id", "email", "role", "token_hash", "expires_at", "accepted_at", "accepted_user_id")
     VALUES ($1, 'integridade@e2e.test', 'EMPLOYEE', $2, now() + interval '1 day', now(), $3)`,
    [storeA.id, 'f'.repeat(64), storeB.owner.user.id],
    /A conta \d+ não pertence à loja do convite/,
  );
  await expectRefused(
    'ADMIN da loja A passando para a loja B',
    'UPDATE "users" SET "store_id" = $1 WHERE "id" = $2',
    [storeB.id, storeA.owner.user.id],
    /A conta \d+ não pode passar da loja \d+ para a loja \d+\./,
  );

  // Ligações coerentes continuam aceitas (e não mudam nada aqui)
  await sql('UPDATE "stores" SET "owner_user_id" = $1 WHERE "id" = $2', [storeA.owner.user.id, storeA.id]);
  const [store] = await sql<{ owner_user_id: number }>('SELECT "owner_user_id" FROM "stores" WHERE "id" = $1', [storeA.id]);
  expect(store.owner_user_id).toBe(storeA.owner.user.id);
  const [owner] = await sql<{ store_id: number }>('SELECT "store_id" FROM "users" WHERE "id" = $1', [storeA.owner.user.id]);
  expect(owner.store_id).toBe(storeA.id);
  expect(await sql('SELECT 1 FROM "invitations" WHERE "email" = $1', ['integridade@e2e.test'])).toEqual([]);
});
