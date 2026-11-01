import { readFileSync } from 'fs';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { setupApp } from './../src/config/app-setup';
import { BRAND } from './../src/config/brand';

/**
 * Sobe o AppModule completo, como em produção (mesma ValidationPipe e CORS do main.ts).
 * Precisa de um PostgreSQL acessível com as variáveis DB_* (do .env ou do ambiente) e de um banco
 * DESCARTÁVEL: a subida aplica as migrations (DB_MIGRATIONS_RUN). Rode com DB_DATABASE=<nome>_test
 * (ex.: createdb comestra_test); qualquer outro nome é recusado para nunca migrar o banco de desenvolvimento.
 */
describe('API (e2e)', () => {
  let app: INestApplication<App>;

  const packageVersion = (
    JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      version: string;
    }
  ).version;

  beforeAll(async () => {
    const database = process.env.DB_DATABASE ?? '';
    if (!/_(test|e2e)$/.test(database)) {
      throw new Error(
        `Recusado: DB_DATABASE="${database}" não termina com _test (ou _e2e). Este teste aplica migrations e só roda em banco descartável.`,
      );
    }

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = setupApp(
      moduleFixture.createNestApplication<INestApplication<App>>(),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health responde só { status: "ok" } (sem nome nem versão)', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.text).not.toContain(packageVersion);
    expect(res.text).not.toContain(BRAND.name);
  });

  it('rota protegida sem token → 401 no formato do contrato', () => {
    return request(app.getHttpServer()).get('/users').expect(401).expect({
      statusCode: 401,
      message: 'Sessão inválida ou expirada. Faça login novamente.',
      error: 'Unauthorized',
    });
  });
});
