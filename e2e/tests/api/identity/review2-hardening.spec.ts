import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { login } from '../../../support/api';
import {
  bearer,
  cleanupTrackedStaff,
  expectError,
  newClient,
  newUserWithRole,
  sessionOf,
  uniqueEmail,
} from './helpers';

/**
 * Revisão de segurança, rodada 2 (identidade): regra de senha sem ReDoS, links de redefinição que
 * vencem quando a conta muda de mãos, link do superpainel e teto de sessões por conta.
 */
test.afterAll(cleanupTrackedStaff);

const HUGE_PASSWORD = 'a'.repeat(100_000);
const NEW_PASSWORD = 'NovaSenha#2026xy';

/** Gera o link pelo superpainel (driver de log nos testes: a url volta) e devolve o código. */
async function resetTokenFor(api: APIRequestContext, userId: number): Promise<string> {
  const superadmin = await sessionOf(api, 'superadmin');
  const res = await api.post(`/platform/users/${userId}/password-reset`, { headers: bearer(superadmin.token) });
  expect(res.status(), `link de redefinição: ${await res.text()}`).toBe(200);
  const link = await res.json();
  expect(link.delivered).toBe(false);
  return String(link.url).split('/').pop() as string;
}

async function expectLinkDead(api: APIRequestContext, token: string): Promise<void> {
  await expectError(await api.get(`/auth/reset-password/${token}`), 404, /Link de redefinição inválido ou expirado/);
  await expectError(
    await api.post('/auth/reset-password', { data: { token, password: 'Invasor#2026xy' } }),
    404,
    /Link de redefinição inválido ou expirado/,
  );
}

/** Mede a resposta e confere que a API seguiu atendendo (GET /health) enquanto ela era processada. */
async function timed(api: APIRequestContext, send: () => Promise<APIResponse>) {
  const started = Date.now();
  const pending = send();
  const healthStarted = Date.now();
  const health = await api.get('/health');
  const healthMs = Date.now() - healthStarted;
  const res = await pending;
  return { res, ms: Date.now() - started, health, healthMs };
}

test.describe('Regra de senha sem ReDoS: senha de ~100 KB não trava a API', () => {
  const cases: Array<[string, (api: APIRequestContext) => Promise<APIResponse>]> = [
    ['POST /auth/reset-password', (api) => api.post('/auth/reset-password', { data: { token: 'x', password: HUGE_PASSWORD } })],
    [
      'POST /invitations/:token/accept',
      (api) => api.post('/invitations/QUALQUERCOISA/accept', { data: { name: 'x', password: HUGE_PASSWORD } }),
    ],
    [
      'POST /stores/signup',
      (api) =>
        api.post('/stores/signup', {
          data: {
            store: { name: 'x', slug: 'abc' },
            owner: { name: 'x', email: 'a@b.co', password: HUGE_PASSWORD },
            accept_terms: true,
          },
        }),
    ],
    ['POST /users (cadastro público)', (api) => api.post('/users', { data: { name: 'x', email: uniqueEmail('redos'), password: HUGE_PASSWORD } })],
  ];

  for (const [label, send] of cases) {
    test(`${label}: recusada na hora, com a API respondendo ao mesmo tempo`, async ({ request }) => {
      const { res, ms, health, healthMs } = await timed(request, () => send(request));
      // 400 da validação (ou 413 se o corpo passar do limite configurado); antes: ~20 s presos no event loop
      expect([400, 413], `${label}: ${res.status()} ${await res.text()}`).toContain(res.status());
      expect(ms, `${label} levou ${ms} ms`).toBeLessThan(3_000);
      expect(health.status()).toBe(200);
      expect(healthMs, `GET /health levou ${healthMs} ms durante ${label}`).toBeLessThan(3_000);
    });
  }

  test('PATCH /users/:id (própria conta) com senha de ~100 KB → 400 na hora', async ({ request }) => {
    const client = await newClient(request);
    const { res, ms } = await timed(request, () =>
      request.patch(`/users/${client.user.id}`, {
        headers: bearer(client.token),
        data: { password: HUGE_PASSWORD, current_password: client.password },
      }),
    );
    expect([400, 413]).toContain(res.status());
    expect(ms).toBeLessThan(3_000);
  });
});

test.describe('Links de redefinição pendentes vencem quando a conta muda de mãos', () => {
  test('troca do próprio e-mail ou da própria senha: o link enviado antes deixa de valer; editar só o nome não', async ({ request }) => {
    const client = await newClient(request);

    const keep = await resetTokenFor(request, client.user.id);
    const renamed = await request.patch(`/users/${client.user.id}`, {
      headers: bearer(client.token),
      data: { name: 'Só o nome mudou' },
    });
    expect(renamed.status(), await renamed.text()).toBe(200);
    expect((await request.get(`/auth/reset-password/${keep}`)).status()).toBe(200);

    const beforeEmail = await resetTokenFor(request, client.user.id);
    const newEmail = uniqueEmail('troca-email');
    const changed = await request.patch(`/users/${client.user.id}`, {
      headers: bearer(client.token),
      data: { email: newEmail, current_password: client.password },
    });
    expect(changed.status(), await changed.text()).toBe(200);
    const token = (await changed.json()).access_token as string;
    await expectLinkDead(request, beforeEmail);

    const beforePassword = await resetTokenFor(request, client.user.id);
    const changedPassword = await request.patch(`/users/${client.user.id}`, {
      headers: bearer(token),
      data: { password: NEW_PASSWORD, current_password: client.password },
    });
    expect(changedPassword.status(), await changedPassword.text()).toBe(200);
    await expectLinkDead(request, beforePassword);
    // A senha continua a escolhida pela pessoa (o link antigo não a trocou)
    await login(request, newEmail, NEW_PASSWORD);
  });

  test('ADMIN trocando e-mail e senha de um membro: o link pedido antes pelo membro deixa de valer', async ({ request }) => {
    const member = await newUserWithRole(request, 'KITCHEN');
    const admin = await sessionOf(request, 'admin');
    const token = await resetTokenFor(request, member.user.id);
    const res = await request.patch(`/users/${member.user.id}`, {
      headers: bearer(admin.token),
      data: { email: uniqueEmail('caixa'), password: NEW_PASSWORD },
    });
    expect(res.status(), await res.text()).toBe(200);
    await expectLinkDead(request, token);
  });

  test('bloqueio pelo superpainel: o link não volta a valer no desbloqueio', async ({ request }) => {
    const client = await newClient(request);
    const superadmin = await sessionOf(request, 'superadmin');
    const token = await resetTokenFor(request, client.user.id);
    const blocked = await request.post(`/platform/users/${client.user.id}/block`, {
      headers: bearer(superadmin.token),
      data: { reason: 'Revisão rodada 2' },
    });
    expect(blocked.status(), await blocked.text()).toBe(200);
    await expectLinkDead(request, token);
    const unblocked = await request.post(`/platform/users/${client.user.id}/unblock`, { headers: bearer(superadmin.token) });
    expect(unblocked.status(), await unblocked.text()).toBe(200);
    await expectLinkDead(request, token);
  });

  test('"sair de todos os aparelhos" também vence o link pendente', async ({ request }) => {
    const client = await newClient(request);
    const token = await resetTokenFor(request, client.user.id);
    const res = await request.post('/auth/logout-all', { headers: bearer(client.token) });
    expect(res.ok(), await res.text()).toBeTruthy();
    await expectLinkDead(request, token);
  });

  test('lixeira e restauração: o link pedido antes da exclusão não volta a valer', async ({ request }) => {
    const member = await newUserWithRole(request, 'COURIER');
    const admin = await sessionOf(request, 'admin');
    const token = await resetTokenFor(request, member.user.id);
    const removed = await request.delete(`/users/${member.user.id}`, { headers: bearer(admin.token) });
    expect(removed.status(), await removed.text()).toBe(200);
    const restored = await request.patch(`/users/${member.user.id}/restore`, { headers: bearer(admin.token) });
    expect(restored.status(), await restored.text()).toBe(200);
    await expectLinkDead(request, token);
  });
});

test.describe('Link de redefinição pelo superpainel', () => {
  test('conta da plataforma (outro superadmin) não recebe link pelo superpainel → 403, sem url', async ({ request }) => {
    const superadmin = await sessionOf(request, 'superadmin');
    const res = await request.post(`/platform/users/${superadmin.user.id}/password-reset`, {
      headers: bearer(superadmin.token),
    });
    const payload = await expectError(res, 403, /Contas da administração da plataforma não recebem link/);
    expect(JSON.stringify(payload)).not.toMatch(/redefinir-senha/);
  });

  test('sem SMTP (driver de log): { url, delivered: false, expires_at, message } para o operador repassar', async ({ request }) => {
    const client = await newClient(request);
    const superadmin = await sessionOf(request, 'superadmin');
    const res = await request.post(`/platform/users/${client.user.id}/password-reset`, { headers: bearer(superadmin.token) });
    expect(res.status(), await res.text()).toBe(200);
    const link = await res.json();
    expect(Object.keys(link).sort()).toEqual(['delivered', 'expires_at', 'message', 'url']);
    expect(link.delivered).toBe(false);
    expect(String(link.url)).toMatch(/\/redefinir-senha\/[A-Za-z0-9_-]{32,128}$/);
  });
});

test.describe('Teto de sessões ativas por conta', () => {
  test('logins corretos repetidos não acumulam sessões sem fim: as mais antigas caem (401) e a lista fica limitada', async ({ request }) => {
    test.slow();
    const client = await newClient(request);
    // Teto de 100 sessões ativas por conta (MAX_ACTIVE_SESSIONS_PER_ACCOUNT); 105 logins passam dele
    const tokens: string[] = [client.token];
    for (let i = 0; i < 105; i++) {
      tokens.push((await login(request, client.email, client.password)).token);
    }

    const newest = tokens[tokens.length - 1];
    const list = await request.get('/auth/sessions?page=1&pageSize=100', { headers: bearer(newest) });
    expect(list.status(), await list.text()).toBe(200);
    const sessions = await list.json();
    expect(sessions.total).toBe(100);

    // A mais antiga foi encerrada pelo teto; a mais recente continua valendo
    await expectError(await request.get('/auth/me', { headers: bearer(tokens[0]) }), 401);
    expect((await request.get('/auth/me', { headers: bearer(newest) })).status()).toBe(200);
  });
});
