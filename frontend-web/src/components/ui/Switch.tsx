import { useId, type ReactNode } from 'react';
import { cx } from './styles';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/** Interruptor liga/desliga (role="switch") com rótulo e descrição ligados por aria. */
export default function Switch({ checked, onChange, label, description, disabled = false, className }: SwitchProps) {
  const labelId = useId();
  const descriptionId = useId();

  return (
    <div className={cx('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <p id={labelId} className="text-sm font-bold text-gray-800 dark:text-gray-100">{label}</p>
        {description && <div id={descriptionId} className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-800',
          'disabled:opacity-60 disabled:cursor-not-allowed',
          checked ? 'bg-orange-600' : 'bg-gray-300 dark:bg-slate-600',
        )}
      >
        <span
          aria-hidden="true"
          className={cx('inline-block h-5 w-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-6' : 'translate-x-1')}
        />
      </button>
    </div>
  );
}
