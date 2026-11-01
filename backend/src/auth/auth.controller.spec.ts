import {
  ExecutionContext,
  HttpException,
  HttpStatus,
  INestApplication,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { setupApp } from '../config/app-setup';
import { UserRole } from '../users/entities/user.entity';
import { AuthController } from './auth.controller';
import { AuthSessionsService } from './auth-sessions.service';
import { AuthService } from './auth.service';
import {
  FORGOT_PASSWORD_MESSAGE,
  PASSWORD_RESET_DONE_MESSAGE,
  PasswordResetService,
} from './password-reset.service';

const ME = { id: 7, role: UserRole.CLIENT, storeId: null };
const TOKEN = 'a'.repeat(43);

function userFrom(context: ExecutionContext) {
  const req = context
    .switchToHttp()
    .getRequest<{ headers: Record<string, string>; user?: unknown }>();
  const header = req.headers['x-test-user'];
  req.user = header ? (JSON.parse(header) as unknown) : null;
  return req.user;
}

describe('AuthController (HTTP)', () => {
  let app: INestApplication<App>;
  let server: App;
  const auth = {
    login: jest
      .fn()
      .mockResolvedValue({ access_token: 'jwt', user: { id: 7 } }),
    me: jest.fn().mockResolvedValue({ id: 7, support_session: null }),
    logoutAll: jest.fn().mockResolvedValue(undefined),
  };
  const passwordReset = {
    requestReset: jest.fn(),
    inspect: jest.fn().mockResolvedValue({
      email_masked: 'ma***@email.com',
      expires_at: '2026-10-11T00:00:00.000Z',
    }),
    reset: jest.fn().mockResolvedValue(undefined),
  };
  const sessions = {
    logout: jest.fn().mockResolvedValue(undefined),
    list: jest
      .fn()
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    revoke: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: PasswordResetService, useValue: passwordReset },
        { provide: AuthSessionsService, useValue: sessions },
      ],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({ canActivate: (ctx: ExecutionContext) => !!userFrom(ctx) })
      .compile();
    app = setupApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('POST /auth/login: { access_token, user } e o e-mail chega normalizado', async () => {
    const res = await request(server)
      .post('/auth/login')
      .send({ email: '  Maria@Email.COM ', password: 'Senha@12345' })
      .expect(201);
    expect(res.body).toEqual({ access_token: 'jwt', user: { id: 7 } });
    const [dto] = auth.login.mock.calls[0] as [{ email: string }];
    expect(dto.email).toBe('maria@email.com');
  });

  it('POST /auth/login com campo extra → 400', async () => {
    await request(server)
      .post('/auth/login')
      .send({ email: 'maria@email.com', password: 'x', store_id: 2 })
      .expect(400);
    expect(auth.login).not.toHaveBeenCalled();
  });

  it('GET /auth/me usa o usuário da sessão', async () => {
    await request(server)
      .get('/auth/me')
      .set('x-test-user', JSON.stringify(ME))
      .expect(200, { id: 7, support_session: null });
    expect(auth.me).toHaveBeenCalledWith(ME);
  });

  it('POST /auth/logout-all → 204 sem corpo', async () => {
    const res = await request(server)
      .post('/auth/logout-all')
      .set('x-test-user', JSON.stringify(ME))
      .expect(204);
    expect(res.text).toBe('');
    expect(auth.logoutAll).toHaveBeenCalledWith(ME, expect.anything());
  });

  describe('sessões da própria conta', () => {
    it('POST /auth/logout → 204 sem corpo; sem usuário → recusado pelo guard', async () => {
      const res = await request(server)
        .post('/auth/logout')
        .set('x-test-user', JSON.stringify(ME))
        .expect(204);
      expect(res.text).toBe('');
      expect(sessions.logout).toHaveBeenCalledWith(ME, expect.anything());

      await request(server).post('/auth/logout').expect(403);
      expect(sessions.logout).toHaveBeenCalledTimes(1);
    });

    it('GET /auth/sessions repassa a paginação validada', async () => {
      await request(server)
        .get('/auth/sessions?page=2&pageSize=5')
        .set('x-test-user', JSON.stringify(ME))
        .expect(200, { items: [], total: 0, page: 1, pageSize: 20 });
      expect(sessions.list).toHaveBeenCalledWith(
        ME,
        expect.objectContaining({ page: 2, pageSize: 5 }),
      );

      await request(server)
        .get('/auth/sessions?page=0')
        .set('x-test-user', JSON.stringify(ME))
        .expect(400);
    });

    it('DELETE /auth/sessions/:id → 204; id inválido → 400 sem chegar ao serviço', async () => {
      await request(server)
        .delete('/auth/sessions/12')
        .set('x-test-user', JSON.stringify(ME))
        .expect(204);
      expect(sessions.revoke).toHaveBeenCalledWith(ME, 12, expect.anything());

      await request(server)
        .delete('/auth/sessions/abc')
        .set('x-test-user', JSON.stringify(ME))
        .expect(400);
      expect(sessions.revoke).toHaveBeenCalledTimes(1);
    });
  });

  describe('esqueci a senha', () => {
    it('sempre 202 com a mesma mensagem (exista a conta ou não)', async () => {
      for (const email of ['existe@email.com', 'ninguem@email.com']) {
        const res = await request(server)
          .post('/auth/forgot-password')
          .send({ email })
          .expect(202);
        expect(res.body).toEqual({ message: FORGOT_PASSWORD_MESSAGE });
      }
      expect(passwordReset.requestReset).toHaveBeenCalledTimes(2);
    });

    it('e-mail inválido → 400; limite por IP → 429', async () => {
      await request(server)
        .post('/auth/forgot-password')
        .send({ email: 'sem-arroba' })
        .expect(400);
      passwordReset.requestReset.mockImplementationOnce(() => {
        throw new HttpException('Muitas', HttpStatus.TOO_MANY_REQUESTS);
      });
      await request(server)
        .post('/auth/forgot-password')
        .send({ email: 'x@email.com' })
        .expect(429);
    });
  });

  describe('redefinir a senha', () => {
    it('GET /auth/reset-password/:token confere o link', async () => {
      await request(server).get(`/auth/reset-password/${TOKEN}`).expect(200, {
        email_masked: 'ma***@email.com',
        expires_at: '2026-10-11T00:00:00.000Z',
      });
      expect(passwordReset.inspect).toHaveBeenCalledWith(
        TOKEN,
        expect.anything(),
      );
    });

    it('POST /auth/reset-password: mesma política de senha do cadastro', async () => {
      for (const password of [
        'fraca',
        'semmaiuscula1',
        `A1${'x'.repeat(71)}`,
      ]) {
        await request(server)
          .post('/auth/reset-password')
          .send({ token: TOKEN, password })
          .expect(400);
      }
      await request(server)
        .post('/auth/reset-password')
        .send({ password: 'NovaSenha#2026' })
        .expect(400);
      expect(passwordReset.reset).not.toHaveBeenCalled();

      await request(server)
        .post('/auth/reset-password')
        .send({ token: TOKEN, password: 'NovaSenha#2026' })
        .expect(200, { message: PASSWORD_RESET_DONE_MESSAGE });
      expect(passwordReset.reset).toHaveBeenCalledWith(
        TOKEN,
        'NovaSenha#2026',
        expect.anything(),
      );
    });
  });

  describe('sessão do site em cookie: logout e logout-all apagam o cookie só com o cabeçalho', () => {
    const WEB = 'http://web.test:5173';
    const saved = process.env.APP_WEB_URL;
    beforeAll(() => {
      process.env.APP_WEB_URL = WEB;
    });
    afterAll(() => {
      if (saved === undefined) delete process.env.APP_WEB_URL;
      else process.env.APP_WEB_URL = saved;
    });

    function cleared(res: request.Response): boolean {
      const raw: unknown = res.headers['set-cookie'];
      const list = Array.isArray(raw)
        ? raw.filter((line): line is string => typeof line === 'string')
        : typeof raw === 'string'
          ? [raw]
          : [];
      return list.some((cookie) =>
        /^comestra_rt=;.*Expires=Thu, 01 Jan 1970/.test(cookie),
      );
    }

    it.each(['/auth/logout', '/auth/logout-all'])(
      '%s: com X-Auth-Transport e a origem do site → 204 e cookie apagado; sem o cabeçalho → contrato de hoje, sem Set-Cookie',
      async (path) => {
        const withHeader = await request(server)
          .post(path)
          .set('x-test-user', JSON.stringify(ME))
          .set('X-Auth-Transport', 'cookie')
          .set('Origin', WEB)
          .expect(204);
        expect(cleared(withHeader)).toBe(true);

        const plain = await request(server)
          .post(path)
          .set('x-test-user', JSON.stringify(ME))
          .expect(204);
        expect(plain.headers['set-cookie']).toBeUndefined();

        const crossSite = await request(server)
          .post(path)
          .set('x-test-user', JSON.stringify(ME))
          .set('X-Auth-Transport', 'cookie')
          .set('Origin', WEB)
          .set('Sec-Fetch-Site', 'cross-site')
          .expect(204);
        expect(crossSite.headers['set-cookie']).toBeUndefined();
      },
    );

    it('logout de uma sessão de suporte nunca apaga o cookie (é da sessão do superadmin)', async () => {
      const support = {
        ...ME,
        supportSession: { id: 4, storeId: 1, expiresAt: new Date() },
      };
      const res = await request(server)
        .post('/auth/logout')
        .set('x-test-user', JSON.stringify(support))
        .set('X-Auth-Transport', 'cookie')
        .set('Origin', WEB)
        .expect(204);
      expect(res.headers['set-cookie']).toBeUndefined();
    });
  });
});
