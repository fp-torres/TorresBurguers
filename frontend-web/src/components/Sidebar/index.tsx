import { Link, NavLink, useNavigate } from 'react-router-dom';
import { Icon } from '@iconify/react';
import { X, Sun, Moon, Monitor, MonitorSmartphone, Loader2, UserCog } from 'lucide-react';
import { Suspense, lazy, useEffect, useState, type ReactNode } from 'react';
import ConfirmModal from '../ConfirmModal';
import BrandLogo from '../BrandLogo';
import { Modal } from '../ui';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';
import type { SidebarItem } from './menus';
import { OPEN_MY_ACCOUNT_EVENT } from '../Account/events';

// Carregadas só ao abrir "Sessões ativas" ou "Minha conta" (fora do pacote inicial do painel)
const ActiveSessions = lazy(() => import('./ActiveSessions'));
const AccountSecurity = lazy(() => import('../Account/AccountSecurity'));

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  /** Itens do menu (já filtrados pelo perfil; ver menus.ts). */
  items: SidebarItem[];
  /** Selo ao lado do logo (ex.: "Admin", "Equipe", "Plataforma"). */
  badge?: string;
  /** Atalho no rodapé, acima do "Sair" (ex.: "Ver Loja"). */
  footerLink?: { label: string; to: string; icon: string };
  /** Nome acessível da navegação. */
  label?: string;
  /** Contexto exibido abaixo da marca (ex.: logo e nome da loja do painel). */
  context?: ReactNode;
}

const THEME_LABELS = { system: 'Auto', dark: 'Escuro', light: 'Claro' } as const;

/** Menu lateral do painel da loja e do superpainel (gaveta no celular, fixo a partir de telas grandes). */
export default function Sidebar({ isOpen, onClose, items, badge, footerLink, label = 'Menu principal', context }: SidebarProps) {
  const navigate = useNavigate();
  const [isLogoutModalOpen, setIsLogoutModalOpen] = useState(false);
  const [isSessionsOpen, setIsSessionsOpen] = useState(false);
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const { signOut, user } = useAuth();
  const inSupportSession = !!user?.support_session;

  // Gaveta aberta no celular: Esc fecha (exceto com um diálogo aberto por cima, que trata o próprio Esc)
  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"],[role="alertdialog"]')) return;
      onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Atalho de outras telas (ex.: editar a si mesmo na Equipe) para "Minha conta"
  useEffect(() => {
    function handleOpenAccount() {
      setIsAccountOpen(true);
    }
    window.addEventListener(OPEN_MY_ACCOUNT_EVENT, handleOpenAccount);
    return () => window.removeEventListener(OPEN_MY_ACCOUNT_EVENT, handleOpenAccount);
  }, []);

  // Sair encerra a sessão (numa sessão de suporte, também no servidor) e apaga os carrinhos deste aparelho; o tema fica
  function executeLogout() {
    setIsLogoutModalOpen(false);
    signOut();
    navigate('/login', { replace: true });
  }

  // Ícone do tema atual (elemento, não componente: evita recriar componente a cada render)
  const themeIcon = theme === 'dark' ? <Moon size={18} aria-hidden="true" /> : theme === 'light' ? <Sun size={18} aria-hidden="true" /> : <Monitor size={18} aria-hidden="true" />;

  function cycleTheme() {
    if (theme === 'system') setTheme('light');
    else if (theme === 'light') setTheme('dark');
    else setTheme('system');
  }

  return (
    <>
      <div
        aria-hidden="true"
        className={`fixed inset-0 bg-black/50 z-40 lg:hidden backdrop-blur-sm transition-opacity duration-300 ${isOpen ? 'opacity-100 visible' : 'opacity-0 invisible'}`}
        onClick={onClose}
      />

      {/* Fechada no celular, a gaveta fica invisível (fora da ordem do Tab); a partir de telas grandes, sempre visível */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-[#1C1C1C] dark:bg-slate-950 text-white shadow-2xl transform transition-[transform,visibility] duration-300 ease-in-out lg:translate-x-0 lg:static lg:inset-auto lg:visible flex flex-col h-screen ${isOpen ? 'translate-x-0 visible' : '-translate-x-full invisible'}`}
      >
        <div className="h-20 shrink-0 flex items-center justify-between px-6 border-b border-gray-800 dark:border-slate-800">
          <Link to={items[0]?.path ?? '/'} onClick={onClose} className="hover:opacity-90 transition-opacity rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
            <BrandLogo size={34} tone="dark" badge={badge} />
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="lg:hidden text-gray-400 hover:text-white transition-colors rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            aria-label="Fechar menu"
          >
            <X size={24} aria-hidden="true" />
          </button>
        </div>

        {context && <div className="px-4 pt-4">{context}</div>}

        <div className="px-4 pt-4">
          <button
            type="button"
            onClick={cycleTheme}
            title="Alternar o tema: automático, claro ou escuro"
            className="w-full flex items-center justify-between px-4 py-2 bg-gray-800 dark:bg-slate-900 hover:bg-gray-700 dark:hover:bg-slate-800 rounded-xl text-xs font-bold text-gray-400 uppercase tracking-wider transition-colors border border-gray-700 dark:border-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            <span>Tema: {THEME_LABELS[theme]}</span>
            {themeIcon}
          </button>
        </div>

        <nav aria-label={label} className="flex-1 p-4 space-y-2 overflow-y-auto custom-scrollbar">
          {items.map((item) => (
            // NavLink marca o item ativo (aria-current="page"), inclusive nas subpáginas (ex.: /platform/stores/12)
            <NavLink
              key={item.path}
              to={item.path}
              end={item.end}
              onClick={onClose}
              className={({ isActive }) => `flex items-center gap-4 px-4 py-3 rounded-xl transition-all duration-200 group focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${isActive ? 'bg-orange-600 text-white shadow-lg shadow-orange-900/50' : 'text-gray-400 hover:bg-gray-800 dark:hover:bg-slate-800 hover:text-white'}`}
            >
              {({ isActive }) => (
                <>
                  <Icon icon={item.icon} width="24" aria-hidden="true" className={isActive ? 'text-white' : 'text-gray-500 group-hover:text-white transition-colors'} />
                  <span className="font-semibold text-sm">{item.name}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="p-4 border-t border-gray-800 dark:border-slate-800 mt-auto bg-[#1C1C1C] dark:bg-slate-950 space-y-1">
          {footerLink && (
            <Link
              to={footerLink.to}
              onClick={onClose}
              className="flex items-center gap-4 w-full px-4 py-3 text-gray-400 hover:bg-gray-800 dark:hover:bg-slate-800 hover:text-white rounded-xl transition-colors group focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              <Icon icon={footerLink.icon} width="24" aria-hidden="true" className="text-gray-500 group-hover:text-white transition-colors" />
              <span className="font-medium text-sm">{footerLink.label}</span>
            </Link>
          )}
          {/* E-mail e senha da própria conta (numa sessão de suporte, somente leitura, não aparece) */}
          {!inSupportSession && (
            <button
              type="button"
              onClick={() => setIsAccountOpen(true)}
              className="flex items-center gap-4 w-full px-4 py-3 text-gray-400 hover:bg-gray-800 dark:hover:bg-slate-800 hover:text-white rounded-xl transition-colors group focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              <UserCog size={24} aria-hidden="true" className="text-gray-500 group-hover:text-white transition-colors" />
              <span className="font-medium text-sm">Minha conta</span>
            </button>
          )}
          {/* Sessões da própria conta (numa sessão de suporte, somente leitura, não aparece) */}
          {!inSupportSession && (
            <button
              type="button"
              onClick={() => setIsSessionsOpen(true)}
              className="flex items-center gap-4 w-full px-4 py-3 text-gray-400 hover:bg-gray-800 dark:hover:bg-slate-800 hover:text-white rounded-xl transition-colors group focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              <MonitorSmartphone size={24} aria-hidden="true" className="text-gray-500 group-hover:text-white transition-colors" />
              <span className="font-medium text-sm">Sessões ativas</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setIsLogoutModalOpen(true)}
            className="flex items-center gap-4 w-full px-4 py-3 text-red-400 hover:bg-red-500/10 hover:text-red-300 rounded-xl transition-colors group focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
          >
            <Icon icon="solar:logout-2-bold-duotone" width="24" aria-hidden="true" className="group-hover:-translate-x-1 transition-transform" />
            <span className="font-medium text-sm">Sair do Sistema</span>
          </button>
        </div>
      </aside>

      <ConfirmModal
        isOpen={isLogoutModalOpen}
        onClose={() => setIsLogoutModalOpen(false)}
        onConfirm={executeLogout}
        title="Sair do Sistema?"
        message={inSupportSession
          ? 'A sessão de suporte será encerrada e você sairá do sistema. Para voltar ao superpainel, use "Encerrar e voltar ao superpainel" no aviso do topo.'
          : 'Você terá que fazer login novamente para acessar o sistema.'}
        confirmLabel="Sair"
        isDestructive
      />

      <Modal open={isSessionsOpen && !inSupportSession} onClose={() => setIsSessionsOpen(false)} title="Sessões da sua conta" size="lg">
        <Suspense
          fallback={(
            <p className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400" role="status">
              <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Carregando sessões...
            </p>
          )}
        >
          <ActiveSessions loginPath="/login" />
        </Suspense>
      </Modal>

      <Modal open={isAccountOpen && !inSupportSession} onClose={() => setIsAccountOpen(false)} title="Minha conta" size="lg">
        <Suspense
          fallback={(
            <p className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400" role="status">
              <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Carregando...
            </p>
          )}
        >
          <AccountSecurity title="E-mail e senha" />
        </Suspense>
      </Modal>
    </>
  );
}
