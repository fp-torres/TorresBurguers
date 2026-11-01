/**
 * Revisão de segurança, rodada 2 — lojas, assinaturas e superpainel (docs/saas/arquitetura.md §5.2, §5.6,
 * §6 e §11). Cada teste cria as próprias lojas, planos e contas; configurações globais alteradas voltam
 * ao valor original (restoreSettings).
 *
 * - Convite de troca do responsável (make_owner) é da plataforma: a loja não cancela (403) nem substitui
 *   (409); a substituição de um convite comum entra na auditoria (invitation.revoke, reason superseded).
 * - Convites pela loja: no máximo 3 por destinatário em 24 h NA MESMA LOJA (429); somando as lojas, a partir
 *   de 10 o convite é criado sem e-mail (o link volta com um aviso) e nenhuma loja fica bloqueada.
 * - Cancelamento agendado pela plataforma: a loja não desfaz (409); a origem sai em cancel_scheduled_by.
 * - Cancelamento imediato (irreversível) pela loja: só o responsável (403 para outro ADMIN).
 * - Limite de produtos do plano rígido numa rajada paralela.
 * - Endereço antigo (troca de slug pelo superpainel) fica reservado contra o autoatendimento.
 * - Leituras de dados pessoais no superpainel entram na auditoria.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  acceptInvitation,
  auditPage,
  bearer,
  cleanupPlatformData,
  createPlan,
  expectApiError,
  expectOk,
  freshSession,
  newApi,
  restoreSettings,
  settingsSnapshot,
  storeSlug,
  storeWithOwner,
  trackStore,
  uniqueEmail,
  STRONG_PASSWORD,
  type Json,
  type Session,
  type StoreWithOwner,
} from "./helpers";

const OWNER_INVITATION_PROTECTED =
  "Este convite de troca do responsável pela loja foi criado pela administração da plataforma: só ela pode cancelá-lo ou substituí-lo.";
const RECIPIENT_LIMIT =
  "A loja já enviou muitos convites para este e-mail nas últimas 24 horas. Tente de novo amanhã.";
const MAIL_SKIPPED =
  "O convite foi criado, mas o e-mail não foi enviado agora. Copie o link e envie à pessoa.";
const CANCEL_SCHEDULED_BY_PLATFORM =
  "O cancelamento da assinatura foi agendado pela administração da plataforma. Fale com o suporte para mantê-la.";
const IMMEDIATE_CANCEL_OWNER_ONLY =
  "Sem período pago a terminar, o cancelamento é imediato e não pode ser desfeito: só o responsável pela loja pode fazê-lo.";
const SLUG_TAKEN =
  "Este endereço (slug) já está em uso por outro estabelecimento. Escolha outro.";

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

/** ADMIN extra (não responsável) da loja, por convite do responsável. */
async function extraAdmin(store: StoreWithOwner): Promise<Session> {
  const created = await expectOk(
    await api.post("/store/invitations", {
      headers: bearer(store.owner.token),
      data: { email: uniqueEmail("r2-admin"), role: "ADMIN" },
    }),
    201,
    "convite de outro ADMIN",
  );
  return acceptInvitation(api, created.url, { name: "Outro ADMIN" });
}

test.describe("Convites (POST/DELETE /store/invitations)", () => {
  test("troca do responsável (make_owner): a loja não cancela (403) nem substitui (409); o superpainel cancela", async () => {
    const store = await storeWithOwner(api, sa.token, { planId: freePlan.id });
    const email = uniqueEmail("r2-novo-dono");
    const created = await expectOk(
      await api.post(`/platform/stores/${store.id}/invitations`, {
        headers: bearer(sa.token),
        data: { email, role: "ADMIN", make_owner: true },
      }),
      201,
      "convite de troca do responsável",
    );
    const id = created.invitation.id;

    await expectApiError(
      await api.delete(`/store/invitations/${id}`, {
        headers: bearer(store.owner.token),
      }),
      403,
      OWNER_INVITATION_PROTECTED,
      "responsável atual tenta cancelar",
    );
    await expectApiError(
      await api.post("/store/invitations", {
        headers: bearer(store.owner.token),
        data: { email, role: "KITCHEN" },
      }),
      409,
      OWNER_INVITATION_PROTECTED,
      "loja tenta substituir por um convite dela",
    );
    const list = await expectOk(
      await api.get("/store/invitations?status=PENDING", {
        headers: bearer(store.owner.token),
      }),
      200,
    );
    expect(list.items.find((item: Json) => item.id === id)).toMatchObject({
      status: "PENDING",
      make_owner: true,
    });

    const revoked = await expectOk(
      await api.delete(`/platform/invitations/${id}`, {
        headers: bearer(sa.token),
      }),
      200,
    );
    expect(revoked.status).toBe("REVOKED");
  });

  test("reenvio pela loja substitui o convite pendente e a revogação do anterior entra na auditoria", async () => {
    const store = await storeWithOwner(api, sa.token, { planId: freePlan.id });
    const email = uniqueEmail("r2-reenvio");
    const first = await expectOk(
      await api.post("/store/invitations", {
        headers: bearer(store.owner.token),
        data: { email, role: "KITCHEN" },
      }),
      201,
    );
    const second = await expectOk(
      await api.post("/store/invitations", {
        headers: bearer(store.owner.token),
        data: { email, role: "EMPLOYEE" },
      }),
      201,
    );
    const page = await auditPage(api, sa.token, {
      action: "invitation.revoke",
      target_type: "invitation",
      target_id: first.invitation.id,
    });
    expect(page.items[0]).toMatchObject({
      store_id: store.id,
      actor: expect.objectContaining({ id: store.owner.user.id }),
      metadata: expect.objectContaining({
        reason: "superseded",
        replaced_by: second.invitation.id,
      }),
    });
  });

  test("no máximo 3 convites por destinatário em 24 h NA MESMA LOJA (429): outra loja não fica bloqueada; o superpainel não entra no limite", async () => {
    const storeA = await storeWithOwner(api, sa.token, { planId: freePlan.id });
    const storeB = await storeWithOwner(api, sa.token, { planId: freePlan.id });
    const email = uniqueEmail("r2-alvo");
    for (const role of ["KITCHEN", "EMPLOYEE", "KITCHEN"]) {
      await expectOk(
        await api.post("/store/invitations", {
          headers: bearer(storeA.owner.token),
          data: { email, role },
        }),
        201,
        `convite de ${storeA.slug}`,
      );
    }
    await expectApiError(
      await api.post("/store/invitations", {
        headers: bearer(storeA.owner.token),
        data: { email, role: "COURIER" },
      }),
      429,
      RECIPIENT_LIMIT,
      "4º convite da mesma loja em 24 h",
    );
    // Outra loja (o empregador de verdade) não é bloqueada pelos convites da primeira
    const fromB = await expectOk(
      await api.post("/store/invitations", {
        headers: bearer(storeB.owner.token),
        data: { email, role: "ADMIN" },
      }),
      201,
      "convite de outra loja para o mesmo e-mail",
    );
    expect(fromB).not.toHaveProperty("message");
    await expectOk(
      await api.post(`/platform/stores/${storeB.id}/invitations`, {
        headers: bearer(sa.token),
        data: { email, role: "COURIER" },
      }),
      201,
      "superpainel convida o mesmo e-mail",
    );
  });

  test("teto de 10 convites por destinatário em 24 h somando as lojas: o convite é criado sem e-mail e o link volta com o aviso", async () => {
    const email = uniqueEmail("r2-teto");
    const stores: StoreWithOwner[] = [];
    for (let i = 0; i < 4; i++) {
      stores.push(await storeWithOwner(api, sa.token, { planId: freePlan.id }));
    }
    // 3 + 3 + 3 convites de três lojas e 1 do superpainel = 10 nas últimas 24 h
    for (const store of stores.slice(0, 3)) {
      for (const role of ["KITCHEN", "EMPLOYEE", "COURIER"]) {
        await expectOk(
          await api.post("/store/invitations", {
            headers: bearer(store.owner.token),
            data: { email, role },
          }),
          201,
          `convite de ${store.slug}`,
        );
      }
    }
    await expectOk(
      await api.post(`/platform/stores/${stores[0].id}/invitations`, {
        headers: bearer(sa.token),
        data: { email, role: "KITCHEN" },
      }),
      201,
      "convite do superpainel",
    );
    const skipped = await expectOk(
      await api.post("/store/invitations", {
        headers: bearer(stores[3].owner.token),
        data: { email, role: "ADMIN" },
      }),
      201,
      "11º convite para o e-mail (quarta loja)",
    );
    expect(skipped).toMatchObject({ message: MAIL_SKIPPED, invitation: { status: "PENDING" } });
    expect(String(skipped.url)).toContain("/convite/");
    expect(skipped).not.toHaveProperty("delivered");
    const audit = await auditPage(api, sa.token, {
      action: "invitation.create",
      store_id: stores[3].id,
    });
    expect(audit.items[0]).toMatchObject({
      result: "SUCCESS",
      metadata: expect.objectContaining({ email, mail_skipped: "recipient_mail_limit" }),
    });
  });
});

test.describe("Assinatura (POST /store/subscription/cancel e /resume)", () => {
  test("cancelamento agendado pela plataforma: a loja não desfaz (409) e vê a origem; o superpainel desfaz", async () => {
    const paid = await createPlan(api, sa.token, { price: 49.9 });
    const store = await storeWithOwner(api, sa.token, { planId: paid.id });
    const subscriptionId = store.subscription.id;
    const scheduled = await expectOk(
      await api.post(`/platform/subscriptions/${subscriptionId}/cancel`, {
        headers: bearer(sa.token),
        data: { at_period_end: true, reason: "Encerramento contratual (E2E)" },
      }),
      200,
      "superpainel agenda o cancelamento",
    );
    expect(JSON.stringify(scheduled)).toContain(
      '"cancel_scheduled_by":"PLATFORM"',
    );

    await expectApiError(
      await api.post("/store/subscription/resume", {
        headers: bearer(store.owner.token),
      }),
      409,
      CANCEL_SCHEDULED_BY_PLATFORM,
      "loja tenta desfazer",
    );
    const overview = await expectOk(
      await api.get("/store/subscription", {
        headers: bearer(store.owner.token),
      }),
      200,
    );
    expect(overview.subscription).toMatchObject({
      cancel_at_period_end: true,
      cancel_scheduled_by: "PLATFORM",
    });

    await expectOk(
      await api.post(`/platform/subscriptions/${subscriptionId}/resume`, {
        headers: bearer(sa.token),
      }),
      200,
      "superpainel desfaz",
    );
    const after = await expectOk(
      await api.get("/store/subscription", {
        headers: bearer(store.owner.token),
      }),
      200,
    );
    expect(after.subscription).toMatchObject({
      cancel_at_period_end: false,
      cancel_scheduled_by: null,
    });

    // Agendado pela própria loja: ela mesma desfaz (comportamento de antes)
    await expectOk(
      await api.post("/store/subscription/cancel", {
        headers: bearer(store.owner.token),
        data: {},
      }),
      200,
    );
    const own = await expectOk(
      await api.get("/store/subscription", {
        headers: bearer(store.owner.token),
      }),
      200,
    );
    expect(own.subscription).toMatchObject({
      cancel_at_period_end: true,
      cancel_scheduled_by: "STORE",
    });
    await expectOk(
      await api.post("/store/subscription/resume", {
        headers: bearer(store.owner.token),
      }),
      200,
    );
  });

  test("cancelamento imediato (plano sem período, irreversível): outro ADMIN → 403 e nada muda; o responsável cancela", async () => {
    const store = await storeWithOwner(api, sa.token, { planId: freePlan.id });
    const other = await extraAdmin(store);
    await expectApiError(
      await api.post("/store/subscription/cancel", {
        headers: bearer(other.token),
        data: { reason: "Teste" },
      }),
      403,
      IMMEDIATE_CANCEL_OWNER_ONLY,
      "ADMIN que não é o responsável",
    );
    const still = await expectOk(
      await api.get("/store/subscription", {
        headers: bearer(store.owner.token),
      }),
      200,
    );
    expect(still.subscription.status).not.toBe("CANCELED");

    const canceled = await expectOk(
      await api.post("/store/subscription/cancel", {
        headers: bearer(store.owner.token),
        data: { reason: "Fechando (E2E)" },
      }),
      200,
    );
    expect(canceled.subscription.status).toBe("CANCELED");
  });
});

test.describe("Limites do plano", () => {
  test("rajada paralela de cadastros de produto não passa do max_products", async () => {
    const plan = await createPlan(api, sa.token, { price: 0, max_products: 3 });
    const store = await storeWithOwner(api, sa.token, { planId: plan.id });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        api.post("/products", {
          headers: bearer(store.owner.token),
          data: {
            name: `Rajada ${index}`,
            price: 10,
            category: "hamburgueres",
          },
        }),
      ),
    );
    const statuses = results.map((res) => res.status());
    expect(
      statuses.filter((status) => status === 201),
      JSON.stringify(statuses),
    ).toHaveLength(3);
    expect(statuses.filter((status) => status === 403)).toHaveLength(9);
    const products = await expectOk(
      await api.get("/products", { headers: bearer(store.owner.token) }),
      200,
    );
    const list = Array.isArray(products) ? products : products.items;
    expect(list).toHaveLength(3);
  });
});

test.describe("Endereço da loja (slug)", () => {
  test("endereço antigo, trocado pelo superpainel, fica reservado contra o autoatendimento", async () => {
    const snapshot = await settingsSnapshot(api, sa.token);
    const signupPlan = await createPlan(api, sa.token, {
      price: 0,
      is_public: true,
    });
    try {
      const store = await storeWithOwner(api, sa.token, {
        planId: freePlan.id,
      });
      const newSlug = storeSlug("r2-novo");
      const updated = await expectOk(
        await api.patch(`/platform/stores/${store.id}`, {
          headers: bearer(sa.token),
          data: { slug: newSlug },
        }),
        200,
        "troca do endereço",
      );
      expect(updated.warnings.join(" ")).toContain(`/loja/${store.slug}`);

      await expectOk(
        await api.patch("/platform/settings", {
          headers: bearer(sa.token),
          data: {
            store_self_signup_enabled: true,
            self_signup_plan_id: signupPlan.id,
          },
        }),
        200,
        "habilita o autoatendimento",
      );
      const signup = (slug: string) =>
        api.post("/stores/signup", {
          data: {
            store: { name: `Impostor ${slug}`, slug },
            owner: {
              name: "Impostor",
              email: uniqueEmail("r2-impostor"),
              password: STRONG_PASSWORD,
            },
            accept_terms: true,
          },
        });
      await expectApiError(
        await signup(store.slug),
        409,
        SLUG_TAKEN,
        "autoatendimento com o endereço antigo",
      );
      // Endereço nunca usado continua livre
      const fresh = await expectOk(
        await signup(storeSlug("r2-livre")),
        201,
        "autoatendimento com endereço novo",
      );
      trackStore(fresh.user.store_id);
    } finally {
      await restoreSettings(api, sa.token, snapshot);
    }
  });
});

test.describe("Leituras de dados pessoais no superpainel (auditoria)", () => {
  test("GET /platform/users, /platform/users/:id e /platform/stores/:id/users ficam na auditoria", async () => {
    const store = await storeWithOwner(api, sa.token, { planId: freePlan.id });
    const search = store.owner.email;
    const list = await expectOk(
      await api.get("/platform/users", {
        headers: bearer(sa.token),
        params: { search, include_deleted: true },
      }),
      200,
    );
    expect(list.total).toBe(1);
    await expect
      .poll(async () => {
        const page = await auditPage(api, sa.token, {
          action: "platform.users.list",
          pageSize: 20,
        });
        return (
          page.items.find(
            (item: Json) => item.metadata?.filters?.search === search,
          )?.metadata ?? null
        );
      })
      .toMatchObject({
        returned: 1,
        total: 1,
        filters: { include_deleted: true },
      });

    await expectOk(
      await api.get(`/platform/users/${store.owner.user.id}`, {
        headers: bearer(sa.token),
      }),
      200,
    );
    const view = await auditPage(api, sa.token, {
      action: "platform.users.view",
      target_type: "user",
      target_id: store.owner.user.id,
    });
    expect(view.items[0]).toMatchObject({
      actor: expect.objectContaining({ id: sa.user.id }),
      store_id: store.id,
    });

    await expectOk(
      await api.get(`/platform/stores/${store.id}/users`, {
        headers: bearer(sa.token),
      }),
      200,
    );
    const team = await auditPage(api, sa.token, {
      action: "platform.store.team.view",
      target_type: "store",
      target_id: store.id,
    });
    expect(team.items[0]).toMatchObject({
      store_id: store.id,
      metadata: expect.objectContaining({ returned: 1 }),
    });
  });
});
