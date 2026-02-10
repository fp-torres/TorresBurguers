import { Outlet, Link } from 'react-router-dom';
import { ShoppingBag, Menu, User, LogOut, Briefcase, LayoutDashboard } from 'lucide-react';
import { useCart } from '../../contexts/CartContext';
import { useAuth } from '../../contexts/AuthContext';
import ClientFooter from '../../components/ClientFooter'; 
import { StoreStatusBadge } from '../../components/StoreStatusBadge'; // <--- IMPORT NOVO

export default function ClientLayout() {
  const { cartCount } = useCart();
  const { user, signOut } = useAuth();

  // Verifica se é equipe (para mostrar botão de dashboard)
  const isStaff = user?.role === 'ADMIN' || user?.role === 'EMPLOYEE';

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans">
      <header className="bg-white shadow-sm sticky top-0 z-50 h-16 px-4 lg:px-8 flex items-center justify-between border-b border-gray-100">
        
        {/* LADO ESQUERDO: Logo + Status da Loja */}
        <div className="flex items-center gap-4 sm:gap-6">
          <Link to="/" className="flex items-center gap-2 group">
            <div className="bg-orange-600 text-white p-1.5 rounded-lg group-hover:bg-orange-700 transition-colors">
              <Menu size={20} />
            </div>
            <span className="font-bold text-gray-800 text-lg tracking-tight">
              Torres<span className="text-orange-600">Burgers</span>
            </span>
          </Link>

          {/* BADGE DE STATUS DA LOJA (Visível em Mobile e Desktop) */}
          <div className="hidden min-[350px]:block">
             <StoreStatusBadge />
          </div>
        </div>

        {/* LADO DIREITO: Ações */}
        <div className="flex items-center gap-3 sm:gap-4">
          
          {/* Se for ADMIN logado, mostra botão "Ir para Painel" */}
          {isStaff ? (
            <Link 
              to="/dashboard" 
              className="flex items-center gap-1 text-xs font-bold text-white bg-gray-800 hover:bg-gray-900 transition-colors px-3 py-1.5 rounded-full"
            >
              <LayoutDashboard size={14} />
              <span className="hidden sm:inline">Painel Admin</span>
            </Link>
          ) : (
            // Se NÃO estiver logado como equipe, mostra botão "Sou Funcionário"
            !user && (
              <Link 
                to="/login" 
                className="hidden md:flex items-center gap-1 text-xs font-bold text-gray-400 hover:text-orange-600 transition-colors border border-gray-200 px-3 py-1.5 rounded-full"
              >
                <Briefcase size={14} />
                <span>Sou Funcionário</span>
              </Link>
            )
          )}

          <Link to="/cart" className="relative p-2 text-gray-600 hover:text-orange-600 transition-colors bg-orange-50 rounded-full hover:bg-orange-100">
            <ShoppingBag size={20} />
            {cartCount > 0 && (
              <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold w-5 h-5 flex items-center justify-center rounded-full border-2 border-white animate-in zoom-in">
                {cartCount}
              </span>
            )}
          </Link>

          {user ? (
            <div className="flex items-center gap-2 pl-2 sm:pl-4 border-l border-gray-100 animate-in fade-in">
              <div className="text-right hidden sm:block">
                <p className="text-[10px] uppercase text-gray-400 font-bold tracking-wide">Olá,</p>
                <p className="text-sm font-bold text-gray-800 leading-none max-w-[100px] truncate">
                  {user.name ? user.name.split(' ')[0] : 'Cliente'}
                </p>
              </div>

              <button 
                onClick={signOut}
                className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                title="Sair"
              >
                <LogOut size={20} />
              </button>
            </div>
          ) : (
            <Link 
              to="/signin" 
              className="flex items-center gap-2 bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-2 sm:px-4 sm:py-2 rounded-xl font-bold text-sm transition-colors"
            >
              <User size={18} />
              <span className="hidden sm:inline">Entrar</span>
            </Link>
          )}

        </div>
      </header>
      
      <main className="flex-1 w-full max-w-7xl mx-auto p-4 lg:p-6 pb-20 md:pb-6">
        <Outlet />
      </main>
      
      <ClientFooter />
    </div>
  );
}