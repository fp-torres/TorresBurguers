import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  Cleanup,
  addProduct,
  bearer,
  cardBody,
  createStore,
  defaultSession,
  expectError,
  expectStatus,
  getJson,
  newApi,
  newCustomer,
  retireStore,
  storePath,
  withTestDb,
  type Json,
  type Member,
  type Session,
  type TenantStore,
} from '../tenancy/helpers';

/**
 * Pedido mínimo e frete grátis acima de um valor (JSON de entrega da loja, docs/saas/arquitetura.md §11.2):
 * - o orçamento NÃO falha abaixo do mínimo: traz min_order_value / missing_for_min_order e os campos do frete
 *   grátis (delivery_fee já zerada, delivery_fee_original, free_delivery_applied, free_delivery_threshold,
 *   missing_for_free_delivery);
 * - o pedido pago na entrega, o PIX e o cartão recusam abaixo do mínimo com 400 ORDER_BELOW_MINIMUM (nada é
 *   criado nem cobrado); no limite exato passa;
 * - frete grátis zera a taxa no pedido e no valor do PIX (e no pedido criado pela aprovação);
 * - cada zona pode sobrescrever os valores da loja; fora das zonas valem os da loja;
 * - retirada: o mínimo só com "min_order_takeout"; nunca há frete grátis;
 * - loja sem nada configurado: os mesmos valores de antes (campos novos nulos).
 * Os bairros vêm do que o cliente digitou (CEPs fora de qualquer mapa de CEP falso → conferência MANUAL).
 */

const ZONES = {
  zones: [
    { neighborhoods: ['Centro'], fee: 5, time: '20-30 min' },
    { neighborhoods: ['Copacabana'], fee: 9, time: '40-50 min', min_order: 40, free_delivery_above: 80 },
  ],
  fallback: { fee: 12, time: '60-70 min' },
  min_order: 30,
  free_delivery_above: 50,
};

/** CEPs que nenhum mapa de CEP falso conhece (vale o bairro digitado). */
const CEPS = { centro: '27990-101', copacabana: '27990-102', outside: '27990-103' } as const;

let api: APIRequestContext;
let superadmin: Session;
let store: TenantStore;
let customer: Member;
/** R$ 20,00 · R$ 10,00 · R$ 30,00 em promoção por R$ 25,90. */
let p20: Json;
let p10: Json;
let promo: Json;
const address: Record<keyof typeof CEPS, Json> = {} as Record<keyof typeof CEPS, Json>;
const cleanup = new Cleanup();

async function setZones(zones: Record<string, unknown> | null): Promise<Json> {
  const res = await api.patch('/store/settings', {
    headers: bearer(store.owner.token),
    data: { delivery_enabled: true, takeout_enabled: true, delivery_zones: zones },
  });
  return expectStatus(res, 200, 'PATCH /store/settings (zonas e regras)');
}

type Line = [Json, number];
const items = (lines: Line[]) => lines.map(([product, quantity]) => ({ productId: product.id as number, quantity }));
const deliveryTo = (where: keyof typeof CEPS, lines: Line[]) => ({ items: items(lines), type: 'DELIVERY' as const, addressId: address[where].id as number });
const pickup = (lines: Line[]) => ({ items: items(lines), type: 'TAKEOUT' as const });

const post = (path: string, data: Record<string, unknown>) =>
  api.post(storePath(store.slug, path), { headers: bearer(customer.token), data });
const quote = (order: Record<string, unknown>) => post('/orders/quote', order);
const placeOrder = (order: Record<string, unknown>) => post('/orders', { ...order, paymentMethod: 'MONEY' });

async function expectBelowMinimum(res: Awaited<ReturnType<typeof post>>, message: string, label: string): Promise<Json> {
  const payload = await expectError(res, 400, message, label);
  expect(payload.code, `${label}: code`).toBe('ORDER_BELOW_MINIMUM');
  return payload;
}

async function countRows(table: 'orders' | 'payments'): Promise<number> {
  const result = await withTestDb((db) =>
    db.query<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "${table}" WHERE "store_id" = $1 AND "user_id" = $2`, [
      store.id,
      customer.user.id,
    ]),
  );
  return result.rows[0].count;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  api = await newApi();
  superadmin = await defaultSession(api, 'superadmin');
  store = await createStore(api, superadmin, 'Regras', { delivery: false });
  cleanup.add('desativar a loja das regras de valor', () => retireStore(api, superadmin, store));
  p20 = await addProduct(api, store.owner, { price: 20 });
  p10 = await addProduct(api, store.owner, { price: 10 });
  promo = await addProduct(api, store.owner, { price: 30, promotion_price: 25.9 });
  customer = await newCustomer(api, 'Regras');
  const neighborhoods: Record<keyof typeof CEPS, string> = { centro: 'Centro', copacabana: 'Copacabana', outside: 'Bairro Sem Zona' };
  for (const key of Object.keys(CEPS) as (keyof typeof CEPS)[]) {
    const res = await api.post('/addresses', {
      headers: bearer(customer.token),
      data: { zipCode: CEPS[key], street: 'Rua das Regras', number: '10', neighborhood: neighborhoods[key], city: 'Rio de Janeiro', state: 'RJ' },
    });
    address[key] = await expectStatus(res, 201, `endereço ${key}`);
  }
});

test.afterAll(async () => {
  await cleanup.run();
  await api.dispose();
});

test('loja sem regras: orçamento e pedido como antes (campos novos nulos)', async () => {
  const { min_order: _m, free_delivery_above: _f, ...plain } = ZONES;
  void _m;
  void _f;
  await setZones({ ...plain, zones: [ZONES.zones[0]] });
  const q = await expectStatus(await quote(deliveryTo('centro', [[p20, 1]])), 200, 'orçamento sem regras');
  expect(q).toMatchObject({
    subtotal: 20,
    delivery_fee: 5,
    total: 25,
    delivery_fee_original: 5,
    free_delivery_applied: false,
    free_delivery_threshold: null,
    missing_for_free_delivery: null,
    min_order_value: null,
    missing_for_min_order: null,
  });
  const order = await expectStatus(await placeOrder(deliveryTo('centro', [[p20, 1]])), 201, 'pedido sem regras');
  expect(Number(order.delivery_fee)).toBe(5);
  expect(Number(order.total_price)).toBe(25);
  expect((await getJson(api, `/stores/${store.slug}`)).order_rules).toEqual({
    min_order: null,
    min_order_takeout: false,
    free_delivery_above: null,
    varies_by_zone: false,
  });
});

test('PATCH /store/settings guarda as regras (normalizadas) e o perfil público as anuncia', async () => {
  const saved = await setZones({ ...ZONES, min_order_takeout: false });
  expect(saved.delivery_zones).toEqual({
    zones: [
      { neighborhoods: ['Centro'], fee: 5, time: '20-30 min' },
      { neighborhoods: ['Copacabana'], fee: 9, time: '40-50 min', min_order: 40, free_delivery_above: 80 },
    ],
    fallback: { fee: 12, time: '60-70 min' },
    min_order: 30,
    free_delivery_above: 50,
  });
  expect((await getJson(api, '/store/settings', store.owner.token)).delivery_zones).toEqual(saved.delivery_zones);
  expect((await getJson(api, `/stores/${store.slug}`)).order_rules).toEqual({
    min_order: 30,
    min_order_takeout: false,
    free_delivery_above: 50,
    varies_by_zone: true,
  });
});

test('PATCH com pedido mínimo ou frete grátis inválido → 400 claro (nada muda)', async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ ...ZONES, min_order: -1 }, /^Zonas de entrega inválidas: "min_order" da loja precisa ser um valor em reais de 0 a 99999999\.99/],
    [{ ...ZONES, free_delivery_above: '50' }, /^Zonas de entrega inválidas: "free_delivery_above" da loja/],
    [{ ...ZONES, min_order_takeout: 'sim' }, /^Zonas de entrega inválidas: "min_order_takeout" deve ser true/],
    [{ ...ZONES, zones: [{ ...ZONES.zones[0], min_order: 100_000_000 }] }, /^Zonas de entrega inválidas: "min_order" da zona 1/],
  ];
  for (const [zones, message] of cases) {
    const res = await api.patch('/store/settings', { headers: bearer(store.owner.token), data: { delivery_zones: zones } });
    await expectError(res, 400, message, String(message));
  }
  expect((await getJson(api, '/store/settings', store.owner.token)).delivery_zones).toMatchObject({ min_order: 30, free_delivery_above: 50 });
});

test('orçamento abaixo do mínimo NÃO falha: traz o mínimo, quanto falta e o frete grátis', async () => {
  const q = await expectStatus(await quote(deliveryTo('centro', [[p20, 1]])), 200, 'orçamento abaixo do mínimo');
  expect(q).toMatchObject({
    subtotal: 20,
    delivery_fee: 5,
    delivery_fee_original: 5,
    total: 25,
    free_delivery_applied: false,
    free_delivery_threshold: 50,
    missing_for_free_delivery: 30,
    min_order_value: 30,
    missing_for_min_order: 10,
  });
  // Promoção conta pelo preço cobrado (R$ 25,90)
  expect(await expectStatus(await quote(deliveryTo('centro', [[promo, 1]])), 200, 'orçamento com promoção')).toMatchObject({
    subtotal: 25.9,
    missing_for_min_order: 4.1,
    missing_for_free_delivery: 24.1,
  });
});

test('pedido, PIX e cartão abaixo do mínimo → 400 ORDER_BELOW_MINIMUM, sem pedido nem cobrança', async () => {
  const before = { orders: await countRows('orders'), payments: await countRows('payments') };
  const order = deliveryTo('centro', [[promo, 1]]);
  const message = 'O pedido mínimo desta loja para entrega é R$ 30,00. Faltam R$ 4,10.';
  const body = await expectBelowMinimum(await placeOrder(order), message, 'pedido pago na entrega');
  expect(body).toMatchObject({ statusCode: 400, error: 'Bad Request', min_order_value: 30, missing_for_min_order: 4.1 });
  await expectBelowMinimum(await post('/payment/pix', { order }), message, 'PIX');
  await expectBelowMinimum(await post('/payment/card', cardBody(order)), message, 'cartão');
  expect({ orders: await countRows('orders'), payments: await countRows('payments') }, 'nada criado nem cobrado').toEqual(before);
});

test('no limite exato (R$ 30,00) o pedido passa', async () => {
  const order = await expectStatus(await placeOrder(deliveryTo('centro', [[p20, 1], [p10, 1]])), 201, 'pedido no limite');
  expect(Number(order.delivery_fee)).toBe(5);
  expect(Number(order.total_price)).toBe(35);
});

test('frete grátis (R$ 50,00 exatos) zera a taxa no orçamento, no pedido e no PIX', async () => {
  const cart = deliveryTo('centro', [[p20, 2], [p10, 1]]);
  expect(await expectStatus(await quote(cart), 200, 'orçamento com frete grátis')).toMatchObject({
    subtotal: 50,
    delivery_fee: 0,
    delivery_fee_original: 5,
    total: 50,
    free_delivery_applied: true,
    free_delivery_threshold: 50,
    missing_for_free_delivery: 0,
    min_order_value: 30,
    missing_for_min_order: 0,
  });
  const order = await expectStatus(await placeOrder(cart), 201, 'pedido com frete grátis');
  expect(Number(order.delivery_fee)).toBe(0);
  expect(Number(order.total_price)).toBe(50);

  const pix = await expectStatus(await post('/payment/pix', { order: cart }), 201, 'PIX com frete grátis');
  expect(Number(pix.amount), 'PIX cobra só os produtos').toBe(50);
  // O pedido criado pela aprovação do PIX (sandbox) também sai sem taxa
  await expect
    .poll(async () => (await getJson(api, `/payment/status/${pix.id}`, customer.token)).orderId ?? null, {
      timeout: 25_000,
      intervals: [500, 1000],
      message: 'PIX aprovado no sandbox e pedido criado',
    })
    .not.toBeNull();
  const status = await getJson(api, `/payment/status/${pix.id}`, customer.token);
  const mine = (await getJson(api, `/stores/${store.slug}/orders/my-orders`, customer.token)) as Json[];
  const fromPix = mine.find((item) => item.id === status.orderId);
  expect(fromPix, 'pedido do PIX').toBeTruthy();
  expect(Number(fromPix?.delivery_fee)).toBe(0);
  expect(Number(fromPix?.total_price)).toBe(50);
});

test('a zona sobrescreve a loja; fora das zonas valem os da loja', async () => {
  // Copacabana: mínimo R$ 40,00 e frete grátis a partir de R$ 80,00
  expect(await expectStatus(await quote(deliveryTo('copacabana', [[p20, 2]])), 200, 'orçamento Copacabana')).toMatchObject({
    subtotal: 40,
    delivery_fee: 9,
    total: 49,
    min_order_value: 40,
    missing_for_min_order: 0,
    free_delivery_threshold: 80,
    missing_for_free_delivery: 40,
  });
  await expectBelowMinimum(
    await placeOrder(deliveryTo('copacabana', [[p20, 1], [p10, 1]])),
    'O pedido mínimo desta loja para entrega é R$ 40,00. Faltam R$ 10,00.',
    'Copacabana abaixo do mínimo da zona',
  );
  // R$ 50,00 em Copacabana não tem frete grátis (o da zona é R$ 80,00)
  expect(await expectStatus(await quote(deliveryTo('copacabana', [[p20, 2], [p10, 1]])), 200, 'Copacabana R$ 50')).toMatchObject({
    delivery_fee: 9,
    free_delivery_applied: false,
  });
  // Fora das zonas (taxa padrão R$ 12,00): mínimo R$ 30,00 e frete grátis R$ 50,00 da loja
  expect(await expectStatus(await quote(deliveryTo('outside', [[p20, 1]])), 200, 'fora das zonas')).toMatchObject({
    delivery_fee: 12,
    min_order_value: 30,
    missing_for_min_order: 10,
    free_delivery_threshold: 50,
  });
  expect(await expectStatus(await quote(deliveryTo('outside', [[p20, 2], [p10, 1]])), 200, 'fora das zonas, R$ 50')).toMatchObject({
    delivery_fee: 0,
    delivery_fee_original: 12,
    total: 50,
  });
});

test('retirada: sem mínimo por padrão; com min_order_takeout, recusa abaixo; nunca frete grátis', async () => {
  expect(await expectStatus(await quote(pickup([[p20, 1]])), 200, 'retirada sem mínimo')).toMatchObject({
    delivery_fee: 0,
    total: 20,
    min_order_value: null,
    missing_for_min_order: null,
    free_delivery_threshold: null,
    missing_for_free_delivery: null,
  });
  await expectStatus(await placeOrder(pickup([[p20, 1]])), 201, 'retirada abaixo do mínimo da entrega');

  await setZones({ ...ZONES, min_order_takeout: true });
  expect((await getJson(api, `/stores/${store.slug}`)).order_rules).toMatchObject({ min_order: 30, min_order_takeout: true });
  expect(await expectStatus(await quote(pickup([[p20, 1]])), 200, 'retirada com mínimo')).toMatchObject({
    total: 20,
    min_order_value: 30,
    missing_for_min_order: 10,
    free_delivery_threshold: null,
  });
  await expectBelowMinimum(
    await placeOrder(pickup([[p20, 1]])),
    'O pedido mínimo desta loja para retirada é R$ 30,00. Faltam R$ 10,00.',
    'retirada abaixo do mínimo',
  );
  await expectStatus(await placeOrder(pickup([[p20, 1], [p10, 1]])), 201, 'retirada no limite');
});
