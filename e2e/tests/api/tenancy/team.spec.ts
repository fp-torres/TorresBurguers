import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { loginAs } from '../../../support/api';
import {
  Cleanup,
  MISSING_ID,
  MSG,
  PASSWORD,
  acceptInvitation,
  addMember,
  bearer,
  buildTeam,
  createStore,
  demoStore,
  demoTeam,
  expectAllFromStore,
  expectError,
  expectNoneOf,
  expectStatus,
  expectUniform404,
  getJson,
  ids,
  invitationToken,
  newApi,
  retireStore,
  uniqueEmail,
  type Json,
  type Member,
  type PublicStore,
  type Session,
  type StaffRole,
  type Team,
  type TenantStore,
} from './helpers';

/**
 * Seção 16 do pedido — "Um funcionário não consegue administrar usuários de outra loja":
 * listar, ver, editar, trocar o perfil, excluir, restaurar, apagar de vez, convidar e bloquear.
 * ADMIN de outra loja → 404 uniforme; demais perfis → 403 (a resposta não depende do alvo).
 */
test.describe('Isolamento entre lojas: equipe, perfis e convites', () => {
  const cleanup = new Cleanup();
  let api: APIRequestContext;
  let superadmin: Session;
  let demo: PublicStore;
  let teamA: Team;
  let storeB: TenantStore;
  let teamB: Team;

  let bTarget: Member;
  let bTrashed: Member;
  let bInvite: { id: number; url: string; email: string };
  let aTarget: Member;
  let aTrashed: Member;
  let aInvite: { id: number; url: string };

  const membersB = () => [teamB.ADMIN, teamB.EMPLOYEE, teamB.KITCHEN, teamB.COURIER, bTarget];

  test.beforeAll(async () => {
    api = await newApi();
    superadmin = await loginAs(api, 'superadmin');
    demo = await demoStore();
    teamA = await demoTeam(api);

    storeB = await createStore(api, superadmin, 'Equipe');
    cleanup.add('desativar a loja B', () => retireStore(api, superadmin, storeB));
    teamB = await buildTeam(api, storeB);
    bTarget = await addMember(api, teamB.ADMIN, 'EMPLOYEE', 'Alvo B');
    bTrashed = await addMember(api, teamB.ADMIN, 'COURIER', 'Lixeira B');
    await expectStatus(await api.delete(`/users/${bTrashed.user.id}`, { headers: bearer(teamB.ADMIN.token) }), 200, 'lixeira da equipe de B');
    const email = uniqueEmail('tn-convite-b');
    const invite = await expectStatus(
      await api.post('/store/invitations', { headers: bearer(teamB.ADMIN.token), data: { email, role: 'KITCHEN' } }),
      201,
      'convite pendente de B',
    );
    bInvite = { id: invite.invitation.id, url: invite.url, email };

    // Loja A: alvos próprios do teste (nunca os usuários padrão nas tentativas de escrita)
    aTarget = await addMember(api, teamA.ADMIN, 'EMPLOYEE', 'Alvo A');
    cleanup.add('lixeira do alvo de A', () => api.delete(`/users/${aTarget.user.id}`, { headers: bearer(teamA.ADMIN.token) }));
    aTrashed = await addMember(api, teamA.ADMIN, 'KITCHEN', 'Lixeira A');
    await expectStatus(await api.delete(`/users/${aTrashed.user.id}`, { headers: bearer(teamA.ADMIN.token) }), 200, 'lixeira da equipe de A');
    cleanup.add('exclusão definitiva do membro de A na lixeira', () =>
      api.delete(`/users/${aTrashed.user.id}/permanent`, { headers: bearer(teamA.ADMIN.token) }),
    );
    const aCreated = await expectStatus(
      await api.post('/store/invitations', {
        headers: bearer(teamA.ADMIN.token),
        data: { email: uniqueEmail('tn-convite-a'), role: 'EMPLOYEE' },
      }),
      201,
      'convite pendente de A',
    );
    aInvite = { id: aCreated.invitation.id, url: aCreated.url };
    cleanup.add('revogar o convite de A', () =>
      api.delete(`/store/invitations/${aInvite.id}`, { headers: bearer(teamA.ADMIN.token) }),
    );
  });

  test.afterAll(async () => {
    await cleanup.run();
    await api.dispose();
  });

  test('cada ADMIN lista só a equipe e a lixeira da própria loja', async () => {
    const teamListA: Json[] = await getJson(api, '/users', teamA.ADMIN.token, 'equipe de A');
    expectAllFromStore(teamListA, demo.id, 'equipe de A');
    expectNoneOf(teamListA, [...membersB(), bTrashed].map((m) => m.user.id), 'equipe de A');

    const teamListB: Json[] = await getJson(api, '/users', teamB.ADMIN.token, 'equipe de B');
    expect(ids(teamListB), 'equipe de B: exatamente os membros de B').toEqual(ids(membersB().map((m) => ({ id: m.user.id }))));
    expectAllFromStore(teamListB, storeB.id, 'equipe de B');

    const trashA: Json[] = await getJson(api, '/users/trash', teamA.ADMIN.token, 'lixeira de A');
    expectNoneOf(trashA, [bTrashed.user.id], 'lixeira de A');
    expect(trashA.some((u) => u.id === aTrashed.user.id)).toBe(true);
    const trashB: Json[] = await getJson(api, '/users/trash', teamB.ADMIN.token, 'lixeira de B');
    expect(ids(trashB), 'lixeira de B').toEqual([bTrashed.user.id]);

    // Superpainel: a equipe de B (com a lixeira) é só de B
    const platformTeam = await getJson(api, `/platform/stores/${storeB.id}/users?pageSize=100`, superadmin.token);
    expect(ids(platformTeam.items)).toEqual(ids([...membersB(), bTrashed].map((m) => ({ id: m.user.id }))));
  });

  test('ADMIN de uma loja não vê, edita, troca o perfil, exclui, restaura nem apaga de vez a equipe da outra (404 uniforme)', async () => {
    type Op = [string, (token: string, id: number) => Promise<APIResponse>];
    const onMember: Op[] = [
      ['GET /users/:id', (token, id) => api.get(`/users/${id}`, { headers: bearer(token) })],
      ['PATCH /users/:id (nome)', (token, id) => api.patch(`/users/${id}`, { headers: bearer(token), data: { name: 'Invadido' } })],
      ['PATCH /users/:id (perfil ADMIN)', (token, id) => api.patch(`/users/${id}`, { headers: bearer(token), data: { role: 'ADMIN' } })],
      ['PATCH /users/:id (senha)', (token, id) => api.patch(`/users/${id}`, { headers: bearer(token), data: { password: 'Invasao@12345' } })],
      ['DELETE /users/:id', (token, id) => api.delete(`/users/${id}`, { headers: bearer(token) })],
    ];
    const onTrashed: Op[] = [
      ['PATCH /users/:id/restore', (token, id) => api.patch(`/users/${id}/restore`, { headers: bearer(token) })],
      ['DELETE /users/:id/permanent', (token, id) => api.delete(`/users/${id}/permanent`, { headers: bearer(token) })],
    ];

    const cases: Array<[string, Session, Session[], Session]> = [
      ['ADMIN de A → equipe de B', teamA.ADMIN, membersB(), bTrashed],
      ['ADMIN de B → equipe de A', teamB.ADMIN, [aTarget], aTrashed],
    ];
    for (const [label, actor, targets, trashed] of cases) {
      for (const target of targets) {
        for (const [op, call] of onMember) {
          await expectUniform404(
            await call(actor.token, target.user.id),
            await call(actor.token, MISSING_ID),
            MSG.userNotFound,
            `${label}: ${op} (#${target.user.id})`,
          );
        }
      }
      for (const [op, call] of onTrashed) {
        await expectUniform404(
          await call(actor.token, trashed.user.id),
          await call(actor.token, MISSING_ID),
          MSG.userNotFound,
          `${label}: ${op} (#${trashed.user.id} na lixeira)`,
        );
      }
    }
    // Leitura do ADMIN padrão de A pelo ADMIN de B também é 404
    await expectError(await api.get(`/users/${teamA.ADMIN.user.id}`, { headers: bearer(teamB.ADMIN.token) }), 404, MSG.userNotFound);

    // Nada mudou: nomes, perfis e sessões continuam; quem estava na lixeira continua lá
    const target = await getJson(api, `/users/${bTarget.user.id}`, teamB.ADMIN.token);
    expect(target).toMatchObject({ id: bTarget.user.id, name: bTarget.user.name, role: 'EMPLOYEE', store_id: storeB.id });
    const me = await getJson(api, '/auth/me', bTarget.token, 'sessão do alvo de B continua válida');
    expect(me.role).toBe('EMPLOYEE');
    const meA = await getJson(api, '/auth/me', aTarget.token, 'sessão do alvo de A continua válida');
    expect(meA).toMatchObject({ role: 'EMPLOYEE', store_id: demo.id, name: aTarget.user.name });
    expect(ids(await getJson(api, '/users/trash', teamB.ADMIN.token))).toEqual([bTrashed.user.id]);
    expect((await getJson(api, '/users/trash', teamA.ADMIN.token)).some((u: Json) => u.id === aTrashed.user.id)).toBe(true);
  });

  test('atendente, cozinha e entregador de uma loja não administram usuários de nenhuma loja (403, igual para qualquer alvo)', async () => {
    const nonAdmins = (team: Team) =>
      (Object.entries(team) as Array<[StaffRole, Session]>).filter(([role]) => role !== 'ADMIN');
    const cases: Array<[string, Team, number, number, number]> = [
      ['de A → B', teamA, bTarget.user.id, bTrashed.user.id, bInvite.id],
      ['de B → A', teamB, aTarget.user.id, aTrashed.user.id, aInvite.id],
    ];
    for (const [direction, team, targetId, trashedId, inviteId] of cases) {
      for (const [role, session] of nonAdmins(team)) {
        const headers = bearer(session.token);
        const label = `${role} ${direction}`;
        // A resposta é a mesma para o alvo da outra loja e para um id inexistente (nada é revelado)
        const sameForAnyTarget = async (op: string, call: (id: number) => Promise<APIResponse>, message: string, id: number) => {
          const foreign = await expectError(await call(id), 403, message, `${label}: ${op}`);
          const missing = await expectError(await call(MISSING_ID), 403, message, `${label}: ${op} (inexistente)`);
          expect(foreign).toEqual(missing);
        };
        await sameForAnyTarget('GET /users/:id', (id) => api.get(`/users/${id}`, { headers }), MSG.noUserPermission, targetId);
        await sameForAnyTarget('PATCH /users/:id', (id) => api.patch(`/users/${id}`, { headers, data: { name: 'Invadido' } }), MSG.noUserPermission, targetId);
        await sameForAnyTarget('PATCH /users/:id (perfil)', (id) => api.patch(`/users/${id}`, { headers, data: { role: 'ADMIN' } }), MSG.noUserPermission, targetId);
        await sameForAnyTarget('DELETE /users/:id', (id) => api.delete(`/users/${id}`, { headers }), 'Você não tem permissão para excluir este usuário.', targetId);
        await sameForAnyTarget('PATCH /users/:id/restore', (id) => api.patch(`/users/${id}/restore`, { headers }), MSG.noPermission, trashedId);
        await sameForAnyTarget('DELETE /users/:id/permanent', (id) => api.delete(`/users/${id}/permanent`, { headers }), MSG.noPermission, trashedId);
        await sameForAnyTarget('DELETE /store/invitations/:id', (id) => api.delete(`/store/invitations/${id}`, { headers }), MSG.noPermission, inviteId);
        await expectError(await api.get('/users', { headers }), 403, MSG.noPermission, `${label}: GET /users`);
        await expectError(await api.get('/users/trash', { headers }), 403, MSG.noPermission, `${label}: GET /users/trash`);
        await expectError(await api.get('/store/invitations', { headers }), 403, MSG.noPermission, `${label}: GET /store/invitations`);
        await expectError(
          await api.post('/store/invitations', { headers, data: { email: uniqueEmail('tn-x'), role: 'ADMIN' } }),
          403,
          MSG.noPermission,
          `${label}: POST /store/invitations`,
        );
        await expectError(
          await api.post('/users', { headers, data: { name: 'Intruso', email: uniqueEmail('tn-x'), password: PASSWORD, role: 'ADMIN' } }),
          403,
          'Somente administradores podem cadastrar contas da equipe.',
          `${label}: POST /users com perfil`,
        );
      }
    }
    const target = await getJson(api, `/users/${bTarget.user.id}`, teamB.ADMIN.token);
    expect(target).toMatchObject({ name: bTarget.user.name, role: 'EMPLOYEE' });
  });

  test('convites: cada ADMIN lista e revoga só os da própria loja; o convite de B cria a conta em B com o perfil do convite', async () => {
    const listA = await getJson(api, '/store/invitations?pageSize=100', teamA.ADMIN.token, 'convites de A');
    expectAllFromStore(listA.items, demo.id, 'convites de A');
    expectNoneOf(listA.items, [bInvite.id], 'convites de A');
    const listB = await getJson(api, '/store/invitations?pageSize=100', teamB.ADMIN.token, 'convites de B');
    expectAllFromStore(listB.items, storeB.id, 'convites de B');
    expectNoneOf(listB.items, [aInvite.id], 'convites de B');
    expect(listB.items.find((i: Json) => i.id === bInvite.id)).toMatchObject({ status: 'PENDING', role: 'KITCHEN' });

    await expectUniform404(
      await api.delete(`/store/invitations/${bInvite.id}`, { headers: bearer(teamA.ADMIN.token) }),
      await api.delete(`/store/invitations/${MISSING_ID}`, { headers: bearer(teamA.ADMIN.token) }),
      MSG.invitationNotFound,
      'ADMIN de A revoga convite de B',
    );
    await expectUniform404(
      await api.delete(`/store/invitations/${aInvite.id}`, { headers: bearer(teamB.ADMIN.token) }),
      await api.delete(`/store/invitations/${MISSING_ID}`, { headers: bearer(teamB.ADMIN.token) }),
      MSG.invitationNotFound,
      'ADMIN de B revoga convite de A',
    );

    // Quem aceita não escolhe loja nem perfil: campos extras → 400 (o convite continua valendo)
    const token = invitationToken(bInvite.url);
    await expectError(
      await api.post(`/invitations/${token}/accept`, { data: { name: 'Convidado', password: PASSWORD, store_id: demo.id } }),
      400,
      MSG.notAllowed('store_id'),
    );
    await expectError(
      await api.post(`/invitations/${token}/accept`, { data: { name: 'Convidado', password: PASSWORD, role: 'ADMIN' } }),
      400,
      MSG.notAllowed('role'),
    );
    const preview = await getJson(api, `/invitations/${token}`);
    expect(preview.store).toMatchObject({ slug: storeB.slug, name: storeB.name });
    expect(preview.role).toBe('KITCHEN');

    const { session } = await acceptInvitation(api, bInvite.url, 'Cozinha Convidada B');
    expect(session.user).toMatchObject({ role: 'KITCHEN', store_id: storeB.id, email: bInvite.email });
    expect(session.user.store).toMatchObject({ id: storeB.id, slug: storeB.slug });
    const teamListB: Json[] = await getJson(api, '/users', teamB.ADMIN.token);
    expect(teamListB.some((u) => u.id === session.user.id)).toBe(true);
    const teamListA: Json[] = await getJson(api, '/users', teamA.ADMIN.token);
    expect(teamListA.some((u) => u.id === session.user.id)).toBe(false);
    const accepted = await getJson(api, '/store/invitations?pageSize=100', teamB.ADMIN.token);
    expect(accepted.items.find((i: Json) => i.id === bInvite.id)).toMatchObject({ status: 'ACCEPTED', accepted_user_id: session.user.id });
    const stillPending = await getJson(api, '/store/invitations?pageSize=100', teamA.ADMIN.token);
    expect(stillPending.items.find((i: Json) => i.id === aInvite.id)?.status, 'convite de A intacto').toBe('PENDING');
  });

  test('bloqueio, encerramento de sessões e redefinição de senha são do superpainel: equipe de qualquer loja → 403', async () => {
    const attempts: Array<[string, Session, number]> = [
      ['ADMIN de A → alvo de B', teamA.ADMIN, bTarget.user.id],
      ['ADMIN de B → alvo de A', teamB.ADMIN, aTarget.user.id],
      ['ATENDENTE de B → alvo de A', teamB.EMPLOYEE, aTarget.user.id],
    ];
    for (const [label, actor, targetId] of attempts) {
      const headers = bearer(actor.token);
      await expectError(await api.post(`/platform/users/${targetId}/block`, { headers, data: { reason: 'Tentativa de outra loja' } }), 403, MSG.platformOnly, `${label}: block`);
      await expectError(await api.post(`/platform/users/${targetId}/revoke-sessions`, { headers }), 403, MSG.platformOnly, `${label}: revoke-sessions`);
      await expectError(await api.post(`/platform/users/${targetId}/password-reset`, { headers }), 403, MSG.platformOnly, `${label}: password-reset`);
      await expectError(await api.get(`/platform/users/${targetId}`, { headers }), 403, MSG.platformOnly, `${label}: GET /platform/users/:id`);
      await expectError(await api.get(`/platform/stores/${storeB.id}/users`, { headers }), 403, MSG.platformOnly, `${label}: equipe pelo superpainel`);
    }
    // As contas continuam ativas, sem bloqueio e com as sessões abertas
    expect((await getJson(api, '/auth/me', bTarget.token)).id).toBe(bTarget.user.id);
    expect((await getJson(api, '/auth/me', aTarget.token)).id).toBe(aTarget.user.id);
  });

  test('o ADMIN cria a equipe sempre na própria loja: store_id/storeId no corpo → 400', async () => {
    const data = { name: 'Atendente Extra', email: uniqueEmail('tn-extra'), password: PASSWORD, role: 'EMPLOYEE' };
    for (const field of ['store_id', 'storeId', 'tenantId']) {
      await expectError(
        await api.post('/users', { headers: bearer(teamB.ADMIN.token), data: { ...data, [field]: demo.id } }),
        400,
        MSG.notAllowed(field),
        `POST /users com ${field}`,
      );
      await expectError(
        await api.patch(`/users/${bTarget.user.id}`, { headers: bearer(teamB.ADMIN.token), data: { [field]: demo.id } }),
        400,
        MSG.notAllowed(field),
        `PATCH /users/:id com ${field}`,
      );
      await expectError(
        await api.post('/store/invitations', { headers: bearer(teamB.ADMIN.token), data: { email: uniqueEmail('tn-x'), role: 'EMPLOYEE', [field]: demo.id } }),
        400,
        MSG.notAllowed(field),
        `POST /store/invitations com ${field}`,
      );
    }
    const created = await expectStatus(await api.post('/users', { headers: bearer(teamB.ADMIN.token), data }), 201);
    expect(created).toMatchObject({ role: 'EMPLOYEE', store_id: storeB.id });
    expect(created.store).toMatchObject({ id: storeB.id, slug: storeB.slug });
    const target = await getJson(api, `/users/${bTarget.user.id}`, teamB.ADMIN.token);
    expect(target.store_id).toBe(storeB.id);
  });
});
