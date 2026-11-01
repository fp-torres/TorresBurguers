/**
 * Endurecimento da equipe e da conta (revisão de segurança):
 * - o responsável pela loja (owner_user_id) não tem e-mail, senha nem perfil trocados por outro ADMIN e
 *   não é excluído pela equipe;
 * - convite criado por um ADMIN deixa de valer quando ele é rebaixado, vai para a lixeira ou é
 *   bloqueado (cancelado na hora e recusado no aceite);
 * - a lista de convites da loja não expõe o id da conta da plataforma que convidou;
 * - conta da plataforma troca a própria senha só com a senha atual; senha atual enviada é conferida.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  STRONG_PASSWORD,
  bearer,
  cleanupPlatformData,
  createPlan,
  expectApiError,
  expectOk,
  freshSession,
  newApi,
  storeWithOwner,
  uniqueEmail,
  type Json,
  type Session,
  type StoreWithOwner,
} from '../platform/helpers';
import { login } from '../../../support/api';

const OWNER_CREDENTIALS =
  'O e-mail, a senha e o perfil do responsável pela loja só podem ser alterados por ele mesmo ou pela plataforma.';
const OWNER_DELETE = /O responsável pela loja não pode ser excluído pela equipe/;
const INVALID_INVITATION = 'Convite inválido, expirado ou já utilizado. Peça um novo convite à loja.';

let api: APIRequestContext;
let sa: Session;
let store: StoreWithOwner;
let coAdmin: { id: number; email: string; token: string };

const linkToken = (url: string) => url.split('/convite/')[1];

/** Membro novo da loja (criado pelo responsável) com a sessão dele. */
async function newMember(role: 'ADMIN' | 'EMPLOYEE', label: string) {
  const email = uniqueEmail(label);
  const created = await expectOk(
    await api.post('/users', {
      headers: bearer(store.owner.token),
      data: { name: `Membro ${label}`, email, password: STRONG_PASSWORD, role },
    }),
    201,
  );
  const session = await login(api, email, STRONG_PASSWORD);
  return { id: created.id as number, email, token: session.token };
}

test.beforeAll(async () => {
  api = await newApi();
  sa = await freshSession(api, 'superadmin');
  const plan = await createPlan(api, sa.token, { price: 0 });
  store = await storeWithOwner(api, sa.token, { planId: plan.id });
  coAdmin = await newMember('ADMIN', 'coadmin');
});

test.afterAll(async () => {
  if (!api) return;
  try {
    await cleanupPlatformData(api, sa.token);
  } finally {
    await api.dispose();
  }
});

test.describe('Responsável pela loja (owner_user_id)', () => {
  test('outro ADMIN não troca e-mail, senha nem perfil do responsável (403); nome e telefone seguem editáveis', async () => {
    const ownerId = store.owner.user.id;
    for (const data of [
      { email: uniqueEmail('tomada') },
      { password: 'Tomada@2026x' },
      { role: 'COURIER' },
      { name: 'Ok', email: uniqueEmail('tomada') },
    ]) {
      await expectApiError(
        await api.patch(`/users/${ownerId}`, { headers: bearer(coAdmin.token), data }),
        403,
        OWNER_CREDENTIALS,
        JSON.stringify(data),
      );
    }
    // O responsável continua entrando com o e-mail e a senha dele
    const owner = await login(api, store.owner.email, store.owner.password);
    expect(owner.user).toMatchObject({ id: ownerId, role: 'ADMIN' });

    // Nome/telefone (e o mesmo e-mail reenviado, como o app mobile faz) continuam editáveis
    const renamed = await expectOk(
      await api.patch(`/users/${ownerId}`, {
        headers: bearer(coAdmin.token),
        data: { name: 'Responsável Renomeado', email: store.owner.email.toUpperCase(), phone: '21977776666' },
      }),
      200,
    );
    expect(renamed).toMatchObject({ id: ownerId, name: 'Responsável Renomeado', email: store.owner.email });
    // O próprio responsável continua editando a si mesmo
    expect((await api.get('/auth/me', { headers: bearer(owner.token) })).status()).toBe(200);
  });

  test('o responsável não vai para a lixeira pela equipe (403) e continua ativo', async () => {
    await expectApiError(await api.delete(`/users/${store.owner.user.id}`, { headers: bearer(coAdmin.token) }), 403, OWNER_DELETE);
    const team = await expectOk(await api.get('/users', { headers: bearer(coAdmin.token) }), 200);
    expect(team.map((member: Json) => member.id)).toContain(store.owner.user.id);
  });
});

test.describe('Convites de quem perde o direito de convidar', () => {
  test('ADMIN rebaixado: o convite ADMIN que ele criou é cancelado e o link não cria a conta (404)', async () => {
    const inviter = await newMember('ADMIN', 'convida-rebaixado');
    const created = await expectOk(
      await api.post('/store/invitations', {
        headers: bearer(inviter.token),
        data: { email: uniqueEmail('reserva'), role: 'ADMIN' },
      }),
      201,
    );
    const token = linkToken(created.url);
    expect((await api.get(`/invitations/${token}`)).status()).toBe(200);

    await expectOk(await api.patch(`/users/${inviter.id}`, { headers: bearer(store.owner.token), data: { role: 'EMPLOYEE' } }), 200);

    const list = await expectOk(await api.get('/store/invitations', { headers: bearer(store.owner.token) }), 200);
    expect(list.items.find((item: Json) => item.id === created.invitation.id)).toMatchObject({ status: 'REVOKED' });
    await expectApiError(await api.get(`/invitations/${token}`), 404, INVALID_INVITATION);
    await expectApiError(
      await api.post(`/invitations/${token}/accept`, { data: { name: 'Gerente', password: STRONG_PASSWORD } }),
      404,
      INVALID_INVITATION,
    );
  });

  test('ADMIN bloqueado pela plataforma: o convite dele deixa de valer', async () => {
    const inviter = await newMember('ADMIN', 'convida-bloqueado');
    const created = await expectOk(
      await api.post('/store/invitations', {
        headers: bearer(inviter.token),
        data: { email: uniqueEmail('reserva-bloq'), role: 'ADMIN' },
      }),
      201,
    );
    await expectOk(
      await api.post(`/platform/users/${inviter.id}/block`, { headers: bearer(sa.token), data: { reason: 'Teste E2E de convite' } }),
      200,
    );
    await expectApiError(
      await api.post(`/invitations/${linkToken(created.url)}/accept`, { data: { name: 'Gerente', password: STRONG_PASSWORD } }),
      404,
      INVALID_INVITATION,
    );
  });

  test('a lista da loja não expõe o id do superadmin que convidou (o superpainel vê)', async () => {
    const list = await expectOk(await api.get('/store/invitations', { headers: bearer(store.owner.token) }), 200);
    const ownerInvitation = list.items.find((item: Json) => item.accepted_user_id === store.owner.user.id);
    expect(ownerInvitation, 'convite do responsável (criado pelo superpainel)').toBeTruthy();
    expect(ownerInvitation.invited_by_user_id).toBeNull();
    expect(JSON.stringify(list)).not.toContain(`"invited_by_user_id":${sa.user.id}`);

    // Convite criado por um ADMIN da loja continua mostrando quem convidou
    const byAdmin = await expectOk(
      await api.post('/store/invitations', { headers: bearer(coAdmin.token), data: { email: uniqueEmail('equipe'), role: 'KITCHEN' } }),
      201,
    );
    const again = await expectOk(await api.get('/store/invitations', { headers: bearer(store.owner.token) }), 200);
    expect(again.items.find((item: Json) => item.id === byAdmin.invitation.id)).toMatchObject({ invited_by_user_id: coAdmin.id });

    const platform = await expectOk(
      await api.get(`/platform/stores/${store.id}/invitations`, { headers: bearer(sa.token) }),
      200,
    );
    expect(platform.items.find((item: Json) => item.id === ownerInvitation.id)).toMatchObject({ invited_by_user_id: sa.user.id });
  });
});

test.describe('Reautenticação na troca da própria senha', () => {
  test('conta da plataforma: sem a senha atual (ou com ela errada) → 400 e nada muda', async () => {
    await expectApiError(
      await api.patch(`/users/${sa.user.id}`, { headers: bearer(sa.token), data: { password: 'NovaSenha@2026x' } }),
      400,
      'Informe a senha atual para trocar o e-mail ou a senha.',
    );
    await expectApiError(
      await api.patch(`/users/${sa.user.id}`, {
        headers: bearer(sa.token),
        data: { password: 'NovaSenha@2026x', current_password: 'Errada@2026x' },
      }),
      400,
      'A senha atual não confere.',
    );
    // A sessão continua valendo (nenhuma troca aconteceu)
    expect((await api.get('/platform/dashboard', { headers: bearer(sa.token) })).status()).toBe(200);
  });

  test('membro da equipe: senha atual enviada é conferida; sem ela a troca segue aceita (app mobile)', async () => {
    const member = await newMember('EMPLOYEE', 'reauth');
    await expectApiError(
      await api.patch(`/users/${member.id}`, {
        headers: bearer(member.token),
        data: { password: 'NovaSenha@2026x', current_password: 'Errada@2026x' },
      }),
      400,
      'A senha atual não confere.',
    );
    const changed = await expectOk(
      await api.patch(`/users/${member.id}`, {
        headers: bearer(member.token),
        data: { password: 'NovaSenha@2026x', current_password: STRONG_PASSWORD },
      }),
      200,
    );
    expect(typeof changed.access_token).toBe('string');
    const again = await expectOk(
      await api.patch(`/users/${member.id}`, { headers: bearer(changed.access_token), data: { password: 'OutraSenha@2026x' } }),
      200,
    );
    expect(typeof again.access_token).toBe('string');
    await login(api, member.email, 'OutraSenha@2026x');
  });
});
