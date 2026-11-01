import { Ban, Lock, Store } from 'lucide-react';

const BASE_CLASSES = 'flex items-center justify-center gap-1.5 h-10 px-3 md:min-w-fit min-w-[40px] rounded-xl text-xs font-bold border shadow-sm animate-in fade-in transition-all';

interface StoreStatusBadgeProps {
  /** Aberta agora (null = ainda sem resposta da API). */
  isOpen: boolean | null;
  /** false: a loja não está vendendo pela plataforma (suspensa ou sem assinatura). */
  orderingAvailable?: boolean;
  /** Mensagem da loja exibida como dica (abertura, fechamento ou indisponibilidade). */
  message?: string | null;
  /** Esconde o texto em telas estreitas (só o ícone, com o nome acessível). */
  compact?: boolean;
}

/** Selo "Aberto/Fechado/Indisponível" do cabeçalho da loja (status atualizado a cada 30 s pela vitrine). */
export function StoreStatusBadge({ isOpen, orderingAvailable = true, message, compact = false }: StoreStatusBadgeProps) {
  const labelClass = `uppercase tracking-wide ${compact ? 'hidden md:inline' : ''}`;

  if (!orderingAvailable) {
    return (
      <div role="status" className={`${BASE_CLASSES} bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800`} title={message || 'Pedidos indisponíveis no momento'} aria-label="Loja sem pedidos pelo site no momento">
        <Ban size={18} className="shrink-0" aria-hidden="true" />
        <span className={labelClass} aria-hidden="true">Indisponível</span>
      </div>
    );
  }

  // Ainda sem resposta da API: selo neutro, sem afirmar aberto ou fechado
  if (isOpen === null) {
    return (
      <div role="status" className={`${BASE_CLASSES} bg-gray-50 dark:bg-slate-800 text-gray-400 dark:text-gray-500 border-gray-200 dark:border-slate-700`} aria-label="Verificando se a loja está aberta">
        <Store size={18} className="shrink-0 animate-pulse" aria-hidden="true" />
        <span className={labelClass} aria-hidden="true">...</span>
      </div>
    );
  }

  if (isOpen) {
    return (
      <div role="status" className={`${BASE_CLASSES} bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800`} title={message || 'Loja aberta para pedidos'} aria-label="Loja aberta">
        <Store size={18} className="shrink-0" aria-hidden="true" />
        <span className={labelClass} aria-hidden="true">Aberto</span>
      </div>
    );
  }

  return (
    <div role="status" className={`${BASE_CLASSES} bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800`} title={message || 'Loja fechada no momento'} aria-label="Loja fechada">
      <Lock size={18} className="shrink-0" aria-hidden="true" />
      <span className={labelClass} aria-hidden="true">Fechado</span>
    </div>
  );
}
