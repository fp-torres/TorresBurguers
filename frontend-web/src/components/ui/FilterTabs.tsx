import type { ReactNode } from 'react';
import { cx } from './styles';

export interface FilterTabOption<V extends string> {
  value: V;
  label: string;
  /** Contador ao lado do rótulo (ex.: quantas lojas em cada situação). */
  count?: number;
  icon?: ReactNode;
}

export interface FilterTabsProps<V extends string> {
  options: FilterTabOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Nome acessível do grupo (ex.: "Filtrar por situação"). */
  label: string;
  className?: string;
}

/**
 * Filtros em abas com contador (mesmo visual da tela Equipe). São botões de alternância (aria-pressed):
 * filtram a lista exibida, não trocam de painel (para isso use Tabs).
 */
export default function FilterTabs<V extends string>({ options, value, onChange, label, className }: FilterTabsProps<V>) {
  return (
    <div role="group" aria-label={label} className={cx('relative flex gap-2 p-2 overflow-x-auto custom-scrollbar', className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cx(
              'flex items-center gap-2 px-4 py-2.5 rounded-xl border font-bold text-sm whitespace-nowrap transition-all',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500',
              active
                ? 'bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 border-orange-100 dark:border-orange-800 shadow-sm'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-slate-700 hover:text-gray-700 dark:hover:text-white',
            )}
          >
            {option.icon && <span className="shrink-0 inline-flex" aria-hidden="true">{option.icon}</span>}
            {option.label}
            {option.count !== undefined && (
              <span
                className={cx(
                  'ml-1 text-xs px-2 py-0.5 rounded-full tabular-nums',
                  active ? 'bg-orange-200 dark:bg-orange-800 text-orange-800 dark:text-orange-200' : 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-gray-300',
                )}
              >
                <span className="sr-only">(</span>{option.count}<span className="sr-only">)</span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
