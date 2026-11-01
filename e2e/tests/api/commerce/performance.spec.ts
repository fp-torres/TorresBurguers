import { test, expect } from '@playwright/test';
import { uid } from '../../../support/api';
import {
  Actors,
  PNG_1PX,
  advance,
  createAddress,
  createProduct,
  expectStatus,
  placeOrder,
  type Actor,
  type Json,
} from './helpers';

/**
 * Desempenho (leva 9): o quadro de pedidos reaproveita a resposta montada sem servir dado velho, a API
 * comprime o JSON, /uploads tem cache longo e o corpo JSON tem teto. As regras finas têm testes
 * unitários; aqui vale o comportamento da API de verdade.
 */
test.describe('Desempenho: quadro em cache, compressão, cache de /uploads e teto do corpo', () => {
  const actors = new Actors();
  let admin: Actor;
  let kitchen: Actor;
  let client: Actor;
  let product: Json;
  let address: Json;

  test.beforeAll(async () => {
    admin = await actors.defaultUser('admin');
    kitchen = await actors.defaultUser('kitchen');
    client = await actors.newClient('Cliente Desempenho');
    product = await createProduct(admin.ctx, { name: `Desempenho ${uid('pf')}`, price: 19.9 });
    address = await createAddress(client.ctx, 'Centro');
  });

  test.afterAll(async () => {
    await actors.dispose();
  });

  const board = async (actor: Actor): Promise<Json[]> => {
    const res = await actor.ctx.get('/orders?scope=active');
    await expectStatus(res, 200);
    return res.json();
  };

  test('quadro: polls seguidos devolvem o mesmo conteúdo, e um pedido novo ou uma mudança de status aparece no poll seguinte', async () => {
    const first = await board(admin);
    expect(await board(admin)).toEqual(first);

    const order = await placeOrder(client.ctx, {
      items: [{ productId: product.id, quantity: 2 }],
      type: 'DELIVERY',
      addressId: address.id,
      paymentMethod: 'MONEY',
    });
    const withNew = await board(admin);
    expect(withNew.find((item) => item.id === order.id)).toMatchObject({ status: 'PENDING' });

    // A cozinha (outro formato de resposta) vê o mesmo pedido; a mudança dela aparece no quadro da gestão
    expect((await board(kitchen)).find((item) => item.id === order.id)).toMatchObject({ status: 'PENDING' });
    await advance(kitchen.ctx, order.id, 'PREPARING');
    expect((await board(admin)).find((item) => item.id === order.id)).toMatchObject({ status: 'PREPARING' });
    expect((await board(kitchen)).find((item) => item.id === order.id)).toMatchObject({ status: 'PREPARING' });
    // O formato de cada perfil continua o dele (a cozinha não recebe o contato completo do cliente)
    const kitchenView = (await board(kitchen)).find((item) => item.id === order.id);
    expect(Object.keys(kitchenView.user).sort()).toEqual(['id', 'name']);
  });

  test('JSON comprimido quando o cliente aceita (mesmo conteúdo); ETag continua valendo (304)', async () => {
    const plain = await admin.ctx.get('/orders?scope=active', { headers: { 'Accept-Encoding': 'identity' } });
    await expectStatus(plain, 200);
    expect(plain.headers()['content-encoding']).toBeUndefined();

    const gzip = await admin.ctx.get('/orders?scope=active', { headers: { 'Accept-Encoding': 'gzip' } });
    await expectStatus(gzip, 200);
    // Respostas pequenas (abaixo de 1 KB) saem sem compressão
    const expected = await plain.json();
    if (JSON.stringify(expected).length > 1024) expect(gzip.headers()['content-encoding']).toBe('gzip');
    expect(gzip.headers().vary).toMatch(/Accept-Encoding/i);
    expect(await gzip.json()).toEqual(expected);

    const etag = gzip.headers().etag;
    expect(etag).toBeTruthy();
    const again = await admin.ctx.get('/orders?scope=active', {
      headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': etag },
    });
    expect(again.status()).toBe(304);
  });

  test('/uploads: imagem com cache longo e imutável (nome único)', async () => {
    const upload = await admin.ctx.post('/uploads', {
      multipart: { file: { name: 'foto.png', mimeType: 'image/png', buffer: PNG_1PX } },
    });
    await expectStatus(upload, 201);
    const { filename } = await upload.json();
    const res = await admin.ctx.get(`/uploads/${filename}`);
    await expectStatus(res, 200);
    expect(res.headers()['cache-control']).toBe('public, max-age=2592000, immutable');
    // Imagem (já comprimida) não é comprimida de novo
    expect(res.headers()['content-encoding']).toBeUndefined();
  });

  test('corpo JSON acima de 100 KB → 413 antes de chegar à rota', async () => {
    const res = await client.ctx.post('/addresses', {
      data: { nickname: 'x'.repeat(120 * 1024) },
    });
    expect(res.status()).toBe(413);
  });
});
