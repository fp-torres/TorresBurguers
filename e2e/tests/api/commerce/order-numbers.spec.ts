import { test, expect, type APIRequestContext } from '@playwright/test';
import { loginAs } from '../../../support/api';
import {
  Cleanup,
  addProduct,
  bearer,
  createStore,
  expectError,
  expectStatus,
  getJson,
  newApi,
  newCustomer,
  payCard,
  placeOrder,
  retireStore,
  storePath,
  withTestDb,
  type Json,
  type Member,
  type OrderInput,
  type PgError,
  type Session,
  type TenantStore,
} from '../tenancy/helpers';

/**
 * Número do pedido por loja (orders.number; pendência da arquitetura §12): o id é global e sequencial
 * (revelaria o volume das outras lojas), então cada loja numera os próprios pedidos 1, 2, 3... O número é
 * atribuído pelo banco em TODO insert (gatilho com contador por loja): pago na entrega, criado pelo
 * pagamento aprovado e até SQL manual; sem repetição nem buraco, também sob pedidos simultâneos.
 * O id continua sendo a chave das rotas (app mobile).
 */
test.describe('Número do pedido por loja', () => {
  const cleanup = new Cleanup();
  let api: APIRequestContext;
  let superadmin: Session;
  let storeA: TenantStore;
  let storeB: TenantStore;
  let productA: Json;
  let productB: Json;
  let customer: Member;
  let other: Member;

  const takeout = (product: Json): OrderInput => ({ items: [{ productId: product.id, quantity: 1 }], type: 'TAKEOUT' });
  const numberOf = async (orderId: number, token: string): Promise<number> =>
    (await getJson(api, `/orders/${orderId}`, token, `GET /orders/${orderId}`)).number;
  /** Números da loja direto no banco (todos os pedidos dela, inclusive os criados por SQL). */
  const storeNumbers = (storeId: number): Promise<{ count: number; max: number; distinct: number }> =>
    withTestDb(async (db) => {
      const { rows } = await db.query<{ count: number; max: number; distinct: number }>(
        `SELECT count(*)::int AS "count", COALESCE(max("number"), 0)::int AS "max", count(DISTINCT "number")::int AS "distinct"
           FROM "orders" WHERE "store_id" = $1`,
        [storeId],
      );
      return rows[0];
    });

  test.beforeAll(async () => {
    api = await newApi();
    superadmin = await loginAs(api, 'superadmin');
    storeA = await createStore(api, superadmin, 'NumeroA');
    cleanup.add('desativar a loja A', () => retireStore(api, superadmin, storeA));
    storeB = await createStore(api, superadmin, 'NumeroB');
    cleanup.add('desativar a loja B', () => retireStore(api, superadmin, storeB));
    productA = await addProduct(api, storeA.owner, { price: 21 });
    productB = await addProduct(api, storeB.owner, { price: 22 });
    customer = await newCustomer(api, 'Numeração');
    other = await newCustomer(api, 'Numeração 2');
  });

  test.afterAll(async () => {
    await cleanup.run();
    await api.dispose();
  });

  test('cada loja numera os próprios pedidos (1, 2, 3...), independente das outras; o id continua global', async () => {
    const a1 = await placeOrder(api, storeA.slug, customer, takeout(productA));
    const b1 = await placeOrder(api, storeB.slug, customer, takeout(productB));
    const a2 = await placeOrder(api, storeA.slug, other, takeout(productA));
    const b2 = await placeOrder(api, storeB.slug, other, takeout(productB));
    const a3 = await placeOrder(api, storeA.slug, customer, takeout(productA));

    expect([a1.number, a2.number, a3.number], 'loja A').toEqual([1, 2, 3]);
    expect([b1.number, b2.number], 'loja B').toEqual([1, 2]);
    // O id é global (cresce entre as lojas) e não é o número mostrado
    expect(b1.id).toBeGreaterThan(a1.id);
    expect(a2.id).toBeGreaterThan(b1.id);
    expect(a3.id).not.toBe(a3.number);

    // O mesmo número em todas as leituras: cliente, equipe (detalhe e lista), Meus Pedidos e Clientes
    expect(await numberOf(a2.id, other.token)).toBe(2);
    expect(await numberOf(a2.id, storeA.owner.token)).toBe(2);
    const board = (await getJson(api, '/orders?scope=active', storeA.owner.token)) as Json[];
    expect(board.find((order) => order.id === a3.id)?.number).toBe(3);
    const mine = (await getJson(api, '/orders/my-orders', customer.token)) as Json[];
    expect(mine.find((order) => order.id === b1.id)).toMatchObject({ number: 1, store: { id: storeB.id } });
    expect(mine.find((order) => order.id === a3.id)).toMatchObject({ number: 3, store: { id: storeA.id } });
    const inB = (await getJson(api, storePath(storeB.slug, '/orders/my-orders'), other.token)) as Json[];
    expect(inB.map((order) => order.number)).toEqual([2]);
    const history = await getJson(api, `/store/customers/${customer.user.id}`, storeA.owner.token);
    expect((history.orders as Json[]).map((order) => order.number)).toEqual([3, 1]);
  });

  test('pedidos simultâneos: números únicos e sem buraco em cada loja (as lojas não se esperam)', async () => {
    const before = { a: (await storeNumbers(storeA.id)).max, b: (await storeNumbers(storeB.id)).max };
    const perStore = 8;
    const place = (store: TenantStore, product: Json, buyer: Session) =>
      api.post(storePath(store.slug, '/orders'), {
        headers: bearer(buyer.token),
        data: { ...takeout(product), paymentMethod: 'MONEY' },
      });
    const responses = await Promise.all(
      Array.from({ length: perStore }, (_, index) => [
        place(storeA, productA, index % 2 ? customer : other),
        place(storeB, productB, index % 2 ? other : customer),
      ]).flat(),
    );
    const created: Json[] = [];
    for (const res of responses) created.push(await expectStatus(res, 201, 'pedido simultâneo'));

    const numbersIn = (store: TenantStore) =>
      created.filter((order) => order.store_id === store.id).map((order) => order.number as number).sort((x, y) => x - y);
    const range = (from: number) => Array.from({ length: perStore }, (_, index) => from + index + 1);
    expect(numbersIn(storeA), 'loja A: a sequência continua, sem repetir nem pular').toEqual(range(before.a));
    expect(numbersIn(storeB), 'loja B: a sequência continua, sem repetir nem pular').toEqual(range(before.b));

    for (const store of [storeA, storeB]) {
      const stats = await storeNumbers(store.id);
      expect(stats, `loja ${store.slug}: 1..N`).toEqual({ count: stats.max, max: stats.max, distinct: stats.max });
    }
  });

  test('pedido criado pelo pagamento aprovado (cartão) também recebe o número da loja', async () => {
    const before = (await storeNumbers(storeA.id)).max;
    const payment = await payCard(api, storeA.slug, customer, takeout(productA));
    expect(await numberOf(payment.orderId, customer.token)).toBe(before + 1);
    expect(await numberOf(payment.orderId, storeA.owner.token)).toBe(before + 1);

    // Pago na entrega em seguida: o próximo número
    const next = await placeOrder(api, storeA.slug, other, takeout(productA));
    expect(next.number).toBe(before + 2);
    // A loja B não andou
    expect((await storeNumbers(storeB.id)).max).toBe((await storeNumbers(storeB.id)).count);
  });

  test('o número não vem do cliente: campo recusado no pedido; no banco é sempre o do contador', async () => {
    const res = await api.post(storePath(storeA.slug, '/orders'), {
      headers: bearer(customer.token),
      data: { ...takeout(productA), paymentMethod: 'MONEY', number: 1 },
    });
    await expectError(res, 400, /property number should not exist/, 'POST /orders com number');

    // SQL manual (suporte) com número escolhido: o gatilho troca pelo próximo da loja
    const before = (await storeNumbers(storeA.id)).max;
    const inserted = await withTestDb(async (db) => {
      const { rows } = await db.query<{ id: number; number: number }>(
        `INSERT INTO "orders" ("store_id", "user_id", "total_price", "payment_method", "number")
         VALUES ($1, $2, 10, 'MONEY', 1) RETURNING "id", "number"`,
        [storeA.id, customer.user.id],
      );
      return rows[0];
    });
    expect(inserted.number).toBe(before + 1);
    await api.patch(`/orders/${inserted.id}/cancel`, { headers: bearer(storeA.owner.token) });
  });

  test('transação desfeita devolve o número (sem buraco) e o número nunca muda depois de gravado', async () => {
    const reserved = await withTestDb(async (db) => {
      await db.query('BEGIN');
      try {
        const { rows } = await db.query<{ number: number }>(
          `INSERT INTO "orders" ("store_id", "total_price", "payment_method") VALUES ($1, 10, 'MONEY') RETURNING "number"`,
          [storeA.id],
        );
        return rows[0].number;
      } finally {
        await db.query('ROLLBACK');
      }
    });
    const next = await placeOrder(api, storeA.slug, customer, takeout(productA));
    expect(next.number, 'o número da transação desfeita volta para o próximo pedido').toBe(reserved);

    const failure = await withTestDb(async (db) =>
      db
        .query(`UPDATE "orders" SET "number" = "number" + 1000 WHERE "id" = $1`, [next.id])
        .then(() => null)
        .catch((error: PgError) => error),
    );
    expect(failure?.code, 'check_violation').toBe('23514');
    expect(failure?.message).toBe(`O número do pedido ${next.id} não pode ser alterado.`);
    expect(await numberOf(next.id, customer.token)).toBe(reserved);
  });

  test('banco inteiro: em toda loja os números formam 1..N, sem repetição (UQ_orders_store_number)', async () => {
    const broken = await withTestDb(async (db) => {
      const { rows } = await db.query(
        `SELECT "store_id", count(*)::int AS "count", max("number")::int AS "max", count(DISTINCT "number")::int AS "distinct"
           FROM "orders" GROUP BY "store_id"
         HAVING count(*) <> max("number") OR count(DISTINCT "number") <> count(*) OR min("number") <> 1`,
      );
      return rows;
    });
    expect(broken).toEqual([]);
  });
});
