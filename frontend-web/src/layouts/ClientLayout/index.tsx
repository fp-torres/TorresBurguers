import { Outlet, Link } from 'react-router-dom';
import { ShoppingBag, Menu, User, LogOut, Briefcase, ListOrdered, LayoutDashboard } from 'lucide-react';
import { useCart } from '../../contexts/CartContext';
import { useAuth } from '../../contexts/AuthContext';
import ClientFooter from '../../components/ClientFooter'; 

export default function ClientLayout() {
  const { cartCount } = useCart();
  const { user, signOut } = useAuth();

  // Verifica se é equipe (para mostrar botão de dashboard)
  const isStaff = user?.role === 'ADMIN' || user?.role === 'EMPLOYEE';

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white shadow-sm sticky top-0 z-50 h-16 px-4 lg:px-8 flex items-center justify-between">
        
        <Link to="/" className="flex items-center gap-2 group">
          <div className="bg-orange-600 text-white p-1.5 rounded-lg group-hover:bg-orange-700 transition-colors">
            <Menu size={20} />
          </div>
          <span className="font-bold text-gray-800 text-lg tracking-tight">
            Torres<span className="text-orange-600">Burgers</span>
          </span>
        </Link>

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
                className="flex items-center gap-1 text-xs font-bold text-gray-400 hover:text-orange-600 transition-colors border border-gray-200 p-2 sm:px-3 sm:py-1.5 rounded-full"
              >
                <Briefcase size={16} />
                <span className="hidden sm:inline">Sou Funcionário</span>
              </Link>
            )
          )}

          <Link to="/cart" className="relative p-2 text-gray-600 hover:text-orange-600 transition-colors">
            <ShoppingBag size={24} />
            {cartCount > 0 && (
              <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold w-5 h-5 flex items-center justify-center rounded-full border-2 border-white animate-in zoom-in">
                {cartCount}
              </span>
            )}
          </Link>

          {user ? (
            <div className="flex items-center gap-3 pl-2 sm:pl-4 border-l border-gray-100 animate-in fade-in">
              <div className="text-right hidden sm:block">
                <p className="text-xs text-gray-500">Olá,</p>
                <p className="text-sm font-bold text-gray-800 leading-none max-w-[100px] truncate">
                  {user.name ? user.name.split(' ')[0] : 'Cliente'}
                </p>
              </div>

              {/* Botão Meus Pedidos (SÓ APARECE PARA CLIENTES REAIS) */}
              {!isStaff && (
                <Link 
                  to="/my-orders" 
                  className="p-2 text-orange-600 bg-orange-50 hover:bg-orange-100 rounded-lg transition-colors"
                  title="Meus Pedidos"
                >
                  <ListOrdered size={20} />
                </Link>
              )}

              <button 
                onClick={signOut}
                className="p-2 text-red-400 hover:bg-red-50 rounded-lg transition-colors"
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
      <main className="flex-1 w-full max-w-7xl mx-auto p-4 lg:p-6"><Outlet /></main>
      <ClientFooter />
    </div>
  );
}