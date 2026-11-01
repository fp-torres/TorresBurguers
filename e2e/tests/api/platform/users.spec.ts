/**
 * Superpainel › Usuários e acessos (pedido §6.3; arquitetura §4.4 e §11.6): busca global e detalhe,
 * bloqueio (login 403 e token antigo 401), desbloqueio, encerramento de sessões, link de redefinição
 * de senha (uso único, validade real na mensagem) e eventos de autenticação (GET /platform/auth-events).
 * Só contas criadas pelo teste são bloqueadas ou alteradas; os usuários padrão nunca.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { DEFAULT_USERS } from '../../../support/users';
import { E2E } from '../../../support/env';
import {
  MISSING_ID,
  MSG,
  STRONG_PASSWORD,
  bearer,
  cleanupPlatformData,
  createPlan,
  expectApiError,
  expectAuditRecord,
  expectNoSecretValues,
  expectOk,
  freshSession,
  letters,
  lettersEmail,
  linkToken,
  newApi,
  newClientAccount,
  storeWithOwner,
  uid,
  uniqueEmail,
  type Json,
  type Session,
  type StoreWithOwner,
  type TestAccount,
} from './helpers';
import { login } from '../../../support/api';
import { findSecretKeys } from '../identity/helpers';

let api: APIRequestContext;
let sa: Session;
let store: StoreWithOwner;

test.beforeAll(async () => {
  api = await newApi();
  sa = await freshSession(api, 'superadmin');
  const plan = await createPlan(api, sa.token, { price: 0 });
  store = await storeWithOwner(api, sa.token, { planId: plan.id });
});

test.afterAll(async () => {
  if (!api) return;
  try {
    await cleanupPlatformData(api, sa.token);
  } finally {
    await api.dispose();
  }
});

const platformGet = async (path: string) => expectOk(await api.get(path, { headers: bearer(sa.token) }), 200, `GET ${path}`);
const ids = (page: Json) => page.items.map((item: Json) => item.id);

/** Tenta entrar e devolve a resposta (sem exigir sucesso). */
const tryLogin = (email: string, password: string) => api.post('/auth/login', { data: { email, password } });

async function staffMember(role: string): Promise<TestAccount> {
  const email = uniqueEmail(`plat-${role.toLowerCase()}`);
  await expectOk(
    await api.post('/users', {
      headers: bearer(store.owner.token),
      data: { name: `${role} Usuários E2E`, email, password: STRONG_PASSWORD, role, phone: '21955554444' },
    }),
    201,
  );
  const session = await login(api, email, STRONG_PASSWORD);
  return { ...session, email, password: STRONG_PASSWORD };
}

test.describe('Busca e detalhe (GET /platform/users e /platform/users/:id)', () => {
  test('busca por nome, e-mail ou telefone e filtra por perfil, loja, papel global, bloqueio e lixeira — sem senhas', async () => {
    const employee = await staffMember('EMPLOYEE');
    const phone = `2197${String(Date.now()).slice(-7)}`;
    // Nome e e-mail sem dígitos: a busca também procura os dígitos do termo nos telefones (ver o teste do bug abaixo)
    const client = await newClientAccount(api, `Cliente Busca ${letters(10)}`, lettersEmail('plat-busca'));
    await expectOk(await api.patch(`/users/${client.user.id}`, { headers: bearer(client.token), data: { phone } }), 200);

    expect(ids(await platformGet(`/platform/users?search=${encodeURIComponent(client.email)}`))).toEqual([client.user.id]);
    expect(ids(await platformGet(`/platform/users?search=${encodeURIComponent(client.user.name)}`))).toEqual([client.user.id]);
    const formattedPhone = `(${phone.slice(0, 2)}) ${phone.slice(2, 7)}-${phone.slice(7)}`;
    expect(ids(await platformGet(`/platform/users?search=${encodeURIComponent(formattedPhone)}`))).toEqual([client.user.id]);

    const team = await platformGet(`/platform/users?store_id=${store.id}&sort=email&order=asc`);
    expect(ids(team).sort()).toEqual([store.owner.user.id, employee.user.id].sort());
    for (const user of team.items) {
      expect(user).toMatchObject({ store_id: store.id, platform_role: null, store: { id: store.id, slug: store.slug, account_status: 'ACTIVE' } });
    }
    expect(ids(await platformGet(`/platform/users?store_id=${store.id}&role=admin`))).toEqual([store.owner.user.id]);
    const platformAdmins = await platformGet('/platform/users?platform_role=SUPER_ADMIN&pageSize=100');
    expect(ids(platformAdmins)).toContain(sa.user.id);
    for (const user of platformAdmins.items) expect(user).toMatchObject({ platform_role: 'SUPER_ADMIN', store_id: null });
    expect(ids(await platformGet(`/platform/users?platform_role=NONE&search=${encodeURIComponent(DEFAULT_USERS.superadmin.email)}`))).toEqual([]);

    // Bloqueadas
    await expectOk(
      await api.post(`/platform/users/${employee.user.id}/block`, { headers: bearer(sa.token), data: { reason: 'Filtro de bloqueadas' } }),
      200,
    );
    expect(ids(await platformGet(`/platform/users?store_id=${store.id}&blocked=true`))).toEqual([employee.user.id]);
    expect(ids(await platformGet(`/platform/users?store_id=${store.id}&blocked=false`))).toEqual([store.owner.user.id]);

    // Lixeira: a conta excluída pelo próprio cliente só aparece com include_deleted
    await expectOk(await api.delete(`/users/${client.user.id}`, { headers: bearer(client.token) }), 200);
    expect(ids(await platformGet(`/platform/users?search=${encodeURIComponent(client.email)}`))).toEqual([]);
    const withTrash = await platformGet(`/platform/users?search=${encodeURIComponent(client.email)}&include_deleted=true`);
    expect(ids(withTrash)).toEqual([client.user.id]);
    expect(withTrash.items[0].deleted_at).not.toBeNull();
    expect((await platformGet(`/platform/users/${client.user.id}`)).deleted_at, 'detalhe inclusive na lixeira').not.toBeNull();

    // Nenhuma resposta traz senha, hash ou versão das sessões
    const everything = await platformGet('/platform/users?pageSize=100&include_deleted=true');
    expect(findSecretKeys(everything)).toEqual([]);
    for (const user of everything.items) expect(user).not.toHaveProperty('token_version');

    for (const [query, message] of [
      ['role=SUPER_ADMIN', 'Perfil inválido. Use CLIENT, ADMIN, EMPLOYEE, KITCHEN ou COURIER.'],
      ['platform_role=ADMIN', 'Papel na plataforma inválido. Use SUPER_ADMIN ou NONE.'],
      ['blocked=talvez', 'blocked deve ser true ou false.'],
      ['sort=password', 'Ordenação inválida. Use created_at, name, email ou last_login_at.'],
      ['store_id=-1', 'store_id deve ser um id válido (número inteiro positivo).'],
    ]) {
      await expectApiError(await api.get(`/platform/users?${query}`, { headers: bearer(sa.token) }), 400, message, query);
    }
  });

  test('busca por nome ou e-mail com dígitos não traz contas só porque o telefone delas contém esses dígitos', async () => {
    // Telefone com "219" e "2192" numa conta de nome e e-mail sem relação com os termos buscados
    const other = await newClientAccount(api, `Cliente Telefone ${letters(10)}`, lettersEmail('plat-fone'), '21921920000');
    const named = await newClientAccount(api, `Cliente Unidade 219 ${letters(10)}`, lettersEmail('plat-nome'));
    const byName = ids(await platformGet(`/platform/users?search=${encodeURIComponent(named.user.name)}&pageSize=100`));
    expect(byName, 'busca pelo nome completo').toEqual([named.user.id]);
    expect(byName).not.toContain(other.user.id);
    const email = `plat-219-${letters(10)}@e2e.test`;
    const withDigits = await newClientAccount(api, `Cliente Email ${letters(10)}`, email);
    expect(ids(await platformGet(`/platform/users?search=${encodeURIComponent(email)}&pageSize=100`)), 'busca pelo e-mail completo').toEqual([
      withDigits.user.id,
    ]);
    // Termo com cara de telefone continua procurando nos dígitos do telefone (com ou sem pontuação)
    const byPhone = ids(await platformGet(`/platform/users?search=${encodeURIComponent('(21) 92192-0000')}&pageSize=100`));
    expect(byPhone, 'busca pelo telefone com pontuação').toContain(other.user.id);
    expect(byPhone).not.toContain(named.user.id);
  });

  test('detalhe: loja, responsável e eventos recentes de autenticação; conta inexistente → 404', async () => {
    await login(api, store.owner.email, store.owner.password);
    const detail = await platformGet(`/platform/users/${store.owner.user.id}`);
    expect(detail).toMatchObject({
      id: store.owner.user.id,
      email: store.owner.email,
      role: 'ADMIN',
      store_id: store.id,
      platform_role: null,
      is_owner: true,
      blocked_at: null,
      store: { id: store.id, slug: store.slug, name: store.name, account_status: 'ACTIVE' },
    });
    expect(detail.last_login_at).not.toBeNull();
    expect(detail.recent_auth_events.map((event: Json) => event.action)).toContain('auth.login.success');
    for (const event of detail.recent_auth_events) expect(event.action).toMatch(/^auth\./);
    expect(findSecretKeys(detail)).toEqual([]);
    expect(detail).not.toHaveProperty('token_version');
    await expectApiError(await api.get(`/platform/users/${MISSING_ID}`, { headers: bearer(sa.token) }), 404, 'Usuário não encontrado');
  });
});

test.describe('Bloqueio e desbloqueio (POST /platform/users/:id/block e /unblock)', () => {
  test('bloquear exige motivo; login com a senha certa → 403 e o token antigo → 401; desbloquear devolve o acesso (tokens antigos seguem inválidos)', async () => {
    const client = await newClientAccount(api);
    const otherSession = await login(api, client.email, client.password);
    const block = (data: Record<string, unknown>, id = client.user.id) =>
      api.post(`/platform/users/${id}/block`, { headers: bearer(sa.token), data });

    await expectApiError(await block({}), 400, 'Informe o motivo do bloqueio.');
    await expectApiError(await block({ reason: '   ' }), 400, 'Informe o motivo do bloqueio.');
    await expectApiError(await block({ reason: 'x'.repeat(301) }), 400, 'O motivo pode ter no máximo 300 caracteres.');
    await expectApiError(await block({ reason: 'Teste' }, sa.user.id), 400, 'Você não pode bloquear a própria conta.');
    await expectApiError(await block({ reason: 'Teste' }, MISSING_ID), 404, 'Usuário não encontrado');
    expect((await expectOk(await api.get('/auth/me', { headers: bearer(client.token) }), 200)).id).toBe(client.user.id);

    const reason = `Conta comprometida, chamado ${uid('c')}`;
    const blocked = await expectOk(await block({ reason }), 200, 'bloqueio');
    expect(blocked).toMatchObject({ id: client.user.id, blocked_reason: reason });
    expect(blocked.blocked_at).not.toBeNull();

    // Login: a situação só aparece com a senha certa; os tokens abertos deixam de valer na hora
    await expectApiError(await tryLogin(client.email, client.password), 403, MSG.blockedAccount);
    const wrong = await expectApiError(await tryLogin(client.email, 'SenhaErrada@999'), 401, 'Email ou senha inválidos');
    expect(JSON.stringify(wrong)).not.toMatch(/bloquead/i);
    for (const token of [client.token, otherSession.token]) {
      await expectApiError(await api.get('/auth/me', { headers: bearer(token) }), 401);
    }
    await expectAuditRecord(api, sa.token, {
      action: 'user.block',
      targetType: 'user',
      targetId: client.user.id,
      actorId: sa.user.id,
      actorScope: 'PLATFORM',
      secrets: [client.password, client.token],
    });
    const denied = await platformGet(`/platform/auth-events?user_id=${client.user.id}&result=DENIED`);
    expect(denied.items[0]).toMatchObject({ action: 'auth.login.failure', result: 'DENIED', metadata: { reason: 'blocked' } });

    const unblocked = await expectOk(
      await api.post(`/platform/users/${client.user.id}/unblock`, { headers: bearer(sa.token) }),
      200,
      'desbloqueio',
    );
    expect(unblocked).toMatchObject({ blocked_at: null, blocked_reason: null });
    const again = await expectOk(await tryLogin(client.email, client.password), 201, 'login depois do desbloqueio');
    expect((await expectOk(await api.get('/auth/me', { headers: bearer(again.access_token) }), 200)).id).toBe(client.user.id);
    await expectApiError(await api.get('/auth/me', { headers: bearer(client.token) }), 401);
    await expectAuditRecord(api, sa.token, { action: 'user.unblock', targetType: 'user', targetId: client.user.id, actorId: sa.user.id });
  });

  test('equipe bloqueada não entra no painel e o bloqueio fica visível na equipe da loja', async () => {
    const kitchen = await staffMember('KITCHEN');
    await expectOk(
      await api.post(`/platform/users/${kitchen.user.id}/block`, { headers: bearer(sa.token), data: { reason: 'Desligado da loja' } }),
      200,
    );
    await expectApiError(await api.get('/orders', { headers: bearer(kitchen.token) }), 401);
    await expectApiError(await tryLogin(kitchen.email, kitchen.password), 403, MSG.blockedAccount);
    const team = await platformGet(`/platform/stores/${store.id}/users`);
    expect(team.items.find((user: Json) => user.id === kitchen.user.id)).toMatchObject({ blocked_reason: 'Desligado da loja' });
    const detail = await platformGet(`/platform/stores/${store.id}`);
    expect(detail.metrics.active_staff).toBe(detail.metrics.staff - team.items.filter((user: Json) => user.blocked_at).length);
  });
});

test.describe('Encerrar sessões (POST /platform/users/:id/revoke-sessions)', () => {
  test('todos os tokens abertos da conta → 401; um login novo funciona; auditoria user.revoke_sessions', async () => {
    const client = await newClientAccount(api);
    const second = await login(api, client.email, client.password);
    const result = await expectOk(
      await api.post(`/platform/users/${client.user.id}/revoke-sessions`, { headers: bearer(sa.token) }),
      200,
    );
    expect(result.message).toBe('Todas as sessões da conta foram encerradas: será preciso entrar de novo em todos os dispositivos.');
    expect(result.user).toMatchObject({ id: client.user.id, blocked_at: null });
    for (const token of [client.token, second.token]) {
      await expectApiError(await api.get('/addresses', { headers: bearer(token) }), 401, MSG.session);
    }
    const fresh = await login(api, client.email, client.password);
    expect((await api.get('/addresses', { headers: bearer(fresh.token) })).status()).toBe(200);
    await expectAuditRecord(api, sa.token, {
      action: 'user.revoke_sessions',
      targetType: 'user',
      targetId: client.user.id,
      actorId: sa.user.id,
      actorScope: 'PLATFORM',
      secrets: [client.token, second.token],
    });
    await expectApiError(
      await api.post(`/platform/users/${MISSING_ID}/revoke-sessions`, { headers: bearer(sa.token) }),
      404,
      'Usuário não encontrado',
    );
  });
});

test.describe('Link de redefinição de senha (POST /platform/users/:id/password-reset)', () => {
  test('link de uso único com a validade real na mensagem; um link novo invalida o anterior; redefinir encerra as sessões', async () => {
    const client = await newClientAccount(api);
    const requestLink = async () => {
      const before = Date.now();
      const link = await expectOk(
        await api.post(`/platform/users/${client.user.id}/password-reset`, { headers: bearer(sa.token) }),
        200,
        'link de redefinição',
      );
      return { ...link, requestedAt: before };
    };

    const first = await requestLink();
    // Driver de log nos testes: o link volta para o operador (com SMTP, iria só para o e-mail do titular)
    expect(Object.keys(first).sort()).toEqual(['delivered', 'expires_at', 'message', 'requestedAt', 'url']);
    expect(first.delivered).toBe(false);
    const escapedWeb = E2E.webURL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(first.url).toMatch(new RegExp(`^${escapedWeb}/redefinir-senha/[A-Za-z0-9_-]{32,128}$`));
    // A validade escrita na mensagem é a mesma do expires_at devolvido
    const minutes = Number(/Vale por (\d+) minutos e uma única vez/.exec(first.message)?.[1]);
    expect(minutes, `mensagem: ${first.message}`).toBeGreaterThan(0);
    const validity = (new Date(first.expires_at).getTime() - first.requestedAt) / 60_000;
    expect(Math.abs(validity - minutes), `expires_at (${first.expires_at}) × "${minutes} minutos"`).toBeLessThan(1);
    expect(first.message).toMatch(/aparece só agora/);

    const firstToken = linkToken(first.url);
    const inspect = await expectOk(await api.get(`/auth/reset-password/${firstToken}`), 200);
    expect(inspect.expires_at).toBe(first.expires_at);
    expect(inspect.email_masked).not.toBe(client.email);

    const second = await requestLink();
    const secondToken = linkToken(second.url);
    expect(secondToken).not.toBe(firstToken);
    await expectApiError(await api.get(`/auth/reset-password/${firstToken}`), 404, /Link de redefinição inválido ou expirado/);

    const newPassword = `Nova${uid('s').replace(/-/g, '')}!9`;
    const done = await expectOk(
      await api.post('/auth/reset-password', { data: { token: secondToken, password: newPassword } }),
      200,
      'redefinição',
    );
    expect(done.message).toBe('Senha redefinida. Entre com a nova senha.');
    // Uso único; as sessões abertas caem; só a senha nova entra
    await expectApiError(
      await api.post('/auth/reset-password', { data: { token: secondToken, password: `${newPassword}x` } }),
      404,
      /Link de redefinição inválido ou expirado/,
    );
    await expectApiError(await api.get('/auth/me', { headers: bearer(client.token) }), 401);
    await expectApiError(await tryLogin(client.email, client.password), 401, 'Email ou senha inválidos');
    await expectOk(await tryLogin(client.email, newPassword), 201, 'login com a senha nova');

    // Auditoria: quem gerou, para quem e até quando — nunca o link, o token ou a senha
    const generated = await expectAuditRecord(api, sa.token, {
      action: 'user.password_reset_link',
      targetType: 'user',
      targetId: client.user.id,
      actorId: sa.user.id,
      actorScope: 'PLATFORM',
      secrets: [firstToken, secondToken, newPassword],
    });
    expect(generated.metadata).toHaveProperty('expires_at');
    const completed = await expectAuditRecord(api, sa.token, {
      action: 'auth.password_reset.complete',
      targetType: 'user',
      targetId: client.user.id,
      actorId: client.user.id,
      secrets: [secondToken, newPassword],
    });
    expect(completed.metadata).toMatchObject({ via: 'platform_link' });

    await expectApiError(
      await api.post(`/platform/users/${MISSING_ID}/password-reset`, { headers: bearer(sa.token) }),
      404,
    );
  });
});

test.describe('Eventos de autenticação (GET /platform/auth-events)', () => {
  test('filtra por conta, e-mail (inclusive inexistente), resultado e período; só ações auth.*; senhas nunca aparecem', async () => {
    const client = await newClientAccount(api);
    const wrongPassword = `Errada${uid('w').replace(/-/g, '')}!1`;
    const ghost = uniqueEmail('plat-fantasma');
    await expectApiError(await tryLogin(client.email, wrongPassword), 401);
    await expectApiError(await tryLogin(ghost, wrongPassword), 401);
    await login(api, client.email, client.password);
    const startedAt = new Date(Date.now() - 60_000).toISOString();

    const byUser = await platformGet(`/platform/auth-events?user_id=${client.user.id}&pageSize=100`);
    const actions = byUser.items.map((event: Json) => `${event.action}:${event.result}`);
    expect(actions).toEqual(expect.arrayContaining(['auth.login.success:SUCCESS']));
    for (const event of byUser.items) {
      expect(event.action).toMatch(/^auth\./);
      const related = event.actor?.id === client.user.id || (event.target_type === 'user' && event.target_id === String(client.user.id));
      expect(related, `evento ${event.id} é da conta ${client.user.id}`).toBe(true);
    }

    // Senha errada não identifica a conta: o evento guarda só o e-mail digitado (sem diferenciar maiúsculas)
    const byEmail = await platformGet(`/platform/auth-events?email=${encodeURIComponent(client.email.toUpperCase())}&result=FAILURE`);
    expect(byEmail.items.length).toBeGreaterThan(0);
    expect(byEmail.items[0]).toMatchObject({ action: 'auth.login.failure', result: 'FAILURE', metadata: { reason: 'invalid_credentials' } });
    const ghostEvents = await platformGet(`/platform/auth-events?email=${encodeURIComponent(ghost)}`);
    expect(ghostEvents.items).toHaveLength(1);
    expect(ghostEvents.items[0]).toMatchObject({ action: 'auth.login.failure', result: 'FAILURE', actor: { id: null, email: ghost } });

    const everything = await platformGet(`/platform/auth-events?from=${encodeURIComponent(startedAt)}&pageSize=100`);
    expectNoSecretValues(everything, [wrongPassword, client.password], 'GET /platform/auth-events');
    expect(findSecretKeys(everything)).toEqual([]);
    for (const event of everything.items) expect(event.action).toMatch(/^auth\./);

    const denied = await platformGet('/platform/auth-events?result=DENIED&pageSize=100');
    for (const event of denied.items) expect(event.result).toBe('DENIED');

    // Período: depois de agora não há eventos; dia de hoje inclui os de agora
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect((await platformGet(`/platform/auth-events?user_id=${client.user.id}&from=${tomorrow}`)).total).toBe(0);
    expect((await platformGet(`/platform/auth-events?email=${encodeURIComponent(ghost)}&from=${encodeURIComponent(startedAt)}`)).total).toBe(1);

    for (const [query, message] of [
      ['email=nao-e-email', 'email deve ser um e-mail válido.'],
      ['result=OK', 'Resultado inválido. Use SUCCESS, FAILURE ou DENIED.'],
      ['from=2026-02-30', /from inválido/],
      ['from=2026-10-20&to=2026-10-10', 'A data inicial (from) não pode ser depois da data final (to).'],
      ['user_id=0', 'user_id deve ser um id válido (número inteiro positivo).'],
    ] as const) {
      await expectApiError(await api.get(`/platform/auth-events?${query}`, { headers: bearer(sa.token) }), 400, message, query);
    }
  });
});
