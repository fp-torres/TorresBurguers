import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import type { Product } from '../services/productService';

export interface Addon {
  id: number;
  name: string;
  price: number | string; 
}

export interface CartItem extends Product {
  cartId: string;
  quantity: number;
  observation?: string;
  addons: Addon[];
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

export function CartProvider({ children }: { children: ReactNode }) {
  const [cartItems, setCartItems] = useState<CartItem[]>(() => {
    const stored = localStorage.getItem('torresburgers.cart');
    if (!stored) return [];
    
    try {
      const parsed = JSON.parse(stored);
      // Migração de dados: Garante que itens antigos tenham o array de addons
      return parsed.map((item: any) => ({
        ...item,
        addons: item.addons || [],
        removedIngredients: item.removedIngredients || []
      }));
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem('torresburgers.cart', JSON.stringify(cartItems));
  }, [cartItems]);

  function addToCart(
    product: Product, 
    quantity = 1, 
    observation = '', 
    addons: Addon[] = [], 
    meatPoint = '', 
    removedIngredients: string[] = []
  ) {
    setCartItems(state => {
      // Procura item idêntico (mesmo produto + mesmas customizações)
      const existingItemIndex = state.findIndex(item => 
        item.id === product.id &&
        item.observation === observation &&
        item.meatPoint === meatPoint &&
        JSON.stringify((item.removedIngredients || []).sort()) === JSON.stringify(removedIngredients.sort()) &&
        JSON.stringify((item.addons || []).map(a => a.id).sort()) === JSON.stringify(addons.map(a => a.id).sort())
      );

      if (existingItemIndex >= 0) {
        const newState = [...state];
        newState[existingItemIndex].quantity += quantity;
        return newState;
      }

      const newItem: CartItem = {
        ...product,
        cartId: `${product.id}-${Date.now()}-${Math.random()}`,
        quantity,
        observation,
        addons,
        meatPoint,
        removedIngredients
      };
      return [...state, newItem];
    });
  }

  function removeFromCart(cartId: string) {
    setCartItems(state => state.filter(item => item.cartId !== cartId));
  }

  function updateQuantity(cartId: string, delta: number) {
    setCartItems(state => state.map(item => {
      if (item.cartId === cartId) {
        const newQuantity = item.quantity + delta;
        return newQuantity > 0 ? { ...item, quantity: newQuantity } : item;
      }
      return item;
    }));
  }

  function clearCart() {
    setCartItems([]);
  }

  // O Total do carrinho considera apenas os ITENS + ADICIONAIS.
  // A taxa de entrega é somada na página de Checkout.
  const cartTotal = cartItems.reduce((acc, item) => {
    const currentAddons = item.addons || [];
    const addonsPrice = currentAddons.reduce((sum, addon) => sum + Number(addon.price), 0);
    
    const unitPrice = Number(item.price) + addonsPrice;
    return acc + (unitPrice * item.quantity);
  }, 0);

  const cartCount = cartItems.reduce((acc, item) => acc + item.quantity, 0);

  return (
    <CartContext.Provider value={{ cartItems, addToCart, removeFromCart, updateQuantity, clearCart, cartTotal, cartCount }}>
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  return useContext(CartContext);
}