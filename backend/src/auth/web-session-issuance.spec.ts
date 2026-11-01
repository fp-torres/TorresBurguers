import {
  BadRequestException,
  Controller,
  INestApplication,
  Post,
  Req,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import request from 'supertest';
import { App } from 'supertest/types';
import { setupApp } from '../config/app-setup';
import { UserRole } from '../users/entities/user.entity';
import { AuthSessionsService } from './auth-sessions.service';
import {
  AuthSessionKind,
  AuthSessionTransport,
} from './entities/auth-session.entity';
import { SessionIssuanceInterceptor } from './session-issuance.interceptor';
import type { IssuedSession, SessionScope } from './session-scope';
import { SessionModule } from './session.module';
import { SessionTokenService } from './session-token.service';

const SECRET = 'segredo-de-teste-das-sessoes-web';
const WEB = 'http://web.test:5173';
const ACCOUNT = {
  id: 7,
  email: 'maria@email.com',
  role: UserRole.CLIENT,
  name: 'Maria',
  token_version: 2,
};

function claims(token: string): Record<string, number | string> {
  return JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
  ) as Record<string, number | string>;
}

interface Persisted {
  issued: IssuedSession[];
  responsePending: boolean;
}
const persisted: Persisted[] = [];
const replaced: { cookie: string | null; keep: string[] }[] = [];
let failPersistence = false;

const fakeSessions = {
  async persistIssued(scope: SessionScope): Promise<IssuedSession[]> {
    if (scope.issued.length === 0) return [];
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (failPersistence) throw new Error('banco fora do ar');
    const response = (
      scope.request as unknown as { res?: { headersSent: boolean } }
    )?.res;
    const issued = scope.issued.splice(0);
    persisted.push({
      issued,
      responsePending: response ? !response.headersSent : false,
    });
    return issued;
  },
  revokeReplacedCookieSession(
    cookie: string | null,
    keep: IssuedSession[],
  ): Promise<void> {
    replaced.push({ cookie, keep: keep.map((session) => session.jti) });
    return Promise.resolve();
  },
};

@Controller('emissao')
class EmissionController {
  constructor(
    private readonly tokens: SessionTokenService,
    private readonly jwt: JwtService,
  ) {}

  @Post('login')
  login() {
    return { access_token: this.tokens.issue(ACCOUNT), user: { id: 7 } };
  }

  @Post('duas')
  two() {
    const first = this.tokens.issue(ACCOUNT);
    const second = this.tokens.issue({ ...ACCOUNT, id: 8 });
    return { access_token: first, second };
  }

  @Post('falha')
  fail() {
    this.tokens.issue(ACCOUNT);
    throw new BadRequestException('Dados inválidos.');
  }

  /** Superpainel abrindo um suporte: a sessão de quem pediu vira a sessão pai. */
  @Post('suporte')
  support(@Req() req: Request) {
    (req as Request & { user: unknown }).user = { id: 1, authSessionId: 33 };
    return {
      access_token: this.jwt.sign(
        {
          sub: 1,
          email: 'ops@x',
          role: UserRole.CLIENT,
          name: 'Ops',
          tv: 0,
          sid: 4,
        },
        { expiresIn: 60 },
      ),
      expires_at: 'x',
    };
  }
}

describe('Emissão de sessão no modo cookie (SessionJwtService + SessionIssuanceInterceptor)', () => {
  let app: INestApplication<App>;
  const saved = {
    JWT_SECRET: process.env.JWT_SECRET,
    APP_WEB_URL: process.env.APP_WEB_URL,
    AUTH_WEB_COOKIE: process.env.AUTH_WEB_COOKIE,
    CORS_ORIGINS: process.env.CORS_ORIGINS,
    AUTH_COOKIE_ORIGINS: process.env.AUTH_COOKIE_ORIGINS,
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    process.env.APP_WEB_URL = WEB;
    delete process.env.AUTH_WEB_COOKIE;
    delete process.env.CORS_ORIGINS;
    delete process.env.AUTH_COOKIE_ORIGINS;
    const moduleRef = await Test.createTestingModule({
      imports: [SessionModule],
      controllers: [EmissionController],
      providers: [
        { provide: AuthSessionsService, useValue: fakeSessions },
        { provide: APP_INTERCEPTOR, useClass: SessionIssuanceInterceptor },
      ],
    }).compile();
    app = setupApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    persisted.length = 0;
    replaced.length = 0;
    failPersistence = false;
    delete process.env.AUTH_WEB_COOKIE;
  });

  const cookieHeaders = { 'X-Auth-Transport': 'cookie', Origin: WEB };

  function setCookies(res: request.Response): string[] {
    const raw: unknown = res.headers['set-cookie'];
    if (Array.isArray(raw)) {
      return raw.filter((line): line is string => typeof line === 'string');
    }
    return typeof raw === 'string' ? [raw] : [];
  }

  it('com o cabeçalho e a origem do site: token de 15 min, refresh no cookie HttpOnly e campos aditivos', async () => {
    const res = await request(app.getHttpServer())
      .post('/emissao/login')
      .set(cookieHeaders)
      .expect(201);
    const body = res.body as Record<string, unknown>;
    expect(body).toEqual({
      access_token: expect.any(String) as unknown,
      user: { id: 7 },
      session_transport: 'cookie',
      expires_in: 900,
    });
    const token = claims(body.access_token as string);
    expect(Number(token.exp) - Number(token.iat)).toBe(900);

    const cookies = setCookies(res);
    expect(cookies).toHaveLength(1);
    const cookie = cookies[0];
    // http de teste: comestra_rt sem Secure; HttpOnly, SameSite=Strict, Path=/ e sem Domain
    expect(cookie).toMatch(
      /^comestra_rt=v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43};/,
    );
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; SameSite=Strict/);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).not.toMatch(/Secure|Domain/i);
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1]);
    expect(maxAge).toBeGreaterThan(604_790);
    expect(maxAge).toBeLessThanOrEqual(604_800);

    const value = /^comestra_rt=([^;]+)/.exec(cookie)![1];
    const [, selector, validator] = value.split('.');
    expect(JSON.stringify(body)).not.toContain(validator);

    // A sessão COOKIE foi gravada antes da resposta, com o hash do validador e a validade da sessão
    expect(persisted).toHaveLength(1);
    expect(persisted[0].responsePending).toBe(true);
    const session = persisted[0].issued[0];
    expect(session).toMatchObject({
      jti: token.jti,
      userId: 7,
      kind: AuthSessionKind.USER,
      transport: AuthSessionTransport.COOKIE,
      parentSessionId: null,
      refresh: {
        selector,
        hash: createHash('sha256').update(validator).digest('hex'),
      },
    });
    const sessionSeconds = (session.expiresAt.getTime() - Date.now()) / 1000;
    expect(sessionSeconds).toBeGreaterThan(604_790);
    expect(sessionSeconds).toBeLessThanOrEqual(604_800);
    // Sem cookie anterior: nada a substituir
    expect(replaced).toEqual([]);
  });

  it('sem o cabeçalho (app mobile, integrações): resposta idêntica à de hoje, sem Set-Cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/emissao/login')
      .set('Origin', WEB)
      .expect(201);
    const body = res.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['access_token', 'user']);
    expect(setCookies(res)).toEqual([]);
    const token = claims(body.access_token as string);
    expect(Number(token.exp) - Number(token.iat)).toBe(7 * 86_400);
    expect(persisted[0].issued[0].transport).toBe(AuthSessionTransport.BEARER);
  });

  it('com o cabeçalho, mas cross-site, de outra origem ou com AUTH_WEB_COOKIE=false: bearer de hoje + session_transport "bearer"', async () => {
    const server = app.getHttpServer();
    const cases: Record<string, string>[] = [
      { ...cookieHeaders, 'Sec-Fetch-Site': 'cross-site' },
      { 'X-Auth-Transport': 'cookie', Origin: 'https://evil.example' },
    ];
    for (const headers of cases) {
      const res = await request(server)
        .post('/emissao/login')
        .set(headers)
        .expect(201);
      expect(res.body).toEqual({
        access_token: expect.any(String) as unknown,
        user: { id: 7 },
        session_transport: 'bearer',
      });
      expect(setCookies(res)).toEqual([]);
    }
    process.env.AUTH_WEB_COOKIE = 'false';
    const off = await request(server)
      .post('/emissao/login')
      .set(cookieHeaders)
      .expect(201);
    expect((off.body as Record<string, unknown>).session_transport).toBe(
      'bearer',
    );
    expect(setCookies(off)).toEqual([]);
    expect(
      persisted.every((entry) =>
        entry.issued.every(
          (session) => session.transport === AuthSessionTransport.BEARER,
        ),
      ),
    ).toBe(true);
  });

  it('handler com erro depois de assinar: nenhum cookie; gravação com falha: 500 sem cookie', async () => {
    const server = app.getHttpServer();
    const failed = await request(server)
      .post('/emissao/falha')
      .set(cookieHeaders)
      .expect(400);
    expect(setCookies(failed)).toEqual([]);
    expect(persisted).toEqual([]);

    failPersistence = true;
    const broken = await request(server)
      .post('/emissao/login')
      .set(cookieHeaders)
      .expect(500);
    expect(setCookies(broken)).toEqual([]);
    expect(JSON.stringify(broken.body)).not.toContain('access_token');
  });

  it('o navegador já tinha um cookie: a sessão dele é encerrada depois da gravação da nova', async () => {
    const res = await request(app.getHttpServer())
      .post('/emissao/login')
      .set(cookieHeaders)
      .set('Cookie', 'tema=escuro; comestra_rt=v1.antigo.valor')
      .expect(201);
    expect(setCookies(res)).toHaveLength(1);
    expect(replaced).toEqual([
      { cookie: 'v1.antigo.valor', keep: [persisted[0].issued[0].jti] },
    ]);
  });

  it('sessão de suporte (sid): sempre bearer, nunca cookie, com a sessão do superadmin como pai', async () => {
    const res = await request(app.getHttpServer())
      .post('/emissao/suporte')
      .set(cookieHeaders)
      .expect(201);
    expect(setCookies(res)).toEqual([]);
    expect(res.body).toEqual({
      access_token: expect.any(String) as unknown,
      expires_at: 'x',
    });
    expect(persisted[0].issued[0]).toMatchObject({
      kind: AuthSessionKind.SUPPORT,
      supportSessionId: 4,
      transport: AuthSessionTransport.BEARER,
      parentSessionId: 33,
    });
  });

  it('dois tokens na mesma requisição: só o primeiro vira sessão em cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/emissao/duas')
      .set(cookieHeaders)
      .expect(201);
    expect(setCookies(res)).toHaveLength(1);
    expect(persisted[0].issued.map((session) => session.transport)).toEqual([
      AuthSessionTransport.COOKIE,
      AuthSessionTransport.BEARER,
    ]);
    expect((res.body as Record<string, unknown>).session_transport).toBe(
      'cookie',
    );
  });
});
