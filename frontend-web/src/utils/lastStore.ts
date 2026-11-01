import { STORAGE_KEYS } from '../config/brand';
import { isValidStoreSlug } from './validation';

// Vitrine por loja (/loja/:slug): caminhos e a lembrança da última loja visitada.
// Os endereços da versão de loja única (/cart e /order-success) voltam para a última loja.

/** Página da vitrine de uma loja: cardápio (padrão), carrinho ou confirmação do pedido. */
export type StorePage = 'cart' | 'order-success';

/** Caminho da vitrine: storePath('loja-principal') → "/loja/loja-principal"; com página → ".../cart". */
export function storePath(slug: string, page?: StorePage): string {
  const base = `/loja/${encodeURIComponent(slug)}`;
  return page ? `${base}/${page}` : base;
}

/** Slug da última loja visitada (null se não houver ou se o valor salvo for inválido). */
export function readLastStore(): string | null {
  try {
    const slug = localStorage.getItem(STORAGE_KEYS.lastStore);
    return isValidStoreSlug(slug) ? slug : null;
  } catch {
    return null;
  }
}

/** Guarda a loja visitada (gravado pelo StoreLayout). */
export function rememberLastStore(slug: string): void {
  if (!isValidStoreSlug(slug)) return;
  try {
    localStorage.setItem(STORAGE_KEYS.lastStore, slug);
  } catch {
    // Armazenamento bloqueado ou cheio: os endereços antigos levam ao diretório de lojas
  }
}

/**
 * Para onde levar o cliente depois de entrar ou criar a conta quando não há ?redirect=: o carrinho da última
 * loja (se tiver itens), o cardápio dela ou o diretório. `cartCount` informa os itens do carrinho de uma loja.
 */
export function defaultClientDestination(cartCount: (slug: string) => number): string {
  const slug = readLastStore();
  if (!slug) return '/';
  return cartCount(slug) > 0 ? storePath(slug, 'cart') : storePath(slug);
}

/** Esquece a última loja (ex.: a vitrine descobriu que ela não existe mais). Com slug, só se for a mesma. */
export function forgetLastStore(slug?: string): void {
  try {
    if (!slug || localStorage.getItem(STORAGE_KEYS.lastStore) === slug) localStorage.removeItem(STORAGE_KEYS.lastStore);
  } catch {
    // Armazenamento bloqueado: nada a esquecer
  }
}
