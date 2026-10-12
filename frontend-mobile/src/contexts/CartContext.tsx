import React, { createContext, useCallback, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { STORAGE_KEYS } from '../config/brand';
import { effectivePrice, hasMeatPoint, normalizeObservation } from '../utils/catalog';

// Tipagens do que vamos guardar no carrinho
export interface Addon {
  id: number;
  name: string;
  price: number;
}

export interface SelectedAddon {
  addon: Addon;
  quantity: number;
}

export interface Product {
  id: number;
  name: string;
  price: number;
  promotion_price: number | null;
  image: string | null;
  /** Categoria (decide se o item tem ponto da carne). Linhas salvas por versões antigas não têm. */
  category?: string | null;
}

export interface CartItem {
  id: string; // Usamos string porque vamos gerar um ID único para a linha do carrinho
  product: Product;
  quantity: number;
  addons: SelectedAddon[];
  /** Ponto da carne (só hambúrgueres). */
  meatPoint?: string;
  /** Observação para a cozinha (até 300 caracteres). */
  observation?: string;
  total: number;
}

/** Item a adicionar: o ID da linha e o total são calculados pelo carrinho. */
export type NewCartItem = Omit<CartItem, 'id' | 'total'>;

/** Unidades por item aceitas pelo backend. */
export const MAX_ITEM_QUANTITY = 50;

/** Tamanho máximo do ponto da carne aceito pelo backend. */
const MAX_MEAT_POINT_LENGTH = 40;

interface CartContextData {
  cart: CartItem[];
  addItemToCart: (item: NewCartItem) => void;
  removeItemFromCart: (id: string) => void;
  /** Muda a quantidade de uma linha (1 a 50) e recalcula o total dela. */
  updateItemQuantity: (id: string, quantity: number) => void;
  clearCart: () => void;
  totalCartValue: number;
}

export const CartContext = createContext<CartContextData>({} as CartContextData);

/** Total da linha: (preço cobrado + adicionais de uma unidade) × quantidade, como na tela do produto. */
function lineTotal(product: Product, addons: SelectedAddon[], quantity: number): number {
  const addonsTotal = addons.reduce((acc, item) => acc + (Number(item.addon.price) || 0) * item.quantity, 0);
  return (effectivePrice(product) + addonsTotal) * quantity;
}

function clampQuantity(quantity: number): number {
  return Math.min(MAX_ITEM_QUANTITY, Math.max(1, Math.floor(quantity) || 1));
}

/**
 * Ponto da carne e observação no formato do pedido: ponto só em hambúrgueres, observação sem
 * espaços nas pontas e dentro do limite. Campos vazios ficam de fora da linha.
 */
function cleanChoices(product: Product, meatPoint: unknown, observation: unknown): Pick<CartItem, 'meatPoint' | 'observation'> {
  const point = typeof meatPoint === 'string' && hasMeatPoint(product) ? meatPoint.trim().slice(0, MAX_MEAT_POINT_LENGTH) : '';
  const note = typeof observation === 'string' ? normalizeObservation(observation) : '';
  return { ...(point ? { meatPoint: point } : {}), ...(note ? { observation: note } : {}) };
}

/** Mesmas escolhas: mesmo produto, adicionais, ponto da carne e observação (aí a quantidade soma na linha). */
function sameChoices(a: NewCartItem, b: NewCartItem): boolean {
  const addonsKey = (addons: SelectedAddon[]) => addons.map(({ addon, quantity }) => `${addon.id}x${quantity}`).sort().join(',');
  return a.product.id === b.product.id
    && (a.meatPoint ?? '') === (b.meatPoint ?? '')
    && (a.observation ?? '') === (b.observation ?? '')
    && addonsKey(a.addons) === addonsKey(b.addons);
}

/** Descarta linhas salvas com formato inesperado (ex.: gravadas por uma versão antiga do app). */
function isCartItem(value: unknown): value is CartItem {
  const item = value as CartItem | null;
  return !!item
    && typeof item.id === 'string'
    && !!item.product && typeof item.product.id === 'number' && typeof item.product.name === 'string'
    && Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= MAX_ITEM_QUANTITY
    && Array.isArray(item.addons)
    && item.addons.every((selected) => !!selected?.addon && typeof selected.addon.id === 'number' && Number.isInteger(selected.quantity) && selected.quantity > 0)
    && typeof item.total === 'number' && Number.isFinite(item.total);
}

function parseStoredCart(raw: string | null): CartItem[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed
      .filter(isCartItem)
      .filter((item) => {
        if (seen.has(item.id)) return false; // linha repetida (mesmo ID) entra uma vez
        seen.add(item.id);
        return true;
      })
      // Ponto e observação passam pela mesma limpeza de quando o item é adicionado
      .map(({ meatPoint, observation, ...item }) => ({
        ...item,
        ...cleanChoices(item.product, meatPoint, observation),
      }));
  } catch {
    return [];
  }
}

/**
 * Carrinho salvo no aparelho (STORAGE_KEYS.cart): continua depois do logout e de fechar o app,
 * e é esvaziado pelo checkout ao concluir o pedido. Os preços são conferidos de novo pelo
 * orçamento da API no checkout.
 */
export function CartProvider({ children }: { children: React.ReactNode }) {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Restaura o carrinho salvo, mantendo o que já tenha sido adicionado enquanto lia. Linhas que já
  // estão no carrinho (mesmo ID) não entram de novo: restaurar duas vezes não duplica o pedido.
  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(STORAGE_KEYS.cart)
      .then((raw) => {
        const stored = parseStoredCart(raw);
        if (!active || !stored.length) return;
        setCart((current) => {
          const ids = new Set(current.map((item) => item.id));
          const restored = stored.filter((item) => !ids.has(item.id));
          return restored.length ? [...restored, ...current] : current;
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setHydrated(true);
      });
    return () => {
      active = false;
    };
  }, []);

  // Salva a cada mudança (só depois de restaurar, para não apagar o carrinho salvo)
  useEffect(() => {
    if (!hydrated) return;
    const write = cart.length
      ? AsyncStorage.setItem(STORAGE_KEYS.cart, JSON.stringify(cart))
      : AsyncStorage.removeItem(STORAGE_KEYS.cart);
    write.catch(() => undefined); // Falha ao salvar não impede a compra em andamento
  }, [cart, hydrated]);

  // Adiciona um lanche ao carrinho. O mesmo produto com outras escolhas (adicionais, ponto da carne
  // ou observação) vira outra linha; com as mesmas escolhas, a quantidade soma na linha existente
  // (se couber no limite por item; senão, abre outra linha).
  const addItemToCart = useCallback((newItem: NewCartItem) => {
    const quantity = clampQuantity(newItem.quantity);
    const choices: NewCartItem = {
      product: newItem.product,
      addons: newItem.addons,
      quantity,
      ...cleanChoices(newItem.product, newItem.meatPoint, newItem.observation),
    };
    const lineId = String(Date.now()) + Math.random().toString(36).substring(2, 9);

    setCart((oldCart) => {
      const index = oldCart.findIndex((item) => sameChoices(item, choices) && item.quantity + quantity <= MAX_ITEM_QUANTITY);
      if (index < 0) {
        return [...oldCart, { ...choices, total: lineTotal(choices.product, choices.addons, quantity), id: lineId }];
      }
      // Soma na linha existente com os preços mais recentes do produto
      return oldCart.map((item, position) => {
        if (position !== index) return item;
        const merged = item.quantity + quantity;
        return { ...item, product: choices.product, quantity: merged, total: lineTotal(choices.product, item.addons, merged) };
      });
    });
  }, []);

  const removeItemFromCart = useCallback((id: string) => {
    setCart((oldCart) => oldCart.filter((item) => item.id !== id));
  }, []);

  const updateItemQuantity = useCallback((id: string, quantity: number) => {
    const next = clampQuantity(quantity);
    setCart((oldCart) => {
      const target = oldCart.find((item) => item.id === id);
      if (!target || target.quantity === next) return oldCart; // Nada muda: evita salvar de novo
      return oldCart.map((item) => (
        item.id === id ? { ...item, quantity: next, total: lineTotal(item.product, item.addons, next) } : item
      ));
    });
  }, []);

  // Esvazia o carrinho (ao concluir um pedido). O logout NÃO esvazia.
  const clearCart = useCallback(() => {
    setCart([]);
  }, []);

  const value = useMemo<CartContextData>(() => ({
    cart,
    addItemToCart,
    removeItemFromCart,
    updateItemQuantity,
    clearCart,
    // Valor de tudo que está no carrinho (estimativa; o total final vem do orçamento da API)
    totalCartValue: cart.reduce((acc, item) => acc + item.total, 0),
  }), [cart, addItemToCart, removeItemFromCart, updateItemQuantity, clearCart]);

  return (
    <CartContext.Provider value={value}>
      {children}
    </CartContext.Provider>
  );
}
