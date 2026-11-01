import {
  Body,
  Controller,
  INestApplication,
  Module,
  Post,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  setupApp,
  trustProxyWarning,
  uploadsStaticOptions,
} from '../../config/app-setup';

/**
 * As mesmas opções do bloco ServeStaticModule do AppModule (uploadsStaticOptions, em app-setup.ts).
 * Sem o exclude, o "fallback de SPA" do @nestjs/serve-static responde o 404 de /uploads/<inexistente>
 * com a mensagem do ENOENT de <pasta>/index.html, isto é, o caminho absoluto do servidor.
 * (No Jest essa mensagem nem chega a aparecer — o `instanceof Error` do send falha entre realms e
 * vira "Not Found" —, por isso o teste confere o 404 padrão da API: "Cannot GET <url>".)
 */
@Controller('uploads')
class FakeUploadController {
  @Post()
  upload(@Body() body: unknown) {
    return { recebido: body };
  }
}

const textOf = (res: request.Response) =>
  typeof res.text === 'string' ? res.text : '';

describe('/uploads (arquivos estáticos)', () => {
  let root: string;
  let uploads: string;
  let app: INestApplication<App>;
  let server: App;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'serve-uploads-spec-'));
    uploads = join(root, 'uploads');
    mkdirSync(join(uploads, 'pasta'), { recursive: true });
    writeFileSync(join(uploads, 's1-foto.webp'), 'imagem');
    writeFileSync(join(root, 'segredo.txt'), 'SEGREDO');

    // Igual ao main.ts (NestFactory): no Test.createTestingModule o módulo não acha o Express e
    // não serve nada
    @Module({
      imports: [ServeStaticModule.forRoot(uploadsStaticOptions(uploads))],
      controllers: [FakeUploadController],
    })
    class UploadsTestModule {}

    app = await NestFactory.create<INestApplication<App>>(UploadsTestModule, {
      logger: false,
    });
    // Como o main.ts: setupApp antes da inicialização (cabeçalhos valem também para /uploads)
    setupApp(app);
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('serve os arquivos existentes', async () => {
    const res = await request(server).get('/uploads/s1-foto.webp').expect(200);
    expect(res.headers['content-type']).toContain('image/webp');
  });

  it('arquivo inexistente, pasta ou caminho estranho → 404 padrão, sem caminho do servidor', async () => {
    const paths = [
      '/uploads/nao-existe.webp',
      '/uploads/',
      '/uploads',
      '/uploads/pasta',
      '/uploads/pasta/',
      '/uploads/index.html',
      '/uploads/s1-foto.webp/x',
      '/uploads/a/b/c.webp',
      '/UPLOADS/nao-existe.webp',
    ];
    for (const path of paths) {
      const res = await request(server).get(path);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      expect(res.body).toEqual({
        message: `Cannot GET ${path}`,
        error: 'Not Found',
        statusCode: 404,
      });
      expect(textOf(res)).not.toMatch(/ENOENT|serve-uploads-spec/);
    }
  });

  it('não sai da pasta de uploads', async () => {
    for (const path of [
      '/uploads/..%2Fsegredo.txt',
      '/uploads/%2e%2e%2fsegredo.txt',
      '/uploads/..%5Csegredo.txt',
    ]) {
      const res = await request(server).get(path);
      expect([400, 403, 404]).toContain(res.status);
      expect(textOf(res)).not.toContain('SEGREDO');
      expect(textOf(res)).not.toMatch(/ENOENT|[A-Za-z]:\\/);
    }
  });

  it('cabeçalhos de segurança: nosniff e CSP com sandbox nos arquivos; sem X-Powered-By em nada', async () => {
    const file = await request(server).get('/uploads/s1-foto.webp').expect(200);
    expect(file.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'cross-origin',
    });
    expect(file.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(file.headers['content-security-policy']).toContain('sandbox');
    expect(file.headers['x-powered-by']).toBeUndefined();

    for (const res of [
      await request(server).post('/uploads').send({ a: 1 }),
      await request(server).get('/uploads/nao-existe.webp'),
    ]) {
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toContain(
        "frame-ancestors 'none'",
      );
    }
  });

  it('TRUST_PROXY vazio atrás de proxy: avisa uma única vez quando chega X-Forwarded-For', () => {
    const logger = { warn: jest.fn() };
    const middleware = trustProxyWarning(logger);
    const next = jest.fn();
    const req = (headers: Record<string, string>) =>
      ({ headers }) as unknown as Parameters<typeof middleware>[0];
    const res = {} as Parameters<typeof middleware>[1];
    middleware(req({}), res, next);
    expect(logger.warn).not.toHaveBeenCalled();
    middleware(req({ 'x-forwarded-for': '203.0.113.9' }), res, next);
    middleware(req({ forwarded: 'for=203.0.113.9' }), res, next);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message] = logger.warn.mock.calls[0] as [string];
    expect(message).toContain('TRUST_PROXY');
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('POST /uploads continua sendo a rota da API (inclusive os erros dela)', async () => {
    await request(server)
      .post('/uploads')
      .send({ a: 1 })
      .expect(201, { recebido: { a: 1 } });
    // JSON inválido: 400 do body-parser, não o 404 dos arquivos estáticos
    await request(server)
      .post('/uploads')
      .set('Content-Type', 'application/json')
      .send('{"a":')
      .expect(400);
  });
});
