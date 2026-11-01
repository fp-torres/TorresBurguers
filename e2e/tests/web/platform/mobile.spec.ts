import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import {
  newApi,
  pageHeading,
  retireTenantStore,
  signIn,
  superadminSession,
  tenantStore,
  type Session,
  type TenantStore,
} from './helpers';

/**
 * Superpainel no celular (375 px): as listas principais trocam a tabela por cartões, com a ação de cada item
 * visível dentro da tela e sem rolagem horizontal da página.
 */

test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

let api: APIRequestContext;
let superadmin: Session;
let store: TenantStore;

test.beforeAll(async () => {
  api = await newApi();
  superadmin = await superadminSession(api);
  store = await tenantStore(api, superadmin, 'Celular', { open: false, delivery: false });
});

test.afterAll(async () => {
  await retireTenantStore(api, superadmin, store);
  await api.dispose();
});

/** A página não rola na horizontal (nem o documento nem a área principal do layout). */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const main = document.querySelector('main');
    return {
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      main: main ? main.scrollWidth - main.clientWidth : 0,
    };
  });
  expect(overflow.document, 'sem rolagem horizontal no documento').toBeLessThanOrEqual(0);
  expect(overflow.main, 'sem rolagem horizontal na área principal').toBeLessThanOrEqual(0);
}

/** A ação está visível e cabe inteira na largura da tela. */
async function expectActionInViewport(action: Locator): Promise<void> {
  await expect(action).toBeVisible();
  await action.scrollIntoViewIfNeeded();
  const box = await action.boundingBox();
  expect(box, 'ação com área na tela').not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, 'ação dentro dos 375 px').toBeLessThanOrEqual(375);
}

test('estabelecimentos e planos em cartões, com a ação de cada item visível', async ({ page }) => {
  await signIn(page, superadmin);
  await page.goto('/platform/stores');
  await expect(pageHeading(page, 'Estabelecimentos')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Abrir menu' }), 'menu recolhido no celular').toBeVisible();

  const cards = page.getByRole('list', { name: 'Estabelecimentos da plataforma' });
  await expect(cards).toBeVisible();
  await expect(page.getByRole('table', { name: 'Estabelecimentos da plataforma' }), 'a tabela fica para telas largas').toBeHidden();
  await page.getByRole('searchbox', { name: 'Buscar estabelecimentos' }).fill(store.slug);
  await expect(page).toHaveURL(new RegExp(`[?&]q=${store.slug}`));
  const card = cards.getByRole('listitem').filter({ hasText: `/${store.slug}` });
  await expect(cards.getByRole('listitem')).toHaveCount(1);
  await expect(card.getByRole('term').filter({ hasText: 'Situação' })).toBeVisible();
  await expect(card).toContainText('Plano demonstração');
  const details = card.getByRole('link', { name: `Ver detalhes de ${store.name}` });
  await expectActionInViewport(details);
  await expectNoHorizontalScroll(page);
  await details.click();
  await expect(page).toHaveURL(new RegExp(`/platform/stores/${store.id}$`));
  await expect(pageHeading(page, store.name)).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Seções do estabelecimento' })).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Planos: cartões com "Editar" e "Tirar de venda/Disponibilizar"
  await page.getByRole('button', { name: 'Abrir menu' }).click();
  await page.getByRole('navigation', { name: 'Menu do superpainel' }).getByRole('link', { name: 'Planos' }).click();
  await expect(pageHeading(page, 'Planos')).toBeVisible();
  const plans = page.getByRole('list', { name: 'Planos da plataforma' });
  await expect(plans).toBeVisible();
  await expect(page.getByRole('table', { name: 'Planos da plataforma' })).toBeHidden();
  // Na suíte inteira as specs de API criam dezenas de planos: o da demonstração pode não estar na 1ª página
  await page.getByRole('searchbox', { name: 'Buscar planos' }).fill('Plano demonstração');
  const demoPlan = plans.getByRole('listitem').filter({ hasText: 'Plano demonstração' }).first();
  await expectActionInViewport(demoPlan.getByRole('button', { name: 'Editar o plano Plano demonstração' }));
  await expectActionInViewport(demoPlan.getByRole('button', { name: /^(Tirar o plano Plano demonstração de venda|Disponibilizar o plano Plano demonstração)$/ }));
  await expectNoHorizontalScroll(page);
});

test('assinaturas, contas e auditoria em cartões, com a ação de cada item visível', async ({ page }) => {
  await signIn(page, superadmin);

  await page.goto('/platform/subscriptions');
  const subscriptions = page.getByRole('list', { name: 'Assinaturas dos estabelecimentos' });
  await expect(subscriptions).toBeVisible();
  await expect(page.getByRole('table', { name: 'Assinaturas dos estabelecimentos' })).toBeHidden();
  await page.getByRole('searchbox', { name: 'Buscar assinaturas pela loja' }).fill(store.slug);
  await expect(subscriptions.getByRole('listitem')).toHaveCount(1);
  const manage = subscriptions.getByRole('button', { name: `Gerenciar a assinatura de ${store.name}` });
  await expectActionInViewport(manage);
  await expectNoHorizontalScroll(page);
  await manage.click();
  const dialog = page.getByRole('dialog', { name: `Assinatura · ${store.name}` });
  await expect(dialog.getByRole('region', { name: 'Plano e situação da assinatura' })).toContainText(`Assinatura #${store.subscriptionId}`);
  await expectActionInViewport(dialog.getByRole('button', { name: 'Cancelar assinatura' }));
  await dialog.getByRole('button', { name: 'Fechar' }).first().click();
  await expect(dialog).toBeHidden();

  await page.goto('/platform/users');
  const accounts = page.getByRole('list', { name: 'Contas da plataforma' });
  await expect(accounts).toBeVisible();
  await expect(page.getByRole('table', { name: 'Contas da plataforma' })).toBeHidden();
  await page.getByRole('searchbox', { name: 'Buscar contas por nome, e-mail ou telefone' }).fill(store.owner.email);
  await expect(accounts.getByRole('listitem')).toHaveCount(1);
  await expectActionInViewport(accounts.getByRole('button', { name: /^Ver a conta de / }));
  await expectNoHorizontalScroll(page);

  await page.goto(`/platform/audit?loja=${store.id}`);
  const records = page.getByRole('list', { name: 'Registros da auditoria' });
  await expect(records).toBeVisible();
  await expect(page.getByRole('table', { name: 'Registros da auditoria' })).toBeHidden();
  const first = records.getByRole('listitem').first();
  await expect(first).toBeVisible();
  const open = first.getByRole('button', { name: /^Ver detalhes do registro \d+:/ });
  await expectActionInViewport(open);
  await expectNoHorizontalScroll(page);
  await open.click();
  await expect(page.getByRole('dialog')).toBeVisible();
});
