import { test, expect, type APIRequestContext } from '@playwright/test';
import { uid } from '../../../support/api';
import { E2E } from '../../../support/env';
import {
  Actors,
  OUT_OF_RANGE_ID,
  UNKNOWN_ID,
  advance,
  createAddress,
  createProduct,
  expectNestError,
  expectNoPasswordFields,
  expectStatus,
  getOrder,
  patchStatus,
  payCard,
  placeOrder,
  type Actor,
  type Json,
} from './helpers';

test.describe('Pedidos: fluxo de status, entregas, cancelamento e dashboard', () => {
  const actors = new Actors();
  let anon: APIRequestContext;
  let admin: Actor;
  let employee: Actor;
  let kitchen: Actor;
  let courier: Actor; // entregador padrão
  let courier2: Actor; // segundo entregador (criado pelo ADMIN)
  let client: Actor;
  let otherClient: Actor;
  let product: Json;
  let address: Json;

  test.beforeAll(async () => {
    anon = await actors.anon();
    admin = await actors.defaultUser('admin');
    employee = await actors.defaultUser('employee');
    kitchen = await actors.defaultUser('kitchen');
    courier = await actors.defaultUser('courier');
    courier2 = await actors.newStaff(admin.ctx, 'COURIER');
    client = await actors.newClient('Cliente Fluxo');
    otherClient = await actors.newClient('Outro Fluxo');
    product = await createProduct(admin.ctx, { name: `Fluxo ${uid('fx')}`, price: 21.5 });
    address = await createAddress(client.ctx, 'Centro');
  });

  test.afterAll(async () => {
    await actors.dispose();
  });

  async function newOrder(type: 'DELIVERY' | 'TAKEOUT' = 'DELIVERY', addressId?: number): Promise<Json> {
    return placeOrder(client.ctx, {
      items: [{ productId: product.id, quantity: 1 }],
      type,
      ...(type === 'DELIVERY' ? { addressId: addressId ?? address.id } : {}),
      paymentMethod: 'MONEY',
    });
  }

  const assign = (actor: Actor, orderId: number, driverId: unknown) =>
    actor.ctx.patch(`/orders/${orderId}/assign`, { data: { driverId } });

  // -------------------------------------------------------------------------
  // Cozinha
  // -------------------------------------------------------------------------

  test('cozinha aceita (PENDING→PREPARING) e marca como pronto (PREPARING→READY_FOR_PICKUP)', async () => {
    const order = await newOrder();
    const preparing = await advance(kitchen.ctx, order.id, 'PREPARING');
    expect(preparing.status).toBe('PREPARING');
    const ready = await advance(kitchen.ctx, order.id, 'READY_FOR_PICKUP');
    expect(ready.status).toBe('READY_FOR_PICKUP');
    expect(ready.driver).toBeNull();
    expect((await getOrder(client.ctx, order.id)).status).toBe('READY_FOR_PICKUP');
  });

  test('cozinha não pula etapas nem volta status (403)', async () => {
    const order = await newOrder();
    await expectNestError(await patchStatus(kitchen.ctx, order.id, 'READY_FOR_PICKUP'), 403);
    await expectNestError(await patchStatus(kitchen.ctx, order.id, 'DELIVERING'), 403);
    await advance(kitchen.ctx, order.id, 'PREPARING');
    await expectNestError(await patchStatus(kitchen.ctx, order.id, 'PENDING'), 403);
    expect((await getOrder(admin.ctx, order.id)).status).toBe('PREPARING');
  });

  test('cozinha não despacha, não conclui e não cancela pedidos (403 na etapa; 404 fora dela)', async () => {
    const order = await newOrder();
    await advance(kitchen.ctx, order.id, 'PREPARING');
    for (const status of ['DELIVERING', 'DONE', 'CANCELED']) {
      await expectNestError(await patchStatus(kitchen.ctx, order.id, status), 403);
    }
    // Pronto saiu da etapa da cozinha: 404 uniforme, como no GET (não revela o status)
    await advance(kitchen.ctx, order.id, 'READY_FOR_PICKUP');
    for (const status of ['DELIVERING', 'DONE', 'CANCELED']) {
      await expectNestError(await patchStatus(kitchen.ctx, order.id, status), 404, 'Pedido não encontrado.');
    }
    await expectNestError(await kitchen.ctx.get(`/orders/${order.id}`), 404, 'Pedido não encontrado.');
    expect((await getOrder(admin.ctx, order.id)).status).toBe('READY_FOR_PICKUP');
  });

  // -------------------------------------------------------------------------
  // Entregador
  // -------------------------------------------------------------------------

  test('entregador retira pedido pronto (READY_FOR_PICKUP→DELIVERING) e vira o responsável', async () => {
    const order = await newOrder();
    await advance(kitchen.ctx, order.id, 'PREPARING', 'READY_FOR_PICKUP');
    const res = await patchStatus(courier.ctx, order.id, 'DELIVERING');
    await expectStatus(res, 200);
    const delivering = await res.json();
    expect(delivering.status).toBe('DELIVERING');
    expect(delivering.driver?.id).toBe(courier.id);
    expect(delivering.driver?.name).toBe(courier.session.user.name);
    expectNoPasswordFields(delivering);
    expect((await getOrder(client.ctx, order.id)).driver?.id).toBe(courier.id);
  });

  test('entregador conclui a própria entrega (DELIVERING→DONE) e o pagamento na entrega vira PAID', async () => {
    const order = await newOrder();
    expect(order.payment_status).toBe('PENDING');
    await advance(kitchen.ctx, order.id, 'PREPARING', 'READY_FOR_PICKUP');
    await advance(courier.ctx, order.id, 'DELIVERING');
    const done = await advance(courier.ctx, order.id, 'DONE');
    expect(done.status).toBe('DONE');
    expect(done.payment_status).toBe('PAID');
    expect(done.driver?.id).toBe(courier.id);
  });

  test('segundo entregador não assume pedido já atribuído a outro (404: fora da etapa dele, sem revelar o entregador)', async () => {
    const order = await newOrder();
    await advance(kitchen.ctx, order.id, 'PREPARING', 'READY_FOR_PICKUP');
    await expectStatus(await assign(employee, order.id, courier.id), 200);
    // De volta a "pronto" com o entregador 1 ainda responsável
    await advance(employee.ctx, order.id, 'READY_FOR_PICKUP');

    await expectNestError(await patchStatus(courier2.ctx, order.id, 'DELIVERING'), 404, 'Pedido não encontrado.');
    const still = await getOrder(admin.ctx, order.id);
    expect(still.status).toBe('READY_FOR_PICKUP');
    expect(still.driver?.id).toBe(courier.id);

    const mine = await advance(courier.ctx, order.id, 'DELIVERING');
    expect(mine.driver?.id).toBe(courier.id);
  });

  test('dois entregadores pegando o mesmo pedido ao mesmo tempo: só um assume', async () => {
    const order = await newOrder();
    await advance(kitchen.ctx, order.id, 'PREPARING', 'READY_FOR_PICKUP');
    const [first, second] = await Promise.all([
      patchStatus(courier.ctx, order.id, 'DELIVERING'),
      patchStatus(courier2.ctx, order.id, 'DELIVERING'),
    ]);
    const statuses = [first.status(), second.status()];
    expect(statuses.filter((s) => s === 200), `respostas: ${statuses.join(', ')}`).toHaveLength(1);
    const loser = first.status() === 200 ? second : first;
    // 404: o pedido já saiu da etapa do perdedor (está com o outro entregador)
    expect([400, 403, 404, 409], `perdedor: ${await loser.text()}`).toContain(loser.status());

    const winner = first.status() === 200 ? courier : courier2;
    const final = await getOrder(admin.ctx, order.id);
    expect(final.status).toBe('DELIVERING');
    expect(final.driver?.id).toBe(winner.id);
  });

  test('duas pessoas mudando o mesmo pedido ao mesmo tempo: só uma vence (a outra recebe 409/400)', async () => {
    const order = await newOrder();
    const [first, second] = await Promise.all([
      patchStatus(kitchen.ctx, order.id, 'PREPARING'),
      patchStatus(employee.ctx, order.id, 'PREPARING'),
    ]);
    const statuses = [first.status(), second.status()];
    expect(statuses.filter((s) => s === 200), `respostas: ${statuses.join(', ')}`).toHaveLength(1);
    const loser = first.status() === 200 ? second : first;
    expect([400, 409], `perdedor: ${await loser.text()}`).toContain(loser.status());
    expect((await getOrder(admin.ctx, order.id)).status).toBe('PREPARING');
  });

  test('entregador não conclui entrega de outro entregador (404: fora da etapa dele)', async () => {
    const order = await newOrder();
    await advance(kitchen.ctx, order.id, 'PREPARING', 'READY_FOR_PICKUP');
    await advance(courier.ctx, order.id, 'DELIVERING');
    await expectNestError(await patchStatus(courier2.ctx, order.id, 'DONE'), 404, 'Pedido não encontrado.');
    const still = await getOrder(admin.ctx, order.id);
    expect(still.status).toBe('DELIVERING');
    expect(still.payment_status).toBe('PENDING');
  });

  test('entregador não mexe em pedidos fora da sua etapa (404) nem muda o que não pode na etapa (403)', async () => {
    const order = await newOrder();
    // Pendente: fora da etapa do entregador → 404 uniforme
    await expectNestError(await patchStatus(courier.ctx, order.id, 'PREPARING'), 404, 'Pedido não encontrado.');
    await expectNestError(await courier.ctx.patch(`/orders/${order.id}/cancel`), 404, 'Pedido não encontrado.');
    await advance(kitchen.ctx, order.id, 'PREPARING', 'READY_FOR_PICKUP');
    await expectNestError(await patchStatus(courier.ctx, order.id, 'DONE'), 403);
    await expectNestError(await patchStatus(courier.ctx, order.id, 'CANCELED'), 403);
    await expectNestError(await patchStatus(courier.ctx, order.id, 'PREPARING'), 403);
    expect((await getOrder(admin.ctx, order.id)).status).toBe('READY_FOR_PICKUP');
  });

  test('pedido de retirada nunca entra em DELIVERING (400 "Transição inválida")', async () => {
    const order = await newOrder('TAKEOUT');
    await advance(kitchen.ctx, order.id, 'PREPARING', 'READY_FOR_PICKUP');
    for (const actor of [admin, employee]) {
      await expectNestError(
        await patchStatus(actor.ctx, order.id, 'DELIVERING'),
        400,
        'Transição inválida: READY_FOR_PICKUP → DELIVERING',
      );
    }
    // Retirada pronta não é da etapa do entregador: 404 (a mensagem não revela o tipo do pedido)
    await expectNestError(await patchStatus(courier.ctx, order.id, 'DELIVERING'), 404, 'Pedido não encontrado.');
    // Nem direto do PENDING pelo gerente
    const fresh = await newOrder('TAKEOUT');
    await expectNestError(await patchStatus(admin.ctx, fresh.id, 'DELIVERING'), 400, /Transição inválida/);
  });

  // -------------------------------------------------------------------------
  // Administrador e atendente
  // -------------------------------------------------------------------------

  test('atendente move o pedido livremente entre as etapas não finais', async () => {
    const order = await newOrder();
    expect((await advance(employee.ctx, order.id, 'READY_FOR_PICKUP')).status).toBe('READY_FOR_PICKUP');
    expect((await advance(employee.ctx, order.id, 'PENDING')).status).toBe('PENDING');
    expect((await advance(employee.ctx, order.id, 'DELIVERING')).status).toBe('DELIVERING');
    expect((await advance(employee.ctx, order.id, 'PREPARING')).status).toBe('PREPARING');
  });

  test('ADMIN conclui retirada (READY_FOR_PICKUP→DONE) e o pagamento na retirada vira PAID', async () => {
    const order = await newOrder('TAKEOUT');
    const done = await advance(admin.ctx, order.id, 'PREPARING', 'READY_FOR_PICKUP', 'DONE');
    expect(done.status).toBe('DONE');
    expect(done.payment_status).toBe('PAID');
  });

  test('gerentes cancelam pelo PATCH de status e o pagamento não vira PAID', async () => {
    const order = await newOrder();
    const canceled = await advance(employee.ctx, order.id, 'CANCELED');
    expect(canceled.status).toBe('CANCELED');
    expect(canceled.payment_status).toBe('PENDING');
  });

  test('DONE é final para todos (400 "Transição inválida")', async () => {
    const order = await newOrder('TAKEOUT');
    await advance(admin.ctx, order.id, 'DONE');
    await expectNestError(await patchStatus(admin.ctx, order.id, 'PENDING'), 400, 'Transição inválida: DONE → PENDING');
    await expectNestError(await patchStatus(employee.ctx, order.id, 'CANCELED'), 400, 'Transição inválida: DONE → CANCELED');
    // Cozinha: concluído está fora da etapa → 404 (sem "Transição inválida: DONE → ...")
    await expectNestError(await patchStatus(kitchen.ctx, order.id, 'PREPARING'), 404, 'Pedido não encontrado.');
    expect((await getOrder(admin.ctx, order.id)).status).toBe('DONE');
  });

  test('CANCELED é final para todos (400 "Transição inválida")', async () => {
    const order = await newOrder();
    await advance(admin.ctx, order.id, 'CANCELED');
    await expectNestError(await patchStatus(admin.ctx, order.id, 'PENDING'), 400, 'Transição inválida: CANCELED → PENDING');
    await expectNestError(await patchStatus(employee.ctx, order.id, 'DONE'), 400, /Transição inválida/);
    await expectNestError(await patchStatus(kitchen.ctx, order.id, 'PREPARING'), 404, 'Pedido não encontrado.');
    expect((await getOrder(admin.ctx, order.id)).status).toBe('CANCELED');
  });

  test('mudar para o mesmo status é inválido (400)', async () => {
    const order = await newOrder();
    await expectNestError(await patchStatus(admin.ctx, order.id, 'PENDING'), 400, 'Transição inválida: PENDING → PENDING');
  });

  test('status desconhecido ou ausente é recusado (400)', async () => {
    const order = await newOrder();
    await expectNestError(await patchStatus(admin.ctx, order.id, 'ENTREGUE'), 400);
    await expectNestError(await admin.ctx.patch(`/orders/${order.id}`, { data: {} }), 400);
  });

  test('PATCH de status aceita somente { status }: campos extras → 400 e nada muda', async () => {
    const order = await newOrder();
    const extras: Record<string, unknown>[] = [
      { total_price: 0.01 },
      { payment_status: 'PAID' },
      { driver: { id: courier.id } },
      { items: [] },
    ];
    for (const extra of extras) {
      await expectNestError(await admin.ctx.patch(`/orders/${order.id}`, { data: { status: 'PREPARING', ...extra } }), 400);
    }
    const still = await getOrder(admin.ctx, order.id);
    expect(still.status).toBe('PENDING');
    expect(still.payment_status).toBe('PENDING');
    expect(still.total_price).toBe(order.total_price);
    expect(still.driver).toBeNull();
  });

  test('cliente não altera status (403) e anônimo recebe 401', async () => {
    const order = await newOrder();
    await expectNestError(await patchStatus(client.ctx, order.id, 'CANCELED'), 403);
    await expectNestError(await patchStatus(client.ctx, order.id, 'PREPARING'), 403);
    await expectStatus(await patchStatus(anon, order.id, 'PREPARING'), 401);
    expect((await getOrder(client.ctx, order.id)).status).toBe('PENDING');
  });

  test('PATCH de status em pedido inexistente responde 404', async () => {
    await expectNestError(await patchStatus(admin.ctx, UNKNOWN_ID, 'PREPARING'), 404);
    await expectNestError(await patchStatus(admin.ctx, 'abc' as unknown as number, 'PREPARING'), 400);
  });

  test('ids fora do intervalo de inteiro na URL de pedidos respondem 400/404 (nunca 500)', async () => {
    const id = OUT_OF_RANGE_ID;
    const calls: [string, () => ReturnType<APIRequestContext['get']>][] = [
      ['GET /orders/:id (ADMIN)', () => admin.ctx.get(`/orders/${id}`)],
      ['GET /orders/:id (CLIENT)', () => client.ctx.get(`/orders/${id}`)],
      ['PATCH /orders/:id', () => admin.ctx.patch(`/orders/${id}`, { data: { status: 'PREPARING' } })],
      ['PATCH /orders/:id/cancel', () => client.ctx.patch(`/orders/${id}/cancel`)],
      ['PATCH /orders/:id/assign', () => admin.ctx.patch(`/orders/${id}/assign`, { data: { driverId: courier.id } })],
      ['GET /orders/:id/nearby', () => admin.ctx.get(`/orders/${id}/nearby`)],
    ];
    for (const [label, call] of calls) {
      const res = await call();
      expect.soft([400, 404], `${label} com id ${id} → ${res.status()} ${await res.text()}`).toContain(res.status());
    }
  });

  // -------------------------------------------------------------------------
  // Atribuição de entregador
  // -------------------------------------------------------------------------

  test('atendente atribui entregador a pedido em preparo: status DELIVERING e driver definido', async () => {
    const order = await newOrder();
    await advance(kitchen.ctx, order.id, 'PREPARING');
    const res = await assign(employee, order.id, courier2.id);
    await expectStatus(res, 200);
    const assigned = await res.json();
    expect(assigned.status).toBe('DELIVERING');
    expect(assigned.driver?.id).toBe(courier2.id);
    expectNoPasswordFields(assigned);
    // O entregador atribuído conclui a entrega
    expect((await advance(courier2.ctx, order.id, 'DONE')).status).toBe('DONE');
  });

  test('ADMIN atribui entregador a pedido pronto e reatribui durante a entrega', async () => {
    const order = await newOrder();
    await advance(kitchen.ctx, order.id, 'PREPARING', 'READY_FOR_PICKUP');
    const first = await assign(admin, order.id, courier.id);
    await expectStatus(first, 200);
    expect((await first.json()).driver?.id).toBe(courier.id);

    const second = await assign(admin, order.id, courier2.id);
    await expectStatus(second, 200);
    const reassigned = await second.json();
    expect(reassigned.status).toBe('DELIVERING');
    expect(reassigned.driver?.id).toBe(courier2.id);
    // O entregador anterior não conclui mais: a entrega saiu da etapa dele (404 uniforme)
    await expectNestError(await patchStatus(courier.ctx, order.id, 'DONE'), 404, 'Pedido não encontrado.');
  });

  test('atribuição só vale para pedidos de entrega (TAKEOUT → 400)', async () => {
    const order = await newOrder('TAKEOUT');
    await advance(kitchen.ctx, order.id, 'PREPARING');
    await expectNestError(await assign(admin, order.id, courier.id), 400);
    const still = await getOrder(admin.ctx, order.id);
    expect(still.status).toBe('PREPARING');
    expect(still.driver).toBeNull();
  });

  test('atribuição só em PREPARING, READY_FOR_PICKUP ou DELIVERING (PENDING, DONE e CANCELED → 400)', async () => {
    const pending = await newOrder();
    await expectNestError(await assign(employee, pending.id, courier.id), 400);
    expect((await getOrder(admin.ctx, pending.id)).status).toBe('PENDING');

    const done = await newOrder();
    await advance(admin.ctx, done.id, 'DONE');
    await expectNestError(await assign(employee, done.id, courier.id), 400);

    const canceled = await newOrder();
    await advance(admin.ctx, canceled.id, 'CANCELED');
    await expectNestError(await assign(employee, canceled.id, courier.id), 400);
    expect((await getOrder(admin.ctx, canceled.id)).status).toBe('CANCELED');
  });

  test('atribuição exige entregador ativo da equipe da loja: cozinha 400; cliente, inexistente e excluído 404', async () => {
    const order = await newOrder();
    await advance(kitchen.ctx, order.id, 'PREPARING');
    // Cliente não é da equipe da loja: 404 uniforme (como um entregador inexistente ou de outra loja)
    await expectNestError(await assign(admin, order.id, client.id), 404);
    await expectNestError(await assign(admin, order.id, kitchen.id), 400);
    await expectNestError(await assign(admin, order.id, UNKNOWN_ID), 404);

    const gone = await actors.newStaff(admin.ctx, 'COURIER');
    await expectStatus(await admin.ctx.delete(`/users/${gone.id}`), 200);
    await expectNestError(await assign(admin, order.id, gone.id), 404);

    const still = await getOrder(admin.ctx, order.id);
    expect(still.status).toBe('PREPARING');
    expect(still.driver).toBeNull();
  });

  test('atribuição com driverId fora do intervalo de inteiro responde 400/404 (nunca 500)', async () => {
    const order = await newOrder();
    await advance(kitchen.ctx, order.id, 'PREPARING');
    const res = await assign(admin, order.id, OUT_OF_RANGE_ID);
    expect([400, 404], `driverId ${OUT_OF_RANGE_ID} → ${res.status()} ${await res.text()}`).toContain(res.status());
    const still = await getOrder(admin.ctx, order.id);
    expect(still.status).toBe('PREPARING');
    expect(still.driver).toBeNull();
  });

  test('somente ADMIN e EMPLOYEE atribuem entregador (KITCHEN, COURIER e CLIENT 403; anônimo 401)', async () => {
    const order = await newOrder();
    await advance(kitchen.ctx, order.id, 'PREPARING');
    for (const actor of [kitchen, courier, client]) {
      await expectNestError(await assign(actor, order.id, courier.id), 403);
    }
    await expectStatus(await anon.patch(`/orders/${order.id}/assign`, { data: { driverId: courier.id } }), 401);
    expect((await getOrder(admin.ctx, order.id)).driver).toBeNull();
  });

  test('corpo da atribuição é validado (driverId ausente, texto ou campo extra → 400)', async () => {
    const order = await newOrder();
    await advance(kitchen.ctx, order.id, 'PREPARING');
    await expectNestError(await admin.ctx.patch(`/orders/${order.id}/assign`, { data: {} }), 400);
    await expectNestError(await assign(admin, order.id, 'abc'), 400);
    await expectNestError(await assign(admin, order.id, 0), 400);
    await expectNestError(
      await admin.ctx.patch(`/orders/${order.id}/assign`, { data: { driverId: courier.id, status: 'DONE' } }),
      400,
    );
    await expectNestError(await assign(admin, UNKNOWN_ID, courier.id), 404);
  });

  // -------------------------------------------------------------------------
  // Cancelamento (PATCH /orders/:id/cancel)
  // -------------------------------------------------------------------------

  test('cliente cancela o próprio pedido enquanto PENDING', async () => {
    const order = await newOrder();
    const res = await client.ctx.patch(`/orders/${order.id}/cancel`);
    await expectStatus(res, 200);
    const canceled = await res.json();
    expect(canceled.status).toBe('CANCELED');
    expect(canceled.payment_status).toBe('PENDING');
    expect((await getOrder(client.ctx, order.id)).status).toBe('CANCELED');
  });

  test('cliente não cancela pedido que já saiu de PENDING (400)', async () => {
    const order = await newOrder();
    await advance(kitchen.ctx, order.id, 'PREPARING');
    await expectNestError(await client.ctx.patch(`/orders/${order.id}/cancel`), 400);
    expect((await getOrder(client.ctx, order.id)).status).toBe('PREPARING');
  });

  test('cliente não cancela pedido de outro cliente (404, como um pedido inexistente)', async () => {
    const order = await newOrder();
    await expectNestError(await otherClient.ctx.patch(`/orders/${order.id}/cancel`), 404);
    await expectNestError(await otherClient.ctx.patch(`/stores/${E2E.demoStoreSlug}/orders/${order.id}/cancel`), 404);
    expect((await getOrder(client.ctx, order.id)).status).toBe('PENDING');
  });

  test('cozinha e entregador não cancelam pedidos (403 na etapa; 404 fora dela)', async () => {
    const order = await newOrder();
    await expectNestError(await kitchen.ctx.patch(`/orders/${order.id}/cancel`), 403);
    // Pendente não é da etapa do entregador: 404 uniforme
    await expectNestError(await courier.ctx.patch(`/orders/${order.id}/cancel`), 404, 'Pedido não encontrado.');
    expect((await getOrder(client.ctx, order.id)).status).toBe('PENDING');
  });

  test('atendente e ADMIN cancelam pedidos em andamento (PREPARING, READY_FOR_PICKUP, DELIVERING)', async () => {
    const preparing = await newOrder();
    await advance(kitchen.ctx, preparing.id, 'PREPARING');
    await expectStatus(await employee.ctx.patch(`/orders/${preparing.id}/cancel`), 200);
    expect((await getOrder(admin.ctx, preparing.id)).status).toBe('CANCELED');

    const ready = await newOrder('TAKEOUT');
    await advance(kitchen.ctx, ready.id, 'PREPARING', 'READY_FOR_PICKUP');
    await expectStatus(await admin.ctx.patch(`/orders/${ready.id}/cancel`), 200);

    const delivering = await newOrder();
    await advance(kitchen.ctx, delivering.id, 'PREPARING', 'READY_FOR_PICKUP');
    await advance(courier.ctx, delivering.id, 'DELIVERING');
    const res = await admin.ctx.patch(`/orders/${delivering.id}/cancel`);
    await expectStatus(res, 200);
    expect((await res.json()).status).toBe('CANCELED');
  });

  test('pedidos concluídos ou já cancelados não podem ser cancelados (400)', async () => {
    const done = await newOrder('TAKEOUT');
    await advance(admin.ctx, done.id, 'DONE');
    await expectNestError(await admin.ctx.patch(`/orders/${done.id}/cancel`), 400);
    await expectNestError(await client.ctx.patch(`/orders/${done.id}/cancel`), 400);
    expect((await getOrder(admin.ctx, done.id)).status).toBe('DONE');

    const canceled = await newOrder();
    await expectStatus(await client.ctx.patch(`/orders/${canceled.id}/cancel`), 200);
    await expectNestError(await client.ctx.patch(`/orders/${canceled.id}/cancel`), 400);
    await expectNestError(await employee.ctx.patch(`/orders/${canceled.id}/cancel`), 400);
  });

  test('cancelamento exige autenticação (401) e pedido inexistente responde 404', async () => {
    const order = await newOrder();
    await expectStatus(await anon.patch(`/orders/${order.id}/cancel`), 401);
    await expectNestError(await admin.ctx.patch(`/orders/${UNKNOWN_ID}/cancel`), 404);
    await expectNestError(await client.ctx.patch(`/orders/${UNKNOWN_ID}/cancel`), 404);
  });

  // -------------------------------------------------------------------------
  // Entregadores e pedidos próximos
  // -------------------------------------------------------------------------

  test('lista de entregadores (ADMIN/EMPLOYEE) traz só entregadores ativos, sem senha', async () => {
    const gone = await actors.newStaff(admin.ctx, 'COURIER');
    await expectStatus(await admin.ctx.delete(`/users/${gone.id}`), 200);

    for (const actor of [admin, employee]) {
      const res = await actor.ctx.get('/orders/drivers/list');
      await expectStatus(res, 200);
      const drivers: Json[] = await res.json();
      const listed = drivers.map((d) => d.id);
      expect(listed).toEqual(expect.arrayContaining([courier.id, courier2.id]));
      for (const notCourier of [client.id, kitchen.id, admin.id, employee.id, gone.id]) {
        expect(listed, `id ${notCourier} fora da lista`).not.toContain(notCourier);
      }
      for (const driver of drivers) {
        expect(typeof driver.id).toBe('number');
        expect(typeof driver.name).toBe('string');
      }
      expectNoPasswordFields(drivers);
    }
  });

  test('lista de entregadores é negada para KITCHEN, COURIER e CLIENT (403) e anônimo (401)', async () => {
    for (const actor of [kitchen, courier, client]) {
      await expectNestError(await actor.ctx.get('/orders/drivers/list'), 403);
    }
    await expectStatus(await anon.get('/orders/drivers/list'), 401);
  });

  test('pedidos próximos: prontos, sem entregador e no mesmo bairro (ignora acento e caixa)', async () => {
    const tag = uid('nb');
    const hood = `São Commerce ${tag}`;
    const target = await newOrder('DELIVERY', (await createAddress(client.ctx, hood)).id);
    const sameHoodAddress = await createAddress(otherClient.ctx, `SAO COMMERCE ${tag.toUpperCase()}`);
    const sibling = await placeOrder(otherClient.ctx, {
      items: [{ productId: product.id, quantity: 1 }],
      type: 'DELIVERY',
      addressId: sameHoodAddress.id,
      paymentMethod: 'MONEY',
    });
    const pendingSibling = await newOrder('DELIVERY', (await createAddress(client.ctx, hood)).id);
    const takenSibling = await newOrder('DELIVERY', (await createAddress(client.ctx, hood)).id);
    const readyWithDriver = await newOrder('DELIVERY', (await createAddress(client.ctx, hood)).id);
    const elsewhere = await newOrder('DELIVERY', (await createAddress(client.ctx, `Outro Bairro ${tag}`)).id);

    await advance(kitchen.ctx, target.id, 'PREPARING', 'READY_FOR_PICKUP');
    await advance(kitchen.ctx, sibling.id, 'PREPARING', 'READY_FOR_PICKUP');
    await advance(kitchen.ctx, takenSibling.id, 'PREPARING', 'READY_FOR_PICKUP');
    await advance(courier.ctx, takenSibling.id, 'DELIVERING');
    // Pronto, mas já com entregador (atribuído e devolvido para "pronto"): não entra na lista
    await advance(kitchen.ctx, readyWithDriver.id, 'PREPARING');
    await expectStatus(await assign(employee, readyWithDriver.id, courier2.id), 200);
    await advance(employee.ctx, readyWithDriver.id, 'READY_FOR_PICKUP');
    await advance(kitchen.ctx, elsewhere.id, 'PREPARING', 'READY_FOR_PICKUP');

    for (const actor of [admin, employee]) {
      const res = await actor.ctx.get(`/orders/${target.id}/nearby`);
      await expectStatus(res, 200);
      const nearby: Json[] = await res.json();
      expect(nearby.map((o) => o.id), actor.session.user.role).toEqual([sibling.id]);
      expectNoPasswordFields(nearby);
    }
    expect([pendingSibling.id, takenSibling.id, readyWithDriver.id, elsewhere.id]).not.toContain(sibling.id);
  });

  test('pedidos próximos: retirada retorna lista vazia e pedido inexistente responde 404', async () => {
    const order = await newOrder('TAKEOUT');
    const res = await admin.ctx.get(`/orders/${order.id}/nearby`);
    await expectStatus(res, 200);
    expect(await res.json()).toEqual([]);
    await expectNestError(await admin.ctx.get(`/orders/${UNKNOWN_ID}/nearby`), 404);
  });

  test('pedidos próximos são negados para KITCHEN, COURIER e CLIENT (403) e anônimo (401)', async () => {
    const order = await newOrder();
    for (const actor of [kitchen, courier, client]) {
      await expectNestError(await actor.ctx.get(`/orders/${order.id}/nearby`), 403);
    }
    await expectStatus(await anon.get(`/orders/${order.id}/nearby`), 401);
  });

  // -------------------------------------------------------------------------
  // Dashboard (somente ADMIN)
  // -------------------------------------------------------------------------

  test('resumo, gráficos e relatórios do dashboard são exclusivos do ADMIN da loja', async () => {
    const superadmin = await actors.defaultUser('superadmin');
    for (const path of ['/orders/summary', '/orders/charts', '/orders/reports']) {
      for (const actor of [employee, kitchen, courier, client, superadmin]) {
        await expectNestError(await actor.ctx.get(path), 403);
      }
      await expectStatus(await anon.get(path), 401);
      // A loja demo tem o recurso "advanced_reports" (gráficos e relatórios)
      await expectStatus(await admin.ctx.get(path), 200);
    }
  });

  test('relatório de vendas (GET /orders/reports): período, totais, dias, status, pagamentos e mais vendidos da loja', async () => {
    const top = await createProduct(admin.ctx, { name: `Relatorio ${uid('rl')}`, price: 7, category: 'bebidas' });
    const order = await placeOrder(client.ctx, {
      items: [{ productId: top.id, quantity: 50 }, { productId: top.id, quantity: 50 }],
      type: 'TAKEOUT',
      paymentMethod: 'MONEY',
    });
    await advance(admin.ctx, order.id, 'PREPARING', 'READY_FOR_PICKUP', 'DONE');

    const res = await admin.ctx.get('/orders/reports');
    await expectStatus(res, 200);
    const report = await res.json();
    expect(Object.keys(report).sort()).toEqual(['ordersByStatus', 'paymentMethods', 'period', 'revenueByDay', 'summary', 'topProducts']);
    // Sem período: os últimos dias até hoje, no fuso da loja
    expect(report.period).toMatchObject({ timeZone: expect.any(String) });
    expect(report.period.from <= report.period.to).toBe(true);
    expect(report.revenueByDay).toHaveLength(report.period.days);
    expect(report.summary.revenue).toBeGreaterThanOrEqual(700);
    expect(report.summary.paidOrders).toBeGreaterThanOrEqual(1);
    const statuses = report.ordersByStatus.map((row: Json) => row.status);
    expect(statuses).toEqual(expect.arrayContaining(['PENDING', 'PREPARING', 'READY_FOR_PICKUP', 'DELIVERING', 'DONE', 'CANCELED']));
    expect(report.paymentMethods.some((row: Json) => row.method === 'MONEY')).toBe(true);
    expect(report.topProducts.length).toBeLessThanOrEqual(10);
    expect(report.topProducts.find((row: Json) => row.name === top.name)?.quantity).toBe(100);

    // Período informado (AAAA-MM-DD) e validações
    const today = report.period.to;
    const single = await admin.ctx.get(`/orders/reports?from=${today}&to=${today}`);
    await expectStatus(single, 200);
    expect((await single.json()).period).toMatchObject({ from: today, to: today, days: 1 });
    await expectNestError(await admin.ctx.get('/orders/reports?from=17-10-2026'), 400);
    await expectNestError(await admin.ctx.get('/orders/reports?from=2026-10-10&to=2026-10-01'), 400);
    await expectNestError(await admin.ctx.get('/orders/reports?from=2024-01-01&to=2026-01-01'), 400);
  });

  test('resumo traz contadores e faturamento numéricos', async () => {
    const res = await admin.ctx.get('/orders/summary');
    await expectStatus(res, 200);
    const summary = await res.json();
    for (const key of ['totalOrders', 'revenue', 'pendingOrders', 'preparingOrders', 'pendingPayments']) {
      expect(typeof summary[key], key).toBe('number');
      expect(summary[key], key).toBeGreaterThanOrEqual(0);
    }
  });

  test('faturamento do resumo conta só pedidos PAGOS e não cancelados', async () => {
    // Valor alto e único: mudanças paralelas de outros testes ficam muito abaixo da margem
    const BIG = 40_000;
    const MARGIN = 20_000;
    const big = await createProduct(admin.ctx, { name: `Banquete ${uid('bq')}`, price: BIG, category: 'combos' });
    const input = { items: [{ productId: big.id, quantity: 1 }], type: 'TAKEOUT' as const };
    const revenue = async (): Promise<number> => {
      const res = await admin.ctx.get('/orders/summary');
      await expectStatus(res, 200);
      return (await res.json()).revenue;
    };

    const r0 = await revenue();
    const unpaid = await placeOrder(client.ctx, { ...input, paymentMethod: 'MONEY' });
    const r1 = await revenue();
    expect(Math.abs(r1 - r0), `pedido não pago fora do faturamento (${r0} → ${r1})`).toBeLessThan(MARGIN);

    await advance(admin.ctx, unpaid.id, 'PREPARING', 'READY_FOR_PICKUP', 'DONE');
    const r2 = await revenue();
    expect(Math.abs(r2 - r1 - BIG), `pedido concluído (PAID) entra no faturamento (${r1} → ${r2})`).toBeLessThan(MARGIN);

    const card = await payCard(client.ctx, input);
    const paid = await placeOrder(client.ctx, { ...input, paymentMethod: 'CREDIT_CARD', paymentId: card.id });
    expect(paid.payment_status).toBe('PAID');
    const r3 = await revenue();
    expect(Math.abs(r3 - r2 - BIG), `pedido pago online entra no faturamento (${r2} → ${r3})`).toBeLessThan(MARGIN);

    await expectStatus(await admin.ctx.patch(`/orders/${paid.id}/cancel`), 200);
    const r4 = await revenue();
    expect(Math.abs(r3 - r4 - BIG), `pedido pago e cancelado sai do faturamento (${r3} → ${r4})`).toBeLessThan(MARGIN);
  });

  test('gráficos trazem 7 dias de faturamento (hoje por último) e até 5 produtos mais vendidos', async () => {
    const champion = await createProduct(admin.ctx, { name: `Campeao ${uid('cp')}`, price: 1, category: 'bebidas' });
    const order = await placeOrder(client.ctx, {
      items: [
        { productId: champion.id, quantity: 50 },
        { productId: champion.id, quantity: 50 },
      ],
      type: 'TAKEOUT',
      paymentMethod: 'MONEY',
    });
    await advance(admin.ctx, order.id, 'PREPARING', 'READY_FOR_PICKUP', 'DONE');

    const res = await admin.ctx.get('/orders/charts');
    await expectStatus(res, 200);
    const { revenueChart, productsChart } = await res.json();

    expect(revenueChart).toHaveLength(7);
    for (const day of revenueChart) {
      expect(day.date).toMatch(/^\d{2}\/\d{2}$/);
      expect(typeof day.total).toBe('number');
    }
    const today = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    expect(revenueChart[6].date).toBe(today);
    expect(revenueChart[6].total, 'faturamento de hoje inclui o pedido pago').toBeGreaterThanOrEqual(100);

    expect(productsChart.length).toBeLessThanOrEqual(5);
    const quantities = productsChart.map((p: Json) => p.quantity);
    expect([...quantities].sort((a: number, b: number) => b - a)).toEqual(quantities);
    expect(productsChart.find((p: Json) => p.name === champion.name)?.quantity).toBe(100);
  });
});
