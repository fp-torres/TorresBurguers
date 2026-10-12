import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  GIF_1X1,
  JPEG_8X8,
  MAX_UPLOAD_BYTES,
  SVG_IMAGE,
  bearer,
  body,
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

  test('PNG válido → {filename} .webp, servido em /uploads/<arquivo> como imagem', async ({ request }) => {
    const res = await adminUpload(request, pngFile(makePng(64, 48)));
    expect(res.status(), await res.text()).toBe(201);
    const payload = await res.json();
    expect(Object.keys(payload)).toEqual(['filename']);
    expect(payload.filename).toMatch(/^[\w.-]+\.webp$/);

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
    expect((await request.get('/uploads/nao-existe-e2e.webp')).status()).toBe(404);
    for (const path of ['/uploads/..%2Fpackage.json', '/uploads/%2e%2e%2f%2e%2e%2fbackend%2f.env', '/uploads/..%5C..%5Cbackend%5Cpackage.json']) {
      const res = await request.get(path);
      expect([400, 403, 404], `${path}: ${res.status()}`).toContain(res.status());
      expect(await res.text()).not.toMatch(/"dependencies"|JWT_SECRET|DB_PASSWORD/);
    }
  });
});

test.describe('Manutenção (POST /maintenance/optimize-images) — somente ADMIN', () => {
  test('anônimo → 401', async ({ request }) => {
    await expectError(await request.post('/maintenance/optimize-images'), 401);
  });

  for (const key of NON_ADMIN) {
    test(`perfil ${key} → 403`, async ({ request }) => {
      const session = await sessionOf(request, key);
      await expectError(await request.post('/maintenance/optimize-images', { headers: bearer(session.token) }), 403);
    });
  }

  test('ADMIN executa a otimização e recebe o resumo {message, itemsProcessed}', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    const res = await request.post('/maintenance/optimize-images', { headers: bearer(admin.token), timeout: 120_000 });
    expect([200, 201], await res.text()).toContain(res.status());
    const payload = await res.json();
    expect(typeof payload.message).toBe('string');
    expect(Number.isInteger(payload.itemsProcessed)).toBeTruthy();
    expect(payload.itemsProcessed).toBeGreaterThanOrEqual(0);
  });
});
