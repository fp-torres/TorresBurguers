import { test, expect, type Page } from '@playwright/test';
import { signInAs } from '../../../support/web';
import {
  API_URL,
  TEST_CARD,
  addToCart,
  addressFields,
  brl,
  brlPattern,
  cartLine,
  cartLink,
  createAddress,
  createClient,
  demoStore,
  expectServerQuote,
  fillCard,
  fulfillJson,
  getOrder,
  isStoreApiResponse,
  listMyOrders,
  money,
  nextOrderCreation,
  nextQuote,
  openCart,
  openHome,
  seedCatalog,
  storeUrl,
  summaryValue,
  trackRequests,
  useSession,
  waitForStoreOpen,
  type Catalog,
  type TestClient,
} from './helpers';

let catalog: Catalog;
const clients: TestClient[] = [];

test.beforeAll(async () => {
  catalog = await seedCatalog();
});

test.afterEach(async () => {
  while (clients.length) await clients.pop()!.api.dispose();
});

async function newClient(name = 'Cliente Checkout'): Promise<TestClient> {
  const client = await createClient({ name });
  clients.push(client);
  return client;
}

/** Cliente logado com os itens no carrinho, já na página do carrinho. */
async function cartAsClient(page: Page, client: TestClient, add: (page: Page) => Promise<void>): Promise<void> {
  await useSession(page, client.session);
  await openHome(page);
  await add(page);
  await openCart(page);
}

/** Prazo exibido no carrinho: "Prazo estimado: 30-40 min" (o rótulo é só para leitores de tela). */
const estimate = (page: Page, time: string) => page.getByText(`Prazo estimado: ${time}`, { exact: true });

/** Linha da confirmação do pedido (/loja/<slug>/order-success): "Pedido #12 · <loja>" (número do pedido NA LOJA). */
async function confirmedOrderLine(page: Page, number: number) {
  const store = await demoStore();
  return page.getByText(`Pedido #${number} · ${store.name}`, { exact: true });
}

const payNowButton = (page: Page) => page.getByRole('button', { name: /^Pagar (com cartão|R\$)/ });

/** Downloads do SDK do Mercado Pago (script de terceiros) feitos pela página. */
function trackMercadoPagoSdk(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === 'sdk.mercadopago.com') urls.push(request.url());
  });
  return urls;
}

test.describe('Checkout: visitante precisa entrar', () => {
  test.beforeEach(async ({ page }) => {
    await openHome(page);
    await addToCart(page, catalog.drink.name);
    await openCart(page);
  });

  test('visitante que tenta gerar o PIX é convidado a fazer login e nada é cobrado', async ({ page }) => {
    const posts = trackRequests(page, (method) => method === 'POST');
    await page.getByRole('button', { name: 'PIX', exact: true }).click();
    await page.getByRole('button', { name: 'Gerar QR Code PIX' }).click();

    const dialog = page.getByRole('alertdialog', { name: 'Faça login' });
    await expect(dialog).toContainText('Para finalizar seu pedido, entre na sua conta');
    await dialog.getByRole('button', { name: 'Entrar' }).click();
    // O login guarda o destino: o carrinho desta loja
    await expect(page).toHaveURL(/\/signin\?redirect=%2Floja%2F/);
    expect(posts).toEqual([]);
  });

  test('visitante que tenta pagar com cartão é convidado a fazer login antes de qualquer cobrança', async ({ page }) => {
    const posts = trackRequests(page, (method) => method === 'POST');
    await fillCard(page, TEST_CARD);
    await page.getByRole('button', { name: 'Pagar com cartão' }).click();
    await expect(page.getByRole('alertdialog', { name: 'Faça login' })).toBeVisible();
    expect(posts).toEqual([]);
  });

  test('visitante que tenta finalizar com pagamento na retirada é convidado a fazer login', async ({ page }) => {
    const posts = trackRequests(page, (method) => method === 'POST');
    await page.getByRole('button', { name: 'Pagar na Retirada' }).click();
    await page.getByRole('button', { name: 'Finalizar Pedido' }).click();

    const dialog = page.getByRole('alertdialog', { name: 'Faça login' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(storeUrl('cart'));
    await expect(cartLine(page, catalog.drink.name)).toBeVisible();
    expect(posts).toEqual([]);
  });

  test('visitante que escolhe entrega é convidado a entrar antes de cadastrar o endereço', async ({ page }) => {
    await page.getByRole('button', { name: 'Delivery', exact: true }).click();
    await expect(page.getByText('Entre na sua conta para cadastrar o endereço de entrega.')).toBeVisible();
    await page.getByRole('button', { name: 'Cadastrar Endereço' }).click();
    await expect(page.getByRole('alertdialog', { name: 'Faça login' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Novo Endereço' })).toHaveCount(0);
  });
});

test.describe('Checkout: endereço de entrega e cotação do servidor', () => {
  test('endereço novo com o CEP fora do ar: cidade e UF preenchidas à mão e o carrinho mostra subtotal, taxa e total do servidor', async ({ page }) => {
    const client = await newClient();
    await page.route(`${API_URL}/addresses/cep/**`, (route) =>
      fulfillJson(route, 502, {
        statusCode: 502,
        message: 'Não foi possível consultar o CEP agora. Preencha o endereço manualmente.',
        error: 'Bad Gateway',
      }),
    );
    await cartAsClient(page, client, async (p) => {
      await addToCart(p, catalog.burger.name, { addons: [catalog.bacon.name] });
      await addToCart(p, catalog.drink.name);
    });
    const subtotal = money(catalog.burger.price, catalog.bacon.price, catalog.drink.price); // 44,40
    await expectServerQuote(page);

    await page.getByRole('button', { name: 'Delivery', exact: true }).click();
    await expect(summaryValue(page, 'Taxa de entrega')).toHaveText('Selecione o endereço');
    await expect(summaryValue(page, 'Total')).toHaveText('--');
    await page.getByRole('button', { name: 'Cadastrar Endereço' }).click();

    const dialog = page.getByRole('dialog', { name: 'Novo Endereço' });
    const field = addressFields(dialog);
    await field.nickname.fill('Trabalho');
    await field.zip.fill('20040003');
    await expect(field.zip).toHaveValue('20040-003');
    await expect(page.getByText('Não foi possível consultar o CEP agora. Preencha o endereço manualmente.')).toBeVisible();

    await field.street.fill('Rua do Ouvidor');
    await field.number.fill('50');
    await field.neighborhood.fill('Centro');
    await field.complement.fill('Sala 301');
    await field.city.fill('Rio de Janeiro');
    await field.state.fill('rj');
    await expect(field.state).toHaveValue('RJ');

    const deliveryQuote = nextQuote(page, (body) => body.type === 'DELIVERY');
    await field.save.click();
    await expect(page.getByText('Endereço salvo com sucesso!')).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('radio', { name: /Trabalho - Rua do Ouvidor, 50/ })).toBeChecked();

    const quote = await deliveryQuote;
    expect(quote).toMatchObject({ subtotal, delivery_fee: 5, total: money(subtotal, 5), estimated_delivery_time: '30-40 min', store_open: true });
    await expect(summaryValue(page, 'Subtotal')).toHaveText(brl(subtotal));
    await expect(summaryValue(page, 'Taxa de entrega')).toHaveText(brl(5));
    await expect(summaryValue(page, 'Total')).toHaveText(brl(money(subtotal, 5)));
    await expect(estimate(page, '30-40 min')).toBeVisible();

    const addresses = await (await client.api.get('/addresses')).json();
    expect(addresses).toHaveLength(1);
    expect(addresses[0]).toMatchObject({
      nickname: 'Trabalho',
      zipCode: '20040003',
      street: 'Rua do Ouvidor',
      number: '50',
      complement: 'Sala 301',
      neighborhood: 'Centro',
      city: 'Rio de Janeiro',
      state: 'RJ',
    });
  });

  test('busca do CEP preenche rua, bairro, cidade e UF e leva o foco para o número', async ({ page }) => {
    const client = await newClient();
    const probe = await client.api.get('/addresses/cep/01001000');
    test.skip([502, 504].includes(probe.status()), 'Sem acesso aos serviços de CEP (internet) neste ambiente');

    await cartAsClient(page, client, (p) => addToCart(p, catalog.drink.name));
    await page.getByRole('button', { name: 'Delivery', exact: true }).click();
    await page.getByRole('button', { name: 'Cadastrar Endereço' }).click();
    const field = addressFields(page.getByRole('dialog', { name: 'Novo Endereço' }));

    await field.zip.fill('01001000');
    await expect(field.street).toHaveValue('Praça da Sé');
    await expect(field.neighborhood).toHaveValue('Sé');
    await expect(field.city).toHaveValue('São Paulo');
    await expect(field.state).toHaveValue('SP');
    await expect(field.number).toBeFocused();
  });

  test('formulário de endereço recusa campos vazios, CEP incompleto e UF inválida com mensagens claras', async ({ page }) => {
    const client = await newClient();
    await page.route(`${API_URL}/addresses/cep/**`, (route) =>
      fulfillJson(route, 404, {
        statusCode: 404,
        message: 'CEP não encontrado. Confira o número ou preencha o endereço manualmente.',
        error: 'Not Found',
      }),
    );
    const posts = trackRequests(page, (method, path) => method === 'POST' && path === '/addresses');
    await cartAsClient(page, client, (p) => addToCart(p, catalog.drink.name));
    await page.getByRole('button', { name: 'Delivery', exact: true }).click();
    await page.getByRole('button', { name: 'Cadastrar Endereço' }).click();
    const dialog = page.getByRole('dialog', { name: 'Novo Endereço' });
    const field = addressFields(dialog);

    await field.save.click();
    await expect(page.getByText('Preencha todos os campos obrigatórios!').first()).toBeVisible();

    await field.street.fill('Rua Visconde de Pirajá');
    await field.number.fill('100');
    await field.neighborhood.fill('Ipanema');
    await field.city.fill('Rio de Janeiro');
    await field.state.fill('RJ');
    await field.zip.fill('22410');
    await field.save.click();
    await expect(page.getByText('CEP inválido. Informe os 8 dígitos.').first()).toBeVisible();

    await field.zip.fill('22410002');
    await expect(page.getByText('CEP não encontrado. Confira o número ou preencha o endereço manualmente.')).toBeVisible();
    await field.state.fill('R');
    await field.save.click();
    await expect(page.getByText('UF inválida. Use a sigla do estado com 2 letras (ex.: RJ).').first()).toBeVisible();
    expect(posts).toHaveLength(0);

    // "XX" tem o formato, mas não é um estado: o formulário recusa sem chamar a API (que também recusaria) e fica aberto
    await field.state.fill('XX');
    await field.save.click();
    await expect(page.getByText('UF inválida. Use a sigla do estado com 2 letras (ex.: RJ).').first()).toBeVisible();
    await expect(dialog).toBeVisible();
    expect(posts).toHaveLength(0);

    await field.state.fill('RJ');
    const saved = page.waitForResponse((r) => r.url() === `${API_URL}/addresses` && r.request().method() === 'POST');
    await field.save.click();
    expect((await saved).status()).toBe(201);
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('radio', { name: /Rua Visconde de Pirajá, 100/ })).toBeChecked();
    expect(posts).toHaveLength(1);
  });

  test('a cotação do servidor acompanha a quantidade, o bairro de entrega e a retirada', async ({ page }) => {
    const client = await newClient();
    await createAddress(client.api, { nickname: 'Praia', neighborhood: 'Copacabana', street: 'Av. Atlântica', number: '1702', zipCode: '22021001' });
    const office = await createAddress(client.api, { nickname: 'Escritório', neighborhood: 'Centro', street: 'Rua da Quitanda', number: '30' });
    await cartAsClient(page, client, (p) => addToCart(p, catalog.drink.name));
    const line = cartLine(page, catalog.drink.name);

    // Retirada (padrão): sem taxa
    await expectServerQuote(page);
    await expect(summaryValue(page, 'Taxa de entrega')).toHaveText('Grátis (retirada)');
    await expect(summaryValue(page, 'Total')).toHaveText(brl(catalog.drink.price));
    await expect(estimate(page, '15-20 min')).toBeVisible();

    // Entrega: primeiro endereço (Copacabana) já selecionado
    let quote = nextQuote(page, (body) => body.type === 'DELIVERY');
    await page.getByRole('button', { name: 'Delivery', exact: true }).click();
    await expect(page.getByRole('radio', { name: /Praia - Av\. Atlântica, 1702/ })).toBeChecked();
    expect(await quote).toMatchObject({ subtotal: 9.9, delivery_fee: 10, total: 19.9, estimated_delivery_time: '50-60 min' });
    await expect(summaryValue(page, 'Taxa de entrega')).toHaveText(brl(10));
    await expect(summaryValue(page, 'Total')).toHaveText(brl(19.9));
    await expect(estimate(page, '50-60 min')).toBeVisible();

    // + quantidade: novo orçamento
    quote = nextQuote(page, (body) => body.items?.[0]?.quantity === 2);
    await line.getByRole('button', { name: 'Aumentar quantidade' }).click();
    expect(await quote).toMatchObject({ subtotal: 19.8, delivery_fee: 10, total: 29.8 });
    await expect(summaryValue(page, 'Subtotal')).toHaveText(brl(19.8));
    await expect(summaryValue(page, 'Total')).toHaveText(brl(29.8));
    await expect(line).toContainText(brl(19.8));

    // Outro bairro: outra taxa
    quote = nextQuote(page, (body) => body.addressId === office.id);
    await page.getByRole('radio', { name: /Escritório - Rua da Quitanda, 30/ }).check();
    expect(await quote).toMatchObject({ delivery_fee: 5, total: 24.8, estimated_delivery_time: '30-40 min' });
    await expect(summaryValue(page, 'Taxa de entrega')).toHaveText(brl(5));
    await expect(summaryValue(page, 'Total')).toHaveText(brl(24.8));

    // De volta à retirada
    await page.getByRole('button', { name: 'Retirada', exact: true }).click();
    await expect(summaryValue(page, 'Taxa de entrega')).toHaveText('Grátis (retirada)');
    await expect(summaryValue(page, 'Total')).toHaveText(brl(19.8));
  });
});

test.describe('Checkout: pagamento na entrega ou na retirada', () => {
  test.beforeEach(async () => {
    await waitForStoreOpen();
  });

  test('dinheiro com troco: pedido confirmado aparece em Meus Pedidos com total e forma de pagamento e o cliente consegue cancelar', async ({ page }) => {
    const client = await newClient('Ana Dinheiro');
    await createAddress(client.api, { nickname: 'Casa', neighborhood: 'Centro', street: 'Rua do Rosário', number: '99' });
    await cartAsClient(page, client, async (p) => {
      await addToCart(p, catalog.burger.name, {
        meatPoint: 'Bem Passado',
        addons: [catalog.bacon.name, catalog.bacon.name],
        removeIngredients: ['Cebola'],
        observation: 'Capricha no molho',
      });
      await addToCart(p, catalog.drink.name);
    });
    const subtotal = money(catalog.burger.price, catalog.bacon.price, catalog.bacon.price, catalog.drink.price); // 48,90
    const total = money(subtotal, 5); // 53,90

    await page.getByRole('button', { name: 'Delivery', exact: true }).click();
    await expect(page.getByRole('radio', { name: /Casa - Rua do Rosário, 99/ })).toBeChecked();
    await expect(summaryValue(page, 'Taxa de entrega')).toHaveText(brl(5));
    await expect(summaryValue(page, 'Total')).toHaveText(brl(total));

    await page.getByRole('button', { name: 'Pagar na Entrega' }).click();
    await expect(page.getByLabel('Forma de Pagamento')).toHaveValue('MONEY');
    await page.getByLabel('Troco para quanto?').fill('10000');
    await expect(page.getByLabel('Troco para quanto?')).toHaveValue(/^R\$\s100,00$/);
    await expect(page.getByText(`O total do pedido é ${brl(total)}`)).toBeVisible();
    await expect(page.getByText('Total a pagar').locator('xpath=following-sibling::p[1]')).toHaveText(brl(total));

    const creation = nextOrderCreation(page);
    await page.getByRole('button', { name: 'Finalizar Pedido' }).click();
    const { status, sent, order: created } = await creation;
    expect(status, JSON.stringify(created)).toBe(201);
    expect(sent).toMatchObject({ type: 'DELIVERY', paymentMethod: 'MONEY' });
    expect(sent.paymentId).toBeUndefined();

    await expect(page).toHaveURL(storeUrl('order-success'));
    await expect(page.getByRole('heading', { name: 'Pedido Confirmado! 🎉' })).toBeVisible();
    await expect(await confirmedOrderLine(page, created.number)).toBeVisible();
    // O aviso traz o número do pedido NA LOJA (pago na entrega: já vem na resposta do POST /orders)
    await expect(page.getByText(`Pedido #${created.number} realizado com sucesso!`)).toBeVisible();
    await expect(cartLink(page)).toHaveAccessibleName('Carrinho');

    // O pedido gravado tem o total da cotação e o retrato dos itens
    const order = await getOrder(client.api, created.id);
    expect(order).toMatchObject({
      status: 'PENDING',
      type: 'DELIVERY',
      payment_method: 'MONEY',
      payment_status: 'PENDING',
      payment_id: null,
      total_price: total,
      delivery_fee: 5,
    });
    expect(String(order.change_for)).toMatch(/100[,.]00/);
    // Retrato do endereço de entrega no pedido (o endereço vivo do cadastro não sai: address = null)
    expect(order.address).toBeNull();
    expect(order.delivery_address).toMatchObject({ street: 'Rua do Rosário', number: '99', neighborhood: 'Centro' });
    expect(order.store).toMatchObject({ slug: 'demo' });
    const burgerItem = order.items.find((item: any) => item.product?.id === catalog.burger.id);
    expect(burgerItem).toMatchObject({
      quantity: 1,
      unit_price: catalog.burger.price,
      meat_point: 'Bem Passado',
      removed_ingredients: ['Cebola'],
      observation: 'Capricha no molho',
    });
    expect(burgerItem.addons_snapshot).toEqual([
      { id: catalog.bacon.id, name: catalog.bacon.name, price: catalog.bacon.price, quantity: 2 },
    ]);
    const drinkItem = order.items.find((item: any) => item.product?.id === catalog.drink.id);
    expect(drinkItem.meat_point ?? null).toBeNull();

    // Meus Pedidos
    await page.getByRole('link', { name: 'Meus Pedidos' }).click();
    await expect(page).toHaveURL(/\/my-orders$/);
    const header = page.getByText(`Pedido #${created.number}`, { exact: true });
    await expect(header).toBeVisible();
    await expect(page.getByText('Aguardando Confirmação', { exact: true })).toBeVisible();
    await expect(page.getByText(brl(total), { exact: true })).toBeVisible();
    await expect(page.getByText(/· Entrega$/)).toBeVisible();

    await header.click();
    await expect(page.getByText('Dinheiro', { exact: true })).toBeVisible();
    await expect(page.getByText(`Pagar na entrega · troco para ${brl(100)}`)).toBeVisible();
    await expect(page.getByText('Taxa de entrega', { exact: true }).locator('xpath=following-sibling::span[1]')).toHaveText(brl(5));
    await expect(page.getByText(`1x ${catalog.burger.name}`)).toBeVisible();
    await expect(page.getByText('🔥 Bem Passado')).toBeVisible();
    await expect(page.getByText(`2x ${catalog.bacon.name}`)).toBeVisible();
    await expect(page.getByText('Sem: Cebola')).toBeVisible();
    await expect(page.getByText('"Capricha no molho"')).toBeVisible();

    // Cancelamento pelo próprio cliente (pedido ainda novo)
    await page.getByRole('button', { name: 'Cancelar Pedido' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Cancelar Pedido?' });
    await confirm.getByRole('button', { name: 'Sim, Cancelar' }).click();
    await expect(page.getByText('Pedido cancelado com sucesso.')).toBeVisible();
    await expect(page.getByText('Cancelado', { exact: true })).toBeVisible();
    await expect(page.getByText(/^Não cobrado/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancelar Pedido' })).toHaveCount(0);
    expect((await getOrder(client.api, created.id)).status).toBe('CANCELED');
  });

  test('troco menor que o total é recusado com mensagem e nenhum pedido é criado', async ({ page }) => {
    const client = await newClient();
    await cartAsClient(page, client, (p) => addToCart(p, catalog.drink.name));
    await expectServerQuote(page);
    const posts = trackRequests(page, (method, path) => method === 'POST' && path === '/orders');

    await page.getByRole('button', { name: 'Pagar na Retirada' }).click();
    await page.getByLabel('Troco para quanto?').fill('500');
    await page.getByRole('button', { name: 'Finalizar Pedido' }).click();

    await expect(
      page.getByRole('alert').filter({ hasText: `O troco deve ser para um valor maior ou igual ao total (${brl(catalog.drink.price)}).` }),
    ).toBeVisible();
    await expect(page).toHaveURL(storeUrl('cart'));
    expect(posts).toEqual([]);
    expect(await listMyOrders(client.api)).toEqual([]);
  });

  test('retirada no balcão com maquininha de crédito: sem taxa, pagamento na retirada e rótulo em português', async ({ page }) => {
    const client = await newClient();
    await cartAsClient(page, client, async (p) => {
      await addToCart(p, catalog.drink.name);
      await addToCart(p, catalog.promo.name);
    });
    const total = money(catalog.drink.price, 15);

    await expect(page.getByRole('heading', { name: 'Retirada na Loja' })).toBeVisible();
    await expect(page.getByRole('main').getByText(/Av\. Rio Branco, 156/)).toBeVisible();
    await expectServerQuote(page);
    await expect(summaryValue(page, 'Taxa de entrega')).toHaveText('Grátis (retirada)');
    await expect(summaryValue(page, 'Total')).toHaveText(brl(total));
    await expect(cartLine(page, catalog.promo.name)).toContainText(brl(15));

    await page.getByRole('button', { name: 'Pagar na Retirada' }).click();
    await page.getByLabel('Forma de Pagamento').selectOption({ label: 'Cartão de crédito (maquininha)' });
    await expect(page.getByLabel('Troco para quanto?')).toHaveCount(0);

    const creation = nextOrderCreation(page);
    await page.getByRole('button', { name: 'Finalizar Pedido' }).click();
    const { status, order: created } = await creation;
    expect(status, JSON.stringify(created)).toBe(201);
    await expect(await confirmedOrderLine(page, created.number)).toBeVisible();

    const order = await getOrder(client.api, created.id);
    expect(order).toMatchObject({
      type: 'TAKEOUT',
      payment_method: 'CREDIT_CARD',
      payment_status: 'PENDING',
      payment_id: null,
      delivery_fee: 0,
      total_price: total,
      change_for: null,
    });
    expect(order.address ?? null).toBeNull();
    expect(order.delivery_address ?? null).toBeNull();
    expect(order.items.find((item: any) => item.product?.id === catalog.promo.id)).toMatchObject({ unit_price: 15 });

    await page.goto('/my-orders');
    await page.getByText(`Pedido #${created.number}`, { exact: true }).click();
    await expect(page.getByText(/· Retirada$/)).toBeVisible();
    await expect(page.getByText('Cartão de crédito', { exact: true })).toBeVisible();
    await expect(page.getByText('Pagar na retirada', { exact: true })).toBeVisible();
    await expect(page.getByText('Taxa de entrega', { exact: true })).toHaveCount(0);
  });
});

test.describe('Checkout: pagamento online', () => {
  test.beforeEach(async () => {
    await waitForStoreOpen();
  });

  test('PIX: QR Code exibido, aprovação automática do sandbox em ~5 s e pedido registrado como pago', async ({ page }) => {
    const client = await newClient('Pedro Pix');
    await createAddress(client.api, { nickname: 'Casa', neighborhood: 'Botafogo', street: 'Rua Voluntários da Pátria', number: '200' });
    await cartAsClient(page, client, (p) => addToCart(p, catalog.drink.name));
    const total = money(catalog.drink.price, 7);

    await page.getByRole('button', { name: 'Delivery', exact: true }).click();
    await expect(summaryValue(page, 'Total')).toHaveText(brl(total));
    await page.getByRole('button', { name: 'PIX', exact: true }).click();

    // A vitrine paga na rota da loja (POST /stores/<slug>/payment/pix)
    const pixResponse = page.waitForResponse((r) => isStoreApiResponse(r, 'POST', '/payment/pix'));
    // Contrato v2: pagamento online não faz POST /orders no navegador — o servidor cria o pedido na aprovação
    const orderPosts = trackRequests(page, (method, path) => method === 'POST' && path === '/orders');
    await page.getByRole('button', { name: new RegExp(`^Gerar PIX de ${brlPattern(total)}$`) }).click();

    const pixRes = await pixResponse;
    const pix = await pixRes.json();
    expect(pixRes.status(), JSON.stringify(pix)).toBe(201);
    const sentToPix = pixRes.request().postDataJSON();
    expect(Object.keys(sentToPix).sort()).toEqual(['idempotencyKey', 'order']);
    expect(typeof sentToPix.idempotencyKey).toBe('string');
    expect(sentToPix.order).toMatchObject({ type: 'DELIVERY', items: [{ productId: catalog.drink.id, quantity: 1 }] });
    expect(pix.amount).toBe(total);

    await expect(page.getByRole('heading', { name: 'Escaneie o QR Code' })).toBeVisible();
    await expect(page.getByText(/Expira em: \d{2}:\d{2}/)).toBeVisible();
    await expect(page.locator('svg[width="200"][height="200"]')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Código PIX copia e cola' })).toHaveValue(pix.qr_code);
    expect(String(pix.qr_code).length).toBeGreaterThan(10);
    if (pix.simulation) {
      await expect(page.getByText('Ambiente de testes: este PIX é aprovado automaticamente em alguns segundos.')).toBeVisible();
    }
    await expect(page.getByText('Aguardando a confirmação do pagamento...')).toBeVisible();

    // Aprovado o PIX, o servidor cria o pedido e a tela mostra o número dele
    await expect(page.getByRole('heading', { name: 'Pedido Confirmado! 🎉' })).toBeVisible({ timeout: 30_000 });
    const status = await (await client.api.get(`/payment/status/${pix.id}`)).json();
    expect(status).toMatchObject({ status: 'approved', orderId: expect.any(Number) });
    const created = await getOrder(client.api, status.orderId as number);
    await expect(await confirmedOrderLine(page, created.number)).toBeVisible();
    expect(orderPosts, 'nenhum POST /orders no pagamento online').toEqual([]);

    const order = await getOrder(client.api, created.id);
    expect(order).toMatchObject({ payment_method: 'PIX', payment_status: 'PAID', payment_id: pix.id, total_price: total, delivery_fee: 7 });

    await page.getByRole('link', { name: 'Meus Pedidos' }).click();
    await page.getByText(`Pedido #${created.number}`, { exact: true }).click();
    await expect(page.getByText('PIX', { exact: true })).toBeVisible();
    await expect(page.getByText('Pago online', { exact: true })).toBeVisible();
  });

  test('PIX cancelado antes da aprovação não cria pedido e o carrinho continua', async ({ page }) => {
    const client = await newClient();
    await cartAsClient(page, client, (p) => addToCart(p, catalog.drink.name));
    await expectServerQuote(page);
    const orderPosts = trackRequests(page, (method, path) => method === 'POST' && path === '/orders');

    await page.getByRole('button', { name: 'PIX', exact: true }).click();
    await page.getByRole('button', { name: /^Gerar PIX de/ }).click();
    await expect(page.getByRole('heading', { name: 'Escaneie o QR Code' })).toBeVisible();
    // O cancelamento pede confirmação (quem já pagou não deve cancelar); desistir mantém o PIX
    await page.getByRole('button', { name: 'Cancelar pagamento' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Cancelar o PIX?' });
    await expect(confirm).toContainText('nenhum pedido é criado');
    await confirm.getByRole('button', { name: 'Cancelar PIX' }).click();

    await expect(page.getByText('Pagamento PIX cancelado. Nenhum pedido foi criado.')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Gerar PIX de/ })).toBeVisible();
    // Passa do prazo de aprovação automática do sandbox (5 s): nada pode ser registrado
    await page.waitForTimeout(8_000);
    expect(orderPosts).toEqual([]);
    expect(await listMyOrders(client.api)).toEqual([]);
    await expect(cartLine(page, catalog.drink.name)).toBeVisible();
  });

  test('PIX em andamento sobrevive a sair e voltar ao carrinho: retoma o mesmo código e não cobra duas vezes', async ({ page }) => {
    const client = await newClient();
    await cartAsClient(page, client, (p) => addToCart(p, catalog.drink.name));
    await expectServerQuote(page);
    const pixPosts = trackRequests(page, (method, path) => method === 'POST' && path === '/payment/pix');

    await page.getByRole('button', { name: 'PIX', exact: true }).click();
    const pixResponse = page.waitForResponse((r) => isStoreApiResponse(r, 'POST', '/payment/pix'));
    await page.getByRole('button', { name: /^Gerar PIX de/ }).click();
    const pix = await (await pixResponse).json();
    await expect(page.getByRole('heading', { name: 'Escaneie o QR Code' })).toBeVisible();

    // O cliente sai do carrinho (ex.: foi ao app do banco) e depois volta
    await page.goto('/');
    await page.goto('/cart');
    await expect(page.getByRole('textbox', { name: 'Código PIX copia e cola' })).toHaveValue(pix.qr_code);

    await expect(page.getByRole('heading', { name: 'Pedido Confirmado! 🎉' })).toBeVisible({ timeout: 30_000 });
    const status = await (await client.api.get(`/payment/status/${pix.id}`)).json();
    expect(status).toMatchObject({ status: 'approved', orderId: expect.any(Number) });
    await expect(await confirmedOrderLine(page, (await getOrder(client.api, status.orderId)).number)).toBeVisible();
    expect(pixPosts, 'um único PIX gerado').toHaveLength(1);
    expect(await getOrder(client.api, status.orderId)).toMatchObject({ payment_status: 'PAID', payment_id: pix.id });
  });

  test('cartão de teste do Mercado Pago é aprovado, o valor vem do servidor e o pedido fica pago', async ({ page }) => {
    const client = await newClient('Carla Cartão');
    await cartAsClient(page, client, (p) => addToCart(p, catalog.drink.name));
    await expectServerQuote(page);
    await expect(page.getByText(/Ambiente de testes: use o cartão 5031 4332 1540 6351/)).toBeVisible();

    await fillCard(page, TEST_CARD);
    await expect(page.getByPlaceholder('0000 0000 0000 0000')).toHaveValue('5031 4332 1540 6351');
    await expect(page.getByPlaceholder('MM/AA')).toHaveValue('11/30');
    await expect(page.getByPlaceholder('000.000.000-00')).toHaveValue('123.456.789-09');

    const cardResponse = page.waitForResponse((r) => isStoreApiResponse(r, 'POST', '/payment/card'), { timeout: 45_000 });
    const orderPosts = trackRequests(page, (method, path) => method === 'POST' && path === '/orders');
    await page.getByRole('button', { name: new RegExp(`^Pagar ${brlPattern(catalog.drink.price)}$`) }).click();

    const cardRes = await cardResponse;
    const payment = await cardRes.json();
    expect(cardRes.status(), JSON.stringify(payment)).toBe(201);
    const sentToCard = cardRes.request().postDataJSON();
    expect(sentToCard).toMatchObject({ order: { type: 'TAKEOUT' }, docNumber: '12345678909' });
    expect(sentToCard.token).toBeTruthy();
    expect(sentToCard.amount).toBeUndefined();
    expect(JSON.stringify(sentToCard)).not.toContain(TEST_CARD.number); // o número do cartão nunca vai para a nossa API
    expect(payment).toMatchObject({ status: 'approved', amount: catalog.drink.price, orderId: expect.any(Number) });
    expect(typeof sentToCard.idempotencyKey).toBe('string');

    // O servidor cria o pedido na aprovação do cartão: nada de POST /orders no navegador
    const created = await getOrder(client.api, payment.orderId as number);
    await expect(page.getByRole('heading', { name: 'Pedido Confirmado! 🎉' })).toBeVisible();
    await expect(await confirmedOrderLine(page, created.number)).toBeVisible();
    expect(orderPosts, 'nenhum POST /orders no pagamento online').toEqual([]);

    expect(await getOrder(client.api, created.id)).toMatchObject({
      payment_method: 'CREDIT_CARD',
      payment_status: 'PAID',
      payment_id: payment.id,
      total_price: catalog.drink.price,
    });
    await page.goto('/my-orders');
    await page.getByText(`Pedido #${created.number}`, { exact: true }).click();
    await expect(page.getByText('Cartão de crédito', { exact: true })).toBeVisible();
    await expect(page.getByText('Pago online', { exact: true })).toBeVisible();
  });

  test('cartão: validações locais (número, bandeira, nome, validade, CVV e CPF) impedem qualquer cobrança', async ({ page }) => {
    const client = await newClient();
    await cartAsClient(page, client, (p) => addToCart(p, catalog.drink.name));
    await expectServerQuote(page);
    const payments = trackRequests(page, (method, path) => method === 'POST' && path.startsWith('/payment'));
    const pay = payNowButton(page);
    const error = (text: string) => page.getByRole('alert').filter({ hasText: text });

    await fillCard(page, { ...TEST_CARD, number: '4111111111111112' });
    await pay.click();
    await expect(error('Número do cartão inválido.')).toBeVisible();

    await fillCard(page, { number: '6011111111111117' });
    await pay.click();
    await expect(error('Bandeira não aceita. Use Visa, Mastercard, Elo, Amex ou Hipercard.')).toBeVisible();

    await fillCard(page, { number: TEST_CARD.number, name: ' ' });
    await pay.click();
    await expect(error('Informe o nome impresso no cartão.')).toBeVisible();

    await fillCard(page, { name: 'APRO', expiry: '0120' });
    await pay.click();
    await expect(error('Validade inválida ou cartão vencido.')).toBeVisible();

    await fillCard(page, { expiry: '1130', cvc: '12' });
    await pay.click();
    await expect(error('O CVV deve ter 3 dígitos.')).toBeVisible();

    await fillCard(page, { cvc: '123', cpf: '11111111111' });
    await pay.click();
    await expect(error('CPF do titular inválido.')).toBeVisible();

    expect(payments).toEqual([]);
  });

  test('sem o SDK do Mercado Pago (sem internet) a tela avisa, não cobra e o PIX continua disponível', async ({ page }) => {
    await page.route('https://sdk.mercadopago.com/**', (route) => route.abort('internetdisconnected'));
    const client = await newClient();
    await cartAsClient(page, client, (p) => addToCart(p, catalog.drink.name));
    await expectServerQuote(page);
    const payments = trackRequests(page, (method, path) => method === 'POST' && path.startsWith('/payment'));

    await fillCard(page, TEST_CARD);
    await payNowButton(page).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'O sistema de pagamento com cartão não carregou. Verifique sua conexão ou pague via PIX.' }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(payNowButton(page)).toBeEnabled();
    expect(payments).toEqual([]);

    await page.getByRole('button', { name: 'PIX', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Gerar PIX de/ })).toBeEnabled();
  });

  test('conta da equipe no carrinho vê o modo administrativo e não consegue pagar nem cotar', async ({ page }) => {
    await signInAs(page, 'employee');
    await openHome(page);
    await addToCart(page, catalog.drink.name);
    const calls = trackRequests(page, (method, path) => path === '/orders/quote' || path === '/orders' || path.startsWith('/payment'));
    const sdkRequests = trackMercadoPagoSdk(page);
    await openCart(page);

    await expect(page.getByText('Modo Administrativo')).toBeVisible();
    await expect(page.getByText('Você está logado como membro da equipe. A realização de pedidos está bloqueada.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pagar na Retirada' })).toBeDisabled();
    // Conta interna: o formulário de cartão nem monta (só o PIX, desabilitado, com o motivo)
    const payment = page.getByRole('region', { name: 'Pagamento' });
    await expect(payment.getByRole('button', { name: 'Cartão de Crédito' })).toHaveCount(0);
    await expect(payment.getByRole('group', { name: 'Dados do cartão de crédito' })).toHaveCount(0);
    await expect(payNowButton(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Gerar (PIX de|QR Code PIX)/ })).toBeDisabled();
    await expect(page.getByText('Contas da equipe não fazem pedidos pela loja.')).toBeVisible();
    expect(calls).toEqual([]);
    // O SDK de terceiros não roda no mesmo documento que guarda o token da equipe
    await expect(page.locator('script#mercadopago-sdk')).toHaveCount(0);
    expect(sdkRequests).toEqual([]);
  });

  test('superadministrador no carrinho: compra bloqueada, sem formulário de cartão e sem o SDK do Mercado Pago', async ({ page }) => {
    await signInAs(page, 'superadmin');
    await openHome(page);
    await addToCart(page, catalog.drink.name);
    const calls = trackRequests(page, (method, path) => path === '/orders/quote' || path === '/orders' || path.startsWith('/payment'));
    const sdkRequests = trackMercadoPagoSdk(page);
    await openCart(page);

    await expect(page.getByText('Modo Administrativo')).toBeVisible();
    await expect(
      page.getByText('Você está logado com uma conta da administração da plataforma. A realização de pedidos está bloqueada.'),
    ).toBeVisible();
    await expect(page.getByText('Contas da administração da plataforma não fazem pedidos. Use uma conta de cliente.')).toBeVisible();
    const payment = page.getByRole('region', { name: 'Pagamento' });
    await expect(payment.getByRole('button', { name: 'Cartão de Crédito' })).toHaveCount(0);
    await expect(payment.getByRole('group', { name: 'Dados do cartão de crédito' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Gerar (PIX de|QR Code PIX)/ })).toBeDisabled();
    await page.waitForLoadState('networkidle');
    expect(calls, 'nenhuma cotação, pedido ou cobrança').toEqual([]);
    await expect(page.locator('script#mercadopago-sdk')).toHaveCount(0);
    expect(sdkRequests).toEqual([]);
  });
});
