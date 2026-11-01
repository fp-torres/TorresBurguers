/**
 * "Um usuário comum não consegue promover a própria conta" (pedido §6.3 e §16; arquitetura §2 e §4.1):
 * nenhuma rota aceita platform_role, role ou store_id para promover alguém — cadastro público, PATCH da
 * própria conta, aceite de convite, autoatendimento de loja e rotas de usuários do ADMIN. O campo é
 * recusado (400, lista de permitidos), a promoção é negada (403) ou o valor é ignorado; e o papel no
 * banco (superpainel) e no token continua o mesmo. Papel global só pelo comando platform:superadmin.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_USERS } from '../../../support/users';
import {
  MSG,
  STRONG_PASSWORD,
  bearer,
  cleanupPlatformData,
  createPlan,
  demoStoreId,
  expectApiError,
  expectOk,
  freshSession,
  getSettings,
  jwtClaims,
  newApi,
  newClientAccount,
  restoreSettings,
  settingsSnapshot,
  storeSlug,
  storeWithOwner,
  trackStore,
  uniqueEmail,
  type Json,
  type Session,
  type StoreWithOwner,
} from './helpers';
import { login } from '../../../support/api';
import { tamperPayload } from '../identity/helpers';
import { openAccountTokens } from '../identity/account-helpers';

let api: APIRequestContext;
let sa: Session;
let plan: Json;
let store: StoreWithOwner;
let demoId: number;

test.beforeAll(async () => {
  api = await newApi();
  sa = await freshSession(api, 'superadmin');
  plan = await createPlan(api, sa.token, { price: 0 });
  store = await storeWithOwner(api, sa.token, { planId: plan.id });
  demoId = await demoStoreId(api);
});

test.afterAll(async () => {
  if (!api) return;
  try {
    await cleanupPlatformData(api, sa.token);
  } finally {
    await api.dispose();
  }
});

/** Papel no banco (superpainel), na sessão (/auth/me) e no token de um login novo continua o esperado. */
async function expectAccountUnchanged(
  account: { id: number; email: string; password: string },
  expected: { role: string; store_id: number | null },
): Promise<void> {
  const stored = await expectOk(await api.get(`/platform/users/${account.id}`, { headers: bearer(sa.token) }), 200);
  expect(stored, `conta ${account.email} no banco`).toMatchObject({ ...expected, platform_role: null });

  const session = await login(api, account.email, account.password);
  expect(session.user, `sessão de ${account.email}`).toMatchObject({ ...expected, platform_role: null });
  const claims = jwtClaims(session.token);
  expect(claims.role, 'perfil no token').toBe(expected.role);
  expect(claims, 'o token nunca carrega papel global').not.toHaveProperty('platform_role');
  const me = await expectOk(await api.get('/auth/me', { headers: bearer(session.token) }), 200);
  expect(me).toMatchObject({ ...expected, platform_role: null, support_session: null });
  await expectApiError(await api.get('/platform/dashboard', { headers: bearer(session.token) }), 403, MSG.platformOnly);
}

test.describe('Cadastro público (POST /users)', () => {
  test('platform_role e store_id são recusados (400); perfis da equipe ou inválidos também; nada é criado', async () => {
    const email = uniqueEmail('plat-promocao');
    const base = { name: 'Tentativa de Promoção', email, password: STRONG_PASSWORD };
    await expectApiError(await api.post('/users', { data: { ...base, platform_role: 'SUPER_ADMIN' } }), 400, 'property platform_role should not exist');
    await expectApiError(await api.post('/users', { data: { ...base, platformRole: 'SUPER_ADMIN' } }), 400, 'property platformRole should not exist');
    await expectApiError(await api.post('/users', { data: { ...base, store_id: demoId } }), 400, 'property store_id should not exist');
    await expectApiError(
      await api.post('/users', { data: { ...base, role: 'ADMIN' } }),
      403,
      'Somente administradores podem cadastrar contas da equipe.',
    );
    await expectApiError(await api.post('/users', { data: { ...base, role: 'SUPER_ADMIN' } }), 400, 'Perfil de acesso inválido');
    // Mesmo pelo formulário multipart (o que um front-end alterado enviaria)
    await expectApiError(
      await api.post('/users', { multipart: { ...base, platform_role: 'SUPER_ADMIN' } }),
      400,
      'property platform_role should not exist',
    );
    const accounts = await expectOk(
      await api.get(`/platform/users?search=${encodeURIComponent(email)}&include_deleted=true`, { headers: bearer(sa.token) }),
      200,
    );
    expect(accounts.total, 'nenhuma tentativa criou conta').toBe(0);

    // role CLIENT explícito é aceito: continua cliente, sem loja e sem papel global
    const created = await expectOk(await api.post('/users', { data: { ...base, role: 'CLIENT' } }), 201);
    expect(created).toMatchObject({ role: 'CLIENT', store_id: null, platform_role: null });
    await expectAccountUnchanged({ id: created.id, email, password: STRONG_PASSWORD }, { role: 'CLIENT', store_id: null });
  });
});

test.describe('PATCH da própria conta (/users/:id)', () => {
  test('cliente: platform_role/store_id → 400, role ADMIN → 403, reenviar CLIENT é ignorado; o papel não muda', async () => {
    const client = await newClientAccount(api);
    const self = (data: Record<string, unknown>) =>
      api.patch(`/users/${client.user.id}`, { headers: bearer(client.token), data });
    await expectApiError(await self({ platform_role: 'SUPER_ADMIN' }), 400, 'property platform_role should not exist');
    await expectApiError(await self({ store_id: demoId }), 400, 'property store_id should not exist');
    await expectApiError(await self({ role: 'ADMIN' }), 403, 'Somente administradores podem alterar o perfil de acesso.');
    await expectApiError(await self({ role: 'SUPER_ADMIN' }), 400, 'Perfil de acesso inválido');
    const same = await expectOk(await self({ role: 'CLIENT', name: 'Cliente Sem Promoção' }), 200);
    expect(same).toMatchObject({ role: 'CLIENT', name: 'Cliente Sem Promoção', platform_role: null, store_id: null });
    await expectAccountUnchanged({ id: client.user.id, email: client.email, password: client.password }, { role: 'CLIENT', store_id: null });
  });

  test('equipe: EMPLOYEE não vira ADMIN, ADMIN não muda o próprio perfil e ninguém troca de loja nem ganha papel global', async () => {
    const owner = bearer(store.owner.token);
    const employeeEmail = uniqueEmail('plat-func');
    const employee = await expectOk(
      await api.post('/users', {
        headers: owner,
        data: { name: 'Funcionário Promoção', email: employeeEmail, password: STRONG_PASSWORD, role: 'EMPLOYEE' },
      }),
      201,
    );
    const employeeSession = await login(api, employeeEmail, STRONG_PASSWORD);
    const asEmployee = (data: Record<string, unknown>) =>
      api.patch(`/users/${employee.id}`, { headers: bearer(employeeSession.token), data });
    await expectApiError(await asEmployee({ role: 'ADMIN' }), 403, 'Somente administradores podem alterar o perfil de acesso.');
    await expectApiError(await asEmployee({ platform_role: 'SUPER_ADMIN' }), 400, 'property platform_role should not exist');
    await expectApiError(await asEmployee({ store_id: demoId }), 400, 'property store_id should not exist');

    const asOwner = (data: Record<string, unknown>) =>
      api.patch(`/users/${store.owner.user.id}`, { headers: owner, data });
    await expectApiError(
      await asOwner({ role: 'EMPLOYEE' }),
      400,
      'Um administrador não pode alterar o próprio perfil de acesso. Peça a outro administrador.',
    );
    await expectApiError(await asOwner({ platform_role: 'SUPER_ADMIN' }), 400, 'property platform_role should not exist');
    await expectApiError(await asOwner({ store_id: demoId }), 400, 'property store_id should not exist');

    await expectAccountUnchanged({ id: employee.id, email: employeeEmail, password: STRONG_PASSWORD }, { role: 'EMPLOYEE', store_id: store.id });
    await expectAccountUnchanged(
      { id: store.owner.user.id, email: store.owner.email, password: store.owner.password },
      { role: 'ADMIN', store_id: store.id },
    );
  });
});

test.describe('Aceite de convite (POST /invitations/:token/accept)', () => {
  test('perfil, loja, e-mail e papel global vêm do convite: campos extras → 400; o aceite normal cria só o perfil convidado', async () => {
    const email = uniqueEmail('plat-convite-promocao');
    const created = await expectOk(
      await api.post('/store/invitations', { headers: bearer(store.owner.token), data: { email, role: 'KITCHEN' } }),
      201,
    );
    const token = String(created.url).split('/').pop();
    const accept = (data: Record<string, unknown>) =>
      api.post(`/invitations/${token}/accept`, { data: { name: 'Convidado Promoção', password: STRONG_PASSWORD, ...data } });
    await expectApiError(await accept({ role: 'ADMIN' }), 400, 'property role should not exist');
    await expectApiError(await accept({ platform_role: 'SUPER_ADMIN' }), 400, 'property platform_role should not exist');
    await expectApiError(await accept({ store_id: demoId }), 400, 'property store_id should not exist');
    await expectApiError(await accept({ email: DEFAULT_USERS.superadmin.email }), 400, 'property email should not exist');

    // O convite continua válido depois das recusas e cria a conta com o perfil e a loja do convite
    const accepted = await expectOk(await accept({}), 201, 'aceite sem campos extras');
    expect(accepted.user).toMatchObject({ email, role: 'KITCHEN', store_id: store.id, platform_role: null });
    await expectAccountUnchanged({ id: accepted.user.id, email, password: STRONG_PASSWORD }, { role: 'KITCHEN', store_id: store.id });
  });
});

test.describe('Autoatendimento de loja (POST /stores/signup)', () => {
  test('o responsável nasce ADMIN só da loja nova: platform_role, role, store_id e situação no corpo → 400', async () => {
    const snapshot = await settingsSnapshot(api, sa.token);
    const signupPlan = await createPlan(api, sa.token, { price: 0, is_public: true });
    try {
      await expectOk(
        await api.patch('/platform/settings', {
          headers: bearer(sa.token),
          data: { store_self_signup_enabled: true, self_signup_plan_id: signupPlan.id },
        }),
        200,
        'habilita o autoatendimento',
      );
      expect((await getSettings(api, sa.token)).self_signup_available).toBe(true);

      const slug = storeSlug('auto-promo');
      const email = uniqueEmail('plat-auto-promo');
      const valid = {
        store: { name: `Auto Promoção ${slug}`, slug },
        owner: { name: 'Dono Autoatendimento', email, password: STRONG_PASSWORD },
        accept_terms: true,
      };
      const attempts: Array<[string, Record<string, unknown>, string]> = [
        ['papel global no corpo', { ...valid, platform_role: 'SUPER_ADMIN' }, 'property platform_role should not exist'],
        ['papel global do responsável', { ...valid, owner: { ...valid.owner, platform_role: 'SUPER_ADMIN' } }, 'owner.property platform_role should not exist'],
        ['perfil do responsável', { ...valid, owner: { ...valid.owner, role: 'CLIENT' } }, 'owner.property role should not exist'],
        ['loja do responsável', { ...valid, owner: { ...valid.owner, store_id: demoId } }, 'owner.property store_id should not exist'],
        ['loja existente', { ...valid, store: { ...valid.store, id: demoId } }, 'store.property id should not exist'],
        ['situação da loja', { ...valid, store: { ...valid.store, account_status: 'ACTIVE' } }, 'store.property account_status should not exist'],
        ['plano escolhido', { ...valid, plan_id: signupPlan.id }, 'property plan_id should not exist'],
      ];
      for (const [label, data, message] of attempts) {
        await expectApiError(await api.post('/stores/signup', { data }), 400, message, label);
      }
      const accounts = await expectOk(
        await api.get(`/platform/users?search=${encodeURIComponent(email)}`, { headers: bearer(sa.token) }),
        200,
      );
      expect(accounts.total, 'nenhuma tentativa criou conta').toBe(0);

      const created = await expectOk(await api.post('/stores/signup', { data: valid }), 201, 'autoatendimento válido');
      trackStore(created.user.store_id);
      expect(created.user).toMatchObject({ email, role: 'ADMIN', platform_role: null, store: { slug } });
      expect(created.user.store_id).not.toBe(demoId);
      await expectAccountUnchanged({ id: created.user.id, email, password: STRONG_PASSWORD }, { role: 'ADMIN', store_id: created.user.store_id });
      // O link de confirmação do e-mail do responsável sai em segundo plano (como no cadastro de cliente)
      await expect
        .poll(async () => (await openAccountTokens(created.user.id, 'VERIFY')).map((row) => row.email), { timeout: 10_000 })
        .toEqual([email.toLowerCase()]);
    } finally {
      await restoreSettings(api, sa.token, snapshot);
    }
  });
});

test.describe('Rotas de usuários do ADMIN (/users)', () => {
  test('ADMIN não concede papel global, não cria contas em outra loja e não promove clientes', async () => {
    const owner = bearer(store.owner.token);
    const email = uniqueEmail('plat-admin-promo');
    const base = { name: 'Equipe Promoção', email, password: STRONG_PASSWORD, role: 'EMPLOYEE' };
    await expectApiError(await api.post('/users', { headers: owner, data: { ...base, platform_role: 'SUPER_ADMIN' } }), 400, 'property platform_role should not exist');
    await expectApiError(await api.post('/users', { headers: owner, data: { ...base, store_id: demoId } }), 400, 'property store_id should not exist');
    await expectApiError(await api.post('/users', { headers: owner, data: { ...base, role: 'SUPER_ADMIN' } }), 400, 'Perfil de acesso inválido');
    await expectApiError(await api.post('/users', { headers: owner, data: { ...base, role: 'CLIENT' } }), 400, /Escolha um perfil da equipe/);

    const member = await expectOk(await api.post('/users', { headers: owner, data: base }), 201, 'membro da equipe');
    expect(member).toMatchObject({ role: 'EMPLOYEE', store_id: store.id, platform_role: null });
    const patchMember = (data: Record<string, unknown>) => api.patch(`/users/${member.id}`, { headers: owner, data });
    await expectApiError(await patchMember({ platform_role: 'SUPER_ADMIN' }), 400, 'property platform_role should not exist');
    await expectApiError(await patchMember({ store_id: demoId }), 400, 'property store_id should not exist');
    await expectApiError(await patchMember({ role: 'SUPER_ADMIN' }), 400, 'Perfil de acesso inválido');
    await expectApiError(await patchMember({ role: 'CLIENT' }), 400, /só pode ser trocado por outro perfil da equipe/);
    await expectAccountUnchanged({ id: member.id, email, password: STRONG_PASSWORD }, { role: 'EMPLOYEE', store_id: store.id });

    // Clientes são contas globais: o ADMIN não os enxerga nem os promove (404 uniforme)
    const client = await newClientAccount(api);
    await expectApiError(await api.patch(`/users/${client.user.id}`, { headers: owner, data: { role: 'ADMIN' } }), 404);
    await expectAccountUnchanged({ id: client.user.id, email: client.email, password: client.password }, { role: 'CLIENT', store_id: null });
  });
});

test.describe('Token e front-end adulterados', () => {
  test('claims forjadas no JWT → 401; cabeçalhos e query com papel ou loja são ignorados', async () => {
    const client = await newClientAccount(api);
    for (const changes of [{ role: 'ADMIN' }, { platform_role: 'SUPER_ADMIN' }, { sid: 1 }, { sub: sa.user.id }]) {
      const forged = tamperPayload(client.token, changes);
      await expectApiError(await api.get('/platform/dashboard', { headers: bearer(forged) }), 401, MSG.session, JSON.stringify(changes));
    }
    const headers = {
      ...bearer(client.token),
      'X-Platform-Role': 'SUPER_ADMIN',
      'X-Role': 'ADMIN',
      'X-Store-Id': String(demoId),
      'X-Tenant-Id': String(demoId),
    };
    await expectApiError(await api.get('/platform/dashboard?platform_role=SUPER_ADMIN', { headers }), 403, MSG.platformOnly);
    await expectApiError(await api.get(`/store/settings?store_id=${demoId}`, { headers }), 403);
    const me = await expectOk(await api.get('/auth/me', { headers }), 200);
    expect(me).toMatchObject({ role: 'CLIENT', platform_role: null, store_id: null });
  });
});
