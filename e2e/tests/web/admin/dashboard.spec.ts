import { test, expect, type Page, type Route } from '@playwright/test';
import { signInAs } from '../../../support/web';
import {
  API_URL,
  Customer,
  StaffApi,
  money,
  pageHeading,
  trackApiFailures,
  trackConsoleErrors,
  uid,
} from './helpers';

const CORS_HEADERS = {
  'access-control-allow-origin': 'http://localhost:5174',
  'access-control-allow-credentials': 'true',
};

function fulfillJson(route: Route, data: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', headers: CORS_HEADERS, body: JSON.stringify(data) });
}

/** Valor (h3) de um card de KPI, achado pelo título do card. */
function kpiValue(page: Page, title: string) {
  return page
    .locator('div')
    .filter({ has: page.getByText(title, { exact: true }) })
    .filter({ has: page.getByRole('heading', { level: 3 }) })
    .last()
    .getByRole('heading', { level: 3 });
}

/** Card de gráfico: título + gráfico do Recharts (svg com role="application"). */
function chartCard(page: Page, title: string) {
  return page
    .locator('div')
    .filter({ has: page.getByRole('heading', { name: title }) })
    .filter({ has: page.getByRole('application') })
    .last();
}

test.describe('Dashboard do administrador', () => {
  test('dashboard renderiza KPIs e gráficos com dados reais, sem erros no console', async ({ page }) => {
    // Garante ao menos um pedido pago (pago na retirada e concluído) para o gráfico de pagamentos
    const admin = await StaffApi.as('admin');
    const customer = await Customer.create();
    const product = await admin.createProduct({ name: `Dash Burger ${uid('wa')}`, price: 27.5 });
    const order = await customer.order({ items: [{ productId: product.id, quantity: 2 }], type: 'TAKEOUT', paymentMethod: 'MONEY' });
    const done = await admin.advance(order.id, 'PREPARING', 'READY_FOR_PICKUP', 'DONE');
    expect(done.payment_status).toBe('PAID');

    const errors = trackConsoleErrors(page);
    const failures = trackApiFailures(page);
    await signInAs(page, 'admin');
    await page.goto('/dashboard');
    await expect(pageHeading(page, /^Dashboard/)).toBeVisible({ timeout: 20_000 });

    for (const title of ['Faturamento Total', 'Pedidos Realizados', 'Ticket Médio', 'Fila de Produção']) {
      await expect(kpiValue(page, title), title).not.toHaveText('...');
    }
    await expect(kpiValue(page, 'Faturamento Total')).toHaveText(/^R\$\s[\d.]+,\d{2}$/);
    await expect(kpiValue(page, 'Ticket Médio')).toHaveText(/^R\$\s[\d.]+,\d{2}$/);
    const totalOrders = Number(await kpiValue(page, 'Pedidos Realizados').innerText());
    expect(totalOrders).toBeGreaterThanOrEqual(1);
    await expect(page.getByText(/^\d+ pedidos pagos \(sem cancelados\)$/)).toBeVisible();

    await expect(chartCard(page, 'Desempenho Financeiro').getByRole('application')).toBeVisible();
    await expect(chartCard(page, 'Produtos Campeões').getByRole('application')).toBeVisible();
    await expect(chartCard(page, 'Pagamentos').getByRole('application')).toBeVisible();
    await expect(page.getByText('Últimos 7 dias')).toBeVisible();
    await expect(page.getByText(/^Pedido #\d+$/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Loja Online/ })).toBeVisible();

    // Mais um ciclo de atualização automática do painel (15 s) sem erros
    await page.waitForTimeout(16_000);
    await expect(kpiValue(page, 'Pedidos Realizados')).toHaveText(/^\d+$/);

    expect(errors, 'erros no console do Dashboard').toEqual([]);
    expect(failures, 'chamadas da API com erro no Dashboard').toEqual([]);

    await admin.softDeleteProduct(product.id);
    await customer.dispose();
    await admin.dispose();
  });

  test('KPIs contam só pedidos pagos e não cancelados e os pagamentos aparecem em português', async ({ page }) => {
    const now = new Date().toISOString();
    const item = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, quantity: 1, product: { id: 1, name: 'X', price: 10, image: null }, addons: [] }));
    const orders = [
      { id: 9101, status: 'DONE', payment_status: 'PAID', payment_method: 'MONEY', total_price: 50, type: 'DELIVERY', created_at: now, user: null, items: item(1) },
      { id: 9102, status: 'DONE', payment_status: 'PAID', payment_method: 'DINHEIRO', total_price: '30.00', type: 'TAKEOUT', created_at: now, user: null, items: item(2) },
      { id: 9103, status: 'CANCELED', payment_status: 'PAID', payment_method: 'PIX', total_price: 100, type: 'DELIVERY', created_at: now, user: null, items: item(1) },
      { id: 9104, status: 'PREPARING', payment_status: 'PENDING', payment_method: 'CREDIT_CARD', total_price: 20, type: 'DELIVERY', created_at: now, user: null, items: item(1) },
      { id: 9105, status: 'PENDING', payment_status: 'PAID', payment_method: 'CARTAO_CREDITO', total_price: 40, type: 'TAKEOUT', created_at: now, user: null, items: item(3) },
    ];
    const charts = {
      revenueChart: [
        { date: '10/10', total: 0 },
        { date: '11/10', total: 120 },
      ],
      productsChart: [
        { name: 'CampeaoMockWA', quantity: 7 },
        { name: 'ViceMockWA', quantity: 3 },
      ],
    };

    await page.route((url) => url.href.startsWith(API_URL) && new URL(url.href).pathname === '/orders', (route) =>
      route.request().method() === 'GET' ? fulfillJson(route, orders) : route.continue(),
    );
    await page.route(`${API_URL}/orders/charts`, (route) => fulfillJson(route, charts));

    await signInAs(page, 'admin');
    await page.goto('/dashboard');
    await expect(pageHeading(page, /^Dashboard/)).toBeVisible({ timeout: 20_000 });

    await expect(kpiValue(page, 'Faturamento Total')).toHaveText(money(120));
    await expect(page.getByText('3 pedidos pagos (sem cancelados)')).toBeVisible();
    await expect(kpiValue(page, 'Pedidos Realizados')).toHaveText('5');
    await expect(page.getByText('2 ativos agora')).toBeVisible();
    await expect(kpiValue(page, 'Ticket Médio')).toHaveText(money(40));
    await expect(kpiValue(page, 'Fila de Produção')).toHaveText('2');

    // Pizza de pagamentos: só pedidos pagos e não cancelados, com códigos legados traduzidos
    const payments = chartCard(page, 'Pagamentos');
    await expect(payments.getByText('Dinheiro', { exact: true })).toBeVisible();
    await expect(payments.getByText('Cartão de crédito', { exact: true })).toBeVisible();
    await expect(payments.getByText('PIX', { exact: true })).toHaveCount(0);
    await expect(payments).not.toContainText(/DINHEIRO|CARTAO_|MONEY|CREDIT_CARD/);

    await expect(chartCard(page, 'Produtos Campeões').getByText('CampeaoMockWA')).toBeVisible();
    await expect(chartCard(page, 'Desempenho Financeiro').getByText('11/10')).toBeVisible();

    // Atividade: mais recentes primeiro
    await expect(page.getByText(/^Pedido #\d+$/)).toHaveText(['Pedido #9105', 'Pedido #9104', 'Pedido #9103', 'Pedido #9102', 'Pedido #9101']);
    await expect(page.getByText(/• 3 itens$/)).toBeVisible();
  });

  test('dashboard sem pedidos pagos mostra estados vazios em vez de gráficos quebrados', async ({ page }) => {
    await page.route((url) => url.href.startsWith(API_URL) && new URL(url.href).pathname === '/orders', (route) =>
      route.request().method() === 'GET' ? fulfillJson(route, []) : route.continue(),
    );
    await page.route(`${API_URL}/orders/charts`, (route) => fulfillJson(route, { revenueChart: [], productsChart: [] }));
    const errors = trackConsoleErrors(page);

    await signInAs(page, 'admin');
    await page.goto('/dashboard');
    await expect(pageHeading(page, /^Dashboard/)).toBeVisible({ timeout: 20_000 });
    await expect(kpiValue(page, 'Faturamento Total')).toHaveText(money(0));
    await expect(kpiValue(page, 'Pedidos Realizados')).toHaveText('0');
    await expect(kpiValue(page, 'Ticket Médio')).toHaveText(money(0));
    await expect(page.getByText('Nenhum pedido pago ainda.')).toBeVisible();
    await expect(page.getByText('Sem atividade recente.')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
