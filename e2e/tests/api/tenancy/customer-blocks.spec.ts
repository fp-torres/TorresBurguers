import { test, expect, type APIRequestContext } from '@playwright/test';
import { loginAs } from '../../../support/api';
import { expectAuditRecord } from '../platform/helpers';
import {
  Cleanup,
  MISSING_ID,
  MSG,
  addProduct,
  bearer,
  cardBody,
  createStore,
  demoStore,
  demoTeam,
  expectError,
  expectStatus,
  getJson,
  inviteMember,
  newApi,
  newCustomer,
  placeOrder,
  retireStore,
  storePath,
  trashProductLater,
  type Json,
  type Member,
  type OrderInput,
  type PublicStore,
  type Session,
  type TenantStore,
} from './helpers';

const BLOCKED = 'Não é possível fazer pedidos nesta loja. Fale com a loja.';
const NOT_BLOCKED = 'Este cliente não está bloqueado nesta loja.';
const ALREADY_BLOCKED = 'Este cliente já está bloqueado nesta loja.';
const REASON = 'Três pedidos falsos com endereço inexistente (E2E).';

/**
 * Bloqueio de cliente pela loja (pendência da arquitetura §12; abuso de pedidos falsos): o ADMIN bloqueia um
 * cliente que já pediu na loja; ele deixa de orçar, pedir e pagar (PIX e cartão) NESTA loja (403 genérico,
 * sem o motivo) e continua comprando nas outras. Desbloquear devolve o acesso. Tudo auditado.
 */
test.describe('Bloqueio de cliente pela loja', () => {
  // Os testes seguem a história do mesmo bloqueio (bloquear → conferir → desbloquear → auditoria)
  test.describe.configure({ mode: 'serial' });
  const cleanup = new Cleanup();
  let api: APIRequestContext;
  let superadmin: Session;
  let storeA: TenantStore;
  let storeB: TenantStore;
  let productA: Json;
  let productB: Json;
  let employeeA: Member;
  let customer: Member;
  let other: Member;

  const takeout = (product: Json): OrderInput => ({ items: [{ productId: product.id, quantity: 1 }], type: 'TAKEOUT' });
  const block = (admin: Session, userId: number, data: unknown = { reason: REASON }) =>
    api.post(`/store/customers/${userId}/block`, { headers: bearer(admin.token), data });
  const unblock = (admin: Session, userId: number) =>
    api.delete(`/store/customers/${userId}/block`, { headers: bearer(admin.token) });
  /** As 4 compras na vitrine: orçamento, pedido pago na entrega, PIX e cartão. */
  const purchases = (slug: string | null, buyer: Session, product: Json) => {
    const path = (route: string) => (slug ? storePath(slug, route) : route);
    const headers = bearer(buyer.token);
    const order = takeout(product);
    return {
      quote: () => api.post(path('/orders/quote'), { headers, data: order }),
      order: () => api.post(path('/orders'), { headers, data: { ...order, paymentMethod: 'MONEY' } }),
      pix: () => api.post(path('/payment/pix'), { headers, data: { order } }),
      card: () => api.post(path('/payment/card'), { headers, data: cardBody(order) }),
    };
  };

  test.beforeAll(async () => {
    api = await newApi();
    superadmin = await loginAs(api, 'superadmin');
    storeA = await createStore(api, superadmin, 'BloqueioA');
    cleanup.add('desativar a loja A', () => retireStore(api, superadmin, storeA));
    storeB = await createStore(api, superadmin, 'BloqueioB');
    cleanup.add('desativar a loja B', () => retireStore(api, superadmin, storeB));
    productA = await addProduct(api, storeA.owner, { price: 25 });
    productB = await addProduct(api, storeB.owner, { price: 26 });
    employeeA = await inviteMember(api, storeA.owner, 'EMPLOYEE');
    customer = await newCustomer(api, 'Bloqueado');
    other = await newCustomer(api, 'Livre');
    // Clientes da loja A = quem já pediu nela
    await placeOrder(api, storeA.slug, customer, takeout(productA));
    await placeOrder(api, storeA.slug, other, takeout(productA));
  });

  test.afterAll(async () => {
    await cleanup.run();
    await api.dispose();
  });

  test('ADMIN bloqueia: o cliente não orça, não pede nem paga nesta loja (403 genérico) e compra nas outras', async () => {
    const created = await expectStatus(await block(storeA.owner, customer.user.id), 201, 'POST block');
    expect(created).toEqual({
      reason: REASON,
      blocked_at: expect.any(String),
      blocked_by: { id: storeA.owner.user.id, name: storeA.owner.user.name },
    });

    const inA = purchases(storeA.slug, customer, productA);
    for (const [label, attempt] of Object.entries(inA)) {
      const payload = await expectError(await attempt(), 403, BLOCKED, `${label} na loja que bloqueou`);
      // O motivo é interno da loja: nunca aparece para o cliente
      expect(JSON.stringify(payload)).not.toContain('pedidos falsos');
    }

    // Outra loja: o mesmo cliente compra normalmente (orçamento, pedido e cartão)
    const inB = purchases(storeB.slug, customer, productB);
    await expectStatus(await inB.quote(), 200, 'orçamento na loja B');
    const orderB = await expectStatus(await inB.order(), 201, 'pedido na loja B');
    expect(orderB.store_id).toBe(storeB.id);
    const cardB = await expectStatus(await inB.card(), 201, 'cartão na loja B');
    expect(cardB.status).toBe('approved');

    // Outro cliente na loja A: nada muda para ele
    await expectStatus(await purchases(storeA.slug, other, productA).order(), 201, 'outro cliente na loja A');
  });

  test('rotas antigas (app mobile, loja padrão): o bloqueio da loja padrão vale em /orders e /payment', async () => {
    const demo: PublicStore = await demoStore();
    const demoAdmin = (await demoTeam(api)).ADMIN;
    expect(demoAdmin.user.store_id).toBe(demo.id);
    const product = await addProduct(api, demoAdmin, { price: 19 });
    trashProductLater(cleanup, api, demoAdmin, product.id);
    const buyer = await newCustomer(api, 'Bloqueado Demo');
    await expectStatus(await purchases(null, buyer, product).order(), 201, 'primeiro pedido na loja padrão');

    await expectStatus(await block(demoAdmin, buyer.user.id), 201, 'bloqueio na loja padrão');
    cleanup.add('desbloquear o cliente da loja padrão', () => unblock(demoAdmin, buyer.user.id));
    const legacy = purchases(null, buyer, product);
    for (const [label, attempt] of Object.entries(legacy)) {
      await expectError(await attempt(), 403, BLOCKED, `${label} pela rota antiga`);
    }
    await expectStatus(await unblock(demoAdmin, buyer.user.id), 204, 'desbloqueio na loja padrão');
    await expectStatus(await legacy.quote(), 200, 'orçamento depois do desbloqueio');
  });

  test('GET /store/customers mostra o bloqueio (lista, ?blocked e detalhe); o atendente vê, mas não bloqueia', async () => {
    for (const viewer of [storeA.owner, employeeA]) {
      const page = await getJson(api, '/store/customers?pageSize=100', viewer.token);
      const blockedRow = (page.items as Json[]).find((item) => item.id === customer.user.id);
      const freeRow = (page.items as Json[]).find((item) => item.id === other.user.id);
      expect(blockedRow).toMatchObject({
        blocked: true,
        block: { reason: REASON, blocked_by: { id: storeA.owner.user.id } },
      });
      expect(freeRow).toMatchObject({ blocked: false, block: null });
    }

    const onlyBlocked = await getJson(api, '/store/customers?blocked=true', storeA.owner.token);
    expect((onlyBlocked.items as Json[]).map((item) => item.id)).toEqual([customer.user.id]);
    expect(onlyBlocked.total).toBe(1);
    const notBlocked = await getJson(api, '/store/customers?blocked=false&pageSize=100', storeA.owner.token);
    expect((notBlocked.items as Json[]).map((item) => item.id)).not.toContain(customer.user.id);
    expect((notBlocked.items as Json[]).map((item) => item.id)).toContain(other.user.id);
    await expectError(
      await api.get('/store/customers?blocked=talvez', { headers: bearer(storeA.owner.token) }),
      400,
      'blocked deve ser true ou false.',
    );

    const detail = await getJson(api, `/store/customers/${customer.user.id}`, employeeA.token);
    expect(detail.block).toMatchObject({ reason: REASON, blocked_by: { id: storeA.owner.user.id } });
    expect((await getJson(api, `/store/customers/${other.user.id}`, employeeA.token)).block).toBeNull();

    // Loja B: o cliente não está bloqueado lá
    const inB = await getJson(api, `/store/customers/${customer.user.id}`, storeB.owner.token);
    expect(inB.block).toBeNull();

    // Atendente (e qualquer perfil que não seja ADMIN) não bloqueia nem desbloqueia
    await expectError(await block(employeeA, other.user.id), 403, MSG.noPermission, 'atendente bloqueando');
    await expectError(await unblock(employeeA, customer.user.id), 403, MSG.noPermission, 'atendente desbloqueando');
  });

  test('isolamento e validação: só clientes desta loja, 404 uniforme, motivo obrigatório, 409 se já bloqueado', async () => {
    // "other" nunca pediu na loja B: para B ele não é cliente (igual a um id inexistente)
    const foreign = await expectError(await block(storeB.owner, other.user.id), 404, MSG.customerNotFound);
    const missing = await expectError(await block(storeB.owner, MISSING_ID), 404, MSG.customerNotFound);
    expect(foreign).toEqual(missing);
    // A loja B não desfaz o bloqueio da loja A
    await expectError(await unblock(storeB.owner, customer.user.id), 404, NOT_BLOCKED);
    await expectError(await purchases(storeA.slug, customer, productA).order(), 403, BLOCKED, 'continua bloqueado em A');

    // Cliente e conta da plataforma não acessam o painel
    await expectStatus(await block(customer, other.user.id), 403, 'cliente bloqueando');
    await expectStatus(await block(superadmin, other.user.id), 403, 'superadmin pelo painel da loja');

    // Motivo: obrigatório, até 300 caracteres e nada além dele no corpo
    await expectError(
      await block(storeA.owner, other.user.id, { reason: '   ' }),
      400,
      'Informe o motivo do bloqueio (ele fica registrado para a equipe da loja e na auditoria).',
    );
    await expectError(
      await block(storeA.owner, other.user.id, { reason: 'x'.repeat(301) }),
      400,
      'O motivo pode ter no máximo 300 caracteres.',
    );
    await expectError(
      await block(storeA.owner, other.user.id, { reason: REASON, store_id: storeB.id }),
      400,
      MSG.notAllowed('store_id'),
    );
    expect((await getJson(api, `/store/customers/${other.user.id}`, storeA.owner.token)).block).toBeNull();

    // Já bloqueado → 409 (o bloqueio original continua)
    await expectError(await block(storeA.owner, customer.user.id, { reason: 'Outro motivo' }), 409, ALREADY_BLOCKED);
    expect((await getJson(api, `/store/customers/${customer.user.id}`, storeA.owner.token)).block.reason).toBe(REASON);
  });

  test('desbloqueio: o cliente volta a comprar na loja; desbloquear de novo → 404', async () => {
    await expectStatus(await unblock(storeA.owner, customer.user.id), 204, 'DELETE block');
    await expectError(await unblock(storeA.owner, customer.user.id), 404, NOT_BLOCKED);

    const again = purchases(storeA.slug, customer, productA);
    await expectStatus(await again.quote(), 200, 'orçamento depois do desbloqueio');
    const order = await expectStatus(await again.order(), 201, 'pedido depois do desbloqueio');
    expect(order.store_id).toBe(storeA.id);
    const page = await getJson(api, '/store/customers?blocked=true', storeA.owner.token);
    expect(page.total).toBe(0);
  });

  test('auditoria: bloqueio e desbloqueio com a loja, o cliente, quem fez e o motivo', async () => {
    const blocked = await expectAuditRecord(api, superadmin.token, {
      action: 'store.customer.block',
      targetType: 'user',
      targetId: customer.user.id,
      storeId: storeA.id,
      actorId: storeA.owner.user.id,
      actorScope: 'STORE',
    });
    expect(blocked.metadata).toMatchObject({ reason: REASON });

    const unblocked = await expectAuditRecord(api, superadmin.token, {
      action: 'store.customer.unblock',
      targetType: 'user',
      targetId: customer.user.id,
      storeId: storeA.id,
      actorId: storeA.owner.user.id,
      actorScope: 'STORE',
    });
    expect(unblocked.metadata).toMatchObject({ reason: REASON, blocked_by_user_id: storeA.owner.user.id });
  });
});
