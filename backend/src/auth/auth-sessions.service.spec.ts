import { NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { IsNull } from 'typeorm';
import type { AuditService } from '../audit/audit.service';
import { SupportSession } from '../platform/entities/support-session.entity';
import { PlatformRole, UserRole } from '../users/entities/user.entity';
import type { AuthUser } from './auth-user';
import {
  AUTH_SESSION_NOT_FOUND_MESSAGE,
  AuthSessionsService,
  MAX_ACTIVE_SESSIONS_PER_ACCOUNT,
} from './auth-sessions.service';
import {
  AuthSession,
  AuthSessionKind,
  AuthSessionTransport,
} from './entities/auth-session.entity';
import { createRefreshToken } from './refresh-token';
import type { SessionScope } from './session-scope';

const JTI = '3b241101-e2bb-4255-8caf-4136c566a962';
const NOW = new Date('2026-10-25T12:00:00.000Z');

const CLIENT: AuthUser = {
  id: 7,
  email: 'maria@email.com',
  name: 'Maria',
  role: UserRole.CLIENT,
  storeId: null,
  platformRole: null,
  supportSession: null,
  authSessionId: 31,
};

/** Token de suporte (superadmin 1 como ADMIN somente leitura da loja 3, sessão de suporte 4). */
const SUPPORT: AuthUser = {
  id: 1,
  email: 'ops@comestra.com',
  name: 'Ops',
  role: UserRole.ADMIN,
  storeId: 3,
  platformRole: null,
  supportSession: {
    id: 4,
    storeId: 3,
    expiresAt: new Date(NOW.getTime() + 60_000),
  },
  authSessionId: 40,
};

const REQUEST = {
  ip: '203.0.113.9',
  headers: {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36',
  },
} as unknown as Request;

function authSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return Object.assign(new AuthSession(), {
    id: 32,
    jti: JTI,
    user_id: 7,
    kind: AuthSessionKind.USER,
    support_session_id: null,
    token_version: 0,
    created_at: NOW,
    expires_at: new Date(NOW.getTime() + 3_600_000),
    revoked_at: null,
    ip: '10.0.0.1',
    user_agent: 'okhttp/4.9.2',
    ...overrides,
  });
}

/** QueryBuilder falso: cada chamada encadeada fica registrada; getManyAndCount devolve `result`. */
function queryBuilder(result: [AuthSession[], number]) {
  const calls: Array<[string, unknown[]]> = [];
  const qb: Record<string, unknown> = {};
  for (const method of [
    'innerJoin',
    'leftJoin',
    'leftJoinAndSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'setParameter',
    'offset',
    'limit',
  ]) {
    qb[method] = (...args: unknown[]) => {
      calls.push([method, args]);
      return qb;
    };
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue(result);
  qb.getOne = jest.fn().mockResolvedValue(result[0][0] ?? null);
  return { qb, calls };
}

function setup(
  options: {
    found?: AuthSession | null;
    support?: SupportSession | null;
    list?: [AuthSession[], number];
  } = {},
) {
  const { qb, calls } = queryBuilder(options.list ?? [[], 0]);
  const repo = {
    insert: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    findOne: jest.fn().mockResolvedValue(options.found ?? null),
    query: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  };
  const supportSessions = {
    manager: { getRepository: jest.fn().mockReturnValue(repo) },
    findOne: jest.fn().mockResolvedValue(options.support ?? null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new AuthSessionsService(
    supportSessions as never,
    audit as unknown as AuditService,
  );
  return { service, repo, supportSessions, audit, qb, calls };
}

function openSupportSession(
  overrides: Partial<SupportSession> = {},
): SupportSession {
  return Object.assign(new SupportSession(), {
    id: 4,
    platform_user_id: 1,
    store_id: 3,
    reason: 'Chamado 42',
    started_at: new Date(NOW.getTime() - 10 * 60_000),
    expires_at: new Date(NOW.getTime() + 20 * 60_000),
    ended_at: null,
    ip: null,
    ...overrides,
  });
}

describe('AuthSessionsService', () => {
  describe('persistIssued (sessões dos tokens emitidos na requisição)', () => {
    it('grava uma sessão por token (IP e navegador da requisição) e limpa as sessões mortas das contas', async () => {
      const { service, repo } = setup();
      const expiresAt = new Date(NOW.getTime() + 7 * 86_400_000);
      const scope: SessionScope = {
        request: REQUEST,
        issued: [
          {
            jti: JTI,
            userId: 7,
            kind: AuthSessionKind.USER,
            supportSessionId: null,
            tokenVersion: 2,
            expiresAt,
          },
          {
            jti: '9d7a2b8c-1f1e-4a55-9a3e-2f63a3d1c0aa',
            userId: 1,
            kind: AuthSessionKind.SUPPORT,
            supportSessionId: 4,
            tokenVersion: 0,
            expiresAt,
          },
        ],
      };

      await service.persistIssued(scope);

      expect(repo.insert).toHaveBeenCalledTimes(1);
      expect(repo.insert).toHaveBeenCalledWith([
        {
          jti: JTI,
          user_id: 7,
          kind: AuthSessionKind.USER,
          support_session_id: null,
          token_version: 2,
          expires_at: expiresAt,
          revoked_at: null,
          ip: '203.0.113.9',
          user_agent: REQUEST.headers['user-agent'],
          // Sem o modo cookie: BEARER, sem refresh e sem sessão pai (como antes)
          transport: 'BEARER',
          refresh_selector: null,
          refresh_hash: null,
          parent_session_id: null,
        },
        expect.objectContaining({
          user_id: 1,
          kind: AuthSessionKind.SUPPORT,
          support_session_id: 4,
        }),
      ]);
      // As sessões anotadas saem do escopo (nunca gravadas duas vezes)
      expect(scope.issued).toEqual([]);

      // Limpeza por conta (vencidas, revogadas, de outra versão ou de suporte encerrado) + lote geral
      const purges = repo.query.mock.calls as Array<[string, unknown[]]>;
      const perAccount = purges.filter(
        ([sql]) => sql.includes('"user_id" = $1') && !sql.includes('OFFSET'),
      );
      expect(perAccount.map(([, params]) => params)).toEqual([[7], [1]]);
      expect(perAccount[0][0]).toMatch(/"expires_at" <= now\(\)/);
      expect(perAccount[0][0]).toMatch(/"revoked_at" IS NOT NULL/);
      expect(perAccount[0][0]).toMatch(/"token_version" <>/);
      expect(purges.some(([sql]) => /LIMIT \$1/.test(sql))).toBe(true);

      // Teto de sessões ativas por conta: depois da limpeza, as mais antigas além do teto saem
      const caps = purges.filter(([sql]) => sql.includes('OFFSET'));
      expect(caps.map(([, params]) => params)).toEqual([
        [7, AuthSessionKind.USER, MAX_ACTIVE_SESSIONS_PER_ACCOUNT],
        [1, AuthSessionKind.USER, MAX_ACTIVE_SESSIONS_PER_ACCOUNT],
      ]);
      expect(caps[0][0]).toMatch(
        /ORDER BY "created_at" DESC, "id" DESC\s+OFFSET \$3/,
      );
      const order = purges.map(([sql]) =>
        sql.includes('OFFSET') ? 'cap' : 'purge',
      );
      expect(order.slice(0, 2)).toEqual(['purge', 'cap']);
      expect(MAX_ACTIVE_SESSIONS_PER_ACCOUNT).toBeGreaterThanOrEqual(20);
    });

    it('isKnownOrigin: IP (rede /64 no IPv6) de uma sessão ATIVA de acesso da conta', async () => {
      const { service, qb, calls } = setup();
      const getRawMany = jest
        .fn()
        .mockResolvedValue([
          { ip: '10.0.0.1' },
          { ip: '2001:db8:1:2::abcd' },
          { ip: null },
        ]);
      qb.getRawMany = getRawMany;
      qb.select = (...args: unknown[]) => {
        calls.push(['select', args]);
        return qb;
      };

      await expect(
        service.isKnownOrigin(' Maria@Email.com ', '10.0.0.1'),
      ).resolves.toBe(true);
      await expect(
        service.isKnownOrigin('maria@email.com', '2001:db8:1:2::/64'),
      ).resolves.toBe(true);
      await expect(
        service.isKnownOrigin('maria@email.com', '10.0.0.2'),
      ).resolves.toBe(false);

      const sql = calls.map(([method, args]) => `${method}:${String(args[0])}`);
      expect(sql).toEqual(
        expect.arrayContaining([
          'innerJoin:s.user',
          'where:LOWER(u.email) = :email',
          'andWhere:s.kind = :kind',
          'andWhere:s.revoked_at IS NULL',
          'andWhere:s.expires_at > now()',
          `limit:${MAX_ACTIVE_SESSIONS_PER_ACCOUNT}`,
        ]),
      );
      const where = calls.find(([method]) => method === 'where');
      expect(where?.[1][1]).toEqual({ email: 'maria@email.com' });
      // Só sessões da versão atual da conta (as derrubadas por "sair de todos" não contam)
      const join = calls.find(([method]) => method === 'innerJoin');
      expect(join?.[1][2]).toBe('u.token_version = s.token_version');
    });

    it('sem token emitido: não grava nada', async () => {
      const { service, repo } = setup();
      await service.persistIssued({ request: REQUEST, issued: [] });
      expect(repo.insert).not.toHaveBeenCalled();
      expect(repo.query).not.toHaveBeenCalled();
    });

    it('falha na gravação sobe (o token não pode sair); falha na limpeza não derruba a resposta', async () => {
      const issued = () => ({
        request: null,
        issued: [
          {
            jti: JTI,
            userId: 7,
            kind: AuthSessionKind.USER,
            supportSessionId: null,
            tokenVersion: 0,
            expiresAt: NOW,
          },
        ],
      });

      const failingInsert = setup();
      failingInsert.repo.insert.mockRejectedValueOnce(new Error('banco fora'));
      await expect(
        failingInsert.service.persistIssued(issued()),
      ).rejects.toThrow('banco fora');

      const failingPurge = setup();
      failingPurge.repo.query.mockRejectedValue(new Error('timeout'));
      await expect(
        failingPurge.service.persistIssued(issued()),
      ).resolves.toHaveLength(1);
      expect(failingPurge.repo.insert).toHaveBeenCalled();
    });
  });

  it('findForToken: uma consulta pelo jti, com a sessão de suporte junto', async () => {
    const found = authSession();
    const { service, calls } = setup({ list: [[found], 1] });
    await expect(service.findForToken(JTI)).resolves.toBe(found);
    expect(calls).toEqual([
      ['leftJoinAndSelect', ['s.support_session', 'ss']],
      ['where', ['s.jti = :jti', { jti: JTI }]],
    ]);
  });

  it('list: só as ativas da conta (versão atual, sem revogação, no prazo, suporte aberto), a atual primeiro', async () => {
    const current = authSession({
      id: 31,
      user_agent: REQUEST.headers['user-agent'] as string,
    });
    const other = authSession({ id: 30, ip: null });
    const { service, calls } = setup({ list: [[current, other], 2] });

    const page = await service.list(CLIENT, { page: 1, pageSize: 10 }, NOW);

    expect(page).toEqual({
      items: [
        {
          id: 31,
          kind: AuthSessionKind.USER,
          current: true,
          created_at: NOW,
          expires_at: current.expires_at,
          ip: '10.0.0.1',
          browser: 'Chrome no Windows',
          support_session_id: null,
        },
        expect.objectContaining({
          id: 30,
          current: false,
          ip: null,
          browser: 'Aplicativo no Android',
        }),
      ],
      total: 2,
      page: 1,
      pageSize: 10,
    });
    // Nenhum jti nem User-Agent completo na resposta
    expect(JSON.stringify(page)).not.toContain(JTI);
    expect(JSON.stringify(page)).not.toContain('Safari/537.36');

    expect(calls).toEqual(
      expect.arrayContaining([
        ['innerJoin', ['s.user', 'u', 'u.token_version = s.token_version']],
        ['where', ['s.user_id = :userId', { userId: 7 }]],
        ['andWhere', ['s.revoked_at IS NULL']],
        ['andWhere', ['s.expires_at > :now', { now: NOW }]],
        ['setParameter', ['current', 31]],
        ['offset', [0]],
        ['limit', [10]],
      ]),
    );
  });

  describe('logout (POST /auth/logout)', () => {
    it('encerra a sessão do token e audita auth.logout', async () => {
      const { service, repo, audit, supportSessions } = setup();
      await service.logout(CLIENT, REQUEST);

      expect(repo.update).toHaveBeenCalledWith(
        { id: 31, user_id: 7, revoked_at: IsNull() },
        { revoked_at: expect.any(Date) as unknown },
      );
      expect(supportSessions.update).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: CLIENT,
          scope: 'ANONYMOUS',
          action: 'auth.logout',
          targetType: 'auth_session',
          targetId: 31,
        }),
      );
    });

    it('token antigo (sem jti): nada a encerrar, só a auditoria (legacy_token)', async () => {
      const { service, repo, audit } = setup();
      await service.logout({ ...CLIENT, authSessionId: undefined }, REQUEST);
      expect(repo.update).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.logout',
          targetId: null,
          metadata: { legacy_token: true },
        }),
      );
    });

    it('token de suporte: encerra a sessão de acesso E a sessão de suporte (auditado), sem o token do superpainel', async () => {
      const { service, repo, supportSessions, audit } = setup({
        support: openSupportSession({
          started_at: new Date(Date.now() - 10 * 60_000),
          expires_at: new Date(Date.now() + 20 * 60_000),
        }),
      });
      await service.logout(SUPPORT, REQUEST);

      expect(repo.update).toHaveBeenCalledWith(
        { id: 40, user_id: 1, revoked_at: IsNull() },
        { revoked_at: expect.any(Date) as unknown },
      );
      // Só a sessão aberta pelo próprio operador
      expect(supportSessions.findOne).toHaveBeenCalledWith({
        where: { id: 4, platform_user_id: 1 },
      });
      expect(supportSessions.update).toHaveBeenCalledWith(
        { id: 4, platform_user_id: 1, ended_at: IsNull() },
        { ended_at: expect.any(Date) as unknown },
      );
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: SUPPORT,
          scope: 'PLATFORM',
          storeId: 3,
          action: 'platform.support_session.end',
          targetType: 'support_session',
          targetId: 4,
          metadata: expect.objectContaining({
            via: 'logout',
            opened_by_user_id: 1,
            expired_before_end: false,
            duration_minutes: 10,
          }) as unknown,
        }),
      );
    });

    it('token de suporte com a sessão de suporte já encerrada: idempotente, sem nova auditoria', async () => {
      const { service, supportSessions, audit } = setup({
        support: openSupportSession({ ended_at: NOW }),
      });
      await service.logout(SUPPORT, REQUEST);
      expect(supportSessions.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();

      // Encerrada por outra requisição entre a leitura e a gravação
      const raced = setup({ support: openSupportSession() });
      raced.supportSessions.update.mockResolvedValueOnce({ affected: 0 });
      await raced.service.logout(SUPPORT, REQUEST);
      expect(raced.audit.record).not.toHaveBeenCalled();
    });
  });

  describe('revoke (DELETE /auth/sessions/:id)', () => {
    it('sessão de outra conta ou inexistente → 404 (a busca é sempre pela própria conta)', async () => {
      const { service, repo } = setup({ found: null });
      await expect(service.revoke(CLIENT, 99, REQUEST)).rejects.toThrow(
        new NotFoundException(AUTH_SESSION_NOT_FOUND_MESSAGE),
      );
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: 99, user_id: 7 },
      });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('encerra a sessão própria e audita auth.session.revoke (current indica se era a desta requisição)', async () => {
      const { service, repo, audit } = setup({ found: authSession() });
      await service.revoke(CLIENT, 32, REQUEST);
      expect(repo.update).toHaveBeenCalledWith(
        { id: 32, user_id: 7, revoked_at: IsNull() },
        { revoked_at: expect.any(Date) as unknown },
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.session.revoke',
          targetType: 'auth_session',
          targetId: 32,
          metadata: { kind: AuthSessionKind.USER, current: false },
        }),
      );
    });

    it('já encerrada: nada muda (idempotente, sem auditoria)', async () => {
      const { service, repo, audit } = setup({
        found: authSession({ revoked_at: NOW }),
      });
      await service.revoke(CLIENT, 32, REQUEST);
      expect(repo.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('sessão de acesso de um suporte: também encerra a sessão de suporte (via session_revoke)', async () => {
      const superAdmin: AuthUser = {
        ...SUPPORT,
        role: UserRole.CLIENT,
        storeId: null,
        platformRole: PlatformRole.SUPER_ADMIN,
        supportSession: null,
        authSessionId: 41,
      };
      const { service, supportSessions, audit } = setup({
        found: authSession({
          id: 40,
          user_id: 1,
          kind: AuthSessionKind.SUPPORT,
          support_session_id: 4,
        }),
        support: openSupportSession(),
      });
      await service.revoke(superAdmin, 40, REQUEST);
      expect(supportSessions.update).toHaveBeenCalled();
      expect(audit.record.mock.calls.map((call: unknown[]) => call[0])).toEqual(
        [
          expect.objectContaining({
            action: 'platform.support_session.end',
            metadata: expect.objectContaining({
              via: 'session_revoke',
            }) as unknown,
          }),
          expect.objectContaining({
            action: 'auth.session.revoke',
            scope: 'PLATFORM',
            metadata: { kind: AuthSessionKind.SUPPORT, current: false },
          }),
        ],
      );
    });
  });

  it('revokeAll: marca todas as sessões abertas da conta como encerradas', async () => {
    const { service, repo } = setup();
    repo.update.mockResolvedValueOnce({ affected: 3 });
    await expect(service.revokeAll(7, NOW)).resolves.toBe(3);
    expect(repo.update).toHaveBeenCalledWith(
      { user_id: 7, revoked_at: IsNull() },
      { revoked_at: NOW },
    );
  });

  describe('sessão do site em cookie', () => {
    it('persistIssued grava transporte, seletor, hash do refresh e sessão pai (nunca o valor do cookie)', async () => {
      const { service, repo } = setup();
      const refresh = createRefreshToken();
      const scope: SessionScope = {
        request: REQUEST,
        issued: [
          {
            jti: JTI,
            userId: 7,
            kind: AuthSessionKind.USER,
            supportSessionId: null,
            tokenVersion: 0,
            expiresAt: NOW,
            transport: AuthSessionTransport.COOKIE,
            refresh: {
              selector: refresh.selector,
              hash: refresh.hash,
              token: refresh.token,
            },
            parentSessionId: null,
          },
          {
            jti: '9d7a2b8c-1f1e-4a55-9a3e-2f63a3d1c0aa',
            userId: 1,
            kind: AuthSessionKind.SUPPORT,
            supportSessionId: 4,
            tokenVersion: 0,
            expiresAt: NOW,
            transport: AuthSessionTransport.BEARER,
            parentSessionId: 31,
          },
        ],
      };
      await service.persistIssued(scope);
      const [rows] = repo.insert.mock.calls[0] as [Record<string, unknown>[]];
      expect(rows[0]).toMatchObject({
        transport: 'COOKIE',
        refresh_selector: refresh.selector,
        refresh_hash: refresh.hash,
        parent_session_id: null,
      });
      expect(rows[1]).toMatchObject({
        transport: 'BEARER',
        refresh_selector: null,
        refresh_hash: null,
        parent_session_id: 31,
      });
      expect(JSON.stringify(rows)).not.toContain(refresh.validator);
    });

    it('rotateRefresh: UPDATE condicional (hash atual, aberta e no prazo); false quando outra renovação chegou antes', async () => {
      const { service, repo } = setup();
      repo.query.mockResolvedValueOnce([[{ id: 32 }], 1]);
      await expect(
        service.rotateRefresh(32, 'a'.repeat(64), 'b'.repeat(64)),
      ).resolves.toBe(true);
      const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/"refresh_prev_hash" = "refresh_hash"/);
      expect(sql).toMatch(/"refresh_hash" = \$2/);
      expect(sql).toMatch(/"revoked_at" IS NULL/);
      expect(sql).toMatch(/"expires_at" > now\(\)/);
      expect(sql).toMatch(/"refresh_generation" = "refresh_generation" \+ 1/);
      expect(params).toEqual([32, 'a'.repeat(64), 'b'.repeat(64)]);

      repo.query.mockResolvedValueOnce([[], 0]);
      await expect(
        service.rotateRefresh(32, 'a'.repeat(64), 'c'.repeat(64)),
      ).resolves.toBe(false);
    });

    it('hasOpenSupportFrom: sessão de suporte filha aberta (auth e support_sessions)', async () => {
      const { service, repo } = setup();
      repo.query.mockResolvedValueOnce([{ '?column?': 1 }]);
      await expect(service.hasOpenSupportFrom(31)).resolves.toBe(true);
      const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/"parent_session_id" = \$1/);
      expect(sql).toMatch(/ss\."ended_at" IS NULL/);
      expect(params).toEqual([31]);
      repo.query.mockResolvedValueOnce([]);
      await expect(service.hasOpenSupportFrom(31)).resolves.toBe(false);
    });

    it('revokeForReuse: encerra a família e audita auth.refresh.reuse (DENIED) com a geração', async () => {
      const { service, repo, audit } = setup();
      const session = authSession({
        id: 32,
        transport: AuthSessionTransport.COOKIE,
        refresh_generation: 4,
        user: {
          id: 7,
          email: 'maria@email.com',
          store_id: null,
          platform_role: null,
        } as never,
      });
      await service.revokeForReuse(session, REQUEST);
      expect(repo.update).toHaveBeenCalledWith(
        { id: 32, revoked_at: IsNull() },
        { revoked_at: expect.any(Date) as unknown },
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.refresh.reuse',
          result: 'DENIED',
          targetType: 'auth_session',
          targetId: 32,
          metadata: { generation: 4 },
          scope: 'ANONYMOUS',
        }),
      );
    });

    describe('revokeReplacedCookieSession (login novo no mesmo navegador)', () => {
      const owner = {
        id: 7,
        email: 'maria@email.com',
        store_id: null,
        platform_role: null,
        token_version: 0,
      };

      function cookieSession(
        refresh = createRefreshToken(),
        overrides: Partial<AuthSession> = {},
      ) {
        return {
          refresh,
          session: authSession({
            id: 32,
            transport: AuthSessionTransport.COOKIE,
            refresh_selector: refresh.selector,
            refresh_hash: refresh.hash,
            refresh_prev_hash: null,
            expires_at: new Date(Date.now() + 3_600_000),
            user: owner as never,
            ...overrides,
          }),
        };
      }

      it('cookie atual (ou o anterior) de uma sessão aberta: encerra e audita reason "replaced"', async () => {
        const { refresh, session } = cookieSession();
        const { service, repo, audit } = setup({ found: session });
        await service.revokeReplacedCookieSession(refresh.token, [], REQUEST);
        expect(repo.update).toHaveBeenCalledWith(
          { id: 32, revoked_at: IsNull() },
          { revoked_at: expect.any(Date) as unknown },
        );
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'auth.session.revoke',
            targetId: 32,
            metadata: {
              kind: AuthSessionKind.USER,
              current: false,
              reason: 'replaced',
            },
          }),
        );
      });

      it('nada muda: cookie inválido, validador errado, sessão já encerrada, da versão antiga ou a própria sessão nova', async () => {
        const forged = createRefreshToken();
        const cases: Array<{
          cookie: string | null;
          found: AuthSession | null;
          keep?: string;
        }> = [];
        cases.push({ cookie: 'lixo', found: null });
        const wrong = cookieSession();
        cases.push({
          cookie: `v1.${wrong.refresh.selector}.${forged.validator}`,
          found: wrong.session,
        });
        const revoked = cookieSession(undefined, { revoked_at: new Date() });
        cases.push({ cookie: revoked.refresh.token, found: revoked.session });
        const old = cookieSession(undefined, { token_version: 3 });
        cases.push({ cookie: old.refresh.token, found: old.session });
        const same = cookieSession();
        cases.push({
          cookie: same.refresh.token,
          found: same.session,
          keep: same.session.jti,
        });
        for (const item of cases) {
          const { service, repo, audit } = setup({ found: item.found });
          const keep = item.keep
            ? [
                {
                  jti: item.keep,
                  userId: 7,
                  kind: AuthSessionKind.USER,
                  supportSessionId: null,
                  tokenVersion: 0,
                  expiresAt: NOW,
                },
              ]
            : [];
          await service.revokeReplacedCookieSession(item.cookie, keep, REQUEST);
          expect(repo.update).not.toHaveBeenCalled();
          expect(audit.record).not.toHaveBeenCalled();
        }
      });
    });
  });
});
