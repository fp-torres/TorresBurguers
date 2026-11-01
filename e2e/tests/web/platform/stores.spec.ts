import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  addProduct,
  bearer,
  brl,
  escapeRegex,
  expectStatus,
  getJson,
  integer,
  newApi,
  newCustomer,
  pageHeading,
  PASSWORD,
  placeTakeoutOrder,
  retireTenantStore,
  signIn,
  statValue,
  superadminSession,
  tenantStore,
  toast,
  uid,
  uniqueEmail,
  waitForApi,
  type Json,
  type Session,
  type TenantStore,
} from './helpers';

/**
 * Superpainel (/platform) com o superadmin: dashboard com os números da API, lista de estabelecimentos
 * (busca e filtros), cadastro de uma loja com o link do convite exibido uma única vez, detalhe com as abas e
 * suspensão/reativação com motivo. As lojas são próprias deste arquivo (desativadas no fim); a loja demo não muda.
 */

let api: APIRequestContext;
let superadmin: Session;
const createdStoreIds: number[] = [];

test.beforeAll(async () => {
  api = await newApi();
  superadmin = await superadminSession(api);
});

test.afterAll(async () => {
  for (const id of createdStoreIds) await retireTenantStore(api, superadmin, { id });
  await api.dispose();
});

async function storeFixture(label: string, options: { open?: boolean; delivery?: boolean } = {}): Promise<TenantStore> {
  const store = await tenantStore(api, superadmin, label, options);
  createdStoreIds.push(store.id);
  return store;
}

/** Os cartões do dashboard mostram exatamente o que a API respondeu (GET /platform/dashboard). */
async function expectDashboard(page: Page, data: Json): Promise<void> {
  const platform = page.getByRole('region', { name: 'Comestra: lojas, assinaturas e receita' });
  const card = (label: string) =>
    platform.locator('p').filter({ hasText: new RegExp(`^${escapeRegex(label)}$`) }).locator('xpath=following-sibling::p[1]');
  await expect(card('Lojas')).toHaveText(integer(data.stores.total));
  await expect(platform.getByText(
    `${integer(data.stores.by_status.ACTIVE)} ativas · ${integer(data.stores.by_status.SUSPENDED)} suspensas · ${integer(data.stores.by_status.INACTIVE)} desativadas`,
    { exact: true },
  )).toBeVisible();
  await expect(card('Assinaturas vigentes')).toHaveText(integer(data.subscriptions.current));
  await expect(card('MRR')).toHaveText(brl(data.mrr.value));
  await expect(card('ARR (projeção)')).toHaveText(brl(data.arr.value));
  await expect(card('Receita da Comestra')).toHaveText(brl(data.platform_revenue.total));

  const stores = page.getByRole('region', { name: 'Movimento das lojas' });
  await expect(statValue(stores, 'Pedidos processados')).toHaveText(integer(data.orders.total));
  await expect(statValue(stores, 'Volume das lojas (GMV)')).toHaveText(brl(data.gmv.total));
}

test.describe('Dashboard da plataforma', () => {
  test('os indicadores são os da API, batem com a lista de lojas e acompanham uma loja e um pedido novos', async ({ page }) => {
    await signIn(page, superadmin);
    const firstLoad = waitForApi(page, 'GET', '/platform/dashboard');
    await page.goto('/platform');
    await expect(pageHeading(page, 'Dashboard da plataforma')).toBeVisible();
    const before = await (await firstLoad).json();
    await expectDashboard(page, before);

    // Números reais: o total e a situação das lojas são os da lista do superpainel (outras suítes criam lojas
    // ao mesmo tempo: compara leituras feitas juntas e repete até ficarem estáveis)
    await expect(async () => {
      const list = (status?: string) =>
        getJson(api, `/platform/stores?page=1&pageSize=1${status ? `&account_status=${status}` : ''}`, superadmin.token);
      const [dashboard, all, active, suspended, inactive] = await Promise.all([
        getJson(api, '/platform/dashboard', superadmin.token),
        list(),
        list('ACTIVE'),
        list('SUSPENDED'),
        list('INACTIVE'),
      ]);
      expect(dashboard.stores.total, 'total de lojas = lista do superpainel').toBe(all.total);
      expect(dashboard.stores.by_status).toEqual({ ACTIVE: active.total, SUSPENDED: suspended.total, INACTIVE: inactive.total });
    }).toPass({ timeout: 30_000 });

    // Uma loja nova e um pedido nela: "Atualizar" traz os números novos
    const store = await storeFixture('Dashboard');
    const product = await addProduct(api, store.owner, { name: `Lanche Dashboard ${uid('d')}`, price: 18 });
    const customer = await newCustomer(api, 'Dashboard');
    await placeTakeoutOrder(api, store.slug, customer, product.id);

    const reload = waitForApi(page, 'GET', '/platform/dashboard');
    await page.getByRole('button', { name: 'Atualizar' }).click();
    const after = await (await reload).json();
    // Lojas nunca somem do total (desativadas continuam contando); assinaturas e pedidos podem ser cancelados
    // por outras suítes ao mesmo tempo, então só o total de lojas é comparado com o de antes
    expect(after.stores.total, 'a loja nova entra no total').toBeGreaterThanOrEqual(before.stores.total + 1);
    expect(after.orders.total, 'o pedido novo conta nos pedidos processados').toBeGreaterThanOrEqual(1);
    expect(after.subscriptions.current, 'a assinatura da loja nova é vigente').toBeGreaterThanOrEqual(1);
    await expectDashboard(page, after);
  });
});

test.describe('Estabelecimentos', () => {
  test('busca e filtros por situação, plano e assinatura (e o endereço guarda os filtros)', async ({ page }) => {
    const tag = uid('flt').replace(/-/g, '');
    const active = await storeFixture(`Filtro ${tag} Ativa`, { open: false, delivery: false });
    const suspended = await storeFixture(`Filtro ${tag} Suspensa`, { open: false, delivery: false });
    await expectStatus(
      await api.post(`/platform/stores/${suspended.id}/suspend`, {
        headers: bearer(superadmin.token),
        data: { reason: 'Filtro de lojas suspensas (E2E web).' },
      }),
      200,
      'suspender a loja do filtro',
    );

    await signIn(page, superadmin);
    await page.goto('/platform/stores');
    await expect(pageHeading(page, 'Estabelecimentos')).toBeVisible();
    const table = page.getByRole('table', { name: 'Estabelecimentos da plataforma' });
    const row = (store: TenantStore) => table.getByRole('row').filter({ has: page.getByRole('link', { name: store.name, exact: true }) });

    await page.getByRole('searchbox', { name: 'Buscar estabelecimentos' }).fill(tag);
    await expect(row(active)).toBeVisible();
    await expect(row(suspended)).toBeVisible();
    await expect(table.getByRole('row')).toHaveCount(3); // cabeçalho + as duas lojas do filtro
    await expect(row(active)).toContainText('Ativo');
    await expect(row(suspended)).toContainText('Suspenso');
    await expect(page).toHaveURL(new RegExp(`[?&]q=${tag}`));

    const statusFilter = page.getByRole('group', { name: 'Filtrar por situação da loja' });
    await statusFilter.getByRole('button', { name: 'Suspensos', exact: true }).click();
    await expect(statusFilter.getByRole('button', { name: 'Suspensos', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(row(suspended)).toBeVisible();
    await expect(row(active)).toHaveCount(0);
    await expect(page).toHaveURL(/[?&]situacao=SUSPENDED/);

    await statusFilter.getByRole('button', { name: 'Ativos', exact: true }).click();
    await expect(row(active)).toBeVisible();
    await expect(row(suspended)).toHaveCount(0);

    // Plano: as duas lojas estão no plano interno "demo"; nenhum outro plano tem estas lojas
    await statusFilter.getByRole('button', { name: 'Todos', exact: true }).click();
    const plan = page.getByRole('combobox', { name: 'Plano', exact: true });
    const demoOption = plan.locator('option', { hasText: 'Plano demonstração' });
    await plan.selectOption((await demoOption.getAttribute('value')) as string);
    await expect(row(active)).toBeVisible();
    await expect(row(suspended)).toBeVisible();
    await expect(page).toHaveURL(/[?&]plano=\d+/);

    // Assinatura: nenhuma das duas está em teste grátis
    await page.getByRole('combobox', { name: 'Assinatura' }).selectOption({ label: 'Em teste' });
    await expect(page.getByText('Nenhum estabelecimento encontrado')).toBeVisible();
    await expect(row(active)).toHaveCount(0);

    // Recarregar mantém os filtros do endereço
    await page.reload();
    await expect(page.getByRole('searchbox', { name: 'Buscar estabelecimentos' })).toHaveValue(tag);
    await expect(page.getByRole('combobox', { name: 'Assinatura' })).toHaveValue('TRIALING');
    await page.getByRole('combobox', { name: 'Assinatura' }).selectOption({ label: 'Ativa' });
    await expect(row(active)).toBeVisible();
  });

  test('cadastrar uma loja: o link do convite aparece uma única vez e leva o responsável ao painel', async ({ page, browser }) => {
    const slug = uid('wst').toLowerCase();
    const name = `Loja Web ${slug}`;
    const ownerEmail = uniqueEmail('wst-dono');

    await signIn(page, superadmin);
    await page.goto('/platform/stores');
    await page.getByRole('link', { name: 'Novo estabelecimento' }).click();
    await expect(pageHeading(page, 'Novo estabelecimento')).toBeVisible();

    await page.getByRole('textbox', { name: 'Nome do estabelecimento' }).fill(name);
    await page.getByRole('textbox', { name: 'Endereço da loja' }).fill(slug);
    await page.getByRole('checkbox', { name: 'Mostrar planos indisponíveis (internos ou negociados)' }).check();
    const plan = page.getByRole('region', { name: 'Plano inicial' }).getByRole('combobox', { name: 'Plano' });
    const demoOption = plan.locator('option', { hasText: 'Plano demonstração' });
    await plan.selectOption((await demoOption.getAttribute('value')) as string);
    await page.getByRole('textbox', { name: 'E-mail do responsável' }).fill(ownerEmail);
    await page.getByRole('textbox', { name: 'Nome do responsável (opcional)' }).fill('Responsável Web');

    const creation = waitForApi(page, 'POST', '/platform/stores');
    await page.getByRole('button', { name: 'Cadastrar estabelecimento' }).click();
    const createdRes = await creation;
    expect(createdRes.status()).toBe(201);
    const created = await createdRes.json();
    createdStoreIds.push(created.store.id);

    const dialog = page.getByRole('dialog', { name: 'Estabelecimento cadastrado' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`${name} · /loja/${slug}`);
    const link = dialog.getByRole('textbox', { name: 'Link de convite do responsável' });
    await expect(link).toHaveValue(created.invitation.url);
    const inviteUrl = await link.inputValue();
    expect(inviteUrl, 'link de uso único para a web de teste').toMatch(new RegExp(`^${escapeRegex(new URL(page.url()).origin)}/convite/[\\w-]{20,}$`));
    await expect(dialog).toContainText(`Envie para ${ownerEmail}`);
    const token = new URL(inviteUrl).pathname.split('/').pop() as string;

    // Fechou o aviso: o link não aparece mais em lugar nenhum (o banco guarda só o hash do token)
    await dialog.getByRole('button', { name: 'Ir para o estabelecimento' }).click();
    await expect(page).toHaveURL(new RegExp(`/platform/stores/${created.store.id}$`));
    await expect(pageHeading(page, name)).toBeVisible();
    await page.getByRole('tab', { name: 'Convites' }).click();
    const invitations = page.getByRole('tabpanel', { name: 'Convites' });
    const pending = invitations.getByRole('row').filter({ hasText: ownerEmail });
    await expect(pending).toContainText('Pendente');
    await expect(pending).toContainText('Vira responsável ao aceitar');
    await expect(page.locator('body')).not.toContainText(token);
    await expect(page.getByRole('textbox', { name: /Link de convite/ })).toHaveCount(0);
    await page.reload();
    await expect(pageHeading(page, name)).toBeVisible();
    expect(await page.content(), 'o token não volta depois de recarregar').not.toContain(token);
    // A aba Convites fica aberta enquanto o responsável aceita em outro navegador
    await page.getByRole('tab', { name: 'Convites' }).click();
    await expect(pending).toContainText('Pendente');

    // O responsável abre o link (outro navegador), cria a senha e cai no painel da loja nova
    const ownerContext = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    try {
      const ownerPage = await ownerContext.newPage();
      await ownerPage.goto(inviteUrl);
      await expect(ownerPage.getByRole('heading', { name: 'Convite para a equipe', level: 1 })).toBeVisible();
      await expect(ownerPage.getByText(name, { exact: true })).toBeVisible();
      await ownerPage.getByRole('textbox', { name: 'Nome completo' }).fill('Responsável Web');
      await ownerPage.getByRole('textbox', { name: 'Senha', exact: true }).fill(PASSWORD);
      await ownerPage.getByRole('textbox', { name: 'Confirmar senha' }).fill(PASSWORD);
      await ownerPage.getByRole('button', { name: 'Aceitar convite e entrar' }).click();
      await expect(ownerPage).toHaveURL(/\/dashboard$/, { timeout: 20_000 });
      await expect(ownerPage.getByRole('complementary')).toContainText(name);

      // O mesmo link não vale uma segunda vez
      await ownerContext.clearCookies();
      await ownerPage.evaluate(() => window.localStorage.clear());
      await ownerPage.goto(inviteUrl);
      await expect(ownerPage.getByRole('heading', { name: 'Convite indisponível', level: 1 })).toBeVisible();
      await expect(ownerPage.getByText('Este convite não vale mais')).toBeVisible();
      await expect(ownerPage.getByRole('button', { name: 'Aceitar convite e entrar' })).toHaveCount(0);
    } finally {
      await ownerContext.close();
    }

    // De volta à aba do superpainel, sem recarregar: a lista de convites se atualiza sozinha
    const setVisibility = (state: 'hidden' | 'visible') =>
      page.evaluate((value) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => value === 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      }, state);
    await setVisibility('hidden');
    await setVisibility('visible');
    await expect(pending).toContainText('Aceito');

    // No superpainel (dados recarregados), o convite foi aceito e o responsável está na equipe
    await page.reload();
    await page.getByRole('tab', { name: 'Convites' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Convites' }).getByRole('row').filter({ hasText: ownerEmail })).toContainText('Aceito');
    await page.getByRole('tab', { name: 'Equipe' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Equipe' })).toContainText(ownerEmail);
  });

  test('cadastrar uma loja com SMTP: o convite do responsável sai só por e-mail e o link nunca aparece', async ({ page }) => {
    const slug = uid('wsm').toLowerCase();
    const name = `Loja SMTP ${slug}`;
    const ownerEmail = uniqueEmail('wsm-dono');
    const message = `Convite enviado por e-mail para ${ownerEmail.slice(0, 1)}***@e2e.test. O link não aparece aqui: só a pessoa convidada o recebe.`;
    // A suíte usa o driver de log; a resposta do cadastro real é simulada como com SMTP ({ url: null, delivered, message })
    let realUrl = '';
    await page.route(
      (url) => url.pathname === '/platform/stores',
      async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch();
        const json = await response.json();
        if (json?.store?.id) createdStoreIds.push(json.store.id);
        realUrl = json?.invitation?.url ?? '';
        await route.fulfill({ response, json: { ...json, invitation: { ...json.invitation, url: null, delivered: true, message } } });
      },
    );

    await signIn(page, superadmin);
    await page.goto('/platform/stores/new');
    await expect(pageHeading(page, 'Novo estabelecimento')).toBeVisible();
    await page.getByRole('textbox', { name: 'Nome do estabelecimento' }).fill(name);
    await page.getByRole('textbox', { name: 'Endereço da loja' }).fill(slug);
    await page.getByRole('checkbox', { name: 'Mostrar planos indisponíveis (internos ou negociados)' }).check();
    const plan = page.getByRole('region', { name: 'Plano inicial' }).getByRole('combobox', { name: 'Plano' });
    const demoOption = plan.locator('option', { hasText: 'Plano demonstração' });
    await plan.selectOption((await demoOption.getAttribute('value')) as string);
    await page.getByRole('textbox', { name: 'E-mail do responsável' }).fill(ownerEmail);
    await page.getByRole('button', { name: 'Cadastrar estabelecimento' }).click();

    const dialog = page.getByRole('dialog', { name: 'Estabelecimento cadastrado' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('status').filter({ hasText: message })).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Link de convite do responsável' })).toHaveCount(0);
    await expect(dialog).not.toContainText('O convite do responsável não foi gerado');
    expect(realUrl, 'o convite foi criado de verdade').toMatch(/\/convite\//);
    await expect(dialog).not.toContainText(realUrl);
  });

  test('convite pela aba Convites: sem SMTP o link aparece para copiar; com SMTP só a mensagem de envio', async ({ page }) => {
    const store = await storeFixture('Convites', { open: false, delivery: false });
    await signIn(page, superadmin);
    await page.goto(`/platform/stores/${store.id}?tab=invitations`);
    const panel = page.getByRole('tabpanel', { name: 'Convites' });
    await expect(panel.getByRole('heading', { name: 'Convites da equipe' })).toBeVisible();

    // Driver de log da suíte: a API devolve o link (delivered false)
    const employeeEmail = uniqueEmail('wst-atendente');
    await panel.getByRole('button', { name: 'Convidar' }).click();
    let dialog = page.getByRole('dialog', { name: 'Convidar para a equipe' });
    await dialog.getByRole('textbox', { name: 'E-mail' }).fill(employeeEmail);
    await dialog.getByRole('combobox', { name: 'Perfil' }).selectOption('EMPLOYEE');
    const first = waitForApi(page, 'POST', `/platform/stores/${store.id}/invitations`);
    await dialog.getByRole('button', { name: 'Criar convite' }).click();
    const firstBody = await (await first).json();
    expect(firstBody).toMatchObject({ delivered: false, url: expect.stringMatching(/\/convite\//) });
    dialog = page.getByRole('dialog', { name: 'Convite criado' });
    await expect(dialog.getByRole('textbox', { name: 'Link de convite' })).toHaveValue(firstBody.url);
    await dialog.getByRole('button', { name: 'Concluir' }).click();
    await expect(panel.getByRole('row').filter({ hasText: employeeEmail })).toContainText('Pendente');

    // Com SMTP, a API manda o link só para o convidado: { url: null, delivered: true, message } (resposta simulada
    // sobre o convite criado de verdade)
    const kitchenEmail = uniqueEmail('wst-cozinha');
    const message = `Convite enviado por e-mail para ${kitchenEmail.slice(0, 2)}***@e2e.test.`;
    await page.route(
      (url) => url.pathname === `/platform/stores/${store.id}/invitations`,
      async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch();
        const json = await response.json();
        await route.fulfill({ response, json: { ...json, url: null, delivered: true, message } });
      },
    );
    await panel.getByRole('button', { name: 'Convidar' }).click();
    dialog = page.getByRole('dialog', { name: 'Convidar para a equipe' });
    await dialog.getByRole('textbox', { name: 'E-mail' }).fill(kitchenEmail);
    await dialog.getByRole('combobox', { name: 'Perfil' }).selectOption('KITCHEN');
    await dialog.getByRole('button', { name: 'Criar convite' }).click();
    dialog = page.getByRole('dialog', { name: 'Convite enviado' });
    await expect(dialog.getByRole('status').filter({ hasText: message })).toBeVisible();
    await expect(dialog).toContainText('Convite enviado por e-mail: a pessoa abre o link');
    await expect(dialog.getByRole('textbox', { name: /Link de convite/ }), 'o operador não vê o link').toHaveCount(0);
    await expect(toast(page, 'Convite enviado por e-mail.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Concluir' }).click();
    await expect(panel.getByRole('row').filter({ hasText: kitchenEmail })).toContainText('Pendente');
  });

  test('detalhe com as abas: visão geral, equipe, assinatura, convites, métricas, auditoria e suporte', async ({ page }) => {
    const store = await storeFixture('Abas');
    const product = await addProduct(api, store.owner, { name: `Lanche Abas ${uid('a')}`, price: 21 });
    const customer = await newCustomer(api, 'Abas');
    await placeTakeoutOrder(api, store.slug, customer, product.id);

    await signIn(page, superadmin);
    await page.goto('/platform/stores');
    await page.getByRole('searchbox', { name: 'Buscar estabelecimentos' }).fill(store.slug);
    // A lista leva a busca para o endereço; só então abre o detalhe (ver knownIssues: clique durante a sincronização)
    await expect(page).toHaveURL(new RegExp(`[?&]q=${store.slug}`));
    await expect(page.getByRole('table', { name: 'Estabelecimentos da plataforma' }).getByRole('row')).toHaveCount(2);
    await page.getByRole('link', { name: `Ver detalhes de ${store.name}` }).click();
    await expect(page).toHaveURL(new RegExp(`/platform/stores/${store.id}$`));
    await expect(pageHeading(page, store.name)).toBeVisible();
    await expect(page.getByRole('link', { name: `/loja/${store.slug} (abre a vitrine em nova aba)` })).toHaveAttribute('href', `/loja/${store.slug}`);
    await expect(page.getByText('Cadastro: Ativo', { exact: true })).toBeVisible();

    const tabs = page.getByRole('tablist', { name: 'Seções do estabelecimento' });
    await expect(tabs.getByRole('tab', { name: 'Visão geral' })).toHaveAttribute('aria-selected', 'true');
    const overview = page.getByRole('tabpanel', { name: 'Visão geral' });
    await expect(statValue(overview, 'Pedidos (30 dias)')).toHaveText('1');
    await expect(statValue(overview, 'Clientes')).toHaveText('1');
    await expect(overview.getByRole('region', { name: 'Responsável' })).toContainText(store.owner.email);

    await tabs.getByRole('tab', { name: 'Equipe' }).click();
    await expect(page).toHaveURL(/[?&]tab=team/);
    await expect(page.getByRole('tabpanel', { name: 'Equipe' })).toContainText(store.owner.email);

    await tabs.getByRole('tab', { name: 'Assinatura' }).click();
    const subscription = page.getByRole('tabpanel', { name: 'Assinatura' });
    await expect(subscription.getByRole('region', { name: 'Plano e situação da assinatura' })).toContainText(`Assinatura #${store.subscriptionId}`);
    await expect(subscription).toContainText('Plano demonstração');

    await tabs.getByRole('tab', { name: 'Convites' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Convites' }).getByRole('row').filter({ hasText: store.owner.email })).toContainText('Aceito');

    await tabs.getByRole('tab', { name: 'Métricas' }).click();
    const metrics = page.getByRole('tabpanel', { name: 'Métricas' });
    await expect(metrics.getByRole('heading', { name: 'Métricas de vendas' })).toBeVisible();
    await expect(statValue(metrics, 'Pedidos no período')).toHaveText('1');

    await tabs.getByRole('tab', { name: 'Auditoria' }).click();
    const audit = page.getByRole('tabpanel', { name: 'Auditoria' });
    await expect(audit.getByRole('link', { name: 'Abrir na auditoria geral' })).toHaveAttribute('href', `/platform/audit?loja=${store.id}`);
    await expect(audit.getByText('platform.store.create', { exact: true }).first()).toBeVisible();

    await tabs.getByRole('tab', { name: 'Suporte' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Suporte' }).getByRole('button', { name: 'Iniciar sessão de suporte' })).toBeVisible();

    // A aba vem do endereço ao abrir direto
    await page.goto(`/platform/stores/${store.id}?tab=metrics`);
    await expect(tabs.getByRole('tab', { name: 'Métricas' })).toHaveAttribute('aria-selected', 'true');
  });

  test('suspender exige motivo, mostra o motivo e reativar devolve a loja à operação', async ({ page }) => {
    const store = await storeFixture('Suspensão', { delivery: false });
    const reason = `Pendência cadastral ${uid('mot')} (E2E web).`;

    await signIn(page, superadmin);
    await page.goto(`/platform/stores/${store.id}`);
    await expect(pageHeading(page, store.name)).toBeVisible();

    await page.getByRole('button', { name: 'Suspender', exact: true }).click();
    let dialog = page.getByRole('alertdialog', { name: 'Suspender o estabelecimento?' });
    await expect(dialog).toContainText(`${store.name} deixa de aceitar pedidos novos`);
    const writes: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes(`/platform/stores/${store.id}/`)) writes.push(new URL(req.url()).pathname);
    });
    await dialog.getByRole('button', { name: 'Suspender', exact: true }).click();
    await expect(dialog, 'sem motivo, nada é enviado').toBeVisible();
    await expect(dialog.getByLabel('Motivo')).toHaveAttribute('aria-invalid', 'true');
    expect(writes).toEqual([]);

    await dialog.getByLabel('Motivo').fill(reason);
    const suspend = waitForApi(page, 'POST', `/platform/stores/${store.id}/suspend`);
    await dialog.getByRole('button', { name: 'Suspender', exact: true }).click();
    expect((await suspend).status()).toBe(200);
    await expect(toast(page, 'Estabelecimento suspenso.')).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Cadastro: Suspenso', { exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /^Estabelecimento suspenso desde / })).toContainText(`Motivo: “${reason}”`);
    await expect(page.getByRole('button', { name: 'Reativar', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Suspender', exact: true })).toHaveCount(0);

    const suspended = await getJson(api, `/platform/stores/${store.id}`, superadmin.token);
    expect(suspended).toMatchObject({ account_status: 'SUSPENDED', status_reason: reason });
    const vitrine = await (await api.get(`/stores/${store.slug}`)).json();
    expect(vitrine.ordering_available, 'loja suspensa não vende').toBe(false);

    await page.getByRole('button', { name: 'Reativar', exact: true }).click();
    dialog = page.getByRole('alertdialog', { name: 'Reativar o estabelecimento?' });
    await dialog.getByLabel('Observação (opcional)').fill('Pendência resolvida (E2E web).');
    const reactivate = waitForApi(page, 'POST', `/platform/stores/${store.id}/reactivate`);
    await dialog.getByRole('button', { name: 'Reativar', exact: true }).click();
    expect((await reactivate).status()).toBe(200);
    await expect(toast(page, 'Estabelecimento reativado.')).toBeVisible();
    await expect(page.getByText('Cadastro: Ativo', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Suspender', exact: true })).toBeVisible();

    const reactivated = await getJson(api, `/platform/stores/${store.id}`, superadmin.token);
    expect(reactivated.account_status).toBe('ACTIVE');
    expect((await (await api.get(`/stores/${store.slug}`)).json()).ordering_available).toBe(true);

    // A auditoria da loja guarda a suspensão com o motivo
    await page.getByRole('tab', { name: 'Auditoria' }).click();
    const audit = page.getByRole('tabpanel', { name: 'Auditoria' });
    await expect(audit.getByText('platform.store.suspend', { exact: true }).first()).toBeVisible();
    await expect(audit.getByText('platform.store.reactivate', { exact: true }).first()).toBeVisible();
  });
});
