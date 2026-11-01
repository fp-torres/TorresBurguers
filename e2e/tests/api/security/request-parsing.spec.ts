import { test, expect, type APIRequestContext } from '@playwright/test';
import { brotliCompressSync, deflateSync, gzipSync } from 'zlib';
import { body } from '../../../support/api';

/**
 * Corpos forjados que a API lê ANTES de rotas, guards e limites (revisão de segurança, rodada 2):
 * nenhum deles pode derrubar ou travar o processo — que é um só para todas as lojas.
 */

const FIELD_NAME_MESSAGE = 'Formulário inválido: nome de campo não aceito.';

async function expectApiAlive(request: APIRequestContext) {
  const res = await request.get('/health');
  expect(res.status(), 'a API continua no ar').toBe(200);
}

/** Multipart montado à mão, com os nomes de campo exatamente como um atacante enviaria. */
function rawMultipart(fields: Array<[string, string]>) {
  const boundary = '----comestra-e2e-seguranca';
  const parts = fields.map(
    ([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  return {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    data: Buffer.from(`${parts.join('')}--${boundary}--\r\n`),
  };
}

test.describe('Corpo comprimido com bytes extras (body-parser >= 2.4.0)', () => {
  const compressors: Array<[string, (input: Buffer) => Buffer]> = [
    ['gzip', (input) => gzipSync(input)],
    ['deflate', (input) => deflateSync(input)],
    ['br', (input) => brotliCompressSync(input)],
  ];

  for (const [encoding, compress] of compressors) {
    test(`POST /auth/login anônimo com ${encoding} + lixo depois do frame → sem 5xx e a API segue no ar`, async ({ request }) => {
      const data = Buffer.concat([
        compress(Buffer.from(JSON.stringify({ email: 'ninguem@e2e.test', password: 'Errada@123' }))),
        Buffer.from('bytes-extras-depois-do-frame'),
      ]);
      const res = await request.post('/auth/login', {
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': encoding },
        data,
      });
      expect(res.status(), JSON.stringify(await body(res))).toBeLessThan(500);
      await expectApiAlive(request);
    });
  }
});

test.describe('Multipart com nomes de campo forjados (multer >= 2.5.0 + limites da API)', () => {
  test('cadastro anônimo (POST /users) com índice de array gigante → 400 na hora, sem travar a API', async ({ request }) => {
    // GHSA-535w-7cp7-47q4: x[4294967294] cria um array enorme e x[k] o percorre inteiro (minutos de CPU)
    const started = Date.now();
    const res = await request.post(
      '/users',
      rawMultipart([
        ['x[4294967294]', 'a'],
        ['x[k]', 'b'],
      ]),
    );
    expect(res.status(), JSON.stringify(await body(res))).toBe(400);
    expect((await body(res)).message).toBe(FIELD_NAME_MESSAGE);
    expect(Date.now() - started, 'respondeu sem travar o event loop').toBeLessThan(5000);
    await expectApiAlive(request);
  });

  test('cadastro anônimo com nome que estouraria o tamanho do array → 400 (antes derrubava o processo)', async ({ request }) => {
    const res = await request.post(
      '/users',
      rawMultipart([
        ['x[4294967294]', 'a'],
        ['x[]', 'b'],
      ]),
    );
    expect(res.status(), JSON.stringify(await body(res))).toBe(400);
    expect((await body(res)).message).toBe(FIELD_NAME_MESSAGE);
    await expectApiAlive(request);
  });

  test('aninhamento profundo no nome do campo → 400', async ({ request }) => {
    const res = await request.post('/users', rawMultipart([['a[b][c][d]', 'x']]));
    expect(res.status(), JSON.stringify(await body(res))).toBe(400);
    expect((await body(res)).message).toBe(FIELD_NAME_MESSAGE);
    await expectApiAlive(request);
  });
});
