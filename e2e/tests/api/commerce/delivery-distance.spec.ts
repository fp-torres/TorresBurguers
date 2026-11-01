import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { GEO_CEPS, GEO_ORIGIN } from '../../../support/geocoding-fake';
import {
  Cleanup,
  addProduct,
  bearer,
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
 * Entrega por DISTÂNCIA em km (docs/saas/arquitetura.md §11.2):
 * - a loja escolhe o modo ("mode": "distance") com faixas "até X km" (taxa, prazo, pedido mínimo e frete grátis
 *   próprios), raio máximo com taxa por km adicional e fator de rota (linha reta × 1,3);
 * - o local da loja (latitude/longitude) é obrigatório no modo distância; o painel localiza a loja pelo endereço;
 * - o endereço do cliente é localizado pelo servidor (aqui, pelo mapa falso GEOCODING_FAKE de CEPs → coordenadas);
 * - além do raio ou sem coordenadas vale a política de fora da área (taxa padrão ou recusa 400 DELIVERY_OUT_OF_AREA);
 * - o orçamento ganha delivery_mode e distance_km; o perfil público, delivery_distance { max_km };
 * - o modo por zonas (padrão) não muda nada.
 */

const OUT_OF_AREA = 'Este endereço está fora da área de entrega da loja.';
const NOT_LOCATED = /^Não conseguimos localizar este endereço no mapa/;
const LOCATION_REQUIRED =
  'Para cobrar a entrega por distância, informe o local da loja no mapa (latitude e longitude) na seção Entrega.';
const SKIP_WITHOUT_FAKE =
  'API sem o modo de localização falso: suba-a com NODE_ENV=test e GEOCODING_FAKE (e2e/support/geocoding-fake.ts).';

const DISTANCE = {
  bands: [
    { up_to_km: 2, fee: 5, time: '25-35 min' },
    { up_to_km: 5, fee: 8, time: '35-45 min', min_order: 40 },
    { up_to_km: 8, fee: 12, time: '45-55 min', free_delivery_above: 30 },
  ],
};
const DISTANCE_ZONES = {
  zones: [{ neighborhoods: ['Bairro Guardado'], fee: 3, time: '15 min' }],
  fallback: { fee: 20, time: '70-80 min' },
  mode: 'distance',
  distance: DISTANCE,
};

let api: APIRequestContext;
let superadmin: Session;
let store: TenantStore;
let customer: Member;
let p20: Json;
let fakeGeo = false;
const address: Partial<Record<keyof typeof GEO_CEPS, Json>> = {};
const cleanup = new Cleanup();

async function patchSettings(data: Record<string, unknown>): Promise<APIResponse> {
  return api.patch('/store/settings', { headers: bearer(store.owner.token), data });
}

async function setDistance(zones: Record<string, unknown>): Promise<Json> {
  return expectStatus(
    await patchSettings({ delivery_enabled: true, latitude: GEO_ORIGIN.lat, longitude: GEO_ORIGIN.lng, delivery_zones: zones }),
    200,
    'PATCH /store/settings (modo distância)',
  );
}

const post = (path: string, data: Record<string, unknown>) =>
  api.post(storePath(store.slug, path), { headers: bearer(customer.token), data });
const deliveryTo = (where: keyof typeof GEO_CEPS, quantity = 1) => ({
  items: [{ productId: p20.id as number, quantity }],
  type: 'DELIVERY' as const,
  addressId: address[where]?.id as number,
});
const quote = (where: keyof typeof GEO_CEPS, quantity = 1) => post('/orders/quote', deliveryTo(where, quantity));

async function expectOutOfArea(res: APIResponse, message: string | RegExp, label: string): Promise<Json> {
  const payload = await expectError(res, 400, message, label);
  expect(payload.code, `${label}: code`).toBe('DELIVERY_OUT_OF_AREA');
  return payload;
}

async function geoColumns(id: number): Promise<Json> {
  const result = await withTestDb((db) =>
    db.query<Json>(`SELECT "geo_status", "geo_precision", "geo_source", "geo_latitude", "geo_checked_at" FROM "addresses" WHERE "id" = $1`, [id]),
  );
  return result.rows[0];
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  api = await newApi();
  superadmin = await defaultSession(api, 'superadmin');
  store = await createStore(api, superadmin, 'Distancia', { delivery: false });
  cleanup.add('desativar a loja de entrega por distância', () => retireStore(api, superadmin, store));
  p20 = await addProduct(api, store.owner, { price: 20 });
  customer = await newCustomer(api, 'Distancia');
  for (const key of ['km1', 'km3', 'km5', 'km10', 'unavailable', 'notFound'] as const) {
    const res = await api.post('/addresses', {
      headers: bearer(customer.token),
      data: { zipCode: GEO_CEPS[key], street: 'Rua da Distância', number: '10', neighborhood: 'Centro', city: 'Rio de Janeiro', state: 'RJ' },
    });
    address[key] = await expectStatus(res, 201, `endereço ${key}`);
  }
  // Modo de localização falso ativo? (o painel localiza o CEP da loja pelo mapa falso)
  const probe = await api.post('/store/settings/geocode', { headers: bearer(store.owner.token), data: { zip_code: GEO_CEPS.store } });
  fakeGeo = probe.status() === 200 && ((await probe.json()) as Json).latitude === GEO_ORIGIN.lat;
});

test.afterAll(async () => {
  await cleanup.run();
  await api.dispose();
});

test('painel: localizar a loja pelo endereço (só ADMIN; 404 e 502 claros; nada é gravado)', async () => {
  test.skip(!fakeGeo, SKIP_WITHOUT_FAKE);
  const geo = (data: Record<string, unknown>, token = store.owner.token) =>
    api.post('/store/settings/geocode', { headers: bearer(token), data });
  expect(await expectStatus(await geo({ zip_code: GEO_CEPS.store, street: 'Rua da Loja', number: '1' }), 200, 'localizar a loja')).toEqual({
    latitude: GEO_ORIGIN.lat,
    longitude: GEO_ORIGIN.lng,
    precision: 'ADDRESS',
    source: 'FAKE',
  });
  expect(await expectStatus(await geo({ zip_code: GEO_CEPS.zipCenter }), 200, 'centro do CEP')).toMatchObject({ precision: 'ZIP_CENTER' });
  await expectError(await geo({ zip_code: GEO_CEPS.notFound }), 404, /^Não encontramos este endereço no mapa/, 'não encontrado');
  await expectError(await geo({ zip_code: GEO_CEPS.unavailable }), 502, /^O serviço de mapas não respondeu agora/, 'fora do ar');
  await expectError(await geo({ zip_code: '123' }), 400, /CEP inválido/, 'CEP inválido');
  expect((await geo({ zip_code: GEO_CEPS.store }, customer.token)).status()).toBe(403);
  const settings = await getJson(api, '/store/settings', store.owner.token);
  expect(settings).toMatchObject({ latitude: null, longitude: null, road_distance_available: false });
});

test('PATCH: o modo distância exige o local da loja; com ele, grava a configuração normalizada e a vitrine mostra o raio', async () => {
  test.skip(!fakeGeo, SKIP_WITHOUT_FAKE);
  await expectError(
    await patchSettings({ delivery_enabled: true, delivery_zones: DISTANCE_ZONES }),
    400,
    LOCATION_REQUIRED,
    'sem local da loja',
  );
  await expectError(await patchSettings({ latitude: GEO_ORIGIN.lat }), 400, /latitude e a longitude da loja juntas/, 'só a latitude');
  await expectError(
    await patchSettings({ delivery_zones: { ...DISTANCE_ZONES, distance: { bands: [DISTANCE.bands[1], DISTANCE.bands[0]] } } }),
    400,
    /^Zonas de entrega inválidas: as faixas precisam estar em ordem crescente/,
    'faixas fora de ordem',
  );

  const saved = await setDistance(DISTANCE_ZONES);
  expect(saved).toMatchObject({ latitude: GEO_ORIGIN.lat, longitude: GEO_ORIGIN.lng });
  expect(saved.delivery_zones).toEqual({
    zones: DISTANCE_ZONES.zones,
    fallback: DISTANCE_ZONES.fallback,
    mode: 'distance',
    distance: { ...DISTANCE, route_factor: 1.3 },
  });
  const profile = await getJson(api, `/stores/${store.slug}`);
  expect(profile).toMatchObject({ delivery_enabled: true, delivers_outside_zones: true, delivery_distance: { max_km: 8 } });
  // As faixas têm mínimos/frete grátis próprios: a vitrine avisa que varia
  expect(profile.order_rules).toMatchObject({ varies_by_zone: true });
  // Nenhuma loja vê as coordenadas da outra: o perfil público não traz o local
  expect(profile).not.toHaveProperty('latitude');
});

test('orçamento por faixa: distância (linha reta × 1,3), taxa, prazo, delivery_mode e distance_km', async () => {
  test.skip(!fakeGeo, SKIP_WITHOUT_FAKE);
  expect(await expectStatus(await quote('km1'), 200, '1,3 km')).toMatchObject({
    delivery_mode: 'distance',
    distance_km: 1.3,
    delivery_fee: 5,
    estimated_delivery_time: '25-35 min',
    subtotal: 20,
    total: 25,
  });
  expect(await expectStatus(await quote('km3', 2), 200, '3,9 km')).toMatchObject({
    distance_km: 3.9,
    delivery_fee: 8,
    estimated_delivery_time: '35-45 min',
    min_order_value: 40,
    missing_for_min_order: 0,
  });
  expect(await expectStatus(await quote('km5'), 200, '6,5 km')).toMatchObject({ distance_km: 6.5, delivery_fee: 12, missing_for_free_delivery: 10 });
  // O endereço ficou localizado (cache nas colunas do endereço)
  expect(await geoColumns(address.km1?.id as number)).toMatchObject({ geo_status: 'FOUND', geo_precision: 'ADDRESS', geo_source: 'FAKE' });
  // Fator de rota configurável: com 1,0, a mesma rua fica a 3,0 km (ainda na faixa 2)
  await setDistance({ ...DISTANCE_ZONES, distance: { ...DISTANCE, route_factor: 1 } });
  expect(await expectStatus(await quote('km3', 2), 200, 'fator 1')).toMatchObject({ distance_km: 3, delivery_fee: 8 });
  await setDistance(DISTANCE_ZONES);
});

test('pedido mínimo e frete grátis da faixa: o pedido abaixo do mínimo é recusado; o frete grátis zera a taxa no pedido e no PIX', async () => {
  test.skip(!fakeGeo, SKIP_WITHOUT_FAKE);
  // Faixa 2: mínimo de R$ 40 (o orçamento avisa, o pedido recusa)
  expect(await expectStatus(await quote('km3'), 200, 'abaixo do mínimo da faixa')).toMatchObject({ min_order_value: 40, missing_for_min_order: 20 });
  const below = await expectError(
    await post('/orders', { ...deliveryTo('km3'), paymentMethod: 'MONEY' }),
    400,
    'O pedido mínimo desta loja para entrega é R$ 40,00. Faltam R$ 20,00.',
    'pedido abaixo do mínimo da faixa',
  );
  expect(below.code).toBe('ORDER_BELOW_MINIMUM');
  const order = await expectStatus(await post('/orders', { ...deliveryTo('km3', 2), paymentMethod: 'MONEY' }), 201, 'pedido na faixa 2');
  expect(Number(order.delivery_fee)).toBe(8);
  expect(Number(order.total_price)).toBe(48);

  // Faixa 3: frete grátis a partir de R$ 30
  const free = await expectStatus(await quote('km5', 2), 200, 'frete grátis da faixa');
  expect(free).toMatchObject({ delivery_fee: 0, delivery_fee_original: 12, free_delivery_applied: true, total: 40 });
  const pix = await expectStatus(await post('/payment/pix', { order: deliveryTo('km5', 2) }), 201, 'PIX com frete grátis');
  expect(Number(pix.amount)).toBe(40);
  const paidFee = await expectStatus(await post('/payment/pix', { order: deliveryTo('km1') }), 201, 'PIX com a taxa da faixa 1');
  expect(Number(paidFee.amount)).toBe(25);
});

test('além do raio: taxa padrão; km adicional até o raio máximo; com recusa → 400 no orçamento, pedido e PIX', async () => {
  test.skip(!fakeGeo, SKIP_WITHOUT_FAKE);
  expect(await expectStatus(await quote('km10'), 200, '13 km com taxa padrão')).toMatchObject({
    distance_km: 13,
    delivery_fee: 20,
    estimated_delivery_time: '70-80 min',
  });
  // Raio de 15 km com R$ 1,50 por km além dos 8 km: 13 km → 5 km adicionais
  await setDistance({ ...DISTANCE_ZONES, distance: { ...DISTANCE, max_km: 15, extra_km_fee: 1.5 } });
  // R$ 12,00 da última faixa + 5 × R$ 1,50; o frete grátis da última faixa (R$ 30) vale também no km adicional
  expect(await expectStatus(await quote('km10'), 200, 'km adicional')).toMatchObject({ distance_km: 13, delivery_fee: 19.5, missing_for_free_delivery: 10 });
  expect(await expectStatus(await quote('km10', 2), 200, 'km adicional com frete grátis')).toMatchObject({
    delivery_fee: 0,
    delivery_fee_original: 19.5,
    free_delivery_applied: true,
  });
  expect((await getJson(api, `/stores/${store.slug}`)).delivery_distance).toEqual({ max_km: 15 });

  await setDistance({ ...DISTANCE_ZONES, outside_zones: 'refuse' });
  expect((await getJson(api, `/stores/${store.slug}`)).delivers_outside_zones).toBe(false);
  await expectOutOfArea(await quote('km10'), OUT_OF_AREA, 'orçamento além do raio');
  await expectOutOfArea(await post('/orders', { ...deliveryTo('km10', 2), paymentMethod: 'MONEY' }), OUT_OF_AREA, 'pedido além do raio');
  await expectOutOfArea(await post('/payment/pix', { order: deliveryTo('km10', 2) }), OUT_OF_AREA, 'PIX além do raio');
  // Dentro do raio continua normal
  expect(await expectStatus(await quote('km1'), 200, 'dentro do raio com recusa')).toMatchObject({ delivery_fee: 5 });
});

test('endereço não localizado: recusa com o motivo (ou taxa padrão); o endereço fica marcado e é localizado de novo depois de 1 h', async () => {
  test.skip(!fakeGeo, SKIP_WITHOUT_FAKE);
  const refused = await expectOutOfArea(await quote('unavailable'), NOT_LOCATED, 'mapas fora do ar com recusa');
  expect(refused.reason).toBe('ADDRESS_NOT_LOCATED');
  await expectOutOfArea(await quote('notFound'), NOT_LOCATED, 'endereço não encontrado com recusa');
  expect(await geoColumns(address.unavailable?.id as number)).toMatchObject({ geo_status: 'UNAVAILABLE', geo_latitude: null });
  expect(await geoColumns(address.notFound?.id as number)).toMatchObject({ geo_status: 'NOT_FOUND' });

  await setDistance(DISTANCE_ZONES);
  expect(await expectStatus(await quote('unavailable'), 200, 'não localizado com taxa padrão')).toMatchObject({
    delivery_mode: 'distance',
    distance_km: null,
    delivery_fee: 20,
  });

  // Nova tentativa com intervalo: o mesmo endereço, agora num CEP que o mapa conhece (troca direta no banco)
  const id = address.unavailable?.id as number;
  await withTestDb((db) => db.query(`UPDATE "addresses" SET "zipCode" = $2 WHERE "id" = $1`, [id, GEO_CEPS.km1.replace('-', '')]));
  expect(await expectStatus(await quote('unavailable'), 200, 'tentou há pouco: não tenta de novo')).toMatchObject({ distance_km: null });
  await withTestDb((db) => db.query(`UPDATE "addresses" SET "geo_checked_at" = now() - interval '2 hours' WHERE "id" = $1`, [id]));
  expect(await expectStatus(await quote('unavailable'), 200, 'depois de 1 h: localiza')).toMatchObject({ distance_km: 1.3, delivery_fee: 5 });
  expect(await geoColumns(id)).toMatchObject({ geo_status: 'FOUND' });

  // Editar o endereço (CEP, rua, número...) apaga as coordenadas antigas e localiza de novo
  const edited = await expectStatus(
    await api.patch(`/addresses/${address.km1?.id as number}`, { headers: bearer(customer.token), data: { zipCode: GEO_CEPS.km3 } }),
    200,
    'editar o CEP',
  );
  expect(edited.zipCode).toBe(GEO_CEPS.km3.replace('-', ''));
  expect(await expectStatus(await quote('km1', 2), 200, 'endereço editado')).toMatchObject({ distance_km: 3.9, delivery_fee: 8 });
});

test('simulador do painel: distância, faixa e taxa com a configuração em edição (nada é gravado)', async () => {
  test.skip(!fakeGeo, SKIP_WITHOUT_FAKE);
  const simulate = (data: Record<string, unknown>, token = store.owner.token) =>
    api.post('/store/settings/delivery-simulation', { headers: bearer(token), data });
  expect(await expectStatus(await simulate({ zip_code: GEO_CEPS.km3, number: '10' }), 200, 'simulação')).toMatchObject({
    mode: 'distance',
    located: true,
    precision: 'ADDRESS',
    distance_km: 3.9,
    band: 2,
    delivery_fee: 8,
    estimated_delivery_time: '35-45 min',
    min_order: 40,
    outside: false,
    message: 'A 3,9 km da loja (faixa 2: até 5 km): taxa R$ 8,00, prazo 35-45 min.',
  });
  // Rascunho: raio menor com recusa → 13 km é recusado (o salvo continua)
  const draft = await expectStatus(
    await simulate({
      zip_code: GEO_CEPS.km10,
      delivery_zones: { ...DISTANCE_ZONES, outside_zones: 'refuse' },
    }),
    200,
    'simulação com rascunho',
  );
  expect(draft).toMatchObject({ distance_km: 13, outside: true, refused: true, delivery_fee: null });
  expect((await getJson(api, '/store/settings', store.owner.token)).delivery_zones).not.toHaveProperty('outside_zones');
  expect((await simulate({ zip_code: GEO_CEPS.km3 }, customer.token)).status()).toBe(403);
  await expectError(await simulate({}), 400, /Informe o CEP do endereço a testar/, 'sem CEP');
});

test('modo por zonas (padrão) continua igual: as faixas ficam guardadas, o orçamento traz delivery_mode "zones"', async () => {
  test.skip(!fakeGeo, SKIP_WITHOUT_FAKE);
  const { mode: _mode, ...byZones } = DISTANCE_ZONES;
  void _mode;
  const saved = await expectStatus(await patchSettings({ delivery_zones: { ...byZones, zones: [{ neighborhoods: ['Centro'], fee: 6, time: '30 min' }] } }), 200, 'voltar às zonas');
  expect(saved.delivery_zones).toEqual({
    zones: [{ neighborhoods: ['Centro'], fee: 6, time: '30 min' }],
    fallback: DISTANCE_ZONES.fallback,
    distance: { ...DISTANCE, route_factor: 1.3 },
  });
  expect(await expectStatus(await quote('km5'), 200, 'zona Centro')).toMatchObject({
    delivery_mode: 'zones',
    distance_km: null,
    delivery_fee: 6,
    estimated_delivery_time: '30 min',
  });
  expect(
    await expectStatus(await post('/orders/quote', { items: [{ productId: p20.id as number, quantity: 1 }], type: 'TAKEOUT' }), 200, 'retirada'),
  ).toMatchObject({ delivery_mode: null, distance_km: null, delivery_fee: 0 });
  expect((await getJson(api, `/stores/${store.slug}`)).delivery_distance).toBeNull();
  // No modo por zonas o local pode ser apagado
  expect(await expectStatus(await patchSettings({ latitude: null, longitude: null }), 200, 'apagar o local')).toMatchObject({ latitude: null });
});
