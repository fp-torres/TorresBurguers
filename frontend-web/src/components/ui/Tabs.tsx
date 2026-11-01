import { useId, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './styles';

export interface TabItem<V extends string> {
  value: V;
  label: ReactNode;
  icon?: ReactNode;
  /** Contador ou selo após o rótulo. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<V extends string> {
  tabs: TabItem<V>[];
  /** Aba selecionada. */
  value: V;
  onChange: (value: V) => void;
  /** Nome acessível do conjunto de abas. */
  label: string;
  /** Conteúdo da aba selecionada (renderizado no painel ligado a ela). */
  children?: ReactNode;
  className?: string;
  panelClassName?: string;
}

/**
 * Abas acessíveis (padrão WAI-ARIA): role="tablist"/"tab"/"tabpanel", setas ←/→, Home e End
 * movem o foco e selecionam a aba; só a aba selecionada entra na ordem do Tab.
 */
export default function Tabs<V extends string>({ tabs, value, onChange, label, children, className, panelClassName }: TabsProps<V>) {
  const baseId = useId();
  const tabId = (tabValue: string) => `${baseId}-tab-${tabValue}`;
  const panelId = `${baseId}-panel`;
  const enabledTabs = tabs.filter((tab) => !tab.disabled);
  const selected = tabs.find((tab) => tab.value === value && !tab.disabled) ?? enabledTabs[0];

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (enabledTabs.length === 0) return;
    const index = Math.max(0, enabledTabs.findIndex((tab) => tab.value === selected?.value));
    let next: TabItem<V> | undefined;
    if (event.key === 'ArrowRight') next = enabledTabs[(index + 1) % enabledTabs.length];
    else if (event.key === 'ArrowLeft') next = enabledTabs[(index - 1 + enabledTabs.length) % enabledTabs.length];
    else if (event.key === 'Home') next = enabledTabs[0];
    else if (event.key === 'End') next = enabledTabs[enabledTabs.length - 1];
    if (!next) return;

    event.preventDefault();
    onChange(next.value);
    document.getElementById(tabId(next.value))?.focus();
  }

  return (
    <div className={className}>
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={handleKeyDown}
        className="relative flex gap-1 overflow-x-auto custom-scrollbar border-b border-gray-200 dark:border-slate-700"
      >
        {tabs.map((tab) => {
          const isSelected = tab.value === selected?.value;
          return (
            <button
              key={tab.value}
              id={tabId(tab.value)}
              type="button"
              role="tab"
              aria-selected={isSelected}
              aria-controls={children !== undefined ? panelId : undefined}
              tabIndex={isSelected ? 0 : -1}
              disabled={tab.disabled}
              onClick={() => onChange(tab.value)}
              className={cx(
                'flex items-center gap-2 -mb-px px-4 sm:px-5 py-3 border-b-2 rounded-t-lg font-bold text-sm whitespace-nowrap transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500 disabled:opacity-40 disabled:cursor-not-allowed',
                isSelected
                  ? 'border-orange-500 text-orange-600 dark:text-orange-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200',
              )}
            >
              {tab.icon && <span className="shrink-0 inline-flex" aria-hidden="true">{tab.icon}</span>}
              {tab.label}
              {tab.badge !== undefined && tab.badge !== null && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-300 tabular-nums">{tab.badge}</span>
              )}
            </button>
          );
        })}
      </div>

      {children !== undefined && (
        <div
          role="tabpanel"
          id={panelId}
          aria-labelledby={selected ? tabId(selected.value) : undefined}
          tabIndex={0}
          className={cx('pt-5 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 rounded-lg', panelClassName)}
        >
          {children}
        </div>
      )}
    </div>
  );
}
