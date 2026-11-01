/**
 * Sessão de suporte (acesso assistido; pedido §6.5; arquitetura §11.6): iniciar exige motivo; o token
 * vale como ADMIN SOMENTE LEITURA do painel daquela loja (toda escrita → 403: uploads, configurações,
 * pagamentos, assinatura, equipe, cardápio e pedidos), não acessa o superpainel nem outra loja,
 * expira com a sessão, deixa de valer ao encerrar e início/fim ficam na auditoria (sem o token).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  MISSING_ID,
  MSG,
  STRONG_PASSWORD,
  bearer,
  cleanupPlatformData,
  completeOrder,
  createPlan,
  createProductAs,
  endSupportSession,
  expectApiError,
  expectAuditRecord,
  expectNoSecretValues,
  expectOk,
  freshSession,
  jwtClaims,
  newApi,
  newClientAccount,
  openStore,
  placeTakeoutOrder,
  startSupportSession,
  storeWithOwner,
  uniqueEmail,
  type Json,
  type Session,
  type StoreWithOwner,
  type SupportSession,
  type TestAccount,
} from './helpers';
import { makePng, pngFile, uploadedFiles } from '../identity/helpers';

let api: APIRequestContext;
let sa: Session;
let store: StoreWithOwner;
let other: StoreWithOwner;
let client: TestAccount;
let product: Json;
let addon: Json;
let member: Json;
let order: Json;
let invitation: Json;
let otherOrder: Json;
let otherClient: TestAccount;
let support: SupportSession;

test.beforeAll(async () => {
  api = await newApi();
  sa = await freshSession(api, 'superadmin');
  const plan = await createPlan(api, sa.token, {
    price: 0,
    features: { online_payments: true, advanced_reports: true, custom_branding: true },
  });
  store = await storeWithOwner(api, sa.token, { planId: plan.id });
  other = await storeWithOwner(api, sa.token, { planId: plan.id });
  const owner = bearer(store.owner.token);

  await openStore(api, store.owner.token);
  addon = await expectOk(await api.post('/addons', { headers: owner, data: { name: 'Queijo extra', price: 3 } }), 201);
  product = await createProductAs(api, store.owner.token, { name: 'Burger do Suporte', price: 27.5 });
  member = await expectOk(
    await api.post('/users', {
      headers: owner,
      data: { name: 'Atendente do Suporte', email: uniqueEmail('plat-suporte-func'), password: STRONG_PASSWORD, role: 'EMPLOYEE' },
    }),
    201,
  );
  invitation = (
    await expectOk(await api.post('/store/invitations', { headers: owner, data: { email: uniqueEmail('plat-suporte-conv'), role: 'COURIER' } }), 201)
  ).invitation;
  client = await newClientAccount(api, 'Cliente do Suporte');
  order = await placeTakeoutOrder(api, client.token, store.slug, [{ productId: product.id, quantity: 2 }]);

  // Outra loja com pedido e cliente próprios (para o "não acessa outra loja")
  await openStore(api, other.owner.token);
  const otherProduct = await createProductAs(api, other.owner.token, { price: 11 });
  otherClient = await newClientAccount(api, 'Cliente da Outra Loja');
  otherOrder = await placeTakeoutOrder(api, otherClient.token, other.slug, [{ productId: otherProduct.id, quantity: 1 }]);
  await completeOrder(api, other.owner.token, otherOrder.id);

  support = await startSupportSession(api, sa.token, store.id, 'Chamado 4321: conferir pedidos e cardápio com o responsável.');
});

test.afterAll(async () => {
  if (!api) return;
  try {
    await cleanupPlatformData(api, sa.token);
  } finally {
    await api.dispose();
  }
});

test.describe('Início da sessão de suporte (POST /platform/stores/:id/support-sessions)', () => {
  test('exige motivo de 10 a 300 caracteres e uma loja existente; devolve o token uma única vez', async () => {
    const start = (data: Record<string, unknown>, storeId = store.id) =>
      api.post(`/platform/stores/${storeId}/support-sessions`, { headers: bearer(sa.token), data });
    await expectApiError(await start({}), 400, 'Informe o motivo da sessão de suporte.');
    await expectApiError(await start({ reason: '   ' }), 400, 'Informe o motivo da sessão de suporte.');
    await expectApiError(await start({ reason: 'curto' }), 400, 'Descreva o motivo com pelo menos 10 caracteres.');
    await expectApiError(await start({ reason: 'x'.repeat(301) }), 400, 'O motivo pode ter no máximo 300 caracteres.');
    await expectApiError(await start({ reason: 'Motivo suficiente para o teste' }, MISSING_ID), 404, MSG.storeNotFound);
    await expectApiError(
      await start({ reason: 'Motivo suficiente para o teste', store_id: other.id }),
      400,
      'property store_id should not exist',
    );

    expect(support.session).toMatchObject({
      store_id: store.id,
      store: { id: store.id, slug: store.slug },
      platform_user_id: sa.user.id,
      platform_user: { id: sa.user.id },
      reason: 'Chamado 4321: conferir pedidos e cardápio com o responsável.',
      ended_at: null,
      status: 'ACTIVE',
      active: true,
    });
    // O token é da conta do PRÓPRIO superadmin (nunca do lojista), com o id da sessão e a validade dela
    const claims = jwtClaims(support.token);
    expect(claims).toMatchObject({ sub: sa.user.id, sid: support.id });
    expect(claims.sub).not.toBe(store.owner.user.id);
    expect(Math.abs(claims.exp * 1000 - new Date(support.expiresAt).getTime())).toBeLessThan(5_000);

    // A lista mostra a sessão (sem o token)
    const list = await expectOk(
      await api.get(`/platform/support-sessions?store_id=${store.id}&active=true`, { headers: bearer(sa.token) }),
      200,
    );
    expect(list.items.map((session: Json) => session.id)).toContain(support.id);
    expectNoSecretValues(list, [support.token], 'GET /platform/support-sessions');
  });
});

test.describe('Token de suporte: somente leitura do painel da loja', () => {
  test('lê o painel da loja como ADMIN (configurações, pedidos, cardápio, equipe, clientes, assinatura)', async () => {
    const headers = bearer(support.token);
    const me = await expectOk(await api.get('/auth/me', { headers }), 200);
    expect(me).toMatchObject({
      id: sa.user.id,
      role: 'ADMIN',
      store_id: store.id,
      platform_role: null,
      store: { id: store.id, slug: store.slug },
      support_session: { id: support.id, store_id: store.id },
    });

    const reads: Array<[string, (payload: Json) => void]> = [
      ['/store/settings', (s) => expect(s).toMatchObject({ id: store.id, slug: store.slug })],
      ['/store/subscription', (s) => expect(s.subscription).toMatchObject({ status: 'ACTIVE' })],
      ['/orders', (list) => expect(list.map((o: Json) => o.id)).toEqual([order.id])],
      [`/orders/${order.id}`, (o) => expect(o).toMatchObject({ id: order.id, store_id: store.id })],
      [`/stores/${store.slug}/orders`, (list) => expect(list.map((o: Json) => o.id)).toEqual([order.id])],
      ['/orders/summary', (s) => expect(s.totalOrders).toBe(1)],
      ['/orders/reports', (r) => expect(r.summary.orders).toBe(1)],
      ['/products', (list) => expect(list.map((p: Json) => p.id)).toEqual([product.id])],
      ['/products/trash', (list) => expect(list).toEqual([])],
      ['/addons', (list) => expect(list.map((a: Json) => a.id)).toEqual([addon.id])],
      ['/users', (list) => expect(list.map((u: Json) => u.id).sort()).toEqual([store.owner.user.id, member.id].sort())],
      ['/users/trash', (list) => expect(list).toEqual([])],
      [`/users/${member.id}`, (u) => expect(u).toMatchObject({ id: member.id, role: 'EMPLOYEE' })],
      ['/store/customers', (page) => expect(page.items.map((c: Json) => c.id)).toEqual([client.user.id])],
      [`/store/customers/${client.user.id}`, (c) => expect(JSON.stringify(c)).toContain(client.email)],
      ['/store/invitations', (page) => expect(page.items.map((i: Json) => i.id)).toContain(invitation.id)],
    ];
    for (const [path, check] of reads) {
      const payload = await expectOk(await api.get(path, { headers }), 200, `GET ${path} com o token de suporte`);
      check(payload);
    }
  });

  test('toda escrita no painel → 403 (uploads, configurações, pagamentos, assinatura, equipe, cardápio, pedidos) e nada muda', async () => {
    const headers = bearer(support.token);
    const filesBefore = new Set(uploadedFiles());
    const writes: Array<{ method: string; path: string; data?: unknown; multipart?: boolean; message?: string }> = [
      { method: 'POST', path: '/uploads', multipart: true },
      { method: 'POST', path: '/store/logo', multipart: true },
      { method: 'DELETE', path: '/store/logo' },
      { method: 'PATCH', path: '/store/settings', data: { description: 'Alterado pelo suporte' } },
      { method: 'PATCH', path: '/store/status', data: { is_open: false } },
      {
        method: 'PUT',
        path: '/store/settings/payments',
        data: { mp_public_key: 'TEST-chave-do-suporte', mp_access_token: 'TEST-token-do-suporte-12345678' },
      },
      { method: 'DELETE', path: '/store/settings/payments' },
      { method: 'POST', path: '/store/subscription/checkout', data: {} },
      { method: 'POST', path: '/store/subscription/cancel', data: { reason: 'Cancelado pelo suporte' } },
      { method: 'POST', path: '/store/subscription/resume' },
      { method: 'POST', path: '/store/invitations', data: { email: uniqueEmail('plat-suporte-novo'), role: 'KITCHEN' } },
      { method: 'DELETE', path: `/store/invitations/${invitation.id}` },
      {
        method: 'POST',
        path: '/users',
        data: { name: 'Criado pelo suporte', email: uniqueEmail('plat-suporte-equipe'), password: STRONG_PASSWORD, role: 'ADMIN' },
        message: MSG.supportReadOnly,
      },
      { method: 'PATCH', path: `/users/${member.id}`, data: { role: 'ADMIN' }, message: MSG.supportReadOnly },
      { method: 'DELETE', path: `/users/${member.id}`, message: MSG.supportReadOnly },
      { method: 'PATCH', path: `/users/${member.id}/restore` },
      { method: 'DELETE', path: `/users/${member.id}/permanent` },
      { method: 'POST', path: '/products', data: { name: 'Produto do suporte', price: 1, category: 'bebidas' } },
      { method: 'PATCH', path: `/products/${product.id}`, data: { price: 0.5 } },
      { method: 'DELETE', path: `/products/${product.id}` },
      { method: 'PATCH', path: `/products/${product.id}/restore` },
      { method: 'DELETE', path: `/products/${product.id}/permanent` },
      { method: 'POST', path: '/addons', data: { name: 'Adicional do suporte', price: 1 } },
      { method: 'PATCH', path: `/addons/${addon.id}`, data: { price: 0.1 } },
      { method: 'DELETE', path: `/addons/${addon.id}` },
      { method: 'PATCH', path: `/orders/${order.id}`, data: { status: 'PREPARING' } },
      { method: 'PATCH', path: `/stores/${store.slug}/orders/${order.id}`, data: { status: 'CANCELED' } },
      { method: 'PATCH', path: `/orders/${order.id}/assign`, data: { driverId: member.id } },
      // Rota do cliente (fora do painel da loja): recusada pela regra global de somente leitura
      { method: 'PATCH', path: `/orders/${order.id}/cancel`, message: MSG.supportReadOnly },
    ];
    for (const write of writes) {
      const res = await api.fetch(write.path, {
        method: write.method,
        headers,
        ...(write.multipart ? { multipart: { file: pngFile(makePng(8, 8)) } } : write.data === undefined ? {} : { data: write.data }),
      });
      await expectApiError(res, 403, write.message ?? MSG.supportReadOnlyStore, `${write.method} ${write.path} com o token de suporte`);
    }
    // Compras e pagamentos: o token não é de cliente
    const cart = { items: [{ productId: product.id, quantity: 1 }], type: 'TAKEOUT' };
    for (const [path, data] of [
      [`/stores/${store.slug}/orders/quote`, cart],
      [`/stores/${store.slug}/orders`, { ...cart, paymentMethod: 'MONEY' }],
      [`/stores/${store.slug}/payment/pix`, { order: cart }],
      [`/stores/${store.slug}/payment/card`, { order: cart, token: 'tok-suporte', paymentMethodId: 'master', installments: 1 }],
    ] as const) {
      await expectApiError(await api.post(path, { headers, data }), 403, /Somente clientes fazem pedidos e pagamentos/, `POST ${path}`);
    }

    // Nada mudou: conferido pelo ADMIN da loja e pelo superpainel
    const owner = bearer(store.owner.token);
    const settings = await expectOk(await api.get('/store/settings', { headers: owner }), 200);
    expect(settings).toMatchObject({ description: null, logo: null, is_open: true, payments: { access_token_configured: false } });
    expect((await expectOk(await api.get(`/orders/${order.id}`, { headers: owner }), 200)).status).toBe('PENDING');
    const products = await expectOk(await api.get('/products', { headers: owner }), 200);
    expect(products.map((p: Json) => [p.id, Number(p.price)])).toEqual([[product.id, 27.5]]);
    expect((await expectOk(await api.get('/addons', { headers: owner }), 200)).map((a: Json) => [a.id, Number(a.price)])).toEqual([[addon.id, 3]]);
    const team = await expectOk(await api.get('/users', { headers: owner }), 200);
    expect(team.map((u: Json) => [u.id, u.role]).sort()).toEqual([[store.owner.user.id, 'ADMIN'], [member.id, 'EMPLOYEE']].sort());
    const invitations = await expectOk(await api.get('/store/invitations', { headers: owner }), 200);
    // O convite do responsável (aceito na criação da loja) e o convite pendente: nenhum novo, nenhum revogado
    expect(invitations.items.map((i: Json) => `${i.id}:${i.status}`)).toEqual([`${invitation.id}:PENDING`, expect.stringMatching(/:ACCEPTED$/)]);
    const detail = await expectOk(await api.get(`/platform/stores/${store.id}`, { headers: bearer(sa.token) }), 200);
    expect(detail.subscription).toMatchObject({ status: 'ACTIVE', cancel_at_period_end: false });
    expect(uploadedFiles().filter((file) => !filesBefore.has(file)), 'nenhum arquivo gravado pelo suporte').toEqual([]);
  });

  test('a conta do próprio operador também não é alterada com o token de suporte (PATCH/DELETE /users/:id → 403)', async () => {
    const headers = bearer(support.token);
    await expectApiError(await api.patch(`/users/${sa.user.id}`, { headers, data: { name: 'Renomeado pelo suporte' } }), 403, MSG.supportReadOnly);
    await expectApiError(
      await api.patch(`/users/${sa.user.id}`, { headers, data: { password: 'NovaSenha@12345' } }),
      403,
      MSG.supportReadOnly,
    );
    await expectApiError(await api.delete(`/users/${sa.user.id}`, { headers }), 403, MSG.supportReadOnly);
    const account = await expectOk(await api.get(`/platform/users/${sa.user.id}`, { headers: bearer(sa.token) }), 200);
    expect(account).toMatchObject({ name: sa.user.name, deleted_at: null, platform_role: 'SUPER_ADMIN' });
  });

  test('qualquer escrita com o token de suporte é recusada, inclusive fora do painel (endereços da conta)', async () => {
    const before = await expectOk(await api.get('/addresses', { headers: bearer(sa.token) }), 200);
    try {
      const res = await api.post('/addresses', {
        headers: bearer(support.token),
        data: { zipCode: '20040-002', street: 'Rua do Suporte', number: '1', neighborhood: 'Centro', city: 'Rio de Janeiro', state: 'RJ' },
      });
      await expectApiError(res, 403, MSG.supportReadOnly, 'POST /addresses com o token de suporte');
      // Outras escritas fora do painel da loja: endereços existentes, "encerrar sessões" da conta do operador
      const own = before[0] as Json | undefined;
      if (own) {
        await expectApiError(
          await api.patch(`/addresses/${own.id}`, { headers: bearer(support.token), data: { number: '2' } }),
          403,
          MSG.supportReadOnly,
          'PATCH /addresses/:id com o token de suporte',
        );
        await expectApiError(
          await api.delete(`/addresses/${own.id}`, { headers: bearer(support.token) }),
          403,
          MSG.supportReadOnly,
          'DELETE /addresses/:id com o token de suporte',
        );
      }
      await expectApiError(
        await api.post('/auth/logout-all', { headers: bearer(support.token) }),
        403,
        MSG.supportReadOnly,
        'POST /auth/logout-all com o token de suporte',
      );
      // Leitura continua valendo e o token do superpainel não caiu
      expect((await api.get('/addresses', { headers: bearer(support.token) })).status()).toBe(200);
      expect((await api.get('/platform/dashboard', { headers: bearer(sa.token) })).status()).toBe(200);
    } finally {
      // Remove o que o token de suporte tiver gravado na conta do superadmin (estado limpo para as outras suítes)
      const after = await expectOk(await api.get('/addresses', { headers: bearer(sa.token) }), 200);
      const known = new Set(before.map((address: Json) => address.id));
      for (const address of after) {
        if (!known.has(address.id)) await api.delete(`/addresses/${address.id}`, { headers: bearer(sa.token) });
      }
    }
  });

  test('não acessa o superpainel, a rota de outra loja nem dados de outra loja', async () => {
    const headers = bearer(support.token);
    for (const path of ['/platform/dashboard', `/platform/stores/${store.id}`, '/platform/support-sessions']) {
      await expectApiError(await api.get(path, { headers }), 403, MSG.platformOnly, `GET ${path}`);
    }
    await expectApiError(
      await api.post(`/platform/support-sessions/${support.id}/end`, { headers }),
      403,
      MSG.platformOnly,
      'o próprio token não encerra (nem prolonga) a sessão',
    );
    await expectApiError(
      await api.post(`/platform/stores/${other.id}/support-sessions`, { headers, data: { reason: 'Escalar para outra loja' } }),
      403,
      MSG.platformOnly,
    );
    await expectApiError(
      await api.get(`/stores/${other.slug}/orders`, { headers }),
      403,
      'Você só pode administrar a loja à qual a sua conta pertence.',
    );
    await expectApiError(await api.get(`/orders/${otherOrder.id}`, { headers }), 404, 'Pedido não encontrado.');
    await expectApiError(await api.get(`/users/${other.owner.user.id}`, { headers }), 404);
    await expectApiError(await api.get(`/store/customers/${otherClient.user.id}`, { headers }), 404, 'Cliente não encontrado.');
    // A loja da sessão vem do servidor: nada no pedido troca de loja
    const settings = await expectOk(
      await api.get(`/store/settings?store_id=${other.id}`, { headers: { ...headers, 'X-Store-Id': String(other.id) } }),
      200,
    );
    expect(settings.id).toBe(store.id);
  });
});

test.describe('Fim da sessão de suporte', () => {
  test('encerrar invalida o token na hora; encerrar de novo é idempotente; início e fim ficam na auditoria sem o token', async () => {
    const session = await startSupportSession(api, sa.token, store.id, 'Chamado 9876: validar o encerramento da sessão.');
    const headers = bearer(session.token);
    expect((await api.get('/store/settings', { headers })).status()).toBe(200);

    const ended = await endSupportSession(api, sa.token, session.id);
    expect(ended).toMatchObject({ id: session.id, status: 'ENDED', active: false });
    expect(ended.ended_at).not.toBeNull();
    for (const path of ['/store/settings', '/orders', '/auth/me']) {
      await expectApiError(await api.get(path, { headers }), 401, MSG.supportEnded, `GET ${path} depois do fim`);
    }
    const again = await endSupportSession(api, sa.token, session.id);
    expect(again.ended_at, 'encerramento idempotente').toBe(ended.ended_at);
    await expectApiError(
      await api.post(`/platform/support-sessions/${MISSING_ID}/end`, { headers: bearer(sa.token) }),
      404,
      'Sessão de suporte não encontrada.',
    );

    const inactive = await expectOk(
      await api.get(`/platform/support-sessions?store_id=${store.id}&active=false`, { headers: bearer(sa.token) }),
      200,
    );
    expect(inactive.items.find((item: Json) => item.id === session.id)).toMatchObject({ status: 'ENDED' });
    const active = await expectOk(
      await api.get(`/platform/support-sessions?store_id=${store.id}&active=true`, { headers: bearer(sa.token) }),
      200,
    );
    expect(active.items.map((item: Json) => item.id)).not.toContain(session.id);
    // O token normal do superadmin continua valendo (só a sessão de suporte terminou)
    expect((await api.get('/platform/dashboard', { headers: bearer(sa.token) })).status()).toBe(200);

    const started = await expectAuditRecord(api, sa.token, {
      action: 'platform.support_session.start',
      targetType: 'support_session',
      targetId: session.id,
      storeId: store.id,
      actorId: sa.user.id,
      actorScope: 'PLATFORM',
      secrets: [session.token],
    });
    expect(started.metadata).toMatchObject({ reason: 'Chamado 9876: validar o encerramento da sessão.', store_slug: store.slug });
    const finished = await expectAuditRecord(api, sa.token, {
      action: 'platform.support_session.end',
      targetType: 'support_session',
      targetId: session.id,
      storeId: store.id,
      actorId: sa.user.id,
      secrets: [session.token],
    });
    expect(finished.metadata).toMatchObject({ opened_by_user_id: sa.user.id, expired_before_end: false });
    const endRecords = await expectOk(
      await api.get(`/platform/audit?action=platform.support_session.end&target_type=support_session&target_id=${session.id}`, {
        headers: bearer(sa.token),
      }),
      200,
    );
    expect(endRecords.total, 'o segundo encerramento não gera outro registro').toBe(1);
  });
});
