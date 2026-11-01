import type { ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { buttonClass, cx } from './styles';

export interface ErrorStateProps {
  title?: string;
  /** Motivo (ex.: getApiErrorMessage(error, '...')). */
  message?: ReactNode;
  /** Mostra o botão "Tentar novamente". */
  onRetry?: () => void;
  retryLabel?: string;
  /** Nova tentativa em andamento: o botão fica desabilitado e o ícone gira. */
  retrying?: boolean;
  /** Ação extra ao lado da nova tentativa (ex.: "Sair"). */
  action?: ReactNode;
  /** Versão com menos espaço (dentro de tabelas e cartões). */
  compact?: boolean;
  className?: string;
}

/** Falha ao carregar: explica o que houve e oferece uma nova tentativa. */
export default function ErrorState({
  title = 'Não foi possível carregar',
  message,
  onRetry,
  retryLabel = 'Tentar novamente',
  retrying = false,
  action,
  compact = false,
  className,
}: ErrorStateProps) {
  return (
    <div role="alert" className={cx('flex flex-col items-center justify-center text-center', compact ? 'gap-2 px-4 py-10' : 'gap-3 px-6 py-16', className)}>
      <div className="p-4 rounded-full bg-red-50 dark:bg-red-900/20 text-red-500 dark:text-red-400 border border-red-100 dark:border-red-900" aria-hidden="true">
        <AlertTriangle size={compact ? 28 : 36} />
      </div>
      <p className="font-bold text-gray-800 dark:text-white">{title}</p>
      {message && <div className="text-sm text-gray-500 dark:text-gray-400 max-w-md">{message}</div>}
      {(onRetry || action) && (
        <div className="mt-2 flex flex-col sm:flex-row items-center gap-2">
          {onRetry && (
            <button type="button" onClick={onRetry} disabled={retrying} className={buttonClass('primary', 'md')}>
              <RotateCcw size={16} className={retrying ? 'animate-spin' : undefined} aria-hidden="true" /> {retryLabel}
            </button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}
