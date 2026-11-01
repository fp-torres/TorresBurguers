import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { storePath, useSession } from '../../../support/web';
import { addToCart, cartLine, searchBox, summaryValue } from '../client/helpers';
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
 * Pedido mínimo e frete grátis na web:
 * - vitrine: selos "Pedido mínimo R$ 30,00 na entrega" e "Frete grátis acima de R$ 50,00";
 * - carrinho: quanto falta para o mínimo (o botão de finalizar fica bloqueado e nada é enviado), quanto falta para
 *   o frete grátis e, ao chegar, a taxa riscada com "Grátis" — o pedido sai sem taxa;
 * - painel › Configurações › Entrega: pedido mínimo, frete grátis, "vale na retirada" e valores por zona, com o
 *   aviso de frete grátis menor que o mínimo.
 * Loja própria deste arquivo (desativada no fim).
 */

const tag = uid('regras').replace(/-/g, '');
const ZONES = {
  zones: [{ neighborhoods: ['Centro'], fee: 5, time: '20-30 min' }],
  fallback: { fee: 12, time: '60-70 min' },
  min_order: 30,
  free_delivery_above: 50,
};

let api: APIRequestContext;
let superadmin: Session;
let store: TenantStore;
let product: Json;

test.beforeAll(async () => {
  api = await newApi();
  superadmin = await superadminSession(api);
  store = await tenantStore(api, superadmin, `Regras ${tag}`, { delivery: false });
  await expectStatus(
    await api.patch('/store/settings', {
      headers: bearer(store.owner.token),
      data: { delivery_enabled: true, takeout_enabled: true, delivery_zones: ZONES },
    }),
    200,
    'zonas com pedido mínimo e frete grátis',
  );
  product = await addProduct(api, store.owner, { name: `Lanche Regras ${tag}`, price: 20, category: 'bebidas' });
});

test.afterAll(async () => {
  await retireTenantStore(api, superadmin, store);
  await api.dispose();
});

/** Próximo orçamento de entrega da loja deste arquivo (corpo da resposta). */
function nextDeliveryQuote(page: Page): Promise<any> {
  return page
    .waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        new URL(res.url()).pathname === `/stores/${store.slug}/orders/quote` &&
        res.request().postDataJSON()?.type === 'DELIVERY',
      { timeout: 15_000 },
    )
    .then((res) => res.json());
}

/** Valor de um campo de dinheiro ("R$ 30,00", com o espaço especial do formato brasileiro). */
const money = (value: string) => new RegExp(`^R\\$\\s${value}$`);

/** Muda a quantidade do item no carrinho e espera o novo orçamento de entrega. */
async function increase(page: Page): Promise<any> {
  const quoted = nextDeliveryQuote(page);
  await cartLine(page, product.name).getByRole('button', { name: 'Aumentar quantidade' }).click();
  return quoted;
}

test('carrinho: falta para o mínimo bloqueia, falta para o frete grátis e a taxa riscada quando grátis', async ({ page }) => {
  const client = await newCustomer(api, 'Regras Web');
  await expectStatus(
    await api.post('/addresses', {
      headers: bearer(client.token),
      data: { nickname: 'Casa', zipCode: '27990-201', street: 'Rua das Regras', number: '20', neighborhood: 'Centro', city: 'Rio de Janeiro', state: 'RJ' },
    }),
    201,
    'endereço no Centro',
  );
  const posts: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/(orders|payment\/(pix|card))$/.test(new URL(req.url()).pathname)) posts.push(new URL(req.url()).pathname);
  });

  await useSession(page, client);
  await page.goto(storePath(undefined, store.slug));
  await expect(page.getByRole('heading', { level: 1, name: store.name })).toBeVisible();
  await expect(searchBox(page)).toBeVisible();
  const info = page.getByRole('list', { name: 'Informações da loja' });
  await expect(info.getByText('Pedido mínimo R$ 30,00 na entrega')).toBeVisible();
  await expect(info.getByText('Frete grátis acima de R$ 50,00')).toBeVisible();

  await addToCart(page, product.name);
  await page.goto(storePath('cart', store.slug));
  await expect(page.getByRole('heading', { name: 'Carrinho', level: 1, exact: true })).toBeVisible();

  // Entrega no Centro com R$ 20,00: faltam R$ 10,00 para o mínimo e R$ 30,00 para o frete grátis
  const firstQuote = nextDeliveryQuote(page);
  await page.getByRole('button', { name: 'Delivery', exact: true }).click();
  expect(await firstQuote).toMatchObject({ subtotal: 20, delivery_fee: 5, min_order_value: 30, missing_for_min_order: 10, missing_for_free_delivery: 30 });
  await expect(summaryValue(page, 'Taxa de entrega')).toHaveText('R$ 5,00');
  const minimum = page.getByRole('status').filter({ hasText: 'Pedido mínimo para entrega: R$ 30,00' });
  await expect(minimum).toContainText('Faltam R$ 10,00 em produtos para finalizar o pedido.');
  await expect(minimum.getByRole('link', { name: 'Adicionar mais itens' })).toBeVisible();
  await expect(page.getByText('Faltam R$ 30,00 para o frete grátis')).toBeVisible();
  await page.getByRole('button', { name: 'Pagar na Entrega' }).click();
  await expect(page.getByRole('button', { name: 'Finalizar Pedido' }), 'abaixo do mínimo: bloqueado').toBeDisabled();
  await expect(page.getByText('Faltam R$ 10,00 para o pedido mínimo')).toBeVisible();

  // R$ 40,00: mínimo atingido, ainda com taxa
  expect(await increase(page)).toMatchObject({ subtotal: 40, missing_for_min_order: 0, missing_for_free_delivery: 10 });
  await expect(minimum).toBeHidden();
  await expect(page.getByText('Faltam R$ 10,00 para o frete grátis')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Finalizar Pedido' })).toBeEnabled();

  // R$ 60,00: frete grátis — taxa riscada, "Grátis" e o total só com os produtos
  expect(await increase(page)).toMatchObject({ subtotal: 60, delivery_fee: 0, delivery_fee_original: 5, free_delivery_applied: true });
  const fee = summaryValue(page, 'Taxa de entrega');
  await expect(fee).toContainText('Grátis');
  await expect(fee.locator('s')).toHaveText('R$ 5,00');
  await expect(page.getByText('Frete grátis! Você economizou R$ 5,00 na entrega.')).toBeVisible();
  await expect(summaryValue(page, 'Total')).toHaveText('R$ 60,00');
  expect(posts, 'nada foi enviado enquanto abaixo do mínimo').toEqual([]);

  const created = page.waitForResponse(
    (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === `/stores/${store.slug}/orders`,
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: 'Finalizar Pedido' }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const order = await response.json();
  expect(Number(order.delivery_fee), 'pedido sem taxa').toBe(0);
  expect(Number(order.total_price)).toBe(60);
});

test('painel: pedido mínimo, frete grátis e valores por zona salvos nas configurações de entrega', async ({ page }) => {
  await useSession(page, store.owner);
  await page.goto('/settings?secao=entrega');
  const rules = page.getByRole('group', { name: 'Pedido mínimo e frete grátis' });
  await expect(rules).toBeVisible();
  const minOrder = rules.getByLabel('Pedido mínimo para entrega');
  const freeAbove = rules.getByLabel('Frete grátis a partir de');
  await expect(minOrder).toHaveValue(money('30,00'));
  await expect(freeAbove).toHaveValue(money('50,00'));

  await minOrder.fill('2500');
  await freeAbove.fill('2000');
  await expect(rules.getByRole('status')).toContainText('Loja: o frete grátis (R$ 20,00) é menor que o pedido mínimo (R$ 25,00)');
  await freeAbove.fill('6000');
  await expect(rules.getByRole('status')).toHaveCount(0);
  await rules.getByRole('switch', { name: 'Pedido mínimo também na retirada no balcão' }).click();
  const zoneMin = page.getByLabel('Pedido mínimo (zona 1)');
  await expect(zoneMin).toHaveAttribute('placeholder', /^Igual ao da loja \(R\$\s25,00\)$/);
  await zoneMin.fill('4000');

  const saved = page.waitForResponse((res) => res.request().method() === 'PATCH' && new URL(res.url()).pathname === '/store/settings');
  await page.getByRole('button', { name: 'Salvar alterações' }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByText('Entrega e retirada salvas.')).toBeVisible();

  const settings = await expectStatus(await api.get('/store/settings', { headers: bearer(store.owner.token) }), 200, 'configurações salvas');
  expect(settings.delivery_zones).toMatchObject({ min_order: 25, free_delivery_above: 60, min_order_takeout: true });
  expect(settings.delivery_zones.zones[0]).toMatchObject({ neighborhoods: ['Centro'], fee: 5, min_order: 40 });
  expect(settings.delivery_zones.zones[0].free_delivery_above, 'zona sem frete grátis próprio herda o da loja').toBeUndefined();

  // Recarregada, a tela mostra o que foi salvo (sem alterações pendentes)
  await page.reload();
  await expect(page.getByRole('group', { name: 'Pedido mínimo e frete grátis' }).getByLabel('Pedido mínimo para entrega')).toHaveValue(money('25,00'));
  await expect(page.getByLabel('Pedido mínimo (zona 1)')).toHaveValue(money('40,00'));
  await expect(page.getByRole('button', { name: 'Salvar alterações' }), 'nada pendente depois de recarregar').toBeDisabled();
});
