import { test, expect } from '@playwright/test';
import { signInAs } from '../../../support/web';
import { pageHeading, sidebar, visibleBrandTexts } from './helpers';

/** Renomeação do produto: o painel mostra "Comestra" e não sobra nenhum "Torres". */
test.describe('Marca no painel', () => {
  test('tela de login do painel mostra a marca Comestra e nenhum "Torres"', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveTitle(/^Comestra/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Comestra');
    await expect(page.getByText('Acesso Corporativo')).toBeVisible();
    expect(await visibleBrandTexts(page)).not.toMatch(/torres/i);
  });

  test('páginas do administrador mostram Comestra no título e no menu, sem "Torres"', async ({ page }) => {
    await signInAs(page, 'admin');
    const pages: [string, string | RegExp][] = [
      ['/dashboard', /^Dashboard/],
      ['/orders', 'Gestão de Pedidos'],
      ['/products', 'Cardápio'],
      ['/users', 'Equipe'],
      ['/trash', 'Lixeira do Sistema'],
    ];
    for (const [path, heading] of pages) {
      await page.goto(path);
      await expect(pageHeading(page, heading), path).toBeVisible({ timeout: 20_000 });
      await expect(page, path).toHaveTitle(/^Comestra/);
      await expect(sidebar(page).getByText('Comestra', { exact: true }), path).toBeVisible();
      expect(await visibleBrandTexts(page), `textos visíveis em ${path}`).not.toMatch(/torres/i);
    }
  });

  for (const [key, label] of [['kitchen', 'cozinha'], ['courier', 'entregador']] as const) {
    test(`quadro da ${label} também usa só a marca Comestra`, async ({ page }) => {
      await signInAs(page, key);
      await page.goto('/orders');
      await expect(pageHeading(page)).toBeVisible({ timeout: 20_000 });
      await expect(page).toHaveTitle(/^Comestra/);
      await expect(sidebar(page).getByText('Comestra', { exact: true })).toBeVisible();
      await expect(sidebar(page).getByText('Equipe', { exact: true })).toBeVisible();
      expect(await visibleBrandTexts(page), `textos visíveis para ${label}`).not.toMatch(/torres/i);
    });
  }
});
