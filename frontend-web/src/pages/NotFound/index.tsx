import { Link, useLocation } from 'react-router-dom';
import { Compass, Home, LayoutDashboard } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { homePathForRole, isStaffRole } from '../../utils/roles';

/** Página exibida para endereços que não existem. */
export default function NotFound() {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const isStaff = isStaffRole(user?.role);

  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center text-center p-6 animate-in fade-in duration-300">
      <div className="bg-orange-100 dark:bg-orange-900/30 p-6 rounded-full text-orange-600 dark:text-orange-400 mb-6">
        <Compass size={56} />
      </div>
      <p className="text-sm font-bold text-orange-600 dark:text-orange-400 tracking-widest">ERRO 404</p>
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mt-1 mb-2">Página não encontrada</h1>
      <p className="text-gray-500 dark:text-gray-400 max-w-md mb-8 break-all">
        O endereço <span className="font-mono text-gray-700 dark:text-gray-300">{pathname}</span> não existe ou foi removido.
      </p>

      <div className="flex flex-col sm:flex-row gap-3 w-full max-w-sm">
        <Link
          to="/"
          className="flex-1 flex items-center justify-center gap-2 bg-orange-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-orange-700 transition-colors shadow-lg shadow-orange-200 dark:shadow-none"
        >
          <Home size={20} /> Ir para o cardápio
        </Link>
        {isStaff && (
          <Link
            to={homePathForRole(user?.role)}
            className="flex-1 flex items-center justify-center gap-2 bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-gray-200 px-6 py-3 rounded-xl font-bold hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
          >
            <LayoutDashboard size={20} /> Ir para o painel
          </Link>
        )}
      </div>
    </div>
  );
}
