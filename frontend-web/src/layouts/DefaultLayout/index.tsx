import { Outlet } from 'react-router-dom';
import Sidebar from '../../components/Sidebar';

export default function DefaultLayout() {
  // Recupera do localStorage
  const userStored = localStorage.getItem('torresburgers.user');
  
  // Define o usuário padrão (caso não esteja logado ou dê erro)
  let user = { name: 'Admin', email: 'admin@torresburgers.com' };

  try {
    // Só tenta fazer o parse se existir algo E não for a string "undefined"
    if (userStored && userStored !== "undefined") {
      const parsed = JSON.parse(userStored);
      if (parsed) user = parsed;
    }
  } catch (e) {
    // Se der erro, limpamos o lixo para não acontecer de novo
    console.error("Erro ao ler usuário, limpando storage:", e);
    localStorage.removeItem('torresburgers.user');
  }

  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />
      
      <main className="flex-1 flex flex-col">
        {/* Header */}
        <header className="h-20 bg-white shadow-sm flex items-center justify-between px-8">
          <h2 className="text-2xl font-bold text-gray-800">Painel Administrativo</h2>
          
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-sm font-bold text-gray-900">{user.name}</p>
              <p className="text-xs text-gray-500">{user.email}</p>
            </div>
            <div className="w-10 h-10 bg-orange-100 rounded-full flex items-center justify-center text-orange-600 font-bold border border-orange-200">
              {user.name ? user.name[0].toUpperCase() : 'A'}
            </div>
          </div>
        </header>

        <div className="p-8 overflow-auto flex-1">
          <Outlet />
        </div>
      </main>
    </div>
  );
}