import { useState } from 'react';
import { Outlet, Link, useNavigate } from 'react-router-dom';
import { 
  ShoppingBag, ChefHat, User, LogOut, Briefcase, 
  LayoutDashboard, Clock, ChevronDown, UserCog, Package 
} from 'lucide-react';
import toast from 'react-hot-toast'; 
import { useCart } from '../../contexts/CartContext';
import { useAuth } from '../../contexts/AuthContext';
import ClientFooter from '../../components/ClientFooter'; 
import { StoreStatusBadge } from '../../components/StoreStatusBadge';
import ConfirmModal from '../../components/ConfirmModal';

export default function ClientLayout() {
  const { cartCount } = useCart();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  
  const isStaff = user?.role === 'ADMIN' || user?.role === 'EMPLOYEE';
  
  const [isLogoutModalOpen, setIsLogoutModalOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const handleSignOut = () => {
    signOut();
    setIsLogoutModalOpen(false);
    setIsMenuOpen(false);
    
    toast.success('Você saiu da conta. Volte sempre! 👋', {
      duration: 3000,
    });
    navigate('/'); 
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans">
      
      {/* Overlay invisível para fechar o menu ao clicar fora */}
      {isMenuOpen && (
        <div 
          className="fixed inset-0 z-40 bg-black/5 cursor-default" 
          onClick={() => setIsMenuOpen(false)}
        />
      )}

      <header className="bg-white shadow-sm sticky top-0 z-50 h-16 px-4 lg:px-8 flex items-center justify-between border-b border-gray-100">
        
        {/* LADO ESQUERDO: Logo e Status */}
        <div className="flex items-center gap-4">
          <Link 
            to="/" 
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            className="flex items-center gap-2 group"
          >
            {/* CORREÇÃO VISUAL: Estilo Squircle para o Chapéu */}
            <div className="bg-orange-600 text-white w-10 h-10 rounded-xl flex items-center justify-center group-hover:bg-orange-700 transition-colors shadow-sm">
              <ChefHat size={22} />
            </div>
            <span className="font-bold text-gray-800 text-lg tracking-tight hidden min-[350px]:inline">
              Torres<span className="text-orange-600">Burgers</span>
            </span>
          </Link>

          <div className="hidden md:flex items-center gap-3 pl-4 border-l border-gray-200 h-8">
             <StoreStatusBadge />
             <div className="flex flex-col leading-none">
               <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Funcionamento</span>
               <span className="text-xs font-bold text-gray-700 flex items-center gap-1">
                 <Clock size={10} className="text-orange-500"/> Ter a Dom: 12h às 04h
               </span>
             </div>
          </div>
        </div>

        {/* LADO DIREITO: Carrinho e Menu de Usuário */}
        <div className="flex items-center gap-2 sm:gap-3">
          
          <div className="md:hidden [&_span]:hidden flex items-center justify-center">
            <StoreStatusBadge />
          </div>

          {/* Botão Painel (Só aparece para Staff Logado) */}
          {isStaff && (
            <Link to="/dashboard" className="hidden sm:flex items-center gap-1 text-xs font-bold text-white bg-gray-800 px-3 py-1.5 rounded-xl hover:bg-gray-900 transition-colors">
              <LayoutDashboard size={14} /> Painel
            </Link>
          )}

          {/* CORREÇÃO VISUAL: Carrinho estilo Squircle */}
          <Link 
            to="/cart" 
            className="relative w-10 h-10 flex items-center justify-center text-gray-700 hover:text-orange-600 border border-gray-200 bg-white hover:bg-gray-50 rounded-xl transition-colors shadow-sm"
          >
            <ShoppingBag size={20} />
            {cartCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white text-[10px] font-bold w-5 h-5 flex items-center justify-center rounded-full animate-in zoom-in shadow-sm border-2 border-white">
                {cartCount}
              </span>
            )}
          </Link>

          {/* Lógica de Usuário Logado vs Convidado */}
          {user ? (
            <div className="relative z-50">
              {/* Botão do Avatar (Gatilho do Menu) */}
              <button 
                onClick={() => setIsMenuOpen(!isMenuOpen)}
                className="flex items-center gap-1 border border-gray-200 hover:border-gray-300 p-0.5 rounded-xl transition-all shadow-sm bg-white"
              >
                {/* CORREÇÃO VISUAL: Avatar com bordas squircle */}
                <div className="w-8 h-8 rounded-lg overflow-hidden bg-orange-50 flex items-center justify-center">
                  {user.avatar ? (
                    <img 
                      src={user.avatar.startsWith('http') ? user.avatar : `http://localhost:3000${user.avatar}`} 
                      alt="Avatar" 
                      className="w-full h-full object-cover" 
                    />
                  ) : (
                    <User size={18} className="text-orange-600" />
                  )}
                </div>
                <ChevronDown size={14} className={`text-gray-400 mx-1 transition-transform duration-300 ${isMenuOpen ? 'rotate-180' : ''} hidden sm:block`} />
              </button>

              {/* DROPDOWN MENU */}
              {isMenuOpen && (
                <div className="absolute right-0 top-full mt-3 w-64 bg-white rounded-2xl shadow-xl border border-gray-100 overflow-hidden animate-in slide-in-from-top-2 fade-in duration-200">
                  
                  {/* Cabeçalho do Menu */}
                  <div className="p-4 bg-gray-50 border-b border-gray-100">
                    <p className="text-sm font-bold text-gray-800 truncate">{user.name}</p>
                    <p className="text-xs text-gray-500 truncate">{user.email}</p>
                  </div>

                  {/* Itens do Menu */}
                  <div className="p-2 space-y-1">
                    <Link 
                      to="/profile" 
                      onClick={() => setIsMenuOpen(false)}
                      className="flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-gray-700 hover:bg-orange-50 hover:text-orange-700 rounded-xl transition-colors"
                    >
                      <UserCog size={18} /> Meus Dados
                    </Link>
                    
                    <Link 
                      to="/my-orders" 
                      onClick={() => setIsMenuOpen(false)}
                      className="flex items-center gap-3 px-3 py-2.5 text-sm font-medium text-gray-700 hover:bg-orange-50 hover:text-orange-700 rounded-xl transition-colors"
                    >
                      <Package size={18} /> Meus Pedidos
                    </Link>
                  </div>

                  <div className="h-px bg-gray-100 mx-2 my-1"></div>

                  <div className="p-2">
                    <button 
                      onClick={() => setIsLogoutModalOpen(true)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 text-sm font-bold text-red-600 hover:bg-red-50 rounded-xl transition-colors text-left"
                    >
                      <LogOut size={18} /> Sair da Conta
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Botões para Visitantes (Deslogados) */
            <div className="flex items-center gap-2 sm:gap-3 pl-2 sm:pl-3 border-l border-gray-200">
              
              <Link 
                to="/login" 
                title="Sou Equipe"
                className="flex items-center justify-center w-10 h-10 sm:w-auto sm:px-4 sm:py-2 gap-2 text-sm font-bold text-orange-600 bg-orange-50 border border-orange-200 rounded-xl hover:bg-orange-100 transition-colors shadow-sm"
              >
                <Briefcase size={18} /> 
                <span className="hidden sm:inline">Sou Equipe</span>
              </Link>

              <Link 
                to="/signin" 
                className="flex items-center justify-center w-10 h-10 sm:w-auto sm:px-4 sm:py-2 gap-2 bg-gray-900 text-white rounded-xl font-bold text-sm hover:bg-gray-800 transition-all shadow-sm hover:shadow-md"
              >
                <User size={18} /> 
                <span className="hidden sm:inline">Entrar</span>
              </Link>
            </div>
          )}
        </div>
      </header>
      
      <main className="flex-1 w-full max-w-7xl mx-auto p-4 lg:p-6 pb-20 md:pb-6">
        <Outlet />
      </main>
      
      <ClientFooter />

      <ConfirmModal 
        isOpen={isLogoutModalOpen}
        onClose={() => setIsLogoutModalOpen(false)}
        onConfirm={handleSignOut}
        title="Sair da conta?"
        message="Você precisará fazer login novamente para realizar pedidos."
        confirmLabel="Sair Agora"
        isDestructive
      />
    </div>
  );
}