import { test, expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { E2E } from '../../../support/env';
import { signupClient } from '../../../support/api';
import {
  bearer,
  escapeRegex,
  expectStatus,
  getJson,
  newApi,
  pageHeading,
  signIn,
  superadminSession,
  toast,
  uid,
  waitForApi,
  type Json,
  type Session,
} from './helpers';

/**
 * Superpainel › Usuários e acessos (bloquear/desbloquear e link de nova senha com o driver de log) e › Auditoria
 * (filtro por grupo de ações e por alvo, detalhe sem segredos). Cada teste usa um cliente novo: as contas
 * padrão do seed nunca são bloqueadas.
 */

const NEW_PASSWORD = 'NovaSenha@2026';

let api: APIRequestContext;
let superadmin: Session;

test.beforeAll(async () => {
  api = await newApi();
  superadmin = await superadminSession(api);
});

test.afterAll(async () => {
  await api.dispose();
});

interface Client {
  id: number;
  name: string;
  email: string;
  password: string;
}

async function newClient(label: string): Promise<Client> {
  const anon = await request.newContext({ baseURL: E2E.apiURL });
  try {
    const name = `${label} ${uid('u').slice(-6)}`;
    const created = await signupClient(anon, { name });
    return { id: created.user.id, name, email: created.user.email, password: created.password };
  } finally {
    await anon.dispose();
  }
}

async function loginStatus(email: string, password: string): Promise<{ status: number; body: Json }> {
  const res = await api.post('/auth/login', { data: { email, password } });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

/** Abre a conta pela lista (busca pelo e-mail) e devolve o diálogo de detalhe. */
async function openAccount(page: Page, client: Client) {
  await page.goto('/platform/users');
  await expect(pageHeading(page, 'Usuários e acessos')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Buscar contas por nome, e-mail ou telefone' }).fill(client.email);
  const row = page.getByRole('table', { name: 'Contas da plataforma' }).getByRole('row').filter({ hasText: client.email });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: `Ver a conta de ${client.name}` }).click();
  const dialog = page.getByRole('dialog', { name: client.name });
  await expect(dialog).toBeVisible();
  return { row, dialog };
}

test.describe('Usuários e acessos', () => {
  test('bloquear exige motivo e recusa o login; desbloquear libera de novo', async ({ page }) => {
    const client = await newClient('Cliente Bloqueio');
    const reason = `Chargeback em análise ${uid('b')} (E2E web).`;
    expect((await loginStatus(client.email, client.password)).status).toBe(201);

    await signIn(page, superadmin);
    const { row, dialog } = await openAccount(page, client);
    await expect(row).toContainText('Ativa');

    await dialog.getByRole('button', { name: 'Bloquear', exact: true }).click();
    let confirm = page.getByRole('alertdialog', { name: 'Bloquear a conta?' });
    await expect(confirm.getByRole('button', { name: 'Bloquear conta' }), 'sem motivo, não dá para bloquear').toBeDisabled();

    await confirm.getByLabel('Motivo do bloqueio').fill(reason);
    await expect(confirm.getByRole('button', { name: 'Bloquear conta' })).toBeEnabled();
    const block = waitForApi(page, 'POST', `/platform/users/${client.id}/block`);
    await confirm.getByRole('button', { name: 'Bloquear conta' }).click();
    expect((await block).ok()).toBeTruthy();
    await expect(toast(page, 'Conta bloqueada: o login foi recusado e as sessões abertas foram encerradas.')).toBeVisible();
    await expect(dialog).toContainText(reason);
    await expect(dialog.getByRole('button', { name: 'Desbloquear', exact: true })).toBeVisible();
    await expect(row).toContainText('Bloqueada');

    const refused = await loginStatus(client.email, client.password);
    expect(refused.status, 'conta bloqueada não entra').toBe(403);
    expect(refused.body.message).toBe('Esta conta está bloqueada. Fale com o suporte da plataforma.');

    await dialog.getByRole('button', { name: 'Desbloquear', exact: true }).click();
    confirm = page.getByRole('alertdialog', { name: 'Desbloquear a conta?' });
    const unblock = waitForApi(page, 'POST', `/platform/users/${client.id}/unblock`);
    await confirm.getByRole('button', { name: 'Desbloquear', exact: true }).click();
    expect((await unblock).ok()).toBeTruthy();
    await expect(toast(page, 'Conta desbloqueada: a pessoa já pode entrar de novo.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Bloquear', exact: true })).toBeVisible();
    await expect(row).toContainText('Ativa');
    expect((await loginStatus(client.email, client.password)).status, 'desbloqueada entra de novo').toBe(201);
  });

  test('link de nova senha (driver de log): aparece uma vez, funciona uma vez e troca a senha', async ({ page, browser }) => {
    const client = await newClient('Cliente Redefinição');
    await signIn(page, superadmin);
    const { dialog } = await openAccount(page, client);

    const reset = waitForApi(page, 'POST', `/platform/users/${client.id}/password-reset`);
    await dialog.getByRole('button', { name: 'Link de nova senha' }).click();
    await page.getByRole('alertdialog', { name: 'Gerar link de redefinição de senha?' }).getByRole('button', { name: 'Gerar link' }).click();
    const body = await (await reset).json();
    expect(body).toMatchObject({ delivered: false, url: expect.stringMatching(/\/redefinir-senha\/[\w-]{20,}$/) });
    const field = dialog.getByRole('textbox', { name: 'Link de redefinição de senha' });
    await expect(field).toHaveValue(body.url);

    // Ocultar o aviso tira o link da tela
    await dialog.getByRole('button', { name: 'Já copiei, ocultar o link' }).click();
    await expect(field).toHaveCount(0);
    expect(await page.content(), 'o link some da tela').not.toContain(body.url);

    // A pessoa abre o link (outro navegador) e cria a senha nova
    const context = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    try {
      const resetPage = await context.newPage();
      await resetPage.goto(body.url);
      await expect(resetPage.getByRole('heading', { name: 'Crie uma nova senha', level: 1 })).toBeVisible();
      await resetPage.getByRole('textbox', { name: 'Nova senha', exact: true }).fill(NEW_PASSWORD);
      await resetPage.getByRole('textbox', { name: 'Confirmar nova senha' }).fill(NEW_PASSWORD);
      const saved = resetPage.waitForResponse((res) => res.request().method() === 'POST' && res.url().startsWith(E2E.apiURL) && /reset/i.test(res.url()));
      await resetPage.getByRole('button', { name: 'Salvar nova senha' }).click();
      expect((await saved).ok()).toBeTruthy();

      // O mesmo link não vale de novo
      await resetPage.goto(body.url);
      await expect(resetPage.getByRole('button', { name: 'Salvar nova senha' })).toHaveCount(0);
      await expect(resetPage.getByRole('heading', { level: 1 })).not.toHaveText('Crie uma nova senha');
    } finally {
      await context.close();
    }
    expect((await loginStatus(client.email, NEW_PASSWORD)).status, 'senha nova vale').toBe(201);
    expect((await loginStatus(client.email, client.password)).status, 'senha antiga não vale mais').toBe(401);
  });
});

test.describe('Auditoria', () => {
  test('ações da conta (/account) aparecem com rótulo e motivo legíveis, não com o código', async ({ page }) => {
    const anon = await request.newContext({ baseURL: E2E.apiURL });
    let client: Session & { password: string };
    try {
      client = await signupClient(anon, { name: `Cliente Rótulos ${uid('u').slice(-6)}` });
    } finally {
      await anon.dispose();
    }
    const headers = bearer(client.token);
    await expectStatus(await api.post('/account/email-verification', { headers }), 202, 'pedido de confirmação do e-mail');
    // Troca para um e-mail em uso: 202 neutro para a pessoa, FAILURE com o motivo na auditoria
    await expectStatus(
      await api.post('/account/email-change', { headers, data: { email: superadmin.user.email, current_password: client.password } }),
      202,
      'pedido de troca para um e-mail em uso',
    );

    await signIn(page, superadmin);
    await page.goto(`/platform/audit?alvo_tipo=user&alvo=${client.user.id}`);
    await expect(pageHeading(page, 'Auditoria')).toBeVisible();
    const table = page.getByRole('table', { name: 'Registros da auditoria' });
    const row = (code: string) =>
      table.locator('tbody tr').filter({ has: page.locator('code', { hasText: new RegExp(`^${escapeRegex(code)}$`) }) });
    await expect(row('auth.email_verification.request')).toContainText('Pedido de confirmação do e-mail');
    const change = row('auth.email_change.request');
    await expect(change).toContainText('Pedido de troca de e-mail');
    await expect(change).toContainText('Motivo: e-mail já usado por outra conta');
  });

  test('filtro por alvo e por grupo de ações; o detalhe do registro não traz segredos', async ({ page }) => {
    const client = await newClient('Cliente Auditoria');
    const headers = bearer(superadmin.token);
    const link = await expectStatus(await api.post(`/platform/users/${client.id}/password-reset`, { headers }), 200, 'link de redefinição');
    const token = new URL(link.url).pathname.split('/').pop() as string;
    await expectStatus(await api.post(`/platform/users/${client.id}/block`, { headers, data: { reason: 'Auditoria web (E2E).' } }), 200, 'bloquear');
    await expectStatus(await api.post(`/platform/users/${client.id}/unblock`, { headers }), 200, 'desbloquear');
    // Alvo: o link "Ver auditoria" do detalhe da conta abre a auditoria filtrada pela conta (abrir o detalhe
    // da conta também é auditado: platform.users.view)
    await signIn(page, superadmin);
    await page.goto(`/platform/users?usuario=${client.id}`);
    const account = page.getByRole('dialog', { name: client.name });
    const auditLoad = page.waitForResponse((res) => {
      const url = new URL(res.url());
      return res.request().method() === 'GET' && url.pathname === '/platform/audit' && url.searchParams.get('target_id') === String(client.id);
    });
    await account.getByRole('link', { name: `Ver auditoria da conta de ${client.name} (ações sobre a conta)` }).click();
    await expect(page).toHaveURL(new RegExp(`/platform/audit\\?.*alvo_tipo=user.*alvo=${client.id}`));
    await expect(pageHeading(page, 'Auditoria')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Remover o filtro \(Alvo: / })).toBeVisible();
    const loaded = await (await auditLoad).json();
    const expectedActions = (loaded.items as Json[]).map((item) => item.action);
    for (const item of loaded.items as Json[]) {
      expect({ type: item.target_type, id: String(item.target_id) }, `${item.action}: alvo`).toEqual({ type: 'user', id: String(client.id) });
    }
    expect(expectedActions).toEqual(expect.arrayContaining(['user.password_reset_link', 'user.block', 'user.unblock']));

    const table = page.getByRole('table', { name: 'Registros da auditoria' });
    const bodyRows = table.locator('tbody tr');
    // Código da ação de cada linha (o <code> com title; o IP e os metadados ficam em outros elementos)
    const actionCodes = () => table.locator('tbody code[title]').allInnerTexts();
    await expect(bodyRows).toHaveCount(expectedActions.length);
    expect(await actionCodes(), 'só registros sobre a conta').toEqual(expectedActions);

    // Grupo: "Contas: bloqueio, sessões e links" (user.*) tira o login recusado e mantém o alvo
    await page.getByRole('combobox', { name: 'Ação' }).selectOption({ label: 'Contas: bloqueio, sessões e links' });
    await expect(page).toHaveURL(/[?&]acao=user\./);
    const userActions = expectedActions.filter((action) => action.startsWith('user.'));
    await expect(bodyRows).toHaveCount(userActions.length);
    expect(await actionCodes()).toEqual(userActions);

    // Detalhe do link de redefinição: e-mail, validade e entrega, nunca o token nem o link
    const resetRow = bodyRows.filter({ has: page.locator('code', { hasText: /^user\.password_reset_link$/ }) });
    await resetRow.getByRole('button', { name: /^Ver detalhes do registro \d+:/ }).click();
    const detail = page.getByRole('dialog');
    await expect(detail).toContainText('user.password_reset_link');
    await expect(detail).toContainText(client.email);
    const detailText = await detail.innerText();
    expect(detailText).not.toContain(token);
    expect(detailText).not.toContain(link.url);
    expect(detailText.toLowerCase()).not.toMatch(/"(token|password|senha|secret|access_token)"/);
    await detail.getByRole('button', { name: 'Fechar' }).first().click();
    await expect(detail).toBeHidden();

    // Remover o filtro de alvo: volta a listar outras contas (o grupo continua)
    await page.getByRole('button', { name: /^Remover o filtro \(Alvo: / }).click();
    await expect(page).not.toHaveURL(/alvo=/);
    await expect(page).toHaveURL(/[?&]acao=user\./);
    for (const action of await actionCodes()) expect(action).toMatch(/^user\./);

    // Outro grupo: Autenticação (sempre há logins na plataforma)
    await page.getByRole('combobox', { name: 'Ação' }).selectOption({ label: 'Autenticação (login, senha)' });
    await expect(page).toHaveURL(/[?&]acao=auth\./);
    await expect(bodyRows.first()).toBeVisible();
    for (const action of await actionCodes()) expect(action).toMatch(/^auth\./);
  });
});
