import { test, expect, type Locator, type Page } from '@playwright/test';
import { E2E } from '../../../support/env';
import { signInAs } from '../../../support/web';
import {
  API_URL,
  DEFAULT_USERS,
  StaffApi,
  fieldByLabel,
  pageHeading,
  sidebar,
  tableRow,
  toast,
  trackApiWrites,
  uid,
  uniqueEmail,
  waitForApi,
} from './helpers';

let admin: StaffApi;

test.beforeAll(async () => {
  admin = await StaffApi.as('admin');
});

test.afterAll(async () => {
  await admin.dispose();
});

async function openTeam(page: Page) {
  await signInAs(page, 'admin');
  await page.goto('/users');
  await expect(pageHeading(page, 'Equipe')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Carregando membros...')).toHaveCount(0);
}

function memberDialog(page: Page, title: 'Novo Membro' | 'Editar Membro'): Locator {
  return page.getByRole('dialog', { name: title });
}

/** Célula "Cargo" (3ª coluna) de uma linha da Equipe. */
function roleCell(row: Locator): Locator {
  return row.getByRole('cell').nth(2);
}

async function fillMember(
  dialog: Locator,
  data: { name: string; email: string; confirmEmail?: string; phone?: string; role?: string; password: string; confirmPassword?: string },
) {
  await dialog.getByPlaceholder('Ex: João Silva').fill(data.name);
  if (data.phone) await dialog.getByPlaceholder('(99) 99999-9999').fill(data.phone);
  await fieldByLabel(dialog, 'Email').fill(data.email);
  await dialog.getByPlaceholder('Repita o email').fill(data.confirmEmail ?? data.email);
  if (data.role) await fieldByLabel(dialog, 'Cargo / Função').selectOption(data.role);
  await dialog.getByPlaceholder('Senha de Acesso').fill(data.password);
  await dialog.getByPlaceholder('Confirmar Senha').fill(data.confirmPassword ?? data.password);
}

async function loginStatus(page: Page, email: string, password: string): Promise<{ status: number; role?: string }> {
  const res = await page.request.post(`${API_URL}/auth/login`, { data: { email, password } });
  const body = res.ok() ? await res.json() : undefined;
  return { status: res.status(), role: body?.user?.role };
}

test.describe('Equipe (administrador)', () => {
  const roles = [
    { role: 'EMPLOYEE', label: 'Atendente', option: 'Atendente (Gestão de Pedidos)' },
    { role: 'KITCHEN', label: 'Cozinha', option: 'Cozinha (Ver Pedidos)' },
    { role: 'COURIER', label: 'Entregador', option: 'Entregador (Ver Entregas)' },
  ] as const;

  for (const r of roles) {
    test(`administrador cadastra um membro com o perfil ${r.label}`, async ({ page }) => {
      const name = `${r.label} WA ${uid('u')}`;
      const email = uniqueEmail(`wa-${r.role.toLowerCase()}`);
      const password = 'Equipe@Forte9';
      await openTeam(page);

      await page.getByRole('button', { name: 'Novo Membro' }).click();
      const dialog = memberDialog(page, 'Novo Membro');
      await expect(fieldByLabel(dialog, 'Cargo / Função'), 'novo membro começa como Atendente').toHaveValue('EMPLOYEE');
      await fillMember(dialog, { name, email, phone: '21987654321', role: r.role, password });
      await expect(dialog.getByPlaceholder('(99) 99999-9999')).toHaveValue('(21) 98765-4321');
      await expect(fieldByLabel(dialog, 'Cargo / Função').locator('option:checked')).toHaveText(r.option);
      await expect(dialog.getByText('Forte', { exact: true })).toBeVisible();

      const created = waitForApi(page, 'POST', '/users');
      await dialog.getByRole('button', { name: 'Cadastrar Membro' }).click();
      const res = await created;
      expect(res.status(), await res.text()).toBe(201);
      const user = await res.json();
      expect(user).not.toHaveProperty('password_hash');
      expect(user.role).toBe(r.role);
      await expect(toast(page, 'Novo membro cadastrado!')).toBeVisible();
      await expect(dialog).toBeHidden();

      const row = tableRow(page, email);
      await expect(row).toContainText(name);
      await expect(row).toContainText('(21) 98765-4321');
      await expect(roleCell(row)).toHaveText(r.label);

      // O novo membro entra com o perfil escolhido
      expect(await loginStatus(page, email, password)).toEqual({ status: 201, role: r.role });
    });
  }

  test('e-mail já cadastrado (inclusive com outra caixa) mostra a mensagem de duplicidade', async ({ page }) => {
    await openTeam(page);
    await page.getByRole('button', { name: 'Novo Membro' }).click();
    const dialog = memberDialog(page, 'Novo Membro');
    await fillMember(dialog, { name: `Duplicado ${uid('u')}`, email: DEFAULT_USERS.employee.email, role: 'EMPLOYEE', password: 'Equipe@Forte9' });

    let res = waitForApi(page, 'POST', '/users');
    await dialog.getByRole('button', { name: 'Cadastrar Membro' }).click();
    expect((await res).status()).toBe(409);
    await expect(toast(page, 'E-mail já cadastrado')).toBeVisible();
    await expect(dialog).toBeVisible();

    const upper = DEFAULT_USERS.employee.email.toUpperCase();
    await fieldByLabel(dialog, 'Email').fill(upper);
    await dialog.getByPlaceholder('Repita o email').fill(upper);
    res = waitForApi(page, 'POST', '/users');
    await dialog.getByRole('button', { name: 'Cadastrar Membro' }).click();
    expect((await res).status()).toBe(409);
    await expect(toast(page, 'E-mail já cadastrado')).toBeVisible();
    await expect(dialog).toBeVisible();
  });

  test('administrador altera o cargo de um membro e o novo perfil vale na hora', async ({ page }) => {
    const member = await admin.createStaff('EMPLOYEE', { name: `Promovido WA ${uid('u')}` });
    await openTeam(page);
    const row = tableRow(page, member.email);
    await expect(roleCell(row)).toHaveText('Atendente');

    await row.getByRole('button', { name: 'Editar' }).click();
    const dialog = memberDialog(page, 'Editar Membro');
    await expect(dialog.getByPlaceholder('Ex: João Silva')).toHaveValue(member.name);
    await expect(fieldByLabel(dialog, 'Email')).toHaveValue(member.email);
    await expect(fieldByLabel(dialog, 'Cargo / Função')).toHaveValue('EMPLOYEE');
    await expect(dialog.getByPlaceholder('Nova Senha (opcional)')).toHaveValue('');

    await fieldByLabel(dialog, 'Cargo / Função').selectOption('COURIER');
    const save = waitForApi(page, 'PATCH', `/users/${member.id}`);
    await dialog.getByRole('button', { name: 'Salvar Alterações' }).click();
    const res = await save;
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).not.toHaveProperty('password_hash');
    await expect(toast(page, 'Membro atualizado com sucesso!')).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(roleCell(row)).toHaveText('Entregador');

    expect((await admin.getUser(member.id)).role).toBe('COURIER');
    const drivers = (await (await admin.ctx.get('/orders/drivers/list')).json()) as { id: number }[];
    expect(drivers.map((d) => d.id), 'passa a aparecer no despacho').toContain(member.id);
    // Editar sem informar nova senha mantém a senha atual
    expect(await loginStatus(page, member.email, member.password)).toEqual({ status: 201, role: 'COURIER' });
  });

  test('administrador redefine a senha de um membro pela Equipe', async ({ page }) => {
    const member = await admin.createStaff('KITCHEN', { name: `Senha WA ${uid('u')}` });
    const newPassword = 'NovaSenha@2026';
    await openTeam(page);

    await tableRow(page, member.email).getByRole('button', { name: 'Editar' }).click();
    const dialog = memberDialog(page, 'Editar Membro');
    await dialog.getByPlaceholder('Nova Senha (opcional)').fill(newPassword);
    await dialog.getByPlaceholder('Confirmar Senha').fill(newPassword);
    const save = waitForApi(page, 'PATCH', `/users/${member.id}`);
    await dialog.getByRole('button', { name: 'Salvar Alterações' }).click();
    expect((await save).status()).toBe(200);
    await expect(toast(page, 'Membro atualizado com sucesso!')).toBeVisible();

    expect((await loginStatus(page, member.email, newPassword)).status).toBe(201);
    expect((await loginStatus(page, member.email, member.password)).status).toBe(401);
  });

  test('remover membro manda para a Lixeira sem acesso e restaurar devolve o acesso', async ({ page }) => {
    const member = await admin.createStaff('KITCHEN', { name: `Removido WA ${uid('u')}` });
    await openTeam(page);

    const row = tableRow(page, member.email);
    await row.getByRole('button', { name: 'Excluir' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Remover Membro?' });
    await expect(confirm).toContainText('pode ser restaurado depois pela Lixeira');
    const del = waitForApi(page, 'DELETE', `/users/${member.id}`);
    await confirm.getByRole('button', { name: 'Sim, Remover' }).click();
    expect((await del).status()).toBe(200);
    await expect(toast(page, 'Usuário removido.')).toBeVisible();
    await expect(row).toHaveCount(0);
    expect((await loginStatus(page, member.email, member.password)).status, 'sem acesso na lixeira').toBe(401);

    await sidebar(page).getByRole('link', { name: 'Lixeira' }).click();
    await expect(pageHeading(page, 'Lixeira do Sistema')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('tab', { name: /^Usuários/ }).click();
    const trashRow = tableRow(page, member.email);
    await expect(trashRow).toContainText(member.name);
    await expect(trashRow).toContainText('Cozinha');
    await expect(trashRow).not.toContainText('KITCHEN');
    await trashRow.getByRole('button', { name: 'Restaurar' }).click();
    const restore = page.getByRole('alertdialog', { name: 'Restaurar Item?' });
    await expect(restore).toContainText(`O usuário "${member.name}" voltará a ter acesso ao painel da loja.`);
    const res = waitForApi(page, 'PATCH', `/users/${member.id}/restore`);
    await restore.getByRole('button', { name: 'Sim, Restaurar' }).click();
    expect((await res).status()).toBe(200);
    await expect(toast(page, 'Item restaurado com sucesso!')).toBeVisible();
    await expect(trashRow).toHaveCount(0);

    expect(await loginStatus(page, member.email, member.password)).toEqual({ status: 201, role: 'KITCHEN' });
    await sidebar(page).getByRole('link', { name: 'Equipe' }).click();
    await expect(roleCell(tableRow(page, member.email))).toHaveText('Cozinha', { timeout: 20_000 });
  });

  test('perfis da equipe aparecem em português nas abas, na coluna Cargo e nas opções do formulário (sem clientes)', async ({ page }) => {
    await openTeam(page);
    const filters = page.getByRole('group', { name: 'Filtrar por perfil' });
    // Abas com contador ("Todos (13)": os parênteses são só para leitores de tela)
    for (const label of ['Todos', 'Administradores', 'Atendentes', 'Cozinha', 'Entregadores']) {
      await expect(filters.getByRole('button', { name: new RegExp(`^${label}\\s*\\(?\\s*\\d+\\s*\\)?$`) }), `aba ${label}`).toBeVisible();
    }
    // Clientes são contas globais da plataforma: não fazem parte da equipe
    await expect(filters.getByRole('button', { name: /^Clientes/ })).toHaveCount(0);
    await expect(tableRow(page, DEFAULT_USERS.client.email)).toHaveCount(0);
    await expect(tableRow(page, DEFAULT_USERS.superadmin.email)).toHaveCount(0);

    const expected = { admin: 'Administrador', employee: 'Atendente', kitchen: 'Cozinha', courier: 'Entregador' } as const;
    for (const [key, label] of Object.entries(expected) as [keyof typeof expected, string][]) {
      await expect(roleCell(tableRow(page, DEFAULT_USERS[key].email)), DEFAULT_USERS[key].email).toHaveText(label);
    }
    const roleTexts = await page.getByRole('row').locator('td:nth-child(3)').allInnerTexts();
    expect(roleTexts.filter((t) => /\b(ADMIN|EMPLOYEE|KITCHEN|COURIER|CLIENT)\b/.test(t)), 'códigos crus de perfil').toEqual([]);
    expect(roleTexts.filter((t) => /Cliente/.test(t)), 'nenhum cliente na equipe').toEqual([]);

    await page.getByRole('button', { name: 'Novo Membro' }).click();
    await expect(fieldByLabel(memberDialog(page, 'Novo Membro'), 'Cargo / Função').locator('option')).toHaveText([
      'Administrador (Acesso Total)',
      'Atendente (Gestão de Pedidos)',
      'Cozinha (Ver Pedidos)',
      'Entregador (Ver Entregas)',
    ]);
  });

  test('filtro por perfil e busca por nome ou ID mostram só os membros correspondentes', async ({ page }) => {
    const member = await admin.createStaff('COURIER', { name: `Filtro WA ${uid('u')}` });
    await openTeam(page);

    await page.getByRole('button', { name: /^Entregadores/ }).click();
    await expect(tableRow(page, member.email)).toBeVisible();
    await expect(tableRow(page, DEFAULT_USERS.kitchen.email)).toHaveCount(0);
    const roleTexts = await page.getByRole('row').locator('td:nth-child(3)').allInnerTexts();
    expect(new Set(roleTexts.map((t) => t.trim()))).toEqual(new Set(['Entregador']));

    await page.getByRole('button', { name: /^Todos/ }).click();
    const search = page.getByRole('searchbox', { name: 'Buscar na equipe' });
    await expect(search).toHaveAttribute('placeholder', 'Buscar por nome, e-mail ou ID...');
    await search.fill(member.name);
    await expect(page.getByRole('row').filter({ hasText: '@' })).toHaveCount(1);
    await search.fill(String(member.id));
    await expect(tableRow(page, member.email)).toBeVisible();
  });

  test('administrador não pode excluir a própria conta (botão desabilitado com explicação)', async ({ page }) => {
    await openTeam(page);
    const own = tableRow(page, DEFAULT_USERS.admin.email).getByRole('button', { name: 'Você não pode excluir a própria conta' });
    await expect(own).toBeVisible();
    await expect(own).toBeDisabled();
    await expect(tableRow(page, DEFAULT_USERS.kitchen.email).getByRole('button', { name: 'Excluir' })).toBeEnabled();
  });

  test('formulário de membro barra e-mails diferentes, senhas diferentes e senha fraca sem chamar a API', async ({ page }) => {
    await openTeam(page);
    const writes = trackApiWrites(page);
    await page.getByRole('button', { name: 'Novo Membro' }).click();
    const dialog = memberDialog(page, 'Novo Membro');
    const submit = dialog.getByRole('button', { name: 'Cadastrar Membro' });
    const email = uniqueEmail('wa-valida');

    await fillMember(dialog, { name: `Validação WA ${uid('u')}`, email, confirmEmail: `outro.${email}`, password: 'Equipe@Forte9' });
    await expect(dialog.getByText('Os e-mails não conferem.')).toBeVisible();
    await submit.click();
    await expect(toast(page, 'Os e-mails não coincidem.')).toBeVisible();

    await dialog.getByPlaceholder('Repita o email').fill(email);
    await dialog.getByPlaceholder('Confirmar Senha').fill('Outra@Senha9');
    await expect(dialog.getByText('As senhas não conferem.')).toBeVisible();
    await submit.click();
    await expect(toast(page, 'As senhas não coincidem.')).toBeVisible();

    await dialog.getByPlaceholder('Senha de Acesso').fill('fraca1');
    await dialog.getByPlaceholder('Confirmar Senha').fill('fraca1');
    await expect(dialog.getByText('Fraca', { exact: true })).toBeVisible();
    await submit.click();
    await expect(toast(page, 'A senha precisa ter no mínimo 9 caracteres, uma letra maiúscula e um número ou símbolo.')).toBeVisible();
    await expect(dialog).toBeVisible();
    expect(writes, 'nenhuma escrita na API').toEqual([]);
  });
});

test.describe('Equipe › convites (administrador)', () => {
  const CORS_HEADERS = { 'access-control-allow-origin': E2E.webURL, 'access-control-allow-credentials': 'true' };
  const isInvitations = (url: URL) => url.href.startsWith(API_URL) && url.pathname === '/store/invitations';

  function invitation(id: number, overrides: Record<string, unknown> = {}) {
    const now = Date.now();
    return {
      id,
      store_id: 1,
      email: `convite.${id}@e2e.test`,
      role: 'ADMIN',
      make_owner: false,
      status: 'PENDING',
      expires_at: new Date(now + 7 * 86_400_000).toISOString(),
      accepted_at: null,
      revoked_at: null,
      created_at: new Date(now).toISOString(),
      ...overrides,
    };
  }

  test('convite de troca do responsável (criado pela plataforma) não oferece "Revogar"; os demais sim', async ({ page }) => {
    const items = [invitation(990102, { make_owner: true }), invitation(990101, { role: 'EMPLOYEE' })];
    await page.route(isInvitations, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ status: 200, contentType: 'application/json', headers: CORS_HEADERS, body: JSON.stringify({ items, total: 2, page: 1, pageSize: 10 }) })
        : route.continue(),
    );
    await openTeam(page);

    const ownerRow = tableRow(page, 'convite.990102@e2e.test');
    await expect(ownerRow).toContainText('Novo responsável pela loja');
    await expect(ownerRow).toContainText('Criado pela plataforma');
    await expect(ownerRow.getByRole('button', { name: /Revogar/ })).toHaveCount(0);

    const employeeRow = tableRow(page, 'convite.990101@e2e.test');
    await expect(employeeRow.getByRole('button', { name: 'Revogar o convite de convite.990101@e2e.test' })).toBeVisible();
  });

  test('limite diário de convites (429) aparece no formulário com a mensagem da API', async ({ page }) => {
    const LIMIT = 'A loja atingiu o limite de convites das últimas 24 horas. Tente de novo amanhã.';
    let posts = 0;
    await page.route(isInvitations, (route) => {
      // Preflight (OPTIONS) e a lista seguem para a API; o POST nunca chega ao servidor
      if (route.request().method() !== 'POST') return route.continue();
      posts += 1;
      return route.fulfill({
        status: 429,
        contentType: 'application/json',
        headers: CORS_HEADERS,
        body: JSON.stringify({ statusCode: 429, message: LIMIT, error: 'Too Many Requests' }),
      });
    });
    await openTeam(page);
    await page.getByRole('button', { name: 'Convidar por e-mail' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Convidar por e-mail' });
    await dialog.getByPlaceholder('pessoa@email.com').fill(uniqueEmail('wa-convite'));
    await dialog.getByRole('button', { name: 'Criar convite' }).click();

    await expect.poll(() => posts).toBe(1);
    await expect(dialog.getByRole('alert')).toHaveText(LIMIT);
    await expect(dialog, 'o formulário continua aberto').toBeVisible();
    // Trocar o e-mail limpa o aviso
    await dialog.getByPlaceholder('pessoa@email.com').fill(uniqueEmail('wa-convite2'));
    await expect(dialog.getByRole('alert')).toHaveCount(0);
  });
});
