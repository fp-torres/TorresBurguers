import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Product } from '../services/productService';
import { STORAGE_KEYS } from '../config/brand';
import { MAX_ITEM_QUANTITY, effectivePrice, hasMeatPoint } from '../utils/catalog';

export interface Addon {
  id: number;
  name: string;
  price: number | string;
}

export interface CartItem extends Product {
  cartId: string;
  quantity: number;
  observation?: string;
  /** Uma entrada por unidade do adicional: [Bacon, Bacon] = 2x Bacon. */
  addons: Addon[];
  /** Só hambúrgueres têm ponto da carne. */
  meatPoint?: string;
  removedIngredients: string[];
}

interface CartContextType {
  cartItems: CartItem[];
  addToCart: (product: Product, quantity: number, observation?: string, addons?: Addon[], meatPoint?: string, removedIngredients?: string[]) => void;
  removeFromCart: (cartId: string) => void;
  updateQuantity: (cartId: string, delta: number) => void;
  clearCart: () => void;
  cartTotal: number;
  cartCount: number;
}

const CartContext = createContext({} as CartContextType);

/** Quantidade entre 1 e o máximo aceito pela API. */
function clampQuantity(quantity: number): number {
  if (!Number.isFinite(quantity)) return 1;
  return Math.min(MAX_ITEM_QUANTITY, Math.max(1, Math.floor(quantity)));
}

/** Compara duas listas sem considerar a ordem (sem alterar os arrays originais). */
function sameItems(a: readonly (string | number)[], b: readonly (string | number)[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].map(String).sort();
  const sortedB = [...b].map(String).sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

function isStoredItem(value: unknown): value is CartItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<CartItem>;
  return typeof item.id === 'number' && typeof item.cartId === 'string' && typeof item.name === 'string';
}

/** Carrinho salvo no navegador; itens inválidos são descartados. */
function readStoredCart(): CartItem[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.cart);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(isStoredItem).map((item) => ({
      ...item,
      quantity: clampQuantity(Number(item.quantity)),
      addons: Array.isArray(item.addons) ? item.addons : [],
      removedIngredients: Array.isArray(item.removedIngredients) ? item.removedIngredients : [],
      // Carrinhos antigos guardavam "Ao Ponto" até em bebidas
      meatPoint: hasMeatPoint(item) ? item.meatPoint || undefined : undefined,
    }));
  } catch {
    return [];
  }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [cartItems, setCartItems] = useState<CartItem[]>(readStoredCart);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.cart, JSON.stringify(cartItems));
    } catch {
      // Armazenamento cheio ou bloqueado: o carrinho segue só em memória
    }
  }, [cartItems]);

  // Os atualizadores de estado são puros (sem mutação): o StrictMode os executa duas vezes em desenvolvimento.
  const addToCart = useCallback((
    product: Product,
    quantity = 1,
    observation = '',
    addons: Addon[] = [],
    meatPoint = '',
    removedIngredients: string[] = []
  ) => {
    const note = observation.trim();
    const point = hasMeatPoint(product) ? meatPoint.trim() : '';
    const addonIds = addons.map((addon) => addon.id);
    const cartId = `${product.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    setCartItems(state => {
      // Procura item idêntico (mesmo produto + mesmas customizações)
      const existingIndex = state.findIndex(item =>
        item.id === product.id &&
        (item.observation ?? '') === note &&
        (item.meatPoint ?? '') === point &&
        sameItems(item.removedIngredients ?? [], removedIngredients) &&
        sameItems((item.addons ?? []).map(addon => addon.id), addonIds)
      );

      if (existingIndex >= 0) {
        return state.map((item, index) =>
          index === existingIndex ? { ...item, quantity: clampQuantity(item.quantity + quantity) } : item,
        );
      }

      const newItem: CartItem = {
        ...product,
        cartId,
        quantity: clampQuantity(quantity),
        observation: note,
        addons: [...addons],
        meatPoint: point || undefined,
        removedIngredients: [...removedIngredients],
      };
      return [...state, newItem];
    });
  }, []);

  const removeFromCart = useCallback((cartId: string) => {
    setCartItems(state => state.filter(item => item.cartId !== cartId));
  }, []);

  const updateQuantity = useCallback((cartId: string, delta: number) => {
    setCartItems(state => state.map(item =>
      item.cartId === cartId ? { ...item, quantity: clampQuantity(item.quantity + delta) } : item,
    ));
  }, []);

  const clearCart = useCallback(() => {
    setCartItems([]);
  }, []);

  // O Total do carrinho considera apenas os ITENS + ADICIONAIS (preço promocional quando houver).
  // A taxa de entrega e o total final vêm da cotação da API no checkout.
  const cartTotal = useMemo(() => cartItems.reduce((acc, item) => {
    const addonsPrice = (item.addons || []).reduce((sum, addon) => sum + Number(addon.price), 0);
    return acc + (effectivePrice(item) + addonsPrice) * item.quantity;
  }, 0), [cartItems]);

  const cartCount = useMemo(() => cartItems.reduce((acc, item) => acc + item.quantity, 0), [cartItems]);

  const value = useMemo(
    () => ({ cartItems, addToCart, removeFromCart, updateQuantity, clearCart, cartTotal, cartCount }),
    [cartItems, addToCart, removeFromCart, updateQuantity, clearCart, cartTotal, cartCount],
  );

  return (
    <CartContext.Provider value={value}>
      {children}
    </CartContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCart() {
  return useContext(CartContext);
}
