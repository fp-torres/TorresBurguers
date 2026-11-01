import { test, expect } from '@playwright/test';
import { E2E } from '../../../support/env';
import { DEFAULT_USERS } from '../../../support/users';
import {
  MAX_UPLOAD_BYTES,
  STAFF_ROLES,
  STRONG_PASSWORD,
  bearer,
  body,
  demoStore,
  expectError,
  expectNoSecrets,
  isWebp,
  makePng,
  newClient,
  newUploadSizes,
  newUserWithRole,
  pngFile,
  sessionOf,
  signupPayload,
  sleep,
  uid,
  uniqueEmail,
  uploadedFiles,
  cleanupTrackedStaff,
  trackStaff,
} from './helpers';

test.afterAll(cleanupTrackedStaff);

test.describe('Cadastro público (POST /users)', () => {
  test('sem perfil cria um CLIENT global (sem loja) com nome/e-mail normalizados e sem senha na resposta', async ({ request }) => {
    const local = uid('Maria');
    const res = await request.post('/users', {
      data: { name: '  Maria Teste  ', email: `  ${local.toUpperCase()}@E2E.Test  `, password: STRONG_PASSWORD, phone: '21987654321' },
    });
    expect(res.status(), await res.text()).toBe(201);
    const user = await res.json();

    expect(user).toMatchObject({
      name: 'Maria Teste',
      email: `${local.toLowerCase()}@e2e.test`,
      phone: '21987654321',
      role: 'CLIENT',
      store_id: null,
      platform_role: null,
      store: null,
    });
    expect(typeof user.id).toBe('number');
    expectNoSecrets(user, 'resposta do cadastro');

    const loginRes = await request.post('/auth/login', { data: { email: user.email, password: STRONG_PASSWORD } });
    expect(loginRes.ok(), await loginRes.text()).toBeTruthy();
  });

  test('telefone vazio é aceito e tratado como não informado', async ({ request }) => {
    const res = await request.post('/users', { data: signupPayload({ phone: '' }) });
    expect(res.status(), await res.text()).toBe(201);
    const user = await res.json();
    expect(user.role).toBe('CLIENT');
    expect(user.phone ?? null).toBeNull();
  });

  test('telefone ausente é aceito', async ({ request }) => {
    const data = signupPayload();
    delete data.phone;
    const res = await request.post('/users', { data });
    expect(res.status(), await res.text()).toBe(201);
    expect((await res.json()).phone ?? null).toBeNull();
  });

  test('perfil CLIENT enviado explicitamente é aceito no cadastro público', async ({ request }) => {
    const res = await request.post('/users', { data: signupPayload({ role: 'CLIENT' }) });
    expect(res.status(), await res.text()).toBe(201);
    expect((await res.json()).role).toBe('CLIENT');
  });

  test('perfil vazio (como formulários enviam) é tratado como CLIENT', async ({ request }) => {
    const res = await request.post('/users', { data: signupPayload({ role: '' }) });
    expect(res.status(), await res.text()).toBe(201);
    expect((await res.json()).role).toBe('CLIENT');
  });

  for (const role of ['ADMIN', 'EMPLOYEE', 'KITCHEN', 'COURIER'] as const) {
    test(`cadastro anônimo com perfil ${role} → 403 e nenhuma conta é criada`, async ({ request }) => {
      const data = signupPayload({ role });
      await expectError(await request.post('/users', { data }), 403);

      // O e-mail continua livre: a tentativa não criou conta
      const login = await request.post('/auth/login', { data: { email: data.email, password: data.password } });
      expect(login.status()).toBe(401);
      const retry = await request.post('/users', { data: { ...data, role: undefined } });
      expect(retry.status(), await retry.text()).toBe(201);
      expect((await retry.json()).role).toBe('CLIENT');
    });
  }

  test('cliente logado não consegue cadastrar uma conta ADMIN (403)', async ({ request }) => {
    const client = await sessionOf(request, 'client');
    const res = await request.post('/users', { headers: bearer(client.token), data: signupPayload({ role: 'ADMIN' }) });
    await expectError(res, 403);
  });

  for (const actor of ['employee', 'kitchen', 'courier'] as const) {
    test(`${DEFAULT_USERS[actor].role} não cadastra contas da equipe (403)`, async ({ request }) => {
      const session = await sessionOf(request, actor);
      for (const role of ['KITCHEN', 'COURIER', 'EMPLOYEE', 'ADMIN']) {
        const res = await request.post('/users', { headers: bearer(session.token), data: signupPayload({ role }) });
        expect(res.status(), `${DEFAULT_USERS[actor].role} criando ${role}: ${await res.text()}`).toBe(403);
      }
    });
  }

  test('token inválido no cadastro é tratado como anônimo: perfil da equipe → 403', async ({ request }) => {
    const res = await request.post('/users', { headers: bearer('token-invalido'), data: signupPayload({ role: 'ADMIN' }) });
    await expectError(res, 403);
  });

  test('token inválido não impede o cadastro público de cliente (201)', async ({ request }) => {
    const res = await request.post('/users', { headers: bearer('token-invalido'), data: signupPayload() });
    expect(res.status(), await res.text()).toBe(201);
    expect((await res.json()).role).toBe('CLIENT');
  });

  test('token de um ADMIN já excluído não cadastra contas da equipe (403)', async ({ request }) => {
    const tempAdmin = await newUserWithRole(request, 'ADMIN');
    const admin = await sessionOf(request, 'admin');
    expect((await request.delete(`/users/${tempAdmin.user.id}`, { headers: bearer(admin.token) })).ok()).toBeTruthy();

    const res = await request.post('/users', { headers: bearer(tempAdmin.token), data: signupPayload({ role: 'ADMIN' }) });
    await expectError(res, 403);
  });

  for (const role of STAFF_ROLES) {
    test(`ADMIN cadastra uma conta ${role} na equipe da própria loja e ela entra com esse perfil`, async ({ request }) => {
      const store = await demoStore();
      const admin = await sessionOf(request, 'admin');
      const data = signupPayload({ name: `Conta ${role}`, email: uniqueEmail(`admin-cria-${role.toLowerCase()}`), role });
      const res = await request.post('/users', { headers: bearer(admin.token), data });
      expect(res.status(), await res.text()).toBe(201);
      const created = await res.json();
      trackStaff(created.id);
      expect(created).toMatchObject({ role, store_id: store.id, platform_role: null });
      expect(created.store).toMatchObject({ id: store.id, slug: store.slug });
      expectNoSecrets(created, `cadastro de ${role} pelo ADMIN`);

      const login = await request.post('/auth/login', { data: { email: data.email, password: data.password } });
      expect(login.ok(), await login.text()).toBeTruthy();
      expect((await login.json()).user).toMatchObject({ role, store_id: store.id });
    });
  }

  for (const [label, role] of [['perfil CLIENT', 'CLIENT'], ['sem perfil', undefined]] as const) {
    test(`ADMIN não cadastra clientes (${label} → 400): clientes se cadastram sozinhos e a equipe exige um perfil da equipe`, async ({ request }) => {
      const admin = await sessionOf(request, 'admin');
      const data = signupPayload({ email: uniqueEmail('admin-cliente'), ...(role ? { role } : {}) });
      await expectError(await request.post('/users', { headers: bearer(admin.token), data }), 400);
      const login = await request.post('/auth/login', { data: { email: data.email, password: data.password } });
      expect(login.status(), 'nenhuma conta foi criada').toBe(401);
    });
  }

  test('superadmin (conta da plataforma) não cadastra equipe de loja por esta rota (403)', async ({ request }) => {
    const superadmin = await sessionOf(request, 'superadmin');
    for (const role of STAFF_ROLES) {
      const res = await request.post('/users', { headers: bearer(superadmin.token), data: signupPayload({ role }) });
      expect(res.status(), `superadmin criando ${role}: ${await res.text()}`).toBe(403);
    }
  });

  test('ADMIN cadastra atendente (EMPLOYEE) via multipart, como o formulário do painel envia', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    const email = uniqueEmail('atendente-form');
    const res = await request.post('/users', {
      headers: bearer(admin.token),
      multipart: { name: 'Atendente Form', email, password: STRONG_PASSWORD, phone: '', role: 'EMPLOYEE' },
    });
    expect(res.status(), await res.text()).toBe(201);
    const created = await res.json();
    trackStaff(created.id);
    expect(created).toMatchObject({ email, role: 'EMPLOYEE' });
    expect(created.phone ?? null).toBeNull();
  });
});

test.describe('E-mail único (409)', () => {
  test('e-mail já cadastrado → 409 "E-mail já cadastrado"', async ({ request }) => {
    const client = await newClient(request);
    const res = await request.post('/users', { data: signupPayload({ email: client.email }) });
    await expectError(res, 409, /E-mail já cadastrado/);
  });

  test('e-mail de um usuário padrão não pode ser reutilizado (409)', async ({ request }) => {
    const res = await request.post('/users', { data: signupPayload({ email: DEFAULT_USERS.admin.email }) });
    await expectError(res, 409, /E-mail já cadastrado/);
  });

  test('o mesmo e-mail com outra caixa → 409', async ({ request }) => {
    const client = await newClient(request);
    const res = await request.post('/users', { data: signupPayload({ email: client.email.toUpperCase() }) });
    await expectError(res, 409, /E-mail já cadastrado/);
  });

  test('o mesmo e-mail com espaços nas pontas → 409', async ({ request }) => {
    const client = await newClient(request);
    const res = await request.post('/users', { data: signupPayload({ email: `  ${client.email}  ` }) });
    await expectError(res, 409, /E-mail já cadastrado/);
  });

  test('e-mail de uma conta na lixeira continua reservado → 409', async ({ request }) => {
    const client = await newClient(request);
    const del = await request.delete(`/users/${client.user.id}`, { headers: bearer(client.token) });
    expect(del.ok(), await del.text()).toBeTruthy();

    const res = await request.post('/users', { data: signupPayload({ email: client.email }) });
    await expectError(res, 409, /E-mail já cadastrado/);
    const mixed = await request.post('/users', { data: signupPayload({ email: client.email.toUpperCase() }) });
    await expectError(mixed, 409, /E-mail já cadastrado/);
  });

  test('cadastros simultâneos com o mesmo e-mail: um 201 e um 409, nunca 500', async ({ request }) => {
    const email = uniqueEmail('corrida');
    const [first, second] = await Promise.all([
      request.post('/users', { data: signupPayload({ email }) }),
      request.post('/users', { data: signupPayload({ email: email.toUpperCase() }) }),
    ]);
    const statuses = [first.status(), second.status()].sort();
    expect(statuses, `${await first.text()} / ${await second.text()}`).toEqual([201, 409]);
  });
});

test.describe('Política de senha', () => {
  const rejected: Array<[string, unknown]> = [
    ['com menos de 9 caracteres', 'Abc@1234'],
    ['sem letra maiúscula', 'senhafraca@123'],
    ['sem número nem símbolo', 'SenhaSemNumero'],
    ['vazia', ''],
    ['numérica (não texto)', 123456789],
  ];
  for (const [label, password] of rejected) {
    test(`senha ${label} → 400 e a conta não é criada`, async ({ request }) => {
      const data = signupPayload({ password });
      await expectError(await request.post('/users', { data }), 400);
      // e-mail continua livre
      const retry = await request.post('/users', { data: { ...data, password: STRONG_PASSWORD } });
      expect(retry.status(), await retry.text()).toBe(201);
    });
  }

  test('senha ausente → 400', async ({ request }) => {
    const data = signupPayload();
    delete data.password;
    await expectError(await request.post('/users', { data }), 400, /senha/i);
  });

  test('senha com 9+ caracteres, maiúscula e número é aceita e funciona no login', async ({ request }) => {
    const data = signupPayload({ password: 'Abcdefgh1' });
    const res = await request.post('/users', { data });
    expect(res.status(), await res.text()).toBe(201);
    const login = await request.post('/auth/login', { data: { email: data.email, password: 'Abcdefgh1' } });
    expect(login.ok()).toBeTruthy();
  });

  test('senha com maiúscula e símbolo (sem número) é aceita', async ({ request }) => {
    const res = await request.post('/users', { data: signupPayload({ password: 'Abcdefgh!' }) });
    expect(res.status(), await res.text()).toBe(201);
  });

  test('senha longa (> 72 bytes) não pode ser aceita por outra senha com o mesmo prefixo', async ({ request }) => {
    const prefix = `Prefixo1-${'x'.repeat(63)}`; // 72 caracteres ASCII
    expect(prefix.length).toBe(72);
    const data = signupPayload({ password: `${prefix}SegredoReal#1` });
    const res = await request.post('/users', { data });
    if (res.status() === 400) return; // recusar senhas além do limite do bcrypt também é correto
    expect(res.status(), await res.text()).toBe(201);

    const impostor = await request.post('/auth/login', { data: { email: data.email, password: `${prefix}OutraSenha#2` } });
    expect(impostor.status(), 'uma senha diferente (mesmos 72 primeiros bytes) não pode entrar').toBe(401);
  });
});

test.describe('Validação do cadastro', () => {
  const invalid: Array<[string, (data: Record<string, unknown>) => void]> = [
    ['nome ausente', (d) => delete d.name],
    ['nome só com espaços', (d) => (d.name = '    ')],
    ['nome com mais de 50 caracteres', (d) => (d.name = 'N'.repeat(51))],
    ['e-mail ausente', (d) => delete d.email],
    ['e-mail mal formatado', (d) => (d.email = 'sem-arroba.e2e.test')],
    ['telefone com menos de 10 dígitos', (d) => (d.phone = '219999')],
    ['telefone com mais de 20 caracteres', (d) => (d.phone = '2'.repeat(21))],
    ['perfil inexistente', (d) => (d.role = 'SUPERUSER')],
    ['avatar com mais de 500 caracteres', (d) => (d.avatar = `https://exemplo.com/${'a'.repeat(500)}.png`)],
    ['campo extra (isAdmin)', (d) => (d.isAdmin = true)],
    ['campo extra (password_hash)', (d) => (d.password_hash = 'hash-forjado')],
  ];
  for (const [label, mutate] of invalid) {
    test(`${label} → 400`, async ({ request }) => {
      const data = signupPayload();
      mutate(data);
      await expectError(await request.post('/users', { data }), 400);
    });
  }
});

test.describe('Foto de perfil no cadastro (multipart)', () => {
  test('cadastro com foto PNG salva o avatar otimizado (.webp) servido em /uploads', async ({ request }) => {
    const email = uniqueEmail('avatar');
    const res = await request.post('/users', {
      multipart: { name: 'Cliente Com Foto', email, password: STRONG_PASSWORD, phone: '', file: pngFile(makePng(32, 32)) },
    });
    expect(res.status(), await res.text()).toBe(201);
    const user = await res.json();
    expect(user.role).toBe('CLIENT');
    expect(user.avatar).toMatch(/^\/uploads\/[\w.-]+\.webp$/);
    expectNoSecrets(user, 'cadastro multipart');

    const image = await request.get(user.avatar);
    expect(image.status()).toBe(200);
    expect(image.headers()['content-type']).toContain('image/webp');
    expect(isWebp(await image.body())).toBeTruthy();
  });

  test('cadastro com arquivo que não é imagem → 400 e a conta não é criada', async ({ request }) => {
    const email = uniqueEmail('avatar-invalido');
    const res = await request.post('/users', {
      multipart: {
        name: 'Cliente Arquivo Errado',
        email,
        password: STRONG_PASSWORD,
        file: { name: 'foto.png', mimeType: 'image/png', buffer: Buffer.from('isto não é uma imagem') },
      },
    });
    await expectError(res, 400);

    const retry = await request.post('/users', { data: signupPayload({ email }) });
    expect(retry.status(), await retry.text()).toBe(201);
  });

  test('cadastro com foto acima de 5 MB → 400 (ou 413) e a conta não é criada', async ({ request }) => {
    const big = makePng(1500, 1200, { noise: true });
    expect(big.length).toBeGreaterThan(MAX_UPLOAD_BYTES);
    const email = uniqueEmail('avatar-grande');
    const res = await request.post('/users', {
      multipart: { name: 'Cliente Foto Grande', email, password: STRONG_PASSWORD, file: pngFile(big, 'grande.png') },
    });
    expect([400, 413], `status ${res.status()}: ${(await res.text()).slice(0, 200)}`).toContain(res.status());

    const retry = await request.post('/users', { data: signupPayload({ email }) });
    expect(retry.status(), await retry.text()).toBe(201);
  });

  test('cadastro recusado na validação não deixa a foto gravada em /uploads (arquivo órfão)', async ({ request }) => {
    const before = new Set(uploadedFiles());

    // Controle: um cadastro válido grava a foto com as dimensões enviadas (prova que o detector funciona)
    const ok = await request.post('/users', {
      multipart: { name: 'Controle Foto', email: uniqueEmail('orfao-ok'), password: STRONG_PASSWORD, file: pngFile(makePng(41, 59)) },
    });
    expect(ok.status(), await ok.text()).toBe(201);

    // Corpo inválido (senha fraca) com uma foto válida e de dimensões únicas
    const bad = await request.post('/users', {
      multipart: { name: 'Foto Órfã', email: uniqueEmail('orfao'), password: 'fraca', file: pngFile(makePng(37, 53)) },
    });
    expect(bad.status(), await bad.text()).toBe(400);

    await sleep(2_000); // dá tempo para a otimização em segundo plano terminar
    const sizes = newUploadSizes(before).map(({ width, height }) => `${width}x${height}`);
    expect(sizes, 'controle: a foto do cadastro válido foi gravada').toContain('41x59');
    expect(sizes, 'a foto de um cadastro recusado não pode ficar em /uploads').not.toContain('37x53');
  });

  test('multipart com perfil da equipe sem token → 403', async ({ request }) => {
    const res = await request.post('/users', {
      multipart: { name: 'Equipe Forjada', email: uniqueEmail('forjado'), password: STRONG_PASSWORD, role: 'ADMIN' },
    });
    const payload = await body(res);
    expect(res.status(), JSON.stringify(payload)).toBe(403);
  });
});

/** Entrada na equipe por convite: o ADMIN convida um e-mail para um perfil da equipe da PRÓPRIA loja. */
test.describe('Convite para a equipe (POST /store/invitations → /invitations/:token/accept)', () => {
  async function invite(request: import('@playwright/test').APIRequestContext, email: string, role = 'KITCHEN') {
    const admin = await sessionOf(request, 'admin');
    const res = await request.post('/store/invitations', { headers: bearer(admin.token), data: { email, role } });
    expect(res.status(), `convite: ${await res.text()}`).toBe(201);
    const created = await res.json();
    expect(created.url).toMatch(new RegExp(`^${E2E.webURL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/convite/[A-Za-z0-9_-]{32,128}$`));
    return { invitation: created.invitation, token: String(created.url).split('/').pop() as string };
  }

  test('o convite mostra a loja e o perfil; o aceite cria a conta da equipe da loja, já faz login e o link vale uma vez', async ({ request }) => {
    const store = await demoStore();
    const email = uniqueEmail('convite');
    const { invitation, token } = await invite(request, email, 'KITCHEN');
    expect(invitation).toMatchObject({ email, role: 'KITCHEN', status: 'PENDING', store_id: store.id });
    expect(Object.keys(invitation), 'o hash do token nunca sai').not.toContain('token_hash');

    const preview = await request.get(`/invitations/${token}`);
    expect(preview.status(), await preview.text()).toBe(200);
    const view = await preview.json();
    expect(view).toMatchObject({ store: { name: store.name, slug: store.slug }, role: 'KITCHEN' });
    expect(view.email_masked).not.toBe(email);

    const accepted = await request.post(`/invitations/${token}/accept`, { data: { name: 'Convidado E2E', password: STRONG_PASSWORD } });
    expect(accepted.status(), await accepted.text()).toBe(201);
    const session = await accepted.json();
    trackStaff(session.user.id);
    expect(Object.keys(session).sort()).toEqual(['access_token', 'user']);
    expect(session.user).toMatchObject({ email, role: 'KITCHEN', store_id: store.id, platform_role: null });
    expectNoSecrets(session, 'aceite do convite');
    expect((await request.get('/orders', { headers: bearer(session.access_token) })).status()).toBe(200);

    // Uso único: o link não vale de novo
    expect((await request.get(`/invitations/${token}`)).status()).toBe(404);
    const again = await request.post(`/invitations/${token}/accept`, { data: { name: 'De Novo', password: STRONG_PASSWORD } });
    expect(again.status()).toBe(404);

    const admin = await sessionOf(request, 'admin');
    const team = await (await request.get('/users', { headers: bearer(admin.token) })).json();
    expect(team.map((u: { email: string }) => u.email)).toContain(email);
  });

  test('só o ADMIN convida (equipe, cliente e superadmin → 403); perfil CLIENT → 400; e-mail que já tem conta → 409', async ({ request }) => {
    for (const key of ['employee', 'kitchen', 'courier', 'client', 'superadmin'] as const) {
      const session = await sessionOf(request, key);
      const res = await request.post('/store/invitations', {
        headers: bearer(session.token),
        data: { email: uniqueEmail('convite-negado'), role: 'EMPLOYEE' },
      });
      expect(res.status(), `${key}: ${await res.text()}`).toBe(403);
    }
    const admin = await sessionOf(request, 'admin');
    await expectError(
      await request.post('/store/invitations', { headers: bearer(admin.token), data: { email: uniqueEmail('convite-cliente'), role: 'CLIENT' } }),
      400,
    );
    await expectError(
      await request.post('/store/invitations', { headers: bearer(admin.token), data: { email: DEFAULT_USERS.client.email, role: 'EMPLOYEE' } }),
      409,
    );
  });

  test('convite revogado pelo ADMIN deixa de valer (404) e link inválido também é 404', async ({ request }) => {
    const { invitation, token } = await invite(request, uniqueEmail('convite-revogado'), 'COURIER');
    const admin = await sessionOf(request, 'admin');
    const revoked = await request.delete(`/store/invitations/${invitation.id}`, { headers: bearer(admin.token) });
    expect(revoked.status(), await revoked.text()).toBe(200);
    expect((await revoked.json()).status).toBe('REVOKED');

    await expectError(await request.get(`/invitations/${token}`), 404);
    await expectError(await request.post(`/invitations/${token}/accept`, { data: { name: 'Tarde Demais', password: STRONG_PASSWORD } }), 404);
    await expectError(await request.get(`/invitations/${'B'.repeat(43)}`), 404);
  });
});
