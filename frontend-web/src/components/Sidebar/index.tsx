import { Link, useLocation } from 'react-router-dom';
import { Icon } from '@iconify/react';
import { X } from 'lucide-react';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function Sidebar({ isOpen, onClose }: SidebarProps) {
  const location = useLocation();

  const menuItems = [
    { name: 'Dashboard', icon: 'solar:widget-5-bold-duotone', path: '/dashboard' },
    { name: 'Pedidos', icon: 'solar:bag-check-bold-duotone', path: '/orders' },
    { name: 'Cardápio', icon: 'solar:chef-hat-bold-duotone', path: '/products' },
    { name: 'Equipe', icon: 'solar:users-group-rounded-bold-duotone', path: '/users' },
  ];

  function handleLogout() {
    if(confirm("Deseja realmente sair do sistema?")) {
      localStorage.removeItem('torresburgers.token');
      localStorage.removeItem('torresburgers.user');
      window.location.href = '/login';
    }
  }

  return (
    <>
      {/* Overlay Mobile */}
      <div 
        className={`fixed inset-0 bg-black/50 z-40 lg:hidden backdrop-blur-sm transition-opacity duration-300 ${
          isOpen ? 'opacity-100 visible' : 'opacity-0 invisible'
        }`}
        onClick={onClose}
      />

      {/* Sidebar */}
      <aside 
        className={`
          fixed inset-y-0 left-0 z-50 w-64 bg-[#1C1C1C] text-white shadow-2xl 
          transform transition-transform duration-300 ease-in-out
          lg:translate-x-0 lg:static lg:inset-auto flex flex-col h-screen
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        {/* Logo */}
        <div className="h-20 flex-shrink-0 flex items-center justify-between px-6 border-b border-gray-800">
          <div className="flex items-center gap-3 text-orange-500 font-bold text-xl tracking-wide">
            <Icon icon="solar:hamburger-menu-bold" width="32" />
            <span>TorresBurgers</span>
          </div>
          <button onClick={onClose} className="lg:hidden text-gray-400 hover:text-white transition-colors">
            <X size={24} />
          </button>
        </div>

        {/* Navegação (Flex-1 para ocupar espaço disponível) */}
        <nav className="flex-1 p-4 space-y-2 overflow-y-auto custom-scrollbar">
          {menuItems.map((item) => {
            const isActive = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                onClick={onClose}
                className={`flex items-center gap-4 px-4 py-3 rounded-xl transition-all duration-200 group ${
                  isActive 
                    ? 'bg-orange-600 text-white shadow-lg shadow-orange-900/50' 
                    : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                }`}
              >
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

        {/* Logout (Fixo no rodapé) */}
        <div className="p-4 border-t border-gray-800 mt-auto bg-[#1C1C1C]">
          <button 
            onClick={handleLogout}
            className="flex items-center gap-4 w-full px-4 py-3 text-red-400 hover:bg-red-500/10 hover:text-red-300 rounded-xl transition-colors group"
          >
            <Icon icon="solar:logout-2-bold-duotone" width="24" className="group-hover:-translate-x-1 transition-transform" />
            <span className="font-medium text-sm">Sair do Sistema</span>
          </button>
        </div>
      </aside>
    </>
  );
}