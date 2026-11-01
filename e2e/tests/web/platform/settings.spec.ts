import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { E2E } from '../../../support/env';
import { DEFAULT_USERS } from '../../../support/users';
import {
  bearer,
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
 * Superpainel › Configurações. Mexe em configurações GLOBAIS da plataforma: os testes rodam em série, neste
 * arquivo, e tudo o que muda volta ao valor de antes (pela interface e, por garantia, no afterAll pela API).
 * E-mail de teste com o driver de log da suíte (nada é enviado) e a verificação da limpeza de uploads (só conta).
 */

test.describe.configure({ mode: 'serial' });

let api: APIRequestContext;
let superadmin: Session;
let original: { grace_period_days: number; support_session_minutes: number };
const plantedFiles: string[] = [];

test.beforeAll(async () => {
  api = await newApi();
  superadmin = await superadminSession(api);
  const settings = await getJson(api, '/platform/settings', superadmin.token);
  original = { grace_period_days: settings.grace_period_days, support_session_minutes: settings.support_session_minutes };
});

test.afterAll(async () => {
  // Garantia: as regras globais voltam ao que eram, mesmo se um teste falhar no meio
  const current = await getJson(api, '/platform/settings', superadmin.token).catch(() => null);
  if (
    current &&
    (current.grace_period_days !== original.grace_period_days || current.support_session_minutes !== original.support_session_minutes)
  ) {
    await api.patch('/platform/settings', { headers: bearer(superadmin.token), data: original });
  }
  for (const file of plantedFiles) fs.rmSync(file, { force: true });
  await api.dispose();
});

test('cobrança e suporte: salvar com confirmação, conferir, descartar e restaurar o valor de antes', async ({ page }) => {
  const grace = original.grace_period_days >= 60 ? original.grace_period_days - 1 : original.grace_period_days + 1;
  const minutes = original.support_session_minutes >= 240 ? original.support_session_minutes - 5 : original.support_session_minutes + 5;

  await signIn(page, superadmin);
  await page.goto('/platform/settings');
  await expect(pageHeading(page, 'Configurações da plataforma')).toBeVisible();
  const graceField = page.getByRole('spinbutton', { name: 'Tolerância da inadimplência (dias)' });
  const minutesField = page.getByRole('spinbutton', { name: 'Duração da sessão de suporte (minutos)' });
  const saveButton = page.getByRole('button', { name: 'Salvar alterações' });
  await expect(graceField).toHaveValue(String(original.grace_period_days));
  await expect(minutesField).toHaveValue(String(original.support_session_minutes));
  await expect(saveButton, 'nada mudou: nada a salvar').toBeDisabled();

  // Valor fora da faixa: a tela recusa antes de enviar
  await graceField.fill('61');
  await saveButton.click();
  await expect(toast(page, 'Confira os campos destacados antes de salvar.')).toBeVisible();
  await expect(page.getByRole('alertdialog', { name: 'Salvar as configurações da plataforma?' })).toHaveCount(0);

  // Descartar volta ao salvo
  await page.getByRole('button', { name: 'Descartar' }).click();
  await expect(graceField).toHaveValue(String(original.grace_period_days));
  await expect(saveButton).toBeDisabled();

  // Salvar: confirmação com o resumo e PATCH só com o que mudou
  await graceField.fill(String(grace));
  await minutesField.fill(String(minutes));
  await saveButton.click();
  const confirm = page.getByRole('alertdialog', { name: 'Salvar as configurações da plataforma?' });
  await expect(confirm.getByRole('listitem')).toHaveCount(2);
  await expect(confirm).toContainText(String(grace));
  await expect(confirm).toContainText(String(minutes));
  const save = waitForApi(page, 'PATCH', '/platform/settings');
  await confirm.getByRole('button', { name: 'Salvar alterações' }).click();
  const saved = await save;
  expect(saved.status()).toBe(200);
  expect(saved.request().postDataJSON()).toEqual({ grace_period_days: grace, support_session_minutes: minutes });
  await expect(toast(page, 'Configurações da plataforma salvas.')).toBeVisible();
  await expect(saveButton).toBeDisabled();
  expect(await getJson(api, '/platform/settings', superadmin.token)).toMatchObject({ grace_period_days: grace, support_session_minutes: minutes });

  await page.reload();
  await expect(graceField).toHaveValue(String(grace));
  await expect(minutesField).toHaveValue(String(minutes));

  // Restaura pela interface
  await graceField.fill(String(original.grace_period_days));
  await minutesField.fill(String(original.support_session_minutes));
  await saveButton.click();
  const restore = waitForApi(page, 'PATCH', '/platform/settings');
  await page.getByRole('alertdialog', { name: 'Salvar as configurações da plataforma?' }).getByRole('button', { name: 'Salvar alterações' }).click();
  expect((await restore).status()).toBe(200);
  await expect(saveButton).toBeDisabled();
  expect(await getJson(api, '/platform/settings', superadmin.token)).toMatchObject(original);
});

test('e-mail de teste com o driver de log: a tela explica que nada foi enviado', async ({ page }) => {
  await signIn(page, superadmin);
  await page.goto('/platform/settings');
  const mail = page.getByRole('region', { name: 'E-mail transacional' });
  await expect(mail.getByRole('definition').first()).toHaveText('Log (não envia)');
  const to = mail.getByRole('textbox', { name: 'Enviar e-mail de teste para' });
  await expect(to, 'o destino sugerido é o e-mail do operador').toHaveValue(DEFAULT_USERS.superadmin.email);

  // Sem destino: a tela pede o e-mail e não chama a API
  const posts: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/platform/settings/test-email')) posts.push(req.url());
  });
  await to.fill('');
  await mail.getByRole('button', { name: 'Enviar e-mail de teste' }).click();
  await expect(to).toHaveAttribute('aria-invalid', 'true');
  expect(posts).toEqual([]);

  const target = `teste-${uid('mail')}@e2e.test`;
  await to.fill(target);
  const sent = waitForApi(page, 'POST', '/platform/settings/test-email');
  await mail.getByRole('button', { name: 'Enviar e-mail de teste' }).click();
  const response = await sent;
  const result = await response.json();
  expect(response.status()).toBe(200);
  expect(result).toMatchObject({ to: target, driver: 'log', delivered: false, error: null });
  await expect(mail.getByRole('status').filter({ hasText: 'Driver de log ativo: nenhum e-mail foi enviado' })).toContainText(result.message);

  // A auditoria guarda o envio (sem conteúdo do e-mail)
  const audit = await getJson(api, '/platform/audit?action=platform.settings.test_email&pageSize=20', superadmin.token);
  expect((audit.items as Json[]).some((item) => item.metadata?.to === target && item.metadata?.delivered === false)).toBe(true);
});

test('manutenção: "Verificar" conta os arquivos sem uso e não apaga nada', async ({ page }) => {
  // Um arquivo de imagem sem cadastro, com mais de 24 h: entra na contagem da limpeza
  fs.mkdirSync(E2E.uploadsDir, { recursive: true });
  const orphan = path.join(E2E.uploadsDir, `e2e-orfao-${uid('up')}.png`);
  fs.writeFileSync(orphan, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  plantedFiles.push(orphan);
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  fs.utimesSync(orphan, old, old);
  const before = fs.readdirSync(E2E.uploadsDir).sort();

  await signIn(page, superadmin);
  await page.goto('/platform/settings');
  const maintenance = page.getByRole('region', { name: 'Manutenção' });
  await expect(maintenance.getByRole('heading', { name: 'Limpar arquivos sem uso' })).toBeVisible();

  const start = waitForApi(page, 'POST', '/platform/maintenance/cleanup-uploads');
  await maintenance.getByRole('button', { name: 'Verificar', exact: true }).click();
  const started = await start;
  expect(started.request().postDataJSON(), 'só verificar (nunca apagar)').toEqual({ mode: 'check' });
  expect([202, 409]).toContain(started.status());

  const done = maintenance.getByText('Verificação concluída.', { exact: true });
  await expect(done).toBeVisible({ timeout: 30_000 });
  const result = done.locator('xpath=..');
  await expect(result).toContainText(/\d+ arquivos? sem uso há mais de 24 h/);
  await expect(result).toContainText('Nada foi apagado.');

  const job = await getJson(api, '/platform/maintenance/cleanup-uploads', superadmin.token);
  expect(job.job).toMatchObject({ status: 'SUCCEEDED' });
  expect(job.job.summary).toMatchObject({ mode: 'check', deleted: 0 });
  expect(job.job.summary.orphans, 'o arquivo plantado conta como sem uso').toBeGreaterThanOrEqual(1);
  expect(fs.existsSync(orphan), 'verificar não apaga').toBe(true);
  expect(fs.readdirSync(E2E.uploadsDir).sort(), 'a pasta de uploads continua igual').toEqual(expect.arrayContaining(before));

  // A ação de apagar continua pedindo confirmação (não confirmada aqui)
  await maintenance.getByRole('button', { name: 'Apagar sem uso' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Apagar os arquivos sem uso?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancelar' }).click();
  await expect(confirm).toBeHidden();
  expect(fs.existsSync(orphan)).toBe(true);
  await expectStatus(await api.get('/platform/maintenance/cleanup-uploads', { headers: bearer(superadmin.token) }), 200, 'última execução');
});
