import { test, expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { contextAs, demoStore, loginAs, type Session } from '../../../support/api';
import { BRAND } from '../../../support/env';
import { signInAs, useSession } from '../../../support/web';
import { API_URL, DEFAULT_USERS, STORAGE_KEYS, sidebar, toast } from './helpers';

/** Sessão de um usuário padrão aberta pela API (sem passar pela tela). */
async function apiSession(key: keyof typeof DEFAULT_USERS): Promise<Session> {
  const api = await request.newContext({ baseURL: API_URL });
  try {
    return await loginAs(api, key);
  } finally {
    await api.dispose();
  }
}

/** Tudo o que a página guardou no localStorage (chave → valor). */
async function localData(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const data: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      data[key] = localStorage.getItem(key) ?? '';
    }
    return data;
  });
}

/** Identidade exibida no cabeçalho do painel ("<Perfil> · <e-mail>"). */
function panelIdentity(page: Page) {
  return page.getByRole('banner');
}

// ---------------------------------------------------------------------------
// Sessão sincronizada entre abas (mesmo navegador = mesmo localStorage)
// ---------------------------------------------------------------------------

test.describe('Sessão entre abas', () => {
  test('outra aba entra com outra conta: a aba aberta passa para a nova sessão em vez de seguir mostrando a anterior', async ({ context }) => {
    const admin = await apiSession('admin');
    const tabA = await context.newPage();
    await useSession(tabA, admin);
    await tabA.goto('/orders');
    await expect(panelIdentity(tabA)).toContainText(`Administrador · ${DEFAULT_USERS.admin.email}`, { timeout: 20_000 });

    // Outra aba do mesmo navegador passa a usar a conta do atendente (o login de outra conta grava usuário e
    // token no localStorage compartilhado). A aba A só fica sabendo pelo evento "storage".
    const employee = await apiSession('employee');
    const tabB = await context.newPage();
    await tabB.goto('/');
    await tabB.evaluate(({ keys, token, user }) => {
      localStorage.setItem(keys.user, JSON.stringify(user));
      localStorage.setItem(keys.token, token);
    }, { keys: STORAGE_KEYS, token: employee.token, user: employee.user });

    // A aba A não pode continuar dizendo "Administrador" enquanto as chamadas saem com o token do atendente
    await expect(panelIdentity(tabA)).toContainText(`Atendente · ${DEFAULT_USERS.employee.email}`, { timeout: 10_000 });
    await expect(toast(tabA, /A sessão mudou em outra aba/)).toBeVisible();
    await expect(tabA).toHaveURL(/\/orders$/);
  });

  test('sessão trocada sem aviso (aba que perdeu o evento): nenhuma chamada sai com o token da outra conta enquanto a tela mostra a anterior', async ({ page }) => {
    const admin = await signInAs(page, 'admin');
    const employee = await apiSession('employee');
    expect(admin.token).not.toBe(employee.token);
    await page.goto('/orders');
    await expect(panelIdentity(page)).toContainText(`Administrador · ${DEFAULT_USERS.admin.email}`, { timeout: 20_000 });

    // Cada chamada com o token do atendente é conferida contra o que o cabeçalho mostra naquele momento
    const sentWhileShowingAdmin: string[] = [];
    await page.route((url) => url.origin === new URL(API_URL).origin, async (route) => {
      if (route.request().headers().authorization === `Bearer ${employee.token}`) {
        const header = await page.evaluate(() => document.querySelector('header')?.textContent ?? '').catch(() => '');
        if (header.includes(DEFAULT_USERS.admin.email)) sentWhileShowingAdmin.push(`${route.request().method()} ${route.request().url()}`);
      }
      await route.continue();
    });

    // Gravação no próprio documento não dispara o evento "storage" nesta aba (simula a aba congelada ou sem aviso)
    await page.evaluate(({ keys, token, user }) => {
      localStorage.setItem(keys.user, JSON.stringify(user));
      localStorage.setItem(keys.token, token);
    }, { keys: STORAGE_KEYS, token: employee.token, user: employee.user });

    // O quadro de pedidos atualiza sozinho (a cada 5 s): a chamada seguinte percebe a troca e a tela acompanha
    await expect(panelIdentity(page)).toContainText(`Atendente · ${DEFAULT_USERS.employee.email}`, { timeout: 15_000 });
    expect(sentWhileShowingAdmin, 'chamadas com o token do atendente enquanto a tela mostrava o administrador').toEqual([]);
  });

  test('sair em outra aba encerra a sessão nesta: o painel não continua exibindo os dados', async ({ context }) => {
    const admin = await apiSession('admin');
    const tabA = await context.newPage();
    await useSession(tabA, admin);
    await tabA.goto('/customers');
    await expect(panelIdentity(tabA)).toContainText(`Administrador · ${DEFAULT_USERS.admin.email}`, { timeout: 20_000 });

    const tabB = await context.newPage();
    await tabB.goto('/orders');
    await sidebar(tabB).getByRole('button', { name: 'Sair do Sistema' }).click();
    await tabB.getByRole('alertdialog', { name: 'Sair do Sistema?' }).getByRole('button', { name: 'Sair', exact: true }).click();
    await expect(tabB).toHaveURL(/\/login$/);

    await expect(tabA).toHaveURL(/\/login$/, { timeout: 10_000 });
    await expect(toast(tabA, 'Você saiu da conta em outra aba.')).toBeVisible();
    await expect(tabA.getByRole('button', { name: 'Acessar Sistema' })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Sessão de suporte (superadmin no painel de uma loja, somente leitura)
// ---------------------------------------------------------------------------

interface StartedSupport {
  id: number;
  superadmin: Session;
}

/** Superadmin abre o detalhe da loja demo e inicia uma sessão de suporte pela tela (cai no Dashboard da loja). */
async function startSupportViaUi(page: Page): Promise<StartedSupport> {
  const superadmin = await signInAs(page, 'superadmin');
  const store = await demoStore();
  await page.goto(`/platform/stores/${store.id}?tab=support`);
  await page.getByRole('button', { name: 'Iniciar sessão de suporte' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Iniciar sessão de suporte?' });
  await dialog.getByLabel('Motivo').fill('Chamado E2E: conferir o painel da loja demo com o responsável.');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && /\/platform\/stores\/\d+\/support-sessions$/.test(new URL(r.url()).pathname));
  await dialog.getByRole('button', { name: 'Iniciar e abrir o painel' }).click();
  const body = await (await started).json();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(sidebar(page).getByText('Suporte', { exact: true })).toBeVisible();
  return { id: body.session.id as number, superadmin };
}

/** Situação da sessão de suporte na API (ACTIVE, ENDED ou EXPIRED). */
async function supportStatus(api: APIRequestContext, id: number): Promise<string> {
  const store = await demoStore();
  const res = await api.get(`/platform/support-sessions?store_id=${store.id}&page=1&pageSize=100`);
  expect(res.ok(), await res.text()).toBeTruthy();
  const { items } = await res.json();
  const session = (items as { id: number; status: string }[]).find((item) => item.id === id);
  expect(session, `sessão de suporte ${id} na lista`).toBeTruthy();
  return session!.status;
}

test.describe('Sessão de suporte no navegador', () => {
  let platform: { ctx: APIRequestContext };

  test.beforeAll(async () => {
    platform = await contextAs('superadmin');
  });

  test.afterAll(async () => {
    await platform.ctx.dispose();
  });

  test('durante o suporte o token do superpainel não fica guardado no navegador; encerrar volta ao superpainel', async ({ page }) => {
    const { id, superadmin } = await startSupportViaUi(page);

    const storage = await localData(page);
    expect(Object.values(storage).join('\n'), 'token pleno do superadmin no localStorage').not.toContain(superadmin.token);
    expect(storage[`${BRAND.slug}.platformSession`], 'sessão do superpainel guardada no navegador').toBeUndefined();

    await page.getByRole('button', { name: 'Encerrar e voltar ao superpainel' }).click();
    await expect(page).toHaveURL(/\/platform$/);
    await expect(sidebar(page).getByText('Suporte', { exact: true })).toBeHidden();
    await expect.poll(() => supportStatus(platform.ctx, id)).toBe('ENDED');
  });

  test('"Sair do Sistema" durante o suporte encerra a sessão de suporte no servidor', async ({ page }) => {
    const { id } = await startSupportViaUi(page);
    expect(await supportStatus(platform.ctx, id)).toBe('ACTIVE');

    await sidebar(page).getByRole('button', { name: 'Sair do Sistema' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Sair do Sistema?' });
    await expect.soft(dialog).toContainText('A sessão de suporte será encerrada');
    await dialog.getByRole('button', { name: 'Sair', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);

    await expect.poll(() => supportStatus(platform.ctx, id)).toBe('ENDED');
    const storage = await localData(page);
    expect(storage[STORAGE_KEYS.token]).toBeUndefined();
  });

  test('página recarregada durante o suporte: encerrar pede novo login e a sessão termina no servidor ao entrar', async ({ page }) => {
    const { id } = await startSupportViaUi(page);
    await page.reload();
    await expect(sidebar(page).getByText('Suporte', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Encerrar e voltar ao superpainel' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(toast(page, /Entre novamente para voltar ao superpainel/)).toBeVisible();
    expect((await localData(page))[STORAGE_KEYS.token]).toBeUndefined();

    const admin = DEFAULT_USERS.superadmin;
    await page.getByPlaceholder('nome@empresa.com.br').fill(admin.email);
    await page.getByPlaceholder('••••••••').fill(admin.password);
    await page.getByRole('button', { name: 'Acessar Sistema' }).click();
    await expect(page).toHaveURL(/\/platform$/);
    await expect.poll(() => supportStatus(platform.ctx, id)).toBe('ENDED');
  });
});
