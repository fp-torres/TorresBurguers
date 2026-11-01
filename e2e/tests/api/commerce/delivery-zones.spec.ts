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
 * Frete por CEP e recusa fora da área (docs/saas/arquitetura.md §11.2):
 * - o cadastro do endereço confere o CEP e guarda o bairro, a cidade e a UF do CEP (canonical_*) ao lado do
 *   digitado; a zona de entrega usa o do CEP (bairro digitado errado não muda a taxa);
 * - CEP inexistente, sem bairro ou serviço de CEP fora do ar: o endereço é salvo assim mesmo e vale o
 *   bairro digitado (neighborhood_source = MANUAL);
 * - zonas por faixa de CEP;
 * - a loja escolhe o que fazer fora das zonas: "fallback" (padrão, taxa padrão) ou "refuse" (400
 *   "Este endereço está fora da área de entrega da loja." no orçamento, no pedido e nas cobranças).
 *
 * Os testes que dependem do bairro do CEP precisam da API com o modo de CEP falso (NODE_ENV=test +
 * CEP_LOOKUP_FAKE com os CEPs abaixo); sem ele, são pulados (a conferência fica "serviço indisponível").
 */

/**
 * Mapa do modo de CEP falso esperado: a API de teste sobe com CEP_LOOKUP_FAKE contendo estes CEPs (pode ter
 * outros; nunca os CEPs que outros arquivos usam com bairros variados, como 20040-002 e 22041-001).
 */
const FAKE_CEPS = {
  '22071900': { logradouro: 'Rua do Frete E2E', bairro: 'Copacabana', localidade: 'Rio de Janeiro', uf: 'RJ' },
  '23585000': { logradouro: 'Estrada do Frete E2E', bairro: 'Bairro Distante', localidade: 'Rio de Janeiro', uf: 'RJ' },
  '28999000': { logradouro: '', bairro: '', localidade: 'Cidade Única', uf: 'RJ' },
  '28999999': 'unavailable',
} as const;

const CEP = {
  /** Copacabana pelo CEP (zona 2). */
  copacabana: '22071-900',
  /** Bairro fora das zonas pelo CEP. */
  outside: '23585-000',
  /** CEP geral da cidade, sem bairro. */
  noNeighborhood: '28999-000',
  /** Serviço de CEP fora do ar. */
  unavailable: '28999-999',
  /** Inexistente no mapa falso (e sem conferência nos testes sem o mapa). */
  unknown: '27999-001',
  /** Dentro da faixa de CEP da zona 3 (fora do mapa: vale o CEP digitado). */
  inRange: '30140-071',
} as const;

const OUT_OF_AREA = 'Este endereço está fora da área de entrega da loja.';
const SKIP_WITHOUT_FAKE = `API sem o modo de CEP falso: suba-a com NODE_ENV=test e CEP_LOOKUP_FAKE='${JSON.stringify(FAKE_CEPS)}'`;

const ZONES = {
  zones: [
    { neighborhoods: ['Centro'], fee: 4, time: '20-30 min' },
    { neighborhoods: ['Copacabana'], fee: 8, time: '40-50 min' },
    { neighborhoods: [], zip_ranges: [{ from: '30100000', to: '30199999' }], fee: 11, time: '50-60 min' },
  ],
  fallback: { fee: 15, time: '60-70 min' },
};

let api: APIRequestContext;
let superadmin: Session;
let store: TenantStore;
let product: Json;
let customer: Member;
let fakeCep = false;
const cleanup = new Cleanup();

async function setZones(zones: Record<string, unknown> | null): Promise<Json> {
  const res = await api.patch('/store/settings', {
    headers: bearer(store.owner.token),
    data: { delivery_enabled: true, delivery_zones: zones },
  });
  return expectStatus(res, 200, 'PATCH /store/settings (zonas)');
}

async function newAddress(zipCode: string, neighborhood: string, extra: Record<string, unknown> = {}): Promise<Json> {
  const res = await api.post('/addresses', {
    headers: bearer(customer.token),
    data: { zipCode, street: 'Rua do Teste de Frete', number: '10', neighborhood, city: 'Rio de Janeiro', state: 'RJ', ...extra },
  });
  return expectStatus(res, 201, `POST /addresses (${zipCode})`);
}

const order = (addressId?: number) => ({
  items: [{ productId: product.id as number, quantity: 1 }],
  ...(addressId === undefined ? { type: 'TAKEOUT' as const } : { type: 'DELIVERY' as const, addressId }),
});

function quote(addressId?: number) {
  return api.post(storePath(store.slug, '/orders/quote'), { headers: bearer(customer.token), data: order(addressId) });
}

async function expectFee(addressId: number, fee: number, time: string, label: string): Promise<Json> {
  const payload = await expectStatus(await quote(addressId), 200, `orçamento: ${label}`);
  expect(payload, label).toMatchObject({ delivery_fee: fee, estimated_delivery_time: time, subtotal: 20, total: 20 + fee });
  return payload;
}

async function expectOutOfArea(res: Awaited<ReturnType<typeof quote>>, label: string): Promise<void> {
  const payload = await expectError(res, 400, OUT_OF_AREA, label);
  expect(payload.code, `${label}: code`).toBe('DELIVERY_OUT_OF_AREA');
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  api = await newApi();
  superadmin = await defaultSession(api, 'superadmin');
  store = await createStore(api, superadmin, 'Frete', { delivery: false });
  cleanup.add('desativar a loja de frete', () => retireStore(api, superadmin, store));
  await setZones(ZONES);
  product = await addProduct(api, store.owner, { price: 20 });
  customer = await newCustomer(api, 'Frete');

  // Modo de CEP falso ativo? (NODE_ENV=test + CEP_LOOKUP_FAKE com o mapa acima)
  const probe = await newAddress(CEP.copacabana, 'Centro');
  fakeCep = probe.neighborhood_source === 'CEP' && probe.canonical_neighborhood === 'Copacabana';
});

test.afterAll(async () => {
  await cleanup.run();
  await api.dispose();
});

test.describe('Endereço: bairro, cidade e UF pelo CEP', () => {
  test('cadastro guarda o canônico do CEP ao lado do digitado (o digitado não muda)', async () => {
    test.skip(!fakeCep, SKIP_WITHOUT_FAKE);
    const address = await newAddress(CEP.copacabana, 'Centro');
    expect(address).toMatchObject({
      zipCode: '22071900',
      neighborhood: 'Centro',
      city: 'Rio de Janeiro',
      canonical_neighborhood: 'Copacabana',
      canonical_city: 'Rio de Janeiro',
      canonical_state: 'RJ',
      neighborhood_source: 'CEP',
      cep_status: 'FOUND',
    });
    const listed = (await getJson(api, '/addresses', customer.token)) as Json[];
    expect(listed.find((item) => item.id === address.id)).toMatchObject({ canonical_neighborhood: 'Copacabana', neighborhood_source: 'CEP' });
  });

  test('CEP sem bairro e CEP inexistente: bairro informado manualmente (vale o digitado)', async () => {
    test.skip(!fakeCep, SKIP_WITHOUT_FAKE);
    expect(await newAddress(CEP.noNeighborhood, 'Centro', { city: 'Outra Cidade' })).toMatchObject({
      neighborhood: 'Centro',
      canonical_neighborhood: null,
      canonical_city: 'Cidade Única',
      canonical_state: 'RJ',
      neighborhood_source: 'MANUAL',
      cep_status: 'NO_NEIGHBORHOOD',
    });
    expect(await newAddress(CEP.unknown, 'Centro')).toMatchObject({
      canonical_neighborhood: null,
      canonical_city: null,
      neighborhood_source: 'MANUAL',
      cep_status: 'NOT_FOUND',
    });
  });

  test('serviço de CEP fora do ar nunca impede salvar: o endereço fica com o digitado, sinalizado', async () => {
    const address = await newAddress(CEP.unavailable, 'Centro');
    expect(address).toMatchObject({
      neighborhood: 'Centro',
      canonical_neighborhood: null,
      neighborhood_source: 'MANUAL',
      cep_status: 'UNAVAILABLE',
    });
    // A zona usa o bairro digitado
    await expectFee(address.id, 4, '20-30 min', 'CEP fora do ar → bairro digitado (Centro)');
  });

  test('o cliente não grava o canônico por conta própria (campo fora do contrato → 400)', async () => {
    const res = await api.post('/addresses', {
      headers: bearer(customer.token),
      data: {
        zipCode: CEP.unknown,
        street: 'Rua Forjada',
        number: '1',
        neighborhood: 'Centro',
        city: 'Rio de Janeiro',
        state: 'RJ',
        canonical_neighborhood: 'Centro',
      },
    });
    await expectError(res, 400, /canonical_neighborhood should not exist/);
  });
});

test.describe('Zona de entrega pelo CEP', () => {
  test('bairro digitado errado com CEP de outra zona: orçamento e pedido usam a zona do CEP', async () => {
    test.skip(!fakeCep, SKIP_WITHOUT_FAKE);
    // Digitou "Centro" (R$ 4), mas o CEP é de Copacabana (R$ 8)
    const address = await newAddress(CEP.copacabana, 'Centro');
    await expectFee(address.id, 8, '40-50 min', 'zona pelo CEP (Copacabana)');

    const res = await api.post(storePath(store.slug, '/orders'), {
      headers: bearer(customer.token),
      data: { ...order(address.id), paymentMethod: 'MONEY' },
    });
    const created = await expectStatus(res, 201, 'pedido com o bairro digitado errado');
    cleanup.add(`cancelar o pedido ${created.id}`, () => api.patch(`/orders/${created.id}/cancel`, { headers: bearer(store.owner.token) }));
    expect(Number(created.delivery_fee)).toBe(8);
    expect(Number(created.total_price)).toBe(28);
    // O retrato do pedido continua com o endereço que o cliente digitou
    expect(created.delivery_address).toMatchObject({ neighborhood: 'Centro', zipCode: '22071900' });
  });

  test('zona por faixa de CEP: vale mesmo com um bairro que não está em nenhuma zona', async () => {
    const address = await newAddress(CEP.inRange, 'Savassi', { city: 'Belo Horizonte', state: 'MG' });
    await expectFee(address.id, 11, '50-60 min', 'faixa de CEP 30100-000 a 30199-999');
  });

  test('política padrão: endereço fora das zonas paga a faixa padrão', async () => {
    const address = await newAddress(CEP.outside, 'Bairro Que Ninguem Atende');
    await expectFee(address.id, 15, '60-70 min', 'fora das zonas → fallback');
    expect(await getJson(api, `/stores/${store.slug}`)).toMatchObject({ delivery_enabled: true, delivers_outside_zones: true });
  });

  test('endereço antigo (não conferido) é conferido no primeiro orçamento e o resultado fica gravado', async () => {
    const address = await newAddress(CEP.copacabana, 'Centro');
    // Simula um endereço cadastrado antes da conferência do CEP
    await withTestDb((db) =>
      db.query(
        `UPDATE "addresses" SET "canonical_neighborhood" = NULL, "canonical_city" = NULL, "canonical_state" = NULL,
         "neighborhood_source" = NULL, "cep_status" = NULL, "cep_checked_at" = NULL WHERE "id" = $1`,
        [address.id],
      ),
    );
    expect(await getJson(api, `/addresses/${address.id}`, customer.token)).toMatchObject({ cep_status: null, neighborhood_source: null });

    if (fakeCep) await expectFee(address.id, 8, '40-50 min', 'endereço antigo: zona pelo CEP conferido agora');
    else await expectFee(address.id, 4, '20-30 min', 'endereço antigo sem o serviço de CEP: bairro digitado');

    const refreshed = await getJson(api, `/addresses/${address.id}`, customer.token);
    expect(refreshed.cep_status).toBe(fakeCep ? 'FOUND' : 'UNAVAILABLE');
    expect(refreshed.neighborhood_source).toBe(fakeCep ? 'CEP' : 'MANUAL');
    expect(refreshed.cep_checked_at).toEqual(expect.any(String));
  });
});

test.describe('Loja que recusa endereços fora das zonas (outside_zones = "refuse")', () => {
  let outside: Json;
  let inside: Json;

  test.beforeAll(async () => {
    outside = await newAddress(CEP.outside, 'Bairro Que Ninguem Atende');
    inside = await newAddress(CEP.unknown, 'Centro');
  });

  test.afterAll(async () => {
    await setZones(ZONES);
  });

  test('configurações: "refuse" dispensa o fallback, exige uma zona e aparece na vitrine', async () => {
    const zonesOnly = { zones: ZONES.zones, outside_zones: 'refuse' };
    const saved = await setZones(zonesOnly);
    expect(saved.delivery_zones).toEqual({
      zones: [
        { neighborhoods: ['Centro'], fee: 4, time: '20-30 min' },
        { neighborhoods: ['Copacabana'], fee: 8, time: '40-50 min' },
        { neighborhoods: [], zip_ranges: [{ from: '30100000', to: '30199999' }], fee: 11, time: '50-60 min' },
      ],
      outside_zones: 'refuse',
    });
    const settings = await getJson(api, '/store/settings', store.owner.token);
    expect(settings.delivery_zones).toEqual(saved.delivery_zones);
    expect(await getJson(api, `/stores/${store.slug}`)).toMatchObject({ delivery_enabled: true, delivers_outside_zones: false });

    for (const [zones, message] of [
      [{ zones: [], outside_zones: 'refuse' }, /cadastre pelo menos uma zona/],
      [{ ...ZONES, outside_zones: 'talvez' }, /"outside_zones" deve ser "fallback"/],
      [{ zones: ZONES.zones, outside_zones: 'fallback' }, /informe em "fallback"/],
      [{ ...ZONES, zones: [{ zip_ranges: [{ from: '30199999', to: '30100000' }], fee: 1, time: '1 h' }] }, /menor ou igual ao final/],
    ] as const) {
      const res = await api.patch('/store/settings', { headers: bearer(store.owner.token), data: { delivery_zones: zones } });
      await expectError(res, 400, message, `configuração inválida: ${JSON.stringify(zones)}`);
    }
    // Continua a configuração salva
    expect((await getJson(api, '/store/settings', store.owner.token)).delivery_zones).toEqual(saved.delivery_zones);
  });

  test('orçamento e pedido de endereço fora da área → 400 com a mensagem clara (nada é criado)', async () => {
    await setZones({ ...ZONES, outside_zones: 'refuse' });
    await expectOutOfArea(await quote(outside.id), 'orçamento fora da área');
    await expectOutOfArea(
      await api.post(storePath(store.slug, '/orders'), {
        headers: bearer(customer.token),
        data: { ...order(outside.id), paymentMethod: 'MONEY' },
      }),
      'pedido fora da área',
    );
    const mine = (await getJson(api, `/stores/${store.slug}/orders/my-orders`, customer.token)) as Json[];
    expect(mine.filter((item) => item.delivery_address?.neighborhood === 'Bairro Que Ninguem Atende'), 'nenhum pedido fora da área').toEqual([]);
  });

  test('PIX e cartão de endereço fora da área: recusados antes de cobrar', async () => {
    await expectOutOfArea(
      await api.post(storePath(store.slug, '/payment/pix'), { headers: bearer(customer.token), data: { order: order(outside.id) } }),
      'PIX fora da área',
    );
    await expectOutOfArea(
      await api.post(storePath(store.slug, '/payment/card'), { headers: bearer(customer.token), data: cardBody(order(outside.id)) }),
      'cartão fora da área',
    );
    const payments = await withTestDb((db) =>
      db.query<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "payments" WHERE "store_id" = $1 AND "user_id" = $2`, [
        store.id,
        customer.user.id,
      ]),
    );
    expect(payments.rows[0].count, 'nenhuma cobrança criada').toBe(0);
  });

  test('dentro das zonas (bairro, faixa de CEP) e retirada continuam normais', async () => {
    await expectFee(inside.id, 4, '20-30 min', 'Centro (bairro digitado, CEP sem conferência)');
    const inRange = await newAddress(CEP.inRange, 'Savassi', { city: 'Belo Horizonte', state: 'MG' });
    await expectFee(inRange.id, 11, '50-60 min', 'faixa de CEP');
    const takeout = await expectStatus(await quote(), 200, 'retirada');
    expect(takeout).toMatchObject({ delivery_fee: 0, total: 20 });
  });

  test('bairro digitado dentro da zona, mas CEP de um bairro fora dela → recusado (vale o CEP)', async () => {
    test.skip(!fakeCep, SKIP_WITHOUT_FAKE);
    const address = await newAddress(CEP.outside, 'Centro');
    expect(address).toMatchObject({ neighborhood: 'Centro', canonical_neighborhood: 'Bairro Distante' });
    await expectOutOfArea(await quote(address.id), 'bairro digitado Centro, CEP do Bairro Distante');
  });

  test('a loja volta a aceitar fora das zonas: o mesmo endereço paga a faixa padrão', async () => {
    await setZones({ ...ZONES, outside_zones: 'fallback' });
    await expectFee(outside.id, 15, '60-70 min', 'de volta ao fallback');
    expect(await getJson(api, `/stores/${store.slug}`)).toMatchObject({ delivers_outside_zones: true });
  });
});
