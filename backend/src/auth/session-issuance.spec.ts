import {
  BadRequestException,
  Controller,
  Get,
  INestApplication,
  Post,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { setupApp } from '../config/app-setup';
import { UserRole } from '../users/entities/user.entity';
import { AuthSessionsService } from './auth-sessions.service';
import { AuthSessionKind } from './entities/auth-session.entity';
import { SessionIssuanceInterceptor } from './session-issuance.interceptor';
import type { IssuedSession, SessionScope } from './session-scope';
import { SessionModule } from './session.module';
import {
  SessionJwtService,
  SessionTokenService,
} from './session-token.service';

const SECRET = 'segredo-de-teste-das-sessoes';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ACCOUNT = {
  id: 7,
  email: 'maria@email.com',
  role: UserRole.CLIENT,
  name: 'Maria',
  token_version: 2,
};

function claims(token: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
}

/** Gravações feitas pelo interceptor: o que foi gravado e se a resposta ainda não tinha saído. */
interface Persisted {
  issued: IssuedSession[];
  ip: string | undefined;
  responsePending: boolean;
}

const persisted: Persisted[] = [];
let failPersistence = false;

const fakeSessions = {
  async persistIssued(scope: SessionScope): Promise<void> {
    if (scope.issued.length === 0) return;
    // Demora de propósito: a resposta precisa esperar a gravação
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (failPersistence) throw new Error('banco fora do ar');
    const response = (
      scope.request as unknown as { res?: { headersSent: boolean } }
    )?.res;
    persisted.push({
      issued: scope.issued.splice(0),
      ip: scope.request?.ip,
      responsePending: response ? !response.headersSent : false,
    });
  },
};

@Controller('tokens')
class TokensController {
  constructor(
    private readonly jwt: JwtService,
    private readonly tokens: SessionTokenService,
  ) {}

  /** Login: o token é assinado depois de operações assíncronas (o escopo acompanha a requisição). */
  @Post('login')
  async login() {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await Promise.resolve();
    return { access_token: this.tokens.issue(ACCOUNT) };
  }

  /** Sessão de suporte: assinada direto no JwtService, com validade própria (como o superpainel). */
  @Post('suporte')
  support() {
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
    };
  }

  /** Assina e falha depois: o token não sai e a sessão não é gravada. */
  @Post('falha')
  fail() {
    this.tokens.issue(ACCOUNT);
    throw new BadRequestException('Dados inválidos.');
  }

  /** Outros usos do JwtService (sem "sub" de conta) não viram sessão. */
  @Get('outro')
  other() {
    return { value: this.jwt.sign({ purpose: 'teste' }) };
  }
}

describe('Sessões dos tokens emitidos (SessionJwtService + SessionIssuanceInterceptor)', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;
  const originalSecret = process.env.JWT_SECRET;

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    const moduleRef = await Test.createTestingModule({
      imports: [SessionModule],
      controllers: [TokensController],
      providers: [
        { provide: AuthSessionsService, useValue: fakeSessions },
        { provide: APP_INTERCEPTOR, useClass: SessionIssuanceInterceptor },
      ],
    }).compile();
    jwt = moduleRef.get(JwtService);
    app = setupApp(moduleRef.createNestApplication());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  beforeEach(() => {
    persisted.length = 0;
    failPersistence = false;
  });

  it('o JwtService exportado pelo SessionModule é o das sessões', () => {
    expect(jwt).toBeInstanceOf(SessionJwtService);
  });

  it('login: o token leva um jti (UUID) e a sessão é gravada ANTES de a resposta sair', async () => {
    const res = await request(app.getHttpServer())
      .post('/tokens/login')
      .expect(201);
    const token = (res.body as { access_token: string }).access_token;
    const payload = claims(token);

    expect(payload).toMatchObject({ sub: 7, tv: 2 });
    expect(payload.jti).toMatch(UUID);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].responsePending).toBe(true);
    expect(persisted[0].issued).toEqual([
      {
        jti: payload.jti,
        userId: 7,
        kind: AuthSessionKind.USER,
        supportSessionId: null,
        tokenVersion: 2,
        expiresAt: new Date((payload.exp as number) * 1000),
        // Sem X-Auth-Transport: sessão BEARER, como antes (o token só fica em memória no escopo)
        transport: 'BEARER',
        parentSessionId: null,
        accessToken: token,
      },
    ]);
  });

  it('sessão de suporte: kind SUPPORT com a sessão de suporte e a validade do próprio token', async () => {
    const res = await request(app.getHttpServer())
      .post('/tokens/suporte')
      .expect(201);
    const payload = claims((res.body as { access_token: string }).access_token);

    expect(payload).toMatchObject({ sub: 1, sid: 4 });
    expect((payload.exp as number) - (payload.iat as number)).toBe(60);
    expect(persisted[0].issued).toEqual([
      expect.objectContaining({
        jti: payload.jti,
        userId: 1,
        kind: AuthSessionKind.SUPPORT,
        supportSessionId: 4,
        tokenVersion: 0,
      }),
    ]);
  });

  it('requisições simultâneas: cada uma grava só a sessão do próprio token', async () => {
    const server = app.getHttpServer();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => request(server).post('/tokens/login')),
    );
    const jtis = responses.map(
      (res) => claims((res.body as { access_token: string }).access_token).jti,
    );
    expect(new Set(jtis).size).toBe(5);
    expect(persisted).toHaveLength(5);
    expect(persisted.every((entry) => entry.issued.length === 1)).toBe(true);
    expect(persisted.map((entry) => entry.issued[0].jti).sort()).toEqual(
      [...jtis].sort(),
    );
  });

  it('rota que falha depois de assinar: nenhuma sessão gravada; falha ao gravar: 500 sem token', async () => {
    const server = app.getHttpServer();
    await request(server).post('/tokens/falha').expect(400);
    expect(persisted).toEqual([]);

    failPersistence = true;
    const res = await request(server).post('/tokens/login').expect(500);
    expect(JSON.stringify(res.body)).not.toContain('access_token');
  });

  it('JwtService para outro fim (sem conta em "sub"): sem jti e sem sessão', async () => {
    const res = await request(app.getHttpServer())
      .get('/tokens/outro')
      .expect(200);
    expect(claims((res.body as { value: string }).value)).not.toHaveProperty(
      'jti',
    );
    expect(persisted).toEqual([]);
  });

  it('fora de uma requisição (comandos, testes): token como antes, sem jti', () => {
    const token = new SessionTokenService(jwt).issue(ACCOUNT);
    expect(claims(token)).not.toHaveProperty('jti');
    expect(jwt.verify(token)).toMatchObject({ sub: 7 });
  });

  it('signAsync segue a mesma regra do sign', async () => {
    const token = await jwt.signAsync({ sub: 7, tv: 0 });
    expect(claims(token)).toMatchObject({ sub: 7 });
    expect(claims(token)).not.toHaveProperty('jti');
  });
});
