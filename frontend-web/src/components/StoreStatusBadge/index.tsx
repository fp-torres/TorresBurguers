import { Store, Lock } from 'lucide-react';
import { useStoreStatus } from '../../contexts/StoreStatusContext';

const BASE_CLASSES = 'flex items-center justify-center gap-1.5 h-10 px-3 md:min-w-fit min-w-[40px] rounded-xl text-xs font-bold border shadow-sm animate-in fade-in transition-all';

/** Selo "Aberto/Fechado" do cabeçalho da loja (status compartilhado, atualizado a cada 30 s). */
export function StoreStatusBadge() {
  const { status } = useStoreStatus();

  // Ainda sem resposta da API: selo neutro, sem afirmar aberto ou fechado
  if (!status) {
    return (
      <div className={`${BASE_CLASSES} bg-gray-50 dark:bg-slate-800 text-gray-400 dark:text-gray-500 border-gray-200 dark:border-slate-700`} aria-label="Verificando se a loja está aberta">
        <Store size={18} className="shrink-0 animate-pulse" />
        <span className="uppercase tracking-wide hidden md:inline">...</span>
      </div>
    );
  }

  if (status.is_open) {
    return (
      <div className={`${BASE_CLASSES} bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800`} title={status.opening_message || 'Loja aberta para pedidos'}>
        <Store size={18} className="shrink-0" />
        <span className="uppercase tracking-wide hidden md:inline">Aberto</span>
      </div>
    );
  }

  return (
    <div className={`${BASE_CLASSES} bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800`} title={status.closing_message || 'Loja fechada no momento'}>
      <Lock size={18} className="shrink-0" />
      <span className="uppercase tracking-wide hidden md:inline">Fechado</span>
    </div>
  );
}
