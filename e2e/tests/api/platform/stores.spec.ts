/**
 * Superadministrador administra estabelecimentos (pedido §6.2 e §16; docs/saas/arquitetura.md §11.6):
 * criar (validações de slug, documento e e-mail do responsável), editar dados e endereço, definir o
 * responsável, e suspender/reativar/desativar/restaurar com motivo — conferindo os efeitos na vitrine,
 * no painel e no login da equipe. Cada teste usa lojas próprias; a loja demo nunca muda de situação.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_USERS } from '../../../support/users';
import { E2E } from '../../../support/env';
import {
  MISSING_ID,
  MSG,
  STRONG_PASSWORD,
  acceptInvitation,
  bearer,
  changeStoreStatus,
  cleanupPlatformData,
  createPlan,
  createProductAs,
  createStore,
  expectApiError,
  expectAuditRecord,
  expectNoSecretValues,
  expectOk,
  freshSession,
  linkToken,
  newApi,
  newClientAccount,
  openStore,
  placeTakeoutOrder,
  storeDetail,
  storeSlug,
  storeWithOwner,
  trackStore,
  uid,
  uniqueEmail,
  validCnpj,
  type Json,
  type Session,
} from './helpers';
import { findSecretKeys } from '../identity/helpers';

let api: APIRequestContext;
let sa: Session;
let plan: Json;
let inactivePlan: Json;

test.beforeAll(async () => {
  api = await newApi();
  sa = await freshSession(api, 'superadmin');
  plan = await createPlan(api, sa.token, { price: 0 });
  inactivePlan = await createPlan(api, sa.token, { price: 0, status: 'INACTIVE' });
});

test.afterAll(async () => {
  if (!api) return;
  try {
    await cleanupPlatformData(api, sa.token);
  } finally {
    await api.dispose();
  }
});

/** Formata 14 dígitos como CNPJ (11.222.333/0001-81). */
const formatCnpj = (digits: string) =>
  `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;

async function searchStores(query: string): Promise<Json> {
  return expectOk(await api.get(`/platform/stores?${query}`, { headers: bearer(sa.token) }), 200, `GET /platform/stores?${query}`);
}

test.describe('Cadastro de estabelecimentos (POST /platform/stores)', () => {
  test('cria a loja fechada, com entrega desligada, a assinatura do plano inicial e o convite do responsável (link exibido uma vez)', async () => {
    const slug = storeSlug('cadastro');
    const ownerEmail = uniqueEmail('plat-responsavel');
    const cnpj = validCnpj();
    const res = await api.post('/platform/stores', {
      headers: bearer(sa.token),
      data: {
        name: `  Lanchonete Cadastro ${slug}  `,
        slug: `  ${slug.toUpperCase()}  `,
        plan_id: plan.id,
        legal_name: 'Lanchonete Cadastro LTDA',
        document: formatCnpj(cnpj),
        email: `contato-${slug}@e2e.test`,
        phone: '(21) 99999-0000',
        address_zip_code: '20040-003',
        address_street: 'Av. Rio Branco',
        address_number: '156',
        address_neighborhood: 'Centro',
        address_city: 'Rio de Janeiro',
        address_state: 'rj',
        owner: { email: ownerEmail.toUpperCase(), name: 'Maria Responsável' },
      },
    });
    const created = await expectOk(res, 201, 'POST /platform/stores');
    expect(created.store).toMatchObject({
      slug,
      name: `Lanchonete Cadastro ${slug}`,
      legal_name: 'Lanchonete Cadastro LTDA',
      document: cnpj,
      phone: '21999990000',
      address_zip_code: '20040003',
      address_state: 'RJ',
      account_status: 'ACTIVE',
      is_open: false,
      delivery_enabled: false,
      takeout_enabled: true,
      owner_user_id: null,
    });
    expect(created.subscription).toMatchObject({ store_id: created.store.id, plan_id: plan.id, status: 'ACTIVE' });
    expect(created.subscription.plan).toMatchObject({ id: plan.id, code: plan.code });
    expect(created.invitation).toMatchObject({
      store_id: created.store.id,
      email: ownerEmail,
      role: 'ADMIN',
      make_owner: true,
      status: 'PENDING',
    });
    expect(created.warnings).toEqual([]);
    expect(findSecretKeys(created)).toEqual([]);
    expect(created.store).not.toHaveProperty('mp_access_token_encrypted');
    const token = linkToken(created.invitation.url);

    // O link é exibido só na criação: a lista de convites e o detail não o repetem
    const invitations = await expectOk(
      await api.get(`/platform/stores/${created.store.id}/invitations`, { headers: bearer(sa.token) }),
      200,
    );
    expect(invitations.items).toHaveLength(1);
    expect(invitations.items[0]).toMatchObject({ email: ownerEmail, role: 'ADMIN', make_owner: true, status: 'PENDING' });
    expectNoSecretValues(invitations, [token], 'GET /platform/stores/:id/invitations');
    expect(JSON.stringify(invitations)).not.toMatch(/token_hash|"url"/);

    // Detalhe do superpainel: sem segredos, sem responsável até o aceite, plano e situação operacional
    const detail = await storeDetail(api, sa.token, created.store.id);
    expect(detail).toMatchObject({
      id: created.store.id,
      is_default_store: false,
      owner: null,
      subscription: { status: 'ACTIVE', plan: { id: plan.id } },
      usage: { staff_users: 0, products: 0 },
      payments: { configured: false },
      access: { availability: 'OPERATIONAL', canSell: true },
      metrics: { orders_total: 0, gmv_total: 0 },
    });
    expectNoSecretValues(detail, [token], 'GET /platform/stores/:id');

    // A vitrine já existe (fechada); a busca do superpainel acha pelo CNPJ digitado com pontuação
    const profile = await expectOk(await api.get(`/stores/${slug}`), 200, `GET /stores/${slug}`);
    expect(profile).toMatchObject({ slug, is_open: false, delivery_enabled: false, takeout_enabled: true });
    const byDocument = await searchStores(`search=${encodeURIComponent(formatCnpj(cnpj))}`);
    expect(byDocument.items.map((item: Json) => item.id)).toEqual([created.store.id]);
    const byOwner = await searchStores(`search=${encodeURIComponent(ownerEmail)}`);
    expect(byOwner.total, 'o responsável ainda não tem conta: a busca pelo e-mail dele não acha a loja').toBe(0);

    // O link abre o convite (e-mail mascarado) e o aceite cria o ADMIN responsável da loja
    const preview = await expectOk(await api.get(`/invitations/${token}`), 200, 'GET /invitations/:token');
    expect(preview).toMatchObject({ store: { slug, name: `Lanchonete Cadastro ${slug}` }, role: 'ADMIN' });
    expect(preview.email_masked).not.toBe(ownerEmail);
    const owner = await acceptInvitation(api, created.invitation.url, { name: 'Maria Responsável' });
    expect(owner.user).toMatchObject({ email: ownerEmail, role: 'ADMIN', store_id: created.store.id, platform_role: null });
    const afterAccept = await storeDetail(api, sa.token, created.store.id);
    expect(afterAccept.owner).toMatchObject({ id: owner.user.id, email: ownerEmail, role: 'ADMIN', eligible: true });
    expect(afterAccept.owner_user_id).toBe(owner.user.id);
    expect((await searchStores(`search=${encodeURIComponent(ownerEmail)}`)).items.map((item: Json) => item.id)).toEqual([
      created.store.id,
    ]);
    // Uso único: o mesmo link não cria outra conta
    await expectApiError(
      await api.post(`/invitations/${token}/accept`, { data: { name: 'Outra pessoa', password: STRONG_PASSWORD } }),
      404,
    );
  });

  test('validações: slug reservado, mal formado ou em uso; documento; e-mail do responsável; plano; campos extras — e nada é criado', async () => {
    const slug = storeSlug('invalida');
    const ownerEmail = uniqueEmail('plat-invalida');
    const valid = { name: 'Loja Inválida E2E', slug, plan_id: plan.id, owner: { email: ownerEmail } };
    const attempt = (changes: Record<string, unknown>) =>
      api.post('/platform/stores', { headers: bearer(sa.token), data: { ...valid, ...changes } });

    for (const reserved of ['admin', 'platform', 'signup', 'default', 'stores', 'cadastrar-loja', 'api', 'loja']) {
      await expectApiError(await attempt({ slug: reserved }), 400, MSG.slugReserved, `slug reservado "${reserved}"`);
    }
    for (const malformed of ['ab', 'loja_x', '-loja', 'loja-', 'loja x', 'açaí-bom', 'a'.repeat(61)]) {
      await expectApiError(await attempt({ slug: malformed }), 400, MSG.slugFormat, `slug "${malformed}"`);
    }
    // Em uso: a loja demo e uma loja criada agora (maiúsculas e espaços não driblam a unicidade)
    const existing = await createStore(api, sa.token, { planId: plan.id });
    for (const taken of [E2E.demoStoreSlug, existing.slug, ` ${existing.slug.toUpperCase()} `]) {
      await expectApiError(await attempt({ slug: taken }), 409, MSG.slugTaken, `slug em uso "${taken}"`);
    }

    // Documento: dígitos verificadores do CNPJ/CPF e tamanho
    const cnpj = validCnpj();
    const wrongCnpj = `${cnpj.slice(0, 13)}${(Number(cnpj[13]) + 1) % 10}`;
    await expectApiError(await attempt({ document: formatCnpj(wrongCnpj) }), 400, 'CNPJ inválido: confira os números.');
    await expectApiError(await attempt({ document: '123.456.789-00' }), 400, 'CPF inválido: confira os números.');
    await expectApiError(await attempt({ document: '111.111.111-11' }), 400, 'CPF inválido: confira os números.');
    await expectApiError(
      await attempt({ document: '12345' }),
      400,
      'Documento inválido. Informe o CPF (11 dígitos) ou o CNPJ (14 caracteres).',
    );

    // Responsável: e-mail obrigatório, válido e sem conta na plataforma (sem diferenciar maiúsculas)
    await expectApiError(await attempt({ owner: undefined }), 400, 'Informe o responsável pela loja (owner.email).');
    await expectApiError(await attempt({ owner: { email: 'nao-e-um-email' } }), 400, /Informe um e-mail válido para o responsável/);
    for (const used of [DEFAULT_USERS.client.email, DEFAULT_USERS.admin.email.toUpperCase(), DEFAULT_USERS.superadmin.email]) {
      await expectApiError(await attempt({ owner: { email: used } }), 409, MSG.ownerEmailInUse, `responsável ${used}`);
    }

    // Nome e plano
    await expectApiError(await attempt({ name: '   ' }), 400, 'Informe o nome do estabelecimento.');
    await expectApiError(await attempt({ plan_id: undefined }), 400, 'Informe o plano inicial (plan_id) com um id válido.');
    await expectApiError(await attempt({ plan_id: MISSING_ID }), 404, 'Plano não encontrado.');
    await expectApiError(await attempt({ plan_id: inactivePlan.id }), 400, 'Este plano não está disponível para novas contratações.');

    // Situação, responsável e loja nunca vêm do corpo (lista de permitidos)
    for (const extra of ['account_status', 'owner_user_id', 'store_id', 'is_open', 'mp_access_token', 'platform_role']) {
      await expectApiError(
        await attempt({ [extra]: extra === 'account_status' ? 'SUSPENDED' : 1 }),
        400,
        `property ${extra} should not exist`,
        `campo extra ${extra}`,
      );
    }

    // Nenhuma tentativa criou loja ou conta
    expect((await searchStores(`search=${slug}`)).total).toBe(0);
    const accounts = await expectOk(
      await api.get(`/platform/users?search=${encodeURIComponent(ownerEmail)}&include_deleted=true`, { headers: bearer(sa.token) }),
      200,
    );
    expect(accounts.total).toBe(0);
    // O plano INACTIVE só passa com allow_inactive_plan (plano interno ou negociado)
    const internal = await expectOk(await attempt({ plan_id: inactivePlan.id, allow_inactive_plan: true }), 201, 'plano interno');
    trackStore(internal.store.id);
    expect(internal.subscription).toMatchObject({ plan_id: inactivePlan.id, status: 'ACTIVE' });
  });
});

test.describe('Edição (PATCH /platform/stores/:id)', () => {
  test('dados administrativos e endereço: o slug novo passa a valer, o antigo some e a resposta avisa; auditoria com de/para', async () => {
    const store = await storeWithOwner(api, sa.token, { planId: plan.id });
    const other = await createStore(api, sa.token, { planId: plan.id });
    const newSlug = storeSlug('renomeada');
    const cnpj = validCnpj();

    const res = await api.patch(`/platform/stores/${store.id}`, {
      headers: bearer(sa.token),
      data: {
        name: 'Loja Renomeada E2E',
        slug: newSlug,
        legal_name: 'Renomeada Comércio LTDA',
        document: cnpj,
        email: `financeiro-${newSlug}@e2e.test`,
        phone: '21988776655',
        address_city: 'Niterói',
        address_state: 'RJ',
      },
    });
    const updated = await expectOk(res, 200, 'PATCH /platform/stores/:id');
    expect(updated).toMatchObject({
      id: store.id,
      slug: newSlug,
      name: 'Loja Renomeada E2E',
      legal_name: 'Renomeada Comércio LTDA',
      document: cnpj,
      phone: '21988776655',
      address_city: 'Niterói',
    });
    expect(updated.warnings).toEqual([
      `O endereço da loja mudou de /loja/${store.slug} para /loja/${newSlug}: links e QR codes com o endereço antigo deixam de funcionar.`,
    ]);

    await expectApiError(await api.get(`/stores/${store.slug}`), 404, MSG.storeNotFound);
    expect((await expectOk(await api.get(`/stores/${newSlug}`), 200)).name).toBe('Loja Renomeada E2E');
    // A sessão da equipe enxerga o endereço novo na hora (loja recarregada do banco)
    const me = await expectOk(await api.get('/auth/me', { headers: bearer(store.owner.token) }), 200);
    expect(me.store).toMatchObject({ id: store.id, slug: newSlug, name: 'Loja Renomeada E2E' });

    const audit = await expectAuditRecord(api, sa.token, {
      action: 'platform.store.update',
      targetType: 'store',
      targetId: store.id,
      storeId: store.id,
      actorId: sa.user.id,
      actorScope: 'PLATFORM',
    });
    expect(audit.metadata.fields).toEqual(expect.arrayContaining(['name', 'slug', 'document', 'phone']));
    expect(audit.metadata.slug).toEqual({ from: store.slug, to: newSlug });
    // Dados pessoais/cadastrais não vão para a trilha: só o nome dos campos
    expectNoSecretValues(audit, [cnpj, '21988776655'], 'platform.store.update');

    // Reenviar os mesmos valores não muda nada nem gera aviso
    const same = await expectOk(
      await api.patch(`/platform/stores/${store.id}`, { headers: bearer(sa.token), data: { slug: newSlug, name: 'Loja Renomeada E2E' } }),
      200,
    );
    expect(same.warnings).toEqual([]);

    // Slug reservado, em uso por outra loja ou mal formado; domínio próprio
    await expectApiError(
      await api.patch(`/platform/stores/${store.id}`, { headers: bearer(sa.token), data: { slug: 'dashboard' } }),
      400,
      MSG.slugReserved,
    );
    await expectApiError(
      await api.patch(`/platform/stores/${store.id}`, { headers: bearer(sa.token), data: { slug: other.slug } }),
      409,
      MSG.slugTaken,
    );
    await expectApiError(
      await api.patch(`/platform/stores/${store.id}`, { headers: bearer(sa.token), data: { slug: 'Loja Nova!' } }),
      400,
      MSG.slugFormat,
    );
    const domain = `pedidos-${uid('d')}.e2e-loja.com.br`;
    const withDomain = await expectOk(
      // Gravado normalizado: minúsculo e sem o ponto final
      await api.patch(`/platform/stores/${store.id}`, { headers: bearer(sa.token), data: { custom_domain: `${domain.toUpperCase()}.` } }),
      200,
    );
    expect(withDomain.custom_domain).toBe(domain);
    expect(withDomain.warnings.join(' ')).toMatch(/domínio próprio fica registrado, mas ainda não é roteado/);
    await expectApiError(
      await api.patch(`/platform/stores/${other.id}`, { headers: bearer(sa.token), data: { custom_domain: domain } }),
      409,
      'Este domínio já está cadastrado em outro estabelecimento.',
    );
    await expectApiError(
      await api.patch(`/platform/stores/${other.id}`, { headers: bearer(sa.token), data: { custom_domain: `https://${domain}/x` } }),
      400,
      /Domínio inválido/,
    );

    // A situação só muda pelas rotas próprias; a loja vem da rota
    for (const extra of ['account_status', 'status_reason', 'is_open', 'store_id']) {
      await expectApiError(
        await api.patch(`/platform/stores/${store.id}`, { headers: bearer(sa.token), data: { [extra]: 'SUSPENDED' } }),
        400,
        `property ${extra} should not exist`,
      );
    }
    await expectApiError(
      await api.patch(`/platform/stores/${MISSING_ID}`, { headers: bearer(sa.token), data: { name: 'Fantasma' } }),
      404,
      MSG.storeNotFound,
    );
    expect((await storeDetail(api, sa.token, other.id)).custom_domain).toBeNull();
  });

  test('responsável (owner_user_id): só um ADMIN ativo da própria loja; null remove; auditoria registra de/para', async () => {
    const store = await storeWithOwner(api, sa.token, { planId: plan.id });
    const firstOwner = store.owner.user.id;
    expect((await storeDetail(api, sa.token, store.id)).owner).toMatchObject({ id: firstOwner, eligible: true });

    const createStaff = async (role: string) => {
      const email = uniqueEmail(`plat-${role.toLowerCase()}`);
      const res = await api.post('/users', {
        headers: bearer(store.owner.token),
        data: { name: `${role} da loja`, email, password: STRONG_PASSWORD, role },
      });
      return expectOk(res, 201, `POST /users (${role})`);
    };
    const secondAdmin = await createStaff('ADMIN');
    const employee = await createStaff('EMPLOYEE');
    const blockedAdmin = await createStaff('ADMIN');
    await expectOk(
      await api.post(`/platform/users/${blockedAdmin.id}/block`, { headers: bearer(sa.token), data: { reason: 'Conta comprometida (teste E2E)' } }),
      200,
    );
    const demoAdmin = await freshSession(api, 'admin');
    const client = await newClientAccount(api);

    const setOwner = (owner: number | null) =>
      api.patch(`/platform/stores/${store.id}`, { headers: bearer(sa.token), data: { owner_user_id: owner } });
    for (const [label, candidate] of [
      ['EMPLOYEE da loja', employee.id],
      ['ADMIN de outra loja', demoAdmin.user.id],
      ['cliente', client.user.id],
      ['superadmin', sa.user.id],
      ['ADMIN bloqueado', blockedAdmin.id],
      ['conta inexistente', MISSING_ID],
    ] as const) {
      await expectApiError(await setOwner(candidate), 400, MSG.ownerNotEligible, `responsável = ${label}`);
    }
    expect((await storeDetail(api, sa.token, store.id)).owner_user_id, 'recusas não mudaram o responsável').toBe(firstOwner);

    const updated = await expectOk(await setOwner(secondAdmin.id), 200, 'responsável = segundo ADMIN');
    expect(updated.owner).toMatchObject({ id: secondAdmin.id, role: 'ADMIN', eligible: true, blocked: false });
    const team = await expectOk(await api.get(`/platform/stores/${store.id}/users`, { headers: bearer(sa.token) }), 200);
    const owners = team.items.filter((member: Json) => member.is_owner).map((member: Json) => member.id);
    expect(owners).toEqual([secondAdmin.id]);
    expect((await expectOk(await api.get(`/platform/users/${secondAdmin.id}`, { headers: bearer(sa.token) }), 200)).is_owner).toBe(true);
    const audit = await expectAuditRecord(api, sa.token, {
      action: 'platform.store.update',
      targetType: 'store',
      targetId: store.id,
      storeId: store.id,
      actorId: sa.user.id,
    });
    expect(audit.metadata.owner_user_id).toEqual({ from: firstOwner, to: secondAdmin.id });

    const cleared = await expectOk(await setOwner(null), 200, 'responsável = null');
    expect(cleared).toMatchObject({ owner_user_id: null, owner: null });
  });
});

test.describe('Situação da loja: suspender, reativar, desativar e restaurar (com motivo; nada é apagado)', () => {
  test('suspender exige motivo; a vitrine para de vender, o painel só lê e opera pedidos, a equipe continua entrando; reativar devolve tudo', async () => {
    const store = await storeWithOwner(api, sa.token, { planId: plan.id });
    await openStore(api, store.owner.token);
    const product = await createProductAs(api, store.owner.token, { name: 'Burger da Suspensão', price: 30 });
    const client = await newClientAccount(api);
    const pending = await placeTakeoutOrder(api, client.token, store.slug, [{ productId: product.id, quantity: 1 }]);
    const reason = `Pendência cadastral ${uid('r')}`;

    // Motivo obrigatório (vazio, só espaços ou longo demais → 400) e nada muda
    for (const data of [{}, { reason: '' }, { reason: '    ' }, { reason: 'x'.repeat(301) }]) {
      await expectApiError(
        await api.post(`/platform/stores/${store.id}/suspend`, { headers: bearer(sa.token), data }),
        400,
        /motivo/i,
        `suspender com ${JSON.stringify(data).slice(0, 40)}`,
      );
    }
    expect((await storeDetail(api, sa.token, store.id)).account_status).toBe('ACTIVE');

    const suspended = await changeStoreStatus(api, sa.token, store.id, 'suspend', reason);
    expect(suspended).toMatchObject({
      account_status: 'SUSPENDED',
      status_reason: reason,
      access: { availability: 'SUSPENDED', canSell: false, canRead: true, canOperate: true, canManage: false },
      warnings: [],
    });
    expect(Number.isNaN(new Date(suspended.status_changed_at).getTime())).toBe(false);

    // Vitrine: continua visível, sem vender, com mensagem genérica (sem o motivo interno)
    const profile = await expectOk(await api.get(`/stores/${store.slug}`), 200);
    expect(profile).toMatchObject({
      ordering_available: false,
      unavailable_message: 'Esta loja está temporariamente indisponível para novos pedidos.',
    });
    expect(JSON.stringify(profile)).not.toContain(reason);
    expect((await expectOk(await api.get(`/stores/${store.slug}/products`), 200)).map((item: Json) => item.id)).toContain(product.id);
    const directory = await expectOk(await api.get(`/stores?search=${store.slug}`), 200);
    expect(directory.total, 'loja suspensa sai do diretório de lojas que vendem').toBe(0);
    for (const path of [`/stores/${store.slug}/orders`, `/stores/${store.slug}/orders/quote`]) {
      const res = await api.post(path, {
        headers: bearer(client.token),
        data: { items: [{ productId: product.id, quantity: 1 }], type: 'TAKEOUT', paymentMethod: 'MONEY' },
      });
      expect(res.status(), `${path} em loja suspensa: ${await res.text()}`).toBe(403);
    }

    // Login da equipe continua; o painel só lê (com o motivo para a equipe) e opera os pedidos existentes
    const relogin = await expectOk(
      await api.post('/auth/login', { data: { email: store.owner.email, password: store.owner.password } }),
      201,
      'login do ADMIN de loja suspensa',
    );
    expect(relogin.user.store).toMatchObject({ id: store.id, account_status: 'SUSPENDED' });
    const panel = bearer(relogin.access_token);
    const settings = await expectOk(await api.get('/store/settings', { headers: panel }), 200);
    expect(settings.access.message).toContain(reason);
    await expectApiError(
      await api.patch('/store/settings', { headers: panel, data: { description: 'Tentativa durante a suspensão' } }),
      403,
      /Alterações no cardápio, na equipe e nas configurações estão bloqueadas/,
    );
    await expectApiError(await api.patch('/store/status', { headers: panel, data: { is_open: false } }), 403, /bloqueadas/);
    await expectApiError(
      await api.post('/products', { headers: panel, data: { name: 'Novo na suspensão', price: 10, category: 'bebidas' } }),
      403,
      /bloqueadas/,
    );
    expect((await expectOk(await api.get('/orders', { headers: panel }), 200)).map((order: Json) => order.id)).toContain(pending.id);
    const operated = await expectOk(
      await api.patch(`/orders/${pending.id}`, { headers: panel, data: { status: 'PREPARING' } }),
      200,
      'operar pedido existente durante a suspensão',
    );
    expect(operated.status).toBe('PREPARING');

    // Transições inválidas a partir de SUSPENDED → 409
    await expectApiError(
      await api.post(`/platform/stores/${store.id}/suspend`, { headers: bearer(sa.token), data: { reason: 'De novo' } }),
      409,
      'A loja já está suspensa.',
    );
    await expectApiError(
      await api.post(`/platform/stores/${store.id}/restore`, { headers: bearer(sa.token), data: {} }),
      409,
      'A loja está suspensa, não desativada: use "reativar".',
    );

    // Reativar: tudo volta (motivo limpo, vitrine vendendo, painel alterando)
    const reactivated = await changeStoreStatus(api, sa.token, store.id, 'reactivate', 'Pendência resolvida');
    expect(reactivated).toMatchObject({ account_status: 'ACTIVE', status_reason: null, access: { availability: 'OPERATIONAL' } });
    expect((await expectOk(await api.get(`/stores/${store.slug}`), 200)).ordering_available).toBe(true);
    expect((await expectOk(await api.get(`/stores?search=${store.slug}`), 200)).total).toBe(1);
    await placeTakeoutOrder(api, client.token, store.slug, [{ productId: product.id, quantity: 2 }]);
    await expectOk(await api.patch('/store/settings', { headers: panel, data: { description: 'Voltamos!' } }), 200);
    await expectApiError(
      await api.post(`/platform/stores/${store.id}/reactivate`, { headers: bearer(sa.token), data: {} }),
      409,
      'A loja já está ativa.',
    );
  });

  test('o cliente não vê o motivo interno da suspensão ao tentar comprar (mensagem genérica, como na vitrine)', async () => {
    const store = await storeWithOwner(api, sa.token, { planId: plan.id });
    await openStore(api, store.owner.token);
    const product = await createProductAs(api, store.owner.token, { price: 12 });
    const client = await newClientAccount(api);
    const reason = `Fraude em investigação ${uid('sigilo')}`;
    await changeStoreStatus(api, sa.token, store.id, 'suspend', reason);

    const order = { items: [{ productId: product.id, quantity: 1 }], type: 'TAKEOUT' };
    for (const [path, data] of [
      [`/stores/${store.slug}/orders/quote`, order],
      [`/stores/${store.slug}/orders`, { ...order, paymentMethod: 'MONEY' }],
      [`/stores/${store.slug}/payment/pix`, { order }],
    ] as const) {
      const payload = await expectApiError(
        await api.post(path, { headers: bearer(client.token), data }),
        403,
        undefined,
        `${path} em loja suspensa`,
      );
      expect(JSON.stringify(payload), `${path}: o motivo interno da suspensão vazou para o cliente`).not.toContain(reason);
      expect(payload.message, `${path}: mesma mensagem genérica do perfil público`).toBe(
        'Esta loja está temporariamente indisponível para novos pedidos.',
      );
    }
  });

  test('desativar exige motivo; a loja some da vitrine, a equipe não entra e o painel fecha; restaurar devolve o acesso', async () => {
    const store = await storeWithOwner(api, sa.token, { planId: plan.id });
    const product = await createProductAs(api, store.owner.token, { price: 18 });

    await expectApiError(
      await api.post(`/platform/stores/${store.id}/deactivate`, { headers: bearer(sa.token), data: { reason: ' ' } }),
      400,
      MSG.reasonRequired,
    );
    // De SUSPENDED também se desativa
    await changeStoreStatus(api, sa.token, store.id, 'suspend', 'Antes de encerrar');
    const inactive = await changeStoreStatus(api, sa.token, store.id, 'deactivate', 'Encerramento do contrato (teste E2E)');
    expect(inactive).toMatchObject({
      account_status: 'INACTIVE',
      status_reason: 'Encerramento do contrato (teste E2E)',
      access: { availability: 'INACTIVE', canRead: false, publicVisible: false },
    });

    await expectApiError(await api.get(`/stores/${store.slug}`), 404, MSG.storeNotFound);
    await expectApiError(await api.get(`/stores/${store.slug}/products`), 404, MSG.storeNotFound);
    expect((await expectOk(await api.get(`/stores?search=${store.slug}`), 200)).total).toBe(0);

    await expectApiError(
      await api.post('/auth/login', { data: { email: store.owner.email, password: store.owner.password } }),
      403,
      MSG.inactiveStoreLogin,
    );
    // Desativar encerra as sessões da equipe (token_version + 1): o token emitido antes da desativação não
    // abre mais o painel nem os pedidos
    for (const path of ['/store/settings', '/orders']) {
      await expectApiError(await api.get(path, { headers: bearer(store.owner.token) }), 401, MSG.session, `GET ${path}`);
    }
    // Rotas antigas sem slug (autenticação opcional): o token encerrado vale como anônimo — a vitrine da
    // loja padrão — e nada da loja desativada é lido
    const legacyMenu = await expectOk(await api.get('/products', { headers: bearer(store.owner.token) }), 200);
    expect(legacyMenu.map((item: Json) => item.id), 'cardápio da loja desativada pela rota antiga').not.toContain(product.id);
    await expectApiError(
      await api.get(`/products/${product.id}`, { headers: bearer(store.owner.token) }),
      404,
      undefined,
      'produto da loja desativada pela rota antiga',
    );
    await expectApiError(
      await api.post(`/platform/stores/${store.id}/support-sessions`, {
        headers: bearer(sa.token),
        data: { reason: 'Chamado: olhar a loja desativada' },
      }),
      400,
      /Esta loja está desativada: restaure-a antes de abrir uma sessão de suporte/,
    );
    await expectApiError(
      await api.post(`/platform/stores/${store.id}/invitations`, {
        headers: bearer(sa.token),
        data: { email: uniqueEmail('plat-inativa'), role: 'EMPLOYEE' },
      }),
      400,
      /desativada/,
    );

    // Transições inválidas a partir de INACTIVE → 409
    await expectApiError(
      await api.post(`/platform/stores/${store.id}/reactivate`, { headers: bearer(sa.token), data: {} }),
      409,
      'A loja está desativada, não suspensa: use "restaurar" para reativá-la.',
    );
    await expectApiError(
      await api.post(`/platform/stores/${store.id}/suspend`, { headers: bearer(sa.token), data: { reason: 'x' } }),
      409,
      'A loja está desativada. Restaure-a antes de suspendê-la.',
    );
    await expectApiError(
      await api.post(`/platform/stores/${store.id}/deactivate`, { headers: bearer(sa.token), data: { reason: 'x' } }),
      409,
      'A loja já está desativada.',
    );

    // O superpainel continua vendo tudo (nada foi apagado)
    const detail = await storeDetail(api, sa.token, store.id);
    expect(detail).toMatchObject({ usage: { products: 1, staff_users: 1 }, owner: { id: store.owner.user.id } });

    const restored = await changeStoreStatus(api, sa.token, store.id, 'restore', 'Contrato renovado');
    expect(restored).toMatchObject({ account_status: 'ACTIVE', status_reason: null });
    await expectApiError(
      await api.post(`/platform/stores/${store.id}/restore`, { headers: bearer(sa.token), data: {} }),
      409,
      'A loja já está ativa.',
    );
    const login = await expectOk(
      await api.post('/auth/login', { data: { email: store.owner.email, password: store.owner.password } }),
      201,
    );
    expect(login.user.store).toMatchObject({ id: store.id, account_status: 'ACTIVE' });
    // A sessão antiga continua encerrada; a do novo login lê o painel
    await expectApiError(await api.get('/store/settings', { headers: bearer(store.owner.token) }), 401, MSG.session);
    expect((await expectOk(await api.get('/store/settings', { headers: bearer(login.access_token) }), 200)).id).toBe(store.id);
    expect((await expectOk(await api.get(`/stores/${store.slug}/products`), 200)).map((item: Json) => item.id)).toContain(product.id);
  });

  test('loja inexistente → 404 em todas as ações; a loja demo (padrão) não é tocada', async () => {
    for (const action of ['suspend', 'reactivate', 'deactivate', 'restore'] as const) {
      await expectApiError(
        await api.post(`/platform/stores/${MISSING_ID}/${action}`, { headers: bearer(sa.token), data: { reason: 'Inexistente' } }),
        404,
        MSG.storeNotFound,
        `${action} de loja inexistente`,
      );
    }
    for (const path of ['', '/users', '/metrics', '/audit', '/invitations']) {
      await expectApiError(await api.get(`/platform/stores/${MISSING_ID}${path}`, { headers: bearer(sa.token) }), 404, MSG.storeNotFound);
    }
    const demo = (await searchStores('search=demo')).items.find((item: Json) => item.slug === 'demo');
    expect(demo).toMatchObject({ account_status: 'ACTIVE' });
  });
});

test.describe('Lista do superpainel (GET /platform/stores)', () => {
  test('filtra por situação, plano e assinatura, ordena e pagina no servidor', async () => {
    const filterPlan = await createPlan(api, sa.token, { price: 0 });
    const a = await createStore(api, sa.token, { planId: filterPlan.id, name: `AAA Lista ${uid('l')}` });
    const b = await createStore(api, sa.token, { planId: filterPlan.id, name: `BBB Lista ${uid('l')}` });
    await changeStoreStatus(api, sa.token, b.id, 'suspend', 'Filtro da lista');

    const byPlan = await searchStores(`plan_id=${filterPlan.id}&sort=name&order=asc`);
    expect(byPlan.items.map((item: Json) => item.id)).toEqual([a.id, b.id]);
    for (const item of byPlan.items) {
      expect(item).toMatchObject({ plan: { id: filterPlan.id }, subscription: { status: 'ACTIVE' }, staff_count: 0, orders_30d: 0, gmv_30d: 0 });
    }
    const desc = await searchStores(`plan_id=${filterPlan.id}&sort=name&order=desc`);
    expect(desc.items.map((item: Json) => item.id)).toEqual([b.id, a.id]);
    const suspended = await searchStores(`plan_id=${filterPlan.id}&account_status=suspended`);
    expect(suspended.items.map((item: Json) => item.id)).toEqual([b.id]);
    const paged = await searchStores(`plan_id=${filterPlan.id}&sort=name&pageSize=1&page=2`);
    expect(paged).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(paged.items.map((item: Json) => item.id)).toEqual([b.id]);
    expect((await searchStores('pageSize=500')).pageSize, 'pageSize acima de 100 usa 100').toBe(100);

    // Sem assinatura vigente: a loja aparece como CANCELED (última cancelada) e some do filtro do plano
    await expectOk(
      await api.post(`/platform/subscriptions/${a.subscription.id}/cancel`, { headers: bearer(sa.token), data: { reason: 'Filtro' } }),
      200,
    );
    expect((await searchStores(`plan_id=${filterPlan.id}`)).items.map((item: Json) => item.id)).toEqual([b.id]);
    expect((await searchStores(`subscription_status=CANCELED&search=${a.slug}`)).items.map((item: Json) => item.id)).toEqual([a.id]);

    for (const [query, message] of [
      ['account_status=PAUSED', 'Situação da loja inválida. Use ACTIVE, SUSPENDED ou INACTIVE.'],
      ['subscription_status=LATE', 'Situação da assinatura inválida. Use TRIALING, ACTIVE, PAST_DUE, SUSPENDED, CANCELED ou NONE.'],
      ['sort=gmv', 'Ordenação inválida. Use created_at, name ou slug.'],
      ['order=up', 'Ordem inválida. Use asc ou desc.'],
      ['plan_id=abc', 'plan_id deve ser um id válido (número inteiro positivo).'],
    ]) {
      await expectApiError(await api.get(`/platform/stores?${query}`, { headers: bearer(sa.token) }), 400, message, query);
    }
  });
});
