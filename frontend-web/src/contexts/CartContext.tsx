import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Product } from '../services/productService';
import { effectivePrice } from '../utils/catalog';
import { migrateLegacyCart } from '../utils/legacyStorage';
import {
  CARTS_CLEARED_EVENT, cartItemFromProduct, cartStorageKey, clampQuantity, mergeCartItems, readCart, sameCartItems, toCartAddonFrom,
  writeCart, type CartAddon, type CartItem,
} from './cartStorage';

export type { CartAddon, CartItem } from './cartStorage';

/** Adicional como vem do cardápio (preço em número ou texto). */
export interface AddonChoice {
  id: number;
  name: string;
  price: number | string;
}

interface CartContextType {
  /** Loja dona deste carrinho (cada loja tem o seu). */
  storeId: number;
  storeSlug: string;
  cartItems: CartItem[];
  addToCart: (
    product: Product,
    quantity: number,
    observation?: string,
    addons?: AddonChoice[],
    meatPoint?: string,
    removedIngredients?: string[],
  ) => void;
  removeFromCart: (cartId: string) => void;
  updateQuantity: (cartId: string, delta: number) => void;
  clearCart: () => void;
  /** Itens + adicionais (preço promocional quando houver). Taxa e total final vêm do orçamento da API. */
  cartTotal: number;
  cartCount: number;
}

const CartContext = createContext<CartContextType | null>(null);

/** Compara duas listas sem considerar a ordem (sem alterar os arrays originais). */
function sameItems(a: readonly (string | number)[], b: readonly (string | number)[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].map(String).sort();
  const sortedB = [...b].map(String).sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

function newCartId(productId: number): string {
  return `${productId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Carrinho de UMA loja (montado pelo StoreLayout com key = id da loja).
 * - Salvo em "comestra.cart.<storeId>" ({ v: 2, storeId, storeSlug, items }), só com os campos necessários;
 * - abas abertas da mesma loja ficam sincronizadas (evento "storage"): uma aba não sobrescreve mais o
 *   carrinho da outra com uma versão velha;
 * - na loja padrão, recebe o carrinho da versão de loja única (utils/legacyStorage).
 */
export function CartProvider({ storeId, storeSlug, children }: { storeId: number; storeSlug: string; children: ReactNode }) {
  const [cartItems, setCartItems] = useState<CartItem[]>(() => readCart(storeId));

  useEffect(() => {
    writeCart(storeId, storeSlug, cartItems);
  }, [storeId, storeSlug, cartItems]);

  // Outra aba mudou o carrinho desta loja, ou a conta saiu (carrinhos apagados): adota a versão salva
  useEffect(() => {
    const key = cartStorageKey(storeId);
    function adoptStored() {
      const stored = readCart(storeId);
      setCartItems((current) => (sameCartItems(current, stored) ? current : stored));
    }
    function handleStorage(event: StorageEvent) {
      if (event.key !== null && event.key !== key) return;
      adoptStored();
    }
    window.addEventListener('storage', handleStorage);
    window.addEventListener(CARTS_CLEARED_EVENT, adoptStored);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(CARTS_CLEARED_EVENT, adoptStored);
    };
  }, [storeId]);

  // Carrinho da versão de loja única: entra no carrinho da loja padrão (uma vez; sem duplicar)
  useEffect(() => {
    let active = true;
    migrateLegacyCart({ id: storeId, slug: storeSlug })
      .then((migrated) => {
        if (active && migrated) setCartItems((current) => mergeCartItems(current, migrated));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [storeId, storeSlug]);

  // Os atualizadores de estado são puros (sem mutação): o StrictMode os executa duas vezes em desenvolvimento.
  const addToCart = useCallback((
    product: Product,
    quantity: number,
    observation = '',
    addons: AddonChoice[] = [],
    meatPoint = '',
    removedIngredients: string[] = [],
  ) => {
    const candidate = cartItemFromProduct(product, {
      cartId: newCartId(product.id),
      quantity,
      observation,
      addons: addons.map(toCartAddonFrom),
      meatPoint: meatPoint || null,
      removedIngredients,
    });
    const addonIds = candidate.addons.map((addon: CartAddon) => addon.id);

    setCartItems((state) => {
      // Item idêntico (mesmo produto + mesmas personalizações) soma na mesma linha
      const existingIndex = state.findIndex((item) =>
        item.id === candidate.id
        && item.observation === candidate.observation
        && item.meatPoint === candidate.meatPoint
        && sameItems(item.removedIngredients, candidate.removedIngredients)
        && sameItems(item.addons.map((addon) => addon.id), addonIds),
      );

      if (existingIndex >= 0) {
        return state.map((item, index) =>
          index === existingIndex ? { ...item, quantity: clampQuantity(item.quantity + candidate.quantity) } : item,
        );
      }
      return [...state, candidate];
    });
  }, []);

  const removeFromCart = useCallback((cartId: string) => {
    setCartItems((state) => state.filter((item) => item.cartId !== cartId));
  }, []);

  const updateQuantity = useCallback((cartId: string, delta: number) => {
    setCartItems((state) => state.map((item) =>
      item.cartId === cartId ? { ...item, quantity: clampQuantity(item.quantity + delta) } : item,
    ));
  }, []);

  const clearCart = useCallback(() => {
    setCartItems([]);
  }, []);

  const cartTotal = useMemo(() => cartItems.reduce((acc, item) => {
    const addonsPrice = item.addons.reduce((sum, addon) => sum + addon.price, 0);
    return acc + (effectivePrice(item) + addonsPrice) * item.quantity;
  }, 0), [cartItems]);

  const cartCount = useMemo(() => cartItems.reduce((acc, item) => acc + item.quantity, 0), [cartItems]);

  const value = useMemo(
    () => ({ storeId, storeSlug, cartItems, addToCart, removeFromCart, updateQuantity, clearCart, cartTotal, cartCount }),
    [storeId, storeSlug, cartItems, addToCart, removeFromCart, updateQuantity, clearCart, cartTotal, cartCount],
  );

  return (
    <CartContext.Provider value={value}>
      {children}
    </CartContext.Provider>
  );
}

/** Carrinho da loja da vitrine. Só existe dentro do StoreLayout (/loja/:slug). */
// eslint-disable-next-line react-refresh/only-export-components
export function useCart(): CartContextType {
  const context = useContext(CartContext);
  if (!context) throw new Error('useCart deve ser usado dentro da vitrine de uma loja (CartProvider).');
  return context;
}

/** Carrinho da loja atual, ou null fora da vitrine (ex.: Meus Pedidos). */
// eslint-disable-next-line react-refresh/only-export-components
export function useOptionalCart(): CartContextType | null {
  return useContext(CartContext);
}
