import {
  ExecutionContext,
  ForbiddenException,
  HttpException,
  INestApplication,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { PlanLimitsService } from '../billing/plan-limits.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { setupApp } from '../config/app-setup';
import { StoreStaffGuard } from '../tenancy/guards';
import { UserRole } from '../users/entities/user.entity';
import {
  InvitationsController,
  StoreInvitationsController,
} from './invitations.controller';
import { InvitationsService } from './invitations.service';

const STORE_A = 1;
const ADMIN_A = { id: 1, role: UserRole.ADMIN, storeId: STORE_A };
const KITCHEN_A = { id: 2, role: UserRole.KITCHEN, storeId: STORE_A };
const TOKEN = 'b'.repeat(43);

function userFrom(context: ExecutionContext) {
  const req = context
    .switchToHttp()
    .getRequest<{ headers: Record<string, string>; user?: unknown }>();
  const header = req.headers['x-test-user'];
  req.user = header ? (JSON.parse(header) as unknown) : null;
  return req.user;
}

const as = (user: object) => ({ 'x-test-user': JSON.stringify(user) });

describe('Convites (HTTP)', () => {
  let app: INestApplication<App>;
  let server: App;
  const invitations = {
    create: jest
      .fn()
      .mockResolvedValue({ invitation: { id: 1 }, url: 'https://x/convite/t' }),
    listByStore: jest
      .fn()
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    revoke: jest.fn().mockResolvedValue({ id: 1, status: 'REVOKED' }),
    inspect: jest.fn().mockResolvedValue({ role: 'KITCHEN' }),
    accept: jest
      .fn()
      .mockResolvedValue({ access_token: 'jwt', user: { id: 9 } }),
  };
  const planLimits = {
    assertWithinLimit: jest.fn().mockResolvedValue(undefined),
  };
  const rateLimit = { consume: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InvitationsController, StoreInvitationsController],
      providers: [
        { provide: InvitationsService, useValue: invitations },
        { provide: PlanLimitsService, useValue: planLimits },
        { provide: RateLimitService, useValue: rateLimit },
      ],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({ canActivate: (ctx: ExecutionContext) => !!userFrom(ctx) })
      .overrideGuard(StoreStaffGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest<{
            user: { storeId: number | null } | null;
            tenant?: unknown;
          }>();
          if (!req.user?.storeId) throw new ForbiddenException();
          req.tenant = { storeId: req.user.storeId };
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

  describe('loja (ADMIN)', () => {
    it('POST /store/invitations: loja do ADMIN, nunca make_owner, plano conferido antes', async () => {
      const res = await request(server)
        .post('/store/invitations')
        .set(as(ADMIN_A))
        .send({ email: ' Nova@Email.com ', role: 'EMPLOYEE' })
        .expect(201);
      expect(res.body).toEqual({
        invitation: { id: 1 },
        url: 'https://x/convite/t',
      });
      expect(planLimits.assertWithinLimit).toHaveBeenCalledWith(
        STORE_A,
        'staff_users',
      );
      expect(invitations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: STORE_A,
          email: 'nova@email.com',
          role: UserRole.EMPLOYEE,
          makeOwner: false,
          invitedBy: expect.objectContaining({ id: ADMIN_A.id }) as unknown,
        }),
      );

      // Convite criado sem e-mail (teto do destinatário): o aviso acompanha o link (aditivo); delivered fica de fora
      invitations.create.mockResolvedValueOnce({
        invitation: { id: 2 },
        url: 'https://x/convite/u',
        delivered: false,
        message: 'O convite foi criado, mas o e-mail não foi enviado agora.',
      });
      const skipped = await request(server)
        .post('/store/invitations')
        .set(as(ADMIN_A))
        .send({ email: 'outra@email.com', role: 'EMPLOYEE' })
        .expect(201);
      expect(skipped.body).toEqual({
        invitation: { id: 2 },
        url: 'https://x/convite/u',
        message: 'O convite foi criado, mas o e-mail não foi enviado agora.',
      });
    });

    it('POST /store/invitations conta no limite TEAM_WRITE da loja; no limite → 429 e nada é criado', async () => {
      await request(server)
        .post('/store/invitations')
        .set(as(ADMIN_A))
        .send({ email: 'limite@email.com', role: 'EMPLOYEE' })
        .expect(201);
      expect(rateLimit.consume).toHaveBeenCalledWith(
        'TEAM_WRITE',
        `store:${STORE_A}`,
      );
      rateLimit.consume.mockImplementationOnce(() => {
        throw new HttpException('Muitas tentativas', 429);
      });
      invitations.create.mockClear();
      await request(server)
        .post('/store/invitations')
        .set(as(ADMIN_A))
        .send({ email: 'limite2@email.com', role: 'EMPLOYEE' })
        .expect(429);
      expect(invitations.create).not.toHaveBeenCalled();
    });

    it('perfil de cliente, make_owner ou store_id no corpo → 400', async () => {
      for (const body of [
        { email: 'x@email.com', role: 'CLIENT' },
        { email: 'x@email.com', role: 'KITCHEN', make_owner: true },
        { email: 'x@email.com', role: 'KITCHEN', store_id: 2 },
      ]) {
        await request(server)
          .post('/store/invitations')
          .set(as(ADMIN_A))
          .send(body)
          .expect(400);
      }
      expect(invitations.create).not.toHaveBeenCalled();
    });

    it('GET /store/invitations: paginação validada e loja do ADMIN', async () => {
      await request(server)
        .get('/store/invitations?page=2&pageSize=10&status=PENDING')
        .set(as(ADMIN_A))
        .expect(200);
      expect(invitations.listByStore).toHaveBeenCalledWith(
        STORE_A,
        { page: 2, pageSize: 10, status: 'PENDING' },
        { hidePlatformInviters: true },
      );

      for (const query of [
        'pageSize=500',
        'page=0',
        'status=QUALQUER',
        'storeId=2',
      ]) {
        await request(server)
          .get(`/store/invitations?${query}`)
          .set(as(ADMIN_A))
          .expect(400);
      }
    });

    it('DELETE /store/invitations/:id usa a loja do ADMIN', async () => {
      await request(server)
        .delete('/store/invitations/5')
        .set(as(ADMIN_A))
        .expect(200);
      expect(invitations.revoke).toHaveBeenCalledWith(
        5,
        STORE_A,
        expect.objectContaining({ id: ADMIN_A.id }),
        expect.anything(),
      );
    });

    it('equipe que não é ADMIN → 403', async () => {
      await request(server)
        .get('/store/invitations')
        .set(as(KITCHEN_A))
        .expect(403);
      await request(server)
        .post('/store/invitations')
        .set(as(KITCHEN_A))
        .send({ email: 'x@email.com', role: 'KITCHEN' })
        .expect(403);
      expect(invitations.listByStore).not.toHaveBeenCalled();
      expect(invitations.create).not.toHaveBeenCalled();
    });
  });

  describe('público (link do convite)', () => {
    it('GET /invitations/:token', async () => {
      await request(server).get(`/invitations/${TOKEN}`).expect(200);
      expect(invitations.inspect).toHaveBeenCalledWith(
        TOKEN,
        expect.anything(),
      );
    });

    it('POST /invitations/:token/accept: só nome, senha e telefone (perfil, e-mail e loja vêm do convite)', async () => {
      for (const extra of [
        { role: 'ADMIN' },
        { email: 'outro@email.com' },
        { store_id: 2 },
      ]) {
        await request(server)
          .post(`/invitations/${TOKEN}/accept`)
          .send({ name: 'Pessoa', password: 'SenhaForte@123', ...extra })
          .expect(400);
      }
      await request(server)
        .post(`/invitations/${TOKEN}/accept`)
        .send({ name: 'Pessoa', password: 'fraca' })
        .expect(400);
      expect(invitations.accept).not.toHaveBeenCalled();

      const res = await request(server)
        .post(`/invitations/${TOKEN}/accept`)
        .send({ name: ' Pessoa ', password: 'SenhaForte@123', phone: '' })
        .expect(201);
      expect(res.body).toEqual({ access_token: 'jwt', user: { id: 9 } });
      const [token, dto] = invitations.accept.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(token).toBe(TOKEN);
      expect(dto).toEqual({ name: 'Pessoa', password: 'SenhaForte@123' });
    });
  });
});
