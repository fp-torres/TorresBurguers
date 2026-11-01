import { expect, test, type APIRequestContext } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';
import { E2E } from '../../../support/env';
import { makePng, pngFile } from '../identity/helpers';
import {
  ALL_FEATURES,
  bearer,
  Cleanup,
  createPlan,
  createStore,
  defaultSession,
  expectError,
  expectStatus,
  newApi,
  sql,
  storeOverview,
  subscriptionDetail,
  uid,
  type BillingStore,
  type Json,
  type Plan,
  type Session,
} from './helpers';

/**
 * Armazenamento por plano (plans.max_storage_mb) e limpeza agendada dos arquivos sem uso:
 * - o uso de cada loja é a soma dos arquivos s<storeId>- da pasta de uploads (fotos de perfil não contam);
 * - a cota é conferida ANTES de gravar qualquer imagem da loja (POST /uploads, produto, adicional e logo):
 *   acima dela → 403 com a mensagem do plano, e nada fica na pasta;
 * - uso × limite em GET /store/subscription, /platform/subscriptions/:id e /platform/stores/:id (campo storage,
 *   sem mudar usage/limits) e no downgrade (409 com a violação storage_mb);
 * - limpeza agendada (UPLOADS_CLEANUP_INTERVAL_HOURS): só roda com a variável ligada na API de teste (ex.: 0.005 =
 *   18 s); sem ela o teste é pulado.
 * O uso medido fica em cache por loja (alguns minutos): os arquivos "plantados" na pasta são gravados ANTES da primeira
 * consulta de cada loja nova.
 */

const MB = 1024 * 1024;
const FREE_BYTES = 64 * 1024;
const STORAGE_LIMIT_INPUT_MESSAGE =
  'O limite de armazenamento (MB) deve ser um número inteiro a partir de 1 (ou null para ilimitado).';

const cleanup = new Cleanup();
const planted: string[] = [];
let superadmin: Session;
let plan: Plan;

test.beforeAll(async () => {
  const api = await newApi();
  superadmin = await defaultSession(api, 'superadmin');
  plan = await createPlan(api, superadmin, cleanup, {
    name: `Armazenamento E2E ${uid('st')}`.slice(0, 80),
    max_storage_mb: 1,
    features: ALL_FEATURES,
  });
  await api.dispose();
});

test.afterAll(async () => {
  for (const file of planted) rmSync(file, { force: true });
  await cleanup.run();
});

/** Mensagem do 403 da cota (o uso e o tamanho da imagem variam). */
function quotaMessage(planName: string, incoming: boolean): RegExp {
  const name = planName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^Limite de armazenamento do plano ${name} atingido: [\\d,]+ de [\\d,]+ MB em uso` +
      (incoming ? '; a imagem otimizada tem [\\d,]+ (KB|MB)' : '') +
      '\\. Fale com a administração da plataforma para mudar de plano ou liberar espaço\\.$',
  );
}

/** Grava um arquivo da loja direto na pasta de uploads (o "lastro" que ocupa a cota). */
function plant(storeId: number, label: string, bytes: number, ageHours = 0): string {
  mkdirSync(E2E.uploadsDir, { recursive: true });
  const file = nodePath.join(E2E.uploadsDir, `s${storeId}-e2e-${label}-${uid('arq').toLowerCase()}.webp`);
  writeFileSync(file, Buffer.alloc(bytes, 7));
  if (ageHours > 0) {
    const time = new Date(Date.now() - ageHours * 60 * 60 * 1000);
    utimesSync(file, time, time);
  }
  planted.push(file);
  return file;
}

/** Arquivos da loja na pasta de uploads. */
function storeFiles(storeId: number): string[] {
  mkdirSync(E2E.uploadsDir, { recursive: true });
  return readdirSync(E2E.uploadsDir).filter((name) => name.startsWith(`s${storeId}-`)).sort();
}

/**
 * Loja nova para o teste. Com o banco recriado e a mesma pasta de uploads, o id pode repetir o de uma loja de uma
 * execução anterior: os arquivos s<id>- que já estiverem na pasta são sobras dela (a loja acabou de nascer) e saem.
 */
async function freshStore(api: APIRequestContext, planId: number, label: string): Promise<BillingStore> {
  const store = await createStore(api, superadmin, cleanup, planId, label);
  for (const name of storeFiles(store.id)) rmSync(nodePath.join(E2E.uploadsDir, name), { force: true });
  return store;
}

const tinyImage = () => pngFile(makePng(16, 16), 'pequena.png');
/** Ruído não comprime: a versão WebP (até 800 px) passa com folga dos 64 KB livres. */
const bigImage = () => pngFile(makePng(800, 800, { noise: true }), 'grande.png');

async function upload(api: APIRequestContext, store: BillingStore, file = tinyImage()) {
  return api.post('/uploads', { headers: bearer(store.owner.token), multipart: { file } });
}

test.describe('Plano: limite de armazenamento (max_storage_mb)', () => {
  test('superpainel cria e edita o limite (null = ilimitado), com a validação dos outros limites', async ({ request }) => {
    const headers = bearer(superadmin.token);
    for (const invalid of [0, -1, 1.5, 'muito']) {
      await expectError(
        await request.post('/platform/plans', {
          headers,
          data: { code: uid('st-inv').toLowerCase().slice(0, 40), name: 'Inválido', price: 0, max_storage_mb: invalid },
        }),
        400,
        STORAGE_LIMIT_INPUT_MESSAGE,
        `max_storage_mb = ${String(invalid)}`,
      );
    }

    const created = await createPlan(request, superadmin, cleanup, { max_storage_mb: '250' });
    expect(created.max_storage_mb, 'texto numérico vira número').toBe(250);
    const unlimited = await createPlan(request, superadmin, cleanup);
    expect(unlimited.max_storage_mb, 'padrão: ilimitado').toBeNull();

    const patched = await expectStatus(
      await request.patch(`/platform/plans/${created.id}`, { headers, data: { max_storage_mb: null } }),
      200,
      'PATCH max_storage_mb null',
    );
    expect(patched.max_storage_mb).toBeNull();
    const detail = await expectStatus(await request.get(`/platform/plans/${created.id}`, { headers }), 200);
    expect(detail.max_storage_mb).toBeNull();

    const audit = await expectStatus(
      await request.get(`/platform/audit?action=plan.update&target_type=plan&target_id=${created.id}&pageSize=10`, { headers }),
      200,
    );
    expect((audit.items as Json[])[0]?.metadata?.fields).toEqual(['max_storage_mb']);
  });
});

test.describe('Cota de armazenamento: conferida antes de gravar as imagens da loja', () => {
  test('acima da cota: POST /uploads, produto, adicional e logo recusados (403) sem gravar; foto de perfil não conta', async ({ request }) => {
    const store = await freshStore(request, plan.id, 'Cota de armazenamento');
    const owner = bearer(store.owner.token);
    // Antes da primeira consulta da loja: o uso medido já inclui o lastro
    const ballast = plant(store.id, 'lastro', MB - FREE_BYTES);

    const before = await storeOverview(request, store.owner);
    expect(before.storage).toEqual({
      used_bytes: MB - FREE_BYTES,
      used_mb: 0.94,
      files: 1,
      limit_mb: 1,
      measured_at: expect.any(String),
    });
    expect(Object.keys(before.usage).sort(), 'usage continua igual').toEqual(['monthly_orders', 'products', 'staff_users']);

    // Cabe: grava e o uso já soma o arquivo
    const small = await expectStatus(await upload(request, store), 201, 'imagem pequena');
    expect(small.filename).toMatch(new RegExp(`^s${store.id}-compressed-\\d+-[0-9a-f]{8}\\.webp$`));
    const smallSize = statSync(nodePath.join(E2E.uploadsDir, small.filename)).size;
    expect((await storeOverview(request, store.owner)).storage).toMatchObject({
      used_bytes: MB - FREE_BYTES + smallSize,
      files: 2,
    });

    // Não cabe: recusada antes de gravar, em todas as rotas de imagem da loja
    const files = storeFiles(store.id);
    const message = quotaMessage(plan.name, true);
    await expectError(await upload(request, store, bigImage()), 403, message, 'POST /uploads');
    await expectError(
      await request.post('/products', {
        headers: owner,
        multipart: { name: `Lanche cota ${uid('p')}`.slice(0, 60), price: '20', category: 'hamburgueres', file: bigImage() },
      }),
      403,
      message,
      'POST /products com imagem',
    );
    await expectError(
      await request.post('/addons', { headers: owner, multipart: { name: `Adicional cota ${uid('a')}`.slice(0, 60), price: '2', file: bigImage() } }),
      403,
      message,
      'POST /addons com imagem',
    );
    await expectError(await request.post('/store/logo', { headers: owner, multipart: { file: bigImage() } }), 403, message, 'POST /store/logo');
    expect(storeFiles(store.id), 'nada novo na pasta').toEqual(files);
    expect((await storeOverview(request, store.owner)).storage.used_bytes, 'uso não muda').toBe(MB - FREE_BYTES + smallSize);
    const products = await expectStatus(await request.get(`/stores/${store.slug}/products`), 200);
    expect(products, 'o produto recusado não foi criado').toEqual([]);

    // Sem imagem, o cadastro segue normalmente
    await expectStatus(
      await request.post('/products', { headers: owner, data: { name: 'Sem imagem', price: 10, category: 'hamburgueres' } }),
      201,
      'produto sem imagem',
    );

    // Foto de perfil (u<id>-): não conta para a loja e não é barrada pela cota
    const profile = await expectStatus(
      await request.patch(`/users/${store.owner.user.id}`, { headers: owner, multipart: { file: bigImage() } }),
      200,
      'foto de perfil',
    );
    expect(String(profile.avatar)).toMatch(new RegExp(`u${store.owner.user.id}-`));
    expect((await storeOverview(request, store.owner)).storage.used_bytes, 'a foto de perfil não conta').toBe(MB - FREE_BYTES + smallSize);

    // Limite maior vale na hora (o plano é lido a cada envio)
    await expectStatus(
      await request.patch(`/platform/plans/${plan.id}`, { headers: bearer(superadmin.token), data: { max_storage_mb: 3 } }),
      200,
    );
    try {
      await expectStatus(await upload(request, store, bigImage()), 201, 'cabe no limite novo');
    } finally {
      await request.patch(`/platform/plans/${plan.id}`, { headers: bearer(superadmin.token), data: { max_storage_mb: 1 } });
    }
    expect(existsSync(ballast)).toBe(true);
  });

  test('loja já acima da cota: até a menor imagem é recusada (antes da conversão)', async ({ request }) => {
    const store = await freshStore(request, plan.id, 'Acima da cota');
    plant(store.id, 'lastro', MB + 10);
    const files = storeFiles(store.id);
    await expectError(await upload(request, store), 403, quotaMessage(plan.name, false), 'imagem minúscula');
    expect(storeFiles(store.id)).toEqual(files);
  });
});

test.describe('Uso × limite nas respostas e no downgrade', () => {
  test('storage em GET /store/subscription, /platform/subscriptions/:id e /platform/stores/:id; downgrade que não cabe → 409', async ({ request }) => {
    const roomy = await createPlan(request, superadmin, cleanup, { name: `Folgado E2E ${uid('pf')}`.slice(0, 80), max_storage_mb: 5 });
    const tight = await createPlan(request, superadmin, cleanup, { name: `Apertado E2E ${uid('pa')}`.slice(0, 80), max_storage_mb: 1 });
    const store = await freshStore(request, roomy.id, 'Uso de armazenamento');
    plant(store.id, 'lastro', Math.round(1.5 * MB));
    const headers = bearer(superadmin.token);

    const expected = { used_bytes: Math.round(1.5 * MB), used_mb: 1.5, files: 1, limit_mb: 5 };
    expect((await storeOverview(request, store.owner)).storage).toMatchObject(expected);
    const detail = await subscriptionDetail(request, superadmin, store.subscriptionId);
    expect(detail.storage).toMatchObject(expected);
    expect(detail.plan.max_storage_mb).toBe(5);
    const platformStore = await expectStatus(await request.get(`/platform/stores/${store.id}`, { headers }), 200);
    expect(platformStore.storage).toMatchObject(expected);
    expect(Object.keys(platformStore.limits).sort()).toEqual(['monthly_orders', 'products', 'staff_users']);

    const refused = await expectError(
      await request.post(`/platform/subscriptions/${store.subscriptionId}/change-plan`, { headers, data: { plan_id: tight.id } }),
      409,
      `O uso atual da loja não cabe no plano ${tight.name}: MB de armazenamento: 1,5 em uso (limite 1). Reduza o uso antes de mudar de plano.`,
      'downgrade pelo armazenamento',
    );
    expect(refused.violations).toEqual([{ key: 'storage_mb', label: 'MB de armazenamento', limit: 1, usage: 1.5 }]);
    expect((await subscriptionDetail(request, superadmin, store.subscriptionId)).plan_id, 'o plano não mudou').toBe(roomy.id);
  });
});

// -------------------------------------------------------------------------------------------------
// Limpeza agendada (UPLOADS_CLEANUP_INTERVAL_HOURS)
// -------------------------------------------------------------------------------------------------

const CLEANUP_PATH = '/platform/maintenance/cleanup-uploads';

async function cleanupSchedule(api: APIRequestContext): Promise<Json> {
  const payload = await expectStatus(
    await api.get(`${CLEANUP_PATH}?include=schedule`, { headers: bearer(superadmin.token) }),
    200,
    'GET cleanup-uploads?include=schedule',
  );
  expect(Object.keys(payload).sort()).toEqual(['job', 'schedule']);
  return payload.schedule;
}

test.describe('Limpeza agendada dos arquivos sem uso', () => {
  test('situação no superpainel: só com ?include=schedule (o formato padrão continua { job })', async ({ request }) => {
    const plain = await expectStatus(await request.get(CLEANUP_PATH, { headers: bearer(superadmin.token) }), 200);
    expect(Object.keys(plain)).toEqual(['job']);
    const schedule = await cleanupSchedule(request);
    expect(schedule).toMatchObject({ mode: 'delete', min_age_hours: 24 });
    if (schedule.enabled) {
      expect(schedule.interval_hours).toBeGreaterThan(0);
      expect(schedule.next_run_at).toEqual(expect.any(String));
    } else {
      expect(schedule).toMatchObject({ interval_hours: null, next_run_at: null });
    }
    // Mesmas regras de acesso da rota (somente superadmin)
    const admin = await defaultSession(request, 'admin');
    expect((await request.get(`${CLEANUP_PATH}?include=schedule`, { headers: bearer(admin.token) })).status()).toBe(403);
  });

  test('roda sozinha no intervalo: apaga só o que está sem uso há mais de 24 h, auditada como sistema, e o uso da loja cai', async ({ request }) => {
    const initial = await cleanupSchedule(request);
    test.skip(!initial.enabled, 'Limpeza agendada desligada nesta API (suba com UPLOADS_CLEANUP_INTERVAL_HOURS=0.005 para testar).');
    const intervalMs = Number(initial.interval_hours) * 60 * 60 * 1000;
    test.setTimeout(Math.max(120_000, intervalMs * 3 + 60_000));

    const unlimited = await createPlan(request, superadmin, cleanup, { name: `Agendada E2E ${uid('pg')}`.slice(0, 80) });
    const store = await freshStore(request, unlimited.id, 'Limpeza agendada');
    const owner = bearer(store.owner.token);
    // Em uso e antigo (produto com a imagem): fica
    const uploaded = await expectStatus(await upload(request, store), 201, 'imagem do produto');
    await expectStatus(
      await request.post('/products', { headers: owner, data: { name: 'Com imagem antiga', price: 10, category: 'hamburgueres', image: uploaded.filename } }),
      201,
    );
    const inUse = nodePath.join(E2E.uploadsDir, uploaded.filename);
    const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
    utimesSync(inUse, old, old);
    const plantedAt = new Date();
    const orphan = plant(store.id, 'agendada-velho', 4096, 72);
    const recent = plant(store.id, 'agendada-novo', 2048);

    const before = (await storeOverview(request, store.owner)).storage;
    expect(before.files).toBe(3);

    // Ninguém pede a limpeza: a próxima automática apaga o arquivo sem uso
    const timeout = intervalMs * 3 + 30_000;
    await expect.poll(() => existsSync(orphan), { timeout, intervals: [1_000] }).toBe(false);
    // A execução automática que apagou (concluída; uma conferência pode ter começado logo antes do plantio)
    let jobId: number | null = null;
    await expect
      .poll(
        async () => {
          const [row] = await sql<{ id: number }>(
            `SELECT "id" FROM "maintenance_jobs"
             WHERE "kind" = 'cleanup_uploads' AND "started_by_user_id" IS NULL AND "status" = 'SUCCEEDED'
               AND "started_at" >= $1 AND ("summary"->>'deleted')::int >= 1
             ORDER BY "id" DESC LIMIT 1`,
            [new Date(plantedAt.getTime() - 60_000)],
          );
          jobId = row?.id ?? null;
          return jobId;
        },
        { timeout: 30_000 },
      )
      .not.toBeNull();
    expect(existsSync(recent), 'sem uso, mas recente: fica').toBe(true);
    expect(existsSync(inUse), 'em uso: fica').toBe(true);

    // O superpainel mostra a última automática (sem ator, trigger schedule)
    const schedule = await cleanupSchedule(request);
    expect(schedule.last_run).toMatchObject({
      kind: 'cleanup_uploads',
      started_by: null,
      summary: { mode: 'delete', trigger: 'schedule' },
    });
    expect(schedule.last_run.id).toBeGreaterThanOrEqual(jobId!);
    const run = { id: jobId! };

    // O uso da loja é medido de novo depois da exclusão
    const after = (await storeOverview(request, store.owner)).storage;
    expect(after).toMatchObject({ files: 2, used_bytes: before.used_bytes - 4096 });

    // Auditoria como sistema (sem ator), só com contagens
    const audit = await expectStatus(
      await request.get(`/platform/audit?target_type=maintenance_job&target_id=${run.id}&pageSize=10`, { headers: bearer(superadmin.token) }),
      200,
    );
    const entries = audit.items as Json[];
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'platform.maintenance.cleanup_uploads',
          actor_scope: 'SYSTEM',
          actor: null,
          result: 'SUCCESS',
          metadata: expect.objectContaining({ job_id: run.id, mode: 'delete', trigger: 'schedule' }),
        }),
        expect.objectContaining({
          action: 'platform.maintenance.cleanup_uploads.finish',
          actor_scope: 'SYSTEM',
          actor: null,
          result: 'SUCCESS',
          metadata: expect.objectContaining({ job_id: run.id, trigger: 'schedule' }),
        }),
      ]),
    );
    expect(JSON.stringify(entries)).not.toContain(nodePath.basename(orphan));
  });
});
