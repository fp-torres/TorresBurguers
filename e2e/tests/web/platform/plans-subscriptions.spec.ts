import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  createPlan,
  getJson,
  newApi,
  pageHeading,
  paidStore,
  retirePaidStore,
  retirePlan,
  signIn,
  superadminSession,
  toast,
  uid,
  waitForApi,
  type Json,
  type PaidStore,
  type Session,
} from './helpers';

/**
 * Superpainel › Planos (criar e editar, inclusive o limite de armazenamento) e › Assinaturas (detalhe, agendar
 * o cancelamento para o fim do período e desfazer). Os planos são privados (fora da página pública) e saem de
 * venda no fim; a loja com cobrança é cancelada e desativada no fim do arquivo.
 */

let api: APIRequestContext;
let superadmin: Session;
const planIds: number[] = [];
const paidStores: PaidStore[] = [];

test.beforeAll(async () => {
  api = await newApi();
  superadmin = await superadminSession(api);
});

test.afterAll(async () => {
  for (const store of paidStores) await retirePaidStore(api, superadmin, store);
  for (const id of planIds) await retirePlan(api, superadmin, id);
  await api.dispose();
});

const DATE = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' });

test('planos: criar com limites (inclusive o armazenamento), editar o armazenamento e tirar de venda', async ({ page }) => {
  const code = uid('wplano').toLowerCase().slice(0, 40);
  const name = `Plano Web ${code.slice(-10)}`;

  await signIn(page, superadmin);
  await page.goto('/platform/plans');
  await expect(pageHeading(page, 'Planos')).toBeVisible();

  await page.getByRole('button', { name: 'Novo plano' }).click();
  let dialog = page.getByRole('dialog', { name: 'Novo plano' });
  await dialog.getByRole('textbox', { name: 'Nome' }).fill(name);
  await dialog.getByRole('textbox', { name: 'Código' }).fill(code);
  await dialog.getByRole('textbox', { name: 'Descrição (opcional)' }).fill('Plano criado pela suíte web (E2E).');
  await dialog.getByRole('textbox', { name: 'Preço (R$)' }).fill('39,90');
  await dialog.getByRole('combobox', { name: 'Periodicidade' }).selectOption({ label: 'Mensal' });
  await dialog.getByRole('spinbutton', { name: 'Equipe ativa' }).fill('5');
  await dialog.getByRole('spinbutton', { name: 'Armazenamento (MB)' }).fill('250');
  await dialog.getByRole('checkbox', { name: 'Relatórios e gráficos' }).check();
  // Privado: não aparece na página pública de planos nem no cadastro de lojas
  await dialog.getByRole('checkbox', { name: /^Público/ }).uncheck();

  const creation = waitForApi(page, 'POST', '/platform/plans');
  await dialog.getByRole('button', { name: 'Criar plano' }).click();
  const createdRes = await creation;
  const created = await createdRes.json();
  expect(createdRes.status(), JSON.stringify(created)).toBe(201);
  planIds.push(created.id);
  expect(created).toMatchObject({
    code,
    name,
    price: 39.9,
    billing_interval: 'MONTHLY',
    max_staff_users: 5,
    max_products: null,
    max_monthly_orders: null,
    max_storage_mb: 250,
    is_public: false,
    status: 'ACTIVE',
    features: { online_payments: false, advanced_reports: true, custom_branding: false },
  });
  expect(createdRes.request().postDataJSON()).toMatchObject({ max_storage_mb: 250 });
  await expect(toast(page, `Plano ${name} criado.`)).toBeVisible();
  await expect(dialog).toBeHidden();

  await page.getByRole('searchbox', { name: 'Buscar planos' }).fill(code);
  const row = page.getByRole('table', { name: 'Planos da plataforma' }).getByRole('row').filter({ hasText: code });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('R$ 39,90');
  await expect(row.getByRole('definition').nth(0)).toHaveText('5');
  await expect(row.getByRole('definition').nth(3), 'armazenamento').toHaveText('250 MB');
  await expect(row).toContainText('Oculto');

  // Editar: o formulário volta com o armazenamento salvo; o novo limite vai no PATCH e aparece na lista
  await row.getByRole('button', { name: `Editar o plano ${name}` }).click();
  dialog = page.getByRole('dialog', { name: `Editar plano ${name}` });
  await expect(dialog.getByRole('spinbutton', { name: 'Armazenamento (MB)' })).toHaveValue('250');
  await expect(dialog.getByRole('spinbutton', { name: 'Equipe ativa' })).toHaveValue('5');
  await dialog.getByRole('spinbutton', { name: 'Armazenamento (MB)' }).fill('1536');
  const update = waitForApi(page, 'PATCH', `/platform/plans/${created.id}`);
  await dialog.getByRole('button', { name: 'Salvar alterações' }).click();
  const updatedRes = await update;
  expect(updatedRes.status()).toBe(200);
  expect(updatedRes.request().postDataJSON(), 'só o que mudou vai no PATCH').toEqual({ max_storage_mb: 1536 });
  await expect(toast(page, `Plano ${name} atualizado.`)).toBeVisible();
  await expect(row.getByRole('definition').nth(3)).toHaveText('1,5 GB');
  expect((await getJson(api, `/platform/plans/${created.id}`, superadmin.token)).max_storage_mb).toBe(1536);

  // Voltar a "Ilimitado" também é uma edição do armazenamento
  await row.getByRole('button', { name: `Editar o plano ${name}` }).click();
  dialog = page.getByRole('dialog', { name: `Editar plano ${name}` });
  const storageField = dialog.getByRole('spinbutton', { name: 'Armazenamento (MB)' });
  await storageField.locator('xpath=ancestor::div[contains(@class,"space-y-2")][1]').getByRole('checkbox', { name: 'Ilimitado' }).check();
  const unlimited = waitForApi(page, 'PATCH', `/platform/plans/${created.id}`);
  await dialog.getByRole('button', { name: 'Salvar alterações' }).click();
  expect((await unlimited).request().postDataJSON()).toEqual({ max_storage_mb: null });
  await expect(row.getByRole('definition').nth(3)).toHaveText('Ilimitado');

  // Restaura: o plano sai de venda (planos nunca são apagados)
  await row.getByRole('button', { name: `Tirar o plano ${name} de venda` }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Tirar o plano de venda?' });
  await confirm.getByRole('button', { name: 'Tirar de venda' }).click();
  await expect(toast(page, `${name} saiu de venda.`)).toBeVisible();
  await expect(row).toContainText('Indisponível');
  expect((await getJson(api, `/platform/plans/${created.id}`, superadmin.token)).status).toBe('INACTIVE');
});

test('assinaturas: detalhe da assinatura, agendar o cancelamento para o fim do período e desfazer', async ({ page }) => {
  const plan = await createPlan(api, superadmin, { name: `Plano Cobrança Web ${uid('c').slice(-8)}`, price: 59.9, max_storage_mb: 300 });
  planIds.push(plan.id);
  const store = await paidStore(api, superadmin, plan.id, 'Assinatura Web');
  paidStores.push(store);
  const before = await getJson(api, `/platform/subscriptions/${store.subscriptionId}`, superadmin.token);
  const periodEnd = DATE.format(new Date(before.current_period_end));

  await signIn(page, superadmin);
  await page.goto('/platform/subscriptions');
  await expect(pageHeading(page, 'Assinaturas')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Buscar assinaturas pela loja' }).fill(store.slug);
  const row = page.getByRole('table', { name: 'Assinaturas dos estabelecimentos' }).getByRole('row').filter({ hasText: store.name });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(plan.name);
  await expect(row).toContainText('Ativa');

  await row.getByRole('button', { name: `Gerenciar a assinatura de ${store.name}` }).click();
  const dialog = page.getByRole('dialog', { name: `Assinatura · ${store.name}` });
  const summary = dialog.getByRole('region', { name: 'Plano e situação da assinatura' });
  await expect(summary).toContainText(`Assinatura #${store.subscriptionId}`);
  await expect(summary).toContainText('R$ 59,90 / mês');
  await expect(summary).toContainText('Ativa');
  await expect(summary.getByRole('link', { name: `Ver auditoria da assinatura #${store.subscriptionId}` }))
    .toHaveAttribute('href', `/platform/audit?alvo_tipo=subscription&alvo=${store.subscriptionId}`);
  const dates = dialog.getByRole('region', { name: 'Datas da assinatura' });
  await expect(dates.getByRole('term').filter({ hasText: 'Fim do período / renovação' }).locator('xpath=following-sibling::dd[1]')).toHaveText(periodEnd);
  const usage = dialog.getByRole('region', { name: 'Uso e limites do plano' });
  await expect(usage).toContainText('Armazenamento');
  await expect(usage).toContainText('300 MB');
  const invoices = dialog.getByRole('region', { name: 'Faturas da assinatura' });
  const paid = (before.invoices as Json[]).find((invoice) => invoice.status === 'PAID');
  expect(paid, 'primeira fatura registrada como paga').toBeTruthy();
  await expect(invoices.getByRole('row').filter({ hasText: `#${paid.id}` })).toContainText('Paga');

  // Agendar o cancelamento para o fim do período pago
  await summary.getByRole('button', { name: 'Cancelar assinatura' }).click();
  let confirm = page.getByRole('alertdialog', { name: 'Cancelar a assinatura?' });
  await expect(confirm.getByRole('radio', { name: /No fim do período pago/ })).toBeChecked();
  await expect(confirm).toContainText(`Em ${periodEnd}; a loja usa até lá.`);
  await confirm.getByLabel('Motivo (opcional)').fill('Pedido do responsável pelo suporte (E2E web).');
  const cancel = waitForApi(page, 'POST', `/platform/subscriptions/${store.subscriptionId}/cancel`);
  await confirm.getByRole('button', { name: 'Agendar cancelamento' }).click();
  const cancelRes = await cancel;
  expect(cancelRes.request().postDataJSON()).toMatchObject({ at_period_end: true });
  expect(cancelRes.ok(), await cancelRes.text()).toBeTruthy();
  await expect(toast(page, `Cancelamento agendado para ${periodEnd}.`)).toBeVisible();
  const scheduled = dialog.getByRole('status').filter({ hasText: 'Cancelamento agendado' });
  await expect(scheduled).toContainText(`Cancelamento agendado para ${periodEnd} pela plataforma.`);
  await expect(dialog.getByRole('region', { name: 'Datas da assinatura' })).toContainText('Termina em (cancelamento agendado)');
  const afterCancel = await getJson(api, `/platform/subscriptions/${store.subscriptionId}`, superadmin.token);
  expect(afterCancel).toMatchObject({ status: 'ACTIVE', cancel_at_period_end: true, cancel_scheduled_by: 'PLATFORM' });

  // Desfazer: a assinatura continua
  await scheduled.getByRole('button', { name: 'Desfazer cancelamento' }).click();
  confirm = page.getByRole('alertdialog', { name: 'Desfazer o cancelamento?' });
  const resume = waitForApi(page, 'POST', `/platform/subscriptions/${store.subscriptionId}/resume`);
  await confirm.getByRole('button', { name: 'Desfazer cancelamento' }).click();
  expect((await resume).ok()).toBeTruthy();
  await expect(toast(page, 'Cancelamento desfeito: a assinatura continua.')).toBeVisible();
  await expect(dialog.getByRole('status').filter({ hasText: 'Cancelamento agendado' })).toHaveCount(0);
  await expect(summary.getByRole('button', { name: 'Cancelar assinatura' })).toBeVisible();
  const afterResume = await getJson(api, `/platform/subscriptions/${store.subscriptionId}`, superadmin.token);
  expect(afterResume).toMatchObject({ status: 'ACTIVE', cancel_at_period_end: false, cancel_scheduled_by: null });
  expect(afterResume.current_period_end).toBe(before.current_period_end);

  // O histórico registra o agendamento e a desistência
  const history = dialog.getByRole('region', { name: 'Histórico da assinatura' });
  await expect(history.getByRole('listitem')).not.toHaveCount(0);
  expect((afterResume.events as Json[]).length, 'eventos novos na assinatura').toBeGreaterThan((before.events as Json[]).length);
});
