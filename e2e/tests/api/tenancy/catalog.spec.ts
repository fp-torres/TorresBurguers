import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { loginAs } from '../../../support/api';
import {
  Cleanup,
  MISSING_ID,
  MSG,
  addAddon,
  addProduct,
  bearer,
  createStore,
  demoStore,
  demoTeam,
  expectAllFromStore,
  expectError,
  expectNoneOf,
  expectStatus,
  expectUniform404,
  getJson,
  ids,
  newApi,
  newCustomer,
  retireStore,
  storePath,
  trashAddon,
  trashProduct,
  trashProductLater,
  uid,
  uploadImage,
  type Json,
  type Member,
  type PublicStore,
  type Session,
  type Team,
  type TenantStore,
} from './helpers';

/**
 * Seção 16 do pedido — "A loja A não consegue consultar os produtos privados da loja B".
 * Loja A = loja demo (equipe padrão); loja B = criada pelo superpainel neste arquivo, com cardápio
 * próprio: produtos e adicionais públicos, indisponíveis, na lixeira, em promoção e com imagem.
 */
test.describe('Isolamento entre lojas: cardápio (produtos, adicionais, promoções e imagens)', () => {
  const cleanup = new Cleanup();
  let api: APIRequestContext;
  let superadmin: Session;
  let demo: PublicStore;
  let teamA: Team;
  let storeB: TenantStore;
  let client: Member;

  let addonB: Json;
  let addonBHidden: Json;
  let addonBTrashed: Json;
  let productB: Json;
  let productBPromo: Json;
  let productBHidden: Json;
  let productBTrashed: Json;
  let productBImage: Json;
  let imageB: string;

  let addonA: Json;
  let productA: Json;
  let imageA: string;

  /** Produtos de B que a loja A nunca pode alcançar. */
  const allProductsB = () => [productB, productBPromo, productBHidden, productBTrashed, productBImage];

  test.beforeAll(async () => {
    api = await newApi();
    superadmin = await loginAs(api, 'superadmin');
    demo = await demoStore();
    teamA = await demoTeam(api);

    storeB = await createStore(api, superadmin, 'Cardapio');
    cleanup.add('desativar a loja B', () => retireStore(api, superadmin, storeB));
    const adminB = storeB.owner;
    addonB = await addAddon(api, adminB, { name: `Bacon B ${uid('ab')}`.slice(0, 60), price: 4 });
    addonBHidden = await addAddon(api, adminB, { available: false });
    addonBTrashed = await addAddon(api, adminB);
    await trashAddon(api, adminB, addonBTrashed.id);
    imageB = await uploadImage(api, adminB);
    productB = await addProduct(api, adminB, { name: `Burger B ${uid('pb')}`, price: 22, allowed_addons_ids: [addonB.id] });
    productBPromo = await addProduct(api, adminB, { price: 30, promotion_price: 25, is_highlight: true });
    productBHidden = await addProduct(api, adminB, { available: false });
    productBTrashed = await addProduct(api, adminB);
    await trashProduct(api, adminB, productBTrashed.id);
    productBImage = await addProduct(api, adminB, { image: imageB });

    // Loja A: catálogo próprio do teste (vai para a lixeira no fim)
    addonA = await addAddon(api, teamA.ADMIN, { name: `Cheddar A ${uid('aa')}`.slice(0, 60) });
    cleanup.add('lixeira do adicional da loja A', () =>
      api.delete(`/addons/${addonA.id}`, { headers: bearer(teamA.ADMIN.token) }),
    );
    productA = await addProduct(api, teamA.ADMIN, { name: `Burger A ${uid('pa')}`, allowed_addons_ids: [addonA.id] });
    trashProductLater(cleanup, api, teamA.ADMIN, productA.id);
    imageA = await uploadImage(api, teamA.ADMIN);

    client = await newCustomer(api, 'Cliente Cardapio');
  });

  test.afterAll(async () => {
    await cleanup.run();
    await api.dispose();
  });

  test('a vitrine de cada loja mostra só o próprio cardápio, nunca a lixeira (e a de A, só o de A)', async () => {
    const bProducts: Json[] = await getJson(api, storePath(storeB.slug, '/products'));
    expectAllFromStore(bProducts, storeB.id, 'GET /stores/<B>/products');
    expect(ids(bProducts.filter((p) => p.available)), 'cardápio público de B').toEqual(
      ids([productB, productBPromo, productBImage]),
    );
    expect(bProducts.some((p) => p.id === productBTrashed.id), 'produto da lixeira fora da vitrine').toBe(false);
    // Indisponível: se aparecer, é da própria loja e marcado (o pedido é recusado — ver orders/identifiers)
    for (const unavailable of bProducts.filter((p) => !p.available)) {
      expect(unavailable.id, 'só o indisponível da própria loja').toBe(productBHidden.id);
    }

    const bAddons: Json[] = await getJson(api, storePath(storeB.slug, '/addons'));
    expectAllFromStore(bAddons, storeB.id, 'GET /stores/<B>/addons');
    expect(ids(bAddons.filter((a) => a.available)), 'adicionais públicos de B').toEqual([addonB.id]);
    expect(bAddons.some((a) => a.id === addonBTrashed.id), 'adicional da lixeira fora da vitrine').toBe(false);

    const aProducts: Json[] = await getJson(api, storePath(demo.slug, '/products'));
    expectAllFromStore(aProducts, demo.id, 'GET /stores/<A>/products');
    expectNoneOf(aProducts, ids(allProductsB()), 'vitrine de A');
    expect(aProducts.some((p) => p.id === productA.id), 'produto de A na vitrine de A').toBe(true);

    const aAddons: Json[] = await getJson(api, storePath(demo.slug, '/addons'));
    expectAllFromStore(aAddons, demo.id, 'GET /stores/<A>/addons');
    expectNoneOf(aAddons, [addonB.id, addonBHidden.id, addonBTrashed.id], 'adicionais da vitrine de A');

    // O produto de B leva só adicionais de B
    const withAddon = bProducts.find((p) => p.id === productB.id);
    expect(ids(withAddon.allowed_addons)).toEqual([addonB.id]);
    expectAllFromStore(withAddon.allowed_addons, storeB.id, 'adicionais permitidos do produto de B');
  });

  test('produto de B por id (público, indisponível, na lixeira, em promoção, com imagem) → 404 uniforme no contexto da loja A', async () => {
    const actors: Array<[string, string | null]> = [
      ['visitante', null],
      ['cliente', client.token],
      ...(Object.entries(teamA) as Array<[string, Session]>).map(([role, s]): [string, string] => [`${role} de A`, s.token]),
    ];
    for (const [label, token] of actors) {
      const headers = token ? bearer(token) : undefined;
      for (const product of allProductsB()) {
        // Rota antiga: a equipe de A cai na própria loja; visitante e cliente, na loja padrão (A)
        await expectUniform404(
          await api.get(`/products/${product.id}`, { headers }),
          await api.get(`/products/${MISSING_ID}`, { headers }),
          MSG.productNotFound,
          `${label}: GET /products/${product.id}`,
        );
        // Rota da vitrine de A com o id de B
        await expectUniform404(
          await api.get(storePath(demo.slug, `/products/${product.id}`), { headers }),
          await api.get(storePath(demo.slug, `/products/${MISSING_ID}`), { headers }),
          MSG.productNotFound,
          `${label}: GET /stores/<A>/products/${product.id}`,
        );
      }
    }
    // E o contrário: produto de A pela vitrine de B
    await expectUniform404(
      await api.get(storePath(storeB.slug, `/products/${productA.id}`)),
      await api.get(storePath(storeB.slug, `/products/${MISSING_ID}`)),
      MSG.productNotFound,
      'GET /stores/<B>/products/<produto de A>',
    );
  });

  test('lixeira: cada ADMIN vê só a da própria loja; a lixeira de B pela rota da loja com token de A → 403', async () => {
    const trashA: Json[] = await getJson(api, '/products/trash', teamA.ADMIN.token, 'lixeira de A');
    expectAllFromStore(trashA, demo.id, 'lixeira de A');
    expectNoneOf(trashA, ids(allProductsB()), 'lixeira de A');

    const trashB: Json[] = await getJson(api, '/products/trash', storeB.owner.token, 'lixeira de B');
    expect(ids(trashB), 'lixeira de B: só o produto excluído de B').toEqual([productBTrashed.id]);

    await expectError(
      await api.get(storePath(storeB.slug, '/products/trash'), { headers: bearer(teamA.ADMIN.token) }),
      403,
      MSG.otherStore,
      'GET /stores/<B>/products/trash com token de A',
    );
    const own = await getJson(api, storePath(storeB.slug, '/products/trash'), storeB.owner.token);
    expect(ids(own)).toEqual([productBTrashed.id]);
  });

  test('ADMIN de A não altera, exclui, restaura nem apaga de vez o cardápio de B (404 uniforme) e B fica intacto', async () => {
    const admin = bearer(teamA.ADMIN.token);
    const attempts: Array<[string, (id: number) => Promise<APIResponse>, number, string]> = [
      ['PATCH /products/:id', (id) => api.patch(`/products/${id}`, { headers: admin, data: { name: 'Invadido', price: 0.5 } }), productB.id, MSG.productNotFound],
      ['PATCH /products/:id (multipart)', (id) => api.patch(`/products/${id}`, { headers: admin, multipart: { name: 'Invadido' } }), productBImage.id, MSG.productNotFound],
      ['DELETE /products/:id', (id) => api.delete(`/products/${id}`, { headers: admin }), productB.id, MSG.productNotFound],
      ['PATCH /products/:id/restore', (id) => api.patch(`/products/${id}/restore`, { headers: admin }), productBTrashed.id, MSG.productNotInTrash],
      ['DELETE /products/:id/permanent (lixeira)', (id) => api.delete(`/products/${id}/permanent`, { headers: admin }), productBTrashed.id, MSG.productNotFound],
      ['DELETE /products/:id/permanent', (id) => api.delete(`/products/${id}/permanent`, { headers: admin }), productBHidden.id, MSG.productNotFound],
      ['PATCH /stores/<A>/products/:id', (id) => api.patch(storePath(demo.slug, `/products/${id}`), { headers: admin, data: { name: 'Invadido' } }), productBPromo.id, MSG.productNotFound],
      ['PATCH /addons/:id', (id) => api.patch(`/addons/${id}`, { headers: admin, data: { price: 0.01 } }), addonB.id, MSG.addonNotFound],
      ['DELETE /addons/:id', (id) => api.delete(`/addons/${id}`, { headers: admin }), addonB.id, MSG.addonNotFound],
      ['DELETE /addons/:id (indisponível)', (id) => api.delete(`/addons/${id}`, { headers: admin }), addonBHidden.id, MSG.addonNotFound],
    ];
    for (const [label, call, foreignId, message] of attempts) {
      await expectUniform404(await call(foreignId), await call(MISSING_ID), message, label);
    }

    // Nada mudou em B
    const product = await getJson(api, `/products/${productB.id}`, storeB.owner.token, 'produto de B pelo ADMIN de B');
    expect(product).toMatchObject({ id: productB.id, name: productB.name, store_id: storeB.id, available: true });
    expect(Number(product.price)).toBe(22);
    expect(ids(product.allowed_addons)).toEqual([addonB.id]);
    const addons: Json[] = await getJson(api, storePath(storeB.slug, '/addons'));
    expect(Number(addons.find((a) => a.id === addonB.id)?.price)).toBe(4);
    expect(addons.some((a) => a.id === addonBHidden.id), 'adicional indisponível de B continua cadastrado').toBe(true);
    const trashB: Json[] = await getJson(api, '/products/trash', storeB.owner.token);
    expect(ids(trashB)).toEqual([productBTrashed.id]);
  });

  test('gestão pela rota da loja B com token da equipe de A → 403 (o slug nunca troca a loja) e nada é criado em B', async () => {
    const admin = bearer(teamA.ADMIN.token);
    const B = (path: string) => storePath(storeB.slug, path);
    const before = ids(await getJson(api, B('/products')));
    const beforeAddons = ids(await getJson(api, B('/addons')));
    const attempts: Array<[string, () => Promise<APIResponse>]> = [
      ['POST /stores/<B>/products', () => api.post(B('/products'), { headers: admin, data: { name: 'Intruso', price: 1, category: 'bebidas' } })],
      ['PATCH /stores/<B>/products/:id', () => api.patch(B(`/products/${productB.id}`), { headers: admin, data: { name: 'Intruso' } })],
      ['DELETE /stores/<B>/products/:id', () => api.delete(B(`/products/${productB.id}`), { headers: admin })],
      ['PATCH /stores/<B>/products/:id/restore', () => api.patch(B(`/products/${productBTrashed.id}/restore`), { headers: admin })],
      ['DELETE /stores/<B>/products/:id/permanent', () => api.delete(B(`/products/${productBTrashed.id}/permanent`), { headers: admin })],
      ['POST /stores/<B>/addons', () => api.post(B('/addons'), { headers: admin, data: { name: 'Intruso', price: 1 } })],
      ['PATCH /stores/<B>/addons/:id', () => api.patch(B(`/addons/${addonB.id}`), { headers: admin, data: { price: 0.01 } })],
      ['DELETE /stores/<B>/addons/:id', () => api.delete(B(`/addons/${addonB.id}`), { headers: admin })],
    ];
    for (const [label, call] of attempts) await expectError(await call(), 403, MSG.otherStore, label);

    expect(ids(await getJson(api, B('/products'))), 'cardápio de B igual').toEqual(before);
    expect(ids(await getJson(api, B('/addons'))), 'adicionais de B iguais').toEqual(beforeAddons);
    expect(ids(await getJson(api, '/products/trash', storeB.owner.token))).toEqual([productBTrashed.id]);
  });

  test('adicional e imagem de uma loja são recusados (400) no cadastro da outra, nos dois sentidos', async () => {
    const adminA = bearer(teamA.ADMIN.token);
    const adminB = bearer(storeB.owner.token);
    const productData = (extra: Record<string, unknown>) => ({ name: `Produto ${uid('x')}`, price: 10, category: 'bebidas', ...extra });

    // Adicional de B no cardápio de A (e o de A no de B): mesmo 400 de um adicional inexistente
    await expectError(
      await api.post('/products', { headers: adminA, data: productData({ allowed_addons_ids: [addonB.id] }) }),
      400,
      MSG.addonsMissingInCatalog(addonB.id),
      'A cria produto com adicional de B',
    );
    await expectError(
      await api.patch(`/products/${productA.id}`, { headers: adminA, data: { allowed_addons_ids: [addonA.id, addonB.id] } }),
      400,
      MSG.addonsMissingInCatalog(addonB.id),
      'A edita produto com adicional de B',
    );
    await expectError(
      await api.post('/products', { headers: adminB, data: productData({ allowed_addons_ids: [addonA.id] }) }),
      400,
      MSG.addonsMissingInCatalog(addonA.id),
      'B cria produto com adicional de A',
    );
    await expectError(
      await api.patch(`/products/${productB.id}`, { headers: adminB, multipart: { allowed_addons_ids: String(addonA.id) } }),
      400,
      MSG.addonsMissingInCatalog(addonA.id),
      'B edita produto (multipart) com adicional de A',
    );

    // Arquivo enviado pela outra loja (nome puro, caminho /uploads/ ou URL http da própria API)
    for (const ref of [imageB, `/uploads/${imageB}`, `http://localhost/uploads/${imageB}`]) {
      await expectError(await api.post('/products', { headers: adminA, data: productData({ image: ref }) }), 400, MSG.invalidImage, `A cria produto com a imagem ${ref}`);
      await expectError(await api.patch(`/products/${productA.id}`, { headers: adminA, data: { image: ref } }), 400, MSG.invalidImage, `A edita produto com a imagem ${ref}`);
      await expectError(await api.post('/addons', { headers: adminA, data: { name: 'Adicional', price: 1, image: ref } }), 400, MSG.invalidImage, `A cria adicional com a imagem ${ref}`);
      await expectError(await api.patch(`/addons/${addonA.id}`, { headers: adminA, data: { image: ref } }), 400, MSG.invalidImage, `A edita adicional com a imagem ${ref}`);
    }
    await expectError(await api.post('/products', { headers: adminB, data: productData({ image: imageA }) }), 400, MSG.invalidImage, 'B cria produto com a imagem de A');
    await expectError(await api.patch(`/addons/${addonB.id}`, { headers: adminB, data: { image: imageA } }), 400, MSG.invalidImage, 'B edita adicional com a imagem de A');

    // Nada mudou nos registros das duas lojas
    const a = await getJson(api, `/products/${productA.id}`);
    expect(ids(a.allowed_addons)).toEqual([addonA.id]);
    expect(a.image ?? null).toBeNull();
    const b = await getJson(api, storePath(storeB.slug, `/products/${productB.id}`));
    expect(ids(b.allowed_addons)).toEqual([addonB.id]);
    const withImage = await getJson(api, storePath(storeB.slug, `/products/${productBImage.id}`));
    expect(withImage.image, 'a imagem de B continua no produto de B').toBe(imageB);
  });

  test('cada loja envia imagens com o próprio prefixo (s<id>-) e o arquivo de B fica só no produto de B', async () => {
    expect(imageA.startsWith(`s${demo.id}-`), `arquivo de A: ${imageA}`).toBe(true);
    expect(imageB.startsWith(`s${storeB.id}-`), `arquivo de B: ${imageB}`).toBe(true);
    // Mesmo pela rota da loja B, o upload do ADMIN de A é recusado (nunca grava com o prefixo de B)
    await expectError(
      await api.post(storePath(storeB.slug, '/products'), {
        headers: bearer(teamA.ADMIN.token),
        multipart: { name: 'Intruso', price: '1', category: 'bebidas' },
      }),
      403,
      MSG.otherStore,
    );
    // O arquivo de B não aparece em nenhum registro de A
    const aProducts: Json[] = await getJson(api, '/products', teamA.ADMIN.token);
    const aAddons: Json[] = await getJson(api, '/addons', teamA.ADMIN.token);
    const refs = [...aProducts, ...aAddons].map((item) => String(item.image ?? ''));
    expect(refs.filter((ref) => ref.includes(`s${storeB.id}-`)), 'nenhuma imagem de B no cardápio de A').toEqual([]);
  });

  test('promoção de B vale só na loja B: o produto em promoção não existe para a loja A', async () => {
    const order = { items: [{ productId: productBPromo.id, quantity: 2 }], type: 'TAKEOUT' };
    const inB = await api.post(storePath(storeB.slug, '/orders/quote'), { headers: bearer(client.token), data: order });
    const quote = await expectStatus(inB, 200, 'orçamento em B');
    expect(quote.items[0]).toMatchObject({ productId: productBPromo.id, unitPrice: 25, lineTotal: 50 });

    for (const path of ['/orders/quote', storePath(demo.slug, '/orders/quote')]) {
      await expectError(
        await api.post(path, { headers: bearer(client.token), data: order }),
        400,
        MSG.productMissingInOrder(productBPromo.id),
        `orçamento na loja A (${path}) com o produto em promoção de B`,
      );
    }
    // Destaques da vitrine de A não trazem o destaque de B
    const aProducts: Json[] = await getJson(api, storePath(demo.slug, '/products'));
    expect(aProducts.filter((p) => p.is_highlight).some((p) => p.id === productBPromo.id)).toBe(false);
  });

  test('a equipe de A (cada perfil) nas rotas antigas de leitura só vê o cardápio de A', async () => {
    for (const [role, session] of Object.entries(teamA) as Array<[string, Session]>) {
      const products: Json[] = await getJson(api, '/products', session.token, `GET /products (${role} de A)`);
      expectAllFromStore(products, demo.id, `GET /products (${role} de A)`);
      expectNoneOf(products, ids(allProductsB()), `GET /products (${role} de A)`);
      const addons: Json[] = await getJson(api, '/addons', session.token, `GET /addons (${role} de A)`);
      expectAllFromStore(addons, demo.id, `GET /addons (${role} de A)`);
      expectNoneOf(addons, [addonB.id, addonBHidden.id, addonBTrashed.id], `GET /addons (${role} de A)`);
    }
    // Com o token do ADMIN de B, as mesmas rotas antigas mostram B (e nunca A)
    const bProducts: Json[] = await getJson(api, '/products', storeB.owner.token);
    expectAllFromStore(bProducts, storeB.id, 'GET /products (ADMIN de B)');
    expect(bProducts.some((p) => p.id === productA.id)).toBe(false);
    await expectStatus(await api.get(`/products/${productB.id}`, { headers: bearer(storeB.owner.token) }), 200);
  });
});
