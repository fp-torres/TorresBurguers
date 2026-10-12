import { readFileSync } from 'fs';
import { join } from 'path';
import { INestApplication } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BRAND } from './config/brand';

const packageVersion = (
  JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

describe('AppController — GET /health', () => {
  let app: INestApplication<App>;
  let appController: AppController;
  const originalAppName = process.env.APP_NAME;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = moduleRef.get(AppController);
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(() => {
    if (originalAppName === undefined) delete process.env.APP_NAME;
    else process.env.APP_NAME = originalAppName;
  });

  afterAll(async () => {
    await app.close();
  });

  it('responde 200 com status, nome do sistema e versão do package.json', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);

    expect(res.body).toEqual({
      status: 'ok',
      name: BRAND.name,
      version: packageVersion,
    });
  });

  it('é público: nenhum guard na rota nem no controller', () => {
    // O Nest guarda os guards no próprio método (descriptor.value) e na classe
    const handler = Object.getOwnPropertyDescriptor(
      AppController.prototype,
      'getHealth',
    )?.value as object;
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, AppController)).toBeUndefined();
  });

  it('usa APP_NAME quando definido', () => {
    process.env.APP_NAME = 'Lanchonete do Bairro';
    expect(appController.getHealth().name).toBe('Lanchonete do Bairro');
  });

  it('usa o nome padrão da marca quando APP_NAME está vazio', () => {
    process.env.APP_NAME = '';
    expect(appController.getHealth()).toEqual({
      status: 'ok',
      name: BRAND.name,
      version: packageVersion,
    });
    expect(BRAND.name).toBeTruthy();
  });
});
