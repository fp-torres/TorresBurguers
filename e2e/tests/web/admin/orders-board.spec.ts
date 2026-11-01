import { test, expect, type Page, type Route } from '@playwright/test';
import { E2E } from '../../../support/env';
import { signInAs } from '../../../support/web';
import type { DefaultUserKey } from '../../../support/users';
import {
  API_URL,
  BOARD_COLUMNS,
  Customer,
  StaffApi,
  boardColumn,
  money,
  orderCard,
  orderCardHeading,
  pageHeading,
  toast,
  trackApiFailures,
  uid,
  waitForApi,
  type ApiAddon,
  type ApiOrder,
  type ApiProduct,
  type ApiUser,
  type PaymentMethod,
} from './helpers';

const BOARD_TITLES: Record<DefaultUserKey, string | RegExp> = {
  admin: 'Gestão de Pedidos',
  employee: 'Gestão de Pedidos',
  kitchen: /^Monitor da Cozinha/,
  courier: /^Painel de Entregas/,
  // Clientes e o superadmin (contas sem loja) não têm quadro de pedidos
  client: '',
  superadmin: '',
};

const RAW_CODES = /\b(MONEY|PIX_|CREDIT_CARD|DEBIT_CARD|DINHEIRO|CARTAO_\w+|PENDING|PREPARING|READY_FOR_PICKUP|DELIVERING|DONE|CANCELED|PAID|DELIVERY|TAKEOUT)\b/;

let admin: StaffApi;
let kitchen: StaffApi;
let courier: StaffApi;
let customer: Customer;
let product: ApiProduct;
let bacon: ApiAddon;
let otherCourier: ApiUser & { password: string };
const createdOrders: number[] = [];

test.beforeAll(async () => {
  admin = await StaffApi.as('admin');
  kitchen = await StaffApi.as('kitchen');
  courier = await StaffApi.as('courier');
  bacon = await admin.createAddon(`Bacon Quadro ${uid('a')}`, 4);
  product = await admin.createProduct({
    name: `Quadro Burger ${uid('p')}`,
    price: 30,
    allowed_addons_ids: [bacon.id],
    ingredients: ['Pão', 'Carne', 'Cebola'],
  });
  customer = await Customer.create();
  otherCourier = await admin.createStaff('COURIER', { name: `Motoboy WA ${uid('m')}` });
});

test.afterAll(async () => {
  // Não deixa pedidos deste arquivo abertos no quadro de todo mundo
  for (const id of createdOrders) {
    const order = await admin.getOrder(id).catch(() => undefined);
    if (order && !['DONE', 'CANCELED'].includes(order.status)) await admin.ctx.patch(`/orders/${id}/cancel`);
  }
  await admin.ctx.delete(`/products/${product.id}`);
  await admin.ctx.delete(`/addons/${bacon.id}`);
  await admin.ctx.delete(`/users/${otherCourier.id}`);
  await customer.dispose();
  await Promise.all([admin.dispose(), kitchen.dispose(), courier.dispose()]);
});

async function newOrder(
  opts: { type?: 'DELIVERY' | 'TAKEOUT'; paymentMethod?: PaymentMethod; changeFor?: string; paymentId?: number; who?: Customer } = {},
): Promise<ApiOrder> {
  const order = await (opts.who ?? customer).order({
    items: [{ productId: product.id, quantity: 1 }],
    type: opts.type ?? 'DELIVERY',
    paymentMethod: opts.paymentMethod ?? 'MONEY',
    changeFor: opts.changeFor,
    paymentId: opts.paymentId,
  });
  createdOrders.push(order.id);
  return order;
}

async function openBoard(page: Page, key: DefaultUserKey) {
  await signInAs(page, key);
  await page.goto('/orders');
  await expect(pageHeading(page, BOARD_TITLES[key])).toBeVisible({ timeout: 20_000 });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test.describe('Quadro de pedidos: cozinha', () => {
  test('cozinha aceita o pedido novo e o marca como pronto (PENDING → PREPARING → READY)', async ({ page }) => {
    const order = await newOrder({ type: 'DELIVERY' });
    await openBoard(page, 'kitchen');
    const failures = trackApiFailures(page);

    const card = orderCard(page, order.id);
    await expect(card.getByText('Novo', { exact: true })).toBeVisible();
    // Título do card: o número do pedido NA LOJA, não o id global
    expect(order.number, 'número do pedido na resposta da API').toEqual(expect.any(Number));
    await expect(orderCardHeading(card, order.number)).toBeVisible();
    await expect(card).toContainText(customer.name);
    await expect(card).toContainText(product.name);
    await expect(card.getByRole('button', { name: 'Cancelar Pedido' }), 'cozinha não cancela pedidos').toHaveCount(0);
    await expect(card.getByRole('link', { name: /Google Maps/ })).toHaveCount(0);

    await card.getByRole('button', { name: 'Aceitar e Preparar' }).click();
    await expect(toast(page, 'Enviado para a cozinha!')).toBeVisible();
    await expect(card.getByText('Em preparo', { exact: true })).toBeVisible();

    await card.getByRole('button', { name: 'Chamar Motoboy' }).click();
    await expect(toast(page, 'Pedido Liberado!')).toBeVisible();
    await expect(orderCard(page, order.id), 'pronto sai do quadro da cozinha').toHaveCount(0);

    expect((await admin.getOrder(order.id)).status).toBe('READY_FOR_PICKUP');
    expect(failures, 'ações da cozinha recusadas pela API').toEqual([]);
  });

  test('cozinha vê adicionais, ponto da carne, ingredientes retirados e observação, e usa "Pronto (Balcão)" na retirada', async ({ page }) => {
    const order = await customer.order({
      items: [
        {
          productId: product.id,
          quantity: 2,
          addonIds: [bacon.id, bacon.id],
          meatPoint: 'Mal Passado',
          removedIngredients: ['Cebola'],
          observation: 'Capricha no molho',
        },
      ],
      type: 'TAKEOUT',
      paymentMethod: 'DEBIT_CARD',
    });
    createdOrders.push(order.id);
    await openBoard(page, 'kitchen');
    const failures = trackApiFailures(page);

    const card = orderCard(page, order.id);
    await expect(card).toContainText(new RegExp(`2x\\s*${escapeRegExp(product.name)}`));
    await expect(card.getByText('Ponto: Mal Passado')).toBeVisible();
    await expect(card.getByText('Sem: Cebola')).toBeVisible();
    await expect(card.getByText(`+ 2x ${bacon.name}`)).toBeVisible();
    await expect(card.getByText('Obs: Capricha no molho')).toBeVisible();
    await expect(card.getByText('Retirada no Balcão')).toBeVisible();

    await card.getByRole('button', { name: 'Aceitar e Preparar' }).click();
    await expect(card.getByText('Em preparo', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Chamar Motoboy' })).toHaveCount(0);
    await card.getByRole('button', { name: 'Pronto (Balcão)' }).click();
    await expect(toast(page, 'Pedido Liberado!')).toBeVisible();
    await expect(orderCard(page, order.id)).toHaveCount(0);

    expect((await admin.getOrder(order.id)).status).toBe('READY_FOR_PICKUP');
    expect(failures).toEqual([]);
  });

  test('cozinha vê só as colunas Novos e Preparando', async ({ page }) => {
    await openBoard(page, 'kitchen');
    await expect(boardColumn(page, 'Novos')).toBeVisible();
    await expect(boardColumn(page, 'Preparando')).toBeVisible();
    for (const column of ['Aguardando Motoboy', 'Retirar no Balcão', 'Em Entrega', 'Concluídos', 'Cancelados']) {
      await expect(boardColumn(page, column), column).toHaveCount(0);
    }
  });

  test('pedido novo aparece no quadro da cozinha sem recarregar a página', async ({ page }) => {
    await openBoard(page, 'kitchen');
    await expect(boardColumn(page, 'Novos')).toBeVisible();
    const order = await newOrder();
    await expect(orderCard(page, order.id)).toBeVisible({ timeout: 15_000 });
    await expect(orderCard(page, order.id).getByText('Novo', { exact: true })).toBeVisible();
  });
});

test.describe('Quadro de pedidos: entregador', () => {
  test('entregador pega o pedido pronto, fica registrado como motoboy e confirma a entrega', async ({ page }) => {
    const order = await newOrder({ type: 'DELIVERY', paymentMethod: 'MONEY', changeFor: 'R$ 100,00' });
    await kitchen.advance(order.id, 'PREPARING', 'READY_FOR_PICKUP');
    const me = courier.session.user;
    await openBoard(page, 'courier');
    const failures = trackApiFailures(page);

    const card = orderCard(page, order.id);
    await expect(card.getByText('Aguardando', { exact: true })).toBeVisible();
    await expect(card).toContainText('TROCO NECESSÁRIO');
    await expect(card).toContainText(/Paga com:\s*R\$\s100,00/);
    await expect(card).toContainText(new RegExp(`Levar:\\s*${money(100 - order.total_price).source}`));
    await expect(card.getByRole('link', { name: /Abrir no Google Maps/ })).toHaveAttribute('href', /google\.com\/maps/);

    await card.getByRole('button', { name: 'Pegar para Entrega' }).click();
    await expect(toast(page, 'Saiu para entrega!')).toBeVisible();
    await expect(card.getByText('Em entrega', { exact: true })).toBeVisible();
    await expect(card).toContainText(`Motoboy: ${me.name}`);
    let saved = await admin.getOrder(order.id);
    expect(saved.status).toBe('DELIVERING');
    expect(saved.driver?.id, 'entregador registrado no pedido').toBe(me.id);

    await card.getByRole('button', { name: 'Confirmar Entrega' }).click();
    await expect(toast(page, 'Pedido finalizado!')).toBeVisible();
    await expect(orderCard(page, order.id), 'concluído sai do painel de entregas').toHaveCount(0);
    saved = await admin.getOrder(order.id);
    expect(saved.status).toBe('DONE');
    expect(saved.payment_status, 'pago na entrega fica quitado').toBe('PAID');
    expect(saved.driver?.id).toBe(me.id);
    expect(failures, 'ações do entregador recusadas pela API').toEqual([]);
  });

  test('entregador não vê pedidos de balcão nem as colunas da cozinha e do balcão', async ({ page }) => {
    const takeout = await newOrder({ type: 'TAKEOUT' });
    await kitchen.advance(takeout.id, 'PREPARING', 'READY_FOR_PICKUP');
    const pending = await newOrder({ type: 'DELIVERY' });
    await openBoard(page, 'courier');

    await expect(boardColumn(page, 'Aguardando Motoboy')).toBeVisible();
    await expect(boardColumn(page, 'Em Entrega')).toBeVisible();
    for (const column of ['Novos', 'Preparando', 'Retirar no Balcão', 'Concluídos', 'Cancelados']) {
      await expect(boardColumn(page, column), column).toHaveCount(0);
    }
    await expect(orderCard(page, takeout.id), 'pedido de balcão').toHaveCount(0);
    await expect(orderCard(page, pending.id), 'pedido ainda na cozinha').toHaveCount(0);
  });

  // O entregador lê só a própria etapa (docs/saas/arquitetura.md §4.3): as entregas prontas sem entregador e
  // as dele. Uma entrega pronta sem entregador serve de controle (o quadro carregou) nos dois testes abaixo
  async function readyDelivery() {
    const ready = await newOrder();
    await kitchen.advance(ready.id, 'PREPARING', 'READY_FOR_PICKUP');
    return ready;
  }

  test('entregador não vê a entrega atribuída a outro entregador', async ({ page }) => {
    const order = await newOrder();
    await kitchen.advance(order.id, 'PREPARING', 'READY_FOR_PICKUP');
    await admin.assign(order.id, otherCourier.id);
    const control = await readyDelivery();
    await openBoard(page, 'courier');

    await expect(orderCard(page, control.id), 'entrega pronta sem entregador (controle)').toBeVisible();
    await expect(orderCard(page, order.id), 'entrega de outro entregador fora do quadro').toHaveCount(0);
    await expect(page.getByText(`Motoboy: ${otherCourier.name}`)).toHaveCount(0);
  });

  test('entregador não vê um pedido em entrega sem entregador definido (nem recebe ações que a API recusaria)', async ({ page }) => {
    const order = await newOrder();
    await admin.advance(order.id, 'PREPARING', 'READY_FOR_PICKUP', 'DELIVERING');
    expect((await admin.getOrder(order.id)).driver, 'pedido em entrega sem entregador').toBeNull();
    const control = await readyDelivery();
    await openBoard(page, 'courier');
    const failures = trackApiFailures(page);

    await expect(orderCard(page, control.id), 'entrega pronta sem entregador (controle)').toBeVisible();
    await expect(orderCard(page, order.id), 'pedido em entrega sem entregador fora do quadro').toHaveCount(0);
    expect(failures, 'o quadro do entregador sem recusas da API').toEqual([]);
  });
});

test.describe('Quadro de pedidos: atendente e administrador', () => {
  for (const [key, label] of [['employee', 'atendente'], ['admin', 'administrador']] as const) {
    test(`${label} vê todas as colunas do quadro e o controle da loja`, async ({ page }) => {
      await openBoard(page, key);
      for (const column of BOARD_COLUMNS) await expect(boardColumn(page, column), column).toBeVisible();
      await expect(page.getByRole('switch')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Atualizar' })).toBeVisible();
    });
  }

  test('atendente cancela um pedido novo depois de confirmar (desistir não cancela)', async ({ page }) => {
    const order = await newOrder();
    await openBoard(page, 'employee');
    const failures = trackApiFailures(page);

    const card = orderCard(page, order.id);
    await card.getByRole('button', { name: 'Cancelar Pedido' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Cancelar Pedido?' });
    await expect(dialog).toContainText('Deseja realmente cancelar este pedido?');
    await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect((await admin.getOrder(order.id)).status).toBe('PENDING');

    await card.getByRole('button', { name: 'Cancelar Pedido' }).click();
    const res = waitForApi(page, 'PATCH', new RegExp(`^/orders/${order.id}(/cancel)?$`));
    await page.getByRole('alertdialog', { name: 'Cancelar Pedido?' }).getByRole('button', { name: 'Sim, Cancelar Pedido' }).click();
    expect((await res).status()).toBe(200);
    await expect(toast(page, 'Pedido cancelado.')).toBeVisible();
    expect((await admin.getOrder(order.id)).status).toBe('CANCELED');
    await expect(card.getByRole('button')).toHaveCount(0);
    expect(failures).toEqual([]);
  });

  test('administrador cancela um pedido que já está em preparo', async ({ page }) => {
    const order = await newOrder({ type: 'TAKEOUT' });
    await kitchen.advance(order.id, 'PREPARING');
    await openBoard(page, 'admin');
    const failures = trackApiFailures(page);

    const card = orderCard(page, order.id);
    await expect(card.getByText('Em preparo', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Cancelar Pedido' }).click();
    await page.getByRole('alertdialog', { name: 'Cancelar Pedido?' }).getByRole('button', { name: 'Sim, Cancelar Pedido' }).click();
    await expect(toast(page, 'Pedido cancelado.')).toBeVisible();
    expect((await admin.getOrder(order.id)).status).toBe('CANCELED');
    expect(failures).toEqual([]);
  });

  test('administrador despacha o pedido pronto pelo modal de logística escolhendo o entregador', async ({ page }) => {
    const order = await newOrder();
    await kitchen.advance(order.id, 'PREPARING', 'READY_FOR_PICKUP');
    await openBoard(page, 'admin');
    const failures = trackApiFailures(page);

    const card = orderCard(page, order.id);
    await expect(card.getByText('Aguardando', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Pegar para Entrega' })).toHaveCount(0);
    await card.getByRole('button', { name: 'Despachar (Logística)' }).click();

    const modal = page.getByRole('dialog', { name: 'Logística de Entrega' });
    // Número do pedido NA LOJA (o id é interno)
    await expect(modal).toContainText(`Pedido Principal: #${order.number}`);
    await expect(modal).toContainText(customer.neighborhood);
    const confirm = modal.getByRole('button', { name: 'CONFIRMAR DESPACHO' });
    await expect(confirm).toBeDisabled();
    await modal.getByRole('button', { name: new RegExp(escapeRegExp(otherCourier.name)) }).click();
    await expect(confirm).toBeEnabled();

    const res = waitForApi(page, 'PATCH', `/orders/${order.id}/assign`);
    await confirm.click();
    expect((await res).status()).toBe(200);
    await expect(toast(page, '1 pedido(s) despachado(s) com sucesso!')).toBeVisible();
    await expect(modal).toBeHidden();
    await expect(card.getByText('Em entrega', { exact: true })).toBeVisible();
    await expect(card).toContainText(`Motoboy: ${otherCourier.name}`);

    const saved = await admin.getOrder(order.id);
    expect(saved.status).toBe('DELIVERING');
    expect(saved.driver?.id).toBe(otherCourier.id);
    expect(failures).toEqual([]);
  });

  test('atendente despacha dois pedidos do mesmo bairro de uma vez pela sugestão de rota', async ({ page }) => {
    const neighbor = await Customer.create();
    const first = await newOrder({ who: neighbor });
    const second = await newOrder({ who: neighbor });
    await kitchen.advance(first.id, 'PREPARING', 'READY_FOR_PICKUP');
    await kitchen.advance(second.id, 'PREPARING', 'READY_FOR_PICKUP');
    await openBoard(page, 'employee');
    const failures = trackApiFailures(page);

    await orderCard(page, first.id).getByRole('button', { name: 'Despachar (Logística)' }).click();
    const modal = page.getByRole('dialog', { name: 'Logística de Entrega' });
    await expect(modal.getByText(`Sugestão: Mesmo Bairro (${neighbor.neighborhood})`)).toBeVisible();
    await expect(modal).toContainText(/Entregas Selecionadas:\s*1/);
    await modal.getByText(new RegExp(`^#${second.number} - `)).click();
    await expect(modal).toContainText(/Entregas Selecionadas:\s*2/);
    await modal.getByRole('button', { name: new RegExp(escapeRegExp(otherCourier.name)) }).click();
    await modal.getByRole('button', { name: 'CONFIRMAR DESPACHO' }).click();
    await expect(toast(page, '2 pedido(s) despachado(s) com sucesso!')).toBeVisible();
    await expect(modal).toBeHidden();

    for (const id of [first.id, second.id]) {
      const saved = await admin.getOrder(id);
      expect(saved.status, `pedido #${id}`).toBe('DELIVERING');
      expect(saved.driver?.id, `pedido #${id}`).toBe(otherCourier.id);
    }
    expect(failures).toEqual([]);
    await neighbor.dispose();
  });

  test('administrador conduz um pedido de balcão até "Entregue ao Cliente" e o pagamento fica quitado', async ({ page }) => {
    const order = await newOrder({ type: 'TAKEOUT', paymentMethod: 'CREDIT_CARD' });
    await openBoard(page, 'admin');
    const failures = trackApiFailures(page);

    const card = orderCard(page, order.id);
    await expect(card).toContainText('Retirada no Balcão');
    await expect(card).toContainText('Cartão de crédito');
    await expect(card).toContainText('Cobrar na retirada');

    await card.getByRole('button', { name: 'Aceitar e Preparar' }).click();
    await expect(toast(page, 'Enviado para a cozinha!')).toBeVisible();
    await card.getByRole('button', { name: 'Pronto (Balcão)' }).click();
    await expect(toast(page, 'Pedido Liberado!')).toBeVisible();
    await expect(card.getByText('Balcão', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Despachar (Logística)' }), 'balcão não vai para entrega').toHaveCount(0);

    await card.getByRole('button', { name: 'Entregue ao Cliente' }).click();
    await expect(toast(page, 'Pedido finalizado!')).toBeVisible();
    const saved = await admin.getOrder(order.id);
    expect(saved.status).toBe('DONE');
    expect(saved.payment_status).toBe('PAID');
    expect(failures).toEqual([]);
  });

  test('nenhuma ação oferecida ao atendente é recusada pela API (novo, em preparo, balcão e em entrega)', async ({ page }) => {
    const pending = await newOrder();
    const preparing = await newOrder();
    await kitchen.advance(preparing.id, 'PREPARING');
    const readyTakeout = await newOrder({ type: 'TAKEOUT' });
    await kitchen.advance(readyTakeout.id, 'PREPARING', 'READY_FOR_PICKUP');
    const delivering = await newOrder();
    await kitchen.advance(delivering.id, 'PREPARING', 'READY_FOR_PICKUP');
    await admin.assign(delivering.id, otherCourier.id);

    await openBoard(page, 'employee');
    const failures = trackApiFailures(page);
    const steps: [number, string, string, string][] = [
      [pending.id, 'Aceitar e Preparar', 'Enviado para a cozinha!', 'PREPARING'],
      [preparing.id, 'Chamar Motoboy', 'Pedido Liberado!', 'READY_FOR_PICKUP'],
      [readyTakeout.id, 'Entregue ao Cliente', 'Pedido finalizado!', 'DONE'],
      [delivering.id, 'Confirmar Entrega', 'Pedido finalizado!', 'DONE'],
    ];
    for (const [id, action, message, status] of steps) {
      const res = waitForApi(page, 'PATCH', `/orders/${id}`);
      await orderCard(page, id).getByRole('button', { name: action }).click();
      expect((await res).status(), `${action} no pedido #${id}`).toBe(200);
      await expect(toast(page, message)).toBeVisible();
      expect((await admin.getOrder(id)).status, `pedido #${id}`).toBe(status);
    }
    expect(failures).toEqual([]);
  });

  test('formas e situação de pagamento aparecem em português nos cards', async ({ page }) => {
    const items = [{ productId: product.id, quantity: 1 }];
    const cash = await newOrder({ type: 'DELIVERY', paymentMethod: 'MONEY', changeFor: 'R$ 100,00' });
    const debit = await newOrder({ type: 'TAKEOUT', paymentMethod: 'DEBIT_CARD' });
    const cardPaid = await newOrder({ type: 'DELIVERY', paymentMethod: 'CREDIT_CARD', paymentId: await customer.payByCard(items, 'DELIVERY') });
    const pixPaid = await newOrder({ type: 'TAKEOUT', paymentMethod: 'PIX', paymentId: await customer.payByPix(items, 'TAKEOUT') });
    expect(cardPaid.payment_status).toBe('PAID');
    expect(pixPaid.payment_status).toBe('PAID');
    await openBoard(page, 'employee');

    const cashCard = orderCard(page, cash.id);
    await expect(cashCard).toContainText('Dinheiro');
    await expect(cashCard).toContainText('Cobrar na entrega');
    await expect(cashCard).toContainText('TROCO NECESSÁRIO');
    await expect(cashCard).toContainText(/Paga com:\s*R\$\s100,00/);
    await expect(cashCard).toContainText(new RegExp(`Levar:\\s*${money(100 - cash.total_price).source}`));

    const debitCard = orderCard(page, debit.id);
    await expect(debitCard).toContainText('Cartão de débito');
    await expect(debitCard).toContainText('Cobrar na retirada');

    const creditCard = orderCard(page, cardPaid.id);
    await expect(creditCard).toContainText('Cartão de crédito');
    await expect(creditCard).toContainText('Pago online');
    await expect(creditCard).not.toContainText('TROCO');

    const pixCard = orderCard(page, pixPaid.id);
    await expect(pixCard).toContainText('PIX');
    await expect(pixCard).toContainText('Pago online');

    for (const [label, card] of [['dinheiro', cashCard], ['débito', debitCard], ['crédito', creditCard], ['pix', pixCard]] as const) {
      await expect(card, `card ${label} sem códigos crus`).not.toContainText(RAW_CODES);
    }
  });
});

test.describe('Quadro de pedidos: dados antigos', () => {
  const CORS_HEADERS = { 'access-control-allow-origin': E2E.webURL, 'access-control-allow-credentials': 'true' };

  function legacyOrder(id: number, overrides: Record<string, unknown>) {
    return {
      id,
      status: 'PENDING',
      type: 'TAKEOUT',
      payment_method: 'MONEY',
      payment_status: 'PENDING',
      payment_id: null,
      total_price: '42.00',
      delivery_fee: '0.00',
      change_for: null,
      created_at: new Date().toISOString(),
      user: { id: 999, name: 'Cliente Legado', email: 'legado@e2e.test', phone: null },
      driver: null,
      address: null,
      items: [
        {
          id: id * 10,
          quantity: 1,
          product: { id: 1, name: 'Produto Legado', price: '42.00', image: null },
          addons: [{ id: 7, name: 'Ovo', price: '2.00' }],
          addons_snapshot: null,
          observation: null,
          meat_point: null,
          removed_ingredients: null,
        },
      ],
      ...overrides,
    };
  }

  test('pedidos antigos com códigos legados aparecem traduzidos e pedidos concluídos ou cancelados não têm ações', async ({ page }) => {
    const orders = [
      legacyOrder(990003, { status: 'PENDING', payment_method: 'CARTAO_DEBITO' }),
      legacyOrder(990002, { status: 'CANCELED', payment_method: 'CARTAO_CREDITO' }),
      legacyOrder(990001, {
        status: 'DONE',
        type: 'DELIVERY',
        payment_method: 'DINHEIRO',
        payment_status: 'PAID',
        change_for: '50',
        driver: { id: 3, name: 'Entregador Legado', phone: '21900000003', avatar: null },
        address: { street: 'Rua Antiga', number: '1', neighborhood: 'Centro', city: 'Rio de Janeiro', state: 'RJ', complement: null },
      }),
    ];
    await page.route(
      (url) => url.href.startsWith(API_URL) && new URL(url.href).pathname === '/orders',
      (route: Route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_HEADERS, body: JSON.stringify(orders) })
          : route.continue(),
    );
    await openBoard(page, 'admin');

    const pending = orderCard(page, 990003);
    await expect(pending).toContainText('Cartão de débito');
    await expect(pending.getByText('Novo', { exact: true })).toBeVisible();
    await expect(pending.getByRole('button', { name: 'Aceitar e Preparar' })).toBeVisible();
    await expect(pending.getByRole('button', { name: 'Cancelar Pedido' })).toBeVisible();
    await expect(pending).toContainText('+ Ovo');

    const canceled = orderCard(page, 990002);
    await expect(canceled).toContainText('Cartão de crédito');
    await expect(canceled.getByText('Cancelado', { exact: true })).toBeVisible();
    await expect(canceled.getByRole('button'), 'cancelado não tem ações').toHaveCount(0);
    await expect(canceled).not.toContainText('Cobrar');

    const done = orderCard(page, 990001);
    await expect(done).toContainText('Dinheiro');
    await expect(done.getByText('Concluído', { exact: true })).toBeVisible();
    await expect(done).toContainText('Pago');
    await expect(done).toContainText('Motoboy: Entregador Legado');
    await expect(done.getByRole('button'), 'concluído não tem ações').toHaveCount(0);
    await expect(done, 'pedido já pago não pede troco').not.toContainText('TROCO NECESSÁRIO');

    for (const card of [pending, canceled, done]) await expect(card).not.toContainText(RAW_CODES);
  });

  /** Serve GET /orders (quadro) com `orders` e conta as consultas. */
  async function serveBoard(page: Page, orders: unknown[]): Promise<{ count: () => number }> {
    let requests = 0;
    await page.route(
      (url) => url.href.startsWith(API_URL) && new URL(url.href).pathname === '/orders',
      (route: Route) => {
        if (route.request().method() !== 'GET') return route.continue();
        requests += 1;
        return route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_HEADERS, body: JSON.stringify(orders) });
      },
    );
    return { count: () => requests };
  }

  test('pagamento estornado no Mercado Pago sem o pedido cancelado aparece como "Estornado" com alerta para não entregar sem receber', async ({ page }) => {
    const address = { street: 'Rua do Estorno', number: '7', neighborhood: 'Centro', city: 'Rio de Janeiro', state: 'RJ', complement: null };
    await serveBoard(page, [
      // Estorno/contestação feito no Mercado Pago com o pedido em preparo (payment_status REFUNDED, status não CANCELED)
      legacyOrder(990013, { status: 'PREPARING', type: 'DELIVERY', payment_method: 'PIX', payment_status: 'REFUNDED', payment_id: 7713, address }),
      // Cancelado com devolução: o caso comum, sem alerta
      legacyOrder(990012, { status: 'CANCELED', payment_method: 'PIX', payment_status: 'REFUNDED', payment_id: 7712 }),
      // Contestação depois da entrega
      legacyOrder(990011, { status: 'DONE', payment_method: 'PIX', payment_status: 'REFUNDED', payment_id: 7711 }),
    ]);
    await openBoard(page, 'admin');

    const banner = page.getByRole('alert').filter({ hasText: 'Pagamento estornado no Mercado Pago em 1 pedido(s) em andamento' });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('não entregue sem receber');

    const reversed = orderCard(page, 990013);
    await expect(reversed).toContainText('Estornado no Mercado Pago');
    const alert = reversed.getByRole('alert');
    await expect(alert).toContainText('PAGAMENTO ESTORNADO');
    await expect(alert).toContainText('Não entregue sem receber de outra forma, ou cancele o pedido.');
    await expect(reversed.getByRole('button', { name: 'Cancelar Pedido' }), 'a loja pode cancelar o pedido estornado').toBeVisible();

    const canceled = orderCard(page, 990012);
    await expect(canceled.getByText('Estornado', { exact: true })).toBeVisible();
    await expect(canceled.getByRole('alert'), 'cancelado e estornado não tem alerta').toHaveCount(0);

    const done = orderCard(page, 990011);
    await expect(done.getByRole('alert')).toContainText('depois da entrega');

    for (const card of [reversed, canceled, done]) await expect(card).not.toContainText(RAW_CODES);
  });

  test('o quadro pausa a consulta de 5 s com a aba oculta e atualiza na hora ao voltar', async ({ page }) => {
    const board = await serveBoard(page, [legacyOrder(990021, { status: 'PENDING' })]);
    await openBoard(page, 'admin');
    await expect(orderCard(page, 990021)).toBeVisible();
    await expect.poll(board.count, { message: 'consulta automática com a aba visível', timeout: 12_000 }).toBeGreaterThan(1);

    const setVisibility = (state: 'hidden' | 'visible') =>
      page.evaluate((value) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => value === 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      }, state);

    await setVisibility('hidden');
    // Uma consulta que já tinha saído pode terminar logo depois de ocultar a aba
    await page.waitForTimeout(500);
    const hiddenCount = board.count();
    await page.waitForTimeout(11_000);
    expect(board.count(), 'nenhuma consulta com a aba oculta (mais de 2 ciclos de 5 s)').toBe(hiddenCount);

    await setVisibility('visible');
    await expect.poll(board.count, { message: 'atualiza ao voltar, sem esperar o intervalo', timeout: 2_000 }).toBeGreaterThan(hiddenCount);
  });
});
