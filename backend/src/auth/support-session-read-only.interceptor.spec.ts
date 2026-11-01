import {
  CanActivate,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  INestApplication,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { setupApp } from '../config/app-setup';
import { UserRole } from '../users/entities/user.entity';
import { SUPPORT_READ_ONLY_MESSAGE } from '../users/users.policy';
import type { AuthUser } from './auth-user';
import {
  AllowedInSupportSession,
  SupportSessionReadOnlyInterceptor,
} from './support-session-read-only.interceptor';

const SUPPORT: AuthUser = {
  id: 90,
  email: 'ops@comestra.com.br',
  name: 'Ops',
  role: UserRole.ADMIN,
  storeId: 3,
  platformRole: null,
  supportSession: {
    id: 7,
    storeId: 3,
    expiresAt: new Date(Date.now() + 60_000),
  },
};
const CLIENT: AuthUser = {
  id: 5,
  email: 'cliente@email.com',
  name: 'Cliente',
  role: UserRole.CLIENT,
  storeId: null,
  platformRole: null,
  supportSession: null,
};

/** Como a JwtStrategy: req.user a partir do cabeçalho (aqui, o nome da conta de teste). */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string>;
      user?: AuthUser | null;
    }>();
    const who = req.headers['x-test-user'];
    req.user = who === 'support' ? SUPPORT : who === 'client' ? CLIENT : null;
    return true;
  }
}

const handled: string[] = [];

@Controller('qualquer')
@UseGuards(FakeAuthGuard)
class AnyController {
  @Get()
  read() {
    handled.push('GET');
    return { ok: true };
  }
  @Post()
  create() {
    handled.push('POST');
    return { ok: true };
  }
  @Patch()
  update() {
    handled.push('PATCH');
    return { ok: true };
  }
  @Put()
  replace() {
    handled.push('PUT');
    return { ok: true };
  }
  @Delete()
  remove() {
    handled.push('DELETE');
    return { ok: true };
  }
}

/** Como o POST /auth/logout: sair da própria sessão vale com o token de suporte. */
@Controller('sair')
@UseGuards(FakeAuthGuard)
class LogoutController {
  @Post()
  @AllowedInSupportSession()
  logout() {
    handled.push('LOGOUT');
    return { ok: true };
  }
}

describe('SupportSessionReadOnlyInterceptor (global)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AnyController, LogoutController],
      providers: [
        {
          provide: APP_INTERCEPTOR,
          useClass: SupportSessionReadOnlyInterceptor,
        },
      ],
    }).compile();
    app = setupApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => (handled.length = 0));

  it('token de suporte: toda escrita → 403 com a mensagem de somente leitura (o handler nem roda)', async () => {
    const server = app.getHttpServer();
    for (const method of ['post', 'patch', 'put', 'delete'] as const) {
      const res = await request(server)
        [method]('/qualquer')
        .set('x-test-user', 'support')
        .send({ campo: 1 })
        .expect(403);
      expect(res.body).toMatchObject({
        statusCode: 403,
        message: SUPPORT_READ_ONLY_MESSAGE,
      });
    }
    expect(handled).toEqual([]);
  });

  it('token de suporte lê (GET); outras contas e anônimos escrevem normalmente', async () => {
    const server = app.getHttpServer();
    await request(server)
      .get('/qualquer')
      .set('x-test-user', 'support')
      .expect(200);
    await request(server)
      .post('/qualquer')
      .set('x-test-user', 'client')
      .expect(201);
    await request(server).post('/qualquer').expect(201);
    expect(handled).toEqual(['GET', 'POST', 'POST']);
  });

  it('rota marcada com @AllowedInSupportSession (logout da própria sessão) aceita o token de suporte', async () => {
    const server = app.getHttpServer();
    await request(server)
      .post('/sair')
      .set('x-test-user', 'support')
      .expect(201);
    expect(handled).toEqual(['LOGOUT']);
  });
});
