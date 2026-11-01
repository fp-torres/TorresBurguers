import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { E2E } from '../../../support/env';
import { loginAs } from '../../../support/api';
import { sql } from '../billing/helpers';
import {
  Cleanup,
  MSG,
  addMember,
  addProduct,
  bearer,
  createStore,
  dateKey,
  demoStore,
  demoTeam,
  expectError,
  expectNoSecrets,
  expectStatus,
  getJson,
  makePng,
  newApi,
  pngFile,
  retireStore,
  storePath,
  uid,
  uploadImage,
  type Json,
  type Member,
  type PublicStore,
  type Session,
  type Team,
  type TenantStore,
} from './helpers';

/** Minutos até a meia-noite mais próxima no fuso (antes ou depois). */
function minutesFromMidnight(timeZone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const minutes = value('hour') * 60 + value('minute');
  return Math.min(minutes, 24 * 60 - minutes);
}

/**
 * Fuso em que "hoje" é outro dia em relação a São Paulo (fuso da loja A), longe da virada do dia
 * nos dois fusos. null perto da meia-noite de São Paulo.
 */
function zoneOnAnotherDay(now = new Date()): string | null {
  const home = 'America/Sao_Paulo';
  if (minutesFromMidnight(home, now) < 30) return null;
  for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    if (dateKey(now, zone) !== dateKey(now, home) && minutesFromMidnight(zone, now) >= 30) return zone;
  }
  return null;
}

/**
 * Seção 16 + 5.2 do pedido — configurações, credenciais de pagamento (nunca devolvidas), logo e
 * arquivos (prefixo s<storeId>-), banner da vitrine e assinatura: tudo é da loja do usuário
 * autenticado. A loja A (demo) só é LIDA aqui; as alterações acontecem nas lojas B e C deste arquivo.
 */
test.describe('Isolamento entre lojas: configurações, credenciais, logo, banner e assinatura', () => {
  const cleanup = new Cleanup();
  let api: APIRequestContext;
  let superadmin: Session;
  let demo: PublicStore;
  let teamA: Team;
  let storeB: TenantStore;
  let storeC: TenantStore;
  let employeeB: Member;

  test.beforeAll(async () => {
    api = await newApi();
    superadmin = await loginAs(api, 'superadmin');
    demo = await demoStore();
    teamA = await demoTeam(api);
    storeB = await createStore(api, superadmin, 'Config B');
    cleanup.add('desativar a loja B', () => retireStore(api, superadmin, storeB));
    storeC = await createStore(api, superadmin, 'Config C');
    cleanup.add('desativar a loja C', () => retireStore(api, superadmin, storeC));
    employeeB = await addMember(api, storeB.owner, 'EMPLOYEE');
  });

  test.afterAll(async () => {
    await cleanup.run();
    await api.dispose();
  });

  test('configurações: cada ADMIN lê e altera só a própria loja; a vitrine reflete só a loja alterada', async () => {
    const settingsA = await getJson(api, '/store/settings', teamA.ADMIN.token, 'configurações de A');
    const settingsC = await getJson(api, '/store/settings', storeC.owner.token, 'configurações de C');
    const profileA = await getJson(api, `/stores/${demo.slug}`);
    expect(settingsA.id).toBe(demo.id);
    expect(settingsC.id).toBe(storeC.id);

    const changes = {
      name: `Loja B renomeada ${uid('n')}`.slice(0, 120),
      description: 'Descrição exclusiva da loja B',
      phone: '21912345678',
      opening_message: 'Mensagem de abertura só de B',
      closing_message: 'Mensagem de fechamento só de B',
      takeout_estimate: '25-35 min',
      time_zone: 'America/Manaus',
      opening_hours: [{ day: 1, open: '10:00', close: '22:00' }],
      address_city: 'Niterói',
      address_state: 'RJ',
      primary_color: '#123ABC',
    };
    const updated = await expectStatus(await api.patch('/store/settings', { headers: bearer(storeB.owner.token), data: changes }), 200);
    expect(updated).toMatchObject({ id: storeB.id, slug: storeB.slug, ...changes });

    expect(await getJson(api, '/store/settings', teamA.ADMIN.token), 'configurações de A intactas').toEqual(settingsA);
    expect(await getJson(api, '/store/settings', storeC.owner.token), 'configurações de C intactas').toEqual(settingsC);
    expect(await getJson(api, `/stores/${demo.slug}`), 'vitrine de A intacta').toEqual(profileA);
    const profileB = await getJson(api, `/stores/${storeB.slug}`);
    expect(profileB).toMatchObject({ id: storeB.id, name: changes.name, description: changes.description, time_zone: 'America/Manaus', primary_color: '#123ABC' });
    expect((await getJson(api, storePath(storeB.slug, '/status'))).opening_message).toBe(changes.opening_message);
    expect((await getJson(api, storePath(demo.slug, '/status'))).opening_message).toBe(settingsA.opening_message);

    // A loja nunca vem do corpo: campos de identidade/situação/credenciais/abertura são recusados
    for (const [field, value] of Object.entries({
      id: demo.id,
      store_id: demo.id,
      slug: demo.slug,
      account_status: 'ACTIVE',
      owner_user_id: teamA.ADMIN.user.id,
      custom_domain: 'loja-b.example.com',
      logo: 's1-qualquer.webp',
      is_open: true,
      mp_access_token: 'TEST-1234567890123456',
    })) {
      await expectError(
        await api.patch('/store/settings', { headers: bearer(storeB.owner.token), data: { [field]: value } }),
        400,
        MSG.notAllowed(field),
        `PATCH /store/settings com ${field}`,
      );
    }
    // Só o ADMIN lê/altera as configurações (o atendente de B não)
    await expectError(await api.get('/store/settings', { headers: bearer(employeeB.token) }), 403, MSG.noPermission);
    await expectError(await api.patch('/store/settings', { headers: bearer(employeeB.token), data: { description: 'x' } }), 403, MSG.noPermission);
    expect((await getJson(api, '/store/settings', storeB.owner.token)).slug).toBe(storeB.slug);
  });

  test('credenciais de pagamento: gravadas por loja, mascaradas e nunca devolvidas (nem na auditoria)', async () => {
    const secret = randomBytes(12).toString('hex');
    const accessToken = `TEST-${Date.now()}-${secret}-${randomBytes(4).toString('hex')}`;
    const publicKey = `TEST-${randomBytes(8).toString('hex')}-${uid('pk')}`;
    const leaks = (value: unknown) => {
      const text = JSON.stringify(value);
      return [accessToken, secret, 'mp_access_token_encrypted'].filter((needle) => text.includes(needle));
    };

    const saved = await expectStatus(
      await api.put('/store/settings/payments', { headers: bearer(storeB.owner.token), data: { mp_public_key: publicKey, mp_access_token: accessToken } }),
      200,
    );
    expect(saved).toMatchObject({ mp_public_key: publicKey, access_token_configured: true, using_platform_credentials: false });
    expect(saved.access_token_hint, 'só uma dica do token').toMatch(/…/);
    expect(leaks(saved)).toEqual([]);

    const settingsB = await getJson(api, '/store/settings', storeB.owner.token);
    expect(settingsB.payments).toMatchObject({ mp_public_key: publicKey, access_token_configured: true, access_token_hint: saved.access_token_hint });
    expect(leaks(settingsB)).toEqual([]);
    const profileB = await getJson(api, `/stores/${storeB.slug}`);
    expect(profileB.payments).toEqual({ online_enabled: true, mp_public_key: publicKey });
    expect(leaks(profileB)).toEqual([]);

    // As outras lojas não herdam nada de B
    const settingsA = await getJson(api, '/store/settings', teamA.ADMIN.token);
    expect(settingsA.payments.mp_public_key).not.toBe(publicKey);
    expect(settingsA.payments.access_token_hint).not.toBe(saved.access_token_hint);
    expect(leaks(settingsA)).toEqual([]);
    const settingsC = await getJson(api, '/store/settings', storeC.owner.token);
    expect(settingsC.payments).toEqual({ mp_public_key: null, access_token_configured: false, access_token_hint: null, using_platform_credentials: false });
    for (const slug of [demo.slug, storeC.slug]) {
      expect((await getJson(api, `/stores/${slug}`)).payments.mp_public_key, `vitrine de ${slug}`).not.toBe(publicKey);
    }

    // Cifrado preso à loja (v2, contexto "store:<id>"): o valor de B copiado no banco para C não decifra em C
    // (C não ganha uma credencial utilizável nem a dica do token de B)
    const [stored] = await sql<{ token: string }>('SELECT mp_access_token_encrypted AS token FROM stores WHERE id = $1', [storeB.id]);
    expect(stored.token.startsWith('v2:'), 'token gravado no formato v2 (preso à loja)').toBe(true);
    await sql('UPDATE stores SET mp_access_token_encrypted = $1, mp_public_key = $2 WHERE id = $3', [stored.token, publicKey, storeC.id]);
    try {
      const copied = await getJson(api, '/store/settings', storeC.owner.token);
      expect(copied.payments, 'token de B copiado para C').toMatchObject({ access_token_configured: true, access_token_hint: null });
    } finally {
      await sql('UPDATE stores SET mp_access_token_encrypted = NULL, mp_public_key = NULL WHERE id = $1', [storeC.id]);
    }

    // Superpainel e auditoria também nunca mostram o token
    expect(leaks(await getJson(api, `/platform/stores/${storeB.id}`, superadmin.token)), 'detalhe da loja no superpainel').toEqual([]);
    expect(leaks(await getJson(api, `/platform/stores/${storeB.id}/audit?pageSize=100`, superadmin.token)), 'auditoria da loja').toEqual([]);

    // C remove as próprias credenciais: as de B continuam; B remove as dela
    const removedC = await expectStatus(await api.delete('/store/settings/payments', { headers: bearer(storeC.owner.token) }), 200);
    expect(removedC).toMatchObject({ mp_public_key: null, access_token_configured: false });
    expect((await getJson(api, '/store/settings', storeB.owner.token)).payments).toMatchObject({ mp_public_key: publicKey, access_token_configured: true });
    await expectError(await api.put('/store/settings/payments', { headers: bearer(employeeB.token), data: { mp_public_key: publicKey, mp_access_token: accessToken } }), 403, MSG.noPermission);
    await expectError(
      await api.put('/store/settings/payments', { headers: bearer(storeC.owner.token), data: { mp_public_key: publicKey, mp_access_token: accessToken, store_id: storeB.id } }),
      400,
      MSG.notAllowed('store_id'),
    );
    const removedB = await expectStatus(await api.delete('/store/settings/payments', { headers: bearer(storeB.owner.token) }), 200);
    expect(removedB).toMatchObject({ mp_public_key: null, access_token_configured: false, access_token_hint: null });
    expect((await getJson(api, `/stores/${storeB.slug}`)).payments.mp_public_key).toBeNull();
  });

  test('logo e arquivos levam o prefixo da loja; o arquivo de B é recusado em C e apagar o logo de C não apaga o de B', async () => {
    const logoA = (await getJson(api, '/store/settings', teamA.ADMIN.token)).logo;
    const uploadLogo = (token: string) =>
      api.post('/store/logo', { headers: bearer(token), multipart: { file: pngFile(makePng(32, 32), 'logo.png') } });

    const logoB = (await expectStatus(await uploadLogo(storeB.owner.token), 201)).logo as string;
    expect(logoB).toMatch(new RegExp(`^s${storeB.id}-[\\w.-]+\\.webp$`));
    expect(existsSync(path.join(E2E.uploadsDir, logoB)), 'arquivo do logo de B gravado').toBe(true);
    const served = await api.get(`/uploads/${logoB}`);
    expect(served.status()).toBe(200);
    expect(served.headers()['content-type']).toContain('image/webp');
    expect((await getJson(api, `/stores/${storeB.slug}`)).logo).toBe(logoB);
    expect((await getJson(api, `/stores/${demo.slug}`)).logo ?? null, 'vitrine de A sem o logo de B').toBe(logoA ?? null);
    expect((await getJson(api, '/store/settings', teamA.ADMIN.token)).logo ?? null).toBe(logoA ?? null);

    const logoC = (await expectStatus(await uploadLogo(storeC.owner.token), 201)).logo as string;
    expect(logoC).toMatch(new RegExp(`^s${storeC.id}-`));
    const fileC = await uploadImage(api, storeC.owner);
    expect(fileC.startsWith(`s${storeC.id}-`)).toBe(true);

    // O arquivo de B não serve para C (produto, adicional ou logo pelo corpo)
    await expectError(
      await api.post('/products', { headers: bearer(storeC.owner.token), data: { name: 'Com logo de B', price: 5, category: 'bebidas', image: logoB } }),
      400,
      MSG.invalidImage,
    );
    await expectError(await api.post('/addons', { headers: bearer(storeC.owner.token), data: { name: 'Com logo de B', price: 1, image: logoB } }), 400, MSG.invalidImage);
    await expectError(await api.patch('/store/settings', { headers: bearer(storeC.owner.token), data: { logo: logoB } }), 400, MSG.notAllowed('logo'));
    const own = await addProduct(api, storeC.owner, { image: fileC });
    expect(own.image, 'C usa o próprio arquivo').toBe(fileC);

    // C apaga o próprio logo: o arquivo de C sai do disco; o de B continua no disco e na vitrine de B
    expect(await expectStatus(await api.delete('/store/logo', { headers: bearer(storeC.owner.token) }), 200)).toEqual({ logo: null });
    expect(existsSync(path.join(E2E.uploadsDir, logoC)), 'arquivo do logo de C removido').toBe(false);
    expect(existsSync(path.join(E2E.uploadsDir, logoB)), 'arquivo do logo de B preservado').toBe(true);
    expect((await api.get(`/uploads/${logoB}`)).status()).toBe(200);
    expect((await getJson(api, '/store/settings', storeB.owner.token)).logo).toBe(logoB);

    // Só o ADMIN troca o logo (o atendente de B não)
    await expectError(await uploadLogo(employeeB.token), 403, MSG.noPermission);
  });

  test('banner da vitrine por loja: cada loja usa o próprio fuso; loja inexistente → 404', async () => {
    const bannerA = await getJson(api, storePath(demo.slug, '/promotions/banner'));
    expect(bannerA).toMatchObject({ type: expect.any(String), title: expect.any(String), message: expect.any(String) });
    // A rota antiga (global, fuso de Brasília) e a vitrine da loja A (America/Sao_Paulo) mostram o mesmo dia
    expect(await getJson(api, '/promotions/banner')).toEqual(bannerA);
    await expectError(await api.get(storePath('loja-que-nao-existe-tenancy', '/promotions/banner')), 404, MSG.storeNotFound);

    const zone = zoneOnAnotherDay();
    test.skip(zone === null, 'perto da meia-noite de São Paulo: o "hoje" das lojas muda durante o teste');
    await expectStatus(await api.patch('/store/settings', { headers: bearer(storeC.owner.token), data: { time_zone: zone } }), 200);
    const bannerC = await getJson(api, storePath(storeC.slug, '/promotions/banner'));
    expect(bannerC.title, `banner de C no fuso ${zone} (outro dia) ≠ banner de A`).not.toBe(bannerA.title);
    expect(await getJson(api, storePath(demo.slug, '/promotions/banner')), 'o fuso de C não muda o banner de A').toEqual(bannerA);
  });

  test('assinatura por loja: cada ADMIN vê só a própria assinatura, uso e limites; rotas de assinatura do superpainel → 403', async () => {
    const subA = await getJson(api, '/store/subscription', teamA.ADMIN.token);
    const subB = await getJson(api, '/store/subscription', storeB.owner.token);
    const subC = await getJson(api, '/store/subscription', storeC.owner.token);
    expect(subB.subscription.id).toBe(storeB.subscriptionId);
    expect(subC.subscription.id).toBe(storeC.subscriptionId);
    expect(new Set([subA.subscription.id, subB.subscription.id, subC.subscription.id]).size, 'uma assinatura por loja').toBe(3);
    expect(subB.usage).toEqual({ staff_users: 2, products: 0, monthly_orders: 0 });

    // B cadastra produtos: só o uso de B muda
    await addProduct(api, storeB.owner);
    await addProduct(api, storeB.owner);
    expect((await getJson(api, '/store/subscription', storeB.owner.token)).usage).toEqual({ staff_users: 2, products: 2, monthly_orders: 0 });
    expect((await getJson(api, '/store/subscription', teamA.ADMIN.token)).usage, 'uso de A intacto').toEqual(subA.usage);
    expect((await getJson(api, '/store/subscription', storeC.owner.token)).usage, 'uso de C intacto').toEqual(subC.usage);

    await expectError(await api.get('/store/subscription', { headers: bearer(employeeB.token) }), 403, MSG.noPermission);
    const foreign = subA.subscription.id;
    for (const [label, call] of [
      ['GET /platform/subscriptions/:id', () => api.get(`/platform/subscriptions/${foreign}`, { headers: bearer(storeB.owner.token) })],
      ['POST /platform/subscriptions/:id/cancel', () => api.post(`/platform/subscriptions/${foreign}/cancel`, { headers: bearer(storeB.owner.token), data: { reason: 'Tentativa da loja B' } })],
      ['POST /platform/subscriptions/:id/suspend', () => api.post(`/platform/subscriptions/${foreign}/suspend`, { headers: bearer(storeB.owner.token), data: { reason: 'Tentativa da loja B' } })],
      ['POST /platform/subscriptions/:id/change-plan', () => api.post(`/platform/subscriptions/${foreign}/change-plan`, { headers: bearer(storeB.owner.token), data: { plan_id: subB.plan.id } })],
    ] as Array<[string, () => Promise<APIResponse>]>) {
      await expectError(await call(), 403, MSG.platformOnly, `ADMIN de B: ${label}`);
    }
    // A assinatura de A continua igual (status e plano)
    const again = await getJson(api, '/store/subscription', teamA.ADMIN.token);
    expect(again.subscription).toEqual(subA.subscription);
    expectNoSecrets(again, 'assinatura de A');
  });
});
