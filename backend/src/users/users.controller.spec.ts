import {
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  INestApplication,
  NotFoundException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { SessionTokenService } from '../auth/session-token.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { setupApp } from '../config/app-setup';
import { StoreStaffGuard } from '../tenancy/guards';
import { TenantService } from '../tenancy/tenant.service';
import { UserRole } from './entities/user.entity';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

// PNG 1x1 válido
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const STRONG_PASSWORD = 'SenhaForte@123';
const STORE_A = 1;

const ADMIN = { id: 1, role: UserRole.ADMIN, storeId: STORE_A };
const CLIENT = { id: 10, role: UserRole.CLIENT, storeId: null };
const KITCHEN = { id: 20, role: UserRole.KITCHEN, storeId: STORE_A };
const SUPPORT = {
  id: 90,
  role: UserRole.ADMIN,
  storeId: STORE_A,
  platformRole: null,
  supportSession: { id: 3, storeId: STORE_A },
};

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
  res.body as {
    message?: string | string[];
    avatar?: string;
    access_token?: string;
  };

describe('UsersController (HTTP)', () => {
  let app: INestApplication<App>;
  let server: App;
  let uploads: string;

  const echo = (user: object) => Promise.resolve({ ...user });
  const service = {
    createClient: jest.fn().mockImplementation((dto: object, avatar?: string) =>
      Promise.resolve({
        id: 50,
        ...dto,
        ...(avatar ? { avatar } : {}),
        role: UserRole.CLIENT,
      }),
    ),
    createStaff: jest
      .fn()
      .mockImplementation((dto: object, role: UserRole, storeId: number) =>
        Promise.resolve({ id: 51, ...dto, role, store_id: storeId }),
      ),
    findAccount: jest.fn().mockResolvedValue({ id: 1 }),
    findTeamMember: jest.fn().mockResolvedValue({ id: 2 }),
    findTeam: jest.fn().mockResolvedValue([]),
    findTrash: jest.fn().mockResolvedValue([]),
    updateSelf: jest
      .fn()
      .mockImplementation((actor: { id: number }, dto: object) =>
        Promise.resolve({
          user: { id: actor.id, ...dto },
          sessionsRevoked: false,
        }),
      ),
    updateTeamMember: jest
      .fn()
      .mockImplementation((id: number, _storeId: number, dto: object) =>
        Promise.resolve({ id, ...dto }),
      ),
    removeSelf: jest.fn().mockResolvedValue({ message: 'Usuário removido.' }),
    removeTeamMember: jest
      .fn()
      .mockResolvedValue({ message: 'Usuário removido.' }),
    restore: jest.fn().mockResolvedValue({ id: 3 }),
    purge: jest.fn().mockResolvedValue({ message: 'ok' }),
    presentSession: jest.fn(echo),
    presentAs: jest.fn(echo),
    presentMember: jest.fn(echo),
    presentTeam: jest.fn((users: object[]) => Promise.resolve(users)),
  };
  // Loja da equipe: a do usuário autenticado (como o TenantService real)
  const tenants = {
    staffContext: jest.fn((user: { storeId: number | null }) => {
      if (!user.storeId) {
        return Promise.reject(
          new ForbiddenException(
            'Esta área é exclusiva da equipe de uma loja.',
          ),
        );
      }
      return Promise.resolve({ storeId: user.storeId });
    }),
  };
  const rateLimit = { consume: jest.fn(), assertNotLimited: jest.fn() };
  const sessionTokens = { issue: jest.fn().mockReturnValue('token-novo') };

  const files = () => readdirSync(uploads);

  beforeAll(async () => {
    uploads = mkdtempSync(join(tmpdir(), 'users-uploads-spec-'));
    process.env.UPLOADS_DIR = uploads;

    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UsersService, useValue: service },
        { provide: TenantService, useValue: tenants },
        { provide: RateLimitService, useValue: rateLimit },
        { provide: SessionTokenService, useValue: sessionTokens },
      ],
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
      // Como o guard real: loja do req.user, sessão de suporte só lê
      .overrideGuard(StoreStaffGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest<{
            method: string;
            user: typeof SUPPORT | null;
            tenant?: unknown;
          }>();
          if (!req.user?.storeId) {
            throw new ForbiddenException(
              'Esta área é exclusiva da equipe de uma loja.',
            );
          }
          if (req.user.supportSession && req.method !== 'GET') {
            throw new ForbiddenException(
              'Sessão de suporte é somente leitura.',
            );
          }
          req.tenant = { storeId: req.user.storeId };
          return true;
        },
      })
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
      service.createClient.mockRejectedValueOnce(
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
      expect(service.createClient).toHaveBeenCalledTimes(1); // só o do e-mail repetido
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
      expect(service.updateSelf).not.toHaveBeenCalled();
    });

    it('edição válida grava a foto e passa o avatar para o serviço', async () => {
      await request(server)
        .patch(`/users/${CLIENT.id}`)
        .set(as(CLIENT))
        .field('name', 'Com Foto')
        .attach('file', PNG, { filename: 'eu.png', contentType: 'image/png' })
        .expect(200);

      const [actor, dto, , avatar] = service.updateSelf.mock.calls[0] as [
        { id: number },
        { name?: string; avatar?: string },
        unknown,
        string,
      ];
      expect(actor.id).toBe(CLIENT.id);
      expect(dto.name).toBe('Com Foto');
      // A foto vai separada do texto do cliente, com o dono no nome do arquivo (u<id>-)
      expect(dto.avatar).toBeUndefined();
      expect(avatar.startsWith(`/uploads/u${CLIENT.id}-compressed-`)).toBe(
        true,
      );
      expect(avatar.endsWith('.webp')).toBe(true);
      // Cada imagem recebida conta no limite UPLOAD da conta
      expect(rateLimit.consume).toHaveBeenCalledWith(
        'UPLOAD',
        `user:${CLIENT.id}`,
      );
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
    for (const fn of Object.values(service)) {
      expect(fn).not.toHaveBeenCalled();
    }
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
      expect(service.updateSelf).not.toHaveBeenCalled();
    });
  });

  describe('cadastro (POST /users)', () => {
    it('anônimo cria cliente e passa pelo limite de cadastros por IP', async () => {
      await request(server)
        .post('/users')
        .send({
          name: 'Ana',
          email: 'ana@email.com',
          password: STRONG_PASSWORD,
        })
        .expect(201);
      expect(rateLimit.consume).toHaveBeenCalledWith(
        'SIGNUP',
        expect.any(String),
      );
      expect(service.createClient).toHaveBeenCalledTimes(1);
      expect(service.createStaff).not.toHaveBeenCalled();
    });

    it('limite de cadastros atingido → 429 e nada é criado', async () => {
      rateLimit.consume.mockImplementationOnce(() => {
        throw new HttpException(
          'Muitas tentativas',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      });
      await request(server)
        .post('/users')
        .send({
          name: 'Ana',
          email: 'ana@email.com',
          password: STRONG_PASSWORD,
        })
        .expect(429);
      expect(service.createClient).not.toHaveBeenCalled();
    });

    it('ADMIN cria EQUIPE na própria loja: a loja vem do ADMIN, nunca de cabeçalho', async () => {
      await request(server)
        .post('/users')
        .set(as(ADMIN))
        .set('x-store-id', '2')
        .send({
          name: 'Cozinha',
          email: 'cozinha@email.com',
          password: STRONG_PASSWORD,
          role: 'KITCHEN',
        })
        .expect(201);

      expect(tenants.staffContext).toHaveBeenCalledWith(
        expect.objectContaining({ id: ADMIN.id }),
        'manage',
      );
      const [, role, storeId] = service.createStaff.mock.calls[0] as [
        object,
        UserRole,
        number,
      ];
      expect(role).toBe(UserRole.KITCHEN);
      expect(storeId).toBe(STORE_A);
      // Conta da equipe: limite TEAM_WRITE da loja (não o SIGNUP por IP)
      expect(rateLimit.consume).toHaveBeenCalledTimes(1);
      expect(rateLimit.consume).toHaveBeenCalledWith(
        'TEAM_WRITE',
        `store:${STORE_A}`,
      );
    });

    it('limites são conferidos ANTES de ler o corpo: no limite → 429 e a foto nem é gravada', async () => {
      const before = files();
      rateLimit.consume.mockImplementationOnce(() => {
        throw new HttpException('Muitas tentativas', 429);
      });
      await request(server)
        .post('/users')
        .field('name', 'Maria Silva')
        .field('email', 'limite@email.com')
        .field('password', STRONG_PASSWORD)
        .attach('file', PNG, { filename: 'eu.png', contentType: 'image/png' })
        .expect(429);
      expect(files()).toEqual(before);
      expect(service.createClient).not.toHaveBeenCalled();
    });

    it('store_id ou platform_role no corpo → 400 (o DTO não aceita)', async () => {
      for (const extra of [{ store_id: 2 }, { platform_role: 'SUPER_ADMIN' }]) {
        await request(server)
          .post('/users')
          .set(as(ADMIN))
          .send({
            name: 'Forjado',
            email: 'forjado@email.com',
            password: STRONG_PASSWORD,
            role: 'EMPLOYEE',
            ...extra,
          })
          .expect(400);
      }
      expect(service.createStaff).not.toHaveBeenCalled();
    });

    it('ADMIN pedindo CLIENT (ou sem perfil) → 400; sessão de suporte → 403', async () => {
      for (const role of ['CLIENT', undefined]) {
        await request(server)
          .post('/users')
          .set(as(ADMIN))
          .send({
            name: 'X',
            email: 'x@email.com',
            password: STRONG_PASSWORD,
            role,
          })
          .expect(400);
      }
      await request(server)
        .post('/users')
        .set(as(SUPPORT))
        .send({
          name: 'X',
          email: 'x@email.com',
          password: STRONG_PASSWORD,
          role: 'KITCHEN',
        })
        .expect(403);
      expect(service.createStaff).not.toHaveBeenCalled();
      expect(service.createClient).not.toHaveBeenCalled();
    });
  });

  describe('equipe da própria loja', () => {
    it('GET /users e GET /users/trash usam a loja do ADMIN autenticado', async () => {
      await request(server).get('/users').set(as(ADMIN)).expect(200);
      await request(server).get('/users/trash').set(as(ADMIN)).expect(200);
      expect(service.findTeam).toHaveBeenCalledWith(STORE_A);
      expect(service.findTrash).toHaveBeenCalledWith(STORE_A);
    });

    it('GET /users sem ser ADMIN de loja → 403', async () => {
      for (const user of [CLIENT, KITCHEN]) {
        await request(server).get('/users').set(as(user)).expect(403);
      }
      expect(service.findTeam).not.toHaveBeenCalled();
    });

    it('GET /users/:id de outra conta: ADMIN procura só na própria loja (fora dela → 404)', async () => {
      service.findTeamMember.mockRejectedValueOnce(
        new NotFoundException('Usuário não encontrado'),
      );
      await request(server).get('/users/77').set(as(ADMIN)).expect(404);
      expect(tenants.staffContext).toHaveBeenCalledWith(
        expect.objectContaining({ id: ADMIN.id }),
        'read',
      );
      expect(service.findTeamMember).toHaveBeenCalledWith(77, STORE_A);
    });

    it('GET /users/:id de outra conta por cliente ou equipe não-admin → 403', async () => {
      await request(server).get('/users/77').set(as(CLIENT)).expect(403);
      await request(server).get('/users/77').set(as(KITCHEN)).expect(403);
      expect(service.findTeamMember).not.toHaveBeenCalled();
    });

    it('GET /users/:id da própria conta devolve a visão da sessão atual', async () => {
      await request(server)
        .get(`/users/${KITCHEN.id}`)
        .set(as(KITCHEN))
        .expect(200);
      expect(service.findAccount).toHaveBeenCalledWith(KITCHEN.id);
      expect(service.presentAs).toHaveBeenCalledTimes(1);
    });

    it('ADMIN altera o perfil de um membro: loja do ADMIN, perfil só da equipe', async () => {
      await request(server)
        .patch('/users/77')
        .set(as(ADMIN))
        .send({ role: 'COURIER' })
        .expect(200);
      // A senha atual é só da própria conta: nunca chega à edição da equipe
      expect(service.updateTeamMember).toHaveBeenCalledWith(
        77,
        STORE_A,
        { role: UserRole.COURIER, current_password: undefined },
        expect.objectContaining({ id: ADMIN.id }),
        expect.anything(),
        undefined,
      );

      await request(server)
        .patch('/users/77')
        .set(as(ADMIN))
        .send({ role: 'CLIENT' })
        .expect(400);
      expect(service.updateTeamMember).toHaveBeenCalledTimes(1);
    });

    it('ADMIN não altera o próprio perfil (400), mas pode reenviá-lo sem mudança', async () => {
      const res = await request(server)
        .patch(`/users/${ADMIN.id}`)
        .set(as(ADMIN))
        .send({ role: 'CLIENT' })
        .expect(400);
      expect(bodyOf(res).message).toContain('próprio perfil');
      expect(service.updateSelf).not.toHaveBeenCalled();

      await request(server)
        .patch(`/users/${ADMIN.id}`)
        .set(as(ADMIN))
        .send({ role: 'ADMIN', name: 'Admin' })
        .expect(200);
      const [, dto] = service.updateSelf.mock.calls[0] as [object, object];
      expect(dto).toEqual({ name: 'Admin', role: undefined });
    });

    it('DELETE /users/:id: própria conta ou equipe da própria loja; ADMIN não exclui a si mesmo', async () => {
      await request(server).delete('/users/77').set(as(ADMIN)).expect(200);
      expect(service.removeTeamMember).toHaveBeenCalledWith(
        77,
        STORE_A,
        expect.objectContaining({ id: ADMIN.id }),
        expect.anything(),
      );

      await request(server)
        .delete(`/users/${CLIENT.id}`)
        .set(as(CLIENT))
        .expect(200);
      expect(service.removeSelf).toHaveBeenCalledTimes(1);

      await request(server)
        .delete(`/users/${ADMIN.id}`)
        .set(as(ADMIN))
        .expect(400);
      await request(server).delete('/users/77').set(as(KITCHEN)).expect(403);
      await request(server)
        .delete(`/users/${ADMIN.id}/permanent`)
        .set(as(ADMIN))
        .expect(400);
      expect(service.purge).not.toHaveBeenCalled();
    });

    it('restaurar e excluir definitivamente usam a loja do ADMIN', async () => {
      await request(server)
        .patch('/users/3/restore')
        .set(as(ADMIN))
        .expect(200);
      await request(server)
        .delete('/users/3/permanent')
        .set(as(ADMIN))
        .expect(200);
      expect(service.restore).toHaveBeenCalledWith(
        3,
        STORE_A,
        expect.objectContaining({ id: ADMIN.id }),
        expect.anything(),
      );
      expect(service.purge).toHaveBeenCalledWith(
        3,
        STORE_A,
        expect.objectContaining({ id: ADMIN.id }),
        expect.anything(),
      );
    });

    it('sessão de suporte lê, mas não altera nada (403)', async () => {
      await request(server).get('/users').set(as(SUPPORT)).expect(200);
      await request(server)
        .patch('/users/77')
        .set(as(SUPPORT))
        .send({ name: 'X' })
        .expect(403);
      await request(server).delete('/users/77').set(as(SUPPORT)).expect(403);
      await request(server)
        .patch('/users/3/restore')
        .set(as(SUPPORT))
        .expect(403);
      expect(service.updateTeamMember).not.toHaveBeenCalled();
      expect(service.removeTeamMember).not.toHaveBeenCalled();
      expect(service.restore).not.toHaveBeenCalled();
    });
  });

  describe('troca da própria senha/e-mail', () => {
    it('resposta traz um access_token novo quando as sessões foram encerradas', async () => {
      service.updateSelf.mockResolvedValueOnce({
        user: { id: CLIENT.id, token_version: 1 },
        sessionsRevoked: true,
      });
      const res = await request(server)
        .patch(`/users/${CLIENT.id}`)
        .set(as(CLIENT))
        .send({ password: 'NovaSenha#2026' })
        .expect(200);
      expect(bodyOf(res).access_token).toBe('token-novo');
      expect(sessionTokens.issue).toHaveBeenCalledWith({
        id: CLIENT.id,
        token_version: 1,
      });
    });

    it('sem troca de credenciais, nenhum token novo', async () => {
      const res = await request(server)
        .patch(`/users/${CLIENT.id}`)
        .set(as(CLIENT))
        .send({ name: 'Nome' })
        .expect(200);
      expect(bodyOf(res).access_token).toBeUndefined();
      expect(sessionTokens.issue).not.toHaveBeenCalled();
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

      expect(service.updateSelf).toHaveBeenCalledTimes(3);
      for (const [, dto] of service.updateSelf.mock.calls as [
        object,
        object,
      ][]) {
        expect(dto).toEqual({ phone: null, role: undefined });
      }
    });

    it('PATCH com telefone válido grava; inválido → 400', async () => {
      await request(server)
        .patch(`/users/${CLIENT.id}`)
        .set(as(CLIENT))
        .send({ phone: ' 21988887777 ' })
        .expect(200);
      const [, dto] = service.updateSelf.mock.calls[0] as [object, object];
      expect(dto).toEqual({ phone: '21988887777', role: undefined });

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

      const [dto] = service.createClient.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(dto.phone).toBeUndefined();
    });
  });
});
