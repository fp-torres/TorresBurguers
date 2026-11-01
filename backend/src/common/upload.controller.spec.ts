import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import type { AuthUser } from '../auth/auth-user';
import { RolesGuard } from '../auth/roles.guard';
import { StoreStaffGuard, TenantService } from '../tenancy';
import { UserRole } from '../users/entities/user.entity';
import {
  RateLimitService,
  TOO_MANY_ATTEMPTS_MESSAGE,
} from './rate-limit/rate-limit.service';
import { UploadController } from './upload.controller';
import { MULTIPART_LIMIT_MESSAGE } from './uploads/image-upload';
import { isStoreFile } from './uploads/store-files';

// PNG 1x1 válido
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const bodyOf = (res: request.Response) =>
  res.body as { message?: string | string[]; filename?: string };

const STORES: Record<number, { id: number; slug: string }> = {
  7: { id: 7, slug: 'loja-sete' },
  8: { id: 8, slug: 'loja-oito' },
};

/** TenantService falso: a loja da equipe é a do usuário (como no real). */
const tenants = {
  staffContext: jest.fn((user: AuthUser) =>
    user.storeId && user.role !== UserRole.CLIENT
      ? Promise.resolve({
          storeId: user.storeId,
          store: STORES[user.storeId],
          subscription: null,
          access: {},
        })
      : Promise.reject(
          new ForbiddenException(
            'Esta área é exclusiva da equipe de uma loja.',
          ),
        ),
  ),
};

const session = (role: UserRole, storeId: number | null): AuthUser => ({
  id: 1,
  email: 'equipe@teste.com',
  name: 'Equipe',
  role,
  storeId,
  platformRole: null,
});
const as = (user: AuthUser) => ({ 'x-test-user': JSON.stringify(user) });

/** No lugar do JWT: a sessão do teste vem no cabeçalho x-test-user. */
const fakeJwt: CanActivate = {
  canActivate: (context: ExecutionContext) => {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();
    const raw = req.headers['x-test-user'];
    if (!raw) throw new UnauthorizedException();
    req.user = JSON.parse(raw) as AuthUser;
    return true;
  },
};

describe('POST /uploads', () => {
  let app: INestApplication<App>;
  let server: App;
  let uploads: string;

  beforeAll(async () => {
    uploads = mkdtempSync(join(tmpdir(), 'uploads-spec-'));
    process.env.UPLOADS_DIR = join(uploads, 'nova-pasta'); // ainda não existe: o pipe cria

    const moduleRef = await Test.createTestingModule({
      controllers: [UploadController],
      providers: [
        { provide: TenantService, useValue: tenants },
        // Na API o serviço é global (SharedModule); aqui, o real (lê RATE_LIMIT_UPLOAD do ambiente)
        RateLimitService,
      ],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue(fakeJwt)
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

  const savedFiles = () => {
    const dir = join(uploads, 'nova-pasta');
    return existsSync(dir) ? readdirSync(dir) : [];
  };

  it('é exclusivo do ADMIN de uma loja (StaffRoute)', () => {
    const handler = (
      UploadController.prototype as unknown as Record<string, object>
    ).uploadFile;
    expect(Reflect.getMetadata('roles', handler)).toEqual(['ADMIN']);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual(
      expect.arrayContaining([StoreStaffGuard, RolesGuard]),
    );
  });

  it('anônimo 401; cliente e equipe sem ADMIN 403 (nada é gravado)', async () => {
    const before = savedFiles().length;
    await request(server)
      .post('/uploads')
      .attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' })
      .expect(401);
    for (const user of [
      session(UserRole.CLIENT, null),
      session(UserRole.EMPLOYEE, 7),
      session(UserRole.KITCHEN, 7),
    ]) {
      await request(server)
        .post('/uploads')
        .set(as(user))
        .attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' })
        .expect(403);
    }
    expect(savedFiles().length).toBe(before);
  });

  it('salva a imagem otimizada com o prefixo da loja e devolve só o nome do arquivo', async () => {
    const res = await request(server)
      .post('/uploads')
      .set(as(session(UserRole.ADMIN, 7)))
      .attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' })
      .expect(201);
    expect(Object.keys(res.body as object)).toEqual(['filename']);
    const filename = bodyOf(res).filename ?? '';
    expect(filename).toMatch(/^s7-compressed-.+\.webp$/);
    expect(isStoreFile(filename, 7)).toBe(true);
    expect(isStoreFile(filename, 8)).toBe(false);
    expect(existsSync(join(uploads, 'nova-pasta', filename))).toBe(true);

    // Cada loja recebe o próprio prefixo
    const other = await request(server)
      .post('/uploads')
      .set(as(session(UserRole.ADMIN, 8)))
      .attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' })
      .expect(201);
    expect(bodyOf(other).filename).toMatch(/^s8-compressed-.+\.webp$/);
  });

  it('sem arquivo, campo errado ou arquivo que não é imagem → 400', async () => {
    const admin = as(session(UserRole.ADMIN, 7));
    const none = await request(server).post('/uploads').set(admin).expect(400);
    expect(bodyOf(none).message).toContain('Nenhuma imagem enviada');

    const wrongField = await request(server)
      .post('/uploads')
      .set(admin)
      .attach('foto', PNG, { filename: 'logo.png', contentType: 'image/png' })
      .expect(400);
    expect(bodyOf(wrongField).message).toBe(
      'Envie uma única imagem, no campo "file".',
    );

    await request(server)
      .post('/uploads')
      .set(admin)
      .attach('file', Buffer.from('GIF89a'), {
        filename: 'a.gif',
        contentType: 'image/gif',
      })
      .expect(400);
  });

  it('multipart com campos demais ou texto longo demais → 400 sem guardar o corpo (nada gravado)', async () => {
    const admin = as({ ...session(UserRole.ADMIN, 7), id: 501 });
    const before = savedFiles().length;
    let many = request(server).post('/uploads').set(admin);
    for (let i = 0; i < 1000; i++) many = many.field(`x${i}`, 'a');
    const tooMany = await many
      .attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' })
      .expect(400);
    expect(bodyOf(tooMany).message).toBe(MULTIPART_LIMIT_MESSAGE);

    const tooLong = await request(server)
      .post('/uploads')
      .set(admin)
      .field('x', 'A'.repeat(64 * 1024))
      .attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' })
      .expect(400);
    expect(bodyOf(tooLong).message).toBe(MULTIPART_LIMIT_MESSAGE);
    expect(savedFiles().length).toBe(before);
  });

  it('limite UPLOAD por conta: cada imagem conta; no limite → 429 antes de ler o corpo; outra conta segue', async () => {
    process.env.RATE_LIMIT_UPLOAD = '2/600';
    try {
      const admin = as({ ...session(UserRole.ADMIN, 7), id: 777 });
      for (let i = 0; i < 2; i++) {
        await request(server)
          .post('/uploads')
          .set(admin)
          .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })
          .expect(201);
      }
      const before = savedFiles().length;
      const limited = await request(server)
        .post('/uploads')
        .set(admin)
        .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })
        .expect(429);
      expect(bodyOf(limited).message).toBe(TOO_MANY_ATTEMPTS_MESSAGE);
      expect(savedFiles().length).toBe(before);
      // Outra conta (mesma loja) tem o próprio limite
      await request(server)
        .post('/uploads')
        .set(as({ ...session(UserRole.ADMIN, 7), id: 778 }))
        .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })
        .expect(201);
    } finally {
      delete process.env.RATE_LIMIT_UPLOAD;
    }
  });
});
