import { Link, useLocation } from 'react-router-dom';
import { Icon } from '@iconify/react'; // <--- Importamos o componente do Iconify

export default function Sidebar() {
  const location = useLocation();

  const menuItems = [
    // Usando ícones da coleção Solar: "solar:NOME-DO-ICONE-bold-duotone" ou "linear"
    { name: 'Dashboard', icon: 'solar:widget-5-bold-duotone', path: '/dashboard' },
    { name: 'Pedidos', icon: 'solar:bag-check-bold-duotone', path: '/orders' },
    { name: 'Cardápio', icon: 'solar:chef-hat-bold-duotone', path: '/products' },
    { name: 'Equipe', icon: 'solar:users-group-rounded-bold-duotone', path: '/users' },
  ];

  function handleLogout() {
    localStorage.removeItem('torresburgers.token');
    localStorage.removeItem('torresburgers.user');
    window.location.href = '/';
  }

  return (
    <aside className="w-64 bg-[#1C1C1C] text-white min-h-screen flex flex-col shadow-2xl">
      {/* Logo */}
      <div className="h-24 flex items-center justify-center border-b border-gray-800">
        <div className="flex items-center gap-3 text-orange-500 font-bold text-xl tracking-wide">
          <Icon icon="solar:hamburger-menu-bold" width="32" />
          <span>TorresBurgers</span>
        </div>
      </div>

      {/* Menu */}
      <nav className="flex-1 p-6 space-y-3">
        {menuItems.map((item) => {
          const isActive = location.pathname === item.path;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center gap-4 px-4 py-3 rounded-xl transition-all duration-200 group ${
                isActive 
                  ? 'bg-orange-600 text-white shadow-lg shadow-orange-900/50' 
                  : 'text-gray-400 hover:bg-gray-800 hover:text-white'
              }`}
            >
              {/* Renderiza o ícone do Solar */}
              <Icon 
                icon={item.icon} 
                width="24" 
                className={isActive ? 'text-white' : 'text-gray-500 group-hover:text-white transition-colors'} 
              />
              <span className="font-semibold text-sm">{item.name}</span>
            </Link>
          );
        })}
      </nav>

      {/* Logout */}
      <div className="p-6 border-t border-gray-800">
        <button 
          onClick={handleLogout}
          className="flex items-center gap-4 w-full px-4 py-3 text-red-400 hover:bg-red-500/10 hover:text-red-300 rounded-xl transition-colors"
        >
          <Icon icon="solar:logout-2-bold-duotone" width="24" />
          <span className="font-medium text-sm">Sair do Sistema</span>
        </button>
      </div>
    </aside>
  );
}