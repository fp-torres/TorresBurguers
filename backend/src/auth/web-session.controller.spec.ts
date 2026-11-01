import { ConflictException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { setupApp } from '../config/app-setup';
import { WebSessionController } from './web-session.controller';
import {
  RefreshRejectedException,
  SUPPORT_SESSION_OPEN_MESSAGE,
  WebSessionService,
} from './web-session.service';

const WEB = 'http://web.test:5173';

function setCookies(res: request.Response): string[] {
  const raw: unknown = res.headers['set-cookie'];
  if (Array.isArray(raw)) {
    return raw.filter((line): line is string => typeof line === 'string');
  }
  return typeof raw === 'string' ? [raw] : [];
}

describe('WebSessionController (/auth/web)', () => {
  let app: INestApplication<App>;
  let server: App;
  const savedWeb = process.env.APP_WEB_URL;
  const webSessions = {
    refresh: jest.fn(),
    logout: jest.fn().mockResolvedValue(undefined),
  };
  const body = {
    access_token: 'jwt',
    expires_in: 900,
    user: { id: 7 },
    session_transport: 'cookie',
  };

  beforeAll(async () => {
    process.env.APP_WEB_URL = WEB;
    const moduleRef = await Test.createTestingModule({
      controllers: [WebSessionController],
      providers: [{ provide: WebSessionService, useValue: webSessions }],
    }).compile();
    app = setupApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
    if (savedWeb === undefined) delete process.env.APP_WEB_URL;
    else process.env.APP_WEB_URL = savedWeb;
  });
  beforeEach(() => jest.clearAllMocks());

  const valid = { 'X-Auth-Transport': 'cookie', Origin: WEB };

  it('403 sem o cabeçalho, com origem fora da lista ou cross-site (o app mobile nunca chega ao cookie)', async () => {
    for (const headers of [
      {},
      { Origin: WEB },
      { 'X-Auth-Transport': 'cookie', Origin: 'https://evil.example' },
      { ...valid, 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      for (const path of ['/auth/web/refresh', '/auth/web/logout']) {
        const res = await request(server).post(path).set(headers).expect(403);
        expect((res.body as { message: string }).message).toBe(
          'Origem não autorizada para a sessão deste navegador.',
        );
        expect(setCookies(res)).toEqual([]);
      }
    }
    expect(webSessions.refresh).not.toHaveBeenCalled();
    expect(webSessions.logout).not.toHaveBeenCalled();
  });

  it('refresh 200: corpo da renovação, Set-Cookie rotacionado e sem cache; na tolerância, sem Set-Cookie', async () => {
    webSessions.refresh.mockResolvedValueOnce({
      body,
      rotated: {
        token: 'v1.novo.valor',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const rotated = await request(server)
      .post('/auth/web/refresh')
      .set(valid)
      .expect(200);
    expect(rotated.body).toEqual(body);
    expect(rotated.headers['cache-control']).toBe('no-store');
    expect(setCookies(rotated)).toEqual([
      expect.stringMatching(
        /^comestra_rt=v1\.novo\.valor; Max-Age=\d+; Path=\/; Expires=.+; HttpOnly; SameSite=Strict$/,
      ),
    ]);

    webSessions.refresh.mockResolvedValueOnce({ body, rotated: null });
    const grace = await request(server)
      .post('/auth/web/refresh')
      .set(valid)
      .expect(200);
    expect(setCookies(grace)).toEqual([]);
  });

  it('refresh 401: mensagem de sessão e cookie apagado; 409 do suporte: cookie mantido', async () => {
    webSessions.refresh.mockRejectedValueOnce(new RefreshRejectedException());
    const rejected = await request(server)
      .post('/auth/web/refresh')
      .set(valid)
      .expect(401);
    expect(rejected.body).toEqual({
      statusCode: 401,
      message: 'Sessão inválida ou expirada. Faça login novamente.',
      error: 'Unauthorized',
    });
    expect(setCookies(rejected)).toEqual([
      expect.stringMatching(/^comestra_rt=; Path=\/; Expires=Thu, 01 Jan 1970/),
    ]);

    webSessions.refresh.mockRejectedValueOnce(
      new ConflictException(SUPPORT_SESSION_OPEN_MESSAGE),
    );
    const support = await request(server)
      .post('/auth/web/refresh')
      .set(valid)
      .expect(409);
    expect((support.body as { message: string }).message).toBe(
      SUPPORT_SESSION_OPEN_MESSAGE,
    );
    expect(setCookies(support)).toEqual([]);
  });

  it('logout: sempre 204 apagando o cookie, com ou sem cookie (idempotente)', async () => {
    for (let i = 0; i < 2; i++) {
      const res = await request(server)
        .post('/auth/web/logout')
        .set(valid)
        .set('Cookie', 'comestra_rt=v1.a.b')
        .expect(204);
      expect(setCookies(res)).toEqual([
        expect.stringMatching(
          /^comestra_rt=; Path=\/; Expires=Thu, 01 Jan 1970/,
        ),
      ]);
    }
    await request(server).post('/auth/web/logout').set(valid).expect(204);
    expect(webSessions.logout).toHaveBeenCalledTimes(3);
  });

  it('preflight: a origem do site recebe credenciais e a origem exata; outra origem não', async () => {
    const allowed = await request(server)
      .options('/auth/web/refresh')
      .set('Origin', WEB)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-auth-transport')
      .expect(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(WEB);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(allowed.headers['access-control-allow-headers']).toBe(
      'x-auth-transport',
    );
    expect(allowed.headers['access-control-max-age']).toBe('600');

    const other = await request(server)
      .options('/auth/web/refresh')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-auth-transport');
    expect(other.headers['access-control-allow-credentials']).toBeUndefined();
  });
});
