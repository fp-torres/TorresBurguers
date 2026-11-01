import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { contextAs } from '../../../support/api';
import { signInAs } from '../../../support/web';
import {
  addProduct,
  API_URL,
  bearer,
  getJson,
  newApi,
  pageHeading,
  retireTenantStore,
  sidebar,
  signIn,
  superadminSession,
  tenantStore,
  trackApiWrites,
  uid,
  waitForApi,
  type Json,
  type Session,
  type TenantStore,
} from './helpers';

/**
 * Superpainel: sessão de suporte (motivo → painel da loja somente leitura, com aviso → encerrar e voltar) numa
 * loja própria deste arquivo, e o bloqueio do /platform para a equipe de loja, clientes e visitantes.
 */

let api: APIRequestContext;
let superadmin: Session;
let store: TenantStore;
let productName: string;

test.beforeAll(async () => {
  api = await newApi();
  superadmin = await superadminSession(api);
  store = await tenantStore(api, superadmin, 'Suporte', { delivery: false });
  productName = `Lanche Suporte ${uid('s').slice(-6)}`;
  await addProduct(api, store.owner, { name: productName, price: 19 });
});

test.afterAll(async () => {
  await retireTenantStore(api, superadmin, store);
  await api.dispose();
});

async function supportSessions(): Promise<Json[]> {
  const page = await getJson(api, `/platform/support-sessions?store_id=${store.id}&page=1&pageSize=100`, superadmin.token);
  return page.items as Json[];
}

test('sessão de suporte: motivo obrigatório, painel da loja só para consulta com aviso e encerrar volta ao superpainel', async ({ page }) => {
  const reason = `Chamado ${uid('ch')}: conferir o cardápio com o responsável (E2E web).`;
  await signIn(page, superadmin);
  await page.goto(`/platform/stores/${store.id}?tab=support`);
  const panel = page.getByRole('tabpanel', { name: 'Suporte' });
  await panel.getByRole('button', { name: 'Iniciar sessão de suporte' }).click();

  const dialog = page.getByRole('alertdialog', { name: 'Iniciar sessão de suporte?' });
  await expect(dialog).toContainText(`Você vai abrir o painel de ${store.name} como Administrador, somente leitura`);
  const starts: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith(`/platform/stores/${store.id}/support-sessions`)) starts.push(req.url());
  });
  // Motivo curto (menos de 10 caracteres): nada é enviado
  await dialog.getByLabel('Motivo').fill('curto');
  await dialog.getByRole('button', { name: 'Iniciar e abrir o painel' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Motivo')).toHaveAttribute('aria-invalid', 'true');
  expect(starts).toEqual([]);

  await dialog.getByLabel('Motivo').fill(reason);
  const started = waitForApi(page, 'POST', `/platform/stores/${store.id}/support-sessions`);
  await dialog.getByRole('button', { name: 'Iniciar e abrir o painel' }).click();
  const body = await (await started).json();
  const sessionId = body.session.id as number;
  expect(body.session).toMatchObject({ store_id: store.id, reason, status: 'ACTIVE' });

  // Painel da loja como Administrador, com a faixa da sessão de suporte
  await expect(page).toHaveURL(/\/dashboard$/);
  const banner = page.getByText(new RegExp(`^Sessão de suporte em ${store.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: somente leitura, até `));
  await expect(banner).toBeVisible();
  await expect(sidebar(page)).toContainText(store.name);
  const writes = trackApiWrites(page);

  // Cardápio (navegação pelo menu, sem recarregar): só consulta
  await sidebar(page).getByRole('link', { name: 'Cardápio' }).click();
  await expect(pageHeading(page, 'Cardápio')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Cardápio: somente consulta.' })).toBeVisible();
  await expect(page.getByText(productName, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Novo Produto' })).toHaveCount(0);

  // Equipe também só consulta; e a API recusa escrita com o token da sessão de suporte
  await sidebar(page).getByRole('link', { name: 'Equipe' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Equipe: somente consulta.' })).toBeVisible();
  // Token da sessão de suporte (resposta do início; nunca é exibido na tela)
  const supportToken = body.access_token as string;
  expect(supportToken, 'token próprio da sessão de suporte').toBeTruthy();
  expect(supportToken).not.toBe(superadmin.token);
  expect(await page.locator('body').innerText(), 'o token não aparece na tela').not.toContain(supportToken);
  const write = await api.patch('/store/status', { headers: bearer(supportToken as string), data: { is_open: false } });
  expect(write.status(), 'sessão de suporte é somente leitura').toBe(403);
  const read = await api.get('/store/settings', { headers: bearer(supportToken as string) });
  expect(read.status(), 'consultar continua permitido').toBe(200);
  expect(writes, 'a tela não tentou alterar nada').toEqual([]);

  // Encerrar volta ao superpainel e a sessão termina no servidor
  await page.getByRole('button', { name: 'Encerrar e voltar ao superpainel' }).click();
  await expect(page).toHaveURL(/\/platform$/);
  await expect(pageHeading(page, 'Dashboard da plataforma')).toBeVisible();
  await expect(banner).toHaveCount(0);
  await expect.poll(async () => (await supportSessions()).find((item) => item.id === sessionId)?.status).toBe('ENDED');
  const after = await api.get('/store/settings', { headers: bearer(supportToken as string) });
  expect(after.status(), 'o token da sessão encerrada deixa de valer').toBe(401);

  // A aba Suporte lista a sessão encerrada com o motivo
  await page.goto(`/platform/stores/${store.id}?tab=support`);
  const list = page.getByRole('tabpanel', { name: 'Suporte' });
  await list.getByRole('group', { name: 'Filtrar sessões' }).getByRole('button', { name: 'Encerradas ou expiradas' }).click();
  await expect(list).toContainText(reason);
});

/** O /platform não renderiza nada do superpainel para quem não é superadmin. */
async function expectNoPlatform(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Superpainel Comestra' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Menu do superpainel' })).toHaveCount(0);
}

test.describe('Quem não é superadmin não entra no superpainel', () => {
  test('Administrador da loja: /platform e /platform/stores levam ao Dashboard da loja', async ({ page }) => {
    const calls: string[] = [];
    page.on('request', (req) => {
      if (req.url().startsWith(API_URL) && new URL(req.url()).pathname.startsWith('/platform')) calls.push(req.url());
    });
    await signInAs(page, 'admin');
    await page.goto('/platform');
    await expect(page).toHaveURL(/\/dashboard$/);
    await expectNoPlatform(page);
    await page.goto('/platform/stores');
    await expect(page).toHaveURL(/\/dashboard$/);
    await expectNoPlatform(page);
    expect(calls, 'nenhuma chamada /platform à API').toEqual([]);
  });

  test('Cozinha: /platform/settings leva aos Pedidos', async ({ page }) => {
    await signInAs(page, 'kitchen');
    await page.goto('/platform/settings');
    await expect(page).toHaveURL(/\/orders$/);
    await expectNoPlatform(page);
  });

  test('Cliente: /platform leva ao início do site', async ({ page }) => {
    await signInAs(page, 'client');
    await page.goto('/platform/audit');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Peça nos estabelecimentos da sua região', level: 1 })).toBeVisible();
    await expectNoPlatform(page);
  });

  test('Visitante: /platform pede login; e a API recusa o superpainel para a equipe e o cliente', async ({ page }) => {
    await page.goto('/platform/users');
    await expect(page).toHaveURL(/\/login$/);
    await expectNoPlatform(page);

    for (const key of ['admin', 'client'] as const) {
      const { ctx } = await contextAs(key);
      try {
        const res = await ctx.get('/platform/dashboard');
        expect(res.status(), `${key}: GET /platform/dashboard`).toBe(403);
      } finally {
        await ctx.dispose();
      }
    }
  });
});
