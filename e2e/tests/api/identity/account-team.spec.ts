import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  changeStoreStatus,
  cleanupWithFreshSuperadmin,
  createPlan,
  expectAuditRecord,
  storeWithOwner,
  type StoreWithOwner,
} from '../platform/helpers';
import { forgotPasswordLinksSent } from './account-helpers';
import { bearer, expectError, newClient, sessionOf, STRONG_PASSWORD, uniqueEmail } from './helpers';

/**
 * Pendências da revisão (leva 9a) na área de contas e convites: limite de links de "Esqueci minha senha"
 * por destinatário, convite do superpainel sem SMTP, links pendentes da equipe ao desativar a loja e limite
 * de equipe do plano rígido no cadastro direto e na restauração da lixeira.
 */
test.afterAll(cleanupWithFreshSuperadmin);

/** Membro cadastrado direto pelo ADMIN da loja (POST /users). */
function createMember(api: APIRequestContext, admin: { token: string }, role = 'KITCHEN') {
  return api.post('/users', {
    headers: bearer(admin.token),
    data: { name: `Equipe ${role}`, email: uniqueEmail('equipe-plano'), password: STRONG_PASSWORD, role },
  });
}

/** Loja nova com um plano de equipe limitado (o responsável já ocupa uma vaga). */
async function storeWithStaffLimit(api: APIRequestContext, limit: number): Promise<StoreWithOwner> {
  const superadmin = await sessionOf(api, 'superadmin');
  const plan = await createPlan(api, superadmin.token, { max_staff_users: limit });
  return storeWithOwner(api, superadmin.token, { planId: plan.id });
}

test('"Esqueci minha senha": no máximo 3 links por destinatário em 24 h (silencioso, auditado)', async ({ request }) => {
  const superadmin = await sessionOf(request, 'superadmin');
  const client = await newClient(request);
  for (let i = 0; i < 3; i++) {
    expect((await request.post('/auth/forgot-password', { data: { email: client.email } })).status()).toBe(202);
    await expect.poll(() => forgotPasswordLinksSent(client.user.id), { timeout: 10_000 }).toBe(i + 1);
  }
  // 4º pedido: a mesma resposta 202, mas nenhum link novo sai (de qualquer IP)
  const fourth = await request.post('/auth/forgot-password', { data: { email: client.email } });
  expect(fourth.status()).toBe(202);
  const denied = await expectAuditRecord(request, superadmin.token, {
    action: 'auth.password_reset.request',
    targetType: 'user',
    targetId: client.user.id,
    result: 'DENIED',
  });
  expect(denied.metadata).toMatchObject({ reason: 'recipient_limit', limit: 3 });
  expect(await forgotPasswordLinksSent(client.user.id)).toBe(3);
});

test('convite do superpainel sem SMTP: o link volta para o operador (delivered false), como antes', async ({ request }) => {
  const superadmin = await sessionOf(request, 'superadmin');
  const plan = await createPlan(request, superadmin.token);
  const store = await storeWithOwner(request, superadmin.token, { planId: plan.id });
  const res = await request.post(`/platform/stores/${store.id}/invitations`, {
    headers: bearer(superadmin.token),
    data: { email: uniqueEmail('convite-plataforma'), role: 'EMPLOYEE' },
  });
  expect(res.status(), await res.text()).toBe(201);
  const created = await res.json();
  expect(Object.keys(created).sort()).toEqual(['delivered', 'invitation', 'url', 'warnings']);
  expect(created.delivered).toBe(false);
  expect(created.url).toMatch(/\/convite\/[A-Za-z0-9_-]{43}$/);
});

test('desativar a loja vence os links de redefinição pendentes da equipe (além de encerrar as sessões)', async ({ request }) => {
  const superadmin = await sessionOf(request, 'superadmin');
  const store = await storeWithStaffLimit(request, 10);
  const memberRes = await createMember(request, store.owner);
  expect(memberRes.status(), await memberRes.text()).toBe(201);
  const member = await memberRes.json();

  const link = await request.post(`/platform/users/${member.id}/password-reset`, { headers: bearer(superadmin.token) });
  expect(link.status(), await link.text()).toBe(200);
  const token = String((await link.json()).url).split('/').pop() as string;
  expect((await request.get(`/auth/reset-password/${token}`)).status()).toBe(200);

  await changeStoreStatus(request, superadmin.token, store.id, 'deactivate', 'Encerrou as atividades (E2E)');
  await expectError(await request.get(`/auth/reset-password/${token}`), 404, /Link de redefinição inválido ou expirado/);
  // Nem a reativação traz o link de volta
  await changeStoreStatus(request, superadmin.token, store.id, 'restore', 'Voltou (E2E)');
  await expectError(await request.post('/auth/reset-password', { data: { token, password: 'Invasor#2026xy' } }), 404);
});

test('limite de equipe do plano rígido: cadastro direto em paralelo e restauração da lixeira não passam do max_staff_users', async ({ request }) => {
  // Plano com 3 vagas: o responsável ocupa 1
  const store = await storeWithStaffLimit(request, 3);
  const first = await createMember(request, store.owner);
  expect(first.status(), await first.text()).toBe(201);
  const firstMember = await first.json();

  // Uma vaga sobrando e quatro cadastros ao mesmo tempo: só um entra
  const burst = await Promise.all(Array.from({ length: 4 }, () => createMember(request, store.owner)));
  const statuses = burst.map((res) => res.status()).sort();
  expect(statuses, `status dos cadastros simultâneos: ${statuses.join(', ')}`).toEqual([201, 403, 403, 403]);
  const team = await request.get('/users', { headers: bearer(store.owner.token) });
  expect((await team.json()).length).toBe(3);

  // Lixeira libera a vaga; outra pessoa ocupa; restaurar a primeira → 403 e ela continua na lixeira
  expect((await request.delete(`/users/${firstMember.id}`, { headers: bearer(store.owner.token) })).status()).toBe(200);
  expect((await createMember(request, store.owner)).status()).toBe(201);
  await expectError(
    await request.patch(`/users/${firstMember.id}/restore`, { headers: bearer(store.owner.token) }),
    403,
    /Limite do plano/,
  );
  const trash = await request.get('/users/trash', { headers: bearer(store.owner.token) });
  expect((await trash.json()).map((user: { id: number }) => user.id)).toContain(firstMember.id);
});
