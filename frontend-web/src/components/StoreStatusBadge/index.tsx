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
      <div className="flex items-center gap-1 bg-green-100 text-green-700 px-3 py-1 rounded-full text-xs font-bold border border-green-200 shadow-sm animate-in fade-in">
        <Store size={14} /> 
        <span className="uppercase tracking-wide">Aberto</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 bg-red-100 text-red-700 px-3 py-1 rounded-full text-xs font-bold border border-red-200 shadow-sm animate-in fade-in">
      <Lock size={14} /> 
      <span className="uppercase tracking-wide">Fechado</span>
    </div>
  );
}