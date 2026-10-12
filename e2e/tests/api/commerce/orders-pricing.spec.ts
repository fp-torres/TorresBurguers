import { test, expect, type APIRequestContext } from '@playwright/test';
import { uid } from '../../../support/api';
import {
  Actors,
  OUT_OF_RANGE_ID,
  UNKNOWN_ID,
  cardBody,
  createAddon,
  createAddress,
  createProduct,
  deleteAddon,
  expectMoney,
  expectNestError,
  expectNoPasswordFields,
  expectStatus,
  getOrder,
  myOrders,
  placeOrder,
  postCommerce,
  quote,
  softDeleteProduct,
  tryOrder,
  type Actor,
  type Json,
  type QuoteInput,
} from './helpers';

test.describe('Pedidos: orçamento, validações e retrato de preços', () => {
  const actors = new Actors();
  let anon: APIRequestContext;
  let admin: Actor;
  let employee: Actor;
  let kitchen: Actor;
  let courier: Actor;
  let client: Actor;
  let other: Actor;

  // Adicionais
  let addA: Json; // 3,50
  let addB: Json; // 2,25
  let addOff: Json; // indisponível
  let addDel: Json; // na lixeira
  let addCent: Json; // 0,10

  // Produtos
  let burger: Json; // 30,00 com promoção 25,00; permite A e B
  let fries: Json; // 12,90 sem promoção; sem lista de adicionais (aceita qualquer um)
  let restricted: Json; // 20,00; permite só A
  let unavailable: Json;
  let trashed: Json;
  let cents: Json; // 19,99

  let centro: Json;
  let otherAddress: Json;

  test.beforeAll(async () => {
    anon = await actors.anon();
    admin = await actors.defaultUser('admin');
    employee = await actors.defaultUser('employee');
    kitchen = await actors.defaultUser('kitchen');
    courier = await actors.defaultUser('courier');
    client = await actors.newClient('Cliente Orcamento');
    other = await actors.newClient('Outro Cliente');

    addA = await createAddon(admin.ctx, { name: `Bacon ${uid('a')}`, price: 3.5 });
    addB = await createAddon(admin.ctx, { name: `Cheddar ${uid('b')}`, price: 2.25 });
    addOff = await createAddon(admin.ctx, { name: `Pausado ${uid('off')}`, price: 1, available: false });
    addDel = await createAddon(admin.ctx, { name: `Excluido ${uid('del')}`, price: 1 });
    await deleteAddon(admin.ctx, addDel.id);
    addCent = await createAddon(admin.ctx, { name: `Sache ${uid('cent')}`, price: 0.1 });

    burger = await createProduct(admin.ctx, {
      name: `Burger Promo ${uid('bp')}`,
      price: 30,
      promotion_price: 25,
      allowed_addons_ids: [addA.id, addB.id],
    });
    fries = await createProduct(admin.ctx, { name: `Fritas ${uid('fr')}`, price: 12.9, category: 'acompanhamentos' });
    restricted = await createProduct(admin.ctx, {
      name: `Restrito ${uid('rs')}`,
      price: 20,
      allowed_addons_ids: [addA.id],
    });
    unavailable = await createProduct(admin.ctx, { name: `Esgotado ${uid('un')}`, price: 10, available: false });
    trashed = await createProduct(admin.ctx, { name: `Lixeira ${uid('tr')}`, price: 10 });
    await softDeleteProduct(admin.ctx, trashed.id);
    cents = await createProduct(admin.ctx, { name: `Centavos ${uid('ct')}`, price: 19.99, category: 'bebidas' });

    centro = await createAddress(client.ctx, 'Centro');
    otherAddress = await createAddress(other.ctx, 'Centro');
  });

  test.afterAll(async () => {
    await actors.dispose();
  });

  const takeout = (items: QuoteInput['items']): QuoteInput => ({ items, type: 'TAKEOUT' });

  // -------------------------------------------------------------------------
  // Orçamento (POST /orders/quote)
  // -------------------------------------------------------------------------

  test('orçamento usa o preço promocional quando é menor que o preço cheio', async () => {
    const q = await quote(client.ctx, takeout([{ productId: burger.id, quantity: 2 }]));
    expect(q.items).toEqual([
      { productId: burger.id, name: burger.name, quantity: 2, unitPrice: 25, addonsTotal: 0, lineTotal: 50 },
    ]);
    expect(q).toMatchObject({ subtotal: 50, delivery_fee: 0, total: 50, store_open: true });
    expect(typeof q.estimated_delivery_time).toBe('string');
  });

  test('orçamento usa o preço cheio em produto sem promoção', async () => {
    const q = await quote(client.ctx, takeout([{ productId: fries.id, quantity: 3 }]));
    expect(q.items[0]).toMatchObject({ productId: fries.id, unitPrice: 12.9, addonsTotal: 0, lineTotal: 38.7 });
    expect(q).toMatchObject({ subtotal: 38.7, delivery_fee: 0, total: 38.7 });
  });

  test('ids repetidos em addonIds indicam a quantidade do adicional', async () => {
    const q = await quote(
      client.ctx,
      takeout([{ productId: burger.id, quantity: 2, addonIds: [addA.id, addA.id, addB.id] }]),
    );
    // Por unidade: 2 x 3,50 + 1 x 2,25 = 9,25; linha: (25 + 9,25) x 2 = 68,50
    expect(q.items[0]).toMatchObject({ unitPrice: 25, addonsTotal: 9.25, lineTotal: 68.5 });
    expect(q).toMatchObject({ subtotal: 68.5, total: 68.5 });
  });

  test('taxa de entrega e tempo estimado seguem o bairro do endereço (sem acento e sem diferenciar caixa)', async () => {
    const zones = [
      { neighborhood: 'Centro', fee: 5, time: '30-40 min' },
      { neighborhood: 'Botafogo', fee: 7, time: '40-50 min' },
      { neighborhood: 'Copacabana', fee: 10, time: '50-60 min' },
      { neighborhood: 'Barra da Tijuca', fee: 20, time: '60-80 min' },
      { neighborhood: 'Tijuca', fee: 12, time: '50-60 min' },
      { neighborhood: '  MARACANÃ ', fee: 12, time: '50-60 min' },
      { neighborhood: 'Bangu', fee: 15, time: '50-60 min' },
    ];
    for (const zone of zones) {
      const address = await createAddress(client.ctx, zone.neighborhood);
      const q = await quote(client.ctx, {
        items: [{ productId: fries.id, quantity: 1 }],
        type: 'DELIVERY',
        addressId: address.id,
      });
      expect(q.delivery_fee, `taxa para ${zone.neighborhood}`).toBe(zone.fee);
      expect(q.estimated_delivery_time, `tempo para ${zone.neighborhood}`).toBe(zone.time);
      expectMoney(q.subtotal, 12.9, 'subtotal');
      expectMoney(q.total, 12.9 + zone.fee, `total para ${zone.neighborhood}`);
    }
  });

  test('retirada (TAKEOUT) não cobra taxa de entrega, mesmo com addressId', async () => {
    const copacabana = await createAddress(client.ctx, 'Copacabana');
    const q = await quote(client.ctx, {
      items: [{ productId: fries.id, quantity: 2 }],
      type: 'TAKEOUT',
      addressId: copacabana.id,
    });
    expect(q).toMatchObject({ subtotal: 25.8, delivery_fee: 0, total: 25.8 });
  });

  test('contas em centavos: sem erro de ponto flutuante no orçamento', async () => {
    const q = await quote(client.ctx, {
      items: [{ productId: cents.id, quantity: 3, addonIds: [addCent.id] }],
      type: 'DELIVERY',
      addressId: centro.id,
    });
    // (19,99 + 0,10) x 3 = 60,27 (em ponto flutuante daria 60.269999999999996)
    expect(q.items[0]).toMatchObject({ unitPrice: 19.99, addonsTotal: 0.1, lineTotal: 60.27 });
    expect(q.subtotal).toBe(60.27);
    expect(q.delivery_fee).toBe(5);
    expect(q.total).toBe(65.27);
  });

  test('orçamento e pedido criado têm exatamente os mesmos valores', async () => {
    const copacabana = await createAddress(client.ctx, 'Copacabana');
    const input: QuoteInput = {
      items: [
        { productId: burger.id, quantity: 1, addonIds: [addB.id, addB.id] },
        { productId: fries.id, quantity: 2, addonIds: [addCent.id] },
      ],
      type: 'DELIVERY',
      addressId: copacabana.id,
    };
    const q = await quote(client.ctx, input);
    const order = await placeOrder(client.ctx, { ...input, paymentMethod: 'MONEY' });

    expectMoney(order.total_price, q.total, 'total_price');
    expectMoney(order.delivery_fee, q.delivery_fee, 'delivery_fee');
    expect(order.estimated_delivery_time).toBe(q.estimated_delivery_time);
    expect(order.items.map((i: Json) => Number(i.unit_price))).toEqual(q.items.map((i: Json) => i.unitPrice));
    // (25 + 4,50) + (12,90 + 0,10) x 2 = 29,50 + 26,00 = 55,50 + taxa 10 = 65,50
    expect(q.total).toBe(65.5);
  });

  test('quantidade 50 por item é aceita e 51 é recusada', async () => {
    const q = await quote(client.ctx, takeout([{ productId: burger.id, quantity: 50 }]));
    expect(q.items[0].lineTotal).toBe(1250);
    await expectNestError(
      await postCommerce(client.ctx, '/orders/quote', takeout([{ productId: burger.id, quantity: 51 }])),
      400,
    );
  });

  test('orçamento aplica as mesmas validações do pedido', async () => {
    const post = (data: unknown) => postCommerce(client.ctx, '/orders/quote', data);
    await expectNestError(await post(takeout([])), 400);
    await expectNestError(await post(takeout([{ productId: UNKNOWN_ID, quantity: 1 }])), 400, `#${UNKNOWN_ID}`);
    await expectNestError(await post(takeout([{ productId: unavailable.id, quantity: 1 }])), 400, unavailable.name);
    await expectNestError(await post(takeout([{ productId: trashed.id, quantity: 1 }])), 400, trashed.name);
    await expectNestError(await post(takeout([{ productId: restricted.id, quantity: 1, addonIds: [addB.id] }])), 400);
    await expectNestError(await post(takeout([{ productId: fries.id, quantity: 0 }])), 400);
    await expectNestError(await post({ items: [{ productId: fries.id, quantity: 1 }], type: 'DELIVERY' }), 400);
    await expectNestError(
      await post({ items: [{ productId: fries.id, quantity: 1 }], type: 'DELIVERY', addressId: otherAddress.id }),
      404,
    );
  });

  test('preço promocional 0 significa "sem promoção": é salvo como null e o orçamento cobra o preço cheio', async () => {
    // Contrato v2: promotion_price <= 0 (ou vazio) = sem promoção. A vitrine usa a mesma regra (0 < promo < preço).
    const res = await admin.ctx.post('/products', {
      data: { name: `Promo Zero ${uid('z')}`, price: 10, promotion_price: 0, category: 'bebidas' },
    });
    expect(res.status(), `POST /products → ${res.status()} ${await res.text()}`).toBe(201);
    const product = await res.json();
    expect(product.promotion_price ?? null, 'promoção 0 é guardada como "sem promoção"').toBeNull();

    const q = await quote(client.ctx, takeout([{ productId: product.id, quantity: 1 }]));
    expect(q.items[0].unitPrice, 'sem promoção, vale o preço cheio').toBe(10);
    expect(q.total).toBe(10);
  });

  test('total acima do limite suportado nunca gera 500 nem cobrança de pedido que não pode ser salvo', async () => {
    const huge = await createProduct(admin.ctx, { name: `Gigante ${uid('g')}`, price: 999_999.99, category: 'combos' });
    const order = takeout([1, 2, 3].map(() => ({ productId: huge.id, quantity: 50 })));
    const expectedTotal = 149_999_998.5; // 3 x 50 x 999.999,99

    const created = await tryOrder(client.ctx, { ...order, paymentMethod: 'MONEY' });
    expect([201, 400], `POST /orders → ${created.status()} ${await created.text()}`).toContain(created.status());
    if (created.status() === 201) {
      // Aceito: o total precisa ser guardado sem perda
      const saved = await created.json();
      expect(saved.total_price).toBe(expectedTotal);
      await expectStatus(await client.ctx.patch(`/orders/${saved.id}/cancel`), 200);
      return;
    }
    // Recusado: o orçamento e os pagamentos recusam igual, ANTES de cobrar
    await expectNestError(await postCommerce(client.ctx, '/orders/quote', order), 400);
    await expectNestError(await postCommerce(client.ctx, '/payment/card', cardBody(order)), 400);
    await expectNestError(await postCommerce(client.ctx, '/payment/pix', { order }), 400);
  });

  test('ids fora do intervalo de inteiro no corpo do pedido respondem 400/404 (nunca 500)', async () => {
    const bodies: [string, Record<string, unknown>][] = [
      ['productId', takeout([{ productId: OUT_OF_RANGE_ID, quantity: 1 }]) as never],
      ['addonIds', takeout([{ productId: fries.id, quantity: 1, addonIds: [OUT_OF_RANGE_ID] }]) as never],
      ['addressId', { items: [{ productId: fries.id, quantity: 1 }], type: 'DELIVERY', addressId: OUT_OF_RANGE_ID }],
    ];
    for (const [field, order] of bodies) {
      const calls: [string, unknown][] = [
        ['/orders/quote', order],
        ['/orders', { ...order, paymentMethod: 'MONEY' }],
        ['/payment/card', cardBody(order)],
        ['/payment/pix', { order }],
      ];
      for (const [path, data] of calls) {
        const res = await postCommerce(client.ctx, path, data);
        expect
          .soft([400, 404], `${path} com ${field} = ${OUT_OF_RANGE_ID} → ${res.status()} ${await res.text()}`)
          .toContain(res.status());
      }
    }
  });

  test('orçamento recusa campos fora do contrato (400)', async () => {
    const base = takeout([{ productId: fries.id, quantity: 1 }]);
    await expectNestError(await postCommerce(client.ctx, '/orders/quote', { ...base, paymentMethod: 'MONEY' }), 400);
    await expectNestError(await postCommerce(client.ctx, '/orders/quote', { ...base, total: 1 }), 400);
    await expectNestError(
      await postCommerce(client.ctx, '/orders/quote', takeout([{ productId: fries.id, quantity: 1, price: 0.01 } as never])),
      400,
    );
  });

  test('orçamento é exclusivo de clientes: anônimo 401 e equipe 403', async () => {
    const body = takeout([{ productId: fries.id, quantity: 1 }]);
    await expectStatus(await anon.post('/orders/quote', { data: body }), 401);
    for (const actor of [admin, employee, kitchen, courier]) {
      await expectNestError(await actor.ctx.post('/orders/quote', { data: body }), 403);
    }
  });

  // -------------------------------------------------------------------------
  // Criação: validações
  // -------------------------------------------------------------------------

  test('pedido sem itens é recusado (400)', async () => {
    await expectNestError(await tryOrder(client.ctx, { items: [], type: 'TAKEOUT', paymentMethod: 'MONEY' }), 400);
    await expectNestError(await tryOrder(client.ctx, { type: 'TAKEOUT', paymentMethod: 'MONEY' }), 400);
  });

  test('produto inexistente é recusado com 400 citando o produto', async () => {
    const res = await tryOrder(client.ctx, {
      items: [{ productId: UNKNOWN_ID, quantity: 1 }],
      type: 'TAKEOUT',
      paymentMethod: 'MONEY',
    });
    await expectNestError(res, 400, `#${UNKNOWN_ID}`);
  });

  test('produto indisponível é recusado com 400 citando o nome', async () => {
    const res = await tryOrder(client.ctx, {
      items: [{ productId: unavailable.id, quantity: 1 }],
      type: 'TAKEOUT',
      paymentMethod: 'MONEY',
    });
    await expectNestError(res, 400, unavailable.name);
  });

  test('produto na lixeira é recusado com 400 citando o nome', async () => {
    const res = await tryOrder(client.ctx, {
      items: [
        { productId: fries.id, quantity: 1 },
        { productId: trashed.id, quantity: 1 },
      ],
      type: 'TAKEOUT',
      paymentMethod: 'MONEY',
    });
    await expectNestError(res, 400, trashed.name);
  });

  test('adicional fora da lista permitida do produto é recusado (400)', async () => {
    const res = await tryOrder(client.ctx, {
      items: [{ productId: restricted.id, quantity: 1, addonIds: [addA.id, addB.id] }],
      type: 'TAKEOUT',
      paymentMethod: 'MONEY',
    });
    await expectNestError(res, 400, addB.name);
  });

  test('adicional indisponível, excluído ou inexistente é recusado (400)', async () => {
    for (const addonId of [addOff.id, addDel.id, UNKNOWN_ID]) {
      const res = await tryOrder(client.ctx, {
        items: [{ productId: fries.id, quantity: 1, addonIds: [addonId] }],
        type: 'TAKEOUT',
        paymentMethod: 'MONEY',
      });
      await expectNestError(res, 400);
    }
  });

  test('produto sem lista de adicionais permitidos aceita adicionais disponíveis', async () => {
    const q = await quote(client.ctx, takeout([{ productId: fries.id, quantity: 1, addonIds: [addA.id] }]));
    expect(q.items[0]).toMatchObject({ addonsTotal: 3.5, lineTotal: 16.4 });
  });

  test('quantidade 0, 51, negativa ou fracionada é recusada (400)', async () => {
    for (const quantity of [0, 51, -1, 1.5]) {
      const res = await tryOrder(client.ctx, {
        items: [{ productId: fries.id, quantity }],
        type: 'TAKEOUT',
        paymentMethod: 'MONEY',
      });
      await expectNestError(res, 400);
    }
  });

  test('delivery sem endereço é recusado (400)', async () => {
    const res = await tryOrder(client.ctx, {
      items: [{ productId: fries.id, quantity: 1 }],
      type: 'DELIVERY',
      paymentMethod: 'MONEY',
    });
    await expectNestError(res, 400);
  });

  test('endereço de outro cliente responde 404 e nada é salvo', async () => {
    const before = (await myOrders(client.ctx)).length;
    const res = await tryOrder(client.ctx, {
      items: [{ productId: fries.id, quantity: 1 }],
      type: 'DELIVERY',
      addressId: otherAddress.id,
      paymentMethod: 'MONEY',
    });
    await expectNestError(res, 404);
    expect((await myOrders(client.ctx)).length).toBe(before);
  });

  test('endereço excluído pelo cliente não recebe novos pedidos (404)', async () => {
    const address = await createAddress(client.ctx, 'Lapa');
    await expectStatus(await client.ctx.delete(`/addresses/${address.id}`), 200);
    const res = await tryOrder(client.ctx, {
      items: [{ productId: fries.id, quantity: 1 }],
      type: 'DELIVERY',
      addressId: address.id,
      paymentMethod: 'MONEY',
    });
    await expectNestError(res, 404);
  });

  test('retirada ignora addressId e não vincula endereço de outro cliente', async () => {
    const order = await placeOrder(client.ctx, {
      items: [{ productId: fries.id, quantity: 1 }],
      type: 'TAKEOUT',
      addressId: otherAddress.id,
      paymentMethod: 'MONEY',
    });
    expect(order.address).toBeNull();
    expect(order.delivery_fee).toBe(0);
    expectMoney(order.total_price, 12.9, 'total sem taxa');
  });

  test('equipe não faz pedidos (403 para ADMIN, EMPLOYEE, KITCHEN e COURIER)', async () => {
    const data = { items: [{ productId: fries.id, quantity: 1 }], type: 'TAKEOUT', paymentMethod: 'MONEY' };
    for (const actor of [admin, employee, kitchen, courier]) {
      await expectNestError(await actor.ctx.post('/orders', { data }), 403);
      const mine = await myOrders(actor.ctx);
      expect(mine.every((o) => o.user?.id === actor.id), `${actor.session.user.role} sem pedidos alheios`).toBe(true);
    }
  });

  test('anônimo não faz pedidos (401)', async () => {
    const data = { items: [{ productId: fries.id, quantity: 1 }], type: 'TAKEOUT', paymentMethod: 'MONEY' };
    await expectStatus(await anon.post('/orders', { data }), 401);
  });

  test('forma de pagamento e tipo de pedido inválidos são recusados (400)', async () => {
    const items = [{ productId: fries.id, quantity: 1 }];
    for (const paymentMethod of ['BITCOIN', 'DINHEIRO', 'CARTAO_CREDITO', '', undefined]) {
      await expectNestError(await tryOrder(client.ctx, { items, type: 'TAKEOUT', paymentMethod }), 400);
    }
    await expectNestError(await tryOrder(client.ctx, { items, type: 'DRONE', paymentMethod: 'MONEY' }), 400);
    await expectNestError(await tryOrder(client.ctx, { items, paymentMethod: 'MONEY' }), 400);
  });

  test('cliente não define total, status, pagamento ou preço dos itens (campos extras → 400)', async () => {
    const before = (await myOrders(client.ctx)).length;
    const base = { items: [{ productId: burger.id, quantity: 1 }], type: 'TAKEOUT', paymentMethod: 'MONEY' };
    const extras: Record<string, unknown>[] = [
      { total_price: 0.01 },
      { total: 0.01 },
      { status: 'DONE' },
      { payment_status: 'PAID' },
      { delivery_fee: 0 },
      { user: { id: other.id } },
    ];
    for (const extra of extras) await expectNestError(await tryOrder(client.ctx, { ...base, ...extra }), 400);
    for (const itemExtra of [{ price: 0.01 }, { unitPrice: 0.01 }, { unit_price: 0.01 }]) {
      const items = [{ productId: burger.id, quantity: 1, ...itemExtra }];
      await expectNestError(await tryOrder(client.ctx, { ...base, items }), 400);
    }
    expect((await myOrders(client.ctx)).length, 'nada foi salvo').toBe(before);
  });

  test('observação acima de 300 caracteres é recusada; com 300 é aceita', async () => {
    const q = await quote(client.ctx, takeout([{ productId: fries.id, quantity: 1, observation: 'a'.repeat(300) }]));
    expect(q.total).toBe(12.9);
    const res = await tryOrder(client.ctx, {
      items: [{ productId: fries.id, quantity: 1, observation: 'a'.repeat(301) }],
      type: 'TAKEOUT',
      paymentMethod: 'MONEY',
    });
    await expectNestError(res, 400);
  });

  // -------------------------------------------------------------------------
  // Criação: resposta
  // -------------------------------------------------------------------------

  test('pedido criado: PENDING, pagamento pendente, endereço, itens e retrato de preços', async () => {
    const botafogo = await createAddress(client.ctx, 'Botafogo');
    const input: QuoteInput = {
      items: [
        {
          productId: burger.id,
          quantity: 2,
          addonIds: [addA.id, addA.id, addB.id],
          observation: '  Sem cebola, por favor  ',
          meatPoint: 'Ao ponto',
          removedIngredients: ['Cebola', ' Picles '],
        },
        { productId: fries.id, quantity: 1 },
      ],
      type: 'DELIVERY',
      addressId: botafogo.id,
    };
    const q = await quote(client.ctx, input);
    // (25 + 9,25) x 2 + 12,90 = 81,40 + taxa 7 = 88,40
    expect(q).toMatchObject({ subtotal: 81.4, delivery_fee: 7, total: 88.4 });

    const order = await placeOrder(client.ctx, { ...input, paymentMethod: 'MONEY', changeFor: 'R$ 200,00' });
    expect(order).toMatchObject({
      status: 'PENDING',
      payment_status: 'PENDING',
      payment_method: 'MONEY',
      type: 'DELIVERY',
      payment_id: null,
      change_for: 'R$ 200,00',
      driver: null,
    });
    expect(order.total_price).toBe(88.4);
    expect(order.delivery_fee).toBe(7);
    expect(order.address?.id).toBe(botafogo.id);
    expect(order.user?.id).toBe(client.id);
    expectNoPasswordFields(order);

    expect(order.items).toHaveLength(2);
    const [line, plain] = order.items;
    expect(line.product?.id).toBe(burger.id);
    expect(line.quantity).toBe(2);
    expect(line.unit_price).toBe(25);
    expect(line.observation).toBe('Sem cebola, por favor');
    expect(line.meat_point).toBe('Ao ponto');
    expect(line.removed_ingredients).toEqual(['Cebola', 'Picles']);
    expect(line.addons_snapshot).toHaveLength(2);
    expect(line.addons_snapshot).toEqual(
      expect.arrayContaining([
        { id: addA.id, name: addA.name, price: 3.5, quantity: 2 },
        { id: addB.id, name: addB.name, price: 2.25, quantity: 1 },
      ]),
    );
    expect(plain.product?.id).toBe(fries.id);
    expect(plain.unit_price).toBe(12.9);
    expect(plain.addons_snapshot).toEqual([]);

    // O mesmo pedido lido de novo
    const reread = await getOrder(client.ctx, order.id);
    expect(reread.total_price).toBe(88.4);
    expect(reread.items[0].addons_snapshot).toEqual(line.addons_snapshot);
  });

  test('troco menor que o total é recusado e troco válido é guardado formatado', async () => {
    const items = [{ productId: burger.id, quantity: 1 }];
    await expectNestError(
      await tryOrder(client.ctx, { items, type: 'TAKEOUT', paymentMethod: 'MONEY', changeFor: 'R$ 10,00' }),
      400,
      /troco/i,
    );
    const withChange = await placeOrder(client.ctx, { items, type: 'TAKEOUT', paymentMethod: 'MONEY', changeFor: '50' });
    expect(withChange.change_for).toBe('R$ 50,00');
    const noChange = await placeOrder(client.ctx, {
      items,
      type: 'TAKEOUT',
      paymentMethod: 'MONEY',
      changeFor: 'Sem troco',
    });
    expect(noChange.change_for).toBeNull();
  });

  test('pagamento na entrega (maquininha ou PIX na entrega, sem paymentId) fica pendente e sem troco', async () => {
    for (const paymentMethod of ['CREDIT_CARD', 'DEBIT_CARD', 'PIX']) {
      const order = await placeOrder(client.ctx, {
        items: [{ productId: fries.id, quantity: 1 }],
        type: 'TAKEOUT',
        paymentMethod,
      });
      expect(order).toMatchObject({ payment_method: paymentMethod, payment_status: 'PENDING', payment_id: null, change_for: null });
    }
  });

  // -------------------------------------------------------------------------
  // Retrato de preços
  // -------------------------------------------------------------------------

  test('itens guardam o retrato do preço: mudar o cardápio depois não altera o pedido', async () => {
    const addon = await createAddon(admin.ctx, { name: `Molho ${uid('m')}`, price: 5 });
    const product = await createProduct(admin.ctx, {
      name: `Retrato ${uid('r')}`,
      price: 40,
      promotion_price: 35,
      allowed_addons_ids: [addon.id],
    });
    const input = takeout([{ productId: product.id, quantity: 2, addonIds: [addon.id, addon.id] }]);
    const order = await placeOrder(client.ctx, { ...input, paymentMethod: 'MONEY' });
    expect(order.total_price).toBe(90); // (35 + 2 x 5) x 2

    // O cardápio muda depois do pedido
    await expectStatus(
      await admin.ctx.patch(`/products/${product.id}`, { data: { price: 99, promotion_price: null } }),
      200,
    );
    await expectStatus(
      await admin.ctx.patch(`/addons/${addon.id}`, { data: { price: 9.99, name: `Molho novo ${uid('n')}` } }),
      200,
    );
    const newQuote = await quote(client.ctx, input);
    expect(newQuote.items[0]).toMatchObject({ unitPrice: 99, addonsTotal: 19.98, lineTotal: 237.96 });

    // O pedido antigo continua com os valores e nomes da época
    for (const view of [await getOrder(client.ctx, order.id), await getOrder(admin.ctx, order.id)]) {
      expect(view.total_price).toBe(90);
      expect(view.items[0].unit_price).toBe(35);
      expect(view.items[0].addons_snapshot).toEqual([{ id: addon.id, name: addon.name, price: 5, quantity: 2 }]);
      expect(view.items[0].addons).toEqual([
        { id: addon.id, name: addon.name, price: 5 },
        { id: addon.id, name: addon.name, price: 5 },
      ]);
    }
    const fromHistory = (await myOrders(client.ctx)).find((o) => o.id === order.id);
    expect(fromHistory?.total_price).toBe(90);
    expect(fromHistory?.items[0].unit_price).toBe(35);
  });

  test('pedido continua mostrando o produto depois que ele vai para a lixeira', async () => {
    const product = await createProduct(admin.ctx, { name: `Some ${uid('s')}`, price: 11 });
    const order = await placeOrder(client.ctx, {
      items: [{ productId: product.id, quantity: 1 }],
      type: 'TAKEOUT',
      paymentMethod: 'MONEY',
    });
    await softDeleteProduct(admin.ctx, product.id);

    const view = await getOrder(client.ctx, order.id);
    expect(view.items[0].product?.id).toBe(product.id);
    expect(view.items[0].product?.name).toBe(product.name);
    expect(view.items[0].unit_price).toBe(11);
    const fromHistory = (await myOrders(client.ctx)).find((o) => o.id === order.id);
    expect(fromHistory?.items[0].product?.name).toBe(product.name);
  });
});
