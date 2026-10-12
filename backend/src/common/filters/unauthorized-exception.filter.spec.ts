import {
  Controller,
  ForbiddenException,
  Get,
  INestApplication,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthGuard, PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { JwtStrategy } from '../../auth/jwt.strategy';
import { setupApp } from '../../config/app-setup';
import { UserRole } from '../../users/entities/user.entity';
import { UsersService } from '../../users/users.service';
import {
  SESSION_EXPIRED_MESSAGE,
  unauthorizedBody,
} from './unauthorized-exception.filter';

const SECRET = 'segredo-de-teste-do-filtro-com-32-caracteres';

@Controller('teste')
class TestController {
  @Get('protegida')
  @UseGuards(AuthGuard('jwt'))
  protegida() {
    return { ok: true };
  }

  @Post('login')
  login() {
    throw new UnauthorizedException('Email ou senha inválidos');
  }

  @Get('proibida')
  proibida() {
    throw new ForbiddenException('Sem permissão.');
  }
}

const SESSION_BODY = {
  statusCode: 401,
  message: SESSION_EXPIRED_MESSAGE,
  error: 'Unauthorized',
};

describe('UnauthorizedExceptionFilter (todo 401 no formato do contrato)', () => {
  const originalSecret = process.env.JWT_SECRET;
  let app: INestApplication<App>;
  let server: App;
  const users = { findActiveById: jest.fn() };

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [TestController],
      providers: [JwtStrategy, { provide: UsersService, useValue: users }],
    }).compile();

    app = setupApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  beforeEach(() => jest.clearAllMocks());

  const tokenFor = (sub: number) =>
    new JwtService({ secret: SECRET }).sign({
      sub,
      email: 'maria@email.com',
      role: UserRole.CLIENT,
      name: 'Maria',
    });

  it('sem token → mensagem de sessão em português, com o campo error', async () => {
    const res = await request(server).get('/teste/protegida').expect(401);
    expect(res.body).toEqual(SESSION_BODY);
  });

  it('token inválido, de outro segredo ou sem "Bearer" → mesmo formato', async () => {
    const foreign = new JwtService({ secret: 'outro-segredo' }).sign({
      sub: 1,
    });
    for (const authorization of [
      'Bearer token-invalido',
      `Bearer ${foreign}`,
      tokenFor(1), // sem o prefixo
    ]) {
      const res = await request(server)
        .get('/teste/protegida')
        .set('Authorization', authorization)
        .expect(401);
      expect(res.body).toEqual(SESSION_BODY);
    }
    expect(users.findActiveById).not.toHaveBeenCalled();
  });

  it('token válido de conta excluída → mesmo formato', async () => {
    users.findActiveById.mockResolvedValueOnce(null);
    const res = await request(server)
      .get('/teste/protegida')
      .set('Authorization', `Bearer ${tokenFor(7)}`)
      .expect(401);
    expect(res.body).toEqual(SESSION_BODY);
  });

  it('token válido de conta ativa passa', async () => {
    users.findActiveById.mockResolvedValueOnce({
      id: 7,
      email: 'maria@email.com',
      role: UserRole.CLIENT,
      name: 'Maria',
    });
    await request(server)
      .get('/teste/protegida')
      .set('Authorization', `Bearer ${tokenFor(7)}`)
      .expect(200, { ok: true });
  });

  it('senha errada no login mantém a própria mensagem e ganha o campo error', async () => {
    const res = await request(server).post('/teste/login').expect(401);
    expect(res.body).toEqual({
      statusCode: 401,
      message: 'Email ou senha inválidos',
      error: 'Unauthorized',
    });
  });

  it('outros erros não passam pelo filtro', async () => {
    const res = await request(server).get('/teste/proibida').expect(403);
    expect(res.body).toEqual({
      statusCode: 403,
      message: 'Sem permissão.',
      error: 'Forbidden',
    });
  });

  it('unauthorizedBody: 401 genérico (inglês ou vazio) vira a mensagem de sessão', () => {
    expect(unauthorizedBody(new UnauthorizedException())).toEqual(SESSION_BODY);
    expect(
      unauthorizedBody(
        new UnauthorizedException({ statusCode: 401, message: '' }),
      ),
    ).toEqual(SESSION_BODY);
    expect(
      unauthorizedBody(new UnauthorizedException('Sessão encerrada.')),
    ).toEqual({ ...SESSION_BODY, message: 'Sessão encerrada.' });
  });
});
