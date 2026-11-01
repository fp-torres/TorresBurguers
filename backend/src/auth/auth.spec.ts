import {
  ForbiddenException,
  HttpException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import type { Request } from 'express';
import { IsNull, Repository } from 'typeorm';
import type { AuditService } from '../audit/audit.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { SupportSession } from '../platform/entities/support-session.entity';
import { StoreAccountStatus } from '../store/entities/store.entity';
import { PlatformRole, User, UserRole } from '../users/entities/user.entity';
import type { SessionStore } from '../users/session-user';
import { UsersService } from '../users/users.service';
import type { AuthUser } from './auth-user';
import {
  AuthService,
  INACTIVE_STORE_LOGIN_MESSAGE,
  INVALID_CREDENTIALS_MESSAGE,
} from './auth.service';
import type { AuthSessionsService } from './auth-sessions.service';
import { AuthSession, AuthSessionKind } from './entities/auth-session.entity';
import {
  BLOCKED_ACCOUNT_MESSAGE,
  INVALID_SESSION_MESSAGE,
  JwtStrategy,
  SUPPORT_SESSION_ENDED_MESSAGE,
} from './jwt.strategy';
import type { LoginTiming } from './login-timing';
import { SessionTokenService } from './session-token.service';

// bcrypt.compare espionado (mantém o comportamento real) para conferir o hash fictício
jest.mock('bcrypt', () => {
  const actual = jest.requireActual<typeof import('bcrypt')>('bcrypt');
  return {
    ...actual,
    compare: jest.fn((data: string, hash: string) =>
      actual.compare(data, hash),
    ),
  };
});

const SECRET = 'segredo-de-teste';
const PASSWORD = 'Senha@12345';
const STORE: SessionStore = {
  id: 3,
  slug: 'loja-a',
  name: 'Loja A',
  logo: null,
  primary_color: '#123456',
  account_status: StoreAccountStatus.ACTIVE,
};

function makeUser(overrides: Partial<User> = {}): User {
  return Object.assign(new User(), {
    id: 7,
    name: 'Maria Silva',
    email: 'maria@email.com',
    phone: null,
    avatar: null,
    role: UserRole.CLIENT,
    store_id: null,
    platform_role: null,
    blocked_at: null,
    blocked_reason: null,
    token_version: 0,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  });
}

/** Requisição falsa com IP próprio (os limites são por IP). */
const fromIp = (ip: string) =>
  ({ ip, headers: { 'user-agent': 'jest' } }) as unknown as Request;

describe('AuthService', () => {
  let hash: string;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    hash = await bcrypt.hash(PASSWORD, 4);
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.RATE_LIMIT_ENABLED = 'true';
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('RATE_LIMIT_') && key !== 'RATE_LIMIT_ENABLED') {
        delete process.env[key];
      }
    }
    (bcrypt.compare as jest.Mock).mockClear();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function setup(candidates: User[], store: SessionStore | null = null) {
    const users = {
      findForLogin: jest.fn().mockResolvedValue(candidates),
      storeSummary: jest.fn().mockResolvedValue(store),
      recordLogin: jest.fn().mockResolvedValue(undefined),
      findActiveById: jest.fn(),
      presentAs: jest.fn(),
      revokeSessions: jest.fn().mockResolvedValue(undefined),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const rateLimit = new RateLimitService();
    const jwt = new JwtService({
      secret: SECRET,
      signOptions: { expiresIn: '7d' },
    });
    const authSessions = {
      revokeAll: jest.fn().mockResolvedValue(2),
      isKnownOrigin: jest.fn().mockResolvedValue(false),
    };
    const service = new AuthService(
      users as unknown as UsersService,
      new SessionTokenService(jwt),
      rateLimit,
      audit as unknown as AuditService,
      authSessions as unknown as AuthSessionsService,
    );
    return { service, users, audit, rateLimit, jwt, authSessions };
  }

  describe('validateUser', () => {
    it('aceita a senha certa; senha errada → null', async () => {
      const { service, users } = setup([makeUser({ password_hash: hash })]);
      await expect(
        service.validateUser('maria@email.com', PASSWORD),
      ).resolves.toMatchObject({ id: 7 });
      await expect(
        service.validateUser('maria@email.com', 'Errada@12345'),
      ).resolves.toBeNull();
      expect(users.findForLogin).toHaveBeenCalledWith('maria@email.com');
    });

    it('e-mail inexistente: compara com um hash fictício de custo 10 (tempo constante)', async () => {
      const { service } = setup([]);
      await expect(
        service.validateUser('nada@email.com', PASSWORD),
      ).resolves.toBeNull();

      const compare = bcrypt.compare as jest.Mock;
      expect(compare).toHaveBeenCalledTimes(1);
      const [, dummy] = compare.mock.calls[0] as [string, string];
      expect(bcrypt.getRounds(dummy)).toBe(10);
    });

    it('contas antigas que diferem só em maiúsculas: a senha decide qual entra', async () => {
      const otherHash = await bcrypt.hash('Outra@12345', 4);
      const { service } = setup([
        makeUser({ id: 1, email: 'Maria@Email.com', password_hash: otherHash }),
        makeUser({ id: 2, email: 'maria@email.com', password_hash: hash }),
      ]);
      const user = await service.validateUser('MARIA@email.com', PASSWORD);
      expect(user?.id).toBe(2);
    });
  });

  describe('login', () => {
    it('sucesso: { access_token, user: SessionUser } com tv, último acesso e auditoria', async () => {
      const staff = makeUser({
        password_hash: hash,
        role: UserRole.ADMIN,
        store_id: STORE.id,
        token_version: 3,
      });
      const { service, users, audit, jwt } = setup([staff], STORE);

      const result = await service.login(
        { email: ' Maria@Email.com ', password: PASSWORD },
        fromIp('10.0.0.1'),
      );

      expect(Object.keys(result).sort()).toEqual(['access_token', 'user']);
      const payload = jwt.verify<Record<string, number | string>>(
        result.access_token,
      );
      expect(payload).toMatchObject({
        sub: 7,
        email: 'maria@email.com',
        role: UserRole.ADMIN,
        name: 'Maria Silva',
        tv: 3,
      });
      expect(Number(payload.exp) - Number(payload.iat)).toBe(7 * 24 * 60 * 60);

      expect(result.user).toMatchObject({
        id: 7,
        role: UserRole.ADMIN,
        store_id: STORE.id,
        platform_role: null,
        store: STORE,
      });
      const json = JSON.stringify(result.user);
      for (const leaked of ['password_hash', 'token_version', 'blocked']) {
        expect(json).not.toContain(leaked);
      }

      expect(users.recordLogin).toHaveBeenCalledWith(7);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.login.success',
          scope: 'STORE',
          storeId: STORE.id,
          actor: expect.objectContaining({ id: 7 }) as unknown,
        }),
      );
    });

    it('senha errada → 401 genérico, conta a falha e audita sem a senha', async () => {
      const { service, audit, rateLimit } = setup([
        makeUser({ password_hash: hash }),
      ]);
      await expect(
        service.login(
          { email: 'maria@email.com', password: 'Errada@99999' },
          fromIp('10.0.0.2'),
        ),
      ).rejects.toThrow(new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE));

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.login.failure',
          actorEmail: 'maria@email.com',
          result: 'FAILURE',
        }),
      );
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
        'Errada@99999',
      );
      expect(
        rateLimit.isLimited('LOGIN_FAILURES', '10.0.0.2|maria@email.com'),
      ).toBe(false);
    });

    it('e-mail inexistente e senha errada respondem a mesma mensagem', async () => {
      const { service } = setup([]);
      await expect(
        service.login({ email: 'nada@email.com', password: PASSWORD }),
      ).rejects.toThrow(new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE));
    });

    it('10 falhas por IP + e-mail → 429 antes de conferir a senha; o sucesso zera o contador', async () => {
      const { service, users } = setup([makeUser({ password_hash: hash })]);
      const req = fromIp('10.0.0.3');
      const wrong = { email: 'maria@email.com', password: 'Errada@99999' };
      const right = { email: 'maria@email.com', password: PASSWORD };

      for (let i = 0; i < 9; i++) {
        await expect(service.login(wrong, req)).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
      }
      await expect(service.login(right, req)).resolves.toHaveProperty(
        'access_token',
      );
      // Sem o reset, estas 9 somariam 18 e a 11ª já seria 429
      for (let i = 0; i < 9; i++) {
        await expect(service.login(wrong, req)).rejects.toBeInstanceOf(
          UnauthorizedException,
        );
      }
      await expect(service.login(wrong, req)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );

      users.findForLogin.mockClear();
      const limited = await service.login(right, req).catch((e: unknown) => e);
      expect((limited as HttpException).getStatus()).toBe(429);
      expect(users.findForLogin).not.toHaveBeenCalled();

      // Outro IP com o mesmo e-mail não é afetado
      await expect(
        service.login(right, fromIp('10.0.0.4')),
      ).resolves.toHaveProperty('access_token');
    });

    it('falhas por IP (várias contas a partir do mesmo endereço) → 429', async () => {
      process.env.RATE_LIMIT_LOGIN_FAILURES_IP = '3/900';
      const { service } = setup([]);
      const req = fromIp('10.0.0.5');
      for (let i = 0; i < 3; i++) {
        await expect(
          service.login({ email: `x${i}@email.com`, password: PASSWORD }, req),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      }
      const limited = await service
        .login({ email: 'outra@email.com', password: PASSWORD }, req)
        .catch((e: unknown) => e);
      expect((limited as HttpException).getStatus()).toBe(429);
    });

    it('IPv6: endereços do mesmo /64 dividem os limites; IPv4 escrito como IPv6 conta como o IPv4', async () => {
      process.env.RATE_LIMIT_LOGIN_FAILURES_IP = '3/900';
      const { service } = setup([]);
      for (let i = 1; i <= 3; i++) {
        await expect(
          service.login(
            { email: `v6-${i}@email.com`, password: PASSWORD },
            fromIp(`2001:db8:1:2::${i}`),
          ),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      }
      const sameNetwork = await service
        .login(
          { email: 'outra@email.com', password: PASSWORD },
          fromIp('2001:db8:1:2:ffff::9'),
        )
        .catch((e: unknown) => e);
      expect((sameNetwork as HttpException).getStatus()).toBe(429);
      // Outra rede /64 não é afetada
      await expect(
        service.login(
          { email: 'outra@email.com', password: PASSWORD },
          fromIp('2001:db8:1:3::1'),
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      for (let i = 0; i < 3; i++) {
        await service
          .login(
            { email: `v4-${i}@email.com`, password: PASSWORD },
            fromIp('200.1.2.3'),
          )
          .catch(() => undefined);
      }
      const mapped = await service
        .login(
          { email: 'outra@email.com', password: PASSWORD },
          fromIp('::ffff:200.1.2.3'),
        )
        .catch((e: unknown) => e);
      expect((mapped as HttpException).getStatus()).toBe(429);
    });

    it('falhas na mesma conta vindas de muitos IPs têm teto por conta; origens conhecidas seguem entrando', async () => {
      process.env.RATE_LIMIT_LOGIN_FAILURES_ACCOUNT = '5/3600';
      const { service, users, authSessions } = setup([
        makeUser({ password_hash: hash }),
      ]);
      const wrong = { email: 'maria@email.com', password: 'Errada@99999' };
      const right = { email: 'maria@email.com', password: PASSWORD };
      for (let i = 1; i <= 5; i++) {
        await expect(
          service.login(wrong, fromIp(`10.1.0.${i}`)),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      }

      // Força bruta distribuída: um IP novo é barrado ANTES do bcrypt, mesmo com a senha certa
      users.findForLogin.mockClear();
      const distributed = await service
        .login(right, fromIp('10.1.0.99'))
        .catch((e: unknown) => e);
      expect((distributed as HttpException).getStatus()).toBe(429);
      expect(users.findForLogin).not.toHaveBeenCalled();
      expect(authSessions.isKnownOrigin).toHaveBeenCalledWith(
        'maria@email.com',
        '10.1.0.99',
      );

      // A pessoa, de um IP com sessão ativa da conta, continua entrando (sem bloqueio coletivo da conta)
      authSessions.isKnownOrigin.mockResolvedValueOnce(true);
      await expect(
        service.login(right, fromIp('10.9.9.9')),
      ).resolves.toHaveProperty('access_token');
      // Outra conta não é afetada
      await expect(
        service.login(
          { email: 'outra@email.com', password: 'Errada@99999' },
          fromIp('10.1.0.99'),
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('teto por conta atingido: senha ERRADA de uma origem conhecida → o mesmo 429 de qualquer origem (sem oráculo de sessão ativa)', async () => {
      process.env.RATE_LIMIT_LOGIN_FAILURES_ACCOUNT = '3/3600';
      const { service, users, audit, authSessions } = setup([
        makeUser({ password_hash: hash }),
      ]);
      const wrong = { email: 'maria@email.com', password: 'Errada@99999' };
      for (let i = 1; i <= 3; i++) {
        await expect(
          service.login(wrong, fromIp(`203.0.113.${i}`)),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      }

      // Quem sonda da mesma rede da vítima (IP com sessão ativa da conta)...
      authSessions.isKnownOrigin.mockResolvedValue(true);
      users.findForLogin.mockClear();
      const sameNetwork = (await service
        .login(wrong, fromIp('198.51.100.7'))
        .catch((e: unknown) => e)) as HttpException;
      // ...e de qualquer outro IP recebe a mesma resposta
      authSessions.isKnownOrigin.mockResolvedValue(false);
      const elsewhere = (await service
        .login(wrong, fromIp('203.0.113.50'))
        .catch((e: unknown) => e)) as HttpException;
      expect(sameNetwork.getStatus()).toBe(429);
      expect(elsewhere.getStatus()).toBe(429);
      expect(sameNetwork.getResponse()).toEqual(elsewhere.getResponse());
      // A senha foi conferida na origem conhecida (a tentativa errada fica na auditoria)
      expect(users.findForLogin).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'auth.login.failure',
          metadata: expect.objectContaining({
            reason: 'invalid_credentials',
          }) as unknown,
        }),
      );

      // A dona da conta, da origem conhecida e com a senha certa, continua entrando
      authSessions.isKnownOrigin.mockResolvedValue(true);
      await expect(
        service.login(
          { email: 'maria@email.com', password: PASSWORD },
          fromIp('198.51.100.7'),
        ),
      ).resolves.toHaveProperty('access_token');
    });

    it('recusa 429 antes de conferir a senha espera o tempo típico de uma conferência (sem oráculo de tempo)', async () => {
      process.env.RATE_LIMIT_LOGIN_FAILURES_ACCOUNT = '1/3600';
      const { service } = setup([makeUser({ password_hash: hash })]);
      const wrong = { email: 'maria@email.com', password: 'Errada@99999' };
      await expect(
        service.login(wrong, fromIp('203.0.113.1')),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      // Conferências de senha medidas em ~300 ms
      const timing = (service as unknown as { loginTiming: LoginTiming })
        .loginTiming;
      for (let i = 0; i < 60; i++) timing.record(300);

      jest.useFakeTimers();
      try {
        let settled = false;
        const pending = service
          .login(wrong, fromIp('203.0.113.2'))
          .catch((e: unknown) => e)
          .finally(() => {
            settled = true;
          });
        await jest.advanceTimersByTimeAsync(200);
        expect(settled).toBe(false);
        await jest.advanceTimersByTimeAsync(200);
        expect(settled).toBe(true);
        expect(((await pending) as HttpException).getStatus()).toBe(429);
      } finally {
        jest.useRealTimers();
      }
    });

    it('logins corretos também têm teto por IP + e-mail (cada um cria sessão, roda o bcrypt e audita)', async () => {
      process.env.RATE_LIMIT_LOGIN_SUCCESS = '3/600';
      const { service, users } = setup([makeUser({ password_hash: hash })]);
      const right = { email: 'maria@email.com', password: PASSWORD };
      const req = fromIp('10.2.0.1');
      for (let i = 0; i < 3; i++) {
        await expect(service.login(right, req)).resolves.toHaveProperty(
          'access_token',
        );
      }
      users.findForLogin.mockClear();
      const limited = await service.login(right, req).catch((e: unknown) => e);
      expect((limited as HttpException).getStatus()).toBe(429);
      expect(users.findForLogin).not.toHaveBeenCalled();
      // Outro IP, ou outra conta no mesmo IP, seguem entrando
      await expect(
        service.login(right, fromIp('10.2.0.2')),
      ).resolves.toHaveProperty('access_token');
    });

    it('rajada de logins simultâneos: só 10 senhas são conferidas (as demais → 429 sem consultar o banco)', async () => {
      const { service, users } = setup([makeUser({ password_hash: hash })]);
      const req = fromIp('10.0.0.6');
      const results = await Promise.allSettled(
        Array.from({ length: 200 }, (_, i) =>
          service.login(
            { email: 'maria@email.com', password: `Chute@${i}xyz` },
            req,
          ),
        ),
      );
      const statuses = results.map((r) =>
        r.status === 'rejected' ? (r.reason as HttpException).getStatus() : 200,
      );
      expect(statuses.filter((s) => s === 401)).toHaveLength(10);
      expect(statuses.filter((s) => s === 429)).toHaveLength(190);
      expect(users.findForLogin).toHaveBeenCalledTimes(10);
      // 10 conferências + 1 calibração única do tempo de espera dos 429 (LoginTiming), não uma por recusa
      expect(bcrypt.compare).toHaveBeenCalledTimes(11);
    });

    it('a tentativa em andamento ocupa a vaga, mas a senha certa devolve a vaga do IP (não é falha)', async () => {
      process.env.RATE_LIMIT_LOGIN_FAILURES_IP = '2/900';
      const { service } = setup([makeUser({ password_hash: hash })]);
      const req = fromIp('10.0.0.7');
      const right = { email: 'maria@email.com', password: PASSWORD };
      for (let i = 0; i < 5; i++) {
        await expect(service.login(right, req)).resolves.toHaveProperty(
          'access_token',
        );
      }
      // Erro inesperado (ex.: banco fora) também devolve as vagas
      const { service: failing, users } = setup([]);
      users.findForLogin.mockRejectedValue(new Error('banco fora do ar'));
      for (let i = 0; i < 3; i++) {
        await expect(failing.login(right, req)).rejects.toThrow(
          'banco fora do ar',
        );
      }
    });

    it('conta bloqueada: 403 só com a senha correta (senha errada continua 401)', async () => {
      const blocked = makeUser({ password_hash: hash, blocked_at: new Date() });
      const { service, audit } = setup([blocked]);

      await expect(
        service.login({ email: 'maria@email.com', password: 'Errada@99999' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(
        service.login({ email: 'maria@email.com', password: PASSWORD }),
      ).rejects.toThrow(new ForbiddenException(BLOCKED_ACCOUNT_MESSAGE));
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'auth.login.failure',
          result: 'DENIED',
          metadata: { reason: 'blocked' },
        }),
      );
    });

    it('equipe de loja desativada → 403; loja suspensa ainda entra (para regularizar)', async () => {
      const staff = makeUser({
        password_hash: hash,
        role: UserRole.KITCHEN,
        store_id: STORE.id,
      });
      const inactive = setup([staff], {
        ...STORE,
        account_status: StoreAccountStatus.INACTIVE,
      });
      await expect(
        inactive.service.login({
          email: 'maria@email.com',
          password: PASSWORD,
        }),
      ).rejects.toThrow(new ForbiddenException(INACTIVE_STORE_LOGIN_MESSAGE));
      expect(inactive.users.recordLogin).not.toHaveBeenCalled();

      const suspended = setup([staff], {
        ...STORE,
        account_status: StoreAccountStatus.SUSPENDED,
      });
      await expect(
        suspended.service.login({
          email: 'maria@email.com',
          password: PASSWORD,
        }),
      ).resolves.toHaveProperty('access_token');
    });

    it('cliente e superadmin entram sem loja (store null)', async () => {
      const superAdmin = makeUser({
        password_hash: hash,
        platform_role: PlatformRole.SUPER_ADMIN,
      });
      const { service, audit } = setup([superAdmin], null);
      const { user } = await service.login({
        email: 'maria@email.com',
        password: PASSWORD,
      });
      expect(user).toMatchObject({
        store: null,
        store_id: null,
        platform_role: PlatformRole.SUPER_ADMIN,
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'PLATFORM' }),
      );
    });
  });

  describe('me e logout-all', () => {
    const session: AuthUser = {
      id: 7,
      email: 'maria@email.com',
      name: 'Maria Silva',
      role: UserRole.KITCHEN,
      storeId: STORE.id,
      platformRole: null,
      supportSession: null,
    };

    it('GET /auth/me: visão da sessão + support_session null', async () => {
      const { service, users } = setup([]);
      users.findActiveById.mockResolvedValue(makeUser());
      users.presentAs.mockResolvedValue({ id: 7, role: UserRole.KITCHEN });

      await expect(service.me(session)).resolves.toEqual({
        id: 7,
        role: UserRole.KITCHEN,
        support_session: null,
      });
      expect(users.presentAs).toHaveBeenCalledWith(
        expect.objectContaining({ id: 7 }),
        session,
      );
    });

    it('GET /auth/me numa sessão de suporte: { id, store_id, expires_at }', async () => {
      const { service, users } = setup([]);
      users.findActiveById.mockResolvedValue(makeUser());
      users.presentAs.mockResolvedValue({ id: 7, role: UserRole.ADMIN });
      const expiresAt = new Date(Date.now() + 60_000);

      const me = await service.me({
        ...session,
        role: UserRole.ADMIN,
        supportSession: { id: 4, storeId: STORE.id, expiresAt },
      });
      expect(me.support_session).toEqual({
        id: 4,
        store_id: STORE.id,
        expires_at: expiresAt,
      });
    });

    it('conta que sumiu entre o token e o /me → 401', async () => {
      const { service, users } = setup([]);
      users.findActiveById.mockResolvedValue(null);
      await expect(service.me(session)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('logout-all encerra as sessões registradas e DEPOIS muda a versão das sessões da conta', async () => {
      const { service, users, authSessions } = setup([]);
      const req = fromIp('10.0.0.9');
      await service.logoutAll(session, req);
      expect(authSessions.revokeAll).toHaveBeenCalledWith(7);
      expect(users.revokeSessions).toHaveBeenCalledWith(7, session, req);
      expect(authSessions.revokeAll.mock.invocationCallOrder[0]).toBeLessThan(
        users.revokeSessions.mock.invocationCallOrder[0],
      );
    });
  });
});

describe('JwtStrategy.validate', () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = SECRET;
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  function strategyWith(
    found: User | null,
    session: SupportSession | null = null,
    authSession: AuthSession | null = null,
  ) {
    const users = { findActiveById: jest.fn().mockResolvedValue(found) };
    const sessions = { findOne: jest.fn().mockResolvedValue(session) };
    const authSessions = {
      findForToken: jest.fn().mockResolvedValue(authSession),
    };
    return {
      users,
      sessions,
      authSessions,
      strategy: new JwtStrategy(
        users as unknown as UsersService,
        sessions as unknown as Repository<SupportSession>,
        authSessions as unknown as AuthSessionsService,
      ),
    };
  }

  it('devolve perfil, loja e papel global ATUAIS do banco (não os do token)', async () => {
    const { users, strategy } = strategyWith(
      makeUser({
        role: UserRole.EMPLOYEE,
        store_id: 3,
        platform_role: null,
      }),
    );

    await expect(
      strategy.validate({ sub: 7, role: UserRole.CLIENT }),
    ).resolves.toEqual({
      id: 7,
      email: 'maria@email.com',
      role: UserRole.EMPLOYEE,
      name: 'Maria Silva',
      storeId: 3,
      platformRole: null,
      supportSession: null,
    });
    expect(users.findActiveById).toHaveBeenCalledWith(7);
  });

  it('conta excluída ou inexistente → 401; sub inválido → 401 sem consultar o banco', async () => {
    await expect(
      strategyWith(null).strategy.validate({ sub: 7 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const { users, strategy } = strategyWith(makeUser());
    await expect(strategy.validate({})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(users.findActiveById).not.toHaveBeenCalled();
  });

  it('conta bloqueada → 401 com a mensagem de bloqueio', async () => {
    const { strategy } = strategyWith(makeUser({ blocked_at: new Date() }));
    await expect(strategy.validate({ sub: 7, tv: 0 })).rejects.toThrow(
      new UnauthorizedException(BLOCKED_ACCOUNT_MESSAGE),
    );
  });

  it('token de uma versão de sessão antiga (tv) → 401; token sem tv vale como 0', async () => {
    const current = makeUser({ token_version: 2 });
    await expect(
      strategyWith(current).strategy.validate({ sub: 7, tv: 1 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      strategyWith(current).strategy.validate({ sub: 7 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      strategyWith(current).strategy.validate({ sub: 7, tv: 2 }),
    ).resolves.toMatchObject({ id: 7 });
    await expect(
      strategyWith(makeUser({ token_version: 0 })).strategy.validate({
        sub: 7,
      }),
    ).resolves.toMatchObject({ id: 7 });
  });

  it('sessão de suporte válida: ADMIN somente leitura da loja da sessão, sem papel global', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const superAdmin = makeUser({ platform_role: PlatformRole.SUPER_ADMIN });
    const { strategy, sessions } = strategyWith(
      superAdmin,
      Object.assign(new SupportSession(), {
        id: 4,
        store_id: 3,
        expires_at: expiresAt,
      }),
    );

    await expect(strategy.validate({ sub: 7, sid: 4 })).resolves.toEqual({
      id: 7,
      email: 'maria@email.com',
      name: 'Maria Silva',
      role: UserRole.ADMIN,
      storeId: 3,
      platformRole: null,
      supportSession: { id: 4, storeId: 3, expiresAt },
    });
    const [options] = sessions.findOne.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(options.where).toMatchObject({
      id: 4,
      platform_user_id: 7,
      ended_at: IsNull(),
    });
  });

  it('sid de quem não é superadmin, ou sessão encerrada/vencida → 401', async () => {
    const client = strategyWith(makeUser());
    await expect(
      client.strategy.validate({ sub: 7, sid: 4 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(client.sessions.findOne).not.toHaveBeenCalled();

    const ended = strategyWith(
      makeUser({ platform_role: PlatformRole.SUPER_ADMIN }),
      null,
    );
    await expect(
      ended.strategy.validate({ sub: 7, sid: 4 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  describe('token com jti (sessão registrada em auth_sessions)', () => {
    const JTI = '3b241101-e2bb-4255-8caf-4136c566a962';
    const inOneHour = () => new Date(Date.now() + 3_600_000);

    function authSession(overrides: Partial<AuthSession> = {}): AuthSession {
      return Object.assign(new AuthSession(), {
        id: 31,
        jti: JTI,
        user_id: 7,
        kind: AuthSessionKind.USER,
        support_session_id: null,
        support_session: null,
        token_version: 0,
        created_at: new Date(),
        expires_at: inOneHour(),
        revoked_at: null,
        ip: '10.0.0.1',
        user_agent: 'jest',
        ...overrides,
      });
    }

    it('sessão aberta: devolve o usuário com a sessão do token (authSessionId); uma consulta pelo jti', async () => {
      const { strategy, authSessions, sessions } = strategyWith(
        makeUser(),
        null,
        authSession(),
      );
      await expect(strategy.validate({ sub: 7, jti: JTI })).resolves.toEqual({
        id: 7,
        email: 'maria@email.com',
        role: UserRole.CLIENT,
        name: 'Maria Silva',
        storeId: null,
        platformRole: null,
        supportSession: null,
        authSessionId: 31,
      });
      expect(authSessions.findForToken).toHaveBeenCalledTimes(1);
      expect(authSessions.findForToken).toHaveBeenCalledWith(JTI);
      expect(sessions.findOne).not.toHaveBeenCalled();
    });

    it('sessão inexistente, encerrada (logout/revogação), vencida ou de outra conta → 401', async () => {
      for (const found of [
        null,
        authSession({ revoked_at: new Date() }),
        authSession({ expires_at: new Date(Date.now() - 1000) }),
        authSession({ user_id: 99 }),
        // jti de uma sessão de suporte usado sem "sid"
        authSession({ kind: AuthSessionKind.SUPPORT, support_session_id: 4 }),
      ]) {
        const { strategy } = strategyWith(makeUser(), null, found);
        await expect(strategy.validate({ sub: 7, jti: JTI })).rejects.toThrow(
          new UnauthorizedException(INVALID_SESSION_MESSAGE),
        );
      }
    });

    it('jti fora do formato da API → 401 sem consultar o banco; conta com outra versão → 401 antes da sessão', async () => {
      const { strategy, authSessions } = strategyWith(makeUser());
      for (const jti of ['abc', "x' OR 1=1 --", 42]) {
        await expect(
          strategy.validate({ sub: 7, jti } as never),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      }
      expect(authSessions.findForToken).not.toHaveBeenCalled();

      const stale = strategyWith(
        makeUser({ token_version: 3 }),
        null,
        authSession(),
      );
      await expect(
        stale.strategy.validate({ sub: 7, tv: 2, jti: JTI }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(stale.authSessions.findForToken).not.toHaveBeenCalled();
    });

    it('sem o serviço de sessões (montagem parcial): token com jti → 401 (nunca aceito sem conferir)', async () => {
      const strategy = new JwtStrategy(
        {
          findActiveById: jest.fn().mockResolvedValue(makeUser()),
        } as unknown as UsersService,
        { findOne: jest.fn() } as unknown as Repository<SupportSession>,
      );
      await expect(strategy.validate({ sub: 7, jti: JTI })).rejects.toThrow(
        new UnauthorizedException(INVALID_SESSION_MESSAGE),
      );
      await expect(strategy.validate({ sub: 7 })).resolves.toMatchObject({
        id: 7,
      });
    });

    it('token SEM jti (emitido antes das sessões) continua valendo como antes, sem consultar auth_sessions', async () => {
      const { strategy, authSessions } = strategyWith(makeUser());
      await expect(strategy.validate({ sub: 7 })).resolves.toEqual(
        expect.not.objectContaining({
          authSessionId: expect.anything() as unknown,
        }) as unknown,
      );
      expect(authSessions.findForToken).not.toHaveBeenCalled();
    });

    describe('token SEM jti fora da janela de transição (JWT_LEGACY_ISSUED_BEFORE)', () => {
      const original = { ...process.env };
      const CUTOFF = '2026-11-01T12:00:00Z';
      const cutoff = Date.parse(CUTOFF) / 1000;
      const WEEK = 7 * 24 * 60 * 60;

      beforeAll(() => {
        jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);
      });
      afterEach(() => {
        process.env = { ...original };
      });

      it('emitido depois do corte (forjado com o segredo) ou com validade esticada → 401, de usuário e de suporte', async () => {
        process.env.JWT_LEGACY_ISSUED_BEFORE = CUTOFF;
        const superadmin = makeUser({
          platform_role: PlatformRole.SUPER_ADMIN,
        });
        const { strategy, sessions } = strategyWith(superadmin);
        process.env.NODE_ENV = 'production';
        for (const payload of [
          { sub: 7, iat: cutoff + 60, exp: cutoff + WEEK },
          { sub: 7, iat: cutoff - 60, exp: cutoff + 365 * 24 * 60 * 60 },
          { sub: 7 },
          { sub: 7, sid: 4, iat: cutoff + 60, exp: cutoff + WEEK },
        ]) {
          await expect(strategy.validate(payload)).rejects.toThrow(
            new UnauthorizedException(INVALID_SESSION_MESSAGE),
          );
        }
        expect(sessions.findOne).not.toHaveBeenCalled();

        // Emitido antes do corte, com a validade normal: continua valendo até expirar
        await expect(
          strategy.validate({ sub: 7, iat: cutoff - 60, exp: cutoff + WEEK }),
        ).resolves.toMatchObject({ id: 7 });
      });

      it('produção sem o corte: nenhum token sem jti é aceito', async () => {
        delete process.env.JWT_LEGACY_ISSUED_BEFORE;
        const now = Math.floor(Date.now() / 1000);
        const { strategy } = strategyWith(makeUser());
        process.env.NODE_ENV = 'production';
        await expect(
          strategy.validate({ sub: 7, iat: now - 60, exp: now + WEEK }),
        ).rejects.toThrow(new UnauthorizedException(INVALID_SESSION_MESSAGE));
      });
    });

    it('sessão de suporte com jti: a sessão de suporte vem junto (nenhuma consulta a mais)', async () => {
      const expiresAt = inOneHour();
      const support = Object.assign(new SupportSession(), {
        id: 4,
        store_id: 3,
        platform_user_id: 7,
        expires_at: expiresAt,
        ended_at: null,
      });
      const { strategy, sessions } = strategyWith(
        makeUser({ platform_role: PlatformRole.SUPER_ADMIN }),
        null,
        authSession({
          kind: AuthSessionKind.SUPPORT,
          support_session_id: 4,
          support_session: support,
        }),
      );
      await expect(
        strategy.validate({ sub: 7, sid: 4, jti: JTI }),
      ).resolves.toEqual({
        id: 7,
        email: 'maria@email.com',
        name: 'Maria Silva',
        role: UserRole.ADMIN,
        storeId: 3,
        platformRole: null,
        supportSession: { id: 4, storeId: 3, expiresAt },
        authSessionId: 31,
      });
      expect(sessions.findOne).not.toHaveBeenCalled();
    });

    it('sessão de suporte encerrada, vencida, de outro "sid" ou de outro operador → 401 (mensagem do suporte)', async () => {
      const superAdmin = makeUser({ platform_role: PlatformRole.SUPER_ADMIN });
      const support = (overrides: Partial<SupportSession> = {}) =>
        Object.assign(new SupportSession(), {
          id: 4,
          store_id: 3,
          platform_user_id: 7,
          expires_at: inOneHour(),
          ended_at: null,
          ...overrides,
        });
      for (const [found, sid] of [
        [support({ ended_at: new Date() }), 4],
        [support({ expires_at: new Date(Date.now() - 1000) }), 4],
        [support({ platform_user_id: 8 }), 4],
        [support(), 5],
        [null, 4],
      ] as const) {
        const { strategy } = strategyWith(
          superAdmin,
          null,
          authSession({
            kind: AuthSessionKind.SUPPORT,
            support_session_id: 4,
            support_session: found,
          }),
        );
        await expect(
          strategy.validate({ sub: 7, sid, jti: JTI }),
        ).rejects.toThrow(
          new UnauthorizedException(SUPPORT_SESSION_ENDED_MESSAGE),
        );
      }

      // Sessão de acesso encerrada (logout com o token de suporte): também a mensagem do suporte
      const revoked = strategyWith(
        superAdmin,
        null,
        authSession({
          kind: AuthSessionKind.SUPPORT,
          support_session_id: 4,
          support_session: support(),
          revoked_at: new Date(),
        }),
      );
      await expect(
        revoked.strategy.validate({ sub: 7, sid: 4, jti: JTI }),
      ).rejects.toThrow(
        new UnauthorizedException(SUPPORT_SESSION_ENDED_MESSAGE),
      );
    });
  });
});
