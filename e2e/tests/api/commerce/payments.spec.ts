import { test, expect, type APIRequestContext } from '@playwright/test';
import { uid } from '../../../support/api';
import {
  Actors,
  UNKNOWN_ID,
  cardBody,
  createAddon,
  createAddress,
  createProduct,
  expectMoney,
  expectNestError,
  expectStatus,
  getOrder,
  myOrders,
  payCard,
  payPix,
  paymentStatus,
  placeOrder,
  postCommerce,
  quote,
  tryOrder,
  waitApproved,
  type Actor,
  type Json,
  type QuoteInput,
} from './helpers';

test.describe('Pagamentos (sandbox) e verificação do pagamento no pedido', () => {
  const actors = new Actors();
  let anon: APIRequestContext;
  let admin: Actor;
  let employee: Actor;
  let kitchen: Actor;
  let courier: Actor;
  let payer: Actor;
  let stranger: Actor;
  let product: Json; // 20,00
  let addon: Json; // 2,50
  let unavailable: Json;
  let free: Json; // 0,00
  let address: Json; // Flamengo: taxa 7
  let strangerAddress: Json;
  let cart: QuoteInput; // (20 + 2,50) x 2 + 7 = 52,00

  test.beforeAll(async () => {
    anon = await actors.anon();
    admin = await actors.defaultUser('admin');
    employee = await actors.defaultUser('employee');
    kitchen = await actors.defaultUser('kitchen');
    courier = await actors.defaultUser('courier');
    payer = await actors.newClient('Pagador');
    stranger = await actors.newClient('Estranho');
    addon = await createAddon(admin.ctx, { name: `Queijo ${uid('q')}`, price: 2.5 });
    product = await createProduct(admin.ctx, { name: `Pago ${uid('pg')}`, price: 20, allowed_addons_ids: [addon.id] });
    unavailable = await createProduct(admin.ctx, { name: `Pausado ${uid('pz')}`, price: 9, available: false });
    free = await createProduct(admin.ctx, { name: `Brinde ${uid('br')}`, price: 0, category: 'molhos' });
    address = await createAddress(payer.ctx, 'Flamengo');
    strangerAddress = await createAddress(stranger.ctx, 'Flamengo');
    cart = {
      items: [{ productId: product.id, quantity: 2, addonIds: [addon.id] }],
      type: 'DELIVERY',
      addressId: address.id,
    };
  });

  test.afterAll(async () => {
    await actors.dispose();
  });

  const takeout = (quantity: number): QuoteInput => ({
    items: [{ productId: product.id, quantity }],
    type: 'TAKEOUT',
  });

  // -------------------------------------------------------------------------
  // Criação dos pagamentos
  // -------------------------------------------------------------------------

  test('cartão com token de teste vira pagamento aprovado simulado e o servidor já cria o pedido pago', async () => {
    const q = await quote(payer.ctx, cart);
    expect(q.total).toBe(52);
    const payment = await payCard(payer.ctx, cart);
    expect(Object.keys(payment).sort()).toEqual(['amount', 'id', 'orderId', 'simulation', 'status', 'status_detail']);
    expect(typeof payment.id).toBe('number');
    expect(payment).toMatchObject({ status: 'approved', simulation: true });
    expect(typeof payment.status_detail).toBe('string');
    expect(payment.amount).toBe(q.total);
    expect(typeof payment.orderId, 'pedido criado pelo servidor na aprovação').toBe('number');

    const status = await paymentStatus(payer.ctx, payment.id);
    expect(status).toEqual({ id: payment.id, status: 'approved', status_detail: payment.status_detail, orderId: payment.orderId });

    const order = await getOrder(payer.ctx, payment.orderId);
    expect(order).toMatchObject({ payment_status: 'PAID', payment_id: payment.id, payment_method: 'CREDIT_CARD' });
    expect(order.total_price).toBe(q.total);
  });

  test('PIX gera QR pendente e é aprovado sozinho em ~5 s no sandbox', async () => {
    const q = await quote(payer.ctx, cart);
    const createdAt = Date.now();
    const pix = await payPix(payer.ctx, cart);
    expect(Object.keys(pix).sort()).toEqual([
      'amount', 'expires_at', 'id', 'qr_code', 'qr_code_base64', 'simulation', 'status', 'ticket_url',
    ]);
    expect(Date.parse(pix.expires_at), 'expires_at no futuro').toBeGreaterThan(Date.now());
    expect(typeof pix.id).toBe('number');
    expect(pix.status).toBe('pending');
    expect(typeof pix.qr_code).toBe('string');
    expect(pix.qr_code.length).toBeGreaterThan(0);
    expect(pix.qr_code_base64 === null || typeof pix.qr_code_base64 === 'string').toBe(true);
    expect(pix.ticket_url === null || typeof pix.ticket_url === 'string').toBe(true);
    expect(pix.amount).toBe(q.total);
    expect(pix.simulation).toBe(true);

    const first = await paymentStatus(payer.ctx, pix.id);
    expect(first).toMatchObject({ id: pix.id, status: 'pending' });

    await waitApproved(payer.ctx, pix.id);
    expect(Date.now() - createdAt, 'aprovação não é imediata').toBeGreaterThanOrEqual(3_500);
    const approved = await paymentStatus(payer.ctx, pix.id);
    expect(approved).toMatchObject({ id: pix.id, status: 'approved' });

    // Aprovado o PIX, o próprio servidor cria o pedido (o cliente pode até ter fechado o app)
    expect(typeof approved.orderId, 'pedido criado na aprovação').toBe('number');
    const order = await getOrder(payer.ctx, approved.orderId);
    expect(order).toMatchObject({ payment_status: 'PAID', payment_method: 'PIX', payment_id: pix.id });
    expect(order.total_price).toBe(pix.amount);
  });

  test('PIX abandonado (ninguém consulta o status) vira pedido pago pelo job de conciliação do servidor', async () => {
    test.setTimeout(150_000);
    const buyer = await actors.newClient('Abandona PIX');
    const pix = await payPix(buyer.ctx, takeout(1));
    // Nenhuma chamada a /payment/status: aprovação do sandbox (~5 s) + job de conciliação (a cada 60 s)
    const linked = async () => (await myOrders(buyer.ctx)).filter((o) => o.payment_id === pix.id);
    await expect
      .poll(async () => (await linked()).length, { timeout: 120_000, intervals: [5_000], message: 'pedido criado pelo servidor' })
      .toBe(1);
    const [order] = await linked();
    expect(order).toMatchObject({ payment_status: 'PAID', payment_method: 'PIX' });
    expect(order.total_price).toBe(pix.amount);
  });

  test('valor cobrado bate com o orçamento em centavos (adicionais e entrega)', async () => {
    const odd = await createProduct(admin.ctx, { name: `Quebrado ${uid('qb')}`, price: 19.99, allowed_addons_ids: [addon.id] });
    const order: QuoteInput = {
      items: [{ productId: odd.id, quantity: 3, addonIds: [addon.id, addon.id] }],
      type: 'DELIVERY',
      addressId: address.id,
    };
    const q = await quote(payer.ctx, order);
    expect(q.total).toBe(81.97); // (19,99 + 5,00) x 3 + 7
    expect((await payCard(payer.ctx, order)).amount).toBe(81.97);
    expect((await payPix(payer.ctx, order)).amount).toBe(81.97);
  });

  test('pedido sem valor a pagar não gera cobrança online (400)', async () => {
    const order: QuoteInput = { items: [{ productId: free.id, quantity: 1 }], type: 'TAKEOUT' };
    expect((await quote(payer.ctx, order)).total).toBe(0);
    await expectNestError(await postCommerce(payer.ctx, '/payment/card', cardBody(order)), 400);
    await expectNestError(await postCommerce(payer.ctx, '/payment/pix', { order }), 400);
  });

  // -------------------------------------------------------------------------
  // Consulta de status
  // -------------------------------------------------------------------------

  test('consulta de status: pagador e equipe podem; outro cliente 403; anônimo 401', async () => {
    const payment = await payCard(payer.ctx, takeout(1));
    for (const actor of [payer, admin, employee, kitchen, courier]) {
      const status = await paymentStatus(actor.ctx, payment.id);
      expect(status, actor.session.user.role).toMatchObject({ id: payment.id, status: 'approved' });
    }
    await expectNestError(await stranger.ctx.get(`/payment/status/${payment.id}`), 403);
    await expectStatus(await anon.get(`/payment/status/${payment.id}`), 401);
  });

  test('consulta de pagamento desconhecido responde 404 e id inválido responde 400', async () => {
    await expectNestError(await payer.ctx.get('/payment/status/123456789'), 404);
    await expectNestError(await admin.ctx.get('/payment/status/abc'), 400);
  });

  // -------------------------------------------------------------------------
  // Pedido pago online
  // -------------------------------------------------------------------------

  test('pedido com paymentId de cartão aprovado nasce PAID', async () => {
    const payment = await payCard(payer.ctx, cart);
    const order = await placeOrder(payer.ctx, { ...cart, paymentMethod: 'CREDIT_CARD', paymentId: payment.id });
    expect(order).toMatchObject({
      status: 'PENDING',
      payment_status: 'PAID',
      payment_method: 'CREDIT_CARD',
      payment_id: payment.id,
    });
    expect(order.total_price).toBe(payment.amount);

    const view = await getOrder(admin.ctx, order.id);
    expect(view).toMatchObject({ payment_status: 'PAID', payment_id: payment.id });
  });

  test('PIX ainda pendente não quita pedido (400, nada é salvo); depois de aprovado quita (PAID)', async () => {
    const pix = await payPix(payer.ctx, cart);
    const early = await tryOrder(payer.ctx, { ...cart, paymentMethod: 'PIX', paymentId: pix.id });
    await expectNestError(early, 400, /aprovado|pending/i);
    // Filtra pelo pagamento: o job de conciliação pode criar pedidos de outros PIX abandonados em paralelo
    expect((await myOrders(payer.ctx)).filter((o) => o.payment_id === pix.id), 'nada foi salvo').toHaveLength(0);

    await waitApproved(payer.ctx, pix.id);
    const order = await placeOrder(payer.ctx, { ...cart, paymentMethod: 'PIX', paymentId: pix.id });
    expect(order).toMatchObject({ payment_status: 'PAID', payment_method: 'PIX', payment_id: pix.id });
    expect(order.total_price).toBe(pix.amount);
  });

  test('o mesmo paymentId nunca gera dois pedidos: registrar de novo devolve o mesmo pedido', async () => {
    const payment = await payCard(payer.ctx, takeout(1));
    const ordersOf = async () => (await myOrders(payer.ctx)).filter((o) => o.payment_id === payment.id);
    expect(await ordersOf(), 'pedido criado na aprovação').toHaveLength(1);

    const again = await placeOrder(payer.ctx, { ...takeout(1), paymentMethod: 'CREDIT_CARD', paymentId: payment.id });
    expect(again.id, 'idempotente: mesmo pedido').toBe(payment.orderId);
    expect(await ordersOf()).toHaveLength(1);
  });

  test('pedidos simultâneos com o mesmo paymentId devolvem o mesmo pedido (um só é criado)', async () => {
    const payment = await payCard(payer.ctx, takeout(1));
    const body = { ...takeout(1), paymentMethod: 'CREDIT_CARD', paymentId: payment.id };
    const responses = await Promise.all([tryOrder(payer.ctx, body), tryOrder(payer.ctx, body), tryOrder(payer.ctx, body)]);
    for (const res of responses) await expectStatus(res, 201);
    const ids = await Promise.all(responses.map(async (r) => (await r.json()).id));
    expect(new Set(ids), `pedidos devolvidos: ${ids.join(', ')}`).toEqual(new Set([payment.orderId]));
    const linked = (await myOrders(payer.ctx)).filter((o) => o.payment_id === payment.id);
    expect(linked).toHaveLength(1);
  });

  test('paymentId de outro cliente é recusado (400)', async () => {
    const payment = await payCard(payer.ctx, takeout(1));
    const res = await tryOrder(stranger.ctx, { ...takeout(1), paymentMethod: 'CREDIT_CARD', paymentId: payment.id });
    await expectNestError(res, 400);
    expect(await myOrders(stranger.ctx)).toEqual([]);
    // O pagamento continua livre para o dono
    const order = await placeOrder(payer.ctx, { ...takeout(1), paymentMethod: 'CREDIT_CARD', paymentId: payment.id });
    expect(order.payment_status).toBe('PAID');
  });

  test('pagamento de um carrinho mais barato nunca vira pedido mais caro (o pedido é o do carrinho pago)', async () => {
    const cheap = await payCard(payer.ctx, takeout(1)); // 20,00
    expect(cheap.amount).toBe(20);

    // Tentativas de "trocar" o carrinho usando o pagamento barato devolvem o pedido realmente pago
    for (const tampered of [
      { ...takeout(3), paymentMethod: 'CREDIT_CARD', paymentId: cheap.id },
      { items: takeout(1).items, type: 'DELIVERY', addressId: address.id, paymentMethod: 'CREDIT_CARD', paymentId: cheap.id },
    ]) {
      const order = await placeOrder(payer.ctx, tampered as never);
      expect(order.id).toBe(cheap.orderId);
      expect(order.total_price, 'continua o valor pago, não o do carrinho adulterado').toBe(20);
      expect(order.type).toBe('TAKEOUT');
      expect(order.items).toHaveLength(1);
      expect(order.items[0].quantity).toBe(1);
    }
    const linked = (await myOrders(payer.ctx)).filter((o) => o.payment_id === cheap.id);
    expect(linked).toHaveLength(1);
  });

  test('pedido criado no pagamento tem exatamente o valor cobrado (sem centavos de diferença)', async () => {
    const plus1 = await createProduct(admin.ctx, { name: `Mais 1 centavo ${uid('p1')}`, price: 20.01 });
    const exact = await payCard(payer.ctx, { items: [{ productId: plus1.id, quantity: 1 }], type: 'TAKEOUT' });
    expect(exact.amount).toBe(20.01);
    const order = await getOrder(payer.ctx, exact.orderId);
    expect(order.payment_status).toBe('PAID');
    expect(order.total_price).toBe(20.01);

    // Registrar outro carrinho de 20,00 com esse pagamento devolve o mesmo pedido de 20,01 (sem "troco" escondido)
    const reuse = await placeOrder(payer.ctx, { ...takeout(1), paymentMethod: 'CREDIT_CARD', paymentId: exact.id });
    expect(reuse.id).toBe(exact.orderId);
    expect(reuse.total_price).toBe(20.01);
  });

  test('paymentId desconhecido é recusado (400) e nada é salvo', async () => {
    const unknown = [123456789, UNKNOWN_ID, 901_000_000_000_001];
    for (const paymentId of unknown) {
      const res = await tryOrder(payer.ctx, { ...takeout(1), paymentMethod: 'CREDIT_CARD', paymentId });
      await expectNestError(res, 400);
    }
    const saved = (await myOrders(payer.ctx)).filter((o) => unknown.includes(Number(o.payment_id)));
    expect(saved).toHaveLength(0);
  });

  test('paymentId em formato inválido é recusado (400)', async () => {
    for (const paymentId of ['123', 0, -5, 1.5]) {
      const res = await tryOrder(payer.ctx, { ...takeout(1), paymentMethod: 'CREDIT_CARD', paymentId });
      await expectNestError(res, 400);
    }
  });

  test('pagamento de pedido cancelado não pode ser reaproveitado (400)', async () => {
    const payment = await payCard(payer.ctx, takeout(1));
    const order = await placeOrder(payer.ctx, { ...takeout(1), paymentMethod: 'CREDIT_CARD', paymentId: payment.id });
    await expectStatus(await payer.ctx.patch(`/orders/${order.id}/cancel`), 200);
    const reuse = await tryOrder(payer.ctx, { ...takeout(1), paymentMethod: 'CREDIT_CARD', paymentId: payment.id });
    await expectNestError(reuse, 400);
  });

  test('forma de pagamento do pedido precisa corresponder ao pagamento (cartão ≠ PIX/dinheiro)', async () => {
    const card = await payCard(payer.ctx, takeout(1));
    await expectNestError(
      await tryOrder(payer.ctx, { ...takeout(1), paymentMethod: 'PIX', paymentId: card.id }),
      400,
    );
    await expectNestError(
      await tryOrder(payer.ctx, { ...takeout(1), paymentMethod: 'MONEY', paymentId: card.id }),
      400,
    );
    // Débito também é cartão
    const order = await placeOrder(payer.ctx, { ...takeout(1), paymentMethod: 'DEBIT_CARD', paymentId: card.id });
    expect(order.payment_status).toBe('PAID');
  });

  // -------------------------------------------------------------------------
  // Quem pode pagar e o que pode ser enviado
  // -------------------------------------------------------------------------

  test('anônimo não cria pagamentos (401)', async () => {
    await expectStatus(await anon.post('/payment/card', { data: cardBody(takeout(1)) }), 401);
    await expectStatus(await anon.post('/payment/pix', { data: { order: takeout(1) } }), 401);
  });

  test('equipe não cria pagamentos (403 para ADMIN, EMPLOYEE, KITCHEN e COURIER)', async () => {
    for (const actor of [admin, employee, kitchen, courier]) {
      await expectNestError(await actor.ctx.post('/payment/card', { data: cardBody(takeout(1)) }), 403);
      await expectNestError(await actor.ctx.post('/payment/pix', { data: { order: takeout(1) } }), 403);
    }
  });

  test('valor enviado pelo cliente não é aceito (campos extras → 400)', async () => {
    const order = takeout(5); // 100,00
    for (const extra of [{ amount: 0.01 }, { transaction_amount: 0.01 }, { total: 0.01 }]) {
      await expectNestError(await postCommerce(payer.ctx, '/payment/card', cardBody(order, extra)), 400);
      await expectNestError(await postCommerce(payer.ctx, '/payment/pix', { order, ...extra }), 400);
    }
    // Dentro do pedido também
    const tampered = { ...order, total: 0.01 };
    await expectNestError(await postCommerce(payer.ctx, '/payment/card', cardBody(tampered)), 400);
    await expectNestError(await postCommerce(payer.ctx, '/payment/pix', { order: tampered }), 400);
  });

  test('pagamento valida o pedido antes de cobrar (mesmas regras do orçamento)', async () => {
    const invalid: [Record<string, unknown>, number][] = [
      [{ items: [], type: 'TAKEOUT' }, 400],
      [{ items: [{ productId: UNKNOWN_ID, quantity: 1 }], type: 'TAKEOUT' }, 400],
      [{ items: [{ productId: unavailable.id, quantity: 1 }], type: 'TAKEOUT' }, 400],
      [{ items: [{ productId: product.id, quantity: 51 }], type: 'TAKEOUT' }, 400],
      [{ items: [{ productId: product.id, quantity: 1 }], type: 'DELIVERY' }, 400],
      [{ items: [{ productId: product.id, quantity: 1 }], type: 'DELIVERY', addressId: strangerAddress.id }, 404],
    ];
    for (const [order, status] of invalid) {
      await expectNestError(await postCommerce(payer.ctx, '/payment/card', cardBody(order)), status);
      await expectNestError(await postCommerce(payer.ctx, '/payment/pix', { order }), status);
    }
    await expectNestError(await postCommerce(payer.ctx, '/payment/pix', {}), 400);
    await expectNestError(await postCommerce(payer.ctx, '/payment/pix', { order: 'pedido' }), 400);
  });

  test('dados do cartão são validados (token, bandeira, documento, parcelas, e-mail)', async () => {
    const order = takeout(1);
    const invalid: Record<string, unknown>[] = [
      { token: '' },
      { token: undefined },
      { paymentMethodId: 'VISA!' },
      { paymentMethodId: undefined },
      { docNumber: '123' },
      { docNumber: undefined },
      { docType: 'RG' },
      { installments: 0 },
      { installments: 13 },
      { email: 'nao-e-email' },
    ];
    for (const extra of invalid) {
      await expectNestError(await postCommerce(payer.ctx, '/payment/card', cardBody(order, extra)), 400);
    }
  });

  test('CPF com máscara é aceito no pagamento com cartão', async () => {
    const res = await postCommerce(payer.ctx, '/payment/card', cardBody(takeout(1), { docNumber: '123.456.789-09' }));
    await expectStatus(res, 201);
    expect((await res.json()).status).toBe('approved');
  });

  test('webhook do Mercado Pago é público e só confirma o recebimento', async () => {
    const res = await anon.post('/payment/webhook', { data: { action: 'payment.updated', data: { id: '123' } } });
    await expectStatus(res, 200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  test('pagamento aprovado vira pedido mesmo se o cliente mandar depois um carrinho inválido', async () => {
    const payment = await payCard(payer.ctx, takeout(2)); // 40,00
    // O pedido já existe desde a aprovação; um registro posterior com item indisponível não o desfaz
    const res = await tryOrder(payer.ctx, {
      items: [{ productId: unavailable.id, quantity: 1 }],
      type: 'TAKEOUT',
      paymentMethod: 'CREDIT_CARD',
      paymentId: payment.id,
    });
    await expectStatus(res, 201);
    const order = await res.json();
    expect(order.id).toBe(payment.orderId);
    expect(order.payment_status).toBe('PAID');
    expectMoney(order.total_price, 40, 'total');
  });
});
