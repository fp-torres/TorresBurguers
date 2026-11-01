import type { ReactNode } from 'react';
import { cx } from './styles';

/** Tom do selo: success (ok/ativo), warning (atenção), danger (erro/bloqueio), info (informativo), neutral (inativo). */
export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const TONE_CLASSES: Record<StatusTone, string> = {
  success: 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800',
  warning: 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  danger: 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800',
  info: 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800',
  neutral: 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-slate-600',
};

const DOT_CLASSES: Record<StatusTone, string> = {
  success: 'bg-green-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
  info: 'bg-blue-500',
  neutral: 'bg-gray-400',
};

export interface StatusBadgeProps {
  children: ReactNode;
  tone?: StatusTone;
  /** Ícone antes do texto (decorativo). */
  icon?: ReactNode;
  /** Bolinha colorida antes do texto. */
  dot?: boolean;
  /** Dica ao passar o mouse. */
  title?: string;
  className?: string;
}

/** Selo de situação (loja, assinatura, fatura, usuário...). O texto sempre acompanha a cor. */
export default function StatusBadge({ children, tone = 'neutral', icon, dot = false, title, className }: StatusBadgeProps) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1.5 w-fit px-2.5 py-1 rounded-lg border text-xs font-bold whitespace-nowrap',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {dot && <span className={cx('w-1.5 h-1.5 rounded-full shrink-0', DOT_CLASSES[tone])} aria-hidden="true" />}
      {icon && <span className="shrink-0 inline-flex" aria-hidden="true">{icon}</span>}
      {children}
    </span>
  );
}
