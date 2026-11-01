import { test, expect, type APIRequestContext } from '@playwright/test';
import { loginAs } from '../../../support/api';
import {
  Cleanup,
  MISSING_ID,
  MSG,
  addProduct,
  bearer,
  buildTeam,
  cancelOrderLater,
  createStore,
  demoStore,
  demoTeam,
  expectError,
  expectNoneOf,
  expectStatus,
  expectUniform404,
  getJson,
  newApi,
  newCustomer,
  payCard,
  retireStore,
  storePath,
  trashProductLater,
  uid,
  withTestDb,
  type Json,
  type Member,
  type OrderInput,
  type PublicStore,
  type Session,
  type StaffRole,
  type Team,
  type TenantStore,
} from './helpers';

/**
 * Seção 16 do pedido — "Pagamentos e estornos validam o contexto correto":
 * consulta só do pagador e da equipe da loja do pagamento (404 nos demais casos), idempotência por
 * loja + cliente, estorno sempre na loja do pedido e pagamento de uma loja nunca vira pedido em outra.
 * Pagamentos das lojas B e C (sem credencial) são simulados pelo sandbox; o da loja A usa o ambiente.
 */
test.describe('Isolamento entre lojas: pagamentos e estornos', () => {
  const cleanup = new Cleanup();
  let api: APIRequestContext;
  let superadmin: Session;
  let demo: PublicStore;
  let teamA: Team;
  let storeB: TenantStore;
  let teamB: Team;
  let storeC: TenantStore;
  let payer: Member;
  let other: Member;

  let productA: Json;
  let productB: Json;
  let productC: Json;
  const key = `tenancy-${uid('k')}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
  let pa: Json;
  let pb: Json;
  let pc: Json;
  let pbRefund: Json;

  const takeout = (productId: number, quantity = 1): OrderInput => ({ items: [{ productId, quantity }], type: 'TAKEOUT' });
  const roles = (team: Team) => Object.entries(team) as Array<[StaffRole, Session]>;

  test.beforeAll(async () => {
    api = await newApi();
    superadmin = await loginAs(api, 'superadmin');
    demo = await demoStore();
    teamA = await demoTeam(api);

    storeB = await createStore(api, superadmin, 'Pagamentos B');
    cleanup.add('desativar a loja B', () => retireStore(api, superadmin, storeB));
    storeC = await createStore(api, superadmin, 'Pagamentos C');
    cleanup.add('desativar a loja C', () => retireStore(api, superadmin, storeC));
    teamB = await buildTeam(api, storeB);
    productB = await addProduct(api, teamB.ADMIN, { price: 20 });
    productC = await addProduct(api, storeC.owner, { price: 15 });
    productA = await addProduct(api, teamA.ADMIN, { price: 12 });
    trashProductLater(cleanup, api, teamA.ADMIN, productA.id);

    payer = await newCustomer(api, 'Pagador');
    other = await newCustomer(api, 'Outro cliente');

    pb = await payCard(api, storeB.slug, payer, takeout(productB.id, 2), { idempotencyKey: key });
    pc = await payCard(api, storeC.slug, payer, takeout(productC.id, 1), { idempotencyKey: key });
    pbRefund = await payCard(api, storeB.slug, payer, takeout(productB.id, 1));
    pa = await payCard(api, demo.slug, payer, takeout(productA.id, 1));
    cancelOrderLater(cleanup, api, teamA.ADMIN, pa.orderId);
  });

  test.afterAll(async () => {
    await cleanup.run();
    await api.dispose();
  });

  test('o pagamento de B só é consultado pelo pagador e por ADMIN/EMPLOYEE de B (404 uniforme para os demais)', async () => {
    const statusOf = (token: string | null, id: number, path = `/payment/status/${id}`) =>
      api.get(path, token ? { headers: bearer(token) } : undefined);
    const managesOrders = (role: StaffRole) => role === 'ADMIN' || role === 'EMPLOYEE';

    expect(await getJson(api, `/payment/status/${pb.id}`, payer.token)).toMatchObject({ id: pb.id, status: 'approved', orderId: pb.orderId });
    for (const [role, session] of roles(teamB).filter(([role]) => managesOrders(role))) {
      const seen = await expectStatus(await statusOf(session.token, pb.id), 200, `${role} de B`);
      expect(seen).toMatchObject({ id: pb.id, orderId: pb.orderId });
    }

    const outsiders: Array<[string, Session]> = [
      ...roles(teamA).map(([role, s]): [string, Session] => [`${role} de A`, s]),
      // Cozinha e entregador de B acompanham só a própria etapa dos pedidos, não as cobranças
      ...roles(teamB)
        .filter(([role]) => !managesOrders(role))
        .map(([role, s]): [string, Session] => [`${role} de B`, s]),
      ['ADMIN de C', storeC.owner],
      ['outro cliente', other],
      ['superadmin (fora da loja)', superadmin],
    ];
    for (const [label, session] of outsiders) {
      await expectUniform404(
        await statusOf(session.token, pb.id),
        await statusOf(session.token, MISSING_ID),
        MSG.paymentNotFound,
        `${label}: GET /payment/status/<pagamento de B>`,
      );
    }
    await expectError(await statusOf(null, pb.id), 401);

    // Rota por loja: o pagamento precisa ser da loja da URL
    await expectUniform404(
      await statusOf(payer.token, pb.id, storePath(storeC.slug, `/payment/status/${pb.id}`)),
      await statusOf(payer.token, MISSING_ID, storePath(storeC.slug, `/payment/status/${MISSING_ID}`)),
      MSG.paymentNotFound,
      'pagador: pagamento de B pela rota da loja C',
    );
    await expectStatus(await statusOf(payer.token, pb.id, storePath(storeB.slug, `/payment/status/${pb.id}`)), 200);
    await expectError(await statusOf(teamA.ADMIN.token, pb.id, storePath(storeB.slug, `/payment/status/${pb.id}`)), 404, MSG.paymentNotFound);

    // E o contrário: o pagamento da loja A não é visto pela equipe de B
    for (const [role, session] of roles(teamB)) {
      await expectError(await statusOf(session.token, pa.id), 404, MSG.paymentNotFound, `${role} de B: pagamento de A`);
    }
    expect(await getJson(api, `/payment/status/${pa.id}`, teamA.EMPLOYEE.token)).toMatchObject({ id: pa.id, orderId: pa.orderId });
  });

  test('desistir do pagamento de outra pessoa ou pela rota de outra loja → 404, e o pagamento continua aprovado', async () => {
    const cancel = (token: string, id: number, path = `/payment/${id}/cancel`) => api.post(path, { headers: bearer(token) });
    for (const [label, session] of [
      ['ADMIN de A', teamA.ADMIN],
      ['ADMIN de B (só o pagador desiste)', teamB.ADMIN],
      ['outro cliente', other],
    ] as Array<[string, Session]>) {
      await expectUniform404(
        await cancel(session.token, pb.id),
        await cancel(session.token, MISSING_ID),
        MSG.paymentNotFound,
        `${label}: POST /payment/<pagamento de B>/cancel`,
      );
    }
    await expectError(
      await cancel(payer.token, pb.id, storePath(storeC.slug, `/payment/${pb.id}/cancel`)),
      404,
      MSG.paymentNotFound,
      'pagador pela rota da loja C',
    );
    expect(await getJson(api, `/payment/status/${pb.id}`, payer.token)).toMatchObject({ status: 'approved', orderId: pb.orderId });
  });

  test('idempotência por loja: a mesma chave do mesmo cliente gera um pagamento em cada loja; repetir devolve o mesmo', async () => {
    expect(pc.id, 'mesma chave em outra loja = outro pagamento').not.toBe(pb.id);
    expect(pc.orderId).not.toBe(pb.orderId);

    const againB = await payCard(api, storeB.slug, payer, takeout(productB.id, 2), { idempotencyKey: key });
    expect(againB).toMatchObject({ id: pb.id, orderId: pb.orderId });
    const againC = await payCard(api, storeC.slug, payer, takeout(productC.id, 1), { idempotencyKey: key });
    expect(againC).toMatchObject({ id: pc.id, orderId: pc.orderId });

    // A chave é do cliente: outro cliente com a mesma chave na mesma loja tem o próprio pagamento
    const otherPayment = await payCard(api, storeB.slug, other, takeout(productB.id, 1), { idempotencyKey: key });
    expect(otherPayment.id).not.toBe(pb.id);

    // Cada pedido ficou na loja do próprio pagamento (e só um pedido por pagamento)
    expect(await getJson(api, `/orders/${pb.orderId}`, teamB.ADMIN.token)).toMatchObject({ store_id: storeB.id, payment_id: pb.id, payment_status: 'PAID' });
    expect(await getJson(api, `/orders/${pc.orderId}`, storeC.owner.token)).toMatchObject({ store_id: storeC.id, payment_id: pc.id, payment_status: 'PAID' });
    await expectError(await api.get(`/orders/${pc.orderId}`, { headers: bearer(teamB.ADMIN.token) }), 404, MSG.orderNotFound);
    await expectError(await api.get(`/orders/${pb.orderId}`, { headers: bearer(storeC.owner.token) }), 404, MSG.orderNotFound);
    const payerOrdersB: Json[] = await getJson(api, storePath(storeB.slug, '/orders/my-orders'), payer.token);
    expect(payerOrdersB.filter((o) => o.payment_id === pb.id).map((o) => o.id), 'um único pedido para o pagamento repetido').toEqual([pb.orderId]);
    const otherOrders: Json[] = await getJson(api, '/orders/my-orders', other.token);
    expectNoneOf(otherOrders, [pb.orderId, pc.orderId, pbRefund.orderId, pa.orderId], 'pedidos do outro cliente');
  });

  test('estorno valida a loja: equipes de A e de C não cancelam nem estornam o pedido pago de B; a equipe de B estorna', async () => {
    const orderId = pbRefund.orderId as number;
    const attempts: Array<[string, Session, 'cancel' | 'status']> = [
      ['ADMIN de A (cancelar)', teamA.ADMIN, 'cancel'],
      ['ATENDENTE de A (cancelar pelo quadro)', teamA.EMPLOYEE, 'status'],
      ['ADMIN de C (cancelar)', storeC.owner, 'cancel'],
    ];
    for (const [label, session, via] of attempts) {
      const call = (id: number) =>
        via === 'cancel'
          ? api.patch(`/orders/${id}/cancel`, { headers: bearer(session.token) })
          : api.patch(`/orders/${id}`, { headers: bearer(session.token), data: { status: 'CANCELED' } });
      await expectUniform404(await call(orderId), await call(MISSING_ID), MSG.orderNotFound, label);
    }
    expect(await getJson(api, `/payment/status/${pbRefund.id}`, payer.token)).toMatchObject({ status: 'approved' });
    expect((await getJson(api, `/orders/${orderId}`, teamB.ADMIN.token)).payment_status).toBe('PAID');

    // A equipe de B cancela: o estorno sai pela loja do pagamento (sandbox: simulado)
    const canceled = await expectStatus(await api.patch(`/orders/${orderId}/cancel`, { headers: bearer(teamB.EMPLOYEE.token) }), 200);
    expect(canceled).toMatchObject({ id: orderId, status: 'CANCELED', payment_status: 'REFUNDED', store_id: storeB.id });
    expect(await getJson(api, `/payment/status/${pbRefund.id}`, payer.token)).toMatchObject({ status: 'refunded' });
    // Os pagamentos das outras lojas não foram tocados
    expect(await getJson(api, `/payment/status/${pc.id}`, payer.token)).toMatchObject({ status: 'approved' });
    expect(await getJson(api, `/payment/status/${pa.id}`, payer.token)).toMatchObject({ status: 'approved' });
    expect((await getJson(api, `/orders/${pc.orderId}`, storeC.owner.token)).payment_status).toBe('PAID');
  });

  test('pagamento de uma loja nunca vira pedido em outra (POST /orders com paymentId)', async () => {
    const withPayment = (items: OrderInput, paymentId: number) => ({ ...items, paymentMethod: 'CREDIT_CARD', paymentId });
    const attempts: Array<[string, string, Record<string, unknown>]> = [
      ['pagamento de B na loja C', storePath(storeC.slug, '/orders'), withPayment(takeout(productC.id), pb.id)],
      ['pagamento de B na loja A (rota antiga)', '/orders', withPayment(takeout(productA.id), pb.id)],
      ['pagamento de A na loja B', storePath(storeB.slug, '/orders'), withPayment(takeout(productB.id), pa.id)],
      ['pagamento de C na loja B', storePath(storeB.slug, '/orders'), withPayment(takeout(productB.id), pc.id)],
    ];
    for (const [label, path, data] of attempts) {
      await expectError(await api.post(path, { headers: bearer(payer.token), data }), 400, MSG.paymentNotFoundOrExpired, label);
    }
    // Controle: na própria loja, o mesmo pagamento devolve o pedido já criado
    const same = await expectStatus(
      await api.post(storePath(storeB.slug, '/orders'), { headers: bearer(payer.token), data: withPayment(takeout(productB.id, 2), pb.id) }),
      201,
    );
    expect(same).toMatchObject({ id: pb.orderId, store_id: storeB.id, payment_id: pb.id });
  });
});

/**
 * Pagamentos já iniciados quando a loja deixa de vender, fila da conciliação (todas as lojas) e
 * cobranças pendentes por cliente. Lojas próprias (criadas e desativadas aqui); PIX do sandbox.
 */
test.describe('Pagamentos do delivery: loja bloqueada, conciliação justa e cobranças pendentes', () => {
  const cleanup = new Cleanup();
  let api: APIRequestContext;
  let superadmin: Session;

  const takeout = (productId: number, quantity = 1): OrderInput => ({ items: [{ productId, quantity }], type: 'TAKEOUT' });
  const postPix = (slug: string, customer: Session, order: OrderInput) =>
    api.post(storePath(slug, '/payment/pix'), { headers: bearer(customer.token), data: { order } });
  const statusOf = async (customer: Session, id: number): Promise<Json> => getJson(api, `/payment/status/${id}`, customer.token);

  /** Loja nova vendendo (desativada no fim do arquivo), com um produto. */
  async function sellingStore(label: string, price = 18): Promise<{ store: TenantStore; product: Json }> {
    const store = await createStore(api, superadmin, label);
    cleanup.add(`desativar a loja ${label}`, () => retireStore(api, superadmin, store));
    return { store, product: await addProduct(api, store.owner, { price }) };
  }

  /** Adia a aprovação automática do sandbox: o PIX continua pendente enquanto o teste confere o resto. */
  const holdPending = (ids: number[]) =>
    withTestDb((db) =>
      db.query(`UPDATE "payments" SET "auto_approve_at" = now() + interval '1 hour' WHERE "id" = ANY($1::bigint[])`, [ids]),
    );

  test.beforeAll(async () => {
    api = await newApi();
    superadmin = await loginAs(api, 'superadmin');
  });

  test.afterAll(async () => {
    await cleanup.run();
    await api.dispose();
  });

  for (const [label, action] of [
    ['suspensa', 'suspend'],
    ['desativada', 'deactivate'],
  ] as const) {
    test(`PIX gerado antes de a loja ser ${label} não vira pedido: estornado se aprovado, cancelado se ainda pendente (auditado)`, async () => {
      const { store, product } = await sellingStore(`Bloqueio ${label}`);
      const buyer = await newCustomer(api, `PIX loja ${label}`);
      const pix = await expectStatus(await postPix(store.slug, buyer, takeout(product.id)), 201, 'PIX antes do bloqueio');
      expect(pix).toMatchObject({ status: 'pending', simulation: true });

      await expectStatus(
        await api.post(`/platform/stores/${store.id}/${action}`, {
          headers: bearer(superadmin.token),
          data: { reason: `Bloqueio de teste dos pagamentos (${label}, E2E)` },
        }),
        200,
        `loja ${label} pelo superpainel`,
      );

      // O sandbox "paga" o PIX ~5 s depois de criado: a consulta de status (do próprio pagador) vê a aprovação
      await expect
        .poll(async () => (await statusOf(buyer, pix.id)).status, { timeout: 30_000, intervals: [1_000], message: 'PIX aprovado' })
        .not.toBe('pending');
      // Dois desfechos corretos, conforme a conciliação (uma rodada a cada 60 s) alcance o PIX antes ou depois da
      // aprovação do sandbox: aprovado depois do bloqueio → não vira pedido e o valor é estornado; ainda pendente
      // quando a conciliação passa → a cobrança é cancelada (cancelled/by_collector). Nos dois, nenhum pedido.
      const final = await statusOf(buyer, pix.id);
      const refunded = final.status === 'refunded';
      expect(final, 'nenhum pedido; o valor volta para o cliente ou a cobrança é cancelada').toEqual(
        refunded
          ? { id: pix.id, status: 'refunded', status_detail: 'refunded' }
          : { id: pix.id, status: 'cancelled', status_detail: 'by_collector' },
      );
      const mine: Json[] = await getJson(api, '/orders/my-orders', buyer.token);
      expect(mine.filter((o) => o.payment_id === pix.id), 'nenhum pedido criado na loja bloqueada').toEqual([]);

      const auditAction = refunded ? 'payment.order_not_created' : 'payment.cancel';
      const audit = await getJson(
        api,
        `/platform/stores/${store.id}/audit?action=${auditAction}`,
        superadmin.token,
        'auditoria do pagamento sem pedido',
      );
      expect(audit.items, 'um registro na auditoria da loja').toHaveLength(1);
      expect(audit.items[0]).toMatchObject({ action: auditAction, store_id: store.id });
      expect(audit.items[0].metadata).toMatchObject(refunded ? { refunded: true } : { reason: 'store_cannot_sell' });
      expect(JSON.stringify(audit.items[0]), 'o motivo interno do bloqueio não vai para o pagamento').not.toContain('Bloqueio de teste');
    });
  }

  test('pagamentos pendentes que o servidor não consegue reconsultar numa loja não atrasam a conciliação das outras', async () => {
    test.setTimeout(240_000);
    const { store: storeX } = await sellingStore('Fila X');
    const { store: storeY, product: productY } = await sellingStore('Fila Y', 14);
    const intruder = await newCustomer(api, 'Fila X');
    const buyer = await newCustomer(api, 'Fila Y');

    // 60 pagamentos reais "pendentes" da loja X, mais antigos que qualquer outro: a loja não tem credencial,
    // então ninguém consegue reconsultá-los (o mesmo que credencial revogada ou o Mercado Pago recusando)
    const base = 700_000_000_000_000 + (Date.now() % 1_000_000_000) * 100;
    const stuck = await withTestDb(async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO "payments" ("id", "store_id", "user_id", "method", "order_payment_method", "amount", "status",
                                 "simulated", "order_payload", "price_snapshot", "created_at", "updated_at")
         SELECT $1::bigint + n, $2, $3, 'PIX', 'PIX', 10, 'pending', false,
                '{"items":[],"type":"TAKEOUT"}'::jsonb, '{}'::jsonb,
                now() - interval '1 day' + n * interval '1 second', now() - interval '1 day' + n * interval '1 second'
           FROM generate_series(1, 60) AS n
         RETURNING "id"`,
        [base, storeX.id, intruder.user.id],
      );
      return rows.map((row) => Number(row.id));
    });
    expect(stuck).toHaveLength(60);
    cleanup.add('encerrar os pagamentos pendentes inseridos', () =>
      withTestDb((db) => db.query(`UPDATE "payments" SET "status" = 'cancelled' WHERE "id" = ANY($1::bigint[])`, [stuck])),
    );

    // O cliente da loja Y paga o PIX e fecha o app: nenhuma consulta de status, só a conciliação (a cada 60 s)
    const pix = await expectStatus(await postPix(storeY.slug, buyer, takeout(productY.id)), 201, 'PIX na loja Y');
    const linked = async () => ((await getJson(api, '/orders/my-orders', buyer.token)) as Json[]).filter((o) => o.payment_id === pix.id);
    await expect
      .poll(async () => (await linked()).length, { timeout: 150_000, intervals: [5_000], message: 'pedido da loja Y criado pela conciliação' })
      .toBe(1);
    expect((await linked())[0]).toMatchObject({ payment_status: 'PAID', store_id: storeY.id });
  });

  test('cobranças pendentes: o mesmo carrinho reaproveita o PIX pendente e cada cliente tem um teto por loja', async () => {
    const { store, product } = await sellingStore('Teto de PIX', 10);
    const buyer = await newCustomer(api, 'Teto de PIX');
    const pix = async (quantity: number, label = `PIX de ${quantity}`): Promise<Json> => {
      const payment = await expectStatus(await postPix(store.slug, buyer, takeout(product.id, quantity)), 201, label);
      await holdPending([payment.id]);
      return payment;
    };

    const first = await pix(1);
    const again = await pix(1, 'mesmo carrinho de novo');
    expect(again, 'mesmo carrinho ainda pendente: o mesmo PIX, nenhuma cobrança nova').toMatchObject({
      id: first.id,
      qr_code: first.qr_code,
      expires_at: first.expires_at,
      amount: 10,
    });

    // Carrinhos diferentes: até 5 cobranças pendentes ao mesmo tempo por cliente na loja
    for (const quantity of [2, 3, 4, 5]) expect((await pix(quantity)).id).not.toBe(first.id);
    await expectError(await postPix(store.slug, buyer, takeout(product.id, 6)), 429, /pendente/, '6ª cobrança pendente');

    // O teto é por cliente: outro cliente compra normalmente
    const other = await newCustomer(api, 'Outro teto');
    await expectStatus(await postPix(store.slug, other, takeout(product.id, 6)), 201, 'outro cliente');

    // Desistir de um PIX libera a vaga
    await expectStatus(await api.post(`/payment/${first.id}/cancel`, { headers: bearer(buyer.token) }), 200, 'cancelar o 1º PIX');
    expect((await statusOf(buyer, first.id)).status).toBe('cancelled');
    await pix(6, 'vaga liberada');
  });
});
