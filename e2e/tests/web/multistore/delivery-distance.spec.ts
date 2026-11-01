import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { GEO_CEPS, GEO_ORIGIN } from '../../../support/geocoding-fake';
import { storePath, useSession } from '../../../support/web';
import { addToCart, searchBox, summaryValue } from '../client/helpers';
import {
  addProduct,
  bearer,
  expectStatus,
  newApi,
  newCustomer,
  retireTenantStore,
  superadminSession,
  tenantStore,
  uid,
  type Json,
  type Session,
  type TenantStore,
} from '../platform/helpers';

/**
 * Entrega por distância na web:
 * - painel › Configurações › Entrega: escolher "Por distância (km)", localizar a loja pelo endereço (mapa com pino),
 *   cadastrar as faixas, testar um endereço no simulador e salvar (também a 375 px, sem rolagem horizontal);
 * - vitrine: "Entrega até 8 km"; carrinho: a taxa da faixa e a "Distância da loja".
 * A API de teste localiza os CEPs pelo mapa falso (GEOCODING_FAKE); as imagens do mapa (OpenStreetMap) são
 * respondidas localmente: o teste nunca acessa serviços externos. Loja própria deste arquivo (desativada no fim).
 */

const tag = uid('dist').replace(/-/g, '');
const DISTANCE_ZONES = {
  zones: [],
  fallback: { fee: 20, time: '70-80 min' },
  mode: 'distance',
  distance: {
    bands: [
      { up_to_km: 2, fee: 5, time: '25-35 min' },
      { up_to_km: 5, fee: 8, time: '35-45 min' },
      { up_to_km: 8, fee: 12, time: '45-55 min' },
    ],
  },
};
/** PNG 1×1 transparente no lugar dos "tiles" do OpenStreetMap. */
const BLANK_TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

let api: APIRequestContext;
let superadmin: Session;
let store: TenantStore;
let product: Json;

test.beforeAll(async () => {
  api = await newApi();
  superadmin = await superadminSession(api);
  store = await tenantStore(api, superadmin, `Distancia ${tag}`, { delivery: false });
  // Endereço da loja (o painel localiza a loja por ele)
  await expectStatus(
    await api.patch('/store/settings', {
      headers: bearer(store.owner.token),
      data: {
        takeout_enabled: true,
        address_zip_code: GEO_CEPS.store,
        address_street: 'Rua da Loja',
        address_number: '1',
        address_neighborhood: 'Centro',
        address_city: 'Rio de Janeiro',
        address_state: 'RJ',
      },
    }),
    200,
    'endereço da loja',
  );
  product = await addProduct(api, store.owner, { name: `Lanche Distancia ${tag}`, price: 20, category: 'bebidas' });
});

test.afterAll(async () => {
  await retireTenantStore(api, superadmin, store);
  await api.dispose();
});

/** Nenhuma imagem do mapa sai para a internet: os tiles do OpenStreetMap viram um PNG em branco. */
async function offlineMap(page: Page): Promise<string[]> {
  const external: string[] = [];
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: BLANK_TILE }));
  page.on('request', (req) => {
    const host = new URL(req.url()).hostname;
    if (/nominatim|awesomeapi|googleapis/.test(host)) external.push(req.url());
  });
  return external;
}

test('painel: escolher a cobrança por distância, localizar a loja no mapa, cadastrar faixas, testar um endereço e salvar', async ({ page }) => {
  const external = await offlineMap(page);
  await useSession(page, store.owner);
  await page.goto('/settings?secao=entrega');

  await page.getByRole('switch', { name: 'Entrega', exact: true }).click();
  await page.getByRole('button', { name: 'Cobrar por distância' }).click();
  await expect(page.getByRole('radio', { name: /Por distância \(km\)/ })).toBeChecked();
  await expect(page.getByRole('heading', { name: 'Taxa de entrega por distância' })).toBeVisible();

  // Local da loja pelo endereço salvo: o pino aparece no mapa
  await page.getByRole('button', { name: 'Localizar pelo endereço da loja' }).click();
  await expect(page.getByLabel('Latitude')).toHaveValue('-22,9035');
  await expect(page.getByLabel('Longitude')).toHaveValue('-43,2096');
  await expect(page.getByTestId('store-location-map').locator('.leaflet-marker-icon')).toBeVisible();
  await expect(page.getByRole('link', { name: /Ver no mapa/ })).toHaveAttribute('href', /openstreetmap\.org\/\?mlat=-22\.9035&mlon=-43\.2096/);

  // Faixas sugeridas (2, 5 e 8 km): taxa e prazo de cada uma
  await expect(page.getByLabel('Até quantos km (faixa 1)')).toHaveValue('2');
  const bands: [string, string][] = [['500', '25-35 min'], ['800', '35-45 min'], ['1200', '45-55 min']];
  for (const [index, [fee, time]] of bands.entries()) {
    await page.getByLabel(`Taxa (faixa ${index + 1})`, { exact: true }).fill(fee);
    // Campo obrigatório: o rótulo tem o asterisco
    await page.getByLabel(new RegExp(`^Prazo \\(faixa ${index + 1}\\)`)).fill(time);
  }
  await page.getByLabel('Taxa fora do raio').fill('2000');
  await page.getByLabel('Prazo fora do raio').fill('70-80 min');
  await expect(page.getByLabel('Fator de rota')).toHaveValue('1,3');

  // Simulador com o que está na tela (antes de salvar)
  await page.getByLabel('CEP do cliente').fill(GEO_CEPS.km3);
  await page.getByRole('button', { name: 'Testar endereço' }).click();
  const result = page.getByTestId('delivery-simulation-result');
  await expect(result).toContainText('A 3,9 km da loja (faixa 2: até 5 km): taxa R$ 8,00, prazo 35-45 min.');
  await expect(result).toContainText('Distância:');

  const saved = page.waitForResponse((res) => res.request().method() === 'PATCH' && new URL(res.url()).pathname === '/store/settings');
  await page.getByRole('button', { name: 'Salvar alterações' }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByText('Entrega e retirada salvas.')).toBeVisible();

  const settings = await expectStatus(await api.get('/store/settings', { headers: bearer(store.owner.token) }), 200, 'configurações salvas');
  expect(settings).toMatchObject({ delivery_enabled: true, latitude: GEO_ORIGIN.lat, longitude: GEO_ORIGIN.lng });
  expect(settings.delivery_zones).toMatchObject({
    zones: [],
    fallback: { fee: 20, time: '70-80 min' },
    mode: 'distance',
    distance: { bands: DISTANCE_ZONES.distance.bands, route_factor: 1.3 },
  });

  // Recarregada, a tela mostra o salvo (sem alterações pendentes); a 375 px, sem rolagem horizontal
  await page.setViewportSize({ width: 375, height: 800 });
  await page.reload();
  await expect(page.getByRole('radio', { name: /Por distância \(km\)/ })).toBeChecked();
  await expect(page.getByLabel('Taxa (faixa 2)', { exact: true })).toHaveValue(/^R\$\s8,00$/);
  await expect(page.getByRole('button', { name: 'Salvar alterações' }), 'nada pendente depois de recarregar').toBeDisabled();
  await expect(page.getByTestId('store-location-map')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'sem rolagem horizontal a 375 px').toBeLessThanOrEqual(0);
  expect(external, 'nenhum serviço de mapas chamado pelo navegador').toEqual([]);
});

test('vitrine mostra "Entrega até 8 km" e o carrinho mostra a distância e a taxa da faixa', async ({ page }) => {
  await expectStatus(
    await api.patch('/store/settings', {
      headers: bearer(store.owner.token),
      data: { delivery_enabled: true, latitude: GEO_ORIGIN.lat, longitude: GEO_ORIGIN.lng, delivery_zones: DISTANCE_ZONES },
    }),
    200,
    'modo distância',
  );
  const client = await newCustomer(api, 'Distancia Web');
  await expectStatus(
    await api.post('/addresses', {
      headers: bearer(client.token),
      data: { nickname: 'Casa', zipCode: GEO_CEPS.km1, street: 'Rua da Distância', number: '10', neighborhood: 'Centro', city: 'Rio de Janeiro', state: 'RJ' },
    }),
    201,
    'endereço a 1,3 km',
  );

  await useSession(page, client);
  await page.goto(storePath(undefined, store.slug));
  await expect(page.getByRole('heading', { level: 1, name: store.name })).toBeVisible();
  await expect(searchBox(page)).toBeVisible();
  await expect(page.getByRole('list', { name: 'Informações da loja' }).getByText('Entrega até 8 km')).toBeVisible();

  await addToCart(page, product.name);
  await page.goto(storePath('cart', store.slug));
  await expect(page.getByRole('heading', { name: 'Carrinho', level: 1, exact: true })).toBeVisible();
  const quoted = page
    .waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        new URL(res.url()).pathname === `/stores/${store.slug}/orders/quote` &&
        res.request().postDataJSON()?.type === 'DELIVERY',
      { timeout: 15_000 },
    )
    .then((res) => res.json());
  await page.getByRole('button', { name: 'Delivery', exact: true }).click();
  expect(await quoted).toMatchObject({ delivery_mode: 'distance', distance_km: 1.3, delivery_fee: 5, total: 25 });
  await expect(summaryValue(page, 'Taxa de entrega')).toHaveText('R$ 5,00');
  await expect(summaryValue(page, 'Distância da loja')).toHaveText('1,3 km');
  await expect(summaryValue(page, 'Total')).toHaveText('R$ 25,00');
});
