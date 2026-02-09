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
    <div className="flex min-h-screen bg-gray-50">
      {/* Sidebar Responsiva (Passamos o estado para ela) */}
      <Sidebar 
        isOpen={isSidebarOpen} 
        onClose={() => setSidebarOpen(false)} 
      />
      
      <main className="flex-1 flex flex-col min-w-0 transition-all duration-300">
        {/* Header Sticky (Fixo no topo) */}
        <header className="h-20 bg-white shadow-sm flex items-center justify-between px-4 lg:px-8 sticky top-0 z-30">
          
          <div className="flex items-center gap-4">
            {/* Botão Menu Hambúrguer (Só aparece no mobile: lg:hidden) */}
            <button 
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <Menu size={24} />
            </button>
            
            <h2 className="text-xl lg:text-2xl font-bold text-gray-800 truncate">
              Painel <span className="hidden sm:inline">Administrativo</span>
            </h2>
          </div>
          
          <div className="flex items-center gap-3">
            <div className="text-right hidden sm:block">
              <p className="text-sm font-bold text-gray-900">{user.name}</p>
              <p className="text-xs text-gray-500">{user.email}</p>
            </div>
            <div className="w-10 h-10 bg-orange-100 rounded-full flex items-center justify-center text-orange-600 font-bold border border-orange-200">
              {user.name ? user.name[0].toUpperCase() : 'A'}
            </div>
          </div>
        </header>

        {/* Conteúdo Principal com padding responsivo */}
        <div className="p-4 lg:p-8 overflow-auto flex-1">
          <Outlet />
        </div>
      </main>
    </div>
  );
}