import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import type { Product } from '../services/productService';

// Extende o Produto para ter quantidade e um ID único no carrinho
export interface CartItem extends Product {
  cartId: string; 
  quantity: number;
  observation?: string;
}

interface CartContextType {
  cartItems: CartItem[];
  addToCart: (product: Product, quantity?: number, observation?: string) => void;
  removeFromCart: (cartId: string) => void;
  clearCart: () => void;
  cartTotal: number;
  cartCount: number;
}

const CartContext = createContext({} as CartContextType);

export function CartProvider({ children }: { children: ReactNode }) {
  const [cartItems, setCartItems] = useState<CartItem[]>(() => {
    // Tenta recuperar do localStorage ao iniciar
    const stored = localStorage.getItem('torresburgers.cart');
    return stored ? JSON.parse(stored) : [];
  });

  // Salva no localStorage sempre que mudar
  useEffect(() => {
    localStorage.setItem('torresburgers.cart', JSON.stringify(cartItems));
  }, [cartItems]);

  function addToCart(product: Product, quantity = 1, observation = '') {
    setCartItems(state => {
      // Gera um ID único para este item no carrinho (timestamp + random)
      // Isso permite ter 2 "X-Bacon" diferentes (um com obs, outro sem)
      const newItem: CartItem = {
        ...product,
        cartId: `${product.id}-${Date.now()}-${Math.random()}`,
        quantity,
        observation
      };
      return [...state, newItem];
    });
  }

  function removeFromCart(cartId: string) {
    setCartItems(state => state.filter(item => item.cartId !== cartId));
  }

  function clearCart() {
    setCartItems([]);
  }

  // Calcula o total em dinheiro
  const cartTotal = cartItems.reduce((acc, item) => {
    return acc + (Number(item.price) * item.quantity);
  }, 0);

  // Calcula o total de itens (quantidade)
  const cartCount = cartItems.reduce((acc, item) => acc + item.quantity, 0);

  return (
    <CartContext.Provider value={{ cartItems, addToCart, removeFromCart, clearCart, cartTotal, cartCount }}>
      {children}
    </CartContext.Provider>
  );
}

// Hook personalizado para usar fácil
export function useCart() {
  return useContext(CartContext);
}