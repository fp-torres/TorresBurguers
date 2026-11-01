import { test, expect, type Page } from '@playwright/test';
import { E2E } from '../../../support/env';
import { useSession } from '../../../support/web';
import {
  Cleanup,
  createPlan,
  createStore,
  defaultSession,
  newApi,
  platformAction,
  type BillingStore,
  type Session,
} from '../../api/billing/helpers';
import { pageHeading } from './helpers';

/**
 * Painel da loja › Plano e assinatura (/subscription) com a assinatura suspensa pela administração da
 * plataforma (suspended_by = PLATFORM): pagar não reativa (o checkout responde 409), então a tela esconde
 * pagar/autorizar e orienta a falar com o suporte. Suspensa pela cobrança (BILLING), pagar regulariza.
 */

const cleanup = new Cleanup();
let superadmin: Session;
let store: BillingStore;
// Loja em ordem (sem suspensão): as faixas de aviso do painel só aparecem sem um aviso de acesso
let activeStore: BillingStore;

test.beforeAll(async () => {
  const api = await newApi();
  try {
    superadmin = await defaultSession(api, 'superadmin');
    const plan = await createPlan(api, superadmin, cleanup, { name: 'Assinatura Web E2E', price: 49.9 });
    store = await createStore(api, superadmin, cleanup, plan.id, 'Assinatura Web', { open: false });
    activeStore = await createStore(api, superadmin, cleanup, plan.id, 'Assinatura Faixa', { open: false });
    await platformAction(api, superadmin, `/platform/subscriptions/${store.subscriptionId}/suspend`, {
      reason: 'Suspensão pela plataforma (E2E web)',
    });
  } finally {
    await api.dispose();
  }
});

test.afterAll(async () => {
  await cleanup.run();
});

// Recargas silenciosas da tela podem estar passando pelos mocks quando o teste termina
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

/**
 * GET /store/subscription real, com a cobrança online da plataforma marcada como disponível (a suíte usa o
 * registro manual) e, opcionalmente, outra origem da suspensão: isola a decisão da tela.
 */
async function serveOverview(page: Page, suspendedBy?: 'PLATFORM' | 'BILLING'): Promise<void> {
  await page.unroute('**/store/subscription');
  await page.route('**/store/subscription', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.billing = { ...json.billing, online_checkout_available: true };
    if (suspendedBy && json.subscription) json.subscription.suspended_by = suspendedBy;
    await route.fulfill({ response, json });
  });
}

const PAY_ACTIONS = ['Pagar e regularizar', 'Assinar agora', 'Ativar cobrança automática'];

test('assinatura suspensa pela plataforma: sem pagar/autorizar e com o aviso de falar com o suporte', async ({ page }) => {
  await serveOverview(page);
  await useSession(page, store.owner);
  const overview = page.waitForResponse((res) => res.url().endsWith('/store/subscription') && res.request().method() === 'GET');
  await page.goto('/subscription');
  const body = await (await overview).json();
  expect(body.subscription, 'a API informa quem suspendeu').toMatchObject({ status: 'SUSPENDED', suspended_by: 'PLATFORM' });
  await expect(pageHeading(page, 'Plano e assinatura')).toBeVisible({ timeout: 20_000 });

  const notice = page.locator('p', { hasText: 'Assinatura suspensa pela administração da plataforma.' });
  await expect(notice).toBeVisible();
  await expect(notice.locator('a[href^="mailto:"]'), 'contato do suporte').toHaveCount(1);
  for (const name of PAY_ACTIONS) {
    await expect(page.getByRole('button', { name }), name).toHaveCount(0);
  }
  await expect(page.getByRole('link', { name: 'Continuar o pagamento pendente' })).toHaveCount(0);
  await expect(page.getByText('Há uma cobrança a regularizar.')).toHaveCount(0);
});

/** GET /store/subscription real com a assinatura alterada por `patch` (isola a decisão da tela). */
async function serveSubscription(page: Page, patch: (subscription: Record<string, unknown>) => void): Promise<void> {
  await page.unroute('**/store/subscription');
  await page.route('**/store/subscription', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (json.subscription) {
      patch(json.subscription);
      json.subscription.suspended_by = null;
      json.subscription.suspended_at = null;
    }
    await route.fulfill({ response, json });
  });
}

const IN_30_DAYS = () => new Date(Date.now() + 30 * 86_400_000).toISOString();

test('cancelamento agendado pela plataforma: sem "Desistir do cancelamento" e com o aviso de falar com o suporte', async ({ page }) => {
  await serveSubscription(page, (subscription) => {
    Object.assign(subscription, {
      status: 'ACTIVE',
      current_period_end: IN_30_DAYS(),
      cancel_at_period_end: true,
      cancel_scheduled_by: 'PLATFORM',
    });
  });
  await useSession(page, store.owner);
  await page.goto('/subscription');
  await expect(pageHeading(page, 'Plano e assinatura')).toBeVisible({ timeout: 20_000 });

  const notice = page.locator('p', { hasText: 'Cancelamento agendado pela administração da plataforma — fale com o suporte.' });
  await expect(notice).toBeVisible();
  await expect(notice.locator('a[href^="mailto:"]'), 'contato do suporte').toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Desistir do cancelamento' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Falar com o suporte' })).toBeVisible();
});

test('cancelamento agendado pela própria loja continua com "Desistir do cancelamento"', async ({ page }) => {
  await serveSubscription(page, (subscription) => {
    Object.assign(subscription, {
      status: 'ACTIVE',
      current_period_end: IN_30_DAYS(),
      cancel_at_period_end: true,
      cancel_scheduled_by: 'STORE',
    });
  });
  await useSession(page, store.owner);
  await page.goto('/subscription');
  await expect(pageHeading(page, 'Plano e assinatura')).toBeVisible({ timeout: 20_000 });

  await expect(page.getByRole('button', { name: 'Desistir do cancelamento' })).toBeVisible();
  await expect(page.getByText('Cancelamento agendado pela administração da plataforma', { exact: false })).toHaveCount(0);
});

test('plano sem período: quem não é o responsável pela loja não vê "Cancelar assinatura" (cancelamento imediato)', async ({ page }) => {
  await serveSubscription(page, (subscription) => {
    Object.assign(subscription, { status: 'ACTIVE', current_period_end: null, cancel_at_period_end: false, cancel_scheduled_by: null });
  });
  // O responsável pela loja é outra conta
  await page.route('**/store/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const json = await response.json();
    json.owner_user_id = store.owner.user.id + 100_000;
    await route.fulfill({ response, json });
  });
  await useSession(page, store.owner);
  await page.goto('/subscription');
  await expect(pageHeading(page, 'Plano e assinatura')).toBeVisible({ timeout: 20_000 });

  await expect(page.getByText('só o responsável pela loja pode fazê-lo', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Cancelar (assinatura|no fim do período)$/ })).toHaveCount(0);
});

test('plano sem período: 403 IMMEDIATE_CANCEL_OWNER_ONLY mostra a mensagem da API e esconde o botão', async ({ page }) => {
  const OWNER_ONLY = 'Sem período pago a terminar, o cancelamento é imediato e não pode ser desfeito: só o responsável pela loja pode fazê-lo.';
  await serveSubscription(page, (subscription) => {
    Object.assign(subscription, { status: 'ACTIVE', current_period_end: null, cancel_at_period_end: false, cancel_scheduled_by: null });
  });
  let cancelCalls = 0;
  await page.route('**/store/subscription/cancel', async (route) => {
    // Preflight (OPTIONS) segue para a API; o POST nunca chega ao servidor (cancelaria de verdade)
    if (route.request().method() !== 'POST') return route.continue();
    cancelCalls += 1;
    await route.fulfill({
      status: 403,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': E2E.webURL, 'access-control-allow-credentials': 'true' },
      body: JSON.stringify({ statusCode: 403, message: OWNER_ONLY, error: 'Forbidden' }),
    });
  });
  await useSession(page, store.owner);
  await page.goto('/subscription');
  await expect(pageHeading(page, 'Plano e assinatura')).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Cancelar assinatura', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Cancelar a assinatura?' }).getByRole('button', { name: 'Cancelar assinatura' }).click();
  await expect.poll(() => cancelCalls).toBe(1);
  await expect(page.locator('p[role="status"]', { hasText: OWNER_ONLY })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancelar assinatura', exact: true })).toHaveCount(0);
});

test('assinatura suspensa pela cobrança (BILLING): a tela oferece pagar e regularizar', async ({ page }) => {
  await serveOverview(page, 'BILLING');
  await useSession(page, store.owner);
  await page.goto('/subscription');
  await expect(pageHeading(page, 'Plano e assinatura')).toBeVisible({ timeout: 20_000 });

  await expect(page.getByRole('button', { name: 'Pagar e regularizar' })).toBeVisible();
  await expect(page.getByText('Assinatura suspensa pela administração da plataforma.')).toHaveCount(0);
});

/**
 * Faixas do painel: GET /store/settings e /store/subscription reais com a loja em ordem (sem aviso de acesso,
 * que teria prioridade sobre a faixa da assinatura; a rotina da cobrança pode abrir uma fatura na loja nova)
 * e a assinatura alterada por `patch`.
 */
async function serveBanner(page: Page, patch: (subscription: Record<string, unknown>) => void): Promise<void> {
  const operational = {
    availability: 'OPERATIONAL', canSell: true, canRead: true, canOperate: true, canManage: true,
    canManageBilling: true, publicVisible: true, message: null,
  };
  await page.route(/\/store\/(settings|subscription)$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const json = await response.json();
    if (json.access) json.access = { ...json.access, ...operational };
    if (json.subscription) {
      patch(json.subscription);
      json.subscription.suspended_by = null;
      json.subscription.suspended_at = null;
    }
    await route.fulfill({ response, json });
  });
}

test('faixa do painel: cancelamento agendado pela plataforma aponta para o suporte (sem "Desistir do cancelamento")', async ({ page }) => {
  await serveBanner(page, (subscription) => {
    Object.assign(subscription, {
      status: 'ACTIVE',
      current_period_end: IN_30_DAYS(),
      cancel_at_period_end: true,
      cancel_scheduled_by: 'PLATFORM',
    });
  });
  await useSession(page, activeStore.owner);
  await page.goto('/users');
  await expect(pageHeading(page, 'Equipe')).toBeVisible({ timeout: 20_000 });

  const banner = page.locator('p', { hasText: 'Cancelamento agendado pela administração da plataforma.' });
  await expect(banner).toBeVisible();
  await expect(page.getByRole('link', { name: 'Desistir do cancelamento' })).toHaveCount(0);
  const support = page.getByRole('link', { name: 'Falar com o suporte' });
  await expect(support).toHaveCount(1);
  await expect(support).toHaveAttribute('href', /^mailto:/);
});

test('faixa do painel: cancelamento agendado pela loja continua com "Desistir do cancelamento"', async ({ page }) => {
  await serveBanner(page, (subscription) => {
    Object.assign(subscription, {
      status: 'ACTIVE',
      current_period_end: IN_30_DAYS(),
      cancel_at_period_end: true,
      cancel_scheduled_by: 'STORE',
    });
  });
  await useSession(page, activeStore.owner);
  await page.goto('/users');
  await expect(pageHeading(page, 'Equipe')).toBeVisible({ timeout: 20_000 });

  await expect(page.locator('p', { hasText: 'Cancelamento agendado.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Desistir do cancelamento' })).toHaveAttribute('href', '/subscription');
  await expect(page.getByText('Cancelamento agendado pela administração da plataforma', { exact: false })).toHaveCount(0);
});

test('checkout em andamento em outra aba (409 da trava): aviso para aguardar, sem "Pagamento online indisponível"', async ({ page }) => {
  const IN_PROGRESS = 'O link de pagamento desta assinatura já está sendo gerado. Aguarde alguns segundos e tente de novo.';
  await serveOverview(page, 'BILLING');
  let checkoutCalls = 0;
  await page.route('**/store/subscription/checkout', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    checkoutCalls += 1;
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': E2E.webURL, 'access-control-allow-credentials': 'true' },
      body: JSON.stringify({ statusCode: 409, message: IN_PROGRESS, error: 'Conflict' }),
    });
  });
  await useSession(page, store.owner);
  await page.goto('/subscription');
  await expect(pageHeading(page, 'Plano e assinatura')).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Pagar e regularizar' }).click();
  await expect.poll(() => checkoutCalls).toBe(1);
  await expect(page.getByText(IN_PROGRESS)).toBeVisible();
  await expect(page.getByText('Pagamento online indisponível.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pagar e regularizar' })).toBeEnabled();
});
