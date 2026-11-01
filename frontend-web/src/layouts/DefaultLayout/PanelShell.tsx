import { Suspense, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Menu } from 'lucide-react';
import Sidebar from '../../components/Sidebar';
import { staffMenuFor } from '../../components/Sidebar/menus';
import PageLoader from '../../components/PageLoader';
import ErrorBoundary from '../../components/ErrorBoundary';
import { useAuth } from '../../contexts/AuthContext';
import { StoreStatusProvider } from '../../contexts/StoreStatusContext';
import { avatarUrl } from '../../services/api';
import { roleLabel } from '../../utils/roles';
import { storePath } from '../../utils/lastStore';
import PanelStoreProvider from './PanelStoreProvider';
import StoreAvatar from './StoreAvatar';
import StoreNotices from './StoreNotices';

/**
 * Painel da loja (equipe). A rota (StaffRoute) só renderiza este layout com um usuário da equipe
 * vinculado a uma loja; a loja vem SEMPRE do token (o front nunca envia store_id).
 * Monta aqui, só para o painel, o status da loja (abrir/fechar) e a situação da loja/assinatura.
 * Carregado sob demanda pelo DefaultLayout (index.tsx): a vitrine e o diretório não baixam este código.
 */
export default function PanelShell() {
  const [isSidebarOpen, setSidebarOpen] = useState(false);
  const { pathname } = useLocation();
  const { user } = useAuth();

  const name = user?.name || 'Equipe';
  const store = user?.store ?? null;
  const supportSession = user?.support_session ?? null;
  const isAdmin = user?.role === 'ADMIN';
  const avatar = avatarUrl(user?.avatar);

  return (
    <StoreStatusProvider>
      <PanelStoreProvider enabled={isAdmin} readOnly={!!supportSession} accountStatus={store?.account_status}>
        <div className="flex h-screen bg-gray-50 dark:bg-slate-900 overflow-hidden transition-colors duration-300">
          <Sidebar
            isOpen={isSidebarOpen}
            onClose={() => setSidebarOpen(false)}
            items={staffMenuFor(user?.role)}
            badge={supportSession ? 'Suporte' : isAdmin ? 'Admin' : 'Equipe'}
            label="Menu do painel da loja"
            // Loja em que a equipe está operando (logo e nome vêm da sessão, atualizados pela API)
            context={store ? (
              <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white/5 border border-white/10">
                <StoreAvatar name={store.name} logo={store.logo} color={store.primary_color} size={36} />
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Estabelecimento</p>
                  <p className="text-sm font-bold text-white truncate" title={store.name}>{store.name}</p>
                </div>
              </div>
            ) : undefined}
            // Atalho para conferir a vitrine da própria loja como o cliente vê
            footerLink={{ label: 'Ver Loja', to: store ? storePath(store.slug) : '/', icon: 'solar:shop-2-bold-duotone' }}
          />

          <div className="flex-1 flex flex-col min-w-0 transition-all duration-300 relative">
            <header className="h-16 lg:h-20 bg-white dark:bg-slate-800 shadow-sm border-b border-gray-100 dark:border-slate-700 flex items-center justify-between gap-3 px-4 lg:px-8 shrink-0 z-20 transition-colors">
              <div className="flex items-center gap-3 min-w-0">
                <button
                  type="button"
                  onClick={() => setSidebarOpen(true)}
                  aria-label="Abrir menu"
                  className="lg:hidden p-2 -ml-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                >
                  <Menu size={24} aria-hidden="true" />
                </button>

                {/* Identidade da loja em que a equipe está operando (logo e nome vêm da API) */}
                {store && (
                  <span className="hidden min-[400px]:block shrink-0">
                    <StoreAvatar name={store.name} logo={store.logo} color={store.primary_color} size={40} />
                  </span>
                )}
                <div className="min-w-0 flex flex-col-reverse">
                  <h2 className="text-xs font-semibold text-gray-500 dark:text-gray-400 truncate">
                    {isAdmin ? 'Painel Administrativo' : 'Painel da Equipe'}
                  </h2>
                  <p className="text-base lg:text-xl font-bold text-gray-800 dark:text-white truncate" title={store?.name}>
                    {store?.name ?? 'Estabelecimento'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <div className="text-right hidden md:block min-w-0 max-w-64">
                  <p className="text-sm font-bold text-gray-900 dark:text-gray-100 truncate">{name}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                    <span className="font-bold text-orange-600 dark:text-orange-400">{supportSession ? 'Suporte da plataforma' : roleLabel(user?.role)}</span> · {user?.email}
                  </p>
                </div>
                {avatar ? (
                  <img
                    src={avatar}
                    alt=""
                    title={`${name} · ${supportSession ? 'Suporte da plataforma' : roleLabel(user?.role)}`}
                    className="w-9 h-9 lg:w-10 lg:h-10 rounded-full object-cover border border-orange-200 dark:border-orange-800 bg-white dark:bg-slate-700"
                  />
                ) : (
                  <div
                    className="w-9 h-9 lg:w-10 lg:h-10 bg-orange-100 dark:bg-orange-900/30 rounded-full flex items-center justify-center text-orange-600 dark:text-orange-400 font-bold border border-orange-200 dark:border-orange-800 text-sm lg:text-base"
                    title={`${name} · ${supportSession ? 'Suporte da plataforma' : roleLabel(user?.role)}`}
                    aria-hidden="true"
                  >
                    {name[0].toUpperCase()}
                  </div>
                )}
              </div>
            </header>

            {/* Sessão de suporte, loja/assinatura que impede vender ou alterar, cancelamento e fim do teste */}
            <StoreNotices />

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
      </PanelStoreProvider>
    </StoreStatusProvider>
  );
}
