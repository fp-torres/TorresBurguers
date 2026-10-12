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
 * Precisa de um PostgreSQL acessível com as variáveis DB_* (do .env ou do ambiente);
 * para não usar o banco de desenvolvimento, rode com DB_DATABASE=<banco_de_teste>.
 */
describe('API (e2e)', () => {
  let app: INestApplication<App>;

  const packageVersion = (
    JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      version: string;
    }
  ).version;

  beforeAll(async () => {
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

  it('GET /health responde status, nome e versão', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', name: BRAND.name, version: packageVersion });
  });

  it('rota protegida sem token → 401 no formato do contrato', () => {
    return request(app.getHttpServer()).get('/users').expect(401).expect({
      statusCode: 401,
      message: 'Sessão inválida ou expirada. Faça login novamente.',
      error: 'Unauthorized',
    });
  });
});
