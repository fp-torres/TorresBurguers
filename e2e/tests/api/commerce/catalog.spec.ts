import { test, expect, type APIRequestContext } from '@playwright/test';
import { demoStore, uid } from '../../../support/api';
import { E2E } from '../../../support/env';
import {
  Actors,
  GIF_1PX,
  JPEG_2PX,
  PNG_1PX,
  SVG_SCRIPT,
  UNKNOWN_ID,
  WEBP_2PX,
  createAddon,
  createProduct,
  deleteAddon,
  expectMoney,
  expectNestError,
  expectStatus,
  fileBlob,
  form,
  getAddons,
  getProducts,
  ids,
  placeOrder,
  softDeleteProduct,
  updateProduct,
  type Actor,
  type Json,
} from './helpers';

test.describe('Catálogo: produtos e adicionais', () => {
  const actors = new Actors();
  let anon: APIRequestContext;
  let admin: Actor;
  let employee: Actor;
  let kitchen: Actor;
  let courier: Actor;
  let client: Actor;
  let addonA: Json;
  let addonB: Json;

  test.beforeAll(async () => {
    anon = await actors.anon();
    admin = await actors.defaultUser('admin');
    employee = await actors.defaultUser('employee');
    kitchen = await actors.defaultUser('kitchen');
    courier = await actors.defaultUser('courier');
    client = await actors.newClient();
    addonA = await createAddon(admin.ctx, { name: `Bacon ${uid('a')}`, price: 3.5 });
    addonB = await createAddon(admin.ctx, { name: `Cheddar ${uid('b')}`, price: 2.25 });
  });

  test.afterAll(async () => {
    await actors.dispose();
  });

  // -------------------------------------------------------------------------
  // Leitura pública
  // -------------------------------------------------------------------------

  test('GET /products é público, traz allowed_addons e não lista produtos da lixeira', async () => {
    const visible = await createProduct(admin.ctx, { allowed_addons_ids: [addonA.id, addonB.id] });
    const trashed = await createProduct(admin.ctx);
    await softDeleteProduct(admin.ctx, trashed.id);

    const list = await getProducts(anon);
    expect(Array.isArray(list)).toBe(true);
    for (const product of list) expect(Array.isArray(product.allowed_addons), `allowed_addons de #${product.id}`).toBe(true);

    const found = list.find((p) => p.id === visible.id);
    expect(found, 'produto ativo no cardápio').toBeTruthy();
    expect(ids(found.allowed_addons)).toEqual(ids([addonA, addonB]));
    expect(list.some((p) => p.id === trashed.id), 'produto da lixeira fora do cardápio').toBe(false);
  });

  test('cardápio pela rota da loja (/stores/<slug>/products e /addons) é o mesmo das rotas antigas (loja padrão)', async () => {
    const product = await createProduct(admin.ctx, { allowed_addons_ids: [addonA.id] });
    const scoped = `/stores/${E2E.demoStoreSlug}`;
    const [legacyProducts, scopedProducts, legacyAddons, scopedAddons] = await Promise.all([
      getProducts(anon),
      anon.get(`${scoped}/products`).then((res) => res.json()),
      getAddons(anon),
      anon.get(`${scoped}/addons`).then((res) => res.json()),
    ]);
    expect(ids(scopedProducts)).toEqual(ids(legacyProducts));
    expect(ids(scopedAddons)).toEqual(ids(legacyAddons));
    expect(scopedProducts.some((p: Json) => p.id === product.id)).toBe(true);

    const one = await anon.get(`${scoped}/products/${product.id}`);
    await expectStatus(one, 200);
    expect(ids((await one.json()).allowed_addons)).toEqual([addonA.id]);
    await expectNestError(await anon.get('/stores/loja-que-nao-existe-e2e/products'), 404);
  });

  test('GET /products/:id é público e traz os adicionais permitidos', async () => {
    const product = await createProduct(admin.ctx, { price: 27.5, allowed_addons_ids: [addonA.id] });
    const res = await anon.get(`/products/${product.id}`);
    await expectStatus(res, 200);
    const data = await res.json();
    expect(data).toMatchObject({ id: product.id, name: product.name, category: 'hamburgueres', available: true });
    expectMoney(data.price, 27.5, 'price');
    expect(ids(data.allowed_addons)).toEqual([addonA.id]);
  });

  test('GET /products/:id desconhecido responde 404 e id inválido responde 400 (nunca 500)', async () => {
    await expectNestError(await anon.get(`/products/${UNKNOWN_ID}`), 404);
    await expectNestError(await anon.get('/products/abc'), 400);
    await expectNestError(await anon.get('/products/99999999999'), 400);
  });

  test('GET /products/:id de produto na lixeira responde 404', async () => {
    const product = await createProduct(admin.ctx);
    await softDeleteProduct(admin.ctx, product.id);
    await expectNestError(await anon.get(`/products/${product.id}`), 404);
  });

  // -------------------------------------------------------------------------
  // Cadastro (ADMIN)
  // -------------------------------------------------------------------------

  test('ADMIN cria produto via multipart com imagem, um adicional permitido e ingredientes', async () => {
    const name = `X-Commerce ${uid('mp')}`;
    const fd = form(
      [
        ['name', name],
        ['description', 'Pão brioche, blend 180g e cheddar.'],
        ['price', '29.90'],
        ['category', 'hamburgueres'],
        ['available', 'true'],
        ['is_highlight', 'false'],
        ['ingredients', 'Pão brioche'],
        ['ingredients', 'Blend 180g'],
        ['allowed_addons_ids', String(addonA.id)],
      ],
      { blob: fileBlob(PNG_1PX, 'image/png'), name: 'foto.png' },
    );
    const res = await admin.ctx.post('/products', { multipart: fd });
    await expectStatus(res, 201);
    const product = await res.json();

    expect(product).toMatchObject({ name, category: 'hamburgueres', available: true, is_highlight: false });
    expectMoney(product.price, 29.9, 'price');
    expect(product.ingredients).toEqual(['Pão brioche', 'Blend 180g']);
    expect(ids(product.allowed_addons)).toEqual([addonA.id]);
    const store = await demoStore();
    expect(product.image, 'nome do arquivo salvo (sem pasta), com o prefixo da loja').toMatch(new RegExp(`^s${store.id}-[\\w.-]+\\.webp$`));

    const image = await anon.get(`/uploads/${product.image}`);
    expect(image.status(), 'imagem servida em /uploads').toBe(200);
    expect(image.headers()['content-type']).toContain('image/webp');

    const again = await (await anon.get(`/products/${product.id}`)).json();
    expect(again.image).toBe(product.image);
  });

  test('ADMIN cria produto via multipart com vários adicionais (campo repetido) e textos do FormData', async () => {
    const fd = form([
      ['name', `Combo ${uid('rep')}`],
      ['price', '45,50'],
      ['category', 'Combos '],
      ['available', 'false'],
      ['is_highlight', 'true'],
      ['allowed_addons_ids', String(addonA.id)],
      ['allowed_addons_ids', String(addonB.id)],
    ]);
    const res = await admin.ctx.post('/products', { multipart: fd });
    await expectStatus(res, 201);
    const product = await res.json();
    expect(ids(product.allowed_addons)).toEqual(ids([addonA, addonB]));
    expectMoney(product.price, 45.5, 'price "45,50"');
    expect(product.category).toBe('combos');
    expect(product.available).toBe(false);
    expect(product.is_highlight).toBe(true);
  });

  test('ADMIN cria produto via multipart com listas em JSON ou separadas por vírgula', async () => {
    const asJson = await admin.ctx.post('/products', {
      multipart: form([
        ['name', `Lista JSON ${uid('j')}`],
        ['price', '18'],
        ['category', 'hamburgueres'],
        ['allowed_addons_ids', JSON.stringify([addonA.id, addonB.id])],
        ['ingredients', JSON.stringify(['Alface', 'Tomate'])],
      ]),
    });
    await expectStatus(asJson, 201);
    const fromJson = await asJson.json();
    expect(ids(fromJson.allowed_addons)).toEqual(ids([addonA, addonB]));
    expect(fromJson.ingredients).toEqual(['Alface', 'Tomate']);

    const asCsv = await admin.ctx.post('/products', {
      multipart: form([
        ['name', `Lista CSV ${uid('c')}`],
        ['price', '18'],
        ['category', 'hamburgueres'],
        ['allowed_addons_ids', `${addonA.id},${addonB.id}`],
        ['ingredients', 'Alface, Tomate'],
      ]),
    });
    await expectStatus(asCsv, 201);
    const fromCsv = await asCsv.json();
    expect(ids(fromCsv.allowed_addons)).toEqual(ids([addonA, addonB]));
    expect(fromCsv.ingredients).toEqual(['Alface', 'Tomate']);
  });

  test('ADMIN cria produto via JSON com preço promocional', async () => {
    const product = await createProduct(admin.ctx, {
      price: 40,
      promotion_price: 35.5,
      category: 'sobremesas',
      ingredients: ['Chocolate'],
      allowed_addons_ids: [addonB.id],
    });
    expectMoney(product.price, 40, 'price');
    expectMoney(product.promotion_price, 35.5, 'promotion_price');
    expect(product.category).toBe('sobremesas');
    expect(product.ingredients).toEqual(['Chocolate']);
    expect(ids(product.allowed_addons)).toEqual([addonB.id]);
  });

  test('cadastro recusa preço negativo, inválido ou acima do limite (400)', async () => {
    const name = `Preco Ruim ${uid('pr')}`;
    for (const price of [-1, 'abc', 1_000_000]) {
      const res = await admin.ctx.post('/products', { data: { name, price, category: 'hamburgueres' } });
      await expectNestError(res, 400);
    }
    await expectNestError(
      await admin.ctx.post('/products', { multipart: form([['name', name], ['price', '-5'], ['category', 'bebidas']]) }),
      400,
      /negativo/i,
    );
    expect((await getProducts(anon)).some((p) => p.name === name), 'nada foi criado').toBe(false);
  });

  test('cadastro recusa preço promocional maior ou igual ao preço (400)', async () => {
    const name = `Promo Ruim ${uid('pp')}`;
    for (const promotion_price of [30, 30.01, 45]) {
      const res = await admin.ctx.post('/products', {
        data: { name, price: 30, promotion_price, category: 'hamburgueres' },
      });
      await expectNestError(res, 400, /promocional/i);
    }
    expect((await getProducts(anon)).some((p) => p.name === name), 'nada foi criado').toBe(false);
  });

  test('cadastro recusa categoria inválida e campos obrigatórios ausentes (400)', async () => {
    const name = `Obrigatorios ${uid('ob')}`;
    await expectNestError(
      await admin.ctx.post('/products', { data: { name, price: 10, category: 'pizzas' } }),
      400,
      /categoria/i,
    );
    await expectNestError(await admin.ctx.post('/products', { data: { price: 10, category: 'bebidas' } }), 400);
    await expectNestError(await admin.ctx.post('/products', { data: { name: '   ', price: 10, category: 'bebidas' } }), 400);
    await expectNestError(await admin.ctx.post('/products', { data: { name: 'x'.repeat(101), price: 10, category: 'bebidas' } }), 400);
    await expectNestError(await admin.ctx.post('/products', { data: { name, category: 'bebidas' } }), 400);
    await expectNestError(await admin.ctx.post('/products', { data: { name, price: 10 } }), 400);
    expect((await getProducts(anon)).some((p) => p.name === name), 'nada foi criado').toBe(false);
  });

  test('cadastro recusa adicional inexistente, campo desconhecido e referência de imagem com caminho (400)', async () => {
    const name = `Diversos ${uid('dv')}`;
    const base = { name, price: 10, category: 'bebidas' };
    await expectNestError(await admin.ctx.post('/products', { data: { ...base, allowed_addons_ids: [UNKNOWN_ID] } }), 400);
    await expectNestError(await admin.ctx.post('/products', { data: { ...base, allowed_addons_ids: ['abc'] } }), 400);
    await expectNestError(await admin.ctx.post('/products', { data: { ...base, estoque: 10 } }), 400);
    await expectNestError(await admin.ctx.post('/products', { data: { ...base, image: '../../etc/passwd' } }), 400);
    await expectNestError(await admin.ctx.post('/products', { data: { ...base, image: 'javascript:alert(1)' } }), 400);
    await expectNestError(await admin.ctx.post('/products', { data: { ...base, available: 'talvez' } }), 400);
    expect((await getProducts(anon)).some((p) => p.name === name), 'nada foi criado').toBe(false);
  });

  test('campo "image" só aceita arquivo da própria loja (s<id>-), URL https:// ou o valor atual (400 nos demais)', async () => {
    const store = await demoStore();
    const name = `Imagem Ref ${uid('ir')}`;
    const base = { name, price: 10, category: 'bebidas' };
    const orphan = 'compressed-1700000000000-abcd1234.webp';
    for (const image of ['http://exemplo.com/foto.png', orphan, `s${store.id + 1000}-${orphan}`, '/uploads/foto.webp']) {
      await expectNestError(await admin.ctx.post('/products', { data: { ...base, image } }), 400, /Imagem inválida/);
    }
    expect((await getProducts(anon)).some((p) => p.name === name), 'nada foi criado').toBe(false);

    // Arquivo enviado pela própria loja (POST /uploads) e URL https:// são aceitos
    const upload = await admin.ctx.post('/uploads', { multipart: { file: { name: 'foto.png', mimeType: 'image/png', buffer: PNG_1PX } } });
    await expectStatus(upload, 201);
    const { filename } = await upload.json();
    expect(filename).toMatch(new RegExp(`^s${store.id}-`));
    const own = await createProduct(admin.ctx, { image: filename });
    expect(own.image).toBe(filename);
    const external = await createProduct(admin.ctx, { image: 'https://cdn.exemplo.com/burger.png' });
    expect(external.image).toBe('https://cdn.exemplo.com/burger.png');

    // Reenviar o valor atual é aceito; trocar por um arquivo sem dono ou de outra loja, não
    expect((await updateProduct(admin.ctx, own.id, { image: filename, price: 11 })).image).toBe(filename);
    for (const image of [orphan, `s${store.id + 1000}-${orphan}`]) {
      await expectNestError(await admin.ctx.patch(`/products/${own.id}`, { data: { image } }), 400, /Imagem inválida/);
    }
    expect((await (await anon.get(`/products/${own.id}`)).json()).image).toBe(filename);

    // Adicionais seguem a mesma regra
    await expectNestError(await admin.ctx.post('/addons', { data: { name: `Img ${uid('ai')}`, price: 1, image: 'http://exemplo.com/a.png' } }), 400);
    await expectNestError(await admin.ctx.post('/addons', { data: { name: `Img ${uid('ai')}`, price: 1, image: orphan } }), 400);
  });

  test('imagem que não é JPG/PNG/WebP é recusada com 400 e o produto não é criado', async () => {
    const name = `Imagem Falsa ${uid('img')}`;
    const fd = form(
      [
        ['name', name],
        ['price', '10'],
        ['category', 'bebidas'],
      ],
      { blob: fileBlob(Buffer.from('isto não é uma imagem'), 'image/png'), name: 'foto.png' },
    );
    await expectNestError(await admin.ctx.post('/products', { multipart: fd }), 400, /imagem/i);
    expect((await getProducts(anon)).some((p) => p.name === name), 'nada foi criado').toBe(false);
  });

  test('imagem acima de 5 MB é recusada e o produto não é criado', async () => {
    const name = `Imagem Grande ${uid('big')}`;
    const big = Buffer.alloc(5 * 1024 * 1024 + 1024, 0);
    PNG_1PX.copy(big, 0, 0, 8); // assinatura PNG
    const fd = form(
      [
        ['name', name],
        ['price', '10'],
        ['category', 'bebidas'],
      ],
      { blob: fileBlob(big, 'image/png'), name: 'grande.png' },
    );
    // Contrato: imagens acima de 5 MB → 400 (não o 413 padrão do multer)
    await expectNestError(await admin.ctx.post('/products', { multipart: fd }), 400, /5 MB/);
    expect((await getProducts(anon)).some((p) => p.name === name), 'nada foi criado').toBe(false);
  });

  test('imagens JPG e WebP também são aceitas e servidas como WebP', async () => {
    const created = await admin.ctx.post('/products', {
      multipart: form(
        [
          ['name', `Foto JPG ${uid('jpg')}`],
          ['price', '12'],
          ['category', 'bebidas'],
        ],
        { blob: fileBlob(JPEG_2PX, 'image/jpeg'), name: 'foto.jpg' },
      ),
    });
    await expectStatus(created, 201);
    const product = await created.json();
    expect(product.image).toMatch(/\.webp$/);
    expect((await anon.get(`/uploads/${product.image}`)).status()).toBe(200);

    const updated = await admin.ctx.patch(`/products/${product.id}`, {
      multipart: form([], { blob: fileBlob(WEBP_2PX, 'image/webp'), name: 'foto.webp' }),
    });
    await expectStatus(updated, 200);
    const after = await updated.json();
    expect(after.image).toMatch(/\.webp$/);
    expect(after.image).not.toBe(product.image);
    expect((await anon.get(`/uploads/${after.image}`)).status()).toBe(200);
  });

  test('a imagem trocada de produto ou adicional sai do disco, a menos que outro cadastro ainda a use', async () => {
    const png = () => ({ blob: fileBlob(PNG_1PX, 'image/png'), name: 'foto.png' });
    const served = async (file: string) => (await anon.get(`/uploads/${file}`)).status();

    // Dois produtos com o mesmo arquivo da loja (o segundo pelo campo "image")
    const created = await admin.ctx.post('/products', {
      multipart: form(
        [
          ['name', `Imagem trocada ${uid('img')}`],
          ['price', '10'],
          ['category', 'bebidas'],
        ],
        png(),
      ),
    });
    await expectStatus(created, 201);
    const first = await created.json();
    const shared = first.image as string;
    const twin = await createProduct(admin.ctx, { image: shared });
    expect(twin.image).toBe(shared);

    // O primeiro troca a foto: o arquivo continua, porque o outro produto ainda o usa
    const replaced = await admin.ctx.patch(`/products/${first.id}`, { multipart: form([], png()) });
    await expectStatus(replaced, 200);
    const firstNew = (await replaced.json()).image as string;
    expect(firstNew).not.toBe(shared);
    expect(await served(shared), 'arquivo ainda usado por outro produto').toBe(200);

    // O outro tira a imagem: ninguém mais usa o arquivo e ele sai do disco
    await updateProduct(admin.ctx, twin.id, { image: null });
    expect(await served(shared), 'arquivo sem nenhum uso').toBe(404);
    expect(await served(firstNew), 'a foto nova continua').toBe(200);

    // Adicional: mesma regra
    const addonCreated = await admin.ctx.post('/addons', {
      multipart: form(
        [
          ['name', `Adicional com foto ${uid('ad')}`],
          ['price', '2'],
        ],
        png(),
      ),
    });
    await expectStatus(addonCreated, 201);
    const addon = await addonCreated.json();
    const addonReplaced = await admin.ctx.patch(`/addons/${addon.id}`, { multipart: form([], png()) });
    await expectStatus(addonReplaced, 200);
    const addonNew = (await addonReplaced.json()).image as string;
    expect(addonNew).not.toBe(addon.image);
    expect(await served(addon.image), 'foto antiga do adicional').toBe(404);
    expect(await served(addonNew), 'foto nova do adicional').toBe(200);

    await softDeleteProduct(admin.ctx, first.id);
    await softDeleteProduct(admin.ctx, twin.id);
    await deleteAddon(admin.ctx, addon.id);
  });

  test('GIF e SVG são recusados com 400 mesmo declarados como imagem', async () => {
    const name = `Formato Ruim ${uid('fmt')}`;
    const files = [
      { blob: fileBlob(GIF_1PX, 'image/gif'), name: 'anim.gif' },
      { blob: fileBlob(SVG_SCRIPT, 'image/svg+xml'), name: 'logo.svg' },
      { blob: fileBlob(SVG_SCRIPT, 'image/png'), name: 'disfarce.png' },
    ];
    for (const file of files) {
      const fd = form(
        [
          ['name', name],
          ['price', '10'],
          ['category', 'bebidas'],
        ],
        file,
      );
      await expectNestError(await admin.ctx.post('/products', { multipart: fd }), 400);
    }
    expect((await getProducts(anon)).some((p) => p.name === name), 'nada foi criado').toBe(false);
  });

  test('arquivo enviado em campo diferente de "file" é recusado com 400', async () => {
    const name = `Campo Errado ${uid('fld')}`;
    const fd = new FormData();
    fd.append('name', name);
    fd.append('price', '10');
    fd.append('category', 'bebidas');
    fd.append('image', fileBlob(PNG_1PX, 'image/png'), 'foto.png');
    await expectNestError(await admin.ctx.post('/products', { multipart: fd }), 400, /file/);
    expect((await getProducts(anon)).some((p) => p.name === name), 'nada foi criado').toBe(false);
  });

  test('PATCH com imagem inválida responde 400 e mantém a imagem e os dados atuais', async () => {
    const created = await admin.ctx.post('/products', {
      multipart: form(
        [
          ['name', `Com Foto ${uid('cf')}`],
          ['price', '14'],
          ['category', 'bebidas'],
        ],
        { blob: fileBlob(PNG_1PX, 'image/png'), name: 'foto.png' },
      ),
    });
    await expectStatus(created, 201);
    const product = await created.json();

    const res = await admin.ctx.patch(`/products/${product.id}`, {
      multipart: form([['price', '99']], { blob: fileBlob(Buffer.from('texto'), 'image/png'), name: 'x.png' }),
    });
    await expectNestError(res, 400);
    const after = await (await anon.get(`/products/${product.id}`)).json();
    expect(after.image).toBe(product.image);
    expectMoney(after.price, 14, 'preço intacto');
  });

  // -------------------------------------------------------------------------
  // Permissões
  // -------------------------------------------------------------------------

  test('anônimo recebe 401 em todas as escritas de produtos e na lixeira', async () => {
    const product = await createProduct(admin.ctx);
    const calls = [
      anon.post('/products', { data: { name: 'Hack', price: 1, category: 'bebidas' } }),
      anon.patch(`/products/${product.id}`, { data: { price: 0.01 } }),
      anon.delete(`/products/${product.id}`),
      anon.patch(`/products/${product.id}/restore`),
      anon.delete(`/products/${product.id}/permanent`),
      anon.get('/products/trash'),
    ];
    for (const res of await Promise.all(calls)) await expectStatus(res, 401);
    const after = await (await anon.get(`/products/${product.id}`)).json();
    expectMoney(after.price, 20, 'preço intacto');
  });

  test('401 de escrita anônima no catálogo segue o formato de erro do contrato {statusCode, message, error}', async () => {
    for (const res of await Promise.all([
      anon.post('/products', { data: { name: 'Hack', price: 1, category: 'bebidas' } }),
      anon.post('/addons', { data: { name: 'Hack', price: 1 } }),
    ]))
      await expectNestError(res, 401);
  });

  test('CLIENT, EMPLOYEE, KITCHEN e COURIER recebem 403 nas escritas de produtos e na lixeira', async () => {
    const product = await createProduct(admin.ctx);
    for (const actor of [client, employee, kitchen, courier]) {
      const role = actor.session.user.role;
      const calls = [
        actor.ctx.post('/products', { data: { name: `Hack ${role}`, price: 1, category: 'bebidas' } }),
        actor.ctx.patch(`/products/${product.id}`, { data: { price: 0.01 } }),
        actor.ctx.delete(`/products/${product.id}`),
        actor.ctx.patch(`/products/${product.id}/restore`),
        actor.ctx.delete(`/products/${product.id}/permanent`),
        actor.ctx.get('/products/trash'),
      ];
      for (const res of await Promise.all(calls)) await expectNestError(res, 403);
    }
    const after = await (await anon.get(`/products/${product.id}`)).json();
    expectMoney(after.price, 20, 'preço intacto');
  });

  // -------------------------------------------------------------------------
  // Edição
  // -------------------------------------------------------------------------

  test('ADMIN edita produto via multipart (nome, preço e nova imagem)', async () => {
    const product = await createProduct(admin.ctx, { price: 22 });
    const name = `Editado ${uid('ed')}`;
    const fd = form(
      [
        ['name', name],
        ['price', '31.5'],
      ],
      { blob: fileBlob(PNG_1PX, 'image/png'), name: 'nova.png' },
    );
    const res = await admin.ctx.patch(`/products/${product.id}`, { multipart: fd });
    await expectStatus(res, 200);
    const updated = await res.json();
    expect(updated.name).toBe(name);
    expectMoney(updated.price, 31.5, 'price');
    expect(updated.image).toMatch(/\.webp$/);
    expect((await anon.get(`/uploads/${updated.image}`)).status()).toBe(200);

    const reread = await (await anon.get(`/products/${product.id}`)).json();
    expect(reread.name).toBe(name);
  });

  test('ADMIN limpa adicionais permitidos e ingredientes enviando campos vazios no multipart', async () => {
    const product = await createProduct(admin.ctx, {
      allowed_addons_ids: [addonA.id, addonB.id],
      ingredients: ['Pão', 'Carne'],
    });
    const fd = form([
      ['allowed_addons_ids', ''],
      ['ingredients', ''],
    ]);
    const res = await admin.ctx.patch(`/products/${product.id}`, { multipart: fd });
    await expectStatus(res, 200);
    const reread = await (await anon.get(`/products/${product.id}`)).json();
    expect(reread.allowed_addons).toEqual([]);
    expect(reread.ingredients ?? []).toEqual([]);
  });

  test('ADMIN limpa adicionais com lista vazia e remove a promoção com null (JSON)', async () => {
    const product = await createProduct(admin.ctx, {
      price: 30,
      promotion_price: 25,
      allowed_addons_ids: [addonA.id],
    });
    const res = await admin.ctx.patch(`/products/${product.id}`, { data: { allowed_addons_ids: [], promotion_price: null } });
    await expectStatus(res, 200);
    const reread = await (await anon.get(`/products/${product.id}`)).json();
    expect(reread.allowed_addons).toEqual([]);
    expect(reread.promotion_price).toBeNull();
    expectMoney(reread.price, 30, 'preço mantido');
  });

  test('PATCH de produto sem campos não quebra e mantém o produto', async () => {
    const product = await createProduct(admin.ctx, { price: 19.9, allowed_addons_ids: [addonA.id] });
    const res = await admin.ctx.patch(`/products/${product.id}`, { data: {} });
    await expectStatus(res, 200);
    const data = await res.json();
    expect(data.name).toBe(product.name);
    expectMoney(data.price, 19.9, 'price');
    expect(ids(data.allowed_addons)).toEqual([addonA.id]);
  });

  test('PATCH de produto valida preço, promoção, null em obrigatórios e campos desconhecidos (400)', async () => {
    const product = await createProduct(admin.ctx, { price: 30, promotion_price: 25 });
    const id = product.id;
    await expectNestError(await admin.ctx.patch(`/products/${id}`, { data: { price: -5 } }), 400);
    await expectNestError(await admin.ctx.patch(`/products/${id}`, { data: { promotion_price: 35 } }), 400, /promocional/i);
    // Baixar o preço para abaixo da promoção atual também é inválido
    await expectNestError(await admin.ctx.patch(`/products/${id}`, { data: { price: 20 } }), 400, /promocional/i);
    await expectNestError(await admin.ctx.patch(`/products/${id}`, { data: { name: null } }), 400);
    await expectNestError(await admin.ctx.patch(`/products/${id}`, { data: { category: 'pizzas' } }), 400);
    await expectNestError(await admin.ctx.patch(`/products/${id}`, { data: { estoque: 3 } }), 400);

    const reread = await (await anon.get(`/products/${id}`)).json();
    expectMoney(reread.price, 30, 'price intacto');
    expectMoney(reread.promotion_price, 25, 'promotion_price intacto');
  });

  test('PATCH em produto desconhecido responde 404', async () => {
    await expectNestError(await admin.ctx.patch(`/products/${UNKNOWN_ID}`, { data: { price: 10 } }), 404);
  });

  // -------------------------------------------------------------------------
  // Lixeira e exclusão definitiva
  // -------------------------------------------------------------------------

  test('soft delete leva o produto para a lixeira e o restore devolve ao cardápio', async () => {
    const product = await createProduct(admin.ctx, { allowed_addons_ids: [addonA.id] });

    await expectStatus(await admin.ctx.delete(`/products/${product.id}`), 200);
    expect((await getProducts(anon)).some((p) => p.id === product.id), 'fora do cardápio').toBe(false);
    await expectNestError(await anon.get(`/products/${product.id}`), 404);
    // Excluir de novo: já está na lixeira
    await expectNestError(await admin.ctx.delete(`/products/${product.id}`), 404);

    const trashRes = await admin.ctx.get('/products/trash');
    await expectStatus(trashRes, 200);
    const trashed = (await trashRes.json()).find((p: Json) => p.id === product.id);
    expect(trashed, 'produto na lixeira').toBeTruthy();
    expect(trashed.deleted_at).toBeTruthy();

    const restoreRes = await admin.ctx.patch(`/products/${product.id}/restore`);
    await expectStatus(restoreRes, 200);
    const restored = await restoreRes.json();
    expect(restored.id).toBe(product.id);
    expect(restored.deleted_at).toBeNull();
    expect((await getProducts(anon)).some((p) => p.id === product.id), 'de volta ao cardápio').toBe(true);
    const trashAfter = await (await admin.ctx.get('/products/trash')).json();
    expect(trashAfter.some((p: Json) => p.id === product.id), 'saiu da lixeira').toBe(false);

    // Restaurar o que não está na lixeira
    await expectNestError(await admin.ctx.patch(`/products/${product.id}/restore`), 404);
  });

  test('excluir ou restaurar produto desconhecido responde 404', async () => {
    await expectNestError(await admin.ctx.delete(`/products/${UNKNOWN_ID}`), 404);
    await expectNestError(await admin.ctx.patch(`/products/${UNKNOWN_ID}/restore`), 404);
    await expectNestError(await admin.ctx.delete(`/products/${UNKNOWN_ID}/permanent`), 404);
  });

  test('exclusão definitiva de produto sem pedidos responde 200 e remove de vez', async () => {
    const product = await createProduct(admin.ctx, { allowed_addons_ids: [addonA.id, addonB.id] });
    await softDeleteProduct(admin.ctx, product.id);
    await expectStatus(await admin.ctx.delete(`/products/${product.id}/permanent`), 200);

    const trash = await (await admin.ctx.get('/products/trash')).json();
    expect(trash.some((p: Json) => p.id === product.id), 'fora da lixeira').toBe(false);
    await expectNestError(await anon.get(`/products/${product.id}`), 404);
    await expectNestError(await admin.ctx.patch(`/products/${product.id}/restore`), 404);
    await expectNestError(await admin.ctx.delete(`/products/${product.id}/permanent`), 404);
    // Os adicionais que ele permitia continuam existindo
    expect(ids(await getAddons(anon))).toEqual(expect.arrayContaining(ids([addonA, addonB])));
  });

  test('exclusão definitiva de produto presente em pedidos responde 409 e preserva o produto', async () => {
    const product = await createProduct(admin.ctx, { price: 15 });
    const order = await placeOrder(client.ctx, {
      items: [{ productId: product.id, quantity: 1 }],
      type: 'TAKEOUT',
      paymentMethod: 'MONEY',
    });

    // Ativo e com pedido
    await expectNestError(await admin.ctx.delete(`/products/${product.id}/permanent`), 409);
    // Na lixeira e com pedido
    await softDeleteProduct(admin.ctx, product.id);
    await expectNestError(await admin.ctx.delete(`/products/${product.id}/permanent`), 409, /pedidos/i);

    const trash = await (await admin.ctx.get('/products/trash')).json();
    expect(trash.some((p: Json) => p.id === product.id), 'continua na lixeira').toBe(true);
    const orderRes = await client.ctx.get(`/orders/${order.id}`);
    await expectStatus(orderRes, 200);
    expect((await orderRes.json()).items[0].product?.id).toBe(product.id);
  });

  // -------------------------------------------------------------------------
  // Adicionais
  // -------------------------------------------------------------------------

  test('GET /addons é público e não lista adicionais excluídos', async () => {
    const kept = await createAddon(admin.ctx);
    const removed = await createAddon(admin.ctx);
    await deleteAddon(admin.ctx, removed.id);

    const list = await getAddons(anon);
    expect(list.some((a) => a.id === kept.id), 'adicional ativo').toBe(true);
    expect(list.some((a) => a.id === removed.id), 'adicional excluído').toBe(false);
  });

  test('ADMIN cria adicional com padrões (categoria geral, disponível, sem descrição)', async () => {
    const name = `Ovo ${uid('ovo')}`;
    const res = await admin.ctx.post('/addons', { data: { name: `  ${name}  `, price: 4.5 } });
    await expectStatus(res, 201);
    const addon = await res.json();
    expect(addon).toMatchObject({ name, category: 'geral', available: true });
    expect(addon.description ?? null).toBeNull();
    expectMoney(addon.price, 4.5, 'price');
    expect((await getAddons(anon)).some((a) => a.id === addon.id)).toBe(true);
  });

  test('cadastro de adicional valida nome, preço e campos desconhecidos (400)', async () => {
    const name = `Adicional Ruim ${uid('ar')}`;
    const invalid: Record<string, unknown>[] = [
      { price: 2 },
      { name: '', price: 2 },
      { name: 'x'.repeat(61), price: 2 },
      { name },
      { name, price: -1 },
      { name, price: 'abc' },
      { name, price: 2, available: 'talvez' },
      { name, price: 2, estoque: 5 },
    ];
    for (const data of invalid) await expectNestError(await admin.ctx.post('/addons', { data }), 400);
    expect((await getAddons(anon)).some((a) => a.name === name), 'nada foi criado').toBe(false);
  });

  test('somente ADMIN cria, altera e exclui adicionais (anônimo 401, demais perfis 403)', async () => {
    const addon = await createAddon(admin.ctx, { price: 6 });

    for (const res of await Promise.all([
      anon.post('/addons', { data: { name: 'Hack', price: -100 } }),
      anon.patch(`/addons/${addon.id}`, { data: { price: -100 } }),
      anon.delete(`/addons/${addon.id}`),
    ]))
      await expectStatus(res, 401);

    for (const actor of [client, employee, kitchen, courier]) {
      for (const res of await Promise.all([
        actor.ctx.post('/addons', { data: { name: 'Hack', price: 1 } }),
        actor.ctx.patch(`/addons/${addon.id}`, { data: { price: 0.01 } }),
        actor.ctx.delete(`/addons/${addon.id}`),
      ]))
        await expectNestError(res, 403);
    }

    const current = (await getAddons(anon)).find((a) => a.id === addon.id);
    expect(current, 'adicional continua ativo').toBeTruthy();
    expectMoney(current.price, 6, 'preço intacto');
  });

  test('ADMIN altera adicional (preço e disponibilidade) e PATCH vazio não quebra', async () => {
    const addon = await createAddon(admin.ctx, { price: 3, category: 'bebidas' });
    const res = await admin.ctx.patch(`/addons/${addon.id}`, { data: { price: 5.25, available: false } });
    await expectStatus(res, 200);
    const updated = await res.json();
    expectMoney(updated.price, 5.25, 'price');
    expect(updated.available).toBe(false);

    const empty = await admin.ctx.patch(`/addons/${addon.id}`, { data: {} });
    await expectStatus(empty, 200);
    const same = await empty.json();
    expect(same).toMatchObject({ id: addon.id, name: addon.name, available: false, category: 'bebidas' });
    expectMoney(same.price, 5.25, 'price mantido');
  });

  test('PATCH de adicional recusa null em nome/preço, preço negativo e campos desconhecidos (400)', async () => {
    const addon = await createAddon(admin.ctx, { price: 3 });
    for (const data of [{ name: null }, { price: null }, { price: -2 }, { available: null }, { estoque: 1 }]) {
      await expectNestError(await admin.ctx.patch(`/addons/${addon.id}`, { data }), 400);
    }
    const current = (await getAddons(anon)).find((a) => a.id === addon.id);
    expect(current.name).toBe(addon.name);
    expectMoney(current.price, 3, 'preço intacto');
  });

  test('adicional desconhecido responde 404 e id inválido responde 400', async () => {
    await expectNestError(await admin.ctx.patch(`/addons/${UNKNOWN_ID}`, { data: { price: 1 } }), 404);
    await expectNestError(await admin.ctx.delete(`/addons/${UNKNOWN_ID}`), 404);
    await expectNestError(await admin.ctx.patch('/addons/abc', { data: { price: 1 } }), 400);
    await expectNestError(await admin.ctx.delete('/addons/abc'), 400);
  });

  test('ADMIN exclui adicional: some de GET /addons e dos produtos que o permitiam; nova exclusão 404', async () => {
    const addon = await createAddon(admin.ctx);
    const product = await createProduct(admin.ctx, { allowed_addons_ids: [addon.id, addonA.id] });

    await expectStatus(await admin.ctx.delete(`/addons/${addon.id}`), 200);
    expect((await getAddons(anon)).some((a) => a.id === addon.id)).toBe(false);
    const reread = await (await anon.get(`/products/${product.id}`)).json();
    expect(ids(reread.allowed_addons)).toEqual([addonA.id]);

    await expectNestError(await admin.ctx.delete(`/addons/${addon.id}`), 404);
    await expectNestError(await admin.ctx.patch(`/addons/${addon.id}`, { data: { price: 1 } }), 404);
  });
});
