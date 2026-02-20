import { Link, useLocation } from 'react-router-dom';
import { Icon } from '@iconify/react';
import { X, Sun, Moon, Monitor, Smartphone } from 'lucide-react';
import { useState } from 'react';
import ConfirmModal from '../ConfirmModal';
import { useTheme } from '../../contexts/ThemeContext'; // Importando o Tema

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function Sidebar({ isOpen, onClose }: SidebarProps) {
  const location = useLocation();
  const [isLogoutModalOpen, setIsLogoutModalOpen] = useState(false);
  const { theme, setTheme } = useTheme(); // Hook do Tema

  const userStored = localStorage.getItem('torresburgers.user');
  let userRole = 'ADMIN';
  if (userStored) {
    try { userRole = JSON.parse(userStored).role; } catch {}
  }

  const allMenuItems = [
    { name: 'Dashboard', icon: 'solar:widget-5-bold-duotone', path: '/dashboard', roles: ['ADMIN'] },
    { name: 'Pedidos', icon: 'solar:bag-check-bold-duotone', path: '/orders', roles: ['ADMIN', 'KITCHEN', 'COURIER', 'EMPLOYEE'] },
    { name: 'Cardápio', icon: 'solar:chef-hat-bold-duotone', path: '/products', roles: ['ADMIN'] },
    { name: 'Equipe', icon: 'solar:users-group-rounded-bold-duotone', path: '/users', roles: ['ADMIN'] },
    { name: 'Lixeira', icon: 'solar:trash-bin-trash-bold-duotone', path: '/trash', roles: ['ADMIN'] },
  ];

  const menuItems = allMenuItems.filter(item => item.roles.includes(userRole));

  function executeLogout() {
    localStorage.removeItem('torresburgers.token');
    localStorage.removeItem('torresburgers.user');
    window.location.href = '/login';
  }

  // Ícone Dinâmico do Tema
  const ThemeIcon = () => {
    if (theme === 'dark') return <Moon size={18} />;
    if (theme === 'light') return <Sun size={18} />;
    return <Monitor size={18} />;
  };

  function cycleTheme() {
    if (theme === 'system') setTheme('light');
    else if (theme === 'light') setTheme('dark');
    else setTheme('system');
  }

  return (
    <>
      <div 
        className={`fixed inset-0 bg-black/50 z-40 lg:hidden backdrop-blur-sm transition-opacity duration-300 ${isOpen ? 'opacity-100 visible' : 'opacity-0 invisible'}`}
        onClick={onClose}
      />

      <aside 
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-[#1C1C1C] dark:bg-slate-950 text-white shadow-2xl transform transition-transform duration-300 ease-in-out lg:translate-x-0 lg:static lg:inset-auto flex flex-col h-screen ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="h-20 flex-shrink-0 flex items-center justify-between px-6 border-b border-gray-800 dark:border-slate-800">
          <div className="flex items-center gap-3 text-orange-500 font-bold text-xl tracking-wide">
            <Icon icon="solar:hamburger-menu-bold" width="32" />
            <span>Torres<span className="text-white text-sm font-normal opacity-50">Admin</span></span>
          </div>
          <button onClick={onClose} className="lg:hidden text-gray-400 hover:text-white transition-colors"><X size={24} /></button>
        </div>

        {/* Botão de Tema na Sidebar */}
        <div className="px-4 pt-4">
           <button 
             onClick={cycleTheme}
             className="w-full flex items-center justify-between px-4 py-2 bg-gray-800 dark:bg-slate-900 hover:bg-gray-700 dark:hover:bg-slate-800 rounded-xl text-xs font-bold text-gray-400 uppercase tracking-wider transition-colors border border-gray-700 dark:border-slate-800"
           >
             <span>Tema: {theme === 'system' ? 'Auto' : theme === 'dark' ? 'Escuro' : 'Claro'}</span>
             <ThemeIcon />
           </button>
        </div>

        <nav className="flex-1 p-4 space-y-2 overflow-y-auto custom-scrollbar">
          {menuItems.map((item) => {
            const isActive = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                onClick={onClose}
                className={`flex items-center gap-4 px-4 py-3 rounded-xl transition-all duration-200 group ${isActive ? 'bg-orange-600 text-white shadow-lg shadow-orange-900/50' : 'text-gray-400 hover:bg-gray-800 dark:hover:bg-slate-800 hover:text-white'}`}
              >
                <Icon icon={item.icon} width="24" className={isActive ? 'text-white' : 'text-gray-500 group-hover:text-white transition-colors'} />
                <span className="font-semibold text-sm">{item.name}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-gray-800 dark:border-slate-800 mt-auto bg-[#1C1C1C] dark:bg-slate-950">
          <button 
            onClick={() => setIsLogoutModalOpen(true)}
            className="flex items-center gap-4 w-full px-4 py-3 text-red-400 hover:bg-red-500/10 hover:text-red-300 rounded-xl transition-colors group"
          >
            <Icon icon="solar:logout-2-bold-duotone" width="24" className="group-hover:-translate-x-1 transition-transform" />
            <span className="font-medium text-sm">Sair do Sistema</span>
          </button>
        </div>
      </aside>

      <ConfirmModal 
        isOpen={isLogoutModalOpen}
        onClose={() => setIsLogoutModalOpen(false)}
        onConfirm={executeLogout}
        title="Sair do Sistema?"
        message="Você terá que fazer login novamente para acessar o sistema."
        confirmLabel="Sair"
        isDestructive
      />
    </>
  );
}