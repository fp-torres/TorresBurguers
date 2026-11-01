import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  GIF_1X1,
  JPEG_8X8,
  MAX_UPLOAD_BYTES,
  SVG_IMAGE,
  bearer,
  body,
  demoStore,
  expectError,
  isWebp,
  makePng,
  pngFile,
  sessionOf,
} from './helpers';

const NON_ADMIN = ['client', 'employee', 'kitchen', 'courier'] as const;

async function adminUpload(request: APIRequestContext, file: { name: string; mimeType: string; buffer: Buffer }) {
  const admin = await sessionOf(request, 'admin');
  return request.post('/uploads', { headers: bearer(admin.token), multipart: { file } });
}

test.describe('Upload de imagens (POST /uploads) — somente ADMIN', () => {
  test('anônimo → 401', async ({ request }) => {
    await expectError(await request.post('/uploads', { multipart: { file: pngFile() } }), 401);
  });

  for (const key of NON_ADMIN) {
    test(`perfil ${key} → 403`, async ({ request }) => {
      const session = await sessionOf(request, key);
      await expectError(
        await request.post('/uploads', { headers: bearer(session.token), multipart: { file: pngFile() } }),
        403,
      );
    });
  }

  test('PNG válido → {filename} .webp com o prefixo da loja (s<id>-), servido em /uploads/<arquivo> como imagem', async ({ request }) => {
    const store = await demoStore();
    const res = await adminUpload(request, pngFile(makePng(64, 48)));
    expect(res.status(), await res.text()).toBe(201);
    const payload = await res.json();
    expect(Object.keys(payload)).toEqual(['filename']);
    expect(payload.filename, 'arquivo da loja: prefixo s<storeId>- e sem pasta').toMatch(new RegExp(`^s${store.id}-[\\w.-]+\\.webp$`));

    const image = await request.get(`/uploads/${payload.filename}`);
    expect(image.status()).toBe(200);
    expect(image.headers()['content-type']).toContain('image/webp');
    expect(isWebp(await image.body())).toBeTruthy();
  });

  test('JPEG válido → 201 e arquivo servido', async ({ request }) => {
    const res = await adminUpload(request, { name: 'foto.jpg', mimeType: 'image/jpeg', buffer: JPEG_8X8 });
    expect(res.status(), await res.text()).toBe(201);
    const { filename } = await res.json();
    expect((await request.get(`/uploads/${filename}`)).status()).toBe(200);
  });

  test('WebP válido → 201', async ({ request }) => {
    const first = await adminUpload(request, pngFile(makePng(16, 16)));
    expect(first.status(), await first.text()).toBe(201);
    const webp = await (await request.get(`/uploads/${(await first.json()).filename}`)).body();
    expect(isWebp(webp)).toBeTruthy();

    const res = await adminUpload(request, { name: 'imagem.webp', mimeType: 'image/webp', buffer: webp });
    expect(res.status(), await res.text()).toBe(201);
  });

  test('imagem real logo abaixo de 5 MB é aceita', async ({ request }) => {
    const nearLimit = makePng(1200, 1300, { noise: true });
    expect(nearLimit.length).toBeLessThan(MAX_UPLOAD_BYTES);
    expect(nearLimit.length).toBeGreaterThan(4 * 1024 * 1024);
    const res = await adminUpload(request, pngFile(nearLimit, 'quase-5mb.png'));
    expect(res.status(), (await res.text()).slice(0, 300)).toBe(201);
  });

  test('imagem acima de 5 MB → 400 (ou 413)', async ({ request }) => {
    const big = makePng(1500, 1200, { noise: true });
    expect(big.length).toBeGreaterThan(MAX_UPLOAD_BYTES);
    const res = await adminUpload(request, pngFile(big, 'grande.png'));
    const payload = await body(res);
    expect([400, 413], JSON.stringify(payload).slice(0, 300)).toContain(res.status());
    expect(payload).toMatchObject({ statusCode: res.status() });
  });

  const rejected: Array<[string, { name: string; mimeType: string; buffer: Buffer }]> = [
    ['arquivo de texto com nome .png', { name: 'falso.png', mimeType: 'image/png', buffer: Buffer.from('não sou uma imagem') }],
    ['GIF', { name: 'anim.gif', mimeType: 'image/gif', buffer: GIF_1X1 }],
    ['SVG com script', { name: 'vetor.svg', mimeType: 'image/svg+xml', buffer: SVG_IMAGE }],
    ['PNG corrompido (assinatura certa, conteúdo inválido)', { name: 'quebrado.png', mimeType: 'image/png', buffer: Buffer.concat([makePng().subarray(0, 16), Buffer.alloc(64, 7)]) }],
    ['PDF', { name: 'doc.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF') }],
    ['arquivo vazio', { name: 'vazio.png', mimeType: 'image/png', buffer: Buffer.alloc(0) }],
  ];
  for (const [label, file] of rejected) {
    test(`${label} → 400`, async ({ request }) => {
      await expectError(await adminUpload(request, file), 400);
    });
  }

  test('sem arquivo → 400', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    await expectError(await request.post('/uploads', { headers: bearer(admin.token), multipart: { nome: 'sem arquivo' } }), 400);
  });

  test('imagem em outro campo ("image" em vez de "file") → 400', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    await expectError(await request.post('/uploads', { headers: bearer(admin.token), multipart: { image: pngFile() } }), 400);
  });

  test('duas imagens no mesmo envio → 400', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(makePng())], { type: 'image/png' }), 'a.png');
    form.append('file', new Blob([new Uint8Array(makePng())], { type: 'image/png' }), 'b.png');
    await expectError(await request.post('/uploads', { headers: bearer(admin.token), multipart: form }), 400);
  });

  test('arquivos inexistentes ou fora da pasta de uploads não são servidos', async ({ request }) => {
    const missing = await request.get('/uploads/nao-existe-e2e.webp');
    expect(missing.status()).toBe(404);
    expect(await missing.text(), '404 padrão, sem expor o caminho do servidor').not.toMatch(/\.uploads|ENOENT|[A-Za-z]:\\/);
    for (const path of ['/uploads/..%2Fpackage.json', '/uploads/%2e%2e%2f%2e%2e%2fbackend%2f.env', '/uploads/..%5C..%5Cbackend%5Cpackage.json']) {
      const res = await request.get(path);
      expect([400, 403, 404], `${path}: ${res.status()}`).toContain(res.status());
      expect(await res.text()).not.toMatch(/"dependencies"|JWT_SECRET|DB_PASSWORD/);
    }
  });

  test('multipart com campos demais ou texto enorme → 400 sem guardar o corpo (vale também para o cadastro anônimo)', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    const many = new FormData();
    for (let i = 0; i < 1000; i++) many.append(`x${i}`, 'a');
    many.append('file', new Blob([new Uint8Array(makePng())], { type: 'image/png' }), 'a.png');
    const tooMany = await request.post('/uploads', { headers: bearer(admin.token), multipart: many });
    expect((await expectError(tooMany, 400)).message).toBe('Formulário inválido: campos demais ou com texto longo demais.');

    // Cadastro público (sem token): um campo de texto de 2 MB é recusado no parsing do multipart
    const huge = new FormData();
    huge.append('name', 'Corpo Enorme');
    huge.append('email', `enorme.${Date.now()}@email.com`);
    huge.append('password', 'SenhaForte@123');
    huge.append('lixo', 'A'.repeat(2 * 1024 * 1024));
    const signup = await request.post('/users', { multipart: huge });
    expect((await expectError(signup, 400)).message).toBe('Formulário inválido: campos demais ou com texto longo demais.');
  });

  test('cabeçalhos de segurança: /uploads com nosniff e CSP (sandbox); nenhuma resposta anuncia X-Powered-By', async ({ request }) => {
    const uploaded = await body(await adminUpload(request, pngFile(makePng(6, 6))));
    const file = await request.get(`/uploads/${uploaded.filename}`);
    expect(file.status()).toBe(200);
    const headers = file.headers();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['content-security-policy']).toContain("default-src 'none'");
    expect(headers['content-security-policy']).toContain('sandbox');
    expect(headers['x-powered-by']).toBeUndefined();
    for (const res of [await request.get('/health'), await request.get('/auth/me'), await request.get('/uploads/nao-existe.webp')]) {
      expect(res.headers()['x-powered-by'], res.url()).toBeUndefined();
      expect(res.headers()['x-content-type-options'], res.url()).toBe('nosniff');
      expect(res.headers()['x-frame-options'], res.url()).toBe('DENY');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Manutenção: otimização de imagens em SEGUNDO PLANO (somente superadmin; a pasta de uploads guarda
// os arquivos de TODAS as lojas). POST /platform/maintenance/optimize-images → 202 { job }; o GET da
// mesma rota acompanha ({ job | null }). Uma execução por vez entre todas as instâncias da API (trava
// no banco, tabela maintenance_jobs). A rota antiga /maintenance/optimize-images espera o fim e mantém
// o contrato { message, itemsProcessed }.
// ---------------------------------------------------------------------------------------------
import { mkdirSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';
import { E2E } from '../../../support/env';
import { createProduct, retireProduct, uid } from './helpers';

interface PgClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

/**
 * Acesso direto ao banco de TESTE (nunca o de desenvolvimento: o nome precisa terminar em _e2e), só para
 * montar o que a API não cria: imagem antiga sem prefixo de loja e execução de outra instância (em
 * andamento ou presa).
 */
async function testDb<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  expect(E2E.db.database, 'acesso direto só ao banco de teste').toMatch(/_e2e$/);
  // pg (dependência da suíte) não tem tipos instalados: só o que é usado aqui
  const { Client } = require('pg') as { Client: new (config: typeof E2E.db) => PgClient };
  const client = new Client(E2E.db);
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

type MaintenanceJob = {
  id: number;
  kind: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  started_at: string;
  heartbeat_at: string;
  finished_at: string | null;
  duration_ms: number;
  summary: { items_processed: number; products: number; addons: number; avatars: number; skipped: number } | null;
  error: string | null;
  started_by: { id: number; name: string } | null;
};

test.describe('Manutenção (otimização de imagens em segundo plano) — somente superadmin', () => {
  const JOB_PATH = '/platform/maintenance/optimize-images';
  const LEGACY_PATH = '/maintenance/optimize-images';
  const STALE_MINUTES = 11; // heartbeat parado há mais de 10 min = instância que caiu

  /** Execução gravada como se outra instância da API a estivesse processando (heartbeat há N minutos). */
  async function insertRunningJob(startedByUserId: number, heartbeatMinutesAgo: number): Promise<number> {
    const [row] = await testDb<{ id: number }>(
      `INSERT INTO "maintenance_jobs" ("kind", "status", "started_by_user_id", "started_at", "heartbeat_at", "summary")
       VALUES ('optimize_images', 'RUNNING', $1, now() - make_interval(mins => $2::int + 5), now() - make_interval(mins => $2::int), $3)
       RETURNING "id"`,
      [startedByUserId, heartbeatMinutesAgo, JSON.stringify({ items_processed: 4, products: 4, addons: 0, avatars: 0, skipped: 1 })],
    );
    return row.id;
  }

  /** Libera a trava se o teste parou no meio (a execução inserida nunca é processada por ninguém). */
  async function releaseJob(id: number): Promise<void> {
    await testDb(
      `UPDATE "maintenance_jobs" SET "status" = 'FAILED', "finished_at" = now(), "error" = 'Encerrada pelo teste E2E.'
       WHERE "id" = $1 AND "status" = 'RUNNING'`,
      [id],
    );
  }

  async function latestJob(request: APIRequestContext, token: string): Promise<MaintenanceJob | null> {
    const res = await request.get(JOB_PATH, { headers: bearer(token) });
    expect(res.status(), await res.text()).toBe(200);
    const payload = await res.json();
    expect(Object.keys(payload)).toEqual(['job']);
    return payload.job;
  }

  /** Acompanha pelo GET (como o superpainel) até a execução terminar. */
  async function waitUntilFinished(request: APIRequestContext, token: string, id: number): Promise<MaintenanceJob> {
    let latest: MaintenanceJob | null = null;
    await expect
      .poll(
        async () => {
          latest = await latestJob(request, token);
          return latest?.id === id ? latest.status : `última execução não é a #${id}: ${JSON.stringify(latest)}`;
        },
        { message: `execução #${id} terminar`, timeout: 60_000, intervals: [200, 500, 1_000] },
      )
      .toMatch(/^(SUCCEEDED|FAILED)$/);
    return latest as unknown as MaintenanceJob;
  }

  test.beforeAll(async () => {
    // Uma rodada anterior interrompida no meio destes testes pode ter deixado uma execução inserida em RUNNING
    // (o banco de teste pode ser reaproveitado). Execuções reais no banco de teste duram milissegundos.
    // Só a otimização: a limpeza de arquivos (maintenance.spec.ts) tem a própria trava.
    await testDb(
      `UPDATE "maintenance_jobs" SET "status" = 'FAILED', "finished_at" = now(), "error" = 'Encerrada pelo teste E2E.'
       WHERE "status" = 'RUNNING' AND "kind" = 'optimize_images'`,
    );
  });

  test('anônimo → 401 (iniciar, acompanhar e rota antiga)', async ({ request }) => {
    await expectError(await request.post(JOB_PATH), 401);
    await expectError(await request.get(JOB_PATH), 401);
    await expectError(await request.post(LEGACY_PATH), 401);
  });

  for (const key of ['admin', ...NON_ADMIN] as const) {
    test(`perfil ${key} (equipe da loja ou cliente) → 403 em /platform/maintenance e /maintenance`, async ({ request }) => {
      const session = await sessionOf(request, key);
      await expectError(await request.post(JOB_PATH, { headers: bearer(session.token) }), 403);
      await expectError(await request.get(JOB_PATH, { headers: bearer(session.token) }), 403);
      await expectError(await request.post(LEGACY_PATH, { headers: bearer(session.token) }), 403);
    });
  }

  test('superadmin em sessão de suporte (token da loja, somente leitura) → 403', async ({ request }) => {
    const superadmin = await sessionOf(request, 'superadmin');
    const store = await demoStore();
    const opened = await request.post(`/platform/stores/${store.id}/support-sessions`, {
      headers: bearer(superadmin.token),
      data: { reason: 'Teste E2E: manutenção fora do alcance do suporte' },
    });
    expect(opened.status(), await opened.text()).toBe(201);
    const { access_token: supportToken, session } = await opened.json();
    try {
      await expectError(await request.post(JOB_PATH, { headers: bearer(supportToken) }), 403);
      await expectError(await request.get(JOB_PATH, { headers: bearer(supportToken) }), 403);
      await expectError(await request.post(LEGACY_PATH, { headers: bearer(supportToken) }), 403);
    } finally {
      await request.post(`/platform/support-sessions/${session.id}/end`, { headers: bearer(superadmin.token) });
    }
  });

  test('superadmin: 202 com a execução RUNNING, acompanhamento pelo GET até SUCCEEDED e a imagem antiga convertida', async ({ request }) => {
    const superadmin = await sessionOf(request, 'superadmin');
    const store = await demoStore();
    // Produto com imagem antiga (PNG sem o prefixo da loja): só pelo banco, a API não aceita mais esse formato
    const product = await createProduct(request);
    const legacyName = `e2e-legado-${uid('img')}.png`;
    mkdirSync(E2E.uploadsDir, { recursive: true });
    writeFileSync(nodePath.join(E2E.uploadsDir, legacyName), makePng(32, 24));
    await testDb(`UPDATE "products" SET "image" = $1 WHERE "id" = $2`, [legacyName, product.id]);

    try {
      const res = await request.post(JOB_PATH, { headers: bearer(superadmin.token) });
      expect(res.status(), await res.text()).toBe(202);
      const payload = await res.json();
      expect(Object.keys(payload)).toEqual(['job']);
      const started: MaintenanceJob = payload.job;
      expect(started).toMatchObject({
        kind: 'optimize_images',
        status: 'RUNNING',
        finished_at: null,
        error: null,
        started_by: { id: superadmin.user.id },
      });
      expect(Number.isInteger(started.id)).toBeTruthy();

      const finished = await waitUntilFinished(request, superadmin.token, started.id);
      expect(finished, JSON.stringify(finished)).toMatchObject({ id: started.id, status: 'SUCCEEDED', error: null });
      expect(finished.finished_at).toEqual(expect.any(String));
      expect(finished.duration_ms).toBeGreaterThanOrEqual(0);
      expect(finished.summary?.products).toBeGreaterThanOrEqual(1);
      expect(finished.summary?.items_processed).toBe(
        (finished.summary?.products ?? 0) + (finished.summary?.addons ?? 0) + (finished.summary?.avatars ?? 0),
      );

      // A imagem virou um WebP da loja (prefixo s<id>-), servido em /uploads; o original fica no disco
      const [row] = await testDb<{ image: string }>(`SELECT "image" FROM "products" WHERE "id" = $1`, [product.id]);
      expect(row.image).toMatch(new RegExp(`^s${store.id}-${legacyName.replace(/\.png$/, '')}-\\d+\\.webp$`));
      const image = await request.get(`/uploads/${row.image}`);
      expect(image.status()).toBe(200);
      expect(isWebp(await image.body())).toBeTruthy();
      expect((await request.get(`/uploads/${legacyName}`)).status()).toBe(200);

      // Auditoria: início (com a rota) e fim (resultado e contagens), no alvo da execução
      const audit = await request.get(`/platform/audit?target_type=maintenance_job&target_id=${started.id}&pageSize=10`, {
        headers: bearer(superadmin.token),
      });
      expect(audit.status(), await audit.text()).toBe(200);
      const entries = (await audit.json()).items as Array<{ action: string; result: string; metadata: Record<string, unknown> }>;
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'platform.maintenance.optimize_images',
            result: 'SUCCESS',
            metadata: expect.objectContaining({ job_id: started.id, route: 'platform' }),
          }),
          expect.objectContaining({
            action: 'platform.maintenance.optimize_images.finish',
            result: 'SUCCESS',
            metadata: expect.objectContaining({ job_id: started.id, products: finished.summary?.products }),
          }),
        ]),
      );
    } finally {
      await retireProduct(request, product.id);
    }
  });

  test('409 traz a execução em andamento (de outra instância); a trava vale também para a rota antiga', async ({ request }) => {
    const superadmin = await sessionOf(request, 'superadmin');
    const runningId = await insertRunningJob(superadmin.user.id, 0);
    try {
      const conflict = await expectError(
        await request.post(JOB_PATH, { headers: bearer(superadmin.token) }),
        409,
        /em andamento/,
      );
      expect(conflict.job, JSON.stringify(conflict)).toMatchObject({
        id: runningId,
        status: 'RUNNING',
        finished_at: null,
        summary: { items_processed: 4, skipped: 1 },
        started_by: { id: superadmin.user.id },
      });

      // O superpainel acompanha a mesma execução
      expect(await latestJob(request, superadmin.token)).toMatchObject({ id: runningId, status: 'RUNNING' });

      // Rota antiga: mesmo bloqueio, no formato antigo
      const legacy = await expectError(await request.post(LEGACY_PATH, { headers: bearer(superadmin.token) }), 409, /em andamento/);
      expect(legacy).not.toHaveProperty('job');

      // Nenhuma execução nova foi criada
      const [{ running }] = await testDb<{ running: number }>(
        `SELECT COUNT(*)::int AS "running" FROM "maintenance_jobs" WHERE "status" = 'RUNNING' AND "kind" = 'optimize_images'`,
      );
      expect(running).toBe(1);
    } finally {
      await releaseJob(runningId);
    }
  });

  test(`execução presa (heartbeat parado há ${STALE_MINUTES} min) vira FAILED "interrompida" e não trava a próxima`, async ({ request }) => {
    const superadmin = await sessionOf(request, 'superadmin');
    const staleId = await insertRunningJob(superadmin.user.id, STALE_MINUTES);
    try {
      const res = await request.post(JOB_PATH, { headers: bearer(superadmin.token) });
      expect(res.status(), await res.text()).toBe(202);
      const { job } = await res.json();
      expect(job.id).not.toBe(staleId);

      const [stale] = await testDb<{ status: string; error: string | null; finished_at: Date | null }>(
        `SELECT "status", "error", "finished_at" FROM "maintenance_jobs" WHERE "id" = $1`,
        [staleId],
      );
      expect(stale.status).toBe('FAILED');
      expect(stale.error).toMatch(/interrompida/i);
      expect(stale.finished_at).not.toBeNull();

      expect(await waitUntilFinished(request, superadmin.token, job.id)).toMatchObject({ status: 'SUCCEEDED' });
    } finally {
      await releaseJob(staleId);
    }
  });

  test('rota antiga (superadmin): espera o fim e responde só { message, itemsProcessed }', async ({ request }) => {
    const superadmin = await sessionOf(request, 'superadmin');
    const res = await request.post(LEGACY_PATH, { headers: bearer(superadmin.token), timeout: 120_000 });
    expect(res.status(), await res.text()).toBe(201);
    const payload = await res.json();
    expect(Object.keys(payload).sort()).toEqual(['itemsProcessed', 'message']);
    expect(typeof payload.message).toBe('string');
    expect(Number.isInteger(payload.itemsProcessed)).toBeTruthy();
    expect(payload.itemsProcessed).toBeGreaterThanOrEqual(0);

    // A execução da rota antiga é a mesma do superpainel (já terminada)
    const latest = await latestJob(request, superadmin.token);
    expect(latest).toMatchObject({ status: 'SUCCEEDED', summary: { items_processed: payload.itemsProcessed } });
  });
});
