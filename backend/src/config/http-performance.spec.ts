import {
  Body,
  Controller,
  Get,
  INestApplication,
  Logger,
  Module,
  Patch,
  Post,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  BODY_ENCODING_UNSUPPORTED_MESSAGE,
  BODY_INVALID_MESSAGE,
  BODY_TOO_LARGE_MESSAGE,
  JSON_BODY_LIMIT,
  STORE_SETTINGS_JSON_BODY_LIMIT,
  UPLOADS_CACHE_MAX_AGE_MS,
  setupApp,
  uploadsStaticOptions,
} from './app-setup';

/** Lista grande e repetitiva, como o quadro de pedidos. */
const BOARD = Array.from({ length: 300 }, (_, index) => ({
  id: index + 1,
  status: 'PENDING',
  items: [{ product_name: 'X-Burger', quantity: 1, unit_price: 25.9 }],
}));

@Controller()
class FakeController {
  @Get('board')
  board() {
    return BOARD;
  }

  @Get('small')
  small() {
    return { ok: true };
  }

  @Post('eco')
  eco(@Body() body: unknown) {
    return { size: JSON.stringify(body).length };
  }

  @Patch('store/settings')
  settings(@Body() body: unknown) {
    return { size: JSON.stringify(body).length };
  }
}

/** Corpo JSON de aproximadamente `bytes` bytes. */
const bodyOf = (bytes: number) => ({ text: 'a'.repeat(bytes) });

describe('HTTP: compressão, teto do corpo JSON e cache de /uploads', () => {
  let root: string;
  let app: INestApplication<App>;
  let server: App;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'http-performance-spec-'));
    writeFileSync(join(root, 's1-123-abcd.webp'), Buffer.alloc(4096, 7));

    @Module({
      imports: [ServeStaticModule.forRoot(uploadsStaticOptions(root))],
      controllers: [FakeController],
    })
    class HttpTestModule {}

    // Igual ao main.ts: NestFactory + setupApp antes da inicialização
    app = await NestFactory.create<INestApplication<App>>(HttpTestModule, {
      logger: false,
    });
    setupApp(app);
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('JSON grande sai comprimido quando o cliente aceita (gzip), com o mesmo conteúdo', async () => {
    const plain = JSON.stringify(BOARD);
    const res = await request(server)
      .get('/board')
      .set('Accept-Encoding', 'gzip')
      .expect(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers.vary).toMatch(/Accept-Encoding/i);
    expect(res.body).toEqual(BOARD);
    expect(Number(res.headers['content-length'] ?? 0)).toBeLessThan(
      plain.length,
    );
  });

  it('sem Accept-Encoding, resposta pequena e imagens de /uploads: sem compressão', async () => {
    const identity = await request(server)
      .get('/board')
      .set('Accept-Encoding', 'identity')
      .expect(200);
    expect(identity.headers['content-encoding']).toBeUndefined();

    const small = await request(server)
      .get('/small')
      .set('Accept-Encoding', 'gzip')
      .expect(200);
    expect(small.headers['content-encoding']).toBeUndefined();

    // webp já é comprimido: o filtro padrão (Content-Type) não comprime de novo
    const image = await request(server)
      .get('/uploads/s1-123-abcd.webp')
      .set('Accept-Encoding', 'gzip')
      .expect(200);
    expect(image.headers['content-encoding']).toBeUndefined();
  });

  it('/uploads: cache longo e imutável (nomes únicos, nunca sobrescritos)', async () => {
    const res = await request(server)
      .get('/uploads/s1-123-abcd.webp')
      .expect(200);
    expect(res.headers['cache-control']).toBe(
      `public, max-age=${UPLOADS_CACHE_MAX_AGE_MS / 1000}, immutable`,
    );
    // Arquivo inexistente segue sendo o 404 padrão (sem cache longo de um erro)
    const missing = await request(server).get('/uploads/nao-existe.webp');
    expect(missing.status).toBe(404);
    expect(missing.headers['cache-control'] ?? '').not.toContain('immutable');
  });

  it(`corpo JSON: até ${JSON_BODY_LIMIT} nas rotas em geral; acima → 413 sem chegar à rota`, async () => {
    expect(JSON_BODY_LIMIT).toBe('100kb');
    await request(server)
      .post('/eco')
      .send(bodyOf(90 * 1024))
      .expect(201);
    await request(server)
      .post('/eco')
      .send(bodyOf(120 * 1024))
      .expect(413);
  });

  it(`/store/settings (zonas de entrega no limite da validação, ~1 MB) aceita até ${STORE_SETTINGS_JSON_BODY_LIMIT}`, async () => {
    // 50 zonas × 200 bairros de 80 caracteres (o maior JSON legítimo)
    const zones = Array.from({ length: 50 }, (_, zone) => ({
      name: `Zona ${zone}`,
      fee: 5,
      neighborhoods: Array.from({ length: 200 }, (_, index) =>
        `Bairro ${zone}-${index} `.padEnd(80, 'x'),
      ),
    }));
    const res = await request(server)
      .patch('/store/settings')
      .send({ delivery_zones: { zones } })
      .expect(200);
    expect((res.body as { size: number }).size).toBeGreaterThan(800 * 1024);

    await request(server)
      .patch('/store/settings')
      .send(bodyOf(2 * 1024 * 1024 + 1024))
      .expect(413);
  });

  it('erros do corpo (grande demais, JSON malformado, compressão inválida ou não suportada): 4xx em português, sem ERROR no log', async () => {
    // Antes caíam no ExceptionsHandler do Nest: ERROR com stack a cada corpo ruim de um cliente
    const logged = jest.spyOn(Logger.prototype, 'error');
    try {
      const big = await request(server)
        .post('/eco')
        .send(bodyOf(120 * 1024))
        .expect(413);
      expect(big.body).toEqual({
        statusCode: 413,
        message: BODY_TOO_LARGE_MESSAGE,
        error: 'Payload Too Large',
      });

      const malformed = await request(server)
        .post('/eco')
        .set('Content-Type', 'application/json')
        .send('{"nome":')
        .expect(400);
      expect(malformed.body).toEqual({
        statusCode: 400,
        message: BODY_INVALID_MESSAGE,
        error: 'Bad Request',
      });

      const badGzip = await request(server)
        .post('/eco')
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'gzip')
        .send('isto não é gzip')
        .expect(400);
      expect(badGzip.body).toEqual({
        statusCode: 400,
        message: BODY_INVALID_MESSAGE,
        error: 'Bad Request',
      });

      const unsupported = await request(server)
        .post('/eco')
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'compress')
        .send('{}')
        .expect(415);
      expect(unsupported.body).toEqual({
        statusCode: 415,
        message: BODY_ENCODING_UNSUPPORTED_MESSAGE,
        error: 'Unsupported Media Type',
      });

      expect(logged).not.toHaveBeenCalled();
      // A API segue respondendo normalmente
      await request(server).post('/eco').send({ ok: true }).expect(201);
    } finally {
      logged.mockRestore();
    }
  });
});
