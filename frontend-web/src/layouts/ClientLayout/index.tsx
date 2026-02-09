import { Outlet, Link } from 'react-router-dom';
import { ShoppingBag, Menu } from 'lucide-react';
import { useState } from 'react';

export default function ClientLayout() {
  // Simulação do carrinho (depois faremos o Context real)
  const cartItemCount = 0; 

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* HEADER CLIENTE (Mobile First)
        - Sticky: Fica preso no topo
        - Z-Index alto para ficar sobre o conteúdo
      */}
      <header className="bg-white shadow-sm sticky top-0 z-50 h-16 px-4 lg:px-8 flex items-center justify-between">
        
        {/* Marca / Logo */}
        <Link to="/" className="flex items-center gap-2 group">
          <div className="bg-orange-600 text-white p-1.5 rounded-lg group-hover:bg-orange-700 transition-colors">
            <Menu size={20} />
          </div>
          <span className="font-bold text-gray-800 text-lg tracking-tight">
            Torres<span className="text-orange-600">Burgers</span>
          </span>
        </Link>

        {/* Ações da Direita (Carrinho) */}
        <div className="flex items-center gap-4">
          <Link 
            to="/cart" 
            className="relative p-2 text-gray-600 hover:text-orange-600 transition-colors"
          >
            <ShoppingBag size={24} />
            {cartItemCount > 0 && (
              <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold w-5 h-5 flex items-center justify-center rounded-full border-2 border-white">
                {cartItemCount}
              </span>
            )}
          </Link>
        </div>
      </header>

      {/* Conteúdo Principal */}
      <main className="flex-1 w-full max-w-7xl mx-auto p-4 lg:p-6">
        <Outlet />
      </main>

      {/* Footer Simples */}
      <footer className="bg-white border-t border-gray-100 py-6 text-center text-sm text-gray-400">
        <p>© 2026 TorresBurgers. O melhor da cidade.</p>
      </footer>
    </div>
  );
}