import {
  ConflictException,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { setupApp } from '../config/app-setup';
import { UserRole } from './entities/user.entity';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

// PNG 1x1 válido
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const STRONG_PASSWORD = 'SenhaForte@123';

const ADMIN = { id: 1, role: UserRole.ADMIN };
const CLIENT = { id: 10, role: UserRole.CLIENT };

/** Usuário "autenticado" do teste: cabeçalho x-test-user com o JSON de req.user. */
function userFrom(context: ExecutionContext) {
  const req = context
    .switchToHttp()
    .getRequest<{ headers: Record<string, string>; user?: unknown }>();
  const header = req.headers['x-test-user'];
  req.user = header ? (JSON.parse(header) as unknown) : null;
  return req.user;
}

const as = (user: object) => ({ 'x-test-user': JSON.stringify(user) });

const bodyOf = (res: request.Response) =>
  res.body as { message?: string | string[]; avatar?: string };

describe('UsersController (HTTP)', () => {
  let app: INestApplication<App>;
  let server: App;
  let uploads: string;
  const service = {
    create: jest
      .fn()
      .mockImplementation((dto: object, role: UserRole) =>
        Promise.resolve({ id: 50, ...dto, role }),
      ),
    update: jest
      .fn()
      .mockImplementation((id: number, dto: object) =>
        Promise.resolve({ id, ...dto }),
      ),
    findOne: jest.fn().mockResolvedValue({ id: 1 }),
    remove: jest.fn().mockResolvedValue({ message: 'ok' }),
    restore: jest.fn().mockResolvedValue({ id: 1 }),
    hardDelete: jest.fn().mockResolvedValue({ message: 'ok' }),
  };

  const files = () => readdirSync(uploads);

  beforeAll(async () => {
    uploads = mkdtempSync(join(tmpdir(), 'users-uploads-spec-'));
    process.env.UPLOADS_DIR = uploads;

    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: service }],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({ canActivate: (ctx: ExecutionContext) => !!userFrom(ctx) })
      .overrideGuard(OptionalJwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          userFrom(ctx);
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    // Mesma configuração da API (ValidationPipe global, filtro dos 401 e CORS)
    app = setupApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.UPLOADS_DIR;
    rmSync(uploads, { recursive: true, force: true });
  });

  beforeEach(() => jest.clearAllMocks());

  describe('foto de perfil: gravada só depois da validação (sem arquivo órfão)', () => {
    it('cadastro válido grava a foto otimizada e usa /uploads/<arquivo>.webp', async () => {
      const before = files().length;
      const res = await request(server)
        .post('/users')
        .field('name', 'Maria Silva')
        .field('email', 'maria@email.com')
        .field('password', STRONG_PASSWORD)
        .attach('file', PNG, { filename: 'eu.png', contentType: 'image/png' })
        .expect(201);

      expect(bodyOf(res).avatar).toMatch(/^\/uploads\/compressed-.+\.webp$/);
      expect(files().length).toBe(before + 1);
    });

    it('cadastro recusado na validação, no perfil ou por e-mail repetido não deixa arquivo', async () => {
      const before = files();

      // Senha fraca → 400 do ValidationPipe
      await request(server)
        .post('/users')
        .field('name', 'Foto Órfã')
        .field('email', 'orfa@email.com')
        .field('password', 'fraca')
        .attach('file', PNG, { filename: 'eu.png', contentType: 'image/png' })
        .expect(400);

      // Perfil da equipe sem token de ADMIN → 403
      await request(server)
        .post('/users')
        .field('name', 'Intruso')
        .field('email', 'intruso@email.com')
        .field('password', STRONG_PASSWORD)
        .field('role', 'ADMIN')
        .attach('file', PNG, { filename: 'eu.png', contentType: 'image/png' })
        .expect(403);

      // E-mail já cadastrado → 409 e a foto recém-gravada é apagada
      service.create.mockRejectedValueOnce(
        new ConflictException('E-mail já cadastrado'),
      );
      await request(server)
        .post('/users')
        .field('name', 'Repetido')
        .field('email', 'repetido@email.com')
        .field('password', STRONG_PASSWORD)
        .attach('file', PNG, { filename: 'eu.png', contentType: 'image/png' })
        .expect(409);

      expect(files()).toEqual(before);
      expect(service.create).toHaveBeenCalledTimes(1); // só o do e-mail repetido
    });

    it('edição recusada na validação não deixa arquivo', async () => {
      const before = files();
      await request(server)
        .patch(`/users/${CLIENT.id}`)
        .set(as(CLIENT))
        .field('phone', '123')
        .attach('file', PNG, { filename: 'eu.png', contentType: 'image/png' })
        .expect(400);

      expect(files()).toEqual(before);
      expect(service.update).not.toHaveBeenCalled();
    });

    it('edição válida grava a foto e passa o avatar para o serviço', async () => {
      await request(server)
        .patch(`/users/${CLIENT.id}`)
        .set(as(CLIENT))
        .field('name', 'Com Foto')
        .attach('file', PNG, { filename: 'eu.png', contentType: 'image/png' })
        .expect(200);

      const [id, dto] = service.update.mock.calls[0] as [
        number,
        { name?: string; avatar?: string },
      ];
      expect(id).toBe(CLIENT.id);
      expect(dto.name).toBe('Com Foto');
      expect(dto.avatar).toMatch(/^\/uploads\/compressed-.+\.webp$/);
    });
  });

  it('ids fora do intervalo de inteiro (ou não numéricos) → 400 "Id inválido."', async () => {
    const calls = [
      request(server).get('/users/99999999999').set(as(ADMIN)),
      request(server).get('/users/abc').set(as(ADMIN)),
      request(server)
        .patch('/users/99999999999')
        .set(as(ADMIN))
        .send({ name: 'X' }),
      request(server).delete('/users/99999999999').set(as(ADMIN)),
      request(server).patch('/users/99999999999/restore').set(as(ADMIN)),
      request(server).delete('/users/99999999999/permanent').set(as(ADMIN)),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(400);
      expect(bodyOf(res).message).toBe('Id inválido.');
    }
    expect(service.findOne).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
    expect(service.restore).not.toHaveBeenCalled();
    expect(service.hardDelete).not.toHaveBeenCalled();
  });

  describe('senha com no máximo 72 bytes (limite do bcrypt)', () => {
    const at72 = `Prefixo1-${'x'.repeat(63)}`; // 72 bytes ASCII

    it('cadastro: 72 bytes passa; 73 bytes ou acentos além do limite → 400', async () => {
      await request(server)
        .post('/users')
        .send({ name: 'Limite', email: 'limite@email.com', password: at72 })
        .expect(201);

      for (const password of [`${at72}Z`, `Senha1${'ç'.repeat(34)}`]) {
        const res = await request(server)
          .post('/users')
          .send({ name: 'Longa', email: 'longa@email.com', password })
          .expect(400);
        expect(bodyOf(res).message).toEqual([
          expect.stringContaining('no máximo 72 caracteres'),
        ]);
      }
    });

    it('edição: senha acima do limite → 400', async () => {
      await request(server)
        .patch(`/users/${CLIENT.id}`)
        .set(as(CLIENT))
        .send({ password: `${at72}Z` })
        .expect(400);
      expect(service.update).not.toHaveBeenCalled();
    });
  });

  describe('perfil de acesso', () => {
    it('ADMIN não altera o próprio perfil (400), mas pode reenviá-lo sem mudança', async () => {
      const res = await request(server)
        .patch(`/users/${ADMIN.id}`)
        .set(as(ADMIN))
        .send({ role: 'CLIENT' })
        .expect(400);
      expect(bodyOf(res).message).toContain('próprio perfil');
      expect(service.update).not.toHaveBeenCalled();

      await request(server)
        .patch(`/users/${ADMIN.id}`)
        .set(as(ADMIN))
        .send({ role: 'ADMIN', name: 'Admin' })
        .expect(200);
      expect(service.update).toHaveBeenCalledWith(ADMIN.id, {
        name: 'Admin',
        role: undefined,
      });
    });

    it('ADMIN altera o perfil de outro usuário', async () => {
      await request(server)
        .patch(`/users/${CLIENT.id}`)
        .set(as(ADMIN))
        .send({ role: 'COURIER' })
        .expect(200);
      expect(service.update).toHaveBeenCalledWith(CLIENT.id, {
        role: UserRole.COURIER,
      });
    });
  });

  describe('telefone', () => {
    it('PATCH com texto vazio ou null remove o telefone (null)', async () => {
      await request(server)
        .patch(`/users/${CLIENT.id}`)
        .set(as(CLIENT))
        .send({ phone: '' })
        .expect(200);
      await request(server)
        .patch(`/users/${CLIENT.id}`)
        .set(as(CLIENT))
        .send({ phone: null })
        .expect(200);
      await request(server)
        .patch(`/users/${CLIENT.id}`)
        .set(as(CLIENT))
        .field('phone', '  ')
        .expect(200);

      expect(service.update).toHaveBeenCalledTimes(3);
      for (const [, dto] of service.update.mock.calls as [number, object][]) {
        expect(dto).toEqual({ phone: null, role: undefined });
      }
    });

    it('PATCH com telefone válido grava; inválido → 400', async () => {
      await request(server)
        .patch(`/users/${CLIENT.id}`)
        .set(as(CLIENT))
        .send({ phone: ' 21988887777 ' })
        .expect(200);
      expect(service.update).toHaveBeenCalledWith(CLIENT.id, {
        phone: '21988887777',
        role: undefined,
      });

      await request(server)
        .patch(`/users/${CLIENT.id}`)
        .set(as(CLIENT))
        .send({ phone: '2199' })
        .expect(400);
    });

    it('POST com telefone vazio = não informado', async () => {
      await request(server)
        .post('/users')
        .field('name', 'Sem Telefone')
        .field('email', 'sem-telefone@email.com')
        .field('password', STRONG_PASSWORD)
        .field('phone', '')
        .expect(201);

      const [dto] = service.create.mock.calls[0] as [Record<string, unknown>];
      expect(dto.phone).toBeUndefined();
    });
  });
});
