import { useState } from 'react';
import { Outlet, Link, useNavigate } from 'react-router-dom';
import { 
  ShoppingBag, Menu, User, LogOut, Briefcase, 
  LayoutDashboard, Clock, ChevronDown, UserCog, Package 
} from 'lucide-react';
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
    navigate('/login');
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
          <Link to="/" className="flex items-center gap-2 group">
            <div className="bg-orange-600 text-white p-1.5 rounded-lg group-hover:bg-orange-700 transition-colors">
              <Menu size={20} />
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
        <div className="flex items-center gap-3">
          <div className="md:hidden"><StoreStatusBadge /></div>

          {/* Botão Painel (Só aparece para Staff) */}
          {isStaff && (
            <Link to="/dashboard" className="hidden sm:flex items-center gap-1 text-xs font-bold text-white bg-gray-800 px-3 py-1.5 rounded-full hover:bg-gray-900 transition-colors">
              <LayoutDashboard size={14} /> Painel
            </Link>
          )}

          {/* Carrinho (Sempre visível) */}
          <Link to="/cart" className="relative p-2 text-gray-600 hover:text-orange-600 bg-orange-50 rounded-full transition-colors">
            <ShoppingBag size={20} />
            {cartCount > 0 && (
              <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold w-5 h-5 flex items-center justify-center rounded-full animate-in zoom-in">
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
                className="flex items-center gap-2 pl-2 pr-1 py-1 rounded-full hover:bg-gray-100 transition-all border border-transparent hover:border-gray-200"
              >
                <div className="w-8 h-8 rounded-full overflow-hidden bg-orange-100 flex items-center justify-center border border-orange-200 shadow-sm">
                  {user.avatar ? (
                    <img src={user.avatar} alt="Avatar" className="w-full h-full object-cover" />
                  ) : (
                    <User size={18} className="text-orange-600" />
                  )}
                </div>
                <ChevronDown size={14} className={`text-gray-400 transition-transform duration-300 ${isMenuOpen ? 'rotate-180' : ''}`} />
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
            /* Botão Entrar (Visitante) */
            <div className="flex items-center gap-2">
              <Link to="/login" className="hidden md:flex items-center gap-1 text-xs font-bold text-gray-400 border border-gray-200 px-3 py-1.5 rounded-full hover:text-orange-600 transition-colors">
                <Briefcase size={14} /> Equipe
              </Link>
              <Link to="/signin" className="flex items-center gap-2 bg-gray-900 text-white px-4 py-2 rounded-xl font-bold text-sm hover:bg-gray-800 transition-all shadow-sm hover:shadow-md">
                <User size={16} /> <span className="hidden sm:inline">Entrar</span>
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