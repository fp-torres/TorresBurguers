import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { cx } from './styles';

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  /** Ícone decorativo (padrão: caixa vazia). */
  icon?: ReactNode;
  /** Ação sugerida (ex.: botão "Novo estabelecimento" ou "Limpar filtros"). */
  action?: ReactNode;
  /** Versão com menos espaço (dentro de tabelas e cartões). */
  compact?: boolean;
  className?: string;
}

/** Estado vazio: nada para mostrar (lista sem itens, busca sem resultados). */
export default function EmptyState({ title, description, icon, action, compact = false, className }: EmptyStateProps) {
  return (
    <div className={cx('flex flex-col items-center justify-center text-center', compact ? 'gap-2 px-4 py-10' : 'gap-3 px-6 py-16', className)}>
      <div className="p-4 rounded-full bg-gray-100 dark:bg-slate-700/60 text-gray-400 dark:text-gray-500" aria-hidden="true">
        {icon ?? <Inbox size={compact ? 28 : 36} />}
      </div>
      <p className="font-bold text-gray-700 dark:text-gray-200">{title}</p>
      {description && <div className="text-sm text-gray-500 dark:text-gray-400 max-w-md">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
