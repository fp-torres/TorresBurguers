import { test, expect, type APIRequestContext } from '@playwright/test';
import { login } from '../../../support/api';
import { demoStoreId, endSupportSession, expectAuditRecord, startSupportSession } from '../platform/helpers';
import {
  accountTokens,
  emailVerifiedAt,
  openAccountTokens,
  plantAccountToken,
  plantForgotPasswordToken,
} from './account-helpers';
import { bearer, expectError, newClient, sessionOf, STRONG_PASSWORD, uniqueEmail, type TestUser } from './helpers';

/**
 * Verificação e troca do e-mail da conta (rotas /account, plano email-verification fase 1a, modo compat):
 * a troca só acontece depois da confirmação no endereço novo, o endereço antigo recebe o "Não fui eu" e
 * fica reservado por 7 dias, e as rotas antigas (PATCH /users/:id, POST /users) mantêm o contrato.
 * Os links vêm do banco de teste (código plantado: o e-mail sai pelo driver de log).
 */

const NEW_PASSWORD = 'NovaSenha#2026xy';
const SECURITY_KEYS = ['account_security_mode', 'email', 'email_change', 'email_verified', 'email_verified_at'];
const PENDING_KEYS = ['email', 'expires_at', 'requested_at'];
const LINK_INVALID = /Link de confirmação inválido ou expirado/;

async function security(api: APIRequestContext, token: string): Promise<Record<string, any>> {
  const res = await api.get('/account/security', { headers: bearer(token) });
  expect(res.status(), `GET /account/security: ${await res.text()}`).toBe(200);
  return res.json();
}

function requestChange(api: APIRequestContext, user: TestUser, email: string, currentPassword = user.password) {
  return api.post('/account/email-change', {
    headers: bearer(user.token),
    data: { email, current_password: currentPassword },
  });
}

/** Pede a troca para um endereço livre e confirma pelo link (código plantado). */
async function changeEmail(api: APIRequestContext, user: TestUser, newEmail: string): Promise<void> {
  expect((await requestChange(api, user, newEmail)).status()).toBe(202);
  const token = await plantAccountToken(user.user.id, 'CHANGE', newEmail);
  const res = await api.post('/account/email-change/confirm', { data: { token } });
  expect(res.status(), `confirmação da troca: ${await res.text()}`).toBe(200);
}

test.describe('GET /account/security', () => {
  test('cliente novo: e-mail não confirmado, sem troca pendente, modo compat; sem token → 401', async ({ request }) => {
    const client = await newClient(request);
    const view = await security(request, client.token);
    expect(Object.keys(view).sort()).toEqual(SECURITY_KEYS);
    expect(view).toEqual({
      email: client.email.toLowerCase(),
      email_verified: false,
      email_verified_at: null,
      email_change: null,
      account_security_mode: 'compat',
    });
    // As respostas usadas pelo app não ganham o campo novo
    const self = await request.get(`/users/${client.user.id}`, { headers: bearer(client.token) });
    expect(Object.keys(await self.json())).not.toContain('email_verified_at');
    expect(Object.keys(client.user)).not.toContain('email_verified_at');

    await expectError(await request.get('/account/security'), 401);
  });
});

test.describe('verificação do e-mail', () => {
  test('o cadastro já envia o link; reenvio 202; conferir e confirmar; uso único; depois 200 "já confirmado" (auditado)', async ({ request }) => {
    const client = await newClient(request);
    const superadmin = await sessionOf(request, 'superadmin');
    // O cadastro dispara a verificação em segundo plano
    const signupToken = await plantAccountToken(client.user.id, 'VERIFY', client.email);

    const resent = await request.post('/account/email-verification', { headers: bearer(client.token) });
    expect(resent.status(), await resent.text()).toBe(202);
    const masked = `${client.email.slice(0, 2).toLowerCase()}***@`;
    expect((await resent.json()).message).toContain(masked);
    // O reenvio cancela o link anterior
    await expectError(await request.get(`/account/email-verification/${signupToken}`), 404, LINK_INVALID);

    const token = await plantAccountToken(client.user.id, 'VERIFY', client.email);
    const inspect = await request.get(`/account/email-verification/${token}`);
    expect(inspect.status(), await inspect.text()).toBe(200);
    const info = await inspect.json();
    expect(Object.keys(info).sort()).toEqual(['email_masked', 'expires_at']);
    expect(info.email_masked).toContain(masked);
    // O GET só confere: o e-mail continua não confirmado
    expect(await emailVerifiedAt(client.user.id)).toBeNull();

    const confirmed = await request.post('/account/email-verification/confirm', { data: { token } });
    expect(confirmed.status(), await confirmed.text()).toBe(200);
    expect(await confirmed.json()).toEqual({ message: 'E-mail confirmado.', email_masked: info.email_masked });
    expect(await emailVerifiedAt(client.user.id)).not.toBeNull();
    await expectError(await request.post('/account/email-verification/confirm', { data: { token } }), 404, LINK_INVALID);

    const view = await security(request, client.token);
    expect(view.email_verified).toBe(true);
    expect(typeof view.email_verified_at).toBe('string');

    const again = await request.post('/account/email-verification', { headers: bearer(client.token) });
    expect(again.status()).toBe(200);
    expect(await again.json()).toEqual({ message: 'Seu e-mail já está confirmado.', email_verified: true });

    const requested = await expectAuditRecord(request, superadmin.token, {
      action: 'auth.email_verification.request',
      targetType: 'user',
      targetId: client.user.id,
    });
    expect(JSON.stringify(requested)).not.toContain(token);
    const audited = await expectAuditRecord(request, superadmin.token, {
      action: 'auth.email_verification.confirm',
      targetType: 'user',
      targetId: client.user.id,
    });
    expect(JSON.stringify(audited)).not.toContain(token);
  });

  test('códigos fora do formato, inexistentes ou de outro tipo de link → 404 (sem revelar nada)', async ({ request }) => {
    const client = await newClient(request);
    const changeToken = await (async () => {
      expect((await requestChange(request, client, uniqueEmail('outro-tipo'))).status()).toBe(202);
      return plantAccountToken(client.user.id, 'CHANGE');
    })();
    for (const token of ['curto', 'x'.repeat(43), changeToken]) {
      await expectError(await request.get(`/account/email-verification/${token}`), 404, LINK_INVALID);
      await expectError(await request.post('/account/email-verification/confirm', { data: { token } }), 404, LINK_INVALID);
    }
    await expectError(await request.post('/account/email-verification/confirm', { data: {} }), 400);
    await expectError(await request.post('/account/email-verification/confirm', { data: { token: changeToken, extra: 1 } }), 400);
  });
});

test.describe('troca do e-mail (POST/DELETE /account/email-change)', () => {
  test('senha atual errada → 400; mesmo e-mail → 400; campos extras ou inválidos → 400', async ({ request }) => {
    const client = await newClient(request);
    await expectError(await requestChange(request, client, uniqueEmail('troca'), 'Errada#2026xy'), 400, /A senha atual não confere/);
    await expectError(await requestChange(request, client, client.email.toUpperCase()), 400, /Este já é o e-mail da sua conta/);
    await expectError(
      await request.post('/account/email-change', { headers: bearer(client.token), data: { email: 'nao-e-email', current_password: client.password } }),
      400,
    );
    await expectError(
      await request.post('/account/email-change', {
        headers: bearer(client.token),
        data: { email: uniqueEmail('troca'), current_password: client.password, role: 'ADMIN' },
      }),
      400,
    );
    await expectError(await request.post('/account/email-change', { data: { email: uniqueEmail('troca'), current_password: 'x' } }), 401);
    expect(await accountTokens(client.user.id).then((rows) => rows.filter((row) => row.purpose === 'CHANGE'))).toHaveLength(0);
  });

  test('e-mail livre ou já usado por outra conta: a MESMA resposta 202 e o mesmo estado pendente; cancelar → 204 (idempotente)', async ({ request }) => {
    const superadmin = await sessionOf(request, 'superadmin');
    const client = await newClient(request);
    const other = await newClient(request);

    const free = uniqueEmail('livre');
    const freeRes = await requestChange(request, client, free);
    expect(freeRes.status(), await freeRes.text()).toBe(202);
    const freeBody = await freeRes.json();

    const takenRes = await requestChange(request, client, other.email);
    expect(takenRes.status(), await takenRes.text()).toBe(202);
    const takenBody = await takenRes.json();

    for (const [body, email] of [
      [freeBody, free],
      [takenBody, other.email.toLowerCase()],
    ] as const) {
      expect(Object.keys(body).sort()).toEqual(['email_change', 'message']);
      expect(Object.keys(body.email_change).sort()).toEqual(PENDING_KEYS);
      expect(body.email_change.email).toBe(email);
      expect(body.message).toBe(
        `Enviamos um link de confirmação para ${email}. O e-mail da conta só muda depois da confirmação (o link vale 24 horas).`,
      );
    }
    // Um pedido em aberto por conta (o novo substitui o anterior), com o mesmo formato nos dois casos
    const open = await openAccountTokens(client.user.id, 'CHANGE');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ email: other.email.toLowerCase(), previous_email: client.email.toLowerCase() });
    expect((await security(request, client.token)).email_change).toEqual(takenBody.email_change);
    // O e-mail da conta não mudou
    expect((await security(request, client.token)).email).toBe(client.email.toLowerCase());

    // A sondagem fica visível na auditoria (FAILURE), mesmo com o HTTP 202
    const audited = await expectAuditRecord(request, superadmin.token, {
      action: 'auth.email_change.request',
      targetType: 'user',
      targetId: client.user.id,
      result: 'FAILURE',
    });
    expect(audited.metadata).toMatchObject({ email: other.email.toLowerCase(), reason: 'email_in_use' });

    const cancel = await request.delete('/account/email-change', { headers: bearer(client.token) });
    expect(cancel.status()).toBe(204);
    expect((await security(request, client.token)).email_change).toBeNull();
    expect(await openAccountTokens(client.user.id, 'CHANGE')).toHaveLength(0);
    expect((await request.delete('/account/email-change', { headers: bearer(client.token) })).status()).toBe(204);
    await expectAuditRecord(request, superadmin.token, {
      action: 'auth.email_change.cancel',
      targetType: 'user',
      targetId: client.user.id,
    });
  });

  test('confirmação: e-mail novo e confirmado, sessões encerradas, "Não fui eu" criado e o e-mail antigo reservado', async ({ request }) => {
    const superadmin = await sessionOf(request, 'superadmin');
    const client = await newClient(request);
    const oldEmail = client.email.toLowerCase();
    const newEmail = uniqueEmail('confirmada');

    expect((await requestChange(request, client, newEmail)).status()).toBe(202);
    const token = await plantAccountToken(client.user.id, 'CHANGE', newEmail);

    const inspect = await request.get(`/account/email-change/${token}`);
    expect(inspect.status(), await inspect.text()).toBe(200);
    const info = await inspect.json();
    expect(Object.keys(info).sort()).toEqual(['current_email_masked', 'expires_at', 'new_email_masked']);
    expect(info.current_email_masked).toBe(`${oldEmail.slice(0, 2)}***@${oldEmail.split('@')[1]}`);
    expect(info.new_email_masked).toBe(`${newEmail.slice(0, 2)}***@${newEmail.split('@')[1]}`);
    // Conferir não usa o link
    expect((await security(request, client.token)).email).toBe(oldEmail);

    const confirmed = await request.post('/account/email-change/confirm', { data: { token } });
    expect(confirmed.status(), await confirmed.text()).toBe(200);
    expect(await confirmed.json()).toEqual({ message: 'E-mail alterado. Entre com o novo e-mail.', email: newEmail });
    await expectError(await request.post('/account/email-change/confirm', { data: { token } }), 404, LINK_INVALID);

    // Todas as sessões foram encerradas; o login vale com o e-mail novo
    await expectError(await request.get('/auth/me', { headers: bearer(client.token) }), 401);
    await expectError(await request.post('/auth/login', { data: { email: oldEmail, password: client.password } }), 401);
    const fresh = await login(request, newEmail, client.password);
    const view = await security(request, fresh.token);
    expect(view).toMatchObject({ email: newEmail, email_verified: true, email_change: null });

    // "Não fui eu" do endereço antigo em aberto: o endereço fica reservado para a conta (cadastro → 409)
    const reverts = await openAccountTokens(client.user.id, 'REVERT');
    expect(reverts).toHaveLength(1);
    expect(reverts[0]).toMatchObject({ email: oldEmail, previous_email: newEmail });
    await expectError(
      await request.post('/users', { data: { name: 'Toma E-mail', email: oldEmail, password: STRONG_PASSWORD } }),
      409,
      /E-mail já cadastrado/,
    );

    const audited = await expectAuditRecord(request, superadmin.token, {
      action: 'auth.email_change.confirm',
      targetType: 'user',
      targetId: client.user.id,
    });
    expect(audited.metadata).toMatchObject({ from: oldEmail, to: newEmail });
    expect(JSON.stringify(audited)).not.toContain(token);
  });

  test('e-mail novo tomado por outra conta antes da confirmação → 409 só para quem tem o link (e nada muda)', async ({ request }) => {
    const client = await newClient(request);
    const target = uniqueEmail('tomado');
    expect((await requestChange(request, client, target)).status()).toBe(202);
    const token = await plantAccountToken(client.user.id, 'CHANGE', target);
    // Outra pessoa se cadastra com o endereço neste meio-tempo
    expect((await request.post('/users', { data: { name: 'Mais Rápida', email: target, password: STRONG_PASSWORD } })).status()).toBe(201);

    await expectError(
      await request.post('/account/email-change/confirm', { data: { token } }),
      409,
      /Este e-mail passou a ser usado por outra conta/,
    );
    expect((await security(request, client.token)).email).toBe(client.email.toLowerCase());
  });

  test('pedido cancelado ou e-mail da conta alterado depois do pedido → o link de confirmação deixa de valer', async ({ request }) => {
    const client = await newClient(request);
    const first = uniqueEmail('cancelada');
    expect((await requestChange(request, client, first)).status()).toBe(202);
    const cancelled = await plantAccountToken(client.user.id, 'CHANGE', first);
    expect((await request.delete('/account/email-change', { headers: bearer(client.token) })).status()).toBe(204);
    await expectError(await request.get(`/account/email-change/${cancelled}`), 404, LINK_INVALID);

    const second = uniqueEmail('desatualizada');
    expect((await requestChange(request, client, second)).status()).toBe(202);
    const stale = await plantAccountToken(client.user.id, 'CHANGE', second);
    // Troca pela rota antiga (compat) depois do pedido: a conta não tem mais o e-mail do pedido
    const legacy = await request.patch(`/users/${client.user.id}`, {
      headers: bearer(client.token),
      data: { email: uniqueEmail('pela-rota-antiga') },
    });
    expect(legacy.status(), await legacy.text()).toBe(200);
    await expectError(await request.post('/account/email-change/confirm', { data: { token: stale } }), 404, LINK_INVALID);
  });
});

test.describe('"Não fui eu" (desfazer a troca)', () => {
  test('devolve o e-mail antigo com senha nova, encerra as sessões e cancela os outros links (auditado)', async ({ request }) => {
    const superadmin = await sessionOf(request, 'superadmin');
    const client = await newClient(request);
    const oldEmail = client.email.toLowerCase();
    const newEmail = uniqueEmail('invasor');
    await changeEmail(request, client, newEmail);
    const intruder = await login(request, newEmail, client.password);
    // Quem tomou a conta pede outra troca: o "Não fui eu" desfaz mesmo assim e cancela esse pedido
    expect((await requestChange(request, { ...client, token: intruder.token }, uniqueEmail('mais-uma'))).status()).toBe(202);

    const token = await plantAccountToken(client.user.id, 'REVERT', oldEmail);
    const inspect = await request.get(`/account/email-revert/${token}`);
    expect(inspect.status(), await inspect.text()).toBe(200);
    const info = await inspect.json();
    expect(Object.keys(info).sort()).toEqual(['expires_at', 'replaced_email_masked', 'restored_email_masked']);
    expect(info.restored_email_masked).toBe(`${oldEmail.slice(0, 2)}***@${oldEmail.split('@')[1]}`);

    await expectError(await request.post('/account/email-revert', { data: { token, password: 'fraca' } }), 400);
    const reverted = await request.post('/account/email-revert', { data: { token, password: NEW_PASSWORD } });
    expect(reverted.status(), await reverted.text()).toBe(200);
    const done = await reverted.json();
    expect(done).toEqual({
      message: `Troca de e-mail desfeita. Entre com ${info.restored_email_masked} e a nova senha.`,
      email_masked: info.restored_email_masked,
    });

    await expectError(await request.get('/auth/me', { headers: bearer(intruder.token) }), 401);
    await expectError(await request.post('/auth/login', { data: { email: newEmail, password: client.password } }), 401);
    const owner = await login(request, oldEmail, NEW_PASSWORD);
    expect(await security(request, owner.token)).toMatchObject({ email: oldEmail, email_verified: true, email_change: null });
    // Nenhum link da conta continua aberto (troca do invasor, verificação, outros "Não fui eu")
    expect((await accountTokens(client.user.id)).filter((row) => !row.used_at && !row.revoked_at)).toEqual([]);
    await expectError(await request.post('/account/email-revert', { data: { token, password: NEW_PASSWORD } }), 404);

    const audited = await expectAuditRecord(request, superadmin.token, {
      action: 'auth.email_change.revert',
      targetType: 'user',
      targetId: client.user.id,
    });
    expect(audited.metadata).toMatchObject({ restored: oldEmail, replaced: newEmail });
    expect(JSON.stringify(audited)).not.toContain(token);
    expect(JSON.stringify(audited)).not.toContain(NEW_PASSWORD);
  });

  test('vale mesmo depois de outra troca (A→B→C): volta para A', async ({ request }) => {
    const client = await newClient(request);
    const a = client.email.toLowerCase();
    const b = uniqueEmail('cadeia-b');
    const c = uniqueEmail('cadeia-c');
    await changeEmail(request, client, b);
    const asB = await login(request, b, client.password);
    await changeEmail(request, { ...client, token: asB.token }, c);

    const token = await plantAccountToken(client.user.id, 'REVERT', a);
    const reverted = await request.post('/account/email-revert', { data: { token, password: NEW_PASSWORD } });
    expect(reverted.status(), await reverted.text()).toBe(200);
    const owner = await login(request, a, NEW_PASSWORD);
    expect((await security(request, owner.token)).email).toBe(a);
  });
});

test.describe('sessão de suporte e rotas antigas (compat)', () => {
  test('sessão de suporte: só a leitura (GET /account/security); as ações → 403', async ({ request }) => {
    const superadmin = await sessionOf(request, 'superadmin');
    const support = await startSupportSession(request, superadmin.token, await demoStoreId(request));
    try {
      const headers = bearer(support.token);
      expect((await request.get('/account/security', { headers })).status()).toBe(200);
      await expectError(
        await request.post('/account/password', { headers, data: { current_password: 'x', password: NEW_PASSWORD } }),
        403,
      );
      await expectError(await request.post('/account/email-change', { headers, data: { email: uniqueEmail('suporte'), current_password: 'x' } }), 403);
      await expectError(await request.delete('/account/email-change', { headers }), 403);
      await expectError(await request.post('/account/email-verification', { headers }), 403);
    } finally {
      await endSupportSession(request, superadmin.token, support.id);
    }
  });

  test('PATCH /users/:id da própria conta mantém o contrato e passa a criar o "Não fui eu" e a verificação do novo', async ({ request }) => {
    const client = await newClient(request);
    const oldEmail = client.email.toLowerCase();
    const newEmail = uniqueEmail('rota-antiga');
    const res = await request.patch(`/users/${client.user.id}`, { headers: bearer(client.token), data: { email: newEmail } });
    expect(res.status(), await res.text()).toBe(200);
    const payload = await res.json();
    // Contrato antigo: o usuário (mesmas chaves) + access_token novo
    expect(Object.keys(payload).sort()).toEqual([...Object.keys(client.user), 'access_token'].sort());
    expect(payload.email).toBe(newEmail);
    expect(await emailVerifiedAt(client.user.id)).toBeNull();

    expect(await openAccountTokens(client.user.id, 'REVERT')).toEqual([
      expect.objectContaining({ email: oldEmail, previous_email: newEmail }),
    ]);
    expect(await openAccountTokens(client.user.id, 'VERIFY')).toEqual([expect.objectContaining({ email: newEmail })]);
    // O endereço antigo fica reservado por 7 dias (409 no cadastro de outra pessoa)
    await expectError(
      await request.post('/users', { data: { name: 'Outra', email: oldEmail, password: STRONG_PASSWORD } }),
      409,
      /E-mail já cadastrado/,
    );
    // A própria conta pode voltar ao e-mail antigo
    const back = await request.patch(`/users/${client.user.id}`, { headers: bearer(payload.access_token), data: { email: oldEmail } });
    expect(back.status(), await back.text()).toBe(200);
  });

  test('"Esqueci minha senha": o link recebido por e-mail confirma o e-mail da conta', async ({ request }) => {
    const client = await newClient(request);
    expect(await emailVerifiedAt(client.user.id)).toBeNull();
    expect((await request.post('/auth/forgot-password', { data: { email: client.email } })).status()).toBe(202);
    const token = await plantForgotPasswordToken(client.user.id);
    const reset = await request.post('/auth/reset-password', { data: { token, password: NEW_PASSWORD } });
    expect(reset.status(), await reset.text()).toBe(200);
    const fresh = await login(request, client.email, NEW_PASSWORD);
    expect((await security(request, fresh.token)).email_verified).toBe(true);
  });
});
