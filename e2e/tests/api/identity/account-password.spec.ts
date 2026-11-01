import { test, expect, type APIRequestContext } from '@playwright/test';
import { login } from '../../../support/api';
import { expectAuditRecord } from '../platform/helpers';
import { openAccountTokens, plantAccountToken } from './account-helpers';
import { bearer, expectError, newClient, newUserWithRole, sessionOf, uniqueEmail, cleanupTrackedStaff } from './helpers';

/**
 * Troca da própria senha com a senha atual (POST /account/password): a sessão continua em quem trocou
 * (resposta no formato do login), as outras caem e os links pendentes da conta deixam de valer.
 */
test.afterAll(cleanupTrackedStaff);

const NEW_PASSWORD = 'NovaSenha#2026xy';
const SESSION_USER_KEYS = [
  'avatar',
  'created_at',
  'email',
  'id',
  'name',
  'phone',
  'platform_role',
  'role',
  'store',
  'store_id',
  'updated_at',
];

/** Link de redefinição gerado pelo superpainel (driver de log: a url volta) e o código dele. */
async function platformResetToken(api: APIRequestContext, userId: number): Promise<string> {
  const superadmin = await sessionOf(api, 'superadmin');
  const res = await api.post(`/platform/users/${userId}/password-reset`, { headers: bearer(superadmin.token) });
  expect(res.status(), await res.text()).toBe(200);
  return String((await res.json()).url).split('/').pop() as string;
}

test('com a senha atual: { access_token, user } do login; o token antigo cai; login com a senha nova; links pendentes invalidados', async ({ request }) => {
  const superadmin = await sessionOf(request, 'superadmin');
  const client = await newClient(request);
  const resetToken = await platformResetToken(request, client.user.id);
  expect((await request.post('/account/email-change', {
    headers: bearer(client.token),
    data: { email: uniqueEmail('pendente'), current_password: client.password },
  })).status()).toBe(202);

  const res = await request.post('/account/password', {
    headers: bearer(client.token),
    data: { current_password: client.password, password: NEW_PASSWORD },
  });
  expect(res.status(), await res.text()).toBe(200);
  const payload = await res.json();
  expect(Object.keys(payload).sort()).toEqual(['access_token', 'user']);
  expect(Object.keys(payload.user).sort()).toEqual(SESSION_USER_KEYS);
  expect(JSON.stringify(payload)).not.toMatch(/password|hash|token_version|email_verified/);

  // A sessão de quem trocou continua com o token novo; a antiga caiu
  expect((await request.get('/auth/me', { headers: bearer(payload.access_token) })).status()).toBe(200);
  await expectError(await request.get('/auth/me', { headers: bearer(client.token) }), 401);
  await expectError(await request.post('/auth/login', { data: { email: client.email, password: client.password } }), 401);
  await login(request, client.email, NEW_PASSWORD);

  // Link de redefinição e pedido de troca de e-mail pendentes não valem mais
  await expectError(await request.get(`/auth/reset-password/${resetToken}`), 404);
  expect(await openAccountTokens(client.user.id, 'CHANGE')).toHaveLength(0);

  const audited = await expectAuditRecord(request, superadmin.token, {
    action: 'account.credentials.change',
    targetType: 'user',
    targetId: client.user.id,
  });
  expect(audited.metadata).toMatchObject({ fields: ['password'], via: 'account_password' });
  expect(JSON.stringify(audited)).not.toContain(NEW_PASSWORD);
});

test('equipe também troca pela rota nova (cozinha); senha atual errada → 400 e nada muda', async ({ request }) => {
  const kitchen = await newUserWithRole(request, 'KITCHEN');
  await expectError(
    await request.post('/account/password', {
      headers: bearer(kitchen.token),
      data: { current_password: 'Errada#2026xy', password: NEW_PASSWORD },
    }),
    400,
    /A senha atual não confere/,
  );
  expect((await request.get('/auth/me', { headers: bearer(kitchen.token) })).status()).toBe(200);

  const res = await request.post('/account/password', {
    headers: bearer(kitchen.token),
    data: { current_password: kitchen.password, password: NEW_PASSWORD },
  });
  expect(res.status(), await res.text()).toBe(200);
  expect((await res.json()).user).toMatchObject({ id: kitchen.user.id, role: 'KITCHEN' });
  await login(request, kitchen.email, NEW_PASSWORD);
});

test('mesma senha → 400; regra de senha → 400; campos extras → 400; sem token → 401', async ({ request }) => {
  const client = await newClient(request);
  const headers = bearer(client.token);
  await expectError(
    await request.post('/account/password', { headers, data: { current_password: client.password, password: client.password } }),
    400,
    /A nova senha deve ser diferente da atual/,
  );
  await expectError(await request.post('/account/password', { headers, data: { current_password: client.password, password: 'fraca' } }), 400);
  await expectError(
    await request.post('/account/password', { headers, data: { current_password: client.password, password: NEW_PASSWORD, role: 'ADMIN' } }),
    400,
  );
  await expectError(await request.post('/account/password', { headers, data: { password: NEW_PASSWORD } }), 400);
  await expectError(await request.post('/account/password', { data: { current_password: client.password, password: NEW_PASSWORD } }), 401);
  // Nada mudou: a sessão continua e a senha antiga vale
  expect((await request.get('/auth/me', { headers })).status()).toBe(200);
  await login(request, client.email, client.password);
});

test('senha trocada pela rota antiga (PATCH /users/:id) continua com o mesmo contrato', async ({ request }) => {
  const client = await newClient(request);
  // Pedido de troca de e-mail em aberto: uma troca de senha também o cancela
  expect((await request.post('/account/email-change', {
    headers: bearer(client.token),
    data: { email: uniqueEmail('cancelado-pela-senha'), current_password: client.password },
  })).status()).toBe(202);
  const pending = await plantAccountToken(client.user.id, 'CHANGE');

  const res = await request.patch(`/users/${client.user.id}`, { headers: bearer(client.token), data: { password: NEW_PASSWORD } });
  expect(res.status(), await res.text()).toBe(200);
  expect(typeof (await res.json()).access_token).toBe('string');
  await expectError(await request.get(`/account/email-change/${pending}`), 404);
});
