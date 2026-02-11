import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Menu } from 'lucide-react'; // Ícone do menu hambúrguer
import Sidebar from '../../components/Sidebar';

export default function DefaultLayout() {
  const [isSidebarOpen, setSidebarOpen] = useState(false);

  // Recupera do localStorage de forma segura
  const userStored = localStorage.getItem('torresburgers.user');
  let user = { name: 'Admin', email: 'admin@torresburgers.com' };

  try {
    if (userStored && userStored !== "undefined") {
      const parsed = JSON.parse(userStored);
      if (parsed) user = parsed;
    }
  } catch (e) {
    console.error("Erro ao ler usuário, limpando storage:", e);
    localStorage.removeItem('torresburgers.user');
  }

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Sidebar Responsiva (Passamos o estado para ela) */}
      <Sidebar 
        isOpen={isSidebarOpen} 
        onClose={() => setSidebarOpen(false)} 
      />
      
      <div className="flex-1 flex flex-col min-w-0 transition-all duration-300 relative">
        {/* Header Sticky (Fixo no topo) */}
        <header className="h-16 lg:h-20 bg-white shadow-sm flex items-center justify-between px-4 lg:px-8 shrink-0 z-20">
          
          <div className="flex items-center gap-3 lg:gap-4">
            {/* Botão Menu Hambúrguer (Só aparece no mobile: lg:hidden) */}
            <button 
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden p-2 -ml-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <Menu size={24} />
            </button>
            
            <h2 className="text-lg lg:text-2xl font-bold text-gray-800 truncate">
              Painel <span className="hidden sm:inline">Administrativo</span>
            </h2>
          </div>
          
          <div className="flex items-center gap-3">
            <div className="text-right hidden sm:block">
              <p className="text-sm font-bold text-gray-900">{user.name}</p>
              <p className="text-xs text-gray-500">{user.email}</p>
            </div>
            <div className="w-9 h-9 lg:w-10 lg:h-10 bg-orange-100 rounded-full flex items-center justify-center text-orange-600 font-bold border border-orange-200 text-sm lg:text-base">
              {user.name ? user.name[0].toUpperCase() : 'A'}
            </div>
          </div>
        </header>

        {/* Conteúdo Principal com Scroll Próprio */}
        <main className="flex-1 overflow-auto p-4 lg:p-8 relative">
          <Outlet />
        </main>
      </div>
    </div>
  );
}