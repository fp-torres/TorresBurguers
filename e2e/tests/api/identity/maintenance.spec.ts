/**
 * Manutenção do superpainel (common/maintenance.controller.ts), além da otimização de imagens (uploads.spec.ts):
 * - limpeza das imagens de /uploads sem uso há mais de 24 h, em segundo plano (uma por vez):
 *   POST /platform/maintenance/cleanup-uploads { mode: 'check' } (só conta) ou { mode: 'delete', confirm: true };
 *   GET da mesma rota acompanha ({ job | null });
 * - credenciais Mercado Pago no formato antigo (v1) regravadas no atual, preso à loja (v2):
 *   GET /platform/maintenance/store-credentials e POST /platform/maintenance/store-credentials/reencrypt.
 * Somente o superadmin (fora de sessão de suporte); tudo auditado só com contagens.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { BRAND, E2E } from '../../../support/env';
import { sql } from '../billing/helpers';
import { createStore, type TenantStore } from '../tenancy/helpers';
import { bearer, createProduct, demoStore, expectError, makePng, newClient, retireProduct, sessionOf, uid } from './helpers';

const CLEANUP_PATH = '/platform/maintenance/cleanup-uploads';
const STATUS_PATH = '/platform/maintenance/store-credentials';
const REENCRYPT_PATH = '/platform/maintenance/store-credentials/reencrypt';
const NON_PLATFORM = ['admin', 'client', 'employee', 'kitchen', 'courier'] as const;

type CleanupSummary = {
  mode: 'check' | 'delete';
  min_age_hours: number;
  files_scanned: number;
  in_use: number;
  recent: number;
  orphans: number;
  orphan_bytes: number;
  deleted: number;
  deleted_bytes: number;
  failed: number;
  skipped: number;
};
type CleanupJob = {
  id: number;
  kind: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  finished_at: string | null;
  summary: CleanupSummary | null;
  error: string | null;
  started_by: { id: number; name: string } | null;
};

/** Todas as rotas novas, com o corpo que o superadmin enviaria (as recusas usam o mesmo corpo). */
const ROUTES: Array<{ method: 'get' | 'post'; path: string; data?: Record<string, unknown> }> = [
  { method: 'get', path: CLEANUP_PATH },
  { method: 'post', path: CLEANUP_PATH, data: { mode: 'check' } },
  { method: 'get', path: STATUS_PATH },
  { method: 'post', path: REENCRYPT_PATH },
];

const call = (api: APIRequestContext, route: (typeof ROUTES)[number], token?: string) =>
  api[route.method](route.path, { headers: token ? bearer(token) : {}, data: route.data });

/** Libera a trava da limpeza se uma rodada anterior parou no meio (execuções reais duram milissegundos). */
async function releaseCleanupJobs(): Promise<void> {
  await sql(
    `UPDATE "maintenance_jobs" SET "status" = 'FAILED', "finished_at" = now(), "error" = 'Encerrada pelo teste E2E.'
     WHERE "status" = 'RUNNING' AND "kind" = 'cleanup_uploads'`,
  );
}

async function latestCleanup(api: APIRequestContext, token: string): Promise<CleanupJob | null> {
  const res = await api.get(CLEANUP_PATH, { headers: bearer(token) });
  expect(res.status(), await res.text()).toBe(200);
  const payload = await res.json();
  expect(Object.keys(payload)).toEqual(['job']);
  return payload.job;
}

/** Inicia uma limpeza e acompanha pelo GET (como o superpainel) até terminar. */
async function runCleanup(
  api: APIRequestContext,
  token: string,
  data: Record<string, unknown>,
): Promise<{ started: CleanupJob; finished: CleanupJob }> {
  const res = await api.post(CLEANUP_PATH, { headers: bearer(token), data });
  expect(res.status(), await res.text()).toBe(202);
  const payload = await res.json();
  expect(Object.keys(payload)).toEqual(['job']);
  const started: CleanupJob = payload.job;
  let finished: CleanupJob | null = null;
  await expect
    .poll(
      async () => {
        finished = await latestCleanup(api, token);
        return finished?.id === started.id ? finished.status : `última execução não é a #${started.id}`;
      },
      { message: `limpeza #${started.id} terminar`, timeout: 60_000, intervals: [200, 500, 1_000] },
    )
    .toMatch(/^(SUCCEEDED|FAILED)$/);
  return { started, finished: finished as unknown as CleanupJob };
}

test.describe('Manutenção: limpeza de arquivos sem uso e credenciais — somente superadmin', () => {
  test.beforeAll(releaseCleanupJobs);

  test('anônimo → 401; equipe da loja e cliente → 403; nada roda', async ({ request }) => {
    const { token } = await sessionOf(request, 'superadmin');
    const before = (await latestCleanup(request, token))?.id ?? null;
    for (const route of ROUTES) {
      await expectError(await call(request, route), 401);
      for (const key of NON_PLATFORM) {
        const session = await sessionOf(request, key);
        await expectError(await call(request, route, session.token), 403);
      }
    }
    expect((await latestCleanup(request, token))?.id ?? null, 'nenhuma limpeza nova').toBe(before);
  });

  test('superadmin em sessão de suporte (token da loja) → 403', async ({ request }) => {
    const superadmin = await sessionOf(request, 'superadmin');
    const store = await demoStore();
    const opened = await request.post(`/platform/stores/${store.id}/support-sessions`, {
      headers: bearer(superadmin.token),
      data: { reason: 'Teste E2E: limpeza e credenciais fora do alcance do suporte' },
    });
    expect(opened.status(), await opened.text()).toBe(201);
    const { access_token: supportToken, session } = await opened.json();
    try {
      for (const route of ROUTES) await expectError(await call(request, route, supportToken), 403);
    } finally {
      await request.post(`/platform/support-sessions/${session.id}/end`, { headers: bearer(superadmin.token) });
    }
  });

  test('validação: modo obrigatório e apagar só com confirm: true', async ({ request }) => {
    const { token } = await sessionOf(request, 'superadmin');
    const before = (await latestCleanup(request, token))?.id ?? null;
    for (const data of [undefined, {}, { mode: 'tudo' }, { mode: 'DELETE', confirm: true }]) {
      await expectError(await request.post(CLEANUP_PATH, { headers: bearer(token), data }), 400, /modo da limpeza/);
    }
    for (const data of [{ mode: 'delete' }, { mode: 'delete', confirm: false }, { mode: 'delete', confirm: 'true' }]) {
      await expectError(await request.post(CLEANUP_PATH, { headers: bearer(token), data }), 400, /confirm: true/);
    }
    await expectError(
      await request.post(CLEANUP_PATH, { headers: bearer(token), data: { mode: 'check', pasta: '/etc' } }),
      400,
      /pasta/,
    );
    expect((await latestCleanup(request, token))?.id ?? null, 'nenhuma limpeza nova').toBe(before);
  });

  test('verificar só conta; apagar remove só as imagens sem uso há mais de 24 h (inclusive lixeira e URLs ficam)', async ({ request }) => {
    const superadmin = await sessionOf(request, 'superadmin');
    const admin = await sessionOf(request, 'admin');
    const store = await demoStore();
    const tag = uid('limpeza').toLowerCase();
    const dir = E2E.uploadsDir;
    const outsideDir = `${dir}-fora-${tag}`;
    mkdirSync(dir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });

    /** Grava uma imagem com a idade (horas, pela data de modificação) informada. */
    const plant = (name: string, ageHours: number, base = dir): { file: string; bytes: number } => {
      const file = nodePath.join(base, name);
      const content = makePng(16, 16, { noise: true });
      writeFileSync(file, content);
      const time = new Date(Date.now() - ageHours * 3_600_000);
      utimesSync(file, time, time);
      return { file, bytes: content.length };
    };
    const name = (label: string, ext = 'png') => `e2e-${tag}-${label}.${ext}`;

    // Cadastros que usam arquivos antigos: produto, produto na lixeira, adicional, avatar, logo e URL completa
    const product = await createProduct(request);
    const trashed = await createProduct(request);
    const withUrl = await createProduct(request);
    const client = await newClient(request);
    const addonRes = await request.post('/addons', {
      headers: bearer(admin.token),
      data: { name: `[E2E] Adicional ${tag}`, price: 1 },
    });
    expect(addonRes.status(), await addonRes.text()).toBe(201);
    const addon = await addonRes.json();
    const [{ logo: originalLogo }] = await sql<{ logo: string | null }>('SELECT "logo" FROM "stores" WHERE "id" = $1', [store.id]);

    const kept = {
      product: plant(name('produto'), 30),
      trashed: plant(name('lixeira'), 30),
      addon: plant(name('adicional'), 30),
      avatar: plant(name('avatar', 'webp'), 30),
      logo: plant(name('logo', 'webp'), 30),
      url: plant(name('url'), 30),
      recent: plant(name('recente'), 1),
      hidden: plant(`.${name('oculto')}`, 30),
      text: plant(name('notas', 'txt'), 30),
    };
    mkdirSync(nodePath.join(dir, name('pasta', 'd')), { recursive: true });
    const nested = plant('dentro.png', 30, nodePath.join(dir, name('pasta', 'd')));
    const outside = plant(name('fora'), 30, outsideDir);
    const orphans = [plant(name('orfao'), 30), plant(name('orfao-antigo', 'webp'), 24 * 40)];
    const orphanBytes = orphans.reduce((total, orphan) => total + orphan.bytes, 0);

    try {
      await sql('UPDATE "products" SET "image" = $1 WHERE "id" = $2', [name('produto'), product.id]);
      await sql('UPDATE "products" SET "image" = $1 WHERE "id" = $2', [name('lixeira'), trashed.id]);
      await retireProduct(request, trashed.id); // vai para a lixeira: a imagem continua em uso
      await sql('UPDATE "products" SET "image" = $1 WHERE "id" = $2', [
        `https://cdn.exemplo.com/fotos/${name('url').toUpperCase()}?v=2`,
        withUrl.id,
      ]);
      await sql('UPDATE "addons" SET "image" = $1 WHERE "id" = $2', [`/uploads/${name('adicional')}`, addon.id]);
      await sql('UPDATE "users" SET "avatar" = $1 WHERE "id" = $2', [`/uploads/${name('avatar', 'webp')}`, client.user.id]);
      await sql('UPDATE "stores" SET "logo" = $1 WHERE "id" = $2', [name('logo', 'webp'), store.id]);

      // 1. Verificar: só relatório
      const check = await runCleanup(request, superadmin.token, { mode: 'check' });
      expect(check.started).toMatchObject({
        kind: 'cleanup_uploads',
        status: 'RUNNING',
        finished_at: null,
        error: null,
        started_by: { id: superadmin.user.id },
        summary: { mode: 'check', deleted: 0 },
      });
      expect(check.finished, JSON.stringify(check.finished)).toMatchObject({ status: 'SUCCEEDED', error: null });
      const report = check.finished.summary!;
      expect(report).toMatchObject({ mode: 'check', min_age_hours: 24, deleted: 0, deleted_bytes: 0, failed: 0 });
      expect(report.orphans).toBeGreaterThanOrEqual(orphans.length);
      expect(report.orphan_bytes).toBeGreaterThanOrEqual(orphanBytes);
      expect(report.in_use).toBeGreaterThanOrEqual(6);
      expect(report.recent).toBeGreaterThanOrEqual(1);
      expect(report.skipped).toBeGreaterThanOrEqual(3); // oculto, .txt e a pasta
      for (const { file } of [...orphans, ...Object.values(kept)]) expect(existsSync(file), file).toBe(true);

      // 2. Apagar (com confirmação)
      const removal = await runCleanup(request, superadmin.token, { mode: 'delete', confirm: true });
      expect(removal.started.summary).toMatchObject({ mode: 'delete' });
      expect(removal.finished, JSON.stringify(removal.finished)).toMatchObject({ status: 'SUCCEEDED', error: null });
      const summary = removal.finished.summary!;
      expect(summary).toMatchObject({ mode: 'delete', failed: 0 });
      expect(summary.deleted).toBeGreaterThanOrEqual(orphans.length);
      expect(summary.deleted_bytes).toBeGreaterThanOrEqual(orphanBytes);
      expect(summary.deleted).toBe(summary.orphans);

      for (const { file } of orphans) {
        expect(existsSync(file), `${file} apagado`).toBe(false);
        expect((await request.get(`/uploads/${nodePath.basename(file)}`)).status()).toBe(404);
      }
      for (const { file } of [...Object.values(kept), nested, outside]) expect(existsSync(file), `${file} mantido`).toBe(true);
      expect((await request.get(`/uploads/${name('produto')}`)).status()).toBe(200);

      // Nova verificação: nada mais a apagar entre os arquivos deste teste
      const after = await runCleanup(request, superadmin.token, { mode: 'check' });
      expect(after.finished.summary).toMatchObject({ orphans: 0, orphan_bytes: 0 });

      // Auditoria: início (com o modo) e fim (contagens), sem nomes de arquivo
      const audit = await request.get(
        `/platform/audit?target_type=maintenance_job&target_id=${removal.started.id}&pageSize=10`,
        { headers: bearer(superadmin.token) },
      );
      expect(audit.status(), await audit.text()).toBe(200);
      const entries = (await audit.json()).items as Array<{ action: string; result: string; metadata: Record<string, unknown> }>;
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'platform.maintenance.cleanup_uploads',
            result: 'SUCCESS',
            metadata: expect.objectContaining({ job_id: removal.started.id, mode: 'delete' }),
          }),
          expect.objectContaining({
            action: 'platform.maintenance.cleanup_uploads.finish',
            result: 'SUCCESS',
            metadata: expect.objectContaining({ job_id: removal.started.id, deleted: summary.deleted }),
          }),
        ]),
      );
      expect(JSON.stringify(entries)).not.toContain(tag);
    } finally {
      await sql('UPDATE "stores" SET "logo" = $1 WHERE "id" = $2', [originalLogo, store.id]);
      await sql('UPDATE "users" SET "avatar" = NULL WHERE "id" = $1', [client.user.id]);
      await retireProduct(request, product.id);
      await retireProduct(request, withUrl.id);
      await request.delete(`/addons/${addon.id}`, { headers: bearer(admin.token) });
      for (const { file } of [...Object.values(kept), nested, ...orphans]) rmSync(file, { force: true });
      rmSync(nodePath.join(dir, name('pasta', 'd')), { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('uma limpeza por vez: 409 traz a execução em andamento (de outra instância)', async ({ request }) => {
    const superadmin = await sessionOf(request, 'superadmin');
    const [{ id }] = await sql<{ id: number }>(
      `INSERT INTO "maintenance_jobs" ("kind", "status", "started_by_user_id", "started_at", "heartbeat_at", "summary")
       VALUES ('cleanup_uploads', 'RUNNING', $1, now() - interval '1 minute', now(), $2) RETURNING "id"`,
      [superadmin.user.id, JSON.stringify({ mode: 'check', files_scanned: 7 })],
    );
    try {
      for (const data of [{ mode: 'check' }, { mode: 'delete', confirm: true }]) {
        const conflict = await expectError(
          await request.post(CLEANUP_PATH, { headers: bearer(superadmin.token), data }),
          409,
          /limpeza de arquivos em andamento/,
        );
        expect(conflict.job).toMatchObject({
          id,
          kind: 'cleanup_uploads',
          status: 'RUNNING',
          summary: { mode: 'check', files_scanned: 7, deleted: 0 },
          started_by: { id: superadmin.user.id },
        });
      }
      expect(await latestCleanup(request, superadmin.token)).toMatchObject({ id, status: 'RUNNING' });
      const [{ running }] = await sql<{ running: number }>(
        `SELECT COUNT(*)::int AS "running" FROM "maintenance_jobs" WHERE "status" = 'RUNNING' AND "kind" = 'cleanup_uploads'`,
      );
      expect(running).toBe(1);
    } finally {
      await releaseCleanupJobs();
    }
  });
});

// -------------------------------------------------------------------------------------------------
// Credenciais Mercado Pago no formato antigo (v1, sem vínculo com a loja)
// -------------------------------------------------------------------------------------------------

/** Chave da API de teste: CREDENTIALS_ENCRYPTION_KEY (se definida aqui) ou a chave fixa de desenvolvimento. */
function credentialsKey(): Buffer {
  const raw = process.env.E2E_CREDENTIALS_ENCRYPTION_KEY ?? process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (raw?.trim()) {
    const value = raw.trim();
    return /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  }
  return createHash('sha256').update(`${BRAND.slug}-dev-credentials-key`).digest();
}

/** Valor no formato antigo (v1, sem contexto), como era gravado antes do vínculo com a loja. */
function legacyCiphertext(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', credentialsKey(), iv, { authTagLength: 16 });
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/** Decifra um valor v2 com o contexto da loja (AAD "store:<id>"). */
function decryptForStore(payload: string, storeId: number): string {
  const [, iv, tag, data] = payload.split(':');
  const decipher = createDecipheriv('aes-256-gcm', credentialsKey(), Buffer.from(iv, 'base64'), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(`store:${storeId}`, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

const mask = (value: string) => `${value.slice(0, 10)}…${value.slice(-4)}`;

test.describe('Manutenção: credenciais Mercado Pago regravadas no formato atual', () => {
  let storeA: TenantStore;
  let storeB: TenantStore;

  test.beforeAll(async ({ request }) => {
    const superadmin = await sessionOf(request, 'superadmin');
    storeA = await createStore(request, superadmin, 'Credenciais A');
    storeB = await createStore(request, superadmin, 'Credenciais B');
  });

  test('regrava v1 como v2 preso à loja, sem expor o token; ilegível fica como está; idempotente e auditado', async ({ request }) => {
    const superadmin = await sessionOf(request, 'superadmin');
    const token = `TEST-${Date.now()}${randomBytes(4).toString('hex')}-101112-e2e${randomBytes(8).toString('hex')}-123456`;
    const legacy = legacyCiphertext(token);
    const corrupted = 'v1:AAAA:BBBB:CCCC';
    const tokenOf = async (storeId: number) =>
      (await sql<{ token: string | null }>('SELECT "mp_access_token_encrypted" AS "token" FROM "stores" WHERE "id" = $1', [storeId]))[0]
        .token;
    const hintOf = async (store: TenantStore) => {
      const res = await request.get('/store/settings', { headers: bearer(store.owner.token) });
      expect(res.status(), await res.text()).toBe(200);
      return (await res.json()).payments?.access_token_hint ?? null;
    };

    await sql('UPDATE "stores" SET "mp_public_key" = $1, "mp_access_token_encrypted" = $2 WHERE "id" = $3', [
      `TEST-pk-${uid('e2e')}`,
      legacy,
      storeA.id,
    ]);
    await sql('UPDATE "stores" SET "mp_public_key" = $1, "mp_access_token_encrypted" = $2 WHERE "id" = $3', [
      `TEST-pk-${uid('e2e')}`,
      corrupted,
      storeB.id,
    ]);
    try {
      // A API lê o v1 (mesma chave); se a API de teste usar outra chave, não há como montar o valor antigo aqui
      const before = await hintOf(storeA);
      test.skip(before === null, 'A API de teste usa outra CREDENTIALS_ENCRYPTION_KEY (defina E2E_CREDENTIALS_ENCRYPTION_KEY).');
      expect(before).toBe(mask(token));

      const legacyCount = async () =>
        (await sql<{ total: number }>(`SELECT COUNT(*)::int AS "total" FROM "stores" WHERE "mp_access_token_encrypted" LIKE 'v1:%'`))[0].total;
      const statusRes = await request.get(STATUS_PATH, { headers: bearer(superadmin.token) });
      expect(statusRes.status(), await statusRes.text()).toBe(200);
      const status = await statusRes.json();
      expect(Object.keys(status).sort()).toEqual(['current', 'legacy', 'total', 'unknown']);
      expect(status.legacy).toBe(await legacyCount());
      expect(status.legacy).toBeGreaterThanOrEqual(2);

      // 1ª regravação
      const res = await request.post(REENCRYPT_PATH, { headers: bearer(superadmin.token) });
      expect(res.status(), await res.text()).toBe(200);
      const text = await res.text();
      const result = JSON.parse(text);
      expect(Object.keys(result).sort()).toEqual(['already_current', 'changed', 'failed', 'failed_store_ids', 'migrated', 'total']);
      expect(result.migrated).toBeGreaterThanOrEqual(1);
      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect(result.failed_store_ids).toContain(storeB.id);
      expect(result.failed_store_ids).not.toContain(storeA.id);

      const upgraded = (await tokenOf(storeA.id))!;
      expect(upgraded.startsWith('v2:'), 'gravado no formato v2').toBe(true);
      expect(upgraded).not.toBe(legacy);
      expect(decryptForStore(upgraded, storeA.id)).toBe(token);
      expect(() => decryptForStore(upgraded, storeB.id), 'preso à loja A').toThrow();
      expect(await tokenOf(storeB.id)).toBe(corrupted);
      expect(await hintOf(storeA)).toBe(mask(token)); // a API continua lendo (agora o v2)
      for (const secret of [token, legacy, upgraded]) expect(text).not.toContain(secret);

      // 2ª regravação: nada muda (idempotente)
      const again = await request.post(REENCRYPT_PATH, { headers: bearer(superadmin.token) });
      expect(again.status(), await again.text()).toBe(200);
      expect(await again.json()).toMatchObject({ migrated: 0, changed: 0 });
      expect(await tokenOf(storeA.id)).toBe(upgraded);
      const statusAfter = await (await request.get(STATUS_PATH, { headers: bearer(superadmin.token) })).json();
      expect(statusAfter.legacy).toBe(await legacyCount());

      // Auditoria: só contagens (nem token, nem valores cifrados, nem ids de loja)
      const audit = await request.get('/platform/audit?action=platform.maintenance.reencrypt_credentials&pageSize=2', {
        headers: bearer(superadmin.token),
      });
      expect(audit.status(), await audit.text()).toBe(200);
      const entries = (await audit.json()).items as Array<{ result: string; metadata: Record<string, unknown> }>;
      expect(entries).toHaveLength(2);
      for (const entry of entries) {
        expect(entry.result).toBe('SUCCESS');
        expect(Object.keys(entry.metadata).sort()).toEqual(['already_current', 'changed', 'failed', 'migrated', 'total']);
      }
      const auditText = JSON.stringify(entries);
      for (const secret of [token, legacy, upgraded, corrupted]) expect(auditText).not.toContain(secret);
    } finally {
      await sql('UPDATE "stores" SET "mp_public_key" = NULL, "mp_access_token_encrypted" = NULL WHERE "id" = ANY($1::int[])', [
        [storeA.id, storeB.id],
      ]);
    }
  });
});
