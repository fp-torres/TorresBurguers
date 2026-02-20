import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Menu } from 'lucide-react'; 
import Sidebar from '../../components/Sidebar';

export default function DefaultLayout() {
  const [isSidebarOpen, setSidebarOpen] = useState(false);

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
    // Fundo principal escuro e transição suave
    <div className="flex h-screen bg-gray-50 dark:bg-slate-900 overflow-hidden transition-colors duration-300">
      
      <Sidebar 
        isOpen={isSidebarOpen} 
        onClose={() => setSidebarOpen(false)} 
      />
      
      <div className="flex-1 flex flex-col min-w-0 transition-all duration-300 relative">
        {/* Header Escuro */}
        <header className="h-16 lg:h-20 bg-white dark:bg-slate-800 shadow-sm border-b border-gray-100 dark:border-slate-700 flex items-center justify-between px-4 lg:px-8 shrink-0 z-20 transition-colors">
          
          <div className="flex items-center gap-3 lg:gap-4">
            <button 
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden p-2 -ml-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
            >
              <Menu size={24} />
            </button>
            
            <h2 className="text-lg lg:text-2xl font-bold text-gray-800 dark:text-white truncate">
              Painel <span className="hidden sm:inline">Administrativo</span>
            </h2>
          </div>
          
          <div className="flex items-center gap-3">
            <div className="text-right hidden sm:block">
              <p className="text-sm font-bold text-gray-900 dark:text-gray-100">{user.name}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">{user.email}</p>
            </div>
            <div className="w-9 h-9 lg:w-10 lg:h-10 bg-orange-100 dark:bg-orange-900/30 rounded-full flex items-center justify-center text-orange-600 dark:text-orange-400 font-bold border border-orange-200 dark:border-orange-800 text-sm lg:text-base">
              {user.name ? user.name[0].toUpperCase() : 'A'}
            </div>
          </div>
        </header>

        {/* Conteúdo Principal com Texto Claro no Dark Mode */}
        <main className="flex-1 overflow-auto p-4 lg:p-8 relative dark:text-gray-100">
          <Outlet />
        </main>
      </div>
    </div>
  );
}