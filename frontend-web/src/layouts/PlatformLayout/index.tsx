import { Suspense, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Menu } from 'lucide-react';
import Sidebar from '../../components/Sidebar';
import { PLATFORM_MENU } from '../../components/Sidebar/menus';
import { BrandMark } from '../../components/BrandLogo';
import PageLoader from '../../components/PageLoader';
import ErrorBoundary from '../../components/ErrorBoundary';
import { useAuth } from '../../contexts/AuthContext';
import { BRAND } from '../../config/brand';
import { platformRoleLabel } from '../../utils/roles';

/**
 * Superpainel da plataforma (/platform). A rota (PlatformRoute) só renderiza este layout para o
 * superadministrador fora de uma sessão de suporte. Mesmo esqueleto responsivo do painel da loja:
 * menu lateral (gaveta no celular), cabeçalho com a marca e o operador, e as páginas sob demanda.
 */
export default function PlatformLayout() {
  const [isSidebarOpen, setSidebarOpen] = useState(false);
  const { pathname } = useLocation();
  const { user } = useAuth();
  const name = user?.name || 'Operador';

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-slate-900 overflow-hidden transition-colors duration-300">
      <Sidebar
        isOpen={isSidebarOpen}
        onClose={() => setSidebarOpen(false)}
        items={PLATFORM_MENU}
        badge="Plataforma"
        label="Menu do superpainel"
        footerLink={{ label: 'Ver diretório de lojas', to: '/', icon: 'solar:globus-bold-duotone' }}
      />

      <div className="flex-1 flex flex-col min-w-0 transition-all duration-300 relative">
        <header className="h-16 lg:h-20 bg-white dark:bg-slate-800 shadow-sm border-b border-gray-100 dark:border-slate-700 flex items-center justify-between gap-3 px-4 lg:px-8 shrink-0 z-20 transition-colors">
          <div className="flex items-center gap-3 lg:gap-4 min-w-0">
            <button
              onClick={() => setSidebarOpen(true)}
              aria-label="Abrir menu"
              className="lg:hidden p-2 -ml-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
            >
              <Menu size={24} />
            </button>
            {/* No celular o menu fica recolhido: a marca da plataforma aparece no cabeçalho */}
            <BrandMark size={30} className="lg:hidden shrink-0" />
            <div className="min-w-0">
              <h2 className="text-lg lg:text-2xl font-bold text-gray-800 dark:text-white truncate">
                Superpainel <span className="hidden sm:inline text-orange-600 dark:text-orange-400">{BRAND.name}</span>
              </h2>
              <p className="hidden sm:block text-xs font-semibold text-gray-500 dark:text-gray-400 truncate">Administração da plataforma</p>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <div className="text-right hidden sm:block">
              <p className="text-sm font-bold text-gray-900 dark:text-gray-100">{name}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                <span className="font-bold text-orange-600 dark:text-orange-400">{platformRoleLabel(user?.platform_role)}</span> · {user?.email}
              </p>
            </div>
            <div
              className="w-9 h-9 lg:w-10 lg:h-10 bg-orange-100 dark:bg-orange-900/30 rounded-full flex items-center justify-center text-orange-600 dark:text-orange-400 font-bold border border-orange-200 dark:border-orange-800 text-sm lg:text-base"
              title={`${name} · ${platformRoleLabel(user?.platform_role)}`}
            >
              {name[0].toUpperCase()}
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-auto p-4 lg:p-8 relative dark:text-gray-100">
          {/* Menu e cabeçalho continuam visíveis enquanto a página carrega ou se ela falhar */}
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
