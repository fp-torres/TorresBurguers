import { test, expect, type Page } from '@playwright/test';
import { demoStore } from '../../../support/api';
import { signInAs } from '../../../support/web';
import { DEFAULT_USERS, sidebar, tableRow } from './helpers';

/**
 * "Minha conta" no menu do painel (toda a equipe) e do superpainel: e-mail e senha da própria conta pelas
 * rotas /account. Ao editar a si mesmo na Equipe, o MemberModal não mostra e-mail nem senha (atalho para
 * "Minha conta"). Tudo oculto na sessão de suporte (somente leitura).
 */

async function openMyAccount(page: Page) {
  await sidebar(page).getByRole('button', { name: 'Minha conta' }).click();
  const dialog = page.getByRole('dialog', { name: 'Minha conta' });
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const key of ['admin', 'kitchen'] as const) {
  test(`painel (${key}): "Minha conta" com o e-mail e os formulários de troca`, async ({ page }) => {
    await signInAs(page, key);
    await page.goto('/orders');
    const dialog = await openMyAccount(page);
    await expect(dialog.getByTestId('account-email-card')).toContainText(DEFAULT_USERS[key].email);
    // Contas de demonstração nascem com o e-mail confirmado (seed)
    await expect(dialog.getByText('Confirmado', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('form', { name: 'Trocar e-mail' })).toBeVisible();
    await expect(dialog.getByRole('form', { name: 'Trocar senha' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Fechar' }).click();
    await expect(dialog).toBeHidden();
  });
}

test('superpainel: "Minha conta" do superadmin', async ({ page }) => {
  await signInAs(page, 'superadmin');
  await page.goto('/platform');
  const dialog = await openMyAccount(page);
  await expect(dialog.getByTestId('account-email-card')).toContainText(DEFAULT_USERS.superadmin.email);
  await expect(dialog.getByRole('form', { name: 'Trocar senha' })).toBeVisible();
});

test('Equipe: editar a si mesmo não mostra e-mail nem senha; o atalho abre "Minha conta"', async ({ page }) => {
  await signInAs(page, 'admin');
  await page.goto('/users');
  await tableRow(page, DEFAULT_USERS.admin.email).getByRole('button', { name: 'Editar' }).click();
  const dialog = page.getByRole('dialog', { name: 'Editar Membro' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('member-self-credentials')).toContainText(DEFAULT_USERS.admin.email);
  await expect(dialog.getByLabel('Email', { exact: true })).toHaveCount(0);
  await expect(dialog.getByPlaceholder('Nova Senha (opcional)')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Abrir Minha conta' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Minha conta' })).toBeVisible();
});

test('Equipe: editar outro membro continua com e-mail e senha (modo compat)', async ({ page }) => {
  await signInAs(page, 'admin');
  await page.goto('/users');
  await tableRow(page, DEFAULT_USERS.kitchen.email).getByRole('button', { name: 'Editar' }).click();
  const dialog = page.getByRole('dialog', { name: 'Editar Membro' });
  await expect(dialog.getByLabel('Email', { exact: true })).toHaveValue(DEFAULT_USERS.kitchen.email);
  await expect(dialog.getByPlaceholder('Nova Senha (opcional)')).toBeVisible();
  await expect(dialog.getByTestId('member-self-credentials')).toHaveCount(0);
});

test('sessão de suporte: "Minha conta" fica oculta (somente leitura)', async ({ page }) => {
  await signInAs(page, 'superadmin');
  const store = await demoStore();
  await page.goto(`/platform/stores/${store.id}?tab=support`);
  await page.getByRole('button', { name: 'Iniciar sessão de suporte' }).click();
  const start = page.getByRole('alertdialog', { name: 'Iniciar sessão de suporte?' });
  await start.getByLabel('Motivo').fill('Chamado E2E: conferir o menu da conta na sessão de suporte.');
  await start.getByRole('button', { name: 'Iniciar e abrir o painel' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(sidebar(page).getByText('Suporte', { exact: true })).toBeVisible();

  await expect(sidebar(page).getByRole('button', { name: 'Minha conta' })).toHaveCount(0);
  await expect(sidebar(page).getByRole('button', { name: 'Sessões ativas' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Encerrar e voltar ao superpainel' }).click();
  await expect(page).toHaveURL(/\/platform$/);
});
