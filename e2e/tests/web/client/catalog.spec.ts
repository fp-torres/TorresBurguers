import { test, expect } from '@playwright/test';
import {
  STORAGE_KEYS,
  addToCart,
  brl,
  cartLine,
  cartLink,
  menuSection,
  modalAddButton,
  money,
  openCart,
  openHome,
  openProduct,
  productCard,
  quantityValue,
  readStorage,
  searchBox,
  searchFor,
  seedCatalog,
  summaryValue,
  type Catalog,
} from './helpers';

let catalog: Catalog;

test.beforeAll(async () => {
  catalog = await seedCatalog();
});

test.describe('Cardápio da vitrine', () => {
  test('lista os produtos disponíveis com imagem e preço e esconde os indisponíveis e os da lixeira', async ({ page }) => {
    await openHome(page);
    await searchFor(page, catalog.tag);

    const menu = menuSection(page);
    for (const product of [catalog.burger, catalog.drink, catalog.promo, catalog.combo]) {
      await expect(menu.getByRole('heading', { name: product.name, exact: true })).toBeVisible();
    }
    await expect(menu.getByRole('heading', { name: catalog.unavailable.name })).toHaveCount(0);
    await expect(menu.getByRole('heading', { name: catalog.removed.name })).toHaveCount(0);
    await expect(page.getByText(`4 resultados para "${catalog.tag}" em todo o cardápio`)).toBeVisible();

    // Preço e imagem servida pela API (/uploads)
    const burgerCard = productCard(page, catalog.burger.name);
    await expect(burgerCard).toContainText(brl(catalog.burger.price));
    const image = burgerCard.getByRole('img', { name: catalog.burger.name, exact: true });
    await image.scrollIntoViewIfNeeded();
    await expect(image).toHaveAttribute('src', /\/uploads\/.+/);
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), { message: 'imagem do produto carregada' })
      .toBe(true);
  });

  test('categorias filtram a lista e a categoria padrão é Combos quando há combos', async ({ page }) => {
    await openHome(page);
    const menu = menuSection(page);
    const category = (name: string) => menu.getByRole('button', { name, exact: true });

    await expect(category('Combos')).toHaveAttribute('aria-pressed', 'true');
    await expect(menu.getByRole('heading', { name: catalog.combo.name })).toBeVisible();
    await expect(menu.getByRole('heading', { name: catalog.burger.name })).toHaveCount(0);

    await category('Bebidas').click();
    await expect(category('Bebidas')).toHaveAttribute('aria-pressed', 'true');
    await expect(category('Combos')).toHaveAttribute('aria-pressed', 'false');
    await expect(menu.getByRole('heading', { name: catalog.drink.name })).toBeVisible();
    await expect(menu.getByRole('heading', { name: catalog.burger.name })).toHaveCount(0);
    await expect(menu.getByRole('heading', { name: catalog.combo.name })).toHaveCount(0);

    await category('Burgers').click();
    await expect(menu.getByRole('heading', { name: catalog.burger.name })).toBeVisible();
    await expect(menu.getByRole('heading', { name: catalog.drink.name })).toHaveCount(0);

    await category('Acomp.').click();
    await expect(menu.getByRole('heading', { name: catalog.promo.name })).toBeVisible();
    await expect(menu.getByRole('heading', { name: catalog.burger.name })).toHaveCount(0);

    await category('Tudo').click();
    for (const product of [catalog.burger, catalog.drink, catalog.promo, catalog.combo]) {
      await expect(menu.getByRole('heading', { name: product.name, exact: true })).toBeVisible();
    }
  });

  test('busca ignora acentos e maiúsculas, procura na descrição e avisa quando nada é encontrado', async ({ page }) => {
    await openHome(page);
    const menu = menuSection(page);

    // "Hambúrguer" com acento é encontrado digitando sem acento e em maiúsculas
    const unaccented = catalog.burger.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
    await searchFor(page, unaccented);
    await expect(page.getByText(`1 resultado para "${unaccented}"`)).toBeVisible();
    await expect(menu.getByRole('heading', { name: catalog.burger.name })).toBeVisible();

    // Palavra que só existe na descrição do suco
    await searchFor(page, catalog.descriptionWord);
    await expect(menu.getByRole('heading', { name: catalog.drink.name })).toBeVisible();
    await expect(page.getByText(`1 resultado para "${catalog.descriptionWord}"`)).toBeVisible();

    await searchFor(page, `nada-existe-${catalog.tag}`);
    await expect(page.getByText('Nenhum produto encontrado para esta busca.')).toBeVisible();
    await expect(page.getByText(`0 resultados para "nada-existe-${catalog.tag}"`)).toBeVisible();

    // Escolher uma categoria limpa a busca
    await menu.getByRole('button', { name: 'Tudo', exact: true }).click();
    await expect(searchBox(page)).toHaveValue('');
    await expect(menu.getByRole('heading', { name: catalog.burger.name })).toBeVisible();
  });

  test('produto em promoção mostra o preço cheio riscado, o promocional e aparece em Imperdíveis', async ({ page }) => {
    await openHome(page);

    const imperdiveis = page.locator('section', { has: page.getByRole('heading', { name: 'Imperdíveis' }) });
    await expect(imperdiveis.getByRole('heading', { name: catalog.promo.name })).toBeVisible();

    await searchFor(page, catalog.promo.name);
    const card = productCard(page, catalog.promo.name);
    await expect(card.getByText('OFERTA', { exact: true })).toBeVisible();
    await expect(card.getByText(brl(15), { exact: true })).toBeVisible();
    const fullPrice = card.getByText(brl(20), { exact: true });
    await expect(fullPrice).toBeVisible();
    await expect(fullPrice).toHaveCSS('text-decoration-line', 'line-through');

    const dialog = await openProduct(page, catalog.promo.name);
    await expect(modalAddButton(dialog)).toContainText(brl(15));
  });
});

test.describe('Modal do produto', () => {
  test('hambúrguer: ponto da carne, retirar ingredientes, adicionais com quantidade e total atualizado', async ({ page }) => {
    await openHome(page);
    const dialog = await openProduct(page, catalog.burger.name);

    // Ponto da carne: três opções, "Ao Ponto" por padrão
    await expect(dialog.getByRole('heading', { name: 'Ponto da Carne' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Ao Ponto', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: 'Bem Passado', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Bem Passado', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByRole('button', { name: 'Ao Ponto', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(dialog.getByRole('button', { name: 'Mal Passado', exact: true })).toBeVisible();

    // Ingredientes que podem ser retirados
    await expect(dialog.getByRole('heading', { name: 'Retirar Ingredientes?' })).toBeVisible();
    for (const ingredient of catalog.burgerIngredients) {
      await expect(dialog.getByRole('checkbox', { name: ingredient, exact: true })).not.toBeChecked();
    }
    await dialog.getByRole('checkbox', { name: 'Cebola', exact: true }).check();

    // Adicionais: o pausado no painel não aparece
    await expect(dialog.getByText(catalog.pausedAddon.name)).toHaveCount(0);
    const addBacon = dialog.getByRole('button', { name: `Adicionar ${catalog.bacon.name}`, exact: true });
    const removeBacon = dialog.getByRole('button', { name: `Remover ${catalog.bacon.name}`, exact: true });
    await expect(removeBacon).toBeDisabled();
    await addBacon.click();
    await addBacon.click();
    await addBacon.click();
    await removeBacon.click();
    await expect(removeBacon.locator('xpath=following-sibling::span[1]')).toHaveText('2');
    await dialog.getByRole('button', { name: `Adicionar ${catalog.cheddar.name}`, exact: true }).click();

    // Quantidade 2: (30 + 2 × 4,50 + 3) × 2 = 84
    await dialog.getByRole('button', { name: 'Aumentar quantidade' }).click();
    await expect(quantityValue(dialog)).toHaveText('2');
    const expected = money(catalog.burger.price, catalog.bacon.price, catalog.bacon.price, catalog.cheddar.price) * 2;
    await expect(modalAddButton(dialog)).toContainText(brl(expected));

    await modalAddButton(dialog).click();
    await expect(dialog).toBeHidden();
    await expect(cartLink(page)).toHaveAccessibleName('Carrinho com 2 itens');

    await cartLink(page).click();
    const line = cartLine(page, catalog.burger.name);
    await expect(line).toContainText('Bem Passado');
    await expect(line).toContainText(`2x ${catalog.bacon.name}`);
    await expect(line).toContainText(`1x ${catalog.cheddar.name}`);
    await expect(line).toContainText('Sem: Cebola');
    await expect(line).toContainText(brl(expected));
    await expect(quantityValue(line)).toHaveText('2');
  });

  test('bebida não oferece ponto da carne, ingredientes nem adicionais', async ({ page }) => {
    await openHome(page);
    const dialog = await openProduct(page, catalog.drink.name);

    await expect(dialog.getByRole('heading', { name: catalog.drink.name })).toBeVisible();
    await expect(dialog.getByText('Ponto da Carne')).toHaveCount(0);
    await expect(dialog.getByText('Retirar Ingredientes?')).toHaveCount(0);
    await expect(dialog.getByText('Adicionais', { exact: true })).toHaveCount(0);
    await expect(modalAddButton(dialog)).toContainText(brl(catalog.drink.price));

    await modalAddButton(dialog).click();
    await expect(cartLink(page)).toHaveAccessibleName('Carrinho com 1 item');

    // Nada de "Ao Ponto" guardado para a bebida
    const stored = JSON.parse((await readStorage(page))[STORAGE_KEYS.cart]);
    expect(stored).toHaveLength(1);
    expect(stored[0].meatPoint ?? null).toBeNull();
    await cartLink(page).click();
    await expect(cartLine(page, catalog.drink.name)).not.toContainText('Ao Ponto');
  });

  test('observação aceita no máximo 300 caracteres, mostra o contador e vai para o carrinho', async ({ page }) => {
    await openHome(page);
    const dialog = await openProduct(page, catalog.drink.name);
    const observation = dialog.getByRole('textbox', { name: 'Observação' });

    await observation.fill('Sem gelo, por favor');
    await expect(dialog.getByText('19/300')).toBeVisible();

    await observation.fill('a'.repeat(300));
    await observation.pressSequentially('bcd');
    await expect(observation).toHaveValue('a'.repeat(300));
    await expect(dialog.getByText('300/300')).toBeVisible();

    await observation.fill('Sem gelo, por favor');
    await modalAddButton(dialog).click();
    await cartLink(page).click();
    await expect(cartLine(page, catalog.drink.name)).toContainText('Obs: Sem gelo, por favor');
  });

  test('quantidade no modal fica entre 1 e 50 e o total acompanha', async ({ page }) => {
    await openHome(page);
    const dialog = await openProduct(page, catalog.drink.name);
    const minus = dialog.getByRole('button', { name: 'Diminuir quantidade' });
    const plus = dialog.getByRole('button', { name: 'Aumentar quantidade' });

    await minus.click();
    await expect(quantityValue(dialog)).toHaveText('1');

    for (let i = 0; i < 49; i++) await plus.click();
    await expect(quantityValue(dialog)).toHaveText('50');
    await expect(plus).toBeDisabled();
    await expect(modalAddButton(dialog)).toContainText(brl(catalog.drink.price * 50));
  });

  test('modal fecha com Esc, com o botão Fechar e clicando fora, sem alterar o carrinho e sem guardar escolhas', async ({ page }) => {
    await openHome(page);

    let dialog = await openProduct(page, catalog.burger.name);
    await dialog.getByRole('button', { name: `Adicionar ${catalog.bacon.name}`, exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(cartLink(page)).toHaveAccessibleName('Carrinho');

    // Reabrir começa do zero
    dialog = await openProduct(page, catalog.burger.name);
    await expect(dialog.getByRole('button', { name: `Remover ${catalog.bacon.name}`, exact: true })).toBeDisabled();
    await expect(modalAddButton(dialog)).toContainText(brl(catalog.burger.price));
    await dialog.getByRole('button', { name: 'Fechar' }).click();
    await expect(dialog).toBeHidden();

    dialog = await openProduct(page, catalog.burger.name);
    await page.mouse.click(8, 450); // fundo escurecido
    await expect(dialog).toBeHidden();
    await expect(cartLink(page)).toHaveAccessibleName('Carrinho');
  });
});

test.describe('Carrinho', () => {
  test('itens iguais são somados na mesma linha e personalizações diferentes viram linhas separadas', async ({ page }) => {
    await openHome(page);
    await addToCart(page, catalog.drink.name);
    await addToCart(page, catalog.drink.name);
    await addToCart(page, catalog.burger.name, { meatPoint: 'Ao Ponto' });
    await addToCart(page, catalog.burger.name, { meatPoint: 'Mal Passado' });
    await expect(cartLink(page)).toHaveAccessibleName('Carrinho com 4 itens');

    await openCart(page);
    await expect(page.getByRole('heading', { level: 3, name: catalog.drink.name, exact: true })).toHaveCount(1);
    await expect(quantityValue(cartLine(page, catalog.drink.name))).toHaveText('2');
    await expect(page.getByRole('heading', { level: 3, name: catalog.burger.name, exact: true })).toHaveCount(2);
    await expect(page.getByText('🔥 Ao Ponto')).toBeVisible();
    await expect(page.getByText('🔥 Mal Passado')).toBeVisible();
  });

  test('carrinho continua salvo depois de recarregar a página, com as personalizações', async ({ page }) => {
    await openHome(page);
    await addToCart(page, catalog.burger.name, {
      meatPoint: 'Mal Passado',
      addons: [catalog.cheddar.name],
      removeIngredients: ['Tomate'],
      observation: 'Pão bem tostado',
    });
    await addToCart(page, catalog.promo.name, { quantity: 2 });
    await expect(cartLink(page)).toHaveAccessibleName('Carrinho com 3 itens');

    await page.reload();
    await expect(cartLink(page)).toHaveAccessibleName('Carrinho com 3 itens');

    await openCart(page);
    const burger = cartLine(page, catalog.burger.name);
    await expect(burger).toContainText('Mal Passado');
    await expect(burger).toContainText(`1x ${catalog.cheddar.name}`);
    await expect(burger).toContainText('Sem: Tomate');
    await expect(burger).toContainText('Obs: Pão bem tostado');
    await expect(quantityValue(cartLine(page, catalog.promo.name))).toHaveText('2');
  });

  test('botões + e − alteram a quantidade, o total da linha e o contador do cabeçalho', async ({ page }) => {
    await openHome(page);
    await addToCart(page, catalog.drink.name);
    await openCart(page);

    const line = cartLine(page, catalog.drink.name);
    const minus = line.getByRole('button', { name: 'Diminuir quantidade' });
    const plus = line.getByRole('button', { name: 'Aumentar quantidade' });

    await expect(minus).toBeDisabled();
    await plus.click();
    await plus.click();
    await expect(quantityValue(line)).toHaveText('3');
    await expect(line).toContainText(brl(catalog.drink.price * 3));
    await expect(cartLink(page)).toHaveAccessibleName('Carrinho com 3 itens');

    await minus.click();
    await expect(quantityValue(line)).toHaveText('2');
    await expect(cartLink(page)).toHaveAccessibleName('Carrinho com 2 itens');
    await minus.click();
    await expect(quantityValue(line)).toHaveText('1');
    await expect(minus).toBeDisabled();
  });

  test('remover o último item mostra o carrinho vazio com link para o cardápio', async ({ page }) => {
    await openHome(page);
    await addToCart(page, catalog.combo.name);
    await openCart(page);

    await page.getByRole('button', { name: `Remover ${catalog.combo.name}` }).click();
    await expect(page.getByRole('heading', { name: 'Seu carrinho está vazio' })).toBeVisible();
    await expect(cartLink(page)).toHaveAccessibleName('Carrinho');
    expect(JSON.parse((await readStorage(page))[STORAGE_KEYS.cart])).toEqual([]);

    await page.getByRole('link', { name: 'Ver Cardápio' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(searchBox(page)).toBeVisible();
  });

  test('visitante vê no carrinho o preço promocional na linha do item e no subtotal estimado', async ({ page }) => {
    await openHome(page);
    await addToCart(page, catalog.promo.name);
    await openCart(page);

    // Sem login não há cotação do servidor: o carrinho estima com o preço cobrado (promocional)
    await expect(page.getByText('Subtotal (estimado)', { exact: true })).toBeVisible();
    await expect(summaryValue(page, 'Subtotal (estimado)')).toHaveText(brl(15));
    await expect(page.getByText('Entre na sua conta para calcular a entrega e finalizar o pedido.')).toBeVisible();
    await expect(summaryValue(page, 'Total')).toHaveText('--');
    await expect(cartLine(page, catalog.promo.name)).toContainText(brl(15));
    await expect(cartLine(page, catalog.promo.name)).not.toContainText(brl(20));
  });
});
