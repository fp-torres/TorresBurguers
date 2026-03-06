import React, { createContext, useState } from 'react';

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
}

export interface CartItem {
  id: string; // Usamos string porque vamos gerar um ID único para a linha do carrinho
  product: Product;
  quantity: number;
  addons: SelectedAddon[];
  total: number; 
}

interface CartContextData {
  cart: CartItem[];
  addItemToCart: (item: Omit<CartItem, 'id'>) => void;
  removeItemFromCart: (id: string) => void;
  clearCart: () => void;
  totalCartValue: number;
}

export const CartContext = createContext<CartContextData>({} as CartContextData);

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [cart, setCart] = useState<CartItem[]>([]);

  // Função para adicionar um lanche no carrinho
  function addItemToCart(newItem: Omit<CartItem, 'id'>) {
    // Geramos um ID único na hora. Isso é necessário porque o cliente pode adicionar 
    // o mesmo hambúrguer duas vezes, mas com adicionais diferentes!
    const item: CartItem = {
      ...newItem,
      id: String(Date.now()) + Math.random().toString(36).substring(2, 9)
    };
    
    setCart((oldCart) => [...oldCart, item]);
  }

  // Função para remover um item específico do carrinho
  function removeItemFromCart(id: string) {
    setCart((oldCart) => oldCart.filter(item => item.id !== id));
  }

  // Limpar carrinho (útil após finalizar a compra ou fazer logout)
  function clearCart() {
    setCart([]);
  }

  // Calcula automaticamente o valor total de tudo que está no carrinho
  const totalCartValue = cart.reduce((acc, item) => acc + item.total, 0);

  return (
    <CartContext.Provider value={{ cart, addItemToCart, removeItemFromCart, clearCart, totalCartValue }}>
      {children}
    </CartContext.Provider>
  );
}