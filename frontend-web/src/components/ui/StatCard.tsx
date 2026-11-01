import type { ReactNode } from 'react';
import { CARD_CLASS, cx } from './styles';

export type StatCardTone = 'orange' | 'emerald' | 'blue' | 'violet' | 'amber' | 'red' | 'slate';

const TONE_CLASSES: Record<StatCardTone, string> = {
  orange: 'bg-orange-500',
  emerald: 'bg-emerald-500',
  blue: 'bg-blue-500',
  violet: 'bg-violet-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  slate: 'bg-slate-500',
};

export interface StatCardProps {
  /** Nome do indicador (ex.: "MRR", "Lojas ativas"). */
  label: string;
  /** Valor já formatado (ex.: formatCurrency(mrr)). */
  value: ReactNode;
  /** Ícone decorativo (ex.: <Store size={22} />). */
  icon?: ReactNode;
  /** Cor do ícone e do detalhe do cartão (padrão: laranja). */
  tone?: StatCardTone;
  /** Texto de apoio abaixo do rótulo (ex.: "12 em teste grátis", "Projeção: MRR × 12"). */
  hint?: ReactNode;
  /** Mostra um esqueleto no lugar do valor. */
  loading?: boolean;
  className?: string;
}

/** Indicador (KPI) com ícone, valor e rótulo — mesmo visual dos cartões do Dashboard. */
export default function StatCard({ label, value, icon, tone = 'orange', hint, loading = false, className }: StatCardProps) {
  return (
    <div className={cx(CARD_CLASS, 'relative overflow-hidden h-full p-5 sm:p-6 flex flex-col justify-between hover:shadow-lg', className)}>
      <div className={cx('absolute -right-4 -top-4 w-24 h-24 rounded-full opacity-10', TONE_CLASSES[tone])} aria-hidden="true" />

      {icon && (
        <div className={cx('relative z-10 w-fit mb-4 p-3 rounded-xl text-white shadow-md', TONE_CLASSES[tone])} aria-hidden="true">
          {icon}
        </div>
      )}

      {/* O rótulo vem antes no HTML (leitores de tela leem "rótulo: valor"); na tela, o valor aparece em cima */}
      <div className="relative z-10 flex flex-col">
        <p className="order-2 mt-1 text-xs font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500">{label}</p>
        {loading ? (
          <div className="order-1 h-8 w-28 rounded-lg bg-gray-200 dark:bg-slate-700 animate-pulse" role="status">
            <span className="sr-only">Carregando</span>
          </div>
        ) : (
          <p className="order-1 text-2xl font-bold text-gray-800 dark:text-white tabular-nums wrap-break-word">{value}</p>
        )}
        {hint && <p className="order-3 mt-2 text-xs text-gray-400 dark:text-gray-500">{hint}</p>}
      </div>
    </div>
  );
}
