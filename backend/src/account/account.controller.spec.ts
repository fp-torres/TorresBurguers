import {
  ExecutionContext,
  HttpStatus,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { SupportSessionReadOnlyInterceptor } from '../auth/support-session-read-only.interceptor';
import { setupApp } from '../config/app-setup';
import { UserRole } from '../users/entities/user.entity';
import { AccountSecurityService } from './account-security.service';
import { AccountController } from './account.controller';

const ME = { id: 7, role: UserRole.CLIENT, storeId: null, platformRole: null };
const SUPPORT = {
  ...ME,
  supportSession: { id: 3, storeId: 1, expiresAt: '2030-01-01T00:00:00Z' },
};
const TOKEN = 'a'.repeat(43);

function userFrom(context: ExecutionContext) {
  const req = context
    .switchToHttp()
    .getRequest<{ headers: Record<string, string>; user?: unknown }>();
  const header = req.headers['x-test-user'];
  req.user = header ? (JSON.parse(header) as unknown) : null;
  return req.user;
}

describe('AccountController (HTTP)', () => {
  let app: INestApplication<App>;
  let server: App;
  const account = {
    view: jest.fn().mockResolvedValue({ email: 'eu@email.com' }),
    changePassword: jest
      .fn()
      .mockResolvedValue({ access_token: 'jwt', user: { id: 7 } }),
    requestEmailChange: jest.fn().mockResolvedValue({
      message: 'ok',
      email_change: { email: 'novo@email.com' },
    }),
    cancelEmailChange: jest.fn().mockResolvedValue(undefined),
    inspectEmailChange: jest.fn().mockResolvedValue({}),
    confirmEmailChange: jest.fn().mockResolvedValue({ message: 'ok' }),
    inspectRevert: jest.fn().mockResolvedValue({}),
    revertEmailChange: jest.fn().mockResolvedValue({ message: 'ok' }),
    requestVerification: jest.fn().mockResolvedValue({
      status: HttpStatus.ACCEPTED,
      body: { message: 'enviado' },
    }),
    inspectVerification: jest.fn().mockResolvedValue({}),
    confirmVerification: jest.fn().mockResolvedValue({ message: 'ok' }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AccountController],
      providers: [
        { provide: AccountSecurityService, useValue: account },
        // Sessão de suporte somente leitura (global no AuthModule)
        {
          provide: APP_INTERCEPTOR,
          useClass: SupportSessionReadOnlyInterceptor,
        },
      ],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({
        // Como a JwtStrategy: sem token válido → 401
        canActivate: (ctx: ExecutionContext) => {
          if (!userFrom(ctx)) throw new UnauthorizedException();
          return true;
        },
      })
      .compile();
    app = setupApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  const as = (user: object) => ({ 'x-test-user': JSON.stringify(user) });

  it('rotas da própria conta exigem token (401) e não chamam o serviço', async () => {
    await request(server).get('/account/security').expect(401);
    await request(server).post('/account/password').send({}).expect(401);
    await request(server).post('/account/email-change').send({}).expect(401);
    await request(server).delete('/account/email-change').expect(401);
    await request(server).post('/account/email-verification').expect(401);
    expect(account.view).not.toHaveBeenCalled();
  });

  it('códigos de resposta: 200 (security, password), 202 (email-change), 204 (cancelar), 202/200 (verificação)', async () => {
    await request(server).get('/account/security').set(as(ME)).expect(200);
    await request(server)
      .post('/account/password')
      .set(as(ME))
      .send({ current_password: 'Atual#2026x', password: 'NovaSenha#2026' })
      .expect(200, { access_token: 'jwt', user: { id: 7 } });
    await request(server)
      .post('/account/email-change')
      .set(as(ME))
      .send({ email: ' Novo@Email.COM ', current_password: 'Atual#2026x' })
      .expect(202);
    expect(account.requestEmailChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      { email: 'novo@email.com', current_password: 'Atual#2026x' },
      expect.anything(),
    );
    await request(server)
      .delete('/account/email-change')
      .set(as(ME))
      .expect(204);
    await request(server)
      .post('/account/email-verification')
      .set(as(ME))
      .expect(202, { message: 'enviado' });
    account.requestVerification.mockResolvedValueOnce({
      status: HttpStatus.OK,
      body: { message: 'já', email_verified: true },
    });
    await request(server)
      .post('/account/email-verification')
      .set(as(ME))
      .expect(200, { message: 'já', email_verified: true });
  });

  it('DTOs com whitelist: campos extras, e-mail inválido, senha fora da regra ou sem a senha atual → 400', async () => {
    const cases: Array<[string, object]> = [
      [
        '/account/password',
        { current_password: 'x', password: 'NovaSenha#2026', role: 'ADMIN' },
      ],
      ['/account/password', { current_password: 'x', password: 'fraca' }],
      ['/account/password', { password: 'NovaSenha#2026' }],
      [
        '/account/email-change',
        { email: 'nao-e-email', current_password: 'x' },
      ],
      ['/account/email-change', { email: 'novo@email.com' }],
      ['/account/email-change/confirm', {}],
      ['/account/email-change/confirm', { token: TOKEN, extra: true }],
      ['/account/email-revert', { token: TOKEN, password: 'fraca' }],
      ['/account/email-verification/confirm', { token: 123 }],
    ];
    for (const [path, body] of cases) {
      await request(server).post(path).set(as(ME)).send(body).expect(400);
    }
    expect(account.changePassword).not.toHaveBeenCalled();
    expect(account.requestEmailChange).not.toHaveBeenCalled();
    expect(account.confirmEmailChange).not.toHaveBeenCalled();
    expect(account.revertEmailChange).not.toHaveBeenCalled();
  });

  it('sessão de suporte: lê GET /account/security; as ações → 403 sem chamar o serviço', async () => {
    await request(server).get('/account/security').set(as(SUPPORT)).expect(200);
    await request(server)
      .post('/account/password')
      .set(as(SUPPORT))
      .send({ current_password: 'Atual#2026x', password: 'NovaSenha#2026' })
      .expect(403);
    await request(server)
      .post('/account/email-change')
      .set(as(SUPPORT))
      .send({ email: 'novo@email.com', current_password: 'x' })
      .expect(403);
    await request(server)
      .delete('/account/email-change')
      .set(as(SUPPORT))
      .expect(403);
    await request(server)
      .post('/account/email-verification')
      .set(as(SUPPORT))
      .expect(403);
    expect(account.changePassword).not.toHaveBeenCalled();
    expect(account.requestEmailChange).not.toHaveBeenCalled();
    expect(account.cancelEmailChange).not.toHaveBeenCalled();
    expect(account.requestVerification).not.toHaveBeenCalled();
  });

  it('links públicos: GET só confere; POST com o código no corpo (o código nunca vai na URL do POST)', async () => {
    await request(server).get(`/account/email-change/${TOKEN}`).expect(200);
    expect(account.inspectEmailChange).toHaveBeenCalledWith(
      TOKEN,
      expect.anything(),
    );
    await request(server)
      .post('/account/email-change/confirm')
      .send({ token: TOKEN })
      .expect(200);
    expect(account.confirmEmailChange).toHaveBeenCalledWith(
      TOKEN,
      expect.anything(),
    );
    await request(server).get(`/account/email-revert/${TOKEN}`).expect(200);
    await request(server)
      .post('/account/email-revert')
      .send({ token: TOKEN, password: 'NovaSenha#2026' })
      .expect(200);
    expect(account.revertEmailChange).toHaveBeenCalledWith(
      TOKEN,
      'NovaSenha#2026',
      expect.anything(),
    );
    await request(server)
      .get(`/account/email-verification/${TOKEN}`)
      .expect(200);
    await request(server)
      .post('/account/email-verification/confirm')
      .send({ token: TOKEN })
      .expect(200);
    expect(account.confirmVerification).toHaveBeenCalledWith(
      TOKEN,
      expect.anything(),
    );
  });
});
