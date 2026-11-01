import { test, expect, type APIRequestContext } from '@playwright/test';
import { loginAs } from '../../../support/api';
import {
  Cleanup,
  addAddon,
  addProduct,
  bearer,
  buildTeam,
  cancelOrderLater,
  createStore,
  demoStore,
  getJson,
  newApi,
  newCustomer,
  payCard,
  placeOrder,
  retireStore,
  trashProductLater,
  withTestDb,
  type Json,
  type Member,
  type PgClient,
  type PgError,
  type PublicStore,
  type Session,
  type Team,
  type TenantStore,
} from './helpers';

/**
 * Seção 16 do pedido — defesa em profundidade NO BANCO (docs/saas/arquitetura.md §3.3): mesmo que um
 * bug na API deixasse passar, o PostgreSQL recusa relacionar registros de lojas diferentes (triggers
 * com erro check_violation = 23514) e nunca deixa um registro mudar de loja.
 *
 * Tudo roda no banco *_e2e desta execução (withTestDb recusa qualquer outro), cada tentativa dentro de
 * uma transação desfeita no fim (ROLLBACK): nada do que é testado aqui fica gravado.
 */
const CHECK_VIOLATION = '23514';

/** A instrução precisa ser recusada pelo banco com check_violation (trigger ou CHECK). */
async function expectRefused(
  db: PgClient,
  label: string,
  sql: string,
  values: unknown[],
  message: RegExp,
  constraint?: string,
): Promise<void> {
  let error: PgError | null = null;
  await db.query('BEGIN');
  try {
    await db.query(sql, values);
  } catch (caught) {
    error = caught as PgError;
  } finally {
    await db.query('ROLLBACK');
  }
  expect(error, `${label}: o banco precisa recusar a relação entre lojas`).not.toBeNull();
  expect(error?.code, `${label}: check_violation (${error?.message})`).toBe(CHECK_VIOLATION);
  expect(error?.message, `${label}: mensagem do banco`).toMatch(message);
  if (constraint) expect(error?.constraint, `${label}: restrição`).toBe(constraint);
}

/** Controle: a mesma instrução dentro da loja é aceita (prova que o trigger não recusa tudo). Desfeita no fim. */
async function expectAccepted(db: PgClient, label: string, sql: string, values: unknown[]): Promise<void> {
  await db.query('BEGIN');
  try {
    const result = await db.query(sql, values);
    expect(result.rowCount, `${label}: a relação dentro da mesma loja é aceita`).toBe(1);
  } finally {
    await db.query('ROLLBACK');
  }
}

test.describe('Isolamento entre lojas: defesa em profundidade no banco', () => {
  const cleanup = new Cleanup();
  let api: APIRequestContext;
  let superadmin: Session;
  let demo: PublicStore;
  let adminA: Session;
  let courierA: Session;
  let storeB: TenantStore;
  let teamB: Team;
  let client: Member;

  let addonA: Json;
  let productA: Json;
  let addonB: Json;
  let addonB2: Json;
  let productB: Json;
  let productB2: Json;
  let orderA: Json;
  let orderB: Json;
  let orderB2: Json;
  let paymentB: Json;
  let itemB: number;

  test.beforeAll(async () => {
    api = await newApi();
    superadmin = await loginAs(api, 'superadmin');
    demo = await demoStore();
    adminA = await loginAs(api, 'admin');
    courierA = await loginAs(api, 'courier');

    storeB = await createStore(api, superadmin, 'Banco');
    cleanup.add('desativar a loja B', () => retireStore(api, superadmin, storeB));
    teamB = await buildTeam(api, storeB);
    addonB = await addAddon(api, teamB.ADMIN, { price: 2 });
    addonB2 = await addAddon(api, teamB.ADMIN, { price: 1 });
    productB = await addProduct(api, teamB.ADMIN, { price: 21, allowed_addons_ids: [addonB.id] });
    productB2 = await addProduct(api, teamB.ADMIN, { price: 13 });

    // Loja A (demo): adicional e produto próprios do teste (vão para a lixeira no fim)
    addonA = await addAddon(api, adminA, { price: 2 });
    cleanup.add('lixeira do adicional da loja A', () => api.delete(`/addons/${addonA.id}`, { headers: bearer(adminA.token) }));
    productA = await addProduct(api, adminA, { price: 17, allowed_addons_ids: [addonA.id] });
    trashProductLater(cleanup, api, adminA, productA.id);

    client = await newCustomer(api, 'Cliente Banco');
    orderB = await placeOrder(api, storeB.slug, client, {
      items: [{ productId: productB.id, quantity: 1, addonIds: [addonB.id] }],
      type: 'TAKEOUT',
    });
    orderB2 = await placeOrder(api, storeB.slug, client, { items: [{ productId: productB2.id, quantity: 1 }], type: 'TAKEOUT' });
    orderA = await placeOrder(api, demo.slug, client, { items: [{ productId: productA.id, quantity: 1 }], type: 'TAKEOUT' });
    cancelOrderLater(cleanup, api, adminA, orderA.id);
    paymentB = await payCard(api, storeB.slug, client, { items: [{ productId: productB.id, quantity: 2 }], type: 'TAKEOUT' });

    itemB = await withTestDb(async (db) => {
      const { rows } = await db.query<{ id: number }>('SELECT "id" FROM "order_items" WHERE "orderId" = $1', [orderB.id]);
      expect(rows, 'item do pedido de B gravado').toHaveLength(1);
      return rows[0].id;
    });
    expect(orderB.store_id).toBe(storeB.id);
    expect(orderA.store_id).toBe(demo.id);
  });

  test.afterAll(async () => {
    await cleanup.run();
    await api.dispose();
  });

  test('item de pedido: produto de outra loja é recusado (inserir, trocar o produto ou mover o item de pedido)', async () => {
    await withTestDb(async (db) => {
      const notFromOrderStore = /O produto \d+ não pertence à loja do pedido \d+\./;
      await expectRefused(
        db,
        'novo item no pedido de B com o produto de A',
        `INSERT INTO "order_items" ("quantity", "orderId", "productId", "product_name", "unit_price") VALUES (1, $1, $2, 'Produto de A', 17)`,
        [orderB.id, productA.id],
        notFromOrderStore,
      );
      await expectRefused(
        db,
        'trocar o produto do item de B pelo produto de A',
        'UPDATE "order_items" SET "productId" = $1 WHERE "id" = $2',
        [productA.id, itemB],
        notFromOrderStore,
      );
      await expectRefused(
        db,
        'mover o item de B (produto de B) para o pedido de A',
        'UPDATE "order_items" SET "orderId" = $1 WHERE "id" = $2',
        [orderA.id, itemB],
        notFromOrderStore,
      );
      await expectAccepted(db, 'trocar pelo outro produto de B', 'UPDATE "order_items" SET "productId" = $1 WHERE "id" = $2', [
        productB2.id,
        itemB,
      ]);
    });
  });

  test('adicionais: o permitido no produto e o escolhido no item de pedido só podem ser da mesma loja', async () => {
    await withTestDb(async (db) => {
      const notFromProductStore = /O adicional \d+ não pertence à loja do produto \d+\./;
      await expectRefused(
        db,
        'adicional de A permitido no produto de B',
        'INSERT INTO "product_allowed_addons" ("product_id", "addon_id") VALUES ($1, $2)',
        [productB.id, addonA.id],
        notFromProductStore,
      );
      await expectRefused(
        db,
        'adicional de B permitido no produto de A',
        'INSERT INTO "product_allowed_addons" ("product_id", "addon_id") VALUES ($1, $2)',
        [productA.id, addonB.id],
        notFromProductStore,
      );
      await expectRefused(
        db,
        'trocar o adicional permitido de B pelo de A',
        'UPDATE "product_allowed_addons" SET "addon_id" = $1 WHERE "product_id" = $2 AND "addon_id" = $3',
        [addonA.id, productB.id, addonB.id],
        notFromProductStore,
      );
      await expectAccepted(db, 'outro adicional de B no produto de B', 'INSERT INTO "product_allowed_addons" ("product_id", "addon_id") VALUES ($1, $2)', [
        productB.id,
        addonB2.id,
      ]);

      const notFromOrder = /O adicional \d+ não pertence à loja do pedido\./;
      await expectRefused(
        db,
        'adicional de A no item do pedido de B',
        'INSERT INTO "order_item_addons" ("orderItemsId", "addonsId") VALUES ($1, $2)',
        [itemB, addonA.id],
        notFromOrder,
      );
      await expectRefused(
        db,
        'trocar o adicional do item de B pelo de A',
        'UPDATE "order_item_addons" SET "addonsId" = $1 WHERE "orderItemsId" = $2 AND "addonsId" = $3',
        [addonA.id, itemB, addonB.id],
        notFromOrder,
      );
      await expectAccepted(db, 'outro adicional de B no item de B', 'INSERT INTO "order_item_addons" ("orderItemsId", "addonsId") VALUES ($1, $2)', [
        itemB,
        addonB2.id,
      ]);
    });
  });

  test('entregador: só da equipe da loja do pedido (nem de outra loja, nem cliente)', async () => {
    await withTestDb(async (db) => {
      const notFromOrderStore = /O entregador \d+ não pertence à loja do pedido\./;
      const assign = 'UPDATE "orders" SET "driver_id" = $1 WHERE "id" = $2';
      await expectRefused(db, 'entregador de A no pedido de B', assign, [courierA.user.id, orderB.id], notFromOrderStore);
      await expectRefused(db, 'entregador de B no pedido de A', assign, [teamB.COURIER.user.id, orderA.id], notFromOrderStore);
      await expectRefused(db, 'cliente (sem loja) como entregador do pedido de B', assign, [client.user.id, orderB.id], notFromOrderStore);
      await expectAccepted(db, 'entregador de B no pedido de B', assign, [teamB.COURIER.user.id, orderB.id]);
    });
  });

  test('pagamento: só quita pedido da mesma loja', async () => {
    await withTestDb(async (db) => {
      const notFromPaymentStore = /O pedido \d+ não pertence à loja do pagamento \d+\./;
      await expectRefused(
        db,
        'pagamento de B apontando para o pedido de A',
        'UPDATE "payments" SET "order_id" = $1 WHERE "id" = $2',
        [orderA.id, paymentB.id],
        notFromPaymentStore,
      );
      await expectAccepted(db, 'pagamento de B apontando para outro pedido de B', 'UPDATE "payments" SET "order_id" = $1 WHERE "id" = $2', [
        orderB2.id,
        paymentB.id,
      ]);
    });
  });

  test('store_id é imutável: produto, adicional, pedido e pagamento nunca mudam de loja (nos dois sentidos)', async () => {
    await withTestDb(async (db) => {
      const attempts: Array<[string, number, number]> = [
        ['products', productB.id, demo.id],
        ['addons', addonB.id, demo.id],
        ['orders', orderB.id, demo.id],
        ['products', productA.id, storeB.id],
        ['addons', addonA.id, storeB.id],
        ['orders', orderA.id, storeB.id],
      ];
      for (const [table, id, target] of attempts) {
        await expectRefused(
          db,
          `${table} #${id} → loja ${target}`,
          `UPDATE "${table}" SET "store_id" = $1 WHERE "id" = $2`,
          [target, id],
          new RegExp(`A loja de um registro de ${table} não pode ser alterada\\.`),
        );
      }
      // Pagamento: mesmo levando junto um pedido coerente da loja A (o trigger pagamento × pedido
      // passaria), a troca de loja continua recusada
      await expectRefused(
        db,
        `payments #${paymentB.id} → loja A com o pedido de A`,
        'UPDATE "payments" SET "store_id" = $1, "order_id" = $2 WHERE "id" = $3',
        [demo.id, orderA.id, paymentB.id],
        /A loja de um registro de payments não pode ser alterada\./,
      );
    });
  });

  test('contas: equipe sempre com loja e cliente sem loja (CHK_users_store_membership)', async () => {
    await withTestDb(async (db) => {
      const constraint = 'CHK_users_store_membership';
      const membership = /CHK_users_store_membership/;
      await expectRefused(db, 'atendente de B sem loja', 'UPDATE "users" SET "store_id" = NULL WHERE "id" = $1', [teamB.EMPLOYEE.user.id], membership, constraint);
      await expectRefused(db, 'cliente preso à loja B', 'UPDATE "users" SET "store_id" = $1 WHERE "id" = $2', [storeB.id, client.user.id], membership, constraint);
    });
  });

  test('nada foi gravado: os registros continuam na loja original e a API segue igual', async () => {
    await withTestDb(async (db) => {
      const storeOf = async (table: string, id: number) =>
        (await db.query<{ store_id: number }>(`SELECT "store_id" FROM "${table}" WHERE "id" = $1`, [id])).rows[0]?.store_id;
      for (const [table, id] of [['products', productB.id], ['addons', addonB.id], ['orders', orderB.id], ['payments', paymentB.id]] as const) {
        expect(await storeOf(table, id), `${table} #${id} continua na loja B`).toBe(storeB.id);
      }
      for (const [table, id] of [['products', productA.id], ['addons', addonA.id], ['orders', orderA.id]] as const) {
        expect(await storeOf(table, id), `${table} #${id} continua na loja A`).toBe(demo.id);
      }
      const item = (await db.query<{ orderId: number; productId: number }>('SELECT "orderId", "productId" FROM "order_items" WHERE "id" = $1', [itemB])).rows[0];
      expect(item).toEqual({ orderId: orderB.id, productId: productB.id });
      const addons = (await db.query<{ addonsId: number }>('SELECT "addonsId" FROM "order_item_addons" WHERE "orderItemsId" = $1', [itemB])).rows;
      expect(addons.map((row) => row.addonsId)).toEqual([addonB.id]);
      const allowed = (await db.query<{ addon_id: number }>('SELECT "addon_id" FROM "product_allowed_addons" WHERE "product_id" = $1', [productB.id])).rows;
      expect(allowed.map((row) => row.addon_id)).toEqual([addonB.id]);
      const payment = (await db.query<{ order_id: number }>('SELECT "order_id" FROM "payments" WHERE "id" = $1', [paymentB.id])).rows[0];
      expect(payment.order_id).toBe(paymentB.orderId);
      const membership = (await db.query<{ id: number; store_id: number | null }>('SELECT "id", "store_id" FROM "users" WHERE "id" = ANY($1) ORDER BY "id"', [[teamB.EMPLOYEE.user.id, client.user.id]])).rows;
      expect(membership).toEqual(
        [
          { id: teamB.EMPLOYEE.user.id, store_id: storeB.id },
          { id: client.user.id, store_id: null },
        ].sort((a, b) => a.id - b.id),
      );
    });

    const order = await getJson(api, `/orders/${orderB.id}`, teamB.ADMIN.token, 'pedido de B pela equipe de B');
    expect(order).toMatchObject({ id: orderB.id, store_id: storeB.id, driver: null, status: 'PENDING' });
  });
});
