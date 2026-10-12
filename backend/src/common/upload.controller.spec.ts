import { INestApplication } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { RolesGuard } from '../auth/roles.guard';
import { UploadController } from './upload.controller';

// PNG 1x1 válido
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const bodyOf = (res: request.Response) =>
  res.body as { message?: string | string[]; filename?: string };

describe('POST /uploads', () => {
  let app: INestApplication<App>;
  let server: App;
  let uploads: string;

  beforeAll(async () => {
    uploads = mkdtempSync(join(tmpdir(), 'uploads-spec-'));
    process.env.UPLOADS_DIR = join(uploads, 'nova-pasta'); // ainda não existe: o pipe cria

    const moduleRef = await Test.createTestingModule({
      controllers: [UploadController],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.UPLOADS_DIR;
    rmSync(uploads, { recursive: true, force: true });
  });

  it('é exclusivo de ADMIN', () => {
    const handler = (
      UploadController.prototype as unknown as Record<string, object>
    ).uploadFile;
    expect(Reflect.getMetadata('roles', handler)).toEqual(['ADMIN']);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RolesGuard);
  });

  it('salva a imagem otimizada em UPLOADS_DIR e devolve o nome do arquivo', async () => {
    const res = await request(server)
      .post('/uploads')
      .attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' })
      .expect(201);
    const filename = bodyOf(res).filename ?? '';
    expect(filename).toMatch(/^compressed-.+\.webp$/);
    expect(existsSync(join(uploads, 'nova-pasta', filename))).toBe(true);
  });

  it('sem arquivo, campo errado ou arquivo que não é imagem → 400', async () => {
    const none = await request(server).post('/uploads').expect(400);
    expect(bodyOf(none).message).toContain('Nenhuma imagem enviada');

    const wrongField = await request(server)
      .post('/uploads')
      .attach('foto', PNG, { filename: 'logo.png', contentType: 'image/png' })
      .expect(400);
    expect(bodyOf(wrongField).message).toBe(
      'Envie uma única imagem, no campo "file".',
    );

    await request(server)
      .post('/uploads')
      .attach('file', Buffer.from('GIF89a'), {
        filename: 'a.gif',
        contentType: 'image/gif',
      })
      .expect(400);
  });
});
