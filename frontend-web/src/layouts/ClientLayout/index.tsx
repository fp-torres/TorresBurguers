import { useState } from 'react';
import { Outlet, Link, useNavigate } from 'react-router-dom';
import { 
  ShoppingBag, ChefHat, User, LogOut, Briefcase, 
  LayoutDashboard, Clock, ChevronDown, UserCog, Package,
  Sun, Moon, Monitor, Smartphone, Menu
} from 'lucide-react';
import toast from 'react-hot-toast'; 
import { useCart } from '../../contexts/CartContext';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import ClientFooter from '../../components/ClientFooter'; 
import { StoreStatusBadge } from '../../components/StoreStatusBadge';
import ConfirmModal from '../../components/ConfirmModal';

export default function ClientLayout() {
  const { cartCount } = useCart();
  const { user, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  
  const isStaff = user?.role === 'ADMIN' || user?.role === 'EMPLOYEE';
  
  const [isLogoutModalOpen, setIsLogoutModalOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isThemeMenuOpen, setIsThemeMenuOpen] = useState(false);

  const handleSignOut = () => {
    signOut();
    setIsLogoutModalOpen(false);
    setIsMenuOpen(false);
    
    toast.success('Você saiu da conta. Volte sempre! 👋', { duration: 3000 });
    navigate('/'); 
  };

  const ThemeIcon = () => {
    if (theme === 'dark') return <Moon size={20} />;
    if (theme === 'light') return <Sun size={20} />;
    return (
      <>
        <Smartphone size={20} className="block md:hidden" />
        <Monitor size={20} className="hidden md:block" />
      </>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950 flex flex-col font-sans transition-colors duration-300">
      
      {(isMenuOpen || isThemeMenuOpen) && (
        <div 
          className="fixed inset-0 z-40 bg-black/5 dark:bg-black/50 cursor-default" 
          onClick={() => { setIsMenuOpen(false); setIsThemeMenuOpen(false); }}
        />
      )}

      <header className="bg-white dark:bg-slate-900 shadow-sm sticky top-0 z-50 h-16 px-4 lg:px-8 flex items-center justify-between border-b border-gray-100 dark:border-slate-800 transition-colors duration-300">
        
        {/* ESQUERDA */}
        <div className="flex items-center gap-4">
          <Link to="/" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} className="flex items-center gap-2 group">
            <div className="bg-orange-600 dark:bg-orange-500 text-white w-10 h-10 rounded-xl flex items-center justify-center group-hover:bg-orange-700 dark:group-hover:bg-orange-600 transition-colors shadow-sm">
              <ChefHat size={22} />
            </div>
            <span className="font-bold text-gray-800 dark:text-gray-100 text-lg tracking-tight hidden min-[350px]:inline">
              Torres<span className="text-orange-600 dark:text-orange-500">Burgers</span>
            </span>
          </Link>

          <div className="hidden md:flex items-center gap-3 pl-4 border-l border-gray-200 dark:border-slate-700 h-8">
             <StoreStatusBadge />
             <div className="flex flex-col leading-none">
               <span className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wide">Funcionamento</span>
               <span className="text-xs font-bold text-gray-700 dark:text-gray-300 flex items-center gap-1">
                 <Clock size={10} className="text-orange-500"/> Ter a Dom: 12h às 04h
               </span>
             </div>
          </div>
        </div>

        {/* DIREITA */}
        <div className="flex items-center gap-2 sm:gap-3">
          
          <div className="md:hidden [&_span]:hidden flex items-center justify-center">
            <StoreStatusBadge />
          </div>

          {/* BOTÃO DE TEMA (ESCONDIDO NO MOBILE PARA ECONOMIZAR ESPAÇO) */}
          <div className="relative hidden md:block">
            <button
              onClick={() => setIsThemeMenuOpen(!isThemeMenuOpen)}
              className="w-10 h-10 flex items-center justify-center text-gray-600 dark:text-gray-300 hover:text-orange-600 dark:hover:text-orange-400 bg-gray-50 dark:bg-slate-800 hover:bg-gray-100 dark:hover:bg-slate-700 border border-gray-200 dark:border-slate-700 rounded-xl transition-colors shadow-sm"
              title="Alterar Tema"
            >
              <ThemeIcon />
            </button>
            {isThemeMenuOpen && (
              <div className="absolute right-0 top-full mt-2 w-32 bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-gray-100 dark:border-slate-700 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                 <div className="p-1 space-y-0.5">
                    <button onClick={() => { setTheme('light'); setIsThemeMenuOpen(false); }} className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-bold rounded-lg ${theme === 'light' ? 'bg-orange-50 dark:bg-orange-500/10 text-orange-600 dark:text-orange-400' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-700'}`}>
                      <Sun size={14} /> Claro
                    </button>
                    <button onClick={() => { setTheme('dark'); setIsThemeMenuOpen(false); }} className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-bold rounded-lg ${theme === 'dark' ? 'bg-orange-50 dark:bg-orange-500/10 text-orange-600 dark:text-orange-400' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-700'}`}>
                      <Moon size={14} /> Escuro
                    </button>
                    <button onClick={() => { setTheme('system'); setIsThemeMenuOpen(false); }} className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-bold rounded-lg ${theme === 'system' ? 'bg-orange-50 dark:bg-orange-500/10 text-orange-600 dark:text-orange-400' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-700'}`}>
                      <Monitor size={14} /> Sistema
                    </button>
                 </div>
              </div>
            )}
          </div>

          {/* Carrinho */}
          <Link 
            to="/cart" 
            className="relative w-10 h-10 flex items-center justify-center text-gray-700 dark:text-gray-200 hover:text-orange-600 dark:hover:text-orange-400 border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-gray-50 dark:hover:bg-slate-700 rounded-xl transition-colors shadow-sm"
          >
            <ShoppingBag size={20} />
            {cartCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white text-[10px] font-bold w-5 h-5 flex items-center justify-center rounded-full animate-in zoom-in shadow-sm border-2 border-white dark:border-slate-800">
                {cartCount}
              </span>
            )}
          </Link>

          {/* Menu de Usuário (Desktop + Mobile Integrado) */}
          <div className="relative z-50">
             <button 
                onClick={() => setIsMenuOpen(!isMenuOpen)}
                className="flex items-center gap-1 border border-gray-200 dark:border-slate-700 hover:border-gray-300 dark:hover:border-slate-600 p-0.5 rounded-xl transition-all shadow-sm bg-white dark:bg-slate-800"
              >
                {user ? (
                   <div className="w-8 h-8 rounded-lg overflow-hidden bg-orange-50 dark:bg-slate-700 flex items-center justify-center">
                     {user.avatar ? (
                       <img src={user.avatar.startsWith('http') ? user.avatar : `http://localhost:3000${user.avatar}`} alt="Avatar" className="w-full h-full object-cover" />
                     ) : (
                       <User size={18} className="text-orange-600 dark:text-orange-500" />
                     )}
                   </div>
                ) : (
                   <div className="w-8 h-8 flex items-center justify-center"><Menu className="text-gray-600 dark:text-gray-300" size={20}/></div>
                )}
                {user && <ChevronDown size={14} className={`text-gray-400 transition-transform duration-300 ${isMenuOpen ? 'rotate-180' : ''} hidden sm:block`} />}
              </button>

              {/* DROPDOWN UNIFICADO */}
              {isMenuOpen && (
                <div className="absolute right-0 top-full mt-3 w-64 bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-gray-100 dark:border-slate-800 overflow-hidden animate-in slide-in-from-top-2 fade-in duration-200">
                  
                  {user ? (
                    <div className="p-4 bg-gray-50 dark:bg-slate-800 border-b border-gray-100 dark:border-slate-800">
                      <p className="text-sm font-bold text-gray-800 dark:text-gray-100 truncate">{user.name}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{user.email}</p>
                    </div>
                  ) : (
                    <div className="p-4 bg-gray-50 dark:bg-slate-800 border-b border-gray-100 dark:border-slate-800">
                      <p className="text-sm font-bold text-gray-500 dark:text-gray-400">Olá, visitante!</p>
                      <div className="flex gap-2 mt-2">
                         <Link to="/signin" className="flex-1 text-center text-xs font-bold bg-gray-900 dark:bg-orange-600 text-white py-2 rounded-lg">Entrar</Link>
                         <Link to="/login" className="flex-1 text-center text-xs font-bold bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-slate-600 py-2 rounded-lg">Equipe</Link>
                      </div>
                    </div>
                  )}

                  <div className="p-2 space-y-1">
                    {user && (
                      <>
                        <Link to="/profile" onClick={() => setIsMenuOpen(false)} className="flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-orange-50 dark:hover:bg-slate-800 hover:text-orange-700 dark:hover:text-orange-400 rounded-xl transition-colors">
                          <UserCog size={18} /> Meus Dados
                        </Link>
                        <Link to="/my-orders" onClick={() => setIsMenuOpen(false)} className="flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-orange-50 dark:hover:bg-slate-800 hover:text-orange-700 dark:hover:text-orange-400 rounded-xl transition-colors">
                          <Package size={18} /> Meus Pedidos
                        </Link>
                        {isStaff && (
                           <Link to="/dashboard" onClick={() => setIsMenuOpen(false)} className="flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-orange-50 dark:hover:bg-slate-800 hover:text-orange-700 dark:hover:text-orange-400 rounded-xl transition-colors">
                              <LayoutDashboard size={18} /> Painel Administrativo
                           </Link>
                        )}
                        <div className="h-px bg-gray-100 dark:bg-slate-800 mx-2 my-1"></div>
                      </>
                    )}

                    {/* SELETOR DE TEMA MOBILE (DENTRO DO MENU) */}
                    <div className="px-3 py-2 md:hidden">
                       <p className="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase mb-2">Aparência</p>
                       <div className="flex bg-gray-100 dark:bg-slate-800 rounded-lg p-1">
                          <button onClick={() => setTheme('light')} className={`flex-1 py-1.5 rounded-md flex justify-center ${theme === 'light' ? 'bg-white dark:bg-slate-600 shadow-sm text-orange-600' : 'text-gray-400'}`}><Sun size={16}/></button>
                          <button onClick={() => setTheme('dark')} className={`flex-1 py-1.5 rounded-md flex justify-center ${theme === 'dark' ? 'bg-white dark:bg-slate-600 shadow-sm text-orange-600' : 'text-gray-400'}`}><Moon size={16}/></button>
                          <button onClick={() => setTheme('system')} className={`flex-1 py-1.5 rounded-md flex justify-center ${theme === 'system' ? 'bg-white dark:bg-slate-600 shadow-sm text-orange-600' : 'text-gray-400'}`}><Smartphone size={16}/></button>
                       </div>
                    </div>

                    {user && (
                      <button onClick={() => setIsLogoutModalOpen(true)} className="w-full flex items-center gap-3 px-3 py-2.5 text-sm font-bold text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-xl transition-colors text-left">
                        <LogOut size={18} /> Sair da Conta
                      </button>
                    )}
                  </div>
                </div>
              )}
          </div>
        </div>
      </header>
      
      <main className="flex-1 w-full max-w-7xl mx-auto p-4 lg:p-6 pb-20 md:pb-6 dark:text-gray-100">
        <Outlet />
      </main>
      
      <ClientFooter />
      <ConfirmModal isOpen={isLogoutModalOpen} onClose={() => setIsLogoutModalOpen(false)} onConfirm={handleSignOut} title="Sair?" message="Deseja sair da sua conta?" confirmLabel="Sair" isDestructive />
    </div>
  );
}