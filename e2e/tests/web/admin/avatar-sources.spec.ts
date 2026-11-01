import { test, expect, type Page } from '@playwright/test';
import { signupClient, uid, type Session } from '../../../support/api';
import { signInAs, useSession } from '../../../support/web';
import { newApi, sql } from '../../api/billing/helpers';
import { PNG_1PX } from '../client/helpers';

/**
 * Fotos de perfil só de fontes conhecidas (services/api.ts avatarUrl): arquivo enviado (/uploads/...) ou um
 * dos ícones prontos (cdn-icons-png.flaticon.com). A API já recusa endereços externos novos, mas avatares
 * antigos assim podem continuar no banco: o painel e a vitrine não os carregam (um pixel de rastreamento
 * revelaria a quem o hospeda quem abriu a tela) e mostram as iniciais ou o ícone padrão.
 */

const TRACKER = 'https://rastreador.example/pixel.png';
const ICON = 'https://cdn-icons-png.flaticon.com/512/3075/3075977.png';

let tag: string;
let external: Session & { password: string };
let withIcon: Session & { password: string };

test.beforeAll(async () => {
  const api = await newApi();
  try {
    tag = uid('avatar').toLowerCase();
    external = await signupClient(api, { name: `Avatar Externo ${tag}` });
    withIcon = await signupClient(api, { name: `Avatar Icone ${tag}` });
    // Valores gravados direto no banco (como os de antes da validação da API)
    await sql('UPDATE users SET avatar = $1 WHERE id = $2', [TRACKER, external.user.id]);
    await sql('UPDATE users SET avatar = $1 WHERE id = $2', [ICON, withIcon.user.id]);
  } finally {
    await api.dispose();
  }
});

/** Bloqueia (e registra) o host externo; o host dos ícones prontos responde com um PNG local (sem internet). */
async function watchImageHosts(page: Page): Promise<string[]> {
  const trackerHits: string[] = [];
  await page.route('https://rastreador.example/**', (route) => {
    trackerHits.push(route.request().url());
    return route.abort();
  });
  await page.route('https://cdn-icons-png.flaticon.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1PX }),
  );
  return trackerHits;
}

test('superpainel (contas): o avatar externo antigo não é carregado; o ícone pronto continua', async ({ page }) => {
  const trackerHits = await watchImageHosts(page);
  await signInAs(page, 'superadmin');
  await page.goto(`/platform/users?busca=${encodeURIComponent(tag)}`);

  const iconRow = page.locator('tr', { hasText: withIcon.user.email });
  const externalRow = page.locator('tr', { hasText: external.user.email });
  await expect(iconRow).toBeVisible({ timeout: 20_000 });
  await expect(externalRow).toBeVisible();
  await expect(iconRow.locator('img')).toHaveAttribute('src', ICON);
  await expect(externalRow.locator('img'), 'sem <img> do endereço externo (iniciais no lugar)').toHaveCount(0);
  await page.waitForLoadState('networkidle');
  expect(trackerHits, 'nenhum pedido ao host externo').toEqual([]);
});

test('vitrine: a foto externa antiga do próprio cliente não é carregada no menu da conta', async ({ page }) => {
  const trackerHits = await watchImageHosts(page);
  await useSession(page, { token: external.token, user: { ...external.user, avatar: TRACKER } });
  await page.goto('/');

  const menu = page.getByRole('button', { name: 'Menu da conta' });
  await expect(menu).toBeVisible({ timeout: 20_000 });
  await expect(menu.locator('img'), 'ícone padrão no lugar da foto externa').toHaveCount(0);
  await page.waitForLoadState('networkidle');
  expect(trackerHits, 'nenhum pedido ao host externo').toEqual([]);
});

test('vitrine: o ícone pronto escolhido pelo cliente aparece no menu da conta', async ({ page }) => {
  await watchImageHosts(page);
  await useSession(page, { token: withIcon.token, user: { ...withIcon.user, avatar: ICON } });
  await page.goto('/');

  const menu = page.getByRole('button', { name: 'Menu da conta' });
  await expect(menu).toBeVisible({ timeout: 20_000 });
  await expect(menu.locator('img')).toHaveAttribute('src', ICON);
});
