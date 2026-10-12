import { Suspense, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Menu } from 'lucide-react';
import Sidebar from '../../components/Sidebar';
import PageLoader from '../../components/PageLoader';
import ErrorBoundary from '../../components/ErrorBoundary';
import { useAuth } from '../../contexts/AuthContext';
import { roleLabel } from '../../utils/roles';

export default function DefaultLayout() {
  const [isSidebarOpen, setSidebarOpen] = useState(false);
  const { pathname } = useLocation();

  // A rota do painel (StaffRoute) só renderiza este layout com um usuário da equipe logado
  const { user } = useAuth();
  const name = user?.name || 'Equipe';

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
              aria-label="Abrir menu"
              className="lg:hidden p-2 -ml-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
            >
              <Menu size={24} />
            </button>
            
            <h2 className="text-lg lg:text-2xl font-bold text-gray-800 dark:text-white truncate">
              Painel <span className="hidden sm:inline">{user?.role === 'ADMIN' ? 'Administrativo' : 'da Equipe'}</span>
            </h2>
          </div>
          
          <div className="flex items-center gap-3">
            <div className="text-right hidden sm:block">
              <p className="text-sm font-bold text-gray-900 dark:text-gray-100">{name}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                <span className="font-bold text-orange-600 dark:text-orange-400">{roleLabel(user?.role)}</span> · {user?.email}
              </p>
            </div>
            <div className="w-9 h-9 lg:w-10 lg:h-10 bg-orange-100 dark:bg-orange-900/30 rounded-full flex items-center justify-center text-orange-600 dark:text-orange-400 font-bold border border-orange-200 dark:border-orange-800 text-sm lg:text-base">
              {name[0].toUpperCase()}
            </div>
          </div>
        </header>

        {/* Conteúdo Principal com Texto Claro no Dark Mode */}
        <main className="flex-1 overflow-auto p-4 lg:p-8 relative dark:text-gray-100">
          {/* Páginas do painel são carregadas sob demanda: menu e cabeçalho continuam visíveis,
              inclusive se a página falhar (ex.: nova versão publicada com a aba aberta) */}
          <ErrorBoundary resetKey={pathname}>
            <Suspense fallback={<PageLoader />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}