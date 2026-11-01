/**
 * E-mail transacional no superpainel (pendência de e-mail da arquitetura §12): GET /platform/settings informa
 * o driver ativo (MAIL_DRIVER) e a situação do SMTP sem usuário nem senha; POST /platform/settings/test-email
 * envia um e-mail de teste pelo driver — aqui o de LOG (a suíte nunca envia e-mails de verdade) —, só para o
 * superadmin com o token normal, com o destinatário validado, auditado (platform.settings.test_email) e
 * limitado por operador (o limite em si é coberto pelos testes unitários; este arquivo faz poucos envios).
 *
 * E-mails em HTML com a marca (texto + HTML; nome, cor e logo da loja nos e-mails dela): o conteúdo, o escape
 * e os links são cobertos pelos testes unitários (backend/src/notifications). Aqui, com o driver de log, os
 * fluxos que montam e-mails com a marca de uma loja de verdade (cor, logo, nome com marcação HTML e até valores
 * fora da validação gravados direto no banco) continuam funcionando: convite 201 com o link do site e o
 * "esqueci a senha" da equipe concluído em segundo plano (auditoria SUCCESS).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  MSG,
  auditRecordsAfter,
  bearer,
  cleanupPlatformData,
  createPlan,
  createStore,
  defaultSessions,
  endSupportSession,
  expectApiError,
  expectAuditRecord,
  expectOk,
  getSettings,
  latestAuditId,
  linkToken,
  newApi,
  startSupportSession,
  storeSlug,
  storeWithOwner,
  uniqueEmail,
  type Json,
  type Session,
} from './helpers';
import { sql } from '../billing/helpers';
import { findSecretKeys, makePng, pngFile } from '../identity/helpers';
import { E2E } from '../../../support/env';
import type { DefaultUserKey } from '../../../support/users';

const PATH = '/platform/settings/test-email';
const ACTION = 'platform.settings.test_email';
const INVALID_EMAIL = 'Informe um e-mail válido para o teste.';

let api: APIRequestContext;
let sessions: Record<DefaultUserKey, Session>;
let sa: Session;

test.beforeAll(async () => {
  api = await newApi();
  sessions = await defaultSessions(api);
  sa = sessions.superadmin;
});

test.afterAll(async () => {
  if (!api) return;
  try {
    await cleanupPlatformData(api, sa.token);
  } finally {
    await api.dispose();
  }
});

const sendTest = (data: unknown, token: string | null) =>
  api.post(PATH, { headers: token ? bearer(token) : {}, data: data as Json });

/** Os envios deste arquivo só fazem sentido com o driver de log (nenhum e-mail sai da máquina). */
async function requireLogDriver(): Promise<Json> {
  const settings = await getSettings(api, sa.token);
  test.skip(settings.mail?.driver !== 'log', `A suíte E2E roda com MAIL_DRIVER=log (driver atual: ${settings.mail?.driver}).`);
  return settings;
}

test.describe('GET /platform/settings: situação do e-mail transacional', () => {
  test('mostra o driver ativo e a situação do SMTP, sem usuário nem senha (também na resposta do PATCH)', async () => {
    const settings = await requireLogDriver();
    const mail = settings.mail;
    expect(mail).toMatchObject({ driver: 'log' });
    expect(typeof mail.smtp_configured).toBe('boolean');
    expect(mail.from === null || typeof mail.from === 'string').toBe(true);
    expect(Array.isArray(mail.issues)).toBe(true);
    if (mail.smtp !== null) {
      expect(Object.keys(mail.smtp).sort()).toEqual(['auth', 'host', 'port', 'secure']);
    }
    // NODE_ENV=test com o driver de log: nenhum aviso (o aviso é para produção)
    expect(mail.issues).toEqual([]);
    expect(findSecretKeys(mail)).toEqual([]);
    expect(JSON.stringify(mail)).not.toMatch(/"(user|password|pass|senha)"/i);

    const patched = await expectOk(
      await api.patch('/platform/settings', { headers: bearer(sa.token), data: { grace_period_days: settings.grace_period_days } }),
      200,
      'PATCH /platform/settings (sem mudança)',
    );
    expect(patched.mail).toEqual(mail);
  });
});

test.describe('POST /platform/settings/test-email', () => {
  test('anônimo 401; cliente, perfis da equipe e sessão de suporte 403 — nada é enviado nem auditado', async () => {
    await requireLogDriver();
    const plan = await createPlan(api, sa.token, { price: 0 });
    const store = await createStore(api, sa.token, { planId: plan.id });
    const support = await startSupportSession(api, sa.token, store.id);
    const marker = await latestAuditId(api, sa.token);
    const data = { to: uniqueEmail('teste-negado') };
    try {
      await expectApiError(await sendTest(data, null), 401, MSG.session, 'anônimo');
      for (const key of ['client', 'admin', 'employee', 'kitchen', 'courier'] as const) {
        await expectApiError(await sendTest(data, sessions[key].token), 403, MSG.platformOnly, key);
      }
      await expectApiError(await sendTest(data, support.token), 403, MSG.platformOnly, 'token de sessão de suporte');
    } finally {
      await endSupportSession(api, sa.token, support.id);
    }
    expect(await auditRecordsAfter(api, sa.token, { action: ACTION, targetType: 'platform_settings', targetId: 1, afterId: marker })).toEqual(
      [],
    );
  });

  test('valida o destinatário (ausente, inválido, lista, campo extra) antes de enviar ou auditar', async () => {
    await requireLogDriver();
    const marker = await latestAuditId(api, sa.token);
    for (const [label, data] of [
      ['sem corpo', {}],
      ['vazio', { to: '' }],
      ['sem domínio', { to: 'operador@' }],
      ['dois endereços', { to: 'a@example.com, b@example.com' }],
      ['número', { to: 123 }],
      ['lista', { to: ['a@example.com'] }],
    ] as const) {
      await expectApiError(await sendTest(data, sa.token), 400, INVALID_EMAIL, label);
    }
    await expectApiError(
      await sendTest({ to: uniqueEmail('teste-extra'), smtp_password: 'x' }, sa.token),
      400,
      'property smtp_password should not exist',
      'campo extra',
    );
    expect(await auditRecordsAfter(api, sa.token, { action: ACTION, targetType: 'platform_settings', targetId: 1, afterId: marker })).toEqual(
      [],
    );
  });

  test('superadmin com o driver de log: 200 sem envio real, destinatário normalizado e auditoria SUCCESS sem segredos', async () => {
    await requireLogDriver();
    const address = uniqueEmail('teste-mail');
    const marker = await latestAuditId(api, sa.token);

    const result = await expectOk(
      await sendTest({ to: `  ${address.toUpperCase()} ` }, sa.token),
      200,
      `POST ${PATH} como superadmin`,
    );
    expect(result).toEqual({
      to: address.toLowerCase(),
      driver: 'log',
      delivered: false,
      message_id: null,
      error: null,
      message: expect.stringContaining('Driver de log ativo'),
    });
    expect(findSecretKeys(result)).toEqual([]);

    const record = await expectAuditRecord(api, sa.token, {
      action: ACTION,
      targetType: 'platform_settings',
      targetId: 1,
      actorId: sa.user.id,
      actorScope: 'PLATFORM',
      storeId: null,
      result: 'SUCCESS',
    });
    expect(record.metadata).toEqual({ to: address.toLowerCase(), driver: 'log', delivered: false });
    // Um registro por envio (só o deste teste desde o marcador)
    const records = await auditRecordsAfter(api, sa.token, { action: ACTION, targetType: 'platform_settings', targetId: 1, afterId: marker });
    expect(records.map((item: Json) => ({ actor: item.actor?.id ?? null, result: item.result }))).toEqual([
      { actor: sa.user.id, result: 'SUCCESS' },
    ]);
    // O grupo "platform.settings" da auditoria inclui o e-mail de teste
    const group = await expectOk(
      await api.get('/platform/audit', { headers: bearer(sa.token), params: { action: 'platform.settings', pageSize: 5 } }),
      200,
      'GET /platform/audit?action=platform.settings',
    );
    expect(group.items.some((item: Json) => item.id === record.id)).toBe(true);
  });
});

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.describe('E-mails com a marca da loja (driver de log)', () => {
  test('loja com nome com marcação, cor e logo: convite 201 com o link do site e "esqueci a senha" da equipe concluído', async () => {
    await requireLogDriver();
    // Plano com identidade visual própria (custom_branding) — o padrão de createPlan
    const plan = await createPlan(api, sa.token);
    const slug = storeSlug('mail-marca');
    const name = `Lanchonete <b>"Marca"</b> & 'Cia' ${slug}`.slice(0, 120);
    const store = await storeWithOwner(api, sa.token, { planId: plan.id, slug, name });
    expect(store.name).toBe(name);
    const owner = bearer(store.owner.token);

    const settings = await expectOk(
      await api.patch('/store/settings', { headers: owner, data: { primary_color: '#FACC15' } }),
      200,
      'PATCH /store/settings (cor da loja)',
    );
    expect(settings.primary_color).toBe('#FACC15');
    const logo = await expectOk(
      await api.post('/store/logo', { headers: owner, multipart: { file: pngFile(makePng(32, 32), 'logo.png') } }),
      201,
      'POST /store/logo',
    );
    expect(logo.logo).toMatch(new RegExp(`^s${store.id}-[\\w.-]+\\.webp$`));

    const invite = async (label: string) => {
      const created = await expectOk(
        await api.post('/store/invitations', { headers: owner, data: { email: uniqueEmail(label), role: 'EMPLOYEE' } }),
        201,
        `POST /store/invitations (${label})`,
      );
      // O link do e-mail (e da resposta) é sempre o do site (APP_WEB_URL da API de teste)
      expect(created.url).toMatch(new RegExp(`^${escapeRegExp(E2E.webURL)}/convite/[A-Za-z0-9_-]{20,}$`));
      await expectAuditRecord(api, sa.token, {
        action: 'invitation.create',
        targetType: 'invitation',
        targetId: created.invitation.id,
        storeId: store.id,
        actorId: store.owner.user.id,
        secrets: [linkToken(created.url)],
      });
      return created;
    };

    // Convite com a marca da loja (nome, cor e logo)
    await invite('mail-marca');

    // Conta da equipe: o "esqueci a senha" responde 202 na hora e monta o e-mail com a marca da loja em
    // segundo plano; a auditoria SUCCESS só é gravada depois do envio pelo driver
    const marker = await latestAuditId(api, sa.token);
    const forgot = await api.post('/auth/forgot-password', { data: { email: store.owner.email } });
    expect(forgot.status(), await forgot.text()).toBe(202);
    await expectAuditRecord(api, sa.token, {
      action: 'auth.password_reset.request',
      targetType: 'user',
      targetId: store.owner.user.id,
      storeId: store.id,
      result: 'SUCCESS',
    });
    const requests = await auditRecordsAfter(api, sa.token, {
      action: 'auth.password_reset.request',
      targetType: 'user',
      targetId: store.owner.user.id,
      afterId: marker,
    });
    expect(requests.map((item: Json) => item.result)).toEqual(['SUCCESS']);

    // Cor e logo fora da validação da API, gravados direto no banco (dados antigos ou editados à mão): o e-mail
    // descarta os dois (cor da plataforma, sem imagem) e o convite continua saindo
    const [original] = await sql<{ primary_color: string | null; logo: string | null }>(
      'SELECT primary_color, logo FROM stores WHERE id = $1',
      [store.id],
    );
    await sql('UPDATE stores SET primary_color = $1, logo = $2 WHERE id = $3', [
      'red;x',
      'https://evil.example/logo.png',
      store.id,
    ]);
    try {
      await invite('mail-marca-suja');
    } finally {
      await sql('UPDATE stores SET primary_color = $1, logo = $2 WHERE id = $3', [original.primary_color, original.logo, store.id]);
    }
  });
});
