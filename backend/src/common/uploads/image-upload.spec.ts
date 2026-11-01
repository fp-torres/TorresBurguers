import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  INestApplication,
  Injectable,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  RateLimitService,
  TOO_MANY_ATTEMPTS_MESSAGE,
} from '../rate-limit/rate-limit.service';
import {
  ImageFileInterceptor,
  MULTIPART_FIELD_NAME_MESSAGE,
  MULTIPART_LIMIT_MESSAGE,
} from './image-upload';

// PNG 1x1 válido
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

/** A conta da requisição vem do cabeçalho x-user-id (cada teste usa a sua: limites independentes). */
@Injectable()
class FakeUserGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();
    const id = Number(req.headers['x-user-id']);
    req.user = id ? { id } : null;
    return true;
  }
}

@Controller('teste-upload')
class TestUploadController {
  @Post()
  @UseGuards(FakeUserGuard)
  @UseInterceptors(ImageFileInterceptor('file'))
  receber(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    return { file: Boolean(file), fields: Object.keys(body ?? {}) };
  }
}

const bodyOf = (res: request.Response) =>
  res.body as { message?: string; file?: boolean; fields?: string[] };

/** Multipart montado à mão: nomes de campo exatamente como um atacante enviaria. */
function rawMultipart(fields: Array<[string, string]>): {
  type: string;
  body: Buffer;
} {
  const boundary = '----comestra-teste';
  const parts = fields.map(
    ([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  return {
    type: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.from(`${parts.join('')}--${boundary}--\r\n`),
  };
}

describe('ImageFileInterceptor (multipart malicioso e limite UPLOAD)', () => {
  let app: INestApplication<App>;
  let server: App;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TestUploadController],
      providers: [RateLimitService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  const send = (userId: number, form: { type: string; body: Buffer }) =>
    request(server)
      .post('/teste-upload')
      .set('x-user-id', String(userId))
      .set('Content-Type', form.type)
      .send(form.body);

  it('índice de array gigante no nome do campo → 400 na hora (sem travar o event loop)', async () => {
    // GHSA-535w-7cp7-47q4: x[4294967294] cria um array esparso enorme e x[k] o percorre inteiro
    const started = Date.now();
    const res = await send(
      9001,
      rawMultipart([
        ['x[4294967294]', 'a'],
        ['x[k]', 'b'],
      ]),
    ).expect(400);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(bodyOf(res).message).toBe(MULTIPART_FIELD_NAME_MESSAGE);
  });

  it('nome de campo que estouraria o tamanho do array → 400 (multer < 2.3 derrubava o processo)', async () => {
    const res = await send(
      9002,
      rawMultipart([
        ['x[4294967294]', 'a'],
        ['x[]', 'b'],
      ]),
    ).expect(400);
    expect(bodyOf(res).message).toBe(MULTIPART_FIELD_NAME_MESSAGE);
  });

  it('aninhamento profundo no nome do campo → 400', async () => {
    const res = await send(9003, rawMultipart([['a[b][c][d]', 'x']])).expect(
      400,
    );
    expect(bodyOf(res).message).toBe(MULTIPART_FIELD_NAME_MESSAGE);
  });

  it('formulários legítimos continuam aceitos: campos simples repetidos, índices pequenos e um nível de objeto', async () => {
    const res = await request(server)
      .post('/teste-upload')
      .set('x-user-id', '9004')
      .field('name', 'X-Burger')
      .field('ingredients', 'pão')
      .field('ingredients', 'queijo')
      .field('allowed_addons_ids[0]', '1')
      .field('allowed_addons_ids[299]', '2')
      .field('address[street]', 'Rua A')
      .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })
      .expect(201);
    expect(bodyOf(res)).toEqual({
      file: true,
      fields: ['name', 'ingredients', 'allowed_addons_ids', 'address'],
    });
  });

  it('o servidor segue respondendo depois dos ataques', async () => {
    await request(server)
      .post('/teste-upload')
      .set('x-user-id', '9005')
      .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })
      .expect(201);
  });

  describe('limite UPLOAD', () => {
    beforeEach(() => {
      process.env.RATE_LIMIT_UPLOAD = '2/600';
    });
    afterEach(() => {
      delete process.env.RATE_LIMIT_UPLOAD;
    });

    it('multipart que falha no parse também conta: tentativas malformadas não escapam do limite', async () => {
      for (let i = 0; i < 2; i++) {
        const res = await send(9101, rawMultipart([['a[b][c][d]', 'x']]));
        expect(res.status).toBe(400);
      }
      const limited = await request(server)
        .post('/teste-upload')
        .set('x-user-id', '9101')
        .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })
        .expect(429);
      expect(bodyOf(limited).message).toBe(TOO_MANY_ATTEMPTS_MESSAGE);
    });

    it('formulário com campos demais também conta', async () => {
      const fields: Array<[string, string]> = Array.from(
        { length: 400 },
        (_, i) => [`f${i}`, 'a'],
      );
      for (let i = 0; i < 2; i++) {
        const res = await send(9102, rawMultipart(fields)).expect(400);
        expect(bodyOf(res).message).toBe(MULTIPART_LIMIT_MESSAGE);
      }
      await send(9102, rawMultipart([['name', 'ok']])).expect(429);
    });

    it('formulário válido SEM imagem não conta (ex.: editar um produto sem trocar a foto)', async () => {
      for (let i = 0; i < 3; i++) {
        const res = await send(9103, rawMultipart([['name', 'ok']])).expect(
          201,
        );
        expect(bodyOf(res).file).toBe(false);
      }
      for (let i = 0; i < 2; i++) {
        await request(server)
          .post('/teste-upload')
          .set('x-user-id', '9103')
          .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })
          .expect(201);
      }
      await request(server)
        .post('/teste-upload')
        .set('x-user-id', '9103')
        .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })
        .expect(429);
    });

    it('o 429 da própria contagem não é contado duas vezes nem vira outro erro', async () => {
      const rateLimit = app.get(RateLimitService);
      const consume = jest.spyOn(rateLimit, 'consume');
      try {
        for (let i = 0; i < 2; i++) {
          await request(server)
            .post('/teste-upload')
            .set('x-user-id', '9104')
            .attach('file', PNG, {
              filename: 'a.png',
              contentType: 'image/png',
            })
            .expect(201);
        }
        await request(server)
          .post('/teste-upload')
          .set('x-user-id', '9104')
          .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })
          .expect(429);
        expect(consume).toHaveBeenCalledTimes(2);
      } finally {
        consume.mockRestore();
      }
    });
  });
});
