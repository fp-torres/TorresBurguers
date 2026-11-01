import { test, expect, request, type Page, type Route } from '@playwright/test';
import { E2E } from '../../../support/env';
import { loginAs, type Session } from '../../../support/api';
import { signInAs } from '../../../support/web';
import { API_URL } from './helpers';

/**
 * Superpainel › Usuários › detalhe da conta: "Link de nova senha". Com o SMTP configurado, a API manda o link só
 * para o e-mail da conta e devolve { url: null, delivered: true, message } (o operador nunca vê o link); contas
 * da plataforma não recebem link por aqui (403) e falha no envio responde 503 com a mensagem. A suíte usa o
 * driver de log (delivered false), então as respostas de e-mail são simuladas; o POST nunca chega à API.
 */

const CORS_HEADERS = { 'access-control-allow-origin': E2E.webURL, 'access-control-allow-credentials': 'true' };

let client: Session;
let superadmin: Session;

test.beforeAll(async () => {
  const api = await request.newContext({ baseURL: E2E.apiURL });
  try {
    client = await loginAs(api, 'client');
    superadmin = await loginAs(api, 'superadmin');
  } finally {
    await api.dispose();
  }
});

/** Simula POST /platform/users/:id/password-reset (o preflight segue para a API). */
async function mockReset(page: Page, userId: number, status: number, body: unknown): Promise<{ calls: () => number }> {
  let calls = 0;
  await page.route(
    (url) => url.href.startsWith(API_URL) && url.pathname === `/platform/users/${userId}/password-reset`,
    (route: Route) => {
      if (route.request().method() !== 'POST') return route.continue();
      calls += 1;
      return route.fulfill({ status, contentType: 'application/json', headers: CORS_HEADERS, body: JSON.stringify(body) });
    },
  );
  return { calls: () => calls };
}

async function openAccount(page: Page, userId: number) {
  await signInAs(page, 'superadmin');
  await page.goto(`/platform/users?usuario=${userId}`);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Link de nova senha' })).toBeVisible({ timeout: 20_000 });
  return dialog;
}

test('link enviado por e-mail (delivered): mostra a mensagem e a validade, sem o campo de copiar o link', async ({ page }) => {
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const message = 'Link de redefinição enviado para cl*****@comestra.com.br.';
  const reset = await mockReset(page, client.user.id, 201, { url: null, delivered: true, expires_at: expiresAt, message });
  const dialog = await openAccount(page, client.user.id);

  await dialog.getByRole('button', { name: 'Link de nova senha' }).click();
  await page.getByRole('alertdialog', { name: 'Gerar link de redefinição de senha?' }).getByRole('button', { name: 'Gerar link' }).click();
  await expect.poll(reset.calls).toBe(1);

  await expect(dialog.getByRole('status').filter({ hasText: message })).toBeVisible();
  await expect(dialog.getByText(/^Vale até .+, uma única vez\./)).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Copiar link de redefinição/ }), 'sem o link para copiar').toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Ocultar aviso' })).toBeVisible();
});

test('falha no envio por e-mail (503): mostra a mensagem da API e nenhum link', async ({ page }) => {
  const message = 'Não foi possível enviar o link por e-mail, então nenhum link foi gerado. Confira o envio de e-mails.';
  const reset = await mockReset(page, client.user.id, 503, { statusCode: 503, message, error: 'Service Unavailable' });
  const dialog = await openAccount(page, client.user.id);

  await dialog.getByRole('button', { name: 'Link de nova senha' }).click();
  await page.getByRole('alertdialog', { name: 'Gerar link de redefinição de senha?' }).getByRole('button', { name: 'Gerar link' }).click();
  await expect.poll(reset.calls).toBe(1);

  await expect(page.getByRole('status').filter({ hasText: message }).last()).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Copiar link de redefinição/ })).toHaveCount(0);
});

test('conta da plataforma: "Link de nova senha" desabilitado com a orientação', async ({ page }) => {
  // O próprio superadmin: conta com platform_role (a API responderia 403)
  const dialog = await openAccount(page, superadmin.user.id);
  await expect(dialog.getByRole('button', { name: 'Link de nova senha' })).toBeDisabled();
  await expect(dialog.getByText('Contas da plataforma: Esqueci minha senha ou comando platform:superadmin.')).toBeVisible();
});

test('sem envio por e-mail (driver de log da suíte): o link aparece uma vez para copiar', async ({ page }) => {
  const dialog = await openAccount(page, client.user.id);
  const response = page.waitForResponse(
    (res) => res.url() === `${API_URL}/platform/users/${client.user.id}/password-reset` && res.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Link de nova senha' }).click();
  await page.getByRole('alertdialog', { name: 'Gerar link de redefinição de senha?' }).getByRole('button', { name: 'Gerar link' }).click();
  const body = await (await response).json();
  expect(body, 'a API não enviou por e-mail e devolveu o link').toMatchObject({ delivered: false, url: expect.stringMatching(/^https?:\/\//) });

  await expect(dialog.getByRole('button', { name: /^Copiar link de redefinição/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Já copiei, ocultar o link' })).toBeVisible();
});
