import { ConflictException, HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { StoreAccountStatus } from '../store/entities/store.entity';
import {
  PlatformRole,
  type User,
  UserRole,
} from '../users/entities/user.entity';
import type { UsersService } from '../users/users.service';
import type { AuthSessionsService } from './auth-sessions.service';
import {
  type AuthSession,
  AuthSessionKind,
  AuthSessionTransport,
} from './entities/auth-session.entity';
import { createRefreshToken, refreshHash } from './refresh-token';
import { jwtModuleOptions, SessionJwtService } from './session-token.service';
import {
  RefreshRejectedException,
  SUPPORT_SESSION_OPEN_MESSAGE,
  WebSessionService,
} from './web-session.service';

const JTI = '5a0438ed-6e37-45b3-b6a0-d53ae5994f05';

function claims(token: string): Record<string, number | string> {
  return JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
  ) as Record<string, number | string>;
}

function account(overrides: Partial<User> = {}): User {
  return {
    id: 7,
    email: 'maria@email.com',
    name: 'Maria',
    role: UserRole.CLIENT,
    token_version: 2,
    blocked_at: null,
    store_id: null,
    platform_role: null,
    phone: null,
    avatar: null,
    ...overrides,
  } as unknown as User;
}

interface Setup {
  service: WebSessionService;
  row: AuthSession;
  cookie: string;
  validator: string;
  sessions: {
    rotateRefresh: jest.Mock;
    revokeForReuse: jest.Mock;
    revokeSession: jest.Mock;
    hasOpenSupportFrom: jest.Mock;
    findBySelector: jest.Mock;
  };
  audit: { record: jest.Mock };
  users: { findActiveById: jest.Mock; storeSummary: jest.Mock };
}

/** Uma família de refresh em memória (a mesma semântica do UPDATE condicional do banco). */
function setup(
  options: {
    user?: User | null;
    row?: Partial<AuthSession>;
    supportOpen?: boolean;
    store?: { account_status: StoreAccountStatus } | null;
    rateLimit?: RateLimitService;
  } = {},
): Setup {
  const refresh = createRefreshToken();
  const user = options.user === undefined ? account() : options.user;
  const row = {
    id: 11,
    jti: JTI,
    user_id: 7,
    kind: AuthSessionKind.USER,
    transport: AuthSessionTransport.COOKIE,
    token_version: 2,
    expires_at: new Date(Date.now() + 7 * 86_400_000),
    revoked_at: null,
    refresh_selector: refresh.selector,
    refresh_hash: refresh.hash,
    refresh_prev_hash: null,
    refresh_rotated_at: null,
    refresh_generation: 0,
    user: user ?? undefined,
    ...options.row,
  } as unknown as AuthSession;

  const sessions = {
    findBySelector: jest.fn((selector: string) =>
      Promise.resolve(selector === row.refresh_selector ? { ...row } : null),
    ),
    rotateRefresh: jest.fn((id: number, presented: string, next: string) => {
      if (
        id !== row.id ||
        row.refresh_hash !== presented ||
        row.revoked_at ||
        new Date(row.expires_at).getTime() <= Date.now()
      ) {
        return Promise.resolve(false);
      }
      row.refresh_prev_hash = row.refresh_hash;
      row.refresh_hash = next;
      row.refresh_rotated_at = new Date();
      row.refresh_generation += 1;
      return Promise.resolve(true);
    }),
    revokeSession: jest.fn(() => {
      if (row.revoked_at) return Promise.resolve(false);
      row.revoked_at = new Date();
      return Promise.resolve(true);
    }),
    revokeForReuse: jest.fn(() => {
      row.revoked_at = new Date();
      return Promise.resolve();
    }),
    hasOpenSupportFrom: jest.fn(() =>
      Promise.resolve(options.supportOpen ?? false),
    ),
  };
  const users = {
    findActiveById: jest.fn(() => Promise.resolve(user)),
    storeSummary: jest.fn(() =>
      Promise.resolve(options.store === undefined ? null : options.store),
    ),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const jwt = new SessionJwtService({
    ...jwtModuleOptions(),
    secret: 'segredo-de-teste-do-refresh',
  });
  const service = new WebSessionService(
    sessions as unknown as AuthSessionsService,
    users as unknown as UsersService,
    jwt,
    options.rateLimit ?? new RateLimitService(),
    audit as unknown as AuditService,
  );
  return {
    service,
    row,
    cookie: refresh.token,
    validator: refresh.validator,
    sessions,
    audit,
    users,
  };
}

function requestWith(cookie: string | null): Request {
  return {
    headers: cookie ? { cookie: `outro=1; comestra_rt=${cookie}` } : {},
    secure: false,
    ip: '203.0.113.5',
    socket: { remoteAddress: '203.0.113.5' },
  } as unknown as Request;
}

describe('WebSessionService (renovação e saída da sessão do site)', () => {
  const savedGrace = process.env.AUTH_REFRESH_GRACE_SECONDS;
  afterEach(() => {
    if (savedGrace === undefined) delete process.env.AUTH_REFRESH_GRACE_SECONDS;
    else process.env.AUTH_REFRESH_GRACE_SECONDS = savedGrace;
    delete process.env.RATE_LIMIT_REFRESH;
    jest.useRealTimers();
  });

  it('rotação normal: troca o validador, mantém o seletor e o jti; token de acesso de 15 min', async () => {
    const ctx = setup();
    const outcome = await ctx.service.refresh(requestWith(ctx.cookie));

    expect(outcome.rotated).not.toBeNull();
    const [, selector, validator] = outcome.rotated!.token.split('.');
    expect(selector).toBe(ctx.row.refresh_selector);
    expect(validator).not.toBe(ctx.validator);
    expect(ctx.row.refresh_hash).toBe(refreshHash(validator));
    expect(ctx.row.refresh_prev_hash).toBe(refreshHash(ctx.validator));
    expect(outcome.rotated!.expiresAt).toEqual(ctx.row.expires_at);

    const token = claims(outcome.body.access_token);
    expect(token).toMatchObject({ sub: 7, tv: 2, jti: JTI });
    expect(Number(token.exp) - Number(token.iat)).toBe(900);
    expect(outcome.body).toMatchObject({
      expires_in: 900,
      session_transport: 'cookie',
      user: expect.objectContaining({
        id: 7,
        email: 'maria@email.com',
      }) as unknown,
    });
    expect(ctx.audit.record).not.toHaveBeenCalled();
  });

  it('o token de acesso nunca passa do fim da sessão', async () => {
    const ctx = setup({
      row: { expires_at: new Date(Date.now() + 120_000) },
    });
    const outcome = await ctx.service.refresh(requestWith(ctx.cookie));
    expect(outcome.body.expires_in).toBeGreaterThan(110);
    expect(outcome.body.expires_in).toBeLessThanOrEqual(120);
  });

  it('rotação concorrente (outra aba renovou antes): a segunda cai na tolerância → 200 sem Set-Cookie', async () => {
    const ctx = setup();
    const [first, second] = await Promise.all([
      ctx.service.refresh(requestWith(ctx.cookie)),
      ctx.service.refresh(requestWith(ctx.cookie)),
    ]);
    expect([first.rotated === null, second.rotated === null].sort()).toEqual([
      false,
      true,
    ]);
    expect(claims(first.body.access_token).jti).toBe(JTI);
    expect(claims(second.body.access_token).jti).toBe(JTI);
    expect(ctx.row.revoked_at).toBeNull();
    expect(ctx.sessions.revokeForReuse).not.toHaveBeenCalled();
  });

  it('refresh anterior dentro da tolerância → 200 sem nova rotação; depois dela → família revogada, auditada e 401', async () => {
    process.env.AUTH_REFRESH_GRACE_SECONDS = '30';
    const ctx = setup();
    await ctx.service.refresh(requestWith(ctx.cookie));
    const generation = ctx.row.refresh_generation;

    const again = await ctx.service.refresh(requestWith(ctx.cookie));
    expect(again.rotated).toBeNull();
    expect(ctx.row.refresh_generation).toBe(generation);

    ctx.row.refresh_rotated_at = new Date(Date.now() - 31_000);
    await expect(
      ctx.service.refresh(requestWith(ctx.cookie)),
    ).rejects.toBeInstanceOf(RefreshRejectedException);
    expect(ctx.sessions.revokeForReuse).toHaveBeenCalledWith(
      expect.objectContaining({ id: 11 }),
      expect.anything(),
    );
    expect(ctx.row.revoked_at).not.toBeNull();
  });

  it('rotação recusada duas vezes com o hash ainda atual (sem outra renovação): 401 sem tratar como reuso', async () => {
    const ctx = setup();
    ctx.sessions.rotateRefresh.mockResolvedValue(false);
    await expect(
      ctx.service.refresh(requestWith(ctx.cookie)),
    ).rejects.toBeInstanceOf(RefreshRejectedException);
    expect(ctx.sessions.rotateRefresh).toHaveBeenCalledTimes(2);
    expect(ctx.sessions.revokeForReuse).not.toHaveBeenCalled();
    expect(ctx.row.revoked_at).toBeNull();
  });

  it('seletor válido com validador desconhecido → reuso (revoga e audita); seletor desconhecido → 401 sem auditoria', async () => {
    const ctx = setup();
    const forged = `v1.${ctx.row.refresh_selector}.${createRefreshToken().validator}`;
    await expect(
      ctx.service.refresh(requestWith(forged)),
    ).rejects.toBeInstanceOf(RefreshRejectedException);
    expect(ctx.sessions.revokeForReuse).toHaveBeenCalledTimes(1);

    const other = setup();
    await expect(
      other.service.refresh(requestWith(createRefreshToken().token)),
    ).rejects.toBeInstanceOf(RefreshRejectedException);
    expect(other.sessions.revokeForReuse).not.toHaveBeenCalled();
    expect(other.audit.record).not.toHaveBeenCalled();
  });

  it('sem cookie, formato inválido ou cookie repetido → 401 sem consultar o banco', async () => {
    const ctx = setup();
    for (const req of [
      requestWith(null),
      requestWith('v1.curto.demais'),
      {
        headers: {
          cookie: `comestra_rt=${ctx.cookie}; comestra_rt=${ctx.cookie}`,
        },
        secure: false,
      } as unknown as Request,
    ]) {
      await expect(ctx.service.refresh(req)).rejects.toBeInstanceOf(
        RefreshRejectedException,
      );
    }
    expect(ctx.sessions.findBySelector).not.toHaveBeenCalled();
  });

  it('sessão vencida ou revogada, versão antiga, conta bloqueada ou excluída, loja desativada → 401', async () => {
    const cases = [
      setup({ row: { expires_at: new Date(Date.now() - 1000) } }),
      setup({ row: { revoked_at: new Date() } }),
      setup({ user: account({ token_version: 3 }) }),
      setup({ user: account({ blocked_at: new Date() }) }),
      setup({ user: null }),
      setup({
        user: account({ store_id: 5, role: UserRole.ADMIN }),
        store: { account_status: StoreAccountStatus.INACTIVE },
      }),
    ];
    for (const ctx of cases) {
      await expect(
        ctx.service.refresh(requestWith(ctx.cookie)),
      ).rejects.toBeInstanceOf(RefreshRejectedException);
      expect(ctx.sessions.rotateRefresh).not.toHaveBeenCalled();
      expect(ctx.sessions.revokeForReuse).not.toHaveBeenCalled();
    }
  });

  it('superadmin com suporte aberto a partir da sessão → 409 (sem rotação, cookie mantido); sem suporte → 200', async () => {
    const superadmin = account({ platform_role: PlatformRole.SUPER_ADMIN });
    const open = setup({ user: superadmin, supportOpen: true });
    const error = await open.service
      .refresh(requestWith(open.cookie))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toBe(
      SUPPORT_SESSION_OPEN_MESSAGE,
    );
    expect(open.sessions.hasOpenSupportFrom).toHaveBeenCalledWith(11);
    expect(open.sessions.rotateRefresh).not.toHaveBeenCalled();

    const closed = setup({ user: superadmin, supportOpen: false });
    await expect(
      closed.service.refresh(requestWith(closed.cookie)),
    ).resolves.toMatchObject({ body: { session_transport: 'cookie' } });

    // Conta comum: nem consulta o suporte
    const client = setup();
    await client.service.refresh(requestWith(client.cookie));
    expect(client.sessions.hasOpenSupportFrom).not.toHaveBeenCalled();
  });

  it('limite REFRESH por IP → 429', async () => {
    process.env.RATE_LIMIT_REFRESH = '2/60';
    const limiter = new RateLimitService();
    const ctx = setup({ rateLimit: limiter });
    await ctx.service.refresh(requestWith(ctx.cookie));
    await ctx.service.refresh(requestWith(ctx.cookie));
    const error = await ctx.service
      .refresh(requestWith(ctx.cookie))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
  });

  describe('logout pelo cookie', () => {
    it('cookie atual (ou o anterior): encerra a família e audita auth.logout via cookie', async () => {
      const ctx = setup();
      await ctx.service.logout(requestWith(ctx.cookie));
      expect(ctx.row.revoked_at).not.toBeNull();
      expect(ctx.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.logout',
          targetType: 'auth_session',
          targetId: 11,
          metadata: { via: 'cookie' },
        }),
      );
      // Idempotente: já encerrada, nada muda
      await ctx.service.logout(requestWith(ctx.cookie));
      expect(ctx.audit.record).toHaveBeenCalledTimes(1);
    });

    it('validador que não é o atual nem o anterior: também conta como reuso; sem cookie ou desconhecido: nada', async () => {
      const ctx = setup();
      const forged = `v1.${ctx.row.refresh_selector}.${createRefreshToken().validator}`;
      await ctx.service.logout(requestWith(forged));
      expect(ctx.sessions.revokeForReuse).toHaveBeenCalledTimes(1);

      const other = setup();
      await other.service.logout(requestWith(null));
      await other.service.logout(requestWith(createRefreshToken().token));
      expect(other.sessions.revokeSession).not.toHaveBeenCalled();
      expect(other.audit.record).not.toHaveBeenCalled();
    });
  });
});
