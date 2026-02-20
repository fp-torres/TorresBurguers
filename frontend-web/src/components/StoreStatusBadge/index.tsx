import { useEffect, useState } from 'react';
import { Store, Lock } from 'lucide-react';
import api from '../../services/api';

export function StoreStatusBadge() {
  const [isOpen, setIsOpen] = useState(true);

  useEffect(() => {
    // Busca status inicial
    api.get('/store/status').then(res => setIsOpen(res.data.is_open));

    // Atualiza a cada 30 segundos (Polling)
    const interval = setInterval(() => {
        api.get('/store/status').then(res => setIsOpen(res.data.is_open));
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  if (isOpen) {
    return (
      <div className="flex items-center justify-center gap-1.5 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 h-10 px-3 md:min-w-fit min-w-[40px] rounded-xl text-xs font-bold border border-green-200 dark:border-green-800 shadow-sm animate-in fade-in transition-all">
        <Store size={18} className="shrink-0" /> 
        <span className="uppercase tracking-wide hidden md:inline">Aberto</span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center gap-1.5 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 h-10 px-3 md:min-w-fit min-w-[40px] rounded-xl text-xs font-bold border border-red-200 dark:border-red-800 shadow-sm animate-in fade-in transition-all">
      <Lock size={18} className="shrink-0" /> 
      <span className="uppercase tracking-wide hidden md:inline">Fechado</span>
    </div>
  );
}