import { Outlet, Link } from 'react-router-dom';
import { ShoppingBag, Menu, User, LogOut, Briefcase, LayoutDashboard, Clock } from 'lucide-react';
import { useCart } from '../../contexts/CartContext';
import { useAuth } from '../../contexts/AuthContext';
import ClientFooter from '../../components/ClientFooter'; 
import { StoreStatusBadge } from '../../components/StoreStatusBadge';

export default function ClientLayout() {
  const { cartCount } = useCart();
  const { user, signOut } = useAuth();
  const isStaff = user?.role === 'ADMIN' || user?.role === 'EMPLOYEE';

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans">
      <header className="bg-white shadow-sm sticky top-0 z-50 h-16 px-4 lg:px-8 flex items-center justify-between border-b border-gray-100">
        
        {/* LADO ESQUERDO */}
        <div className="flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2 group">
            <div className="bg-orange-600 text-white p-1.5 rounded-lg group-hover:bg-orange-700 transition-colors">
              <Menu size={20} />
            </div>
            <span className="font-bold text-gray-800 text-lg tracking-tight hidden min-[350px]:inline">
              Torres<span className="text-orange-600">Burgers</span>
            </span>
          </Link>

          {/* STATUS + HORÁRIO */}
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

        {/* LADO DIREITO */}
        <div className="flex items-center gap-3">
          
          {/* Horário Mobile (Ícone apenas se pouco espaço) */}
          <div className="md:hidden">
            <StoreStatusBadge />
          </div>

          {isStaff ? (
            <Link to="/dashboard" className="hidden sm:flex items-center gap-1 text-xs font-bold text-white bg-gray-800 px-3 py-1.5 rounded-full">
              <LayoutDashboard size={14} /> Painel
            </Link>
          ) : !user && (
            <Link to="/login" className="hidden md:flex items-center gap-1 text-xs font-bold text-gray-400 border border-gray-200 px-3 py-1.5 rounded-full hover:text-orange-600">
              <Briefcase size={14} /> Equipe
            </Link>
          )}

          {user && (
            <Link to="/my-orders" className="p-2 text-gray-600 hover:text-orange-600 bg-gray-50 rounded-full">
              <Clock size={20} />
            </Link>
          )}

          <Link to="/cart" className="relative p-2 text-gray-600 hover:text-orange-600 bg-orange-50 rounded-full">
            <ShoppingBag size={20} />
            {cartCount > 0 && (
              <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold w-5 h-5 flex items-center justify-center rounded-full">
                {cartCount}
              </span>
            )}
          </Link>

          {user ? (
            <button onClick={signOut} className="p-2 text-gray-400 hover:text-red-500"><LogOut size={20} /></button>
          ) : (
            <Link to="/signin" className="flex items-center gap-2 bg-gray-100 text-gray-700 px-3 py-2 rounded-xl font-bold text-sm">
              <User size={18} /> <span className="hidden sm:inline">Entrar</span>
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