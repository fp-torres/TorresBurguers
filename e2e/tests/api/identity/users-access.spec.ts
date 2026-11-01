import { test, expect } from '@playwright/test';
import { DEFAULT_USERS } from '../../../support/users';
import {
  MISSING_ID,
  OUT_OF_RANGE_ID,
  STRONG_PASSWORD,
  bearer,
  body,
  expectError,
  expectNoSecrets,
  isWebp,
  makePng,
  newClient,
  newUploadSizes,
  newUserWithRole,
  pngFile,
  sessionOf,
  sleep,
  uniqueEmail,
  uploadedFiles,
  cleanupTrackedStaff,
  demoStore,
  platformAccount,
  trackStaff,
} from './helpers';

test.afterAll(cleanupTrackedStaff);

/** Um dos ícones prontos que a API aceita como avatar em texto (backend/src/users/avatar.ts). */
const AVATAR_ICON = 'https://cdn-icons-png.flaticon.com/512/3075/3075977.png';

test.describe('Equipe da loja (GET /users) — somente ADMIN', () => {
  test('ADMIN lista só a equipe da própria loja (inclui a equipe padrão; nunca clientes nem a plataforma), sem senha', async ({ request }) => {
    const store = await demoStore();
    const admin = await sessionOf(request, 'admin');
    const fresh = await newClient(request);
    const member = await newUserWithRole(request, 'KITCHEN');
    const res = await request.get('/users', { headers: bearer(admin.token) });
    expect(res.status()).toBe(200);
    const users = await res.json();
    expect(Array.isArray(users)).toBeTruthy();

    const emails = users.map((u: { email: string }) => u.email);
    for (const key of ['admin', 'kitchen', 'courier', 'employee'] as const) expect(emails).toContain(DEFAULT_USERS[key].email);
    expect(emails).toContain(member.email);
    for (const outsider of [DEFAULT_USERS.client.email, DEFAULT_USERS.superadmin.email, fresh.email]) {
      expect(emails, 'clientes e contas da plataforma não são equipe').not.toContain(outsider);
    }
    for (const user of users) {
      expect(user, `membro ${user.email}`).toMatchObject({ store_id: store.id, platform_role: null, deleted_at: null });
      expect(user.role).not.toBe('CLIENT');
    }
    expectNoSecrets(users, 'GET /users');
  });

  for (const role of ['CLIENT', 'EMPLOYEE', 'KITCHEN', 'COURIER'] as const) {
    test(`${role} não lista usuários (403)`, async ({ request }) => {
      const key = ({ CLIENT: 'client', EMPLOYEE: 'employee', KITCHEN: 'kitchen', COURIER: 'courier' } as const)[role];
      const session = await sessionOf(request, key);
      await expectError(await request.get('/users', { headers: bearer(session.token) }), 403);
    });
  }

  test('superadmin não usa a equipe de uma loja (403): as contas são geridas pelo superpainel', async ({ request }) => {
    const superadmin = await sessionOf(request, 'superadmin');
    await expectError(await request.get('/users', { headers: bearer(superadmin.token) }), 403);
    await expectError(await request.get('/users/trash', { headers: bearer(superadmin.token) }), 403);
  });
});

test.describe('Consulta de usuário (GET /users/:id) — próprio ou ADMIN', () => {
  test('cliente consulta o próprio cadastro (sem senha)', async ({ request }) => {
    const client = await newClient(request);
    const res = await request.get(`/users/${client.user.id}`, { headers: bearer(client.token) });
    expect(res.status()).toBe(200);
    const user = await res.json();
    expect(user).toMatchObject({ id: client.user.id, email: client.email, role: 'CLIENT' });
    expectNoSecrets(user, 'GET /users/:id (próprio)');
  });

  test('cliente não consulta outro cliente (403)', async ({ request }) => {
    const [a, b] = [await newClient(request), await newClient(request)];
    await expectError(await request.get(`/users/${b.user.id}`, { headers: bearer(a.token) }), 403);
  });

  test('cliente não consulta o cadastro do ADMIN (403)', async ({ request }) => {
    const client = await newClient(request);
    const admin = await sessionOf(request, 'admin');
    await expectError(await request.get(`/users/${admin.user.id}`, { headers: bearer(client.token) }), 403);
  });

  for (const key of ['employee', 'kitchen', 'courier'] as const) {
    test(`${DEFAULT_USERS[key].role} não consulta o cadastro de um cliente (403)`, async ({ request }) => {
      const client = await newClient(request);
      const staff = await sessionOf(request, key);
      await expectError(await request.get(`/users/${client.user.id}`, { headers: bearer(staff.token) }), 403);
    });
  }

  test('membro da equipe consulta o próprio cadastro', async ({ request }) => {
    const kitchen = await sessionOf(request, 'kitchen');
    const res = await request.get(`/users/${kitchen.user.id}`, { headers: bearer(kitchen.token) });
    expect(res.status()).toBe(200);
    expect((await res.json()).role).toBe('KITCHEN');
  });

  test('ADMIN consulta um membro da equipe da própria loja (sem senha)', async ({ request }) => {
    const store = await demoStore();
    const member = await newUserWithRole(request, 'COURIER');
    const admin = await sessionOf(request, 'admin');
    const res = await request.get(`/users/${member.user.id}`, { headers: bearer(admin.token) });
    expect(res.status()).toBe(200);
    const user = await res.json();
    expect(user).toMatchObject({ email: member.email, role: 'COURIER', store_id: store.id });
    expectNoSecrets(user, 'GET /users/:id (ADMIN)');
  });

  test('ADMIN não consulta clientes nem contas da plataforma (404 uniforme, igual a um id inexistente)', async ({ request }) => {
    const client = await newClient(request);
    const admin = await sessionOf(request, 'admin');
    const superadmin = await sessionOf(request, 'superadmin');
    const missing = await expectError(await request.get(`/users/${MISSING_ID}`, { headers: bearer(admin.token) }), 404);
    for (const id of [client.user.id, superadmin.user.id]) {
      const res = await expectError(await request.get(`/users/${id}`, { headers: bearer(admin.token) }), 404);
      expect(res.message, 'mesma resposta de uma conta inexistente').toBe(missing.message);
    }
  });

  test('ADMIN consultando id inexistente → 404', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    await expectError(await request.get(`/users/${MISSING_ID}`, { headers: bearer(admin.token) }), 404);
  });

  test('id não numérico → 400', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    await expectError(await request.get('/users/abc', { headers: bearer(admin.token) }), 400);
  });

  test('id fora do intervalo de inteiro nas rotas de usuário → 400/404, nunca 500', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    const headers = bearer(admin.token);
    const attempts: Array<[string, () => Promise<{ status(): number; text(): Promise<string> }>]> = [
      ['GET /users/:id', () => request.get(`/users/${OUT_OF_RANGE_ID}`, { headers })],
      ['PATCH /users/:id', () => request.patch(`/users/${OUT_OF_RANGE_ID}`, { headers, data: { name: 'X' } })],
      ['DELETE /users/:id', () => request.delete(`/users/${OUT_OF_RANGE_ID}`, { headers })],
      ['PATCH /users/:id/restore', () => request.patch(`/users/${OUT_OF_RANGE_ID}/restore`, { headers })],
      ['DELETE /users/:id/permanent', () => request.delete(`/users/${OUT_OF_RANGE_ID}/permanent`, { headers })],
    ];
    for (const [label, call] of attempts) {
      const res = await call();
      expect.soft([400, 404], `${label} com id ${OUT_OF_RANGE_ID}: ${res.status()} ${await res.text()}`).toContain(res.status());
    }
  });
});

test.describe('Edição de usuário (PATCH /users/:id)', () => {
  test('cliente edita o próprio nome e telefone e a mudança persiste', async ({ request }) => {
    const client = await newClient(request);
    const res = await request.patch(`/users/${client.user.id}`, {
      headers: bearer(client.token),
      data: { name: '  Nome Atualizado  ', phone: '21911112222' },
    });
    expect(res.status(), await res.text()).toBe(200);
    const updated = await res.json();
    expect(updated).toMatchObject({ name: 'Nome Atualizado', phone: '21911112222', role: 'CLIENT' });
    expectNoSecrets(updated, 'PATCH /users/:id');

    const again = await (await request.get(`/users/${client.user.id}`, { headers: bearer(client.token) })).json();
    expect(again).toMatchObject({ name: 'Nome Atualizado', phone: '21911112222' });
  });

  test('cliente não edita outro usuário (403) e nada muda', async ({ request }) => {
    const [attacker, victim] = [await newClient(request), await newClient(request, { name: 'Vítima Original' })];
    const res = await request.patch(`/users/${victim.user.id}`, {
      headers: bearer(attacker.token),
      data: { name: 'Invadido', email: uniqueEmail('roubo') },
    });
    await expectError(res, 403);

    const current = await (await request.get(`/users/${victim.user.id}`, { headers: bearer(victim.token) })).json();
    expect(current).toMatchObject({ name: 'Vítima Original', email: victim.email });
  });

  test('EMPLOYEE não edita o cadastro de um cliente (403)', async ({ request }) => {
    const client = await newClient(request);
    const employee = await sessionOf(request, 'employee');
    await expectError(
      await request.patch(`/users/${client.user.id}`, { headers: bearer(employee.token), data: { name: 'Alterado' } }),
      403,
    );
  });

  test('cliente não muda o próprio perfil para ADMIN (403) e continua CLIENT', async ({ request }) => {
    const client = await newClient(request);
    await expectError(
      await request.patch(`/users/${client.user.id}`, { headers: bearer(client.token), data: { role: 'ADMIN' } }),
      403,
    );
    const current = await (await request.get(`/users/${client.user.id}`, { headers: bearer(client.token) })).json();
    expect(current.role).toBe('CLIENT');
    expect((await request.get('/users', { headers: bearer(client.token) })).status()).toBe(403);
  });

  test('membro da equipe não muda o próprio perfil (KITCHEN → ADMIN/COURIER → 403)', async ({ request }) => {
    const kitchen = await newUserWithRole(request, 'KITCHEN');
    for (const role of ['ADMIN', 'COURIER', 'EMPLOYEE']) {
      const res = await request.patch(`/users/${kitchen.user.id}`, { headers: bearer(kitchen.token), data: { role } });
      expect(res.status(), `KITCHEN → ${role}: ${await res.text()}`).toBe(403);
    }
    const current = await (await request.get(`/users/${kitchen.user.id}`, { headers: bearer(kitchen.token) })).json();
    expect(current.role).toBe('KITCHEN');
  });

  test('reenviar o próprio perfil (sem mudança) junto com outros campos é aceito', async ({ request }) => {
    const client = await newClient(request);
    const res = await request.patch(`/users/${client.user.id}`, {
      headers: bearer(client.token),
      data: { role: 'CLIENT', name: 'Mesmo Perfil' },
    });
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toMatchObject({ role: 'CLIENT', name: 'Mesmo Perfil' });
  });

  test('ADMIN altera o perfil de um membro da equipe e o novo perfil vale no login', async ({ request }) => {
    const user = await newUserWithRole(request, 'KITCHEN');
    const admin = await sessionOf(request, 'admin');
    const res = await request.patch(`/users/${user.user.id}`, { headers: bearer(admin.token), data: { role: 'COURIER' } });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).role).toBe('COURIER');

    const login = await request.post('/auth/login', { data: { email: user.email, password: user.password } });
    expect((await login.json()).user.role).toBe('COURIER');
  });

  test('ADMIN não troca o perfil de um membro para CLIENT (400): a equipe não tem perfil de cliente', async ({ request }) => {
    const user = await newUserWithRole(request, 'EMPLOYEE');
    const admin = await sessionOf(request, 'admin');
    await expectError(
      await request.patch(`/users/${user.user.id}`, { headers: bearer(admin.token), data: { role: 'CLIENT' } }),
      400,
    );
    const login = await request.post('/auth/login', { data: { email: user.email, password: user.password } });
    expect((await login.json()).user.role).toBe('EMPLOYEE');
  });

  test('ADMIN edita nome e telefone de um membro da equipe', async ({ request }) => {
    const user = await newUserWithRole(request, 'COURIER');
    const admin = await sessionOf(request, 'admin');
    const res = await request.patch(`/users/${user.user.id}`, {
      headers: bearer(admin.token),
      data: { name: 'Editado pelo Admin', phone: '21933334444' },
    });
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'Editado pelo Admin', phone: '21933334444' });
  });

  test('ADMIN não edita clientes nem contas da plataforma (404) e nada muda', async ({ request }) => {
    const client = await newClient(request, { name: 'Cliente Intocado' });
    const admin = await sessionOf(request, 'admin');
    const superadmin = await sessionOf(request, 'superadmin');
    for (const data of [{ name: 'Editado pelo Admin' }, { role: 'EMPLOYEE' }, { email: uniqueEmail('sequestro') }, { password: 'Sequestro#2026' }]) {
      await expectError(await request.patch(`/users/${client.user.id}`, { headers: bearer(admin.token), data }), 404);
      await expectError(await request.patch(`/users/${superadmin.user.id}`, { headers: bearer(admin.token), data }), 404);
    }
    const current = await (await request.get(`/users/${client.user.id}`, { headers: bearer(client.token) })).json();
    expect(current).toMatchObject({ name: 'Cliente Intocado', email: client.email, role: 'CLIENT' });
    expect((await request.post('/auth/login', { data: { email: client.email, password: client.password } })).ok()).toBeTruthy();
  });

  test('perfil inexistente → 400', async ({ request }) => {
    const user = await newUserWithRole(request, 'KITCHEN');
    const admin = await sessionOf(request, 'admin');
    await expectError(
      await request.patch(`/users/${user.user.id}`, { headers: bearer(admin.token), data: { role: 'ROOT' } }),
      400,
    );
  });

  test('trocar para um e-mail já usado → 409 (inclusive com outra caixa)', async ({ request }) => {
    const [a, b] = [await newClient(request), await newClient(request)];
    await expectError(
      await request.patch(`/users/${a.user.id}`, { headers: bearer(a.token), data: { email: b.email } }),
      409,
      /E-mail já cadastrado/,
    );
    await expectError(
      await request.patch(`/users/${a.user.id}`, { headers: bearer(a.token), data: { email: b.email.toUpperCase() } }),
      409,
      /E-mail já cadastrado/,
    );
  });

  test('trocar para o e-mail de uma conta na lixeira → 409', async ({ request }) => {
    const [a, deleted] = [await newClient(request), await newClient(request)];
    expect((await request.delete(`/users/${deleted.user.id}`, { headers: bearer(deleted.token) })).ok()).toBeTruthy();
    await expectError(
      await request.patch(`/users/${a.user.id}`, { headers: bearer(a.token), data: { email: deleted.email } }),
      409,
      /E-mail já cadastrado/,
    );
  });

  test('trocar o próprio e-mail normaliza o valor e o login passa a usar o novo', async ({ request }) => {
    const client = await newClient(request);
    const next = uniqueEmail('novo-email');
    const res = await request.patch(`/users/${client.user.id}`, {
      headers: bearer(client.token),
      data: { email: `  ${next.toUpperCase()}  ` },
    });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).email).toBe(next);

    expect((await request.post('/auth/login', { data: { email: next, password: client.password } })).ok()).toBeTruthy();
    expect((await request.post('/auth/login', { data: { email: client.email, password: client.password } })).status()).toBe(401);
  });

  test('reenviar o próprio e-mail (outra caixa) não gera conflito', async ({ request }) => {
    const client = await newClient(request);
    const res = await request.patch(`/users/${client.user.id}`, {
      headers: bearer(client.token),
      data: { email: client.email.toUpperCase() },
    });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).email).toBe(client.email);
  });

  test('nova senha fora da política → 400 e a senha antiga continua valendo', async ({ request }) => {
    const client = await newClient(request);
    await expectError(
      await request.patch(`/users/${client.user.id}`, { headers: bearer(client.token), data: { password: 'fraca' } }),
      400,
    );
    expect((await request.post('/auth/login', { data: { email: client.email, password: client.password } })).ok()).toBeTruthy();
  });

  test('trocar a senha: a nova entra, a antiga não, e a resposta não traz hash', async ({ request }) => {
    const client = await newClient(request);
    const res = await request.patch(`/users/${client.user.id}`, {
      headers: bearer(client.token),
      data: { password: 'NovaSenha#2026' },
    });
    expect(res.status(), await res.text()).toBe(200);
    expectNoSecrets(await res.json(), 'PATCH com troca de senha');

    expect((await request.post('/auth/login', { data: { email: client.email, password: 'NovaSenha#2026' } })).ok()).toBeTruthy();
    expect((await request.post('/auth/login', { data: { email: client.email, password: client.password } })).status()).toBe(401);
  });

  test('campos desconhecidos no corpo → 400', async ({ request }) => {
    const client = await newClient(request);
    await expectError(
      await request.patch(`/users/${client.user.id}`, { headers: bearer(client.token), data: { name: 'X', isAdmin: true } }),
      400,
    );
    await expectError(
      await request.patch(`/users/${client.user.id}`, { headers: bearer(client.token), data: { password_hash: 'forjado' } }),
      400,
    );
  });

  test('ADMIN editando id inexistente → 404', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    await expectError(
      await request.patch(`/users/${MISSING_ID}`, { headers: bearer(admin.token), data: { name: 'Ninguém' } }),
      404,
    );
  });

  test('foto de perfil enviada via multipart é otimizada e servida', async ({ request }) => {
    const client = await newClient(request);
    const res = await request.patch(`/users/${client.user.id}`, {
      headers: bearer(client.token),
      multipart: { name: 'Com Foto Nova', file: pngFile(makePng(24, 24)) },
    });
    expect(res.status(), await res.text()).toBe(200);
    const updated = await res.json();
    expect(updated.name).toBe('Com Foto Nova');
    expect(updated.avatar).toMatch(/^\/uploads\/[\w.-]+\.webp$/);
    const image = await request.get(updated.avatar);
    expect(image.status()).toBe(200);
    expect(isWebp(await image.body())).toBeTruthy();
  });

  test('edição recusada na validação não deixa a foto gravada em /uploads (arquivo órfão)', async ({ request }) => {
    const client = await newClient(request);
    const before = new Set(uploadedFiles());

    const ok = await request.patch(`/users/${client.user.id}`, {
      headers: bearer(client.token),
      multipart: { name: 'Controle Foto', file: pngFile(makePng(47, 67)) },
    });
    expect(ok.status(), await ok.text()).toBe(200);

    const bad = await request.patch(`/users/${client.user.id}`, {
      headers: bearer(client.token),
      multipart: { phone: '123', file: pngFile(makePng(43, 61)) },
    });
    expect(bad.status(), await bad.text()).toBe(400);

    await sleep(2_000);
    const sizes = newUploadSizes(before).map(({ width, height }) => `${width}x${height}`);
    expect(sizes, 'controle: a foto da edição válida foi gravada').toContain('47x67');
    expect(sizes, 'a foto de uma edição recusada não pode ficar em /uploads').not.toContain('43x61');
  });

  test('foto inválida via multipart → 400 e o avatar não muda', async ({ request }) => {
    const client = await newClient(request, { avatar: AVATAR_ICON });
    const res = await request.patch(`/users/${client.user.id}`, {
      headers: bearer(client.token),
      multipart: { file: { name: 'foto.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('texto qualquer') } },
    });
    await expectError(res, 400);
    const current = await (await request.get(`/users/${client.user.id}`, { headers: bearer(client.token) })).json();
    expect(current.avatar).toBe(AVATAR_ICON);
  });

  test('avatar em texto: URL externa, caminho ou arquivo de outro dono → 400 (cadastro e edição); ícone pronto é aceito', async ({ request }) => {
    const refused = /Foto inválida: envie a imagem no campo "file" ou escolha um dos ícones disponíveis\./;
    await expectError(
      await request.post('/users', { data: { name: 'Pixel', email: uniqueEmail('pixel'), password: STRONG_PASSWORD, avatar: 'https://atacante.example/p.gif?u=1' } }),
      400,
      refused,
    );
    const client = await newClient(request);
    for (const avatar of ['https://atacante.example/p.gif?u=123', 'http://atacante.example/p.gif', '/uploads/s1-compressed-1-aaaa.webp', 'data:image/png;base64,AAAA']) {
      await expectError(
        await request.patch(`/users/${client.user.id}`, { headers: bearer(client.token), data: { avatar } }),
        400,
        refused,
      );
    }
    const ok = await request.patch(`/users/${client.user.id}`, { headers: bearer(client.token), data: { avatar: AVATAR_ICON } });
    expect(ok.status(), await ok.text()).toBe(200);
    expect((await ok.json()).avatar).toBe(AVATAR_ICON);
  });

  test('trocar a foto apaga o arquivo anterior da própria conta (nome com o dono: u<id>-)', async ({ request }) => {
    const client = await newClient(request);
    const send = async () => {
      const res = await request.patch(`/users/${client.user.id}`, {
        headers: bearer(client.token),
        multipart: { file: pngFile(makePng(20, 20, { noise: true })) },
      });
      expect(res.status(), await res.text()).toBe(200);
      return (await res.json()).avatar as string;
    };
    const first = await send();
    expect(first).toMatch(new RegExp(`^/uploads/u${client.user.id}-compressed-[\\w.-]+\\.webp$`));
    expect(uploadedFiles()).toContain(first.replace('/uploads/', ''));
    const second = await send();
    expect(second).not.toBe(first);
    expect(uploadedFiles()).toContain(second.replace('/uploads/', ''));
    expect(uploadedFiles(), 'a foto substituída da própria conta é apagada').not.toContain(first.replace('/uploads/', ''));
    expect((await request.get(first)).status()).toBe(404);
  });
});

test.describe('Exclusão de usuário (DELETE /users/:id)', () => {
  test('cliente exclui a própria conta: vai para a lixeira da plataforma (não para a equipe da loja)', async ({ request }) => {
    const client = await newClient(request);
    const res = await request.delete(`/users/${client.user.id}`, { headers: bearer(client.token) });
    expect(res.status(), await res.text()).toBe(200);
    await expectError(await request.get('/addresses', { headers: bearer(client.token) }), 401);

    // O ADMIN da loja não enxerga clientes (nem ativos nem na lixeira)
    const admin = await sessionOf(request, 'admin');
    await expectError(await request.get(`/users/${client.user.id}`, { headers: bearer(admin.token) }), 404);
    const active = await (await request.get('/users', { headers: bearer(admin.token) })).json();
    expect(active.map((u: { id: number }) => u.id)).not.toContain(client.user.id);
    const trash = await (await request.get('/users/trash', { headers: bearer(admin.token) })).json();
    expect(trash.map((u: { id: number }) => u.id)).not.toContain(client.user.id);

    // O superpainel mostra a conta na lixeira
    const account = await platformAccount(request, client.user.id);
    expect(account).toMatchObject({ id: client.user.id, email: client.email, role: 'CLIENT' });
    expect(account.deleted_at).toBeTruthy();
  });

  test('cliente não exclui outro usuário (403) e o outro continua ativo', async ({ request }) => {
    const [attacker, victim] = [await newClient(request), await newClient(request)];
    await expectError(await request.delete(`/users/${victim.user.id}`, { headers: bearer(attacker.token) }), 403);
    expect((await request.get(`/users/${victim.user.id}`, { headers: bearer(victim.token) })).status()).toBe(200);
  });

  for (const key of ['employee', 'kitchen', 'courier'] as const) {
    test(`${DEFAULT_USERS[key].role} não exclui o cadastro de um cliente (403)`, async ({ request }) => {
      const client = await newClient(request);
      const staff = await sessionOf(request, key);
      await expectError(await request.delete(`/users/${client.user.id}`, { headers: bearer(staff.token) }), 403);
      expect((await request.get(`/users/${client.user.id}`, { headers: bearer(client.token) })).status()).toBe(200);
    });
  }

  test('membro da equipe pode excluir a própria conta', async ({ request }) => {
    const courier = await newUserWithRole(request, 'COURIER');
    const res = await request.delete(`/users/${courier.user.id}`, { headers: bearer(courier.token) });
    expect(res.status(), await res.text()).toBe(200);
    await expectError(await request.get('/orders', { headers: bearer(courier.token) }), 401);
  });

  test('ADMIN exclui (logicamente) um membro da equipe', async ({ request }) => {
    const member = await newUserWithRole(request, 'EMPLOYEE');
    const admin = await sessionOf(request, 'admin');
    const res = await request.delete(`/users/${member.user.id}`, { headers: bearer(admin.token) });
    expect(res.status(), await res.text()).toBe(200);
    await expectError(await request.get('/addresses', { headers: bearer(member.token) }), 401);
  });

  test('ADMIN não exclui clientes nem contas da plataforma (404) e elas continuam ativas', async ({ request }) => {
    const client = await newClient(request);
    const admin = await sessionOf(request, 'admin');
    const superadmin = await sessionOf(request, 'superadmin');
    await expectError(await request.delete(`/users/${client.user.id}`, { headers: bearer(admin.token) }), 404);
    await expectError(await request.delete(`/users/${superadmin.user.id}`, { headers: bearer(admin.token) }), 404);
    expect((await request.get('/addresses', { headers: bearer(client.token) })).status()).toBe(200);
    expect((await request.get('/auth/me', { headers: bearer(superadmin.token) })).status()).toBe(200);
  });

  test('ADMIN não exclui a própria conta (400) e continua ativo', async ({ request }) => {
    const tempAdmin = await newUserWithRole(request, 'ADMIN');
    await expectError(await request.delete(`/users/${tempAdmin.user.id}`, { headers: bearer(tempAdmin.token) }), 400);
    expect((await request.get('/users', { headers: bearer(tempAdmin.token) })).status()).toBe(200);
  });

  test('ADMIN excluindo id inexistente → 404', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    await expectError(await request.delete(`/users/${MISSING_ID}`, { headers: bearer(admin.token) }), 404);
  });

  test('excluir a mesma conta duas vezes → 404 na segunda', async ({ request }) => {
    const member = await newUserWithRole(request, 'KITCHEN');
    const admin = await sessionOf(request, 'admin');
    expect((await request.delete(`/users/${member.user.id}`, { headers: bearer(admin.token) })).status()).toBe(200);
    await expectError(await request.delete(`/users/${member.user.id}`, { headers: bearer(admin.token) }), 404);
  });

  test('id não numérico → 400', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    const res = await request.delete('/users/abc', { headers: bearer(admin.token) });
    const payload = await body(res);
    expect(res.status(), JSON.stringify(payload)).toBe(400);
  });
});

test.describe('Senha nunca exposta em usuários criados pelo ADMIN', () => {
  test('cadastro de equipe com STRONG_PASSWORD não devolve a senha', async ({ request }) => {
    const admin = await sessionOf(request, 'admin');
    const res = await request.post('/users', {
      headers: bearer(admin.token),
      data: { name: 'Sem Senha', email: uniqueEmail('sem-senha'), password: STRONG_PASSWORD, role: 'EMPLOYEE' },
    });
    expect(res.status()).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(STRONG_PASSWORD);
    const created = JSON.parse(text);
    trackStaff(created.id);
    expectNoSecrets(created, 'cadastro pelo ADMIN');
  });
});
