import { maskMoney } from './masks';

/** Quantidade máxima de um mesmo item no pedido (mesmo limite da API). */
export const MAX_ITEM_QUANTITY = 50;

/** Tamanho máximo da observação de um item (mesmo limite da API). */
export const MAX_OBSERVATION_LENGTH = 300;

/** Adicionais por unidade de um item, somando as repetições ([Bacon, Bacon] = 2) — mesmo limite da API. */
export const MAX_ADDONS_PER_ITEM = 50;

/** Categorias de produto aceitas pela API (enum ProductCategory), com o nome exibido. */
export const PRODUCT_CATEGORIES = [
  { id: 'hamburgueres', label: 'Hambúrgueres' },
  { id: 'combos', label: 'Combos' },
  { id: 'entradas', label: 'Entradas' },
  { id: 'acompanhamentos', label: 'Acompanhamentos' },
  { id: 'bebidas', label: 'Bebidas' },
  { id: 'sobremesas', label: 'Sobremesas' },
  { id: 'molhos', label: 'Molhos' },
  { id: 'adicionais', label: 'Adicionais' },
] as const;

export function categoryLabel(id?: string | null): string {
  return PRODUCT_CATEGORIES.find((category) => category.id === id)?.label ?? id ?? '';
}

// --- PONTO DA CARNE ---

/** Só os hambúrgueres têm ponto da carne. */
export const MEAT_POINT_CATEGORY = 'hamburgueres';
export const MEAT_POINTS = ['Mal Passado', 'Ao Ponto', 'Bem Passado'];
export const DEFAULT_MEAT_POINT = 'Ao Ponto';

export function hasMeatPoint(product: { category?: string | null }): boolean {
  return product.category === MEAT_POINT_CATEGORY;
}

// --- PREÇOS ---

/** Maior preço aceito pela API (preço e preço promocional). */
export const MAX_PRICE = 99_999_999.99;

interface Priced {
  price: number | string;
  promotion_price?: number | string | null;
}

/**
 * Preço cobrado: o promocional quando 0 < promocional < preço cheio (mesma regra da API).
 * Promocional zero ou vazio significa "sem promoção" (nunca "grátis").
 */
export function effectivePrice(product: Priced): number {
  const price = Number(product.price) || 0;
  const { promotion_price: promotion } = product;
  if (promotion === null || promotion === undefined || promotion === '') return price;

  const promotional = Number(promotion);
  return Number.isFinite(promotional) && promotional > 0 && promotional < price ? promotional : price;
}

export function hasPromotion(product: Priced): boolean {
  return effectivePrice(product) < (Number(product.price) || 0);
}

/** Valor numérico (ex.: "25.90" vindo da API) → texto do campo com máscara ("R$ 25,90"). */
export function toMoneyInput(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '';
  return maskMoney(String(Math.round(amount * 100)));
}

/** Compara textos sem diferenciar maiúsculas e acentos ("hamburguer" encontra "Hambúrguer"). */
export function normalizeSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}
