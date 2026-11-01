import {
  ExecutionContext,
  INestApplication,
  RequestMethod,
  UnauthorizedException,
  type Type,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import type { AuthUser } from '../auth/auth-user';
import { setupApp } from '../config/app-setup';
import { PlatformAdminGuard } from '../tenancy/guards';
import { PlatformRole, UserRole } from '../users/entities/user.entity';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformInsightsController } from './platform-insights.controller';
import { PlatformInsightsService } from './platform-insights.service';
import { PlatformSettingsController } from './platform-settings.controller';
import { PlatformSettingsService } from './platform-settings.service';
import { PlatformStoresController } from './platform-stores.controller';
import { PlatformStoresService } from './platform-stores.service';
import { PlatformSupportSessionsController } from './platform-support-sessions.controller';
import { PlatformUsersController } from './platform-users.controller';
import { PlatformUsersService } from './platform-users.service';
import { StoreSignupController } from './store-signup.controller';
import { StoreSignupService } from './store-signup.service';
import { SupportSessionsService } from './support-sessions.service';

/** Controllers sob /platform: todos exigem superadmin fora de sessão de suporte. */
const PLATFORM_CONTROLLERS: Type<unknown>[] = [
  PlatformStoresController,
  PlatformSupportSessionsController,
  PlatformUsersController,
  PlatformInsightsController,
  PlatformSettingsController,
];

interface Route {
  method: RequestMethod;
  path: string;
  handler: string;
}

/** Rotas declaradas no controller (lidas dos metadados do Nest: nenhuma fica de fora do teste). */
function routesOf(controller: Type<unknown>): Route[] {
  const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
  const prototype = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== 'constructor')
    .flatMap((name) => {
      const handler = prototype[name] as object;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as
        | string
        | undefined;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as
        | RequestMethod
        | undefined;
      if (path === undefined || method === undefined) return [];
      return [
        {
          method,
          path: `/${base}/${path}`.replace(/:id/g, '1'),
          handler: name,
        },
      ];
    });
}

const SUPER_ADMIN: AuthUser = {
  id: 1,
  email: 'ops@comestra.com',
  role: UserRole.CLIENT,
  name: 'Ops',
  storeId: null,
  platformRole: PlatformRole.SUPER_ADMIN,
  supportSession: null,
};
const STORE_ADMIN: AuthUser = {
  id: 20,
  email: 'admin@loja.com',
  role: UserRole.ADMIN,
  name: 'Admin',
  storeId: 7,
  platformRole: null,
  supportSession: null,
};
const CLIENT: AuthUser = {
  id: 30,
  email: 'cliente@email.com',
  role: UserRole.CLIENT,
  name: 'Cliente',
  storeId: null,
  platformRole: null,
  supportSession: null,
};
/** Token de sessão de suporte como a JwtStrategy o entrega: ADMIN somente leitura da loja. */
const SUPPORT_SESSION: AuthUser = {
  ...SUPER_ADMIN,
  role: UserRole.ADMIN,
  storeId: 7,
  platformRole: null,
  supportSession: { id: 3, storeId: 7, expiresAt: new Date('2030-01-01') },
};
/** Defesa extra: mesmo com o papel global, um token com sessão de suporte não entra. */
const SUPER_ADMIN_WITH_SUPPORT: AuthUser = {
  ...SUPER_ADMIN,
  supportSession: { id: 4, storeId: 7, expiresAt: new Date('2030-01-01') },
};

function userFrom(context: ExecutionContext): AuthUser | null {
  const req = context
    .switchToHttp()
    .getRequest<{ headers: Record<string, string>; user?: unknown }>();
  const header = req.headers['x-test-user'];
  const parsed = header ? (JSON.parse(header) as AuthUser) : null;
  req.user = parsed;
  return parsed;
}

const as = (who: AuthUser) => ({ 'x-test-user': JSON.stringify(who) });

const resolved = () => jest.fn().mockResolvedValue({ ok: true });

describe('Superpainel (HTTP): /platform exige PlatformAdminGuard', () => {
  it('todo controller de /platform aplica AuthGuard("jwt") + PlatformAdminGuard na classe', () => {
    for (const controller of PLATFORM_CONTROLLERS) {
      expect(Reflect.getMetadata(PATH_METADATA, controller)).toBe('platform');
      const guards = Reflect.getMetadata(GUARDS_METADATA, controller) as
        | unknown[]
        | undefined;
      expect(guards).toEqual([AuthGuard('jwt'), PlatformAdminGuard]);
      expect(routesOf(controller).length).toBeGreaterThan(0);
    }
  });

  it('o autoatendimento é a única rota pública do módulo (POST /stores/signup)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, StoreSignupController)).toBe(
      'stores',
    );
    expect(
      Reflect.getMetadata(GUARDS_METADATA, StoreSignupController),
    ).toBeUndefined();
    expect(routesOf(StoreSignupController)).toEqual([
      { method: RequestMethod.POST, path: '/stores/signup', handler: 'signup' },
    ]);
  });

  describe('com a aplicação', () => {
    let app: INestApplication<App>;
    let server: App;

    const stores = {
      list: resolved(),
      create: resolved(),
      detail: resolved(),
      update: resolved(),
      changeStatus: resolved(),
      team: resolved(),
      metrics: resolved(),
      assertExists: jest.fn().mockResolvedValue(undefined),
      listInvitations: resolved(),
      createInvitation: resolved(),
      revokeInvitation: resolved(),
    };
    const auditLogs = { list: resolved(), authEvents: resolved() };
    const sessions = { start: resolved(), list: resolved(), end: resolved() };
    const users = {
      list: resolved(),
      detail: resolved(),
      block: resolved(),
      unblock: resolved(),
      revokeSessions: resolved(),
      passwordResetLink: resolved(),
    };
    const insights = { dashboard: resolved(), finance: resolved() };
    const settings = {
      get: resolved(),
      update: resolved(),
      sendTestEmail: resolved(),
    };
    const signup = {
      signup: jest
        .fn()
        .mockResolvedValue({ access_token: 'token', user: { id: 99 } }),
    };

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [...PLATFORM_CONTROLLERS, StoreSignupController],
        providers: [
          { provide: PlatformStoresService, useValue: stores },
          { provide: PlatformAuditService, useValue: auditLogs },
          { provide: SupportSessionsService, useValue: sessions },
          { provide: PlatformUsersService, useValue: users },
          { provide: PlatformInsightsService, useValue: insights },
          { provide: PlatformSettingsService, useValue: settings },
          { provide: StoreSignupService, useValue: signup },
        ],
      })
        .overrideGuard(AuthGuard('jwt'))
        .useValue({
          canActivate: (ctx: ExecutionContext) => {
            if (!userFrom(ctx)) {
              throw new UnauthorizedException(
                'Sessão inválida ou expirada. Faça login novamente.',
              );
            }
            return true;
          },
        })
        .compile();

      app = setupApp(moduleRef.createNestApplication());
      await app.init();
      server = app.getHttpServer();
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(() => jest.clearAllMocks());

    const ROUTES = PLATFORM_CONTROLLERS.flatMap(routesOf);
    const call = (route: Route) => {
      const agent = request(server);
      switch (route.method) {
        case RequestMethod.GET:
          return agent.get(route.path);
        case RequestMethod.POST:
          return agent.post(route.path);
        case RequestMethod.PATCH:
          return agent.patch(route.path);
        case RequestMethod.DELETE:
          return agent.delete(route.path);
        case RequestMethod.PUT:
          return agent.put(route.path);
        default:
          throw new Error(`Método não coberto pelo teste: ${route.method}`);
      }
    };

    it('cobre todas as rotas do superpainel deste módulo', () => {
      const paths = ROUTES.map(
        (route) => `${RequestMethod[route.method]} ${route.path}`,
      );
      expect(paths).toEqual(
        expect.arrayContaining([
          'GET /platform/stores',
          'POST /platform/stores',
          'GET /platform/stores/1',
          'PATCH /platform/stores/1',
          'POST /platform/stores/1/suspend',
          'POST /platform/stores/1/reactivate',
          'POST /platform/stores/1/deactivate',
          'POST /platform/stores/1/restore',
          'GET /platform/stores/1/users',
          'GET /platform/stores/1/metrics',
          'GET /platform/stores/1/audit',
          'GET /platform/stores/1/invitations',
          'POST /platform/stores/1/invitations',
          'DELETE /platform/invitations/1',
          'POST /platform/stores/1/support-sessions',
          'GET /platform/support-sessions',
          'POST /platform/support-sessions/1/end',
          'GET /platform/users',
          'GET /platform/users/1',
          'POST /platform/users/1/block',
          'POST /platform/users/1/unblock',
          'POST /platform/users/1/revoke-sessions',
          'POST /platform/users/1/password-reset',
          'GET /platform/auth-events',
          'GET /platform/dashboard',
          'GET /platform/finance',
          'GET /platform/audit',
          'GET /platform/settings',
          'PATCH /platform/settings',
          'POST /platform/settings/test-email',
        ]),
      );
      expect(paths).toHaveLength(30);
    });

    it('anônimo → 401 em todas as rotas', async () => {
      for (const route of ROUTES) {
        const res = await call(route);
        expect([route.path, res.status]).toEqual([route.path, 401]);
      }
    });

    it('equipe de loja, cliente e sessão de suporte → 403 em todas as rotas (nenhum serviço é chamado)', async () => {
      for (const who of [
        STORE_ADMIN,
        CLIENT,
        SUPPORT_SESSION,
        SUPER_ADMIN_WITH_SUPPORT,
      ]) {
        for (const route of ROUTES) {
          const res = await call(route).set(as(who));
          expect([route.path, who.email, res.status]).toEqual([
            route.path,
            who.email,
            403,
          ]);
          expect(JSON.stringify(res.body)).toContain(
            'Área exclusiva da administração da plataforma.',
          );
        }
      }
      for (const service of [
        stores,
        auditLogs,
        sessions,
        users,
        insights,
        settings,
      ]) {
        for (const fn of Object.values(service)) {
          expect(fn).not.toHaveBeenCalled();
        }
      }
    });

    it('superadmin passa pelos guards em todas as rotas', async () => {
      for (const route of ROUTES) {
        const res = await call(route).set(as(SUPER_ADMIN));
        // Sem corpo, algumas rotas respondem 400 (validação) — nunca 401/403
        expect([route.path, [401, 403].includes(res.status)]).toEqual([
          route.path,
          false,
        ]);
      }
    });

    it('a loja-alvo vem da rota: store_id na query ou no corpo é recusado', async () => {
      const audit = await request(server)
        .get('/platform/stores/5/audit?store_id=9')
        .set(as(SUPER_ADMIN))
        .expect(400);
      expect(JSON.stringify(audit.body)).toContain(
        'property store_id should not exist',
      );
      await request(server)
        .patch('/platform/stores/5')
        .set(as(SUPER_ADMIN))
        .send({ account_status: 'INACTIVE' })
        .expect(400);
      expect(stores.update).not.toHaveBeenCalled();

      await request(server)
        .get('/platform/stores/5/audit?action=platform.store')
        .set(as(SUPER_ADMIN))
        .expect(200);
      expect(stores.assertExists).toHaveBeenCalledWith(5);
      expect(auditLogs.list).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'platform.store' }),
        { storeId: 5 },
      );
    });

    it('situação da loja: motivo obrigatório para suspender; ação certa no serviço', async () => {
      await request(server)
        .post('/platform/stores/5/suspend')
        .set(as(SUPER_ADMIN))
        .send({})
        .expect(400);
      await request(server)
        .post('/platform/stores/5/suspend')
        .set(as(SUPER_ADMIN))
        .send({ reason: ' Inadimplência ' })
        .expect(200);
      expect(stores.changeStatus).toHaveBeenCalledWith(
        5,
        'suspend',
        'Inadimplência',
        expect.objectContaining({ id: SUPER_ADMIN.id }),
        expect.anything(),
      );
      await request(server)
        .post('/platform/stores/5/restore')
        .set(as(SUPER_ADMIN))
        .expect(200);
      expect(stores.changeStatus).toHaveBeenLastCalledWith(
        5,
        'restore',
        undefined,
        expect.objectContaining({ id: SUPER_ADMIN.id }),
        expect.anything(),
      );
    });

    it('sessão de suporte e bloqueio repassam o operador autenticado', async () => {
      await request(server)
        .post('/platform/stores/5/support-sessions')
        .set(as(SUPER_ADMIN))
        .send({ reason: 'Chamado 42: conferir o cardápio' })
        .expect(201);
      expect(sessions.start).toHaveBeenCalledWith(
        5,
        'Chamado 42: conferir o cardápio',
        expect.objectContaining({ id: SUPER_ADMIN.id }),
        expect.anything(),
      );
      await request(server)
        .post('/platform/users/9/block')
        .set(as(SUPER_ADMIN))
        .send({ reason: 'Conta comprometida' })
        .expect(200);
      expect(users.block).toHaveBeenCalledWith(
        9,
        'Conta comprometida',
        expect.objectContaining({ id: SUPER_ADMIN.id }),
        expect.anything(),
      );
    });

    it('POST /stores/signup é público (sem token) e valida o corpo', async () => {
      const body = {
        store: { name: 'Pizzaria', slug: 'pizzaria-nova' },
        owner: {
          name: 'Ana',
          email: 'ana@pizzaria.com',
          password: 'SenhaForte1',
        },
        accept_terms: true,
      };
      const res = await request(server)
        .post('/stores/signup')
        .send(body)
        .expect(201);
      expect(res.body).toEqual({ access_token: 'token', user: { id: 99 } });
      expect(signup.signup).toHaveBeenCalledTimes(1);

      await request(server)
        .post('/stores/signup')
        .send({ ...body, accept_terms: false })
        .expect(400);
      expect(signup.signup).toHaveBeenCalledTimes(1);
    });
  });
});
