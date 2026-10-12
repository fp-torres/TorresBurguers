import { test, expect, type Locator, type Page } from '@playwright/test';
import { signInAs } from '../../../support/web';
import {
  API_URL,
  Customer,
  StaffApi,
  fieldByLabel,
  money,
  pageHeading,
  sidebar,
  tableRow,
  textFile,
  tinyPng,
  toast,
  trackApiWrites,
  uid,
  waitForApi,
  type ApiAddon,
} from './helpers';

let admin: StaffApi;
let addonA: ApiAddon;
let addonB: ApiAddon;
const createdProducts: number[] = [];
const createdAddons: number[] = [];

test.beforeAll(async () => {
  admin = await StaffApi.as('admin');
  addonA = await admin.createAddon(`Bacon WA ${uid('a')}`, 4.5);
  addonB = await admin.createAddon(`Cheddar WA ${uid('b')}`, 3);
  createdAddons.push(addonA.id, addonB.id);
});

test.afterAll(async () => {
  // Limpeza gentil: só exclusão lógica (lixeira) do que este arquivo criou
  for (const id of createdProducts) await admin.ctx.delete(`/products/${id}`);
  for (const id of createdAddons) await admin.ctx.delete(`/addons/${id}`);
  await admin.dispose();
});

async function createProduct(input: Parameters<StaffApi['createProduct']>[0]) {
  const product = await admin.createProduct(input);
  createdProducts.push(product.id);
  return product;
}

async function openProducts(page: Page) {
  await signInAs(page, 'admin');
  await page.goto('/products');
  await expect(pageHeading(page, 'Cardápio')).toBeVisible({ timeout: 20_000 });
}

function productDialog(page: Page, title: 'Novo Produto' | 'Editar Produto'): Locator {
  return page.getByRole('dialog', { name: title });
}

async function isMissing(field: Locator): Promise<boolean> {
  return field.evaluate((el) => (el as HTMLInputElement).validity.valueMissing);
}

test.describe('Cardápio (administrador)', () => {
  test('administrador cria produto com imagem pelo seletor de arquivos, adicionais e ingredientes', async ({ page }, testInfo) => {
    const name = `Burger WA ${uid('p')}`;
    const newAddonName = `Molho WA ${uid('m')}`;
    await openProducts(page);
    await page.getByRole('button', { name: 'Novo Produto' }).click();
    const dialog = productDialog(page, 'Novo Produto');
    await expect(dialog).toBeVisible();

    // Imagem pelo seletor de arquivos do sistema
    const chooserPromise = page.waitForEvent('filechooser');
    await dialog.getByText('Alterar Imagem').click();
    const chooser = await chooserPromise;
    expect(chooser.isMultiple()).toBe(false);
    await chooser.setFiles(tinyPng(testInfo));
    await expect(dialog.getByRole('img', { name: 'Imagem do produto' })).toBeVisible();

    await fieldByLabel(dialog, 'Nome').fill(name);
    await fieldByLabel(dialog, 'Preço').fill('3290');
    await expect(fieldByLabel(dialog, 'Preço')).toHaveValue(money(32.9));
    await fieldByLabel(dialog, 'Categoria').selectOption('hamburgueres');
    await fieldByLabel(dialog, 'Ingredientes').fill('Pão brioche, Carne 180g, Queijo prato');
    await fieldByLabel(dialog, 'Descrição').fill('Criado pelo teste do painel');

    // Um adicional existente e um novo criado no próprio formulário (entra já selecionado)
    await dialog.getByText(addonA.name, { exact: true }).click();
    await expect(dialog.getByText('1 selecionado(s)')).toBeVisible();
    const newAddonInput = dialog.getByPlaceholder(/^Novo item em/);
    await newAddonInput.fill(newAddonName);
    await newAddonInput.locator('xpath=following-sibling::input[1]').fill('250');
    const addonResponse = waitForApi(page, 'POST', '/addons');
    await dialog.getByRole('button', { name: 'Adicionar', exact: true }).click();
    const newAddon = (await (await addonResponse).json()) as ApiAddon;
    createdAddons.push(newAddon.id);
    await expect(toast(page, 'Adicional criado!')).toBeVisible();
    await expect(dialog.getByText('2 selecionado(s)')).toBeVisible();
    expect(Number(newAddon.price)).toBe(2.5);

    const createResponse = waitForApi(page, 'POST', '/products');
    await dialog.getByRole('button', { name: 'Criar Produto' }).click();
    const res = await createResponse;
    expect(res.status(), await res.text()).toBe(201);
    const { id } = (await res.json()) as { id: number };
    createdProducts.push(id);
    await expect(toast(page, 'Produto criado!')).toBeVisible();
    await expect(dialog).toBeHidden();

    const row = tableRow(page, name);
    await expect(row).toBeVisible();
    await expect(row).toContainText('Hambúrgueres');
    await expect(row).toContainText(money(32.9));
    await expect(row.getByRole('button', { name: 'Disponível' })).toBeVisible();
    await expect(row.getByRole('img', { name })).toHaveAttribute('src', new RegExp(`^${API_URL}/uploads/.+\\.webp$`));

    const product = await admin.getProduct(id);
    expect(Number(product.price)).toBe(32.9);
    expect(product.category).toBe('hamburgueres');
    expect(product.description).toBe('Criado pelo teste do painel');
    expect(product.ingredients).toEqual(['Pão brioche', 'Carne 180g', 'Queijo prato']);
    expect(product.allowed_addons.map((a) => a.id).sort((a, b) => a - b)).toEqual([addonA.id, newAddon.id].sort((a, b) => a - b));
    expect(product.image).toMatch(/\.webp$/);
    const image = await admin.ctx.get(`/uploads/${product.image}`);
    expect(image.status()).toBe(200);
    expect(image.headers()['content-type']).toContain('image/webp');
  });

  test('produto com um único adicional selecionado fica ligado exatamente a esse adicional', async ({ page }) => {
    const name = `Unico WA ${uid('p')}`;
    await openProducts(page);
    await page.getByRole('button', { name: 'Novo Produto' }).click();
    const dialog = productDialog(page, 'Novo Produto');
    await fieldByLabel(dialog, 'Nome').fill(name);
    await fieldByLabel(dialog, 'Preço').fill('1500');
    await fieldByLabel(dialog, 'Categoria').selectOption('acompanhamentos');
    await dialog.getByText(addonB.name, { exact: true }).click();
    await expect(dialog.getByText('1 selecionado(s)')).toBeVisible();

    const createResponse = waitForApi(page, 'POST', '/products');
    await dialog.getByRole('button', { name: 'Criar Produto' }).click();
    const res = await createResponse;
    expect(res.status(), await res.text()).toBe(201);
    const { id } = (await res.json()) as { id: number };
    createdProducts.push(id);
    await expect(tableRow(page, name)).toContainText('Acompanhamentos');

    const product = await admin.getProduct(id);
    expect(product.allowed_addons.map((a) => a.id)).toEqual([addonB.id]);
    expect(product.ingredients ?? []).toEqual([]);
    expect(product.image).toBeNull();
  });

  test('editar produto muda o preço e limpa os adicionais', async ({ page }) => {
    const product = await createProduct({
      name: `Edit WA ${uid('p')}`,
      price: 25,
      allowed_addons_ids: [addonA.id, addonB.id],
      ingredients: ['Pão', 'Carne'],
    });
    await openProducts(page);
    const row = tableRow(page, product.name);
    await row.getByRole('button', { name: 'Editar' }).click();
    const dialog = productDialog(page, 'Editar Produto');
    await expect(fieldByLabel(dialog, 'Nome')).toHaveValue(product.name);
    await expect(fieldByLabel(dialog, 'Preço')).toHaveValue(money(25));
    await expect(fieldByLabel(dialog, 'Ingredientes')).toHaveValue('Pão, Carne');
    await expect(dialog.getByText('2 selecionado(s)')).toBeVisible();

    await fieldByLabel(dialog, 'Preço').fill('4590');
    await expect(fieldByLabel(dialog, 'Preço')).toHaveValue(money(45.9));
    await dialog.getByRole('button', { name: 'Todos', exact: true }).click();
    await dialog.getByText(addonA.name, { exact: true }).click();
    await dialog.getByText(addonB.name, { exact: true }).click();
    await expect(dialog.getByText('Selecione ou crie novos')).toBeVisible();

    const save = waitForApi(page, 'PATCH', `/products/${product.id}`);
    await dialog.getByRole('button', { name: 'Salvar Alterações' }).click();
    const res = await save;
    expect(res.status(), await res.text()).toBe(200);
    await expect(toast(page, 'Produto atualizado!')).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(row).toContainText(money(45.9));

    const updated = await admin.getProduct(product.id);
    expect(Number(updated.price)).toBe(45.9);
    expect(updated.allowed_addons).toEqual([]);
    expect(updated.ingredients).toEqual(['Pão', 'Carne']);
    expect(updated.name).toBe(product.name);
  });

  test('editar produto limpa os ingredientes e define e depois remove o preço promocional', async ({ page }) => {
    const product = await createProduct({ name: `Promo WA ${uid('p')}`, price: 30, ingredients: ['Alface', 'Tomate'] });
    await openProducts(page);
    const row = tableRow(page, product.name);

    await row.getByRole('button', { name: 'Editar' }).click();
    let dialog = productDialog(page, 'Editar Produto');
    await fieldByLabel(dialog, 'Ingredientes').fill('');
    await fieldByLabel(dialog, 'Preço Promocional').fill('2490');
    let save = waitForApi(page, 'PATCH', `/products/${product.id}`);
    await dialog.getByRole('button', { name: 'Salvar Alterações' }).click();
    expect((await save).status()).toBe(200);
    await expect(dialog).toBeHidden();
    await expect(row.getByTitle('Preço promocional')).toHaveText(money(24.9));
    let updated = await admin.getProduct(product.id);
    expect(updated.ingredients ?? []).toEqual([]);
    expect(Number(updated.promotion_price)).toBe(24.9);

    await row.getByRole('button', { name: 'Editar' }).click();
    dialog = productDialog(page, 'Editar Produto');
    await expect(fieldByLabel(dialog, 'Preço Promocional')).toHaveValue(money(24.9));
    await expect(fieldByLabel(dialog, 'Ingredientes')).toHaveValue('');
    await fieldByLabel(dialog, 'Preço Promocional').fill('');
    save = waitForApi(page, 'PATCH', `/products/${product.id}`);
    await dialog.getByRole('button', { name: 'Salvar Alterações' }).click();
    expect((await save).status()).toBe(200);
    await expect(dialog).toBeHidden();
    await expect(row.getByTitle('Preço promocional')).toHaveCount(0);
    await expect(row).toContainText(money(30));
    updated = await admin.getProduct(product.id);
    expect(updated.promotion_price).toBeNull();
  });

  test('pausar e reativar a disponibilidade do produto', async ({ page }) => {
    const product = await createProduct({ name: `Disp WA ${uid('p')}`, price: 12 });
    await openProducts(page);

    const pause = waitForApi(page, 'PATCH', `/products/${product.id}`);
    await tableRow(page, product.name).getByRole('button', { name: 'Disponível' }).click();
    expect((await pause).status()).toBe(200);
    await expect(toast(page, 'Produto Pausado!')).toBeVisible();
    await expect(tableRow(page, product.name).getByRole('button', { name: 'Esgotado' })).toBeVisible();
    expect((await admin.getProduct(product.id)).available).toBe(false);

    // O estado vem da API (persistiu)
    await page.reload();
    const row = tableRow(page, product.name);
    await expect(row.getByRole('button', { name: 'Esgotado' })).toBeVisible({ timeout: 20_000 });

    const resume = waitForApi(page, 'PATCH', `/products/${product.id}`);
    await row.getByRole('button', { name: 'Esgotado' }).click();
    expect((await resume).status()).toBe(200);
    await expect(toast(page, 'Produto Ativado!')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Disponível' })).toBeVisible();
    expect((await admin.getProduct(product.id)).available).toBe(true);
  });

  test('mover produto para a lixeira e restaurar pela Lixeira do sistema', async ({ page }) => {
    const product = await createProduct({ name: `Lixo WA ${uid('p')}`, price: 15, description: 'Vai e volta da lixeira' });
    await openProducts(page);

    const row = tableRow(page, product.name);
    await row.getByRole('button', { name: 'Mover para Lixeira' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Mover para Lixeira?' });
    await expect(confirm).toContainText(product.name);
    const del = waitForApi(page, 'DELETE', `/products/${product.id}`);
    await confirm.getByRole('button', { name: 'Mover para Lixeira' }).click();
    expect((await del).status()).toBe(200);
    await expect(toast(page, 'Produto movido para a lixeira.')).toBeVisible();
    await expect(row).toHaveCount(0);
    expect((await admin.ctx.get(`/products/${product.id}`)).status(), 'fora do cardápio público').toBe(404);

    await sidebar(page).getByRole('link', { name: 'Lixeira' }).click();
    await expect(pageHeading(page, 'Lixeira do Sistema')).toBeVisible({ timeout: 20_000 });
    const trashRow = tableRow(page, product.name);
    await expect(trashRow).toContainText(`ID: ${product.id}`);
    await expect(trashRow).toContainText('Vai e volta da lixeira');
    await trashRow.getByRole('button', { name: 'Restaurar' }).click();
    const restore = page.getByRole('alertdialog', { name: 'Restaurar Item?' });
    await expect(restore).toContainText(`O produto "${product.name}" voltará para o cardápio.`);
    const res = waitForApi(page, 'PATCH', `/products/${product.id}/restore`);
    await restore.getByRole('button', { name: 'Sim, Restaurar' }).click();
    expect((await res).status()).toBe(200);
    await expect(toast(page, 'Item restaurado com sucesso!')).toBeVisible();
    await expect(trashRow).toHaveCount(0);

    await sidebar(page).getByRole('link', { name: 'Cardápio' }).click();
    await expect(tableRow(page, product.name)).toBeVisible({ timeout: 20_000 });
    expect((await admin.getProduct(product.id)).available).toBe(true);
  });

  test('restaurar pela aba Lixeira do Cardápio mantém esgotado o produto que estava pausado', async ({ page }) => {
    const product = await createProduct({ name: `Pausado WA ${uid('p')}`, price: 9, available: false });
    await admin.softDeleteProduct(product.id);
    await openProducts(page);

    await page.getByRole('button', { name: /^Lixeira/ }).click();
    await page.getByPlaceholder('Buscar na lixeira...').fill(product.name);
    const row = tableRow(page, product.name);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Restaurar' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Restaurar Produto?' });
    await expect(dialog).toContainText('continuará Esgotado até você ativá-lo');
    await dialog.getByRole('button', { name: 'Sim, Restaurar' }).click();
    await expect(toast(page, 'Produto restaurado!')).toBeVisible();
    await expect(row).toHaveCount(0);

    await page.getByRole('button', { name: /^Todos/ }).click();
    await expect(tableRow(page, product.name).getByRole('button', { name: 'Esgotado' })).toBeVisible();
    expect((await admin.getProduct(product.id)).available).toBe(false);
  });

  test('exclusão definitiva de produto usado em pedido mostra o motivo (409) e o mantém na Lixeira', async ({ page }) => {
    const product = await createProduct({ name: `Vendido WA ${uid('p')}`, price: 21 });
    const customer = await Customer.create();
    await customer.order({ items: [{ productId: product.id, quantity: 1 }], type: 'TAKEOUT', paymentMethod: 'MONEY' });
    await customer.dispose();
    await admin.softDeleteProduct(product.id);

    await signInAs(page, 'admin');
    await page.goto('/trash');
    const row = tableRow(page, product.name);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByRole('button', { name: 'Excluir', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Excluir Definitivamente?' });
    await expect(dialog).toContainText(product.name);
    const del = waitForApi(page, 'DELETE', `/products/${product.id}/permanent`);
    await dialog.getByRole('button', { name: 'Sim, Excluir' }).click();
    expect((await del).status()).toBe(409);
    await expect(toast(page, 'Este produto aparece em pedidos e não pode ser excluído permanentemente')).toBeVisible();
    await expect(row).toBeVisible();
    expect((await admin.productTrash()).some((p) => p.id === product.id)).toBe(true);
  });

  test('aba Lixeira do Cardápio: apagar para sempre remove produto sem pedidos e explica o bloqueio do produto vendido', async ({ page }) => {
    const tag = uid('perm');
    const unused = await createProduct({ name: `Nunca vendido ${tag}`, price: 5 });
    const sold = await createProduct({ name: `Ja vendido ${tag}`, price: 6 });
    const customer = await Customer.create();
    await customer.order({ items: [{ productId: sold.id, quantity: 2 }], type: 'TAKEOUT', paymentMethod: 'MONEY' });
    await customer.dispose();
    await admin.softDeleteProduct(unused.id);
    await admin.softDeleteProduct(sold.id);

    await openProducts(page);
    await page.getByRole('button', { name: /^Lixeira/ }).click();
    await page.getByPlaceholder('Buscar na lixeira...').fill(tag);
    await expect(page.getByRole('row').filter({ hasText: tag })).toHaveCount(2);

    // Produto vendido: 409 com o motivo
    await tableRow(page, sold.name).getByRole('button', { name: 'Excluir Definitivamente' }).click();
    let dialog = page.getByRole('alertdialog', { name: 'Excluir Permanentemente?' });
    await expect(dialog).toContainText(sold.name);
    let del = waitForApi(page, 'DELETE', `/products/${sold.id}/permanent`);
    await dialog.getByRole('button', { name: 'Apagar para Sempre' }).click();
    expect((await del).status()).toBe(409);
    await expect(toast(page, 'Este produto aparece em pedidos e não pode ser excluído permanentemente')).toBeVisible();
    await expect(tableRow(page, sold.name)).toBeVisible();

    // Produto sem pedidos: apagado de vez
    await tableRow(page, unused.name).getByRole('button', { name: 'Excluir Definitivamente' }).click();
    dialog = page.getByRole('alertdialog', { name: 'Excluir Permanentemente?' });
    del = waitForApi(page, 'DELETE', `/products/${unused.id}/permanent`);
    await dialog.getByRole('button', { name: 'Apagar para Sempre' }).click();
    expect((await del).status()).toBe(200);
    await expect(toast(page, 'Produto excluído definitivamente.')).toBeVisible();
    await expect(tableRow(page, unused.name)).toHaveCount(0);
    expect((await admin.productTrash()).some((p) => p.id === unused.id)).toBe(false);
    expect((await admin.ctx.get(`/products/${unused.id}`)).status()).toBe(404);
  });

  test('formulário de produto exige nome e preço e não envia nada à API enquanto inválido', async ({ page }) => {
    await openProducts(page);
    const writes = trackApiWrites(page);
    await page.getByRole('button', { name: 'Novo Produto' }).click();
    const dialog = productDialog(page, 'Novo Produto');
    const submit = dialog.getByRole('button', { name: 'Criar Produto' });

    await submit.click();
    await expect(dialog).toBeVisible();
    expect(await isMissing(fieldByLabel(dialog, 'Nome')), 'nome obrigatório').toBe(true);

    await fieldByLabel(dialog, 'Nome').fill(`Sem preço ${uid('p')}`);
    await submit.click();
    await expect(dialog).toBeVisible();
    expect(await isMissing(fieldByLabel(dialog, 'Preço')), 'preço obrigatório').toBe(true);

    // Nome só com espaços passa no "required" do navegador, mas o formulário recusa
    await fieldByLabel(dialog, 'Nome').fill('   ');
    await fieldByLabel(dialog, 'Preço').fill('1000');
    await submit.click();
    await expect(toast(page, 'Informe o nome do produto.')).toBeVisible();
    await expect(dialog).toBeVisible();
    expect(writes, 'nenhuma escrita na API').toEqual([]);
  });

  test('preço promocional maior ou igual ao preço é recusado antes de enviar', async ({ page }) => {
    await openProducts(page);
    const writes = trackApiWrites(page);
    await page.getByRole('button', { name: 'Novo Produto' }).click();
    const dialog = productDialog(page, 'Novo Produto');
    await fieldByLabel(dialog, 'Nome').fill(`Promo inválida ${uid('p')}`);
    await fieldByLabel(dialog, 'Preço').fill('2000');

    for (const promo of ['2000', '2500']) {
      await fieldByLabel(dialog, 'Preço Promocional').fill(promo);
      await dialog.getByRole('button', { name: 'Criar Produto' }).click();
      await expect(toast(page, 'O preço promocional deve ser menor que o preço normal.')).toBeVisible();
      await expect(dialog).toBeVisible();
    }
    expect(writes).toEqual([]);
  });

  test('arquivo que não é imagem é recusado pelo seletor de imagem do produto', async ({ page }, testInfo) => {
    await openProducts(page);
    await page.getByRole('button', { name: 'Novo Produto' }).click();
    const dialog = productDialog(page, 'Novo Produto');
    const chooserPromise = page.waitForEvent('filechooser');
    await dialog.getByText('Alterar Imagem').click();
    await (await chooserPromise).setFiles(textFile(testInfo));
    await expect(toast(page, 'Use uma imagem JPG, PNG ou WebP.')).toBeVisible();
    await expect(dialog.getByRole('img', { name: 'Imagem do produto' })).toHaveCount(0);
  });

  test('cancelar um cadastro com imagem não reaproveita a imagem ao editar outro produto', async ({ page }, testInfo) => {
    const product = await createProduct({ name: `SemFoto WA ${uid('p')}`, price: 10 });
    await openProducts(page);

    await page.getByRole('button', { name: 'Novo Produto' }).click();
    const createDialog = productDialog(page, 'Novo Produto');
    const chooserPromise = page.waitForEvent('filechooser');
    await createDialog.getByText('Alterar Imagem').click();
    await (await chooserPromise).setFiles(tinyPng(testInfo));
    await expect(createDialog.getByRole('img', { name: 'Imagem do produto' })).toBeVisible();
    await createDialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(createDialog).toBeHidden();

    await tableRow(page, product.name).getByRole('button', { name: 'Editar' }).click();
    const editDialog = productDialog(page, 'Editar Produto');
    await expect(editDialog.getByRole('img', { name: 'Imagem do produto' })).toHaveCount(0);
    await fieldByLabel(editDialog, 'Preço').fill('1100');
    const save = waitForApi(page, 'PATCH', `/products/${product.id}`);
    await editDialog.getByRole('button', { name: 'Salvar Alterações' }).click();
    expect((await save).status()).toBe(200);
    const updated = await admin.getProduct(product.id);
    expect(updated.image).toBeNull();
    expect(Number(updated.price)).toBe(11);
  });

  test('busca e abas de categoria filtram a tabela do cardápio', async ({ page }) => {
    const tag = uid('busca');
    const burger = await createProduct({ name: `Alpha ${tag}`, price: 20, category: 'hamburgueres' });
    const drink = await createProduct({ name: `Beta ${tag}`, price: 8, category: 'bebidas' });
    await openProducts(page);

    const search = page.getByPlaceholder('Buscar produto...');
    await search.fill(tag);
    await expect(page.getByRole('row').filter({ hasText: tag })).toHaveCount(2);

    await page.getByRole('button', { name: /^Bebidas/ }).click();
    await expect(tableRow(page, drink.name)).toBeVisible();
    await expect(tableRow(page, burger.name)).toHaveCount(0);
    await expect(tableRow(page, drink.name)).toContainText('Bebidas');

    await page.getByRole('button', { name: /^Todos/ }).click();
    await search.fill(burger.name);
    await expect(page.getByRole('row').filter({ hasText: tag })).toHaveCount(1);
    await search.fill(`nada-${tag}`);
    await expect(page.getByText('Nenhum produto encontrado.')).toBeVisible();
  });
});
