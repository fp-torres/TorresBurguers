import { Body, Controller, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { brotliCompressSync, deflateSync, gzipSync } from 'zlib';
import { setupApp } from './app-setup';

/** Pasta do pacote (o package.json nem sempre é exportado, ex.: sharp 0.35). */
function packageDir(name: string, paths: string[]): string {
  let dir = dirname(require.resolve(name, { paths }));
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (
      existsSync(manifest) &&
      (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name ===
        name
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`package.json de ${name} não achado`);
    dir = parent;
  }
}

/** Versão instalada de um pacote, resolvido a partir de quem realmente o carrega. */
function installedVersion(name: string, from: string[] = []): string {
  let paths = [__dirname];
  for (const parent of from) paths = [packageDir(parent, paths)];
  const manifest = join(packageDir(name, paths), 'package.json');
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string })
    .version;
}

/** a >= b em semver simples (x.y.z, sem pré-release). */
function atLeast(version: string, floor: string): boolean {
  const a = version.split('-')[0].split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

@Controller('eco')
class EchoController {
  @Post()
  echo(@Body() body: unknown) {
    return { body };
  }
}

describe('Dependências do processamento de requisições (versões corrigidas)', () => {
  // Cada piso é a primeira versão sem a falha alcançável pela API (revisão de segurança, rodada 2)
  const floors: Array<[string, string, string[], string]> = [
    [
      'body-parser',
      '2.4.0',
      ['@nestjs/platform-express', 'express'],
      'GHSA-27r3-jxmh-p828: corpo comprimido com bytes extras derruba o processo',
    ],
    [
      'proxy-addr',
      '2.0.8',
      ['@nestjs/platform-express', 'express'],
      'GHSA-jqcg-44mw-7w3h: sub-rede IPv4-mapeada do TRUST_PROXY confia em qualquer IP',
    ],
    [
      'multer',
      '2.5.0',
      ['@nestjs/platform-express'],
      'GHSA-wc9g/5528/535w/q7qp: nomes de campo multipart derrubam ou travam o processo',
    ],
    [
      'sharp',
      '0.35.5',
      [],
      'GHSA-f88m/rgj7/wq5f: libvips/libheif/librsvg empacotados',
    ],
  ];

  it.each(floors)('%s >= %s', (name, floor, from, reason) => {
    const version = installedVersion(name, from);
    expect({ name, version, ok: atLeast(version, floor), reason }).toEqual({
      name,
      version,
      ok: true,
      reason,
    });
  });

  it('comparação de versões', () => {
    expect(atLeast('2.2.2', '2.4.0')).toBe(false);
    expect(atLeast('2.0.7', '2.0.8')).toBe(false);
    expect(atLeast('0.34.5', '0.35.5')).toBe(false);
    expect(atLeast('2.4.0', '2.4.0')).toBe(true);
    expect(atLeast('3.0.0', '2.5.0')).toBe(true);
  });
});

describe('Corpo comprimido malformado (antes de rotas e guards)', () => {
  let app: INestApplication<App>;
  let server: App;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EchoController],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    setupApp(app);
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  const compressors: Array<[string, (input: Buffer) => Buffer]> = [
    ['gzip', (input) => gzipSync(input)],
    ['deflate', (input) => deflateSync(input)],
    ['br', (input) => brotliCompressSync(input)],
  ];

  it.each(compressors)(
    '%s válido + bytes extras: responde sem 5xx e a API segue no ar',
    async (encoding, compress) => {
      const body = Buffer.concat([
        compress(Buffer.from('{"email":"a@b.c","password":"x"}')),
        Buffer.from('bytes-extras-depois-do-frame'),
      ]);
      const res = await request(server)
        .post('/eco')
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', encoding)
        .send(body);
      expect(res.status).toBeLessThan(500);

      // O processo não caiu: a próxima requisição é atendida normalmente
      await request(server)
        .post('/eco')
        .send({ ok: true })
        .expect(201, { body: { ok: true } });
    },
  );
});
