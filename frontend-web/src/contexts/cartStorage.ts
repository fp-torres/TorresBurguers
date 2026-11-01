import { STORAGE_KEYS } from '../config/brand';
import type { Product } from '../services/productService';
import { MAX_ADDONS_PER_ITEM, MAX_ITEM_QUANTITY, MAX_OBSERVATION_LENGTH, hasMeatPoint } from '../utils/catalog';

/**
 * Carrinho de cada loja no navegador: "comestra.cart.<storeId>" = { v: 2, storeId, storeSlug, items }.
 * Cada item guarda só o necessário para exibir a linha e montar o pedido (o preço que vale é sempre o
 * do orçamento da API). Tudo o que é lido passa por sanitizeCartItems: dados velhos ou adulterados
 * viram itens válidos ou são descartados.
 */

export const CART_FORMAT_VERSION = 2;

/** Adicional escolhido (uma entrada por unidade: [Bacon, Bacon] = 2x Bacon). */
export interface CartAddon {
  id: number;
  name: string;
  price: number;
}

export interface CartItem {
  /** Linha do carrinho: o mesmo produto com personalizações diferentes vira outra linha. */
  cartId: string;
  /** Id do produto. */
  id: number;
  name: string;
  price: number;
  /** Preço promocional (vale quando 0 < promocional < preço). */
  promotion_price: number | null;
  image: string | null;
  category: string;
  quantity: number;
  /** Observação do cliente ('' = nenhuma). */
  observation: string;
  addons: CartAddon[];
  /** Ponto da carne (só hambúrgueres; null nos demais). */
  meatPoint: string | null;
  removedIngredients: string[];
}

export interface StoredCart {
  v: typeof CART_FORMAT_VERSION;
  storeId: number;
  storeSlug: string;
  items: CartItem[];
}

export function cartStorageKey(storeId: number): string {
  return `${STORAGE_KEYS.cart}.${storeId}`;
}

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPositiveId(value: unknown): number | null {
  const parsed = toNumber(value);
  return parsed !== null && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Quantidade entre 1 e o máximo aceito pela API. */
export function clampQuantity(quantity: number): number {
  if (!Number.isFinite(quantity)) return 1;
  return Math.min(MAX_ITEM_QUANTITY, Math.max(1, Math.floor(quantity)));
}

function toCartAddon(value: unknown): CartAddon | null {
  if (!isRecord(value)) return null;
  const id = toPositiveId(value.id);
  const price = toNumber(value.price);
  if (id === null || typeof value.name !== 'string' || !value.name.trim() || price === null || price < 0) return null;
  return { id, name: value.name.trim(), price };
}

interface CartItemFields {
  cartId: string;
  id: number;
  name: string;
  price: number;
  promotion_price: number | null;
  image: string | null;
  category: string;
  quantity: number;
  observation: string;
  addons: CartAddon[];
  meatPoint: string | null;
  removedIngredients: string[];
}

/** Monta o item sempre com as mesmas chaves e na mesma ordem (comparação por JSON entre abas). */
function buildCartItem(fields: CartItemFields): CartItem {
  const withMeatPoint = hasMeatPoint({ category: fields.category });
  return {
    cartId: fields.cartId,
    id: fields.id,
    name: fields.name,
    price: fields.price,
    promotion_price: fields.promotion_price !== null && fields.promotion_price > 0 ? fields.promotion_price : null,
    image: fields.image || null,
    category: fields.category,
    quantity: clampQuantity(fields.quantity),
    observation: fields.observation.trim().slice(0, MAX_OBSERVATION_LENGTH),
    addons: fields.addons.slice(0, MAX_ADDONS_PER_ITEM),
    // Carrinhos antigos guardavam "Ao Ponto" até em bebidas
    meatPoint: withMeatPoint && fields.meatPoint?.trim() ? fields.meatPoint.trim() : null,
    removedIngredients: fields.removedIngredients.map((ingredient) => ingredient.trim()).filter(Boolean),
  };
}

/** Item salvo (formato novo ou o da versão de loja única) → item válido, ou null para descartar. */
export function sanitizeCartItem(value: unknown): CartItem | null {
  if (!isRecord(value)) return null;
  const id = toPositiveId(value.id);
  const price = toNumber(value.price);
  if (
    id === null || price === null || price < 0
    || typeof value.cartId !== 'string' || value.cartId === ''
    || typeof value.name !== 'string' || !value.name.trim()
  ) {
    return null;
  }

  return buildCartItem({
    cartId: value.cartId,
    id,
    name: value.name.trim(),
    price,
    promotion_price: toNumber(value.promotion_price),
    image: typeof value.image === 'string' ? value.image : null,
    category: typeof value.category === 'string' ? value.category : '',
    quantity: Number(value.quantity),
    observation: typeof value.observation === 'string' ? value.observation : '',
    addons: Array.isArray(value.addons) ? value.addons.map(toCartAddon).filter((addon): addon is CartAddon => addon !== null) : [],
    meatPoint: typeof value.meatPoint === 'string' ? value.meatPoint : null,
    removedIngredients: Array.isArray(value.removedIngredients)
      ? value.removedIngredients.filter((ingredient): ingredient is string => typeof ingredient === 'string')
      : [],
  });
}

/** Lista de itens válidos, sem linhas repetidas (mesmo cartId). */
export function sanitizeCartItems(values: unknown[]): CartItem[] {
  const seen = new Set<string>();
  const items: CartItem[] = [];
  for (const value of values) {
    const item = sanitizeCartItem(value);
    if (!item || seen.has(item.cartId)) continue;
    seen.add(item.cartId);
    items.push(item);
  }
  return items;
}

/** Novo item a partir do produto do cardápio e das escolhas do cliente. */
export function cartItemFromProduct(
  product: Pick<Product, 'id' | 'name' | 'price' | 'promotion_price' | 'image' | 'category'>,
  choices: { cartId: string; quantity: number; observation: string; addons: CartAddon[]; meatPoint: string | null; removedIngredients: string[] },
): CartItem {
  return buildCartItem({
    cartId: choices.cartId,
    id: product.id,
    name: product.name,
    price: toNumber(product.price) ?? 0,
    promotion_price: toNumber(product.promotion_price),
    image: product.image,
    category: product.category ?? '',
    quantity: choices.quantity,
    observation: choices.observation,
    addons: choices.addons,
    meatPoint: choices.meatPoint,
    removedIngredients: choices.removedIngredients,
  });
}

/** Adicional do cardápio (preço em número ou texto) no formato do carrinho. */
export function toCartAddonFrom(addon: { id: number; name: string; price: number | string }): CartAddon {
  return { id: addon.id, name: addon.name, price: toNumber(addon.price) ?? 0 };
}

export function sameCartItems(a: CartItem[], b: CartItem[]): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Acrescenta a `current` os itens de `extra` que ainda não estão nele (mesmo cartId = mesmo item). */
export function mergeCartItems(current: CartItem[], extra: CartItem[]): CartItem[] {
  const ids = new Set(current.map((item) => item.cartId));
  const missing = extra.filter((item) => !ids.has(item.cartId));
  return missing.length > 0 ? [...current, ...missing] : current;
}

/** Carrinho salvo da loja (vazio se não houver, se for de outra loja ou se estiver corrompido). */
export function readCart(storeId: number): CartItem[] {
  try {
    const raw = localStorage.getItem(cartStorageKey(storeId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.v !== CART_FORMAT_VERSION || toPositiveId(parsed.storeId) !== storeId || !Array.isArray(parsed.items)) {
      return [];
    }
    return sanitizeCartItems(parsed.items);
  } catch {
    return [];
  }
}

/**
 * Grava o carrinho da loja (carrinho vazio apaga a chave). Só escreve quando o conteúdo muda: duas abas
 * abertas recebem a mudança uma da outra pelo evento "storage" sem ficar regravando o mesmo valor.
 */
export function writeCart(storeId: number, storeSlug: string, items: CartItem[]): void {
  try {
    const key = cartStorageKey(storeId);
    if (items.length === 0) {
      if (localStorage.getItem(key) !== null) localStorage.removeItem(key);
      return;
    }
    const stored: StoredCart = { v: CART_FORMAT_VERSION, storeId, storeSlug, items };
    const value = JSON.stringify(stored);
    if (localStorage.getItem(key) !== value) localStorage.setItem(key, value);
  } catch {
    // Armazenamento cheio ou bloqueado: o carrinho segue só em memória
  }
}

/**
 * Evento disparado NESTA aba quando os carrinhos do aparelho são apagados (o evento "storage" só chega às
 * outras abas): o carrinho aberto e o atalho da última loja releem o armazenamento.
 */
export const CARTS_CLEARED_EVENT = `${STORAGE_KEYS.cart}:cleared`;

/**
 * Apaga os carrinhos de todas as lojas guardados neste aparelho (inclusive o da versão de loja única).
 * Usado ao sair da conta: num aparelho compartilhado, a próxima pessoa não vê nem finaliza os itens e
 * observações de quem saiu.
 */
export function clearStoredCarts(): void {
  try {
    const prefix = `${STORAGE_KEYS.cart}.`;
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key === STORAGE_KEYS.cart || key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Armazenamento bloqueado: não há carrinho salvo para apagar
  }
  window.dispatchEvent(new Event(CARTS_CLEARED_EVENT));
}

/** Quantidade de itens no carrinho salvo de uma loja, procurada pelo slug (cabeçalho fora da vitrine). */
export function storedCartCountBySlug(slug: string): number {
  try {
    const prefix = `${STORAGE_KEYS.cart}.`;
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const storeId = toPositiveId(key.slice(prefix.length));
      if (storeId === null) continue;
      const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (!isRecord(parsed) || parsed.storeSlug !== slug) continue;
      return readCart(storeId).reduce((sum, item) => sum + item.quantity, 0);
    }
  } catch {
    // Armazenamento bloqueado ou corrompido: sem contador
  }
  return 0;
}
