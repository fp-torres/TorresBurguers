import { test, expect, type Page, type Route } from '@playwright/test';
import { E2E } from '../../../support/env';
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
  'access-control-allow-origin': E2E.webURL,
  'access-control-allow-credentials': 'true',
};

function fulfillJson(route: Route, data: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', headers: CORS_HEADERS, body: JSON.stringify(data) });
}

/** Valor de um indicador (StatCard): o rótulo vem antes no HTML e o valor logo depois. */
function kpiValue(page: Page, title: string) {
  return page.getByRole('region', { name: 'Indicadores da loja' }).getByText(title, { exact: true }).locator('xpath=following-sibling::*[1]');
}

/** Texto de apoio do indicador (ex.: "1 novos · 1 em preparo"). */
function kpiHint(page: Page, title: string) {
  return page.getByRole('region', { name: 'Indicadores da loja' }).getByText(title, { exact: true }).locator('xpath=following-sibling::p[2]');
}

/** Cartão de gráfico: região com o título (h3) e o gráfico do Recharts (role="application"). */
function chartCard(page: Page, title: string) {
  return page.getByRole('region', { name: title, exact: true });
}

/** Valor de um quadro do relatório de vendas ("Faturamento", "Ticket médio"...). */
function reportTile(page: Page, label: string) {
  return page.locator('dt').filter({ hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::dd[1]');
}

/** Atende só o GET do caminho exato da API (sem query); o resto segue para o servidor. */
async function mockGet(page: Page, pathname: string, data: unknown, status = 200) {
  await page.route(
    (url) => url.href.startsWith(API_URL) && new URL(url.href).pathname === pathname,
    (route) => (route.request().method() === 'GET' ? fulfillJson(route, data, status) : route.continue()),
  );
}

test.describe('Dashboard do administrador', () => {
  test('dashboard renderiza indicadores, gráficos, relatórios e atividade com dados reais, sem erros no console', async ({ page }) => {
    // Garante ao menos um pedido pago (pago na retirada e concluído) para os gráficos e o relatório
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

    // Indicadores da loja (GET /orders/summary)
    await expect(kpiValue(page, 'Faturamento Total')).toHaveText(/^R\$\s[\d.]+,\d{2}$/);
    for (const title of ['Pedidos Realizados', 'Fila de Produção', 'Pagamentos Pendentes']) {
      await expect(kpiValue(page, title), title).toHaveText(/^[\d.]+$/);
    }
    const totalOrders = Number((await kpiValue(page, 'Pedidos Realizados').innerText()).replace(/\./g, ''));
    expect(totalOrders).toBeGreaterThanOrEqual(1);
    await expect(page.getByText('Pedidos pagos e não cancelados', { exact: true })).toBeVisible();

    // Gráficos dos últimos 7 dias (a loja demo tem o recurso de relatórios do plano)
    await expect(chartCard(page, 'Desempenho Financeiro').getByRole('application')).toBeVisible();
    await expect(chartCard(page, 'Produtos Campeões').getByRole('application')).toBeVisible();
    await expect(chartCard(page, 'Desempenho Financeiro').getByText('Últimos 7 dias', { exact: true })).toBeVisible();

    // Relatório de vendas por período (GET /orders/reports)
    await expect(page.getByRole('heading', { level: 2, name: 'Relatórios de vendas' })).toBeVisible();
    await expect(reportTile(page, 'Faturamento')).toHaveText(/^R\$\s[\d.]+,\d{2}$/);
    await expect(reportTile(page, 'Ticket médio')).toHaveText(/^R\$\s[\d.]+,\d{2}$/);
    await expect(reportTile(page, 'Pedidos no período')).toHaveText(/^[\d.]+$/);
    for (const title of ['Faturamento por dia', 'Pedidos por situação', 'Formas de pagamento', 'Produtos mais vendidos']) {
      await expect(chartCard(page, title), title).toBeVisible();
    }

    // Atividade recente (o pedido mais novo da loja primeiro, pelo número NA LOJA) e o controle da loja
    await expect(page.getByText(/^Pedido #\d+$/).first()).toHaveText(`Pedido #${order.number}`);
    await expect(page.getByRole('button', { name: /Loja Online/ })).toBeVisible();

    // Mais um ciclo de atualização automática do painel (15 s) sem erros
    await page.waitForTimeout(16_000);
    await expect(kpiValue(page, 'Pedidos Realizados')).toHaveText(/^[\d.]+$/);

    expect(errors, 'erros no console do Dashboard').toEqual([]);
    expect(failures, 'chamadas da API com erro no Dashboard').toEqual([]);

    await admin.softDeleteProduct(product.id);
    await customer.dispose();
    await admin.dispose();
  });

  test('indicadores vêm do resumo da API e o relatório mostra os pagamentos em português', async ({ page }) => {
    const now = new Date().toISOString();
    const item = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, quantity: 1, product: { id: 1, name: 'X', price: 10, image: null }, addons: [] }));
    // number = número do pedido NA LOJA (o id é interno); o 9101 vem sem number (resposta antiga): cai no id
    const orders = [
      { id: 9101, status: 'DONE', payment_status: 'PAID', payment_method: 'MONEY', total_price: 50, type: 'DELIVERY', created_at: now, user: null, items: item(1) },
      { id: 9102, number: 42, status: 'DONE', payment_status: 'PAID', payment_method: 'DINHEIRO', total_price: '30.00', type: 'TAKEOUT', created_at: now, user: null, items: item(2) },
      { id: 9103, number: 43, status: 'CANCELED', payment_status: 'PAID', payment_method: 'PIX', total_price: 100, type: 'DELIVERY', created_at: now, user: null, items: item(1) },
      { id: 9104, number: 44, status: 'PREPARING', payment_status: 'PENDING', payment_method: 'CREDIT_CARD', total_price: 20, type: 'DELIVERY', created_at: now, user: null, items: item(1) },
      { id: 9105, number: 45, status: 'PENDING', payment_status: 'PAID', payment_method: 'CARTAO_CREDITO', total_price: 40, type: 'TAKEOUT', created_at: now, user: null, items: item(3) },
    ];
    const summary = { totalOrders: 5, revenue: 120, pendingOrders: 1, preparingOrders: 1, pendingPayments: 2 };
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
    const report = {
      period: { from: '2026-10-16', to: '2026-10-17', days: 2, timeZone: 'America/Sao_Paulo' },
      summary: { orders: 4, canceledOrders: 1, paidOrders: 3, revenue: 120, averageTicket: 40 },
      revenueByDay: [
        { date: '2026-10-16', orders: 1, paidOrders: 1, revenue: 50 },
        { date: '2026-10-17', orders: 2, paidOrders: 2, revenue: 70 },
      ],
      ordersByStatus: [
        { status: 'DONE', count: 2 },
        { status: 'CANCELED', count: 1 },
        { status: 'PENDING', count: 1 },
      ],
      paymentMethods: [
        { method: 'DINHEIRO', orders: 2, paidOrders: 2, revenue: 80 },
        { method: 'CARTAO_CREDITO', orders: 1, paidOrders: 1, revenue: 40 },
      ],
      topProducts: [{ name: 'CampeaoMockWA', quantity: 7 }],
    };

    await mockGet(page, '/orders', orders);
    await mockGet(page, '/orders/summary', summary);
    await mockGet(page, '/orders/charts', charts);
    await mockGet(page, '/orders/reports', report);

    await signInAs(page, 'admin');
    await page.goto('/dashboard');
    await expect(pageHeading(page, /^Dashboard/)).toBeVisible({ timeout: 20_000 });

    // Indicadores: exatamente os números do resumo da API (o painel não recalcula no navegador)
    await expect(kpiValue(page, 'Faturamento Total')).toHaveText(money(120));
    await expect(kpiValue(page, 'Pedidos Realizados')).toHaveText('5');
    await expect(kpiValue(page, 'Fila de Produção')).toHaveText('2');
    await expect(kpiHint(page, 'Fila de Produção')).toHaveText('1 novos · 1 em preparo');
    await expect(kpiValue(page, 'Pagamentos Pendentes')).toHaveText('2');

    // Rótulos do gráfico (svg); os mesmos dados ficam na tabela "Ver dados em tabela"
    await expect(chartCard(page, 'Produtos Campeões').locator('svg').getByText('CampeaoMockWA')).toBeVisible();
    await expect(chartCard(page, 'Desempenho Financeiro').locator('svg').getByText('11/10')).toBeVisible();

    // Relatório do período
    await expect(reportTile(page, 'Faturamento')).toHaveText(money(120));
    await expect(reportTile(page, 'Ticket médio')).toHaveText(money(40));
    await expect(reportTile(page, 'Pedidos no período')).toHaveText('4');
    await expect(reportTile(page, 'Cancelados')).toHaveText('1');

    // Formas de pagamento: códigos legados traduzidos (gráfico e tabela)
    const payments = chartCard(page, 'Formas de pagamento');
    await payments.getByText('Ver dados em tabela').click();
    await expect(payments.getByRole('rowheader', { name: 'Dinheiro', exact: true })).toBeVisible();
    await expect(payments.getByRole('rowheader', { name: 'Cartão de crédito', exact: true })).toBeVisible();
    await expect(payments).not.toContainText(/DINHEIRO|CARTAO_|MONEY|CREDIT_CARD/);

    // Atividade: mais recentes primeiro, pelo número do pedido na loja (o id interno fica no title)
    await expect(page.getByText(/^Pedido #\d+$/)).toHaveText(['Pedido #45', 'Pedido #44', 'Pedido #43', 'Pedido #42', 'Pedido #9101']);
    await expect(page.getByText('Pedido #45', { exact: true })).toHaveAttribute('title', 'ID interno 9105');
    await expect(page.getByText(/• 3 itens$/)).toBeVisible();
  });

  test('dashboard sem pedidos mostra estados vazios em vez de gráficos quebrados', async ({ page }) => {
    await mockGet(page, '/orders', []);
    await mockGet(page, '/orders/summary', { totalOrders: 0, revenue: 0, pendingOrders: 0, preparingOrders: 0, pendingPayments: 0 });
    await mockGet(page, '/orders/charts', { revenueChart: [], productsChart: [] });
    await mockGet(page, '/orders/reports', {
      period: { from: '2026-10-17', to: '2026-10-17', days: 1, timeZone: 'America/Sao_Paulo' },
      summary: { orders: 0, canceledOrders: 0, paidOrders: 0, revenue: 0, averageTicket: 0 },
      revenueByDay: [{ date: '2026-10-17', orders: 0, paidOrders: 0, revenue: 0 }],
      ordersByStatus: [],
      paymentMethods: [],
      topProducts: [],
    });
    const errors = trackConsoleErrors(page);

    await signInAs(page, 'admin');
    await page.goto('/dashboard');
    await expect(pageHeading(page, /^Dashboard/)).toBeVisible({ timeout: 20_000 });
    await expect(kpiValue(page, 'Faturamento Total')).toHaveText(money(0));
    await expect(kpiValue(page, 'Pedidos Realizados')).toHaveText('0');
    await expect(page.getByText('Nenhuma venda nos últimos 7 dias')).toBeVisible();
    await expect(page.getByText('Sem atividade recente.')).toBeVisible();
    await expect(reportTile(page, 'Ticket médio')).toHaveText(money(0));
    await expect(page.getByText('Nenhum pedido no período')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('plano sem relatórios: gráficos e relatórios dão lugar ao aviso do plano (403) e os indicadores continuam', async ({ page }) => {
    const denied = { statusCode: 403, message: 'O plano Essencial não inclui relatórios e gráficos.', error: 'Forbidden' };
    await mockGet(page, '/orders/charts', denied, 403);
    await mockGet(page, '/orders/reports', denied, 403);

    await signInAs(page, 'admin');
    await page.goto('/dashboard');
    await expect(pageHeading(page, /^Dashboard/)).toBeVisible({ timeout: 20_000 });

    const locked = page.getByRole('region', { name: 'Relatórios e gráficos' });
    await expect(locked).toContainText('O plano Essencial não inclui relatórios e gráficos.');
    await expect(locked.getByRole('link', { name: 'Ver plano e assinatura' })).toHaveAttribute('href', '/subscription');
    await expect(chartCard(page, 'Desempenho Financeiro')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Relatórios de vendas' })).toHaveCount(0);
    await expect(kpiValue(page, 'Faturamento Total')).toHaveText(/^R\$\s[\d.]+,\d{2}$/);
  });
});
