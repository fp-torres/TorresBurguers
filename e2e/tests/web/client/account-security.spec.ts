import { test, expect, request, type Page } from '@playwright/test';
import { login } from '../../../support/api';
import { plantAccountToken } from '../../api/identity/account-helpers';
import { API_URL, STORAGE_KEYS, createClient, readStorage, useSession, type TestClient } from './helpers';

/**
 * "Segurança da conta" em Meus Dados e as páginas públicas dos links por e-mail (/verificar-email,
 * /confirmar-email e /desfazer-troca-de-email). Os links vêm do banco de teste (código plantado).
 */
const clients: TestClient[] = [];

test.afterEach(async () => {
  while (clients.length) await clients.pop()!.api.dispose();
});

async function newClient(name: string): Promise<TestClient> {
  const client = await createClient({ name });
  clients.push(client);
  return client;
}

function uniqueAddress(prefix: string): string {
  return `${prefix}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@e2e.comestra.com.br`;
}

/** A página não rola na horizontal (largura do conteúdo ≤ largura da janela). */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'rolagem horizontal').toBeLessThanOrEqual(0);
}

test.describe('Meus Dados › Segurança da conta', () => {
  test('cartão do e-mail (não confirmado, reenvio), troca pendente e cancelamento', async ({ page }) => {
    const client = await newClient('Cliente Segurança');
    await useSession(page, client.session);
    await page.goto('/profile');

    const section = page.getByRole('region', { name: 'Segurança da conta' });
    const card = section.getByTestId('account-email-card');
    await expect(card).toContainText(client.email);
    await expect(card.getByText('Não confirmado')).toBeVisible();

    const resent = page.waitForResponse((r) => r.url() === `${API_URL}/account/email-verification` && r.request().method() === 'POST');
    await card.getByRole('button', { name: 'Enviar link de confirmação' }).click();
    expect((await resent).status()).toBe(202);
    await expect(card.getByRole('status')).toContainText('Enviamos um link de confirmação para');

    const newEmail = uniqueAddress('troca-web');
    const form = section.getByRole('form', { name: 'Trocar e-mail' });
    await form.getByRole('textbox', { name: 'Novo e-mail', exact: true }).fill(newEmail);
    await form.getByLabel('Repita o novo e-mail').fill(newEmail);
    await form.getByLabel('Senha atual').fill(client.password);
    const requested = page.waitForResponse((r) => r.url() === `${API_URL}/account/email-change` && r.request().method() === 'POST');
    await form.getByRole('button', { name: 'Enviar link de confirmação' }).click();
    expect((await requested).status()).toBe(202);
    await expect(form.getByRole('status')).toContainText(`Enviamos um link de confirmação para ${newEmail}`);

    const pending = card.getByTestId('account-email-pending');
    await expect(pending).toContainText(newEmail);
    // O e-mail da conta continua o mesmo até a confirmação
    await expect(card).toContainText(client.email);

    await pending.getByRole('button', { name: 'Cancelar troca' }).click();
    await expect(page.getByText('Troca de e-mail cancelada.')).toBeVisible();
    await expect(pending).toBeHidden();
  });

  test('390 px no tema escuro: Meus Dados e a seção de segurança sem rolagem horizontal', async ({ page }) => {
    const client = await newClient('Cliente Celular');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await useSession(page, client.session);
    await page.goto('/profile');
    await expect(page.getByRole('region', { name: 'Segurança da conta' }).getByTestId('account-email-card')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});

test.describe('links recebidos por e-mail', () => {
  test('/verificar-email: confere ao abrir, confirma no clique e não vale de novo', async ({ page }) => {
    const client = await newClient('Cliente Verifica');
    const token = await plantAccountToken(client.session.user.id, 'VERIFY', client.email);
    await page.goto(`/verificar-email/${token}`);
    await expect(page.getByRole('heading', { name: 'Confirme o seu e-mail' })).toBeVisible();
    await page.getByRole('button', { name: 'Confirmar e-mail' }).click();
    await expect(page.getByRole('heading', { name: 'E-mail confirmado', exact: true })).toBeVisible();

    const security = await (await client.api.get('/account/security')).json();
    expect(security.email_verified).toBe(true);

    await page.goto(`/verificar-email/${token}`);
    await expect(page.getByText('Este link não vale mais')).toBeVisible();
  });

  test('/confirmar-email: troca o e-mail, encerra a sessão deste navegador (o carrinho fica) e manda entrar de novo', async ({ page }) => {
    const client = await newClient('Cliente Troca');
    const newEmail = uniqueAddress('confirmada-web');
    const res = await client.api.post('/account/email-change', { data: { email: newEmail, current_password: client.password } });
    expect(res.status()).toBe(202);
    const token = await plantAccountToken(client.session.user.id, 'CHANGE', newEmail);

    await useSession(page, client.session);
    await page.goto(`/confirmar-email/${token}`);
    await expect(page.getByRole('heading', { name: 'Confirme o novo e-mail' })).toBeVisible();
    await expect(page.getByText(`${newEmail.slice(0, 2)}***@`)).toBeVisible();
    await page.getByRole('button', { name: 'Confirmar troca de e-mail' }).click();
    await expect(page.getByRole('heading', { name: 'E-mail alterado', exact: true })).toBeVisible();
    await expect(page.getByText(`Use ${newEmail} para entrar.`)).toBeVisible();
    expect((await readStorage(page))[STORAGE_KEYS.token], 'sessão deste navegador encerrada').toBeUndefined();

    const anon = await request.newContext({ baseURL: API_URL });
    await login(anon, newEmail, client.password);
    await anon.dispose();
  });

  test('/desfazer-troca-de-email: senha nova devolve o e-mail antigo; link inválido mostra a mensagem', async ({ page }) => {
    const client = await newClient('Cliente Desfaz');
    const intruderEmail = uniqueAddress('invasor-web');
    const legacy = await client.api.patch(`/users/${client.session.user.id}`, { data: { email: intruderEmail } });
    expect(legacy.status()).toBe(200);
    const token = await plantAccountToken(client.session.user.id, 'REVERT', client.email);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/desfazer-troca-de-email/${token}`);
    await expect(page.getByRole('heading', { name: 'Não foi você?' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByLabel(/^Nova senha\s*\*?$/).fill('Recuperada#2026');
    await page.getByLabel('Confirmar nova senha').fill('Recuperada#2026');
    await page.getByRole('button', { name: 'Desfazer a troca e salvar a senha' }).click();
    await expect(page).toHaveURL(/\/signin$/);
    await expect(page.getByText(/Troca de e-mail desfeita/)).toBeVisible();

    const anon = await request.newContext({ baseURL: API_URL });
    await login(anon, client.email, 'Recuperada#2026');
    await anon.dispose();

    await page.goto(`/desfazer-troca-de-email/${token}`);
    await expect(page.getByText('Este link não vale mais')).toBeVisible();
    await page.goto('/confirmar-email/codigo-invalido');
    await expect(page.getByText('Este link não vale mais')).toBeVisible();
  });
});
