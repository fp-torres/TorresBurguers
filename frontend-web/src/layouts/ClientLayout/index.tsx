import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Ban, ChevronDown, Clock, LayoutDashboard, LogIn, LogOut, Menu, Monitor, Moon, Package,
  ShoppingBag, Smartphone, Store, Sun, User, UserCog, UserPlus,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useOptionalCart } from '../../contexts/CartContext';
import { useOptionalStorefront } from '../../contexts/StorefrontContext';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import { CARTS_CLEARED_EVENT, storedCartCountBySlug } from '../../contexts/cartStorage';
import ClientFooter from '../../components/ClientFooter';
import { StoreStatusBadge } from '../../components/StoreStatusBadge';
import ConfirmModal from '../../components/ConfirmModal';
import BrandLogo from '../../components/BrandLogo';
import StoreLogo from '../../components/BrandLogo/StoreLogo';
import PageLoader from '../../components/PageLoader';
import ErrorBoundary from '../../components/ErrorBoundary';
import { avatarUrl } from '../../services/api';
import { todayHoursSummary } from '../../services/storefrontDisplay';
import { hasInternalAccess, homePathForUser, isPlatformAdmin } from '../../utils/roles';
import { readLastStore, storePath } from '../../utils/lastStore';

interface ClientLayoutProps {
  /** Conteúdo no lugar da página da rota (ex.: 404, "loja não encontrada" ou o diretório). */
  children?: ReactNode;
  /**
   * Conteúdo de largura total, sem a margem e a largura máxima das páginas (ex.: o diretório, com a faixa
   * de apresentação da plataforma de ponta a ponta).
   */
  fullWidth?: boolean;
}

interface LastStoreShortcut {
  slug: string;
  cartCount: number;
}

function readLastStoreShortcut(): LastStoreShortcut | null {
  const slug = readLastStore();
  return slug ? { slug, cartCount: storedCartCountBySlug(slug) } : null;
}

/**
 * Última loja visitada e o carrinho dela (páginas fora da vitrine), acompanhando as outras abas.
 * `excludeSlug`: loja que acabou de responder 404 (a vitrine a esquece logo depois deste primeiro render).
 */
function useLastStoreShortcut(enabled: boolean, excludeSlug: string | null): LastStoreShortcut | null {
  const [shortcut, setShortcut] = useState(readLastStoreShortcut);
  useEffect(() => {
    if (!enabled) return;
    const update = () => setShortcut(readLastStoreShortcut());
    window.addEventListener('storage', update);
    // Saída da conta nesta aba (carrinhos e última loja apagados)
    window.addEventListener(CARTS_CLEARED_EVENT, update);
    return () => {
      window.removeEventListener('storage', update);
      window.removeEventListener(CARTS_CLEARED_EVENT, update);
    };
  }, [enabled]);
  return enabled && shortcut && shortcut.slug !== excludeSlug ? shortcut : null;
}

const MENU_ITEM = 'flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand';

/**
 * Layout das páginas do cliente.
 * - Na vitrine (/loja/:slug, dentro do StoreLayout): identidade da LOJA — nome, logo e cor no cabeçalho,
 *   selo aberto/fechado, horário de hoje, carrinho da loja e rodapé com endereço, contato e horários.
 * - Fora da loja (diretório, Meus Pedidos, Meus Dados, 404): identidade da plataforma, com atalho para a
 *   última loja; visitantes veem "Entrar" e o convite para cadastrar um estabelecimento.
 */
export default function ClientLayout({ children, fullWidth = false }: ClientLayoutProps) {
  const storefront = useOptionalStorefront();
  const store = storefront?.loadState === 'ready' ? storefront.store : null;
  const storeSlug = store ? storefront?.slug ?? store.slug : null;
  const cart = useOptionalCart();
  const lastStore = useLastStoreShortcut(!store, storefront?.loadState === 'not_found' ? storefront.slug : null);

  const { user, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();

  const [isLogoutModalOpen, setIsLogoutModalOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isThemeMenuOpen, setIsThemeMenuOpen] = useState(false);

  const homeTo = storeSlug ? storePath(storeSlug) : '/';
  const cartTo = storeSlug ? storePath(storeSlug, 'cart') : lastStore ? storePath(lastStore.slug, 'cart') : null;
  const cartCount = storeSlug ? cart?.cartCount ?? 0 : lastStore?.cartCount ?? 0;
  // Depois de entrar: na vitrine com itens no carrinho, direto para o carrinho da loja; senão, esta mesma página
  const loginRedirect = encodeURIComponent(storeSlug && cartCount > 0 ? storePath(storeSlug, 'cart') : `${pathname}${search}`);

  // Equipe e superadministrador ganham o atalho para a sua área
  // (Administrador → Dashboard, demais da equipe → Pedidos, superadministrador → superpainel)
  const hasPanel = hasInternalAccess(user);
  const panelLabel = isPlatformAdmin(user) ? 'Superpainel' : user?.role === 'ADMIN' ? 'Painel Administrativo' : 'Painel da Equipe';

  const todayHours = store ? todayHoursSummary(store.opening_hours, store.time_zone) : null;
  const status = storefront?.status ?? null;

  // Esc fecha os menus abertos
  useEffect(() => {
    if (!isMenuOpen && !isThemeMenuOpen) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setIsMenuOpen(false);
      setIsThemeMenuOpen(false);
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isMenuOpen, isThemeMenuOpen]);

  const closeMenus = () => {
    setIsMenuOpen(false);
    setIsThemeMenuOpen(false);
  };

  const handleSignOut = () => {
    signOut();
    setIsLogoutModalOpen(false);
    setIsMenuOpen(false);
    toast.success('Você saiu da conta. Volte sempre! 👋', { duration: 3000 });
    navigate(homeTo);
  };

  // Ícone do tema atual (elemento, não componente: evita recriar componente a cada render)
  const themeIcon = theme === 'dark'
    ? <Moon size={20} aria-hidden="true" />
    : theme === 'light'
      ? <Sun size={20} aria-hidden="true" />
      : (
        <>
          <Smartphone size={20} className="block md:hidden" aria-hidden="true" />
          <Monitor size={20} className="hidden md:block" aria-hidden="true" />
        </>
      );

  const themeOptions = [
    { value: 'light' as const, label: 'Claro', icon: Sun },
    { value: 'dark' as const, label: 'Escuro', icon: Moon },
    { value: 'system' as const, label: 'Sistema', icon: Monitor },
  ];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950 flex flex-col font-sans transition-colors duration-300">
      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-80 focus:px-4 focus:py-2 focus:rounded-xl focus:bg-white focus:text-gray-900 focus:shadow-lg"
      >
        Pular para o conteúdo
      </a>

      {(isMenuOpen || isThemeMenuOpen) && (
        <div className="fixed inset-0 z-40 bg-black/5 dark:bg-black/50 cursor-default" onClick={closeMenus} aria-hidden="true" />
      )}

      <header className="bg-white dark:bg-slate-900 shadow-sm sticky top-0 z-50 h-16 px-3 sm:px-4 lg:px-8 flex items-center justify-between gap-2 border-b border-gray-100 dark:border-slate-800 transition-colors duration-300">

        {/* ESQUERDA: identidade da loja (vitrine) ou da plataforma */}
        <div className="flex items-center gap-3 lg:gap-4 min-w-0">
          {store && storeSlug ? (
            <>
              <Link
                to={homeTo}
                onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                className="flex items-center gap-2.5 min-w-0 rounded-xl hover:opacity-90 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                aria-label={`${store.name}: cardápio`}
              >
                <StoreLogo name={store.name} logo={store.logo} size={40} decorative />
                <span className="font-extrabold text-gray-900 dark:text-white text-base sm:text-lg leading-tight truncate max-w-36 min-[400px]:max-w-48 sm:max-w-64 lg:max-w-88">
                  {store.name}
                </span>
              </Link>

              <div className="hidden md:flex items-center gap-3 pl-4 border-l border-gray-200 dark:border-slate-700 h-8 shrink-0">
                <StoreStatusBadge
                  isOpen={status ? status.is_open : null}
                  orderingAvailable={storefront?.orderingAvailable ?? true}
                  message={storefront?.orderingAvailable === false
                    ? storefront.unavailableMessage
                    : status?.is_open ? status.opening_message : status?.closing_message}
                />
                {todayHours && (
                  <div className="flex flex-col leading-none">
                    <span className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wide">Funcionamento</span>
                    <span className="text-xs font-bold text-gray-700 dark:text-gray-300 flex items-center gap-1 mt-0.5">
                      <Clock size={10} className="text-brand-ink dark:text-brand-ink-dark" aria-hidden="true" /> {todayHours}
                    </span>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <Link to="/" className="flex items-center rounded-xl hover:opacity-90 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500" aria-label="Página inicial">
                <BrandLogo size={36} nameClassName="hidden min-[350px]:inline" />
              </Link>
              {lastStore && (
                <Link
                  to={storePath(lastStore.slug)}
                  className="hidden md:inline-flex items-center gap-1.5 pl-4 border-l border-gray-200 dark:border-slate-700 text-sm font-bold text-gray-600 dark:text-gray-300 hover:text-orange-700 dark:hover:text-orange-400 transition-colors"
                >
                  <ArrowLeft size={16} aria-hidden="true" /> Voltar para a última loja
                </Link>
              )}
            </>
          )}
        </div>

        {/* DIREITA */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {store && (
            <div className="md:hidden">
              <StoreStatusBadge
                compact
                isOpen={status ? status.is_open : null}
                orderingAvailable={storefront?.orderingAvailable ?? true}
                message={storefront?.orderingAvailable === false ? storefront.unavailableMessage : undefined}
              />
            </div>
          )}

          {/* Visitante fora da vitrine: cadastro de estabelecimento e entrada visíveis (no celular, no menu) */}
          {!store && !user && (
            <>
              <Link to="/cadastrar-loja" className="hidden lg:inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-bold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
                <Store size={16} aria-hidden="true" /> Cadastre seu estabelecimento
              </Link>
              <Link to={`/signin?redirect=${loginRedirect}`} className="hidden sm:inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold bg-orange-600 hover:bg-orange-700 text-white shadow-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900">
                <LogIn size={16} aria-hidden="true" /> Entrar
              </Link>
            </>
          )}

          {/* Tema (no celular fica dentro do menu da conta) */}
          <div className="relative hidden md:block">
            <button
              type="button"
              onClick={() => { setIsThemeMenuOpen(!isThemeMenuOpen); setIsMenuOpen(false); }}
              aria-label="Alterar tema"
              aria-haspopup="true"
              aria-expanded={isThemeMenuOpen}
              className="w-10 h-10 flex items-center justify-center text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white bg-gray-50 dark:bg-slate-800 hover:bg-gray-100 dark:hover:bg-slate-700 border border-gray-200 dark:border-slate-700 rounded-xl transition-colors shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              title="Alterar tema"
            >
              {themeIcon}
            </button>
            {isThemeMenuOpen && (
              <div className="absolute right-0 top-full mt-2 w-36 bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-gray-100 dark:border-slate-700 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                <div className="p-1 space-y-0.5">
                  {themeOptions.map(({ value, label, icon: Icon }) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => { setTheme(value); setIsThemeMenuOpen(false); }}
                      aria-pressed={theme === value}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-bold rounded-lg ${theme === value ? 'bg-brand/10 text-brand-ink dark:text-brand-ink-dark' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-700'}`}
                    >
                      <Icon size={14} aria-hidden="true" /> {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Carrinho da loja (fora da vitrine: o da última loja visitada) */}
          {cartTo && (
            <Link
              to={cartTo}
              aria-label={cartCount > 0 ? `Carrinho com ${cartCount} ${cartCount === 1 ? 'item' : 'itens'}` : 'Carrinho'}
              className="relative w-10 h-10 flex items-center justify-center text-gray-700 dark:text-gray-200 hover:text-gray-900 dark:hover:text-white border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-gray-50 dark:hover:bg-slate-700 rounded-xl transition-colors shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <ShoppingBag size={20} aria-hidden="true" />
              {cartCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 bg-brand text-brand-contrast text-[10px] font-bold min-w-5 h-5 px-1 flex items-center justify-center rounded-full animate-in zoom-in shadow-sm border-2 border-white dark:border-slate-800" aria-hidden="true">
                  {cartCount}
                </span>
              )}
            </Link>
          )}

          {/* Menu da conta (desktop e celular) */}
          <div className="relative z-50">
            <button
              type="button"
              onClick={() => { setIsMenuOpen(!isMenuOpen); setIsThemeMenuOpen(false); }}
              aria-label={user ? 'Menu da conta' : 'Menu'}
              aria-haspopup="true"
              aria-expanded={isMenuOpen}
              className="flex items-center gap-1 border border-gray-200 dark:border-slate-700 hover:border-gray-300 dark:hover:border-slate-600 p-0.5 rounded-xl transition-all shadow-sm bg-white dark:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              {user ? (
                <span className="w-8 h-8 rounded-lg overflow-hidden bg-brand/10 flex items-center justify-center">
                  {avatarUrl(user.avatar) ? (
                    <img src={avatarUrl(user.avatar)} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <User size={18} className="text-brand-ink dark:text-brand-ink-dark" aria-hidden="true" />
                  )}
                </span>
              ) : (
                <span className="w-8 h-8 flex items-center justify-center"><Menu className="text-gray-600 dark:text-gray-300" size={20} aria-hidden="true" /></span>
              )}
              {user && <ChevronDown size={14} className={`text-gray-400 transition-transform duration-300 ${isMenuOpen ? 'rotate-180' : ''} hidden sm:block`} aria-hidden="true" />}
            </button>

            {isMenuOpen && (
              <div className="absolute right-0 top-full mt-3 w-64 max-w-[calc(100vw-1.5rem)] bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-gray-100 dark:border-slate-800 overflow-hidden animate-in slide-in-from-top-2 fade-in duration-200">
                {user ? (
                  <div className="p-4 bg-gray-50 dark:bg-slate-800 border-b border-gray-100 dark:border-slate-800">
                    <p className="text-sm font-bold text-gray-800 dark:text-gray-100 truncate">{user.name}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{user.email}</p>
                  </div>
                ) : (
                  <div className="p-4 bg-gray-50 dark:bg-slate-800 border-b border-gray-100 dark:border-slate-800">
                    <p className="text-sm font-bold text-gray-600 dark:text-gray-300">Olá, visitante!</p>
                    <div className="flex gap-2 mt-2">
                      <Link to={`/signin?redirect=${loginRedirect}`} onClick={closeMenus} className="flex-1 inline-flex items-center justify-center gap-1.5 text-xs font-bold bg-brand hover:bg-brand-hover text-brand-contrast py-2 rounded-lg transition-colors">
                        <LogIn size={14} aria-hidden="true" /> Entrar
                      </Link>
                      <Link to={`/signup?redirect=${loginRedirect}`} onClick={closeMenus} className="flex-1 inline-flex items-center justify-center gap-1.5 text-xs font-bold bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-slate-600 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-600 transition-colors">
                        <UserPlus size={14} aria-hidden="true" /> Criar conta
                      </Link>
                    </div>
                  </div>
                )}

                <div className="p-2 space-y-1">
                  {user ? (
                    <>
                      <Link to="/profile" onClick={closeMenus} className={MENU_ITEM}>
                        <UserCog size={18} aria-hidden="true" /> Meus Dados
                      </Link>
                      <Link to="/my-orders" onClick={closeMenus} className={MENU_ITEM}>
                        <Package size={18} aria-hidden="true" /> Meus Pedidos
                      </Link>
                      {hasPanel && (
                        <Link to={homePathForUser(user)} onClick={closeMenus} className={MENU_ITEM}>
                          <LayoutDashboard size={18} aria-hidden="true" /> {panelLabel}
                        </Link>
                      )}
                      <div className="h-px bg-gray-100 dark:bg-slate-800 mx-2 my-1" />
                    </>
                  ) : (
                    <>
                      <Link to="/login" onClick={closeMenus} className={MENU_ITEM}>
                        <LayoutDashboard size={18} aria-hidden="true" /> Área do lojista e equipe
                      </Link>
                      {!store && (
                        <Link to="/cadastrar-loja" onClick={closeMenus} className={`${MENU_ITEM} lg:hidden`}>
                          <Store size={18} aria-hidden="true" /> Cadastre seu estabelecimento
                        </Link>
                      )}
                    </>
                  )}

                  {!store && lastStore && (
                    <Link to={storePath(lastStore.slug)} onClick={closeMenus} className={`${MENU_ITEM} md:hidden`}>
                      <ArrowLeft size={18} aria-hidden="true" /> Voltar para a última loja
                    </Link>
                  )}

                  {/* Tema no celular (dentro do menu) */}
                  <div className="px-3 py-2 md:hidden">
                    <p className="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase mb-2" id="theme-mobile-label">Aparência</p>
                    <div className="flex bg-gray-100 dark:bg-slate-800 rounded-lg p-1" role="group" aria-labelledby="theme-mobile-label">
                      {themeOptions.map(({ value, label, icon: Icon }) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setTheme(value)}
                          aria-pressed={theme === value}
                          aria-label={label}
                          className={`flex-1 py-1.5 rounded-md flex justify-center ${theme === value ? 'bg-white dark:bg-slate-600 shadow-sm text-brand-ink dark:text-brand-ink-dark' : 'text-gray-400'}`}
                        >
                          <Icon size={16} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  </div>

                  {user && (
                    <button type="button" onClick={() => setIsLogoutModalOpen(true)} className="w-full flex items-center gap-3 px-3 py-2.5 text-sm font-bold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-xl transition-colors text-left">
                      <LogOut size={18} aria-hidden="true" /> Sair da Conta
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Loja que não pode vender agora (suspensa ou sem assinatura): só consulta */}
      {store && storefront && !storefront.orderingAvailable && (
        <div role="status" className="bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200">
          <div className="max-w-7xl mx-auto px-4 lg:px-8 py-3 flex items-start gap-3 text-sm">
            <Ban size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
            <p>
              <span className="font-bold">Pedidos indisponíveis. </span>
              {storefront.unavailableMessage} Você pode consultar o cardápio, mas não é possível fazer pedidos agora.
            </p>
          </div>
        </div>
      )}

      <main
        id="conteudo"
        tabIndex={-1}
        className={`flex-1 w-full dark:text-gray-100 focus:outline-none ${fullWidth ? '' : 'max-w-7xl mx-auto p-4 lg:p-6 pb-20 md:pb-6'}`}
      >
        {/* Páginas carregadas sob demanda (ex.: carrinho): o cabeçalho continua visível,
            inclusive se a página falhar (ex.: nova versão publicada com a aba aberta) */}
        <ErrorBoundary resetKey={pathname}>
          <Suspense fallback={<PageLoader />}>
            {children ?? <Outlet />}
          </Suspense>
        </ErrorBoundary>
      </main>

      <ClientFooter store={store} />
      <ConfirmModal isOpen={isLogoutModalOpen} onClose={() => setIsLogoutModalOpen(false)} onConfirm={handleSignOut} title="Sair?" message="Deseja sair da sua conta?" confirmLabel="Sair" isDestructive />
    </div>
  );
}
