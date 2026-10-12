import { test, expect, type Page } from '@playwright/test';
import { signInAs } from '../../../support/web';
import { API_URL, StaffApi, pageHeading, toast } from './helpers';

/**
 * Abrir/fechar a loja no painel. A loja REAL nunca é fechada aqui: GET e PATCH /store/status
 * são atendidos pelo page.route (o PATCH nunca chega ao servidor).
 */

const CORS_HEADERS = {
  'access-control-allow-origin': 'http://localhost:5174',
  'access-control-allow-credentials': 'true',
};

interface StoreMock {
  isOpen: boolean;
  patches: { body: Record<string, unknown>; authorization?: string }[];
  /** Status devolvido ao PATCH (200 = sucesso). */
  patchStatus: number;
  /** PATCH que chegou ao servidor de verdade (não deveria acontecer). */
  realPatches: number;
}

function statusBody(isOpen: boolean) {
  return { id: 1, is_open: isOpen, opening_message: null, closing_message: null };
}

async function mockStoreStatus(page: Page, initialOpen: boolean): Promise<StoreMock> {
  const state: StoreMock = { isOpen: initialOpen, patches: [], patchStatus: 200, realPatches: 0 };

  await page.context().route(`${API_URL}/store/status`, async (route) => {
    const req = route.request();
    if (req.method() === 'PATCH') {
      const payload = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      state.patches.push({ body: payload, authorization: req.headers()['authorization'] });
      const headers = { ...CORS_HEADERS, 'x-e2e-mock': '1' };
      if (state.patchStatus !== 200) {
        return route.fulfill({
          status: state.patchStatus,
          headers,
          contentType: 'application/json',
          body: JSON.stringify({ statusCode: state.patchStatus, message: 'Falha simulada pelo teste', error: 'Error' }),
        });
      }
      if (typeof payload.is_open === 'boolean') state.isOpen = payload.is_open;
      return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(statusBody(state.isOpen)) });
    }
    if (req.method() === 'GET') {
      return route.fulfill({ status: 200, headers: CORS_HEADERS, contentType: 'application/json', body: JSON.stringify(statusBody(state.isOpen)) });
    }
    return route.continue(); // preflight (OPTIONS) segue para a API; não altera nada
  });

  // Rede de segurança: um PATCH sem o cabeçalho do mock teria chegado ao servidor
  page.on('response', (res) => {
    if (res.url() === `${API_URL}/store/status` && res.request().method() === 'PATCH' && !res.headers()['x-e2e-mock']) {
      state.realPatches += 1;
    }
  });
  return state;
}

let store: StoreMock | undefined;

test.afterEach(async () => {
  // Só reabre se ESTE teste tiver fechado a loja de verdade (o mock falhou); nunca mexe na loja à toa
  if (store && store.realPatches > 0) {
    const admin = await StaffApi.as('admin');
    await admin.ctx.patch('/store/status', { data: { is_open: true } });
    await admin.dispose();
  }
  expect(store?.realPatches ?? 0, 'nenhum PATCH /store/status pode chegar ao servidor').toBe(0);
  store = undefined;
});

test.describe('Interruptor da loja no quadro de pedidos', () => {
  test('atendente vê "Loja aberta" ligado quando GET /store/status diz que a loja está aberta', async ({ page }) => {
    store = await mockStoreStatus(page, true);
    await signInAs(page, 'employee');
    await page.goto('/orders');
    await expect(pageHeading(page, 'Gestão de Pedidos')).toBeVisible({ timeout: 20_000 });

    const toggle = page.getByRole('switch');
    await expect(toggle).toHaveAccessibleName('Loja aberta');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(store.patches).toHaveLength(0);
  });

  test('loja fechada aparece desligada e abrir chama PATCH /store/status sem pedir confirmação', async ({ page }) => {
    store = await mockStoreStatus(page, false);
    await signInAs(page, 'employee');
    await page.goto('/orders');

    const toggle = page.getByRole('switch');
    await expect(toggle).toHaveAccessibleName('Loja fechada', { timeout: 20_000 });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    await toggle.click();
    await expect(toggle).toHaveAccessibleName('Loja aberta');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(toast(page, 'Loja aberta! Os clientes já podem fazer pedidos.')).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    expect(store.patches.map((p) => p.body)).toEqual([{ is_open: true }]);
    expect(store.patches[0].authorization).toMatch(/^Bearer \S+/);
  });

  test('fechar a loja pede confirmação; cancelar não chama a API e confirmar envia is_open=false', async ({ page }) => {
    store = await mockStoreStatus(page, true);
    await signInAs(page, 'admin');
    await page.goto('/orders');

    const toggle = page.getByRole('switch');
    await expect(toggle).toHaveAccessibleName('Loja aberta', { timeout: 20_000 });

    await toggle.click();
    const confirm = page.getByRole('alertdialog', { name: 'Fechar a loja?' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('Os clientes não conseguirão fazer novos pedidos');
    await confirm.getByRole('button', { name: 'Cancelar' }).click();
    await expect(confirm).toBeHidden();
    await expect(toggle).toHaveAccessibleName('Loja aberta');
    expect(store.patches).toHaveLength(0);

    await toggle.click();
    await page.getByRole('alertdialog', { name: 'Fechar a loja?' }).getByRole('button', { name: 'Fechar loja' }).click();
    await expect(toggle).toHaveAccessibleName('Loja fechada');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(toast(page, 'Loja fechada. Novos pedidos estão pausados.')).toBeVisible();
    expect(store.patches.map((p) => p.body)).toEqual([{ is_open: false }]);
  });

  test('falha ao alterar o status mostra o erro e mantém o interruptor como estava', async ({ page }) => {
    store = await mockStoreStatus(page, false);
    store.patchStatus = 500;
    await signInAs(page, 'employee');
    await page.goto('/orders');

    const toggle = page.getByRole('switch');
    await expect(toggle).toHaveAccessibleName('Loja fechada', { timeout: 20_000 });
    await toggle.click();
    await expect(toast(page, 'Falha simulada pelo teste')).toBeVisible();
    await expect(toggle).toHaveAccessibleName('Loja fechada');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(toggle).toBeEnabled();
    expect(store.patches).toHaveLength(1);
  });

  test('o interruptor acompanha uma mudança de status feita em outro lugar ao voltar para a aba', async ({ page }) => {
    store = await mockStoreStatus(page, true);
    await signInAs(page, 'employee');
    await page.goto('/orders');
    const toggle = page.getByRole('switch');
    await expect(toggle).toHaveAccessibleName('Loja aberta', { timeout: 20_000 });

    // Outra pessoa fechou a loja: a próxima consulta (ao voltar para a aba) traz o novo status
    store.isOpen = false;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(toggle).toHaveAccessibleName('Loja fechada');
    expect(store.patches).toHaveLength(0);
  });

  for (const [key, label] of [['kitchen', 'cozinha'], ['courier', 'entregador']] as const) {
    test(`${label} não vê o controle de abrir/fechar a loja`, async ({ page }) => {
      store = await mockStoreStatus(page, true);
      await signInAs(page, key);
      await page.goto('/orders');
      await expect(pageHeading(page)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole('switch')).toHaveCount(0);
      await expect(page.getByText(/^Loja (aberta|fechada)$/)).toHaveCount(0);
    });
  }
});

test.describe('Botão da loja no Dashboard', () => {
  test('reflete GET /store/status e alterna pelo PATCH /store/status (fechar com confirmação)', async ({ page }) => {
    store = await mockStoreStatus(page, false);
    await signInAs(page, 'admin');
    await page.goto('/dashboard');

    const button = page.getByRole('button', { name: /Loja Online/ });
    await expect(button).toContainText('FECHADA', { timeout: 20_000 });
    await expect(button).toHaveAttribute('aria-pressed', 'false');

    await button.click();
    await expect(button).toContainText('ABERTA');
    await expect(button).toHaveAttribute('aria-pressed', 'true');

    await button.click();
    await page.getByRole('alertdialog', { name: 'Fechar a loja?' }).getByRole('button', { name: 'Fechar loja' }).click();
    await expect(button).toContainText('FECHADA');
    await expect(button).toHaveAttribute('aria-pressed', 'false');

    expect(store.patches.map((p) => p.body)).toEqual([{ is_open: true }, { is_open: false }]);
  });
});
