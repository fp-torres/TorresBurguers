/**
 * Correções da revisão independente da leva 9a (docs/saas/arquitetura.md §11 e §12).
 *
 * - Convite de troca do responsável (make_owner) pendente: a equipe da loja não ocupa o e-mail do convidado
 *   (POST /users, PATCH /users/:id de um membro ou da própria conta → 409), então o convite continua aceitável
 *   e o aceite troca o responsável. Um convite comum (ou de outra loja) não reserva o e-mail.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  acceptInvitation,
  bearer,
  cleanupPlatformData,
  createPlan,
  expectApiError,
  expectOk,
  freshSession,
  newApi,
  storeWithOwner,
  uniqueEmail,
  STRONG_PASSWORD,
  type Json,
  type Session,
} from "./helpers";

const OWNER_INVITATION_EMAIL =
  "Este e-mail tem um convite pendente da administração da plataforma para assumir a loja como responsável: ele não pode ser usado em outra conta da equipe enquanto o convite valer.";

let api: APIRequestContext;
let sa: Session;
let freePlan: Json;

test.beforeAll(async () => {
  api = await newApi();
  sa = await freshSession(api, "superadmin");
  freePlan = await createPlan(api, sa.token, { price: 0 });
});

test.afterAll(async () => {
  await cleanupPlatformData(api, sa.token);
  await api.dispose();
});

test.describe("Troca do responsável (make_owner): o e-mail do convidado fica protegido na loja", () => {
  test("o ADMIN não cadastra nem troca para o e-mail do convidado (409); o aceite troca o responsável", async () => {
    const store = await storeWithOwner(api, sa.token, { planId: freePlan.id });
    const admin = bearer(store.owner.token);
    const member = await expectOk(
      await api.post("/users", {
        headers: admin,
        data: {
          name: "Cozinha E2E",
          email: uniqueEmail("r9a-cozinha"),
          password: STRONG_PASSWORD,
          role: "KITCHEN",
        },
      }),
      201,
      "membro da equipe",
    );

    const email = uniqueEmail("r9a-novo-dono");
    const created = await expectOk(
      await api.post(`/platform/stores/${store.id}/invitations`, {
        headers: bearer(sa.token),
        data: { email, role: "ADMIN", make_owner: true },
      }),
      201,
      "convite de troca do responsável",
    );
    expect(created.url, "sem SMTP o link volta para o operador").toBeTruthy();

    await expectApiError(
      await api.post("/users", {
        headers: admin,
        data: {
          name: "Reserva",
          email: email.toUpperCase(),
          password: STRONG_PASSWORD,
          role: "KITCHEN",
        },
      }),
      409,
      OWNER_INVITATION_EMAIL,
      "ADMIN cria a equipe com o e-mail do convidado",
    );
    await expectApiError(
      await api.patch(`/users/${member.id}`, {
        headers: admin,
        data: { email },
      }),
      409,
      OWNER_INVITATION_EMAIL,
      "ADMIN troca o e-mail de um membro para o do convidado",
    );
    await expectApiError(
      await api.patch(`/users/${store.owner.user.id}`, {
        headers: admin,
        data: { email },
      }),
      409,
      OWNER_INVITATION_EMAIL,
      "ADMIN troca o próprio e-mail para o do convidado",
    );

    // O convite continua aceitável e troca o responsável
    const owner = await acceptInvitation(api, created.url, {
      name: "Novo Responsável",
    });
    expect(owner.user).toMatchObject({ email, role: "ADMIN", store_id: store.id });
    const detail = await expectOk(
      await api.get(`/platform/stores/${store.id}`, {
        headers: bearer(sa.token),
      }),
      200,
    );
    expect(detail.owner_user_id).toBe(owner.user.id);
  });

  test("convite comum ou de outra loja não reserva o e-mail", async () => {
    const storeA = await storeWithOwner(api, sa.token, { planId: freePlan.id });
    const storeB = await storeWithOwner(api, sa.token, { planId: freePlan.id });
    const ownerOfB = uniqueEmail("r9a-dono-b");
    await expectOk(
      await api.post(`/platform/stores/${storeB.id}/invitations`, {
        headers: bearer(sa.token),
        data: { email: ownerOfB, role: "ADMIN", make_owner: true },
      }),
      201,
    );
    const common = uniqueEmail("r9a-comum");
    await expectOk(
      await api.post("/store/invitations", {
        headers: bearer(storeA.owner.token),
        data: { email: common, role: "KITCHEN" },
      }),
      201,
    );
    for (const email of [ownerOfB, common]) {
      await expectOk(
        await api.post("/users", {
          headers: bearer(storeA.owner.token),
          data: {
            name: "Equipe A",
            email,
            password: STRONG_PASSWORD,
            role: "EMPLOYEE",
          },
        }),
        201,
        `loja A cadastra ${email}`,
      );
    }
  });
});
