import { test, expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { contextAs, login } from '../../../support/api';
import { expectCookieSession } from '../../../support/web';
import {
  API_URL,
  STORAGE_KEYS,
  addToCart,
  cartLine,
  createClient,
  demoStore,
  loginViaUI,
  openCart,
  openHome,
  readStorage,
  searchBox,
  seedCatalog,
  storePath,
  storeUrl,
  storedCartItems,
  trackRequests,
  useSession,
  waitForStoreOpen,
  type Catalog,
  type TestClient,
} from './helpers';

let catalog: Catalog;
const clients: TestClient[] = [];

test.beforeAll(async () => {
  catalog = await seedCatalog();
});

test.afterEach(async () => {
  while (clients.length) await clients.pop()!.api.dispose();
});

async function newClient(name: string): Promise<TestClient> {
  const client = await createClient({ name });
  clients.push(client);
  return client;
}

/**
 * Campos de "Meus Dados" (rótulos sem htmlFor: localizados pelo rótulo vizinho). A senha fica no formulário
 * "Trocar senha" da seção "Segurança da conta" (POST /account/password, com a senha atual).
 */
function profileFields(page: Page) {
  const passwordForm = page.getByRole('form', { name: 'Trocar senha' });
  return {
    name: page.locator('label:text-is("Nome") + div input'),
    phone: page.locator('label:text-is("Celular") + div input'),
    email: page.locator('label:text-is("E-mail") + div input'),
    currentPassword: passwordForm.getByLabel('Senha atual'),
    newPassword: passwordForm.getByLabel(/^Nova senha\s*\*?$/),
    confirmPassword: passwordForm.getByLabel('Confirmar nova senha'),
    savePassword: passwordForm.getByRole('button', { name: 'Salvar nova senha' }),
    save: page.getByRole('button', { name: 'Salvar Alterações' }),
  };
}

const SESSION_EXPIRED = 'Sua sessão expirou. Faça login novamente.';

test.describe('Meus Dados', () => {
  test('editar nome e telefone salva no servidor, atualiza o cabeçalho e continua após recarregar', async ({ page }) => {
    const client = await newClient('Cliente Perfil');
    await useSession(page, client.session);
    await page.goto('/profile');
    const field = profileFields(page);

    await expect(page.getByRole('heading', { name: /Meus Dados/ })).toBeVisible();
    await expect(field.name).toHaveValue('Cliente Perfil');
    await expect(field.email).toHaveValue(client.email);
    await expect(field.email).not.toBeEditable();

    const newName = `Maria Perfil ${Date.now().toString(36)}`;
    await field.name.fill(newName);
    await field.phone.fill('21977776666');
    await expect(field.phone).toHaveValue('(21) 97777-6666');

    const patch = page.waitForResponse((r) => r.url() === `${API_URL}/users/${client.session.user.id}` && r.request().method() === 'PATCH');
    await field.save.click();
    const response = await patch;
    expect(response.status()).toBe(200);
    expect(JSON.stringify(await response.json())).not.toMatch(/password/i);
    await expect(page.getByText('Perfil atualizado com sucesso!')).toBeVisible();

    await page.getByRole('button', { name: 'Menu da conta' }).click();
    await expect(page.getByText(newName, { exact: true })).toBeVisible();

    await page.reload();
    await expect(field.name).toHaveValue(newName);
    await expect(field.phone).toHaveValue('(21) 97777-6666');

    const server = await (await client.api.get(`/users/${client.session.user.id}`)).json();
    expect(server.name).toBe(newName);
    expect(String(server.phone).replace(/\D/g, '')).toBe('21977776666');
  });

  test('sem alterações, senha fraca ou confirmação diferente não chamam a API', async ({ page }) => {
    const client = await newClient('Cliente Regras');
    await useSession(page, client.session);
    const patches = trackRequests(
      page,
      (method, path) => (method === 'PATCH' && path.startsWith('/users/')) || path === '/account/password',
    );
    await page.goto('/profile');
    const field = profileFields(page);

    await field.save.click();
    await expect(page.getByText('Nenhuma alteração para salvar!')).toBeVisible();

    await field.currentPassword.fill(client.password);
    await field.newPassword.fill('fraca');
    await expect(page.getByText('Mínimo de 9 caracteres')).toBeVisible();
    await field.savePassword.click();
    await expect(
      page.getByText('A senha precisa ter no mínimo 9 caracteres, uma letra maiúscula e um número ou símbolo.'),
    ).toBeVisible();

    await field.newPassword.fill('SenhaForte@1');
    await field.confirmPassword.fill('SenhaForte@2');
    await field.savePassword.click();
    await expect(page.getByText('A confirmação não confere com a nova senha.')).toBeVisible();

    expect(patches).toEqual([]);
    const anon = await request.newContext({ baseURL: API_URL });
    await login(anon, client.email, client.password); // a senha antiga continua valendo
    await anon.dispose();
  });

  test('trocar a senha funciona, mantém esta sessão com o token novo, encerra as outras e a senha nunca vai para o localStorage', async ({ page }) => {
    const client = await newClient('Rita Senha');
    // Login pela tela: sessão do site em cookie (o token de acesso fica só na memória da aba)
    const loggedIn = page.waitForResponse((r) => r.url() === `${API_URL}/auth/login` && r.request().method() === 'POST');
    await loginViaUI(page, client.email, client.password);
    const tokenBefore = (await (await loggedIn).json()).access_token as string;
    // Sem loja visitada antes, o cliente cai no diretório de lojas
    await expect(page).toHaveURL(/\/$/);
    await expectCookieSession(page);
    const markerBefore = JSON.parse((await readStorage(page))[STORAGE_KEYS.session]);
    expect(tokenBefore).toBeTruthy();

    await page.getByRole('button', { name: 'Menu da conta' }).click();
    await page.getByRole('link', { name: 'Meus Dados' }).click();
    await expect(page).toHaveURL(/\/profile$/);

    const newPassword = 'NovaSenha@2026';
    const field = profileFields(page);
    // Troca da senha em "Segurança da conta": com a senha atual (POST /account/password)
    await field.currentPassword.fill(client.password);
    await field.newPassword.fill(newPassword);
    await field.confirmPassword.fill(newPassword);
    const changed = page.waitForResponse((r) => r.url() === `${API_URL}/account/password` && r.request().method() === 'POST');
    await field.savePassword.click();
    const response = await changed;
    expect(response.status()).toBe(200);
    const changedSession = await response.json();
    expect(JSON.stringify(changedSession.user)).not.toMatch(/password/i);
    // Na sessão em cookie, a sessão nova também vem em cookie
    expect(changedSession.session_transport).toBe('cookie');
    await expect(page.getByText('Senha alterada. As sessões em outros aparelhos foram encerradas.')).toBeVisible();

    const storage = await readStorage(page);
    for (const [key, value] of Object.entries(storage)) {
      expect(value, `localStorage[${key}]`).not.toMatch(/password|\$2[aby]\$/i);
      expect(value, `localStorage[${key}]`).not.toContain(newPassword);
      expect(value, `localStorage[${key}]`).not.toContain(client.password);
    }
    // Sessão guardada por lista de campos permitidos (SessionUser + support_session)
    const storedUser = JSON.parse(storage[STORAGE_KEYS.user]);
    const allowed = ['id', 'name', 'email', 'role', 'phone', 'avatar', 'store_id', 'platform_role', 'store', 'support_session'];
    expect(Object.keys(storedUser).filter((key) => !allowed.includes(key))).toEqual([]);
    expect(storedUser).toMatchObject({ id: client.session.user.id, role: 'CLIENT', store_id: null, platform_role: null });

    // A troca da senha encerra as outras sessões: esta continua com a sessão nova (marcador novo, token só em memória)
    await expectCookieSession(page);
    expect(JSON.parse(storage[STORAGE_KEYS.session]).sid, 'sessão nova').not.toBe(markerBefore.sid);
    const tokenAfter = changedSession.access_token as string;
    expect(tokenAfter).not.toBe(tokenBefore);
    const anon = await request.newContext({ baseURL: API_URL });
    expect((await anon.get('/addresses', { headers: { Authorization: `Bearer ${tokenAfter}` } })).status()).toBe(200);
    expect((await anon.get('/addresses', { headers: { Authorization: `Bearer ${tokenBefore}` } })).status()).toBe(401);
    expect((await client.api.get('/addresses')).status(), 'a sessão aberta antes (outro dispositivo) caiu').toBe(401);
    await page.reload();
    await expect(profileFields(page).name).toHaveValue('Rita Senha');

    const old = await anon.post('/auth/login', { data: { email: client.email, password: client.password } });
    expect(old.status()).toBe(401);
    await login(anon, client.email, newPassword);
    await anon.dispose();
  });
});

test.describe('Sessão e rotas protegidas', () => {
  test('Meus Pedidos e Meus Dados exigem login (e voltam para a mesma página depois de entrar)', async ({ page }) => {
    await page.goto('/my-orders');
    await expect(page).toHaveURL(/\/signin\?redirect=%2Fmy-orders$/);
    await page.goto('/profile');
    await expect(page).toHaveURL(/\/signin\?redirect=%2Fprofile$/);
    await expect(page.getByRole('heading', { name: /Bem-vindo de volta/ })).toBeVisible();

    const client = await newClient('Cliente Volta');
    await page.getByPlaceholder('seu@email.com').fill(client.email);
    await page.getByPlaceholder('******').fill(client.password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByRole('heading', { name: /Meus Dados/ })).toBeVisible();
  });

  test('token inválido no localStorage: a próxima ação protegida leva para /signin com aviso e o carrinho fica', async ({ page }) => {
    const client = await newClient('Cliente Token');
    await useSession(page, client.session);
    await openHome(page);
    await addToCart(page, catalog.drink.name);

    await page.evaluate((key) => localStorage.setItem(key, 'token-invalido'), STORAGE_KEYS.token);
    await page.getByRole('button', { name: 'Menu da conta' }).click();
    await page.getByRole('link', { name: 'Meus Pedidos' }).click();

    await expect(page).toHaveURL(/\/signin(\?|$)/);
    await expect(page.getByText(SESSION_EXPIRED)).toBeVisible();
    const storage = await readStorage(page);
    expect(storage[STORAGE_KEYS.token]).toBeUndefined();
    expect(storage[STORAGE_KEYS.user]).toBeUndefined();
    expect(await storedCartItems(page), 'o carrinho da loja continua salvo').toHaveLength(1);

    // Entrando de novo, o cliente volta para a página que tentou abrir, e o carrinho da loja continua lá
    await page.getByPlaceholder('seu@email.com').fill(client.email);
    await page.getByPlaceholder('******').fill(client.password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page).toHaveURL(/\/my-orders$/);
    await openCart(page);
    await expect(cartLine(page, catalog.drink.name)).toBeVisible();
  });

  test('token de uma conta excluída: salvar o perfil encerra a sessão e leva para /signin', async ({ page }) => {
    const client = await newClient('Cliente Excluído');
    const removed = await client.api.delete(`/users/${client.session.user.id}`);
    expect(removed.ok(), await removed.text()).toBeTruthy();

    await useSession(page, client.session);
    await page.goto('/profile');
    const field = profileFields(page);
    await field.name.fill('Outro Nome');
    await field.save.click();

    await expect(page).toHaveURL(/\/signin(\?|$)/);
    await expect(page.getByText(SESSION_EXPIRED)).toBeVisible();
    expect((await readStorage(page))[STORAGE_KEYS.token]).toBeUndefined();
  });

  test('sessão corrompida no localStorage é descartada e a loja abre como visitante', async ({ page }) => {
    await page.addInitScript((keys) => {
      if (!sessionStorage.getItem('__e2e_corrupted')) {
        localStorage.setItem(keys.token, 'abc');
        localStorage.setItem(keys.user, '{corrompido');
        sessionStorage.setItem('__e2e_corrupted', '1');
      }
    }, STORAGE_KEYS);
    await openHome(page);

    await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
    const storage = await readStorage(page);
    expect(storage[STORAGE_KEYS.token]).toBeUndefined();
    expect(storage[STORAGE_KEYS.user]).toBeUndefined();
  });

  test('endereço desconhecido do site mostra a página 404 com link para o início (diretório de lojas)', async ({ page }) => {
    await page.goto('/pedido/nao-existe');
    await expect(page.getByText('ERRO 404', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Página não encontrada' })).toBeVisible();
    await expect(page.getByText('/pedido/nao-existe', { exact: true })).toBeVisible();
    await expect(page.getByRole('banner').getByRole('link', { name: 'Página inicial' })).toBeVisible();

    await page.getByRole('link', { name: 'Ir para o início' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1, name: /estabelecimentos/ })).toBeVisible();
  });

  test('endereço desconhecido dentro da loja mostra a 404 com o cabeçalho da loja e link para o cardápio', async ({ page }) => {
    const store = await demoStore();
    await page.goto(`${storePath()}/pedido/nao-existe`);
    await expect(page.getByRole('heading', { name: 'Página não encontrada' })).toBeVisible();
    await expect(page.getByRole('banner').getByRole('link', { name: `${store.name}: cardápio` })).toBeVisible();

    await page.getByRole('link', { name: 'Ir para o cardápio' }).click();
    await expect(page).toHaveURL(storeUrl());
    await expect(searchBox(page)).toBeVisible();
  });

  test('loja inexistente mostra "Loja não encontrada" com atalho para os estabelecimentos', async ({ page }) => {
    await page.goto('/loja/loja-que-nao-existe-e2e');
    await expect(page.getByRole('heading', { level: 1, name: 'Loja não encontrada' })).toBeVisible();
    await expect(page.getByText('loja-que-nao-existe-e2e', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Ver estabelecimentos' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('endereços antigos /cart e /order-success levam à última loja visitada (sem loja visitada, ao diretório)', async ({ page }) => {
    await page.goto('/cart');
    await expect(page).toHaveURL(/\/$/);

    await openHome(page);
    await addToCart(page, catalog.drink.name);
    await page.goto('/cart');
    await expect(page).toHaveURL(storeUrl('cart'));
    await expect(page.getByRole('heading', { name: 'Carrinho', level: 1, exact: true })).toBeVisible();
    await expect(cartLine(page, catalog.drink.name)).toBeVisible();
    await page.goto('/order-success');
    await expect(page).toHaveURL(storeUrl('order-success'));
    await expect(page.getByRole('heading', { name: 'Acompanhe seus pedidos' })).toBeVisible();
  });
});

test.describe('Meus Pedidos: acompanhamento', () => {
  let admin: APIRequestContext;

  test.beforeAll(async () => {
    admin = (await contextAs('admin')).ctx;
  });

  test.afterAll(async () => {
    await admin?.dispose();
  });

  async function createOrder(client: TestClient, type: 'TAKEOUT' | 'DELIVERY', addressId?: number): Promise<any> {
    await waitForStoreOpen();
    const res = await client.api.post('/orders', {
      data: { items: [{ productId: catalog.drink.id, quantity: 1 }], type, paymentMethod: 'MONEY', ...(addressId ? { addressId } : {}) },
    });
    expect(res.status(), await res.text()).toBe(201);
    return res.json();
  }

  async function moveTo(orderId: number, status: string): Promise<void> {
    const res = await admin.patch(`/orders/${orderId}`, { data: { status } });
    expect(res.ok(), `PATCH /orders/${orderId} → ${status}: ${await res.text()}`).toBeTruthy();
  }

  test('lista os pedidos do mais novo para o mais antigo e atualiza o status sozinha; só pedido novo pode ser cancelado', async ({ page }) => {
    const client = await newClient('Cliente Acompanha');
    const first = await createOrder(client, 'TAKEOUT');
    const second = await createOrder(client, 'TAKEOUT');

    await useSession(page, client.session);
    await page.goto('/my-orders');
    const headers = page.getByText(/^Pedido #\d+$/);
    await expect(headers).toHaveText([`Pedido #${second.number}`, `Pedido #${first.number}`]);
    await expect(page.getByText('Aguardando Confirmação', { exact: true })).toHaveCount(2);

    // A cozinha começa o preparo: a página atualiza sem recarregar (consulta a cada 10 s)
    await moveTo(second.id, 'PREPARING');
    await expect(page.getByText('Preparando', { exact: true })).toBeVisible({ timeout: 15_000 });

    await page.getByText(`Pedido #${second.number}`, { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Cancelar Pedido' })).toHaveCount(0);
    await page.getByText(`Pedido #${first.number}`, { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Cancelar Pedido' })).toHaveCount(1);
  });

  test('pedido de retirada pronto aparece como pronto para retirada, não "Pronto para Entrega"', async ({ page }) => {
    const client = await newClient('Cliente Balcão');
    const order = await createOrder(client, 'TAKEOUT');
    await moveTo(order.id, 'PREPARING');
    await moveTo(order.id, 'READY_FOR_PICKUP');

    await useSession(page, client.session);
    await page.goto('/my-orders');
    const header = page.getByText(`Pedido #${order.number}`, { exact: true }).locator('xpath=..');
    await expect(header).toContainText('· Retirada');
    // Selo de status do pedido (logo abaixo da data e do tipo)
    const statusBadge = header.locator('xpath=./span');
    await expect(statusBadge).not.toHaveText('Aguardando Confirmação');
    await expect(statusBadge).not.toHaveText('Pronto para Entrega');
    await expect(statusBadge).toHaveText(/retirada|retirar|balcão/i);
  });
});
