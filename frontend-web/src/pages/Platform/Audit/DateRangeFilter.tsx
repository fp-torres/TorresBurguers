import { useId, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { FormField, cx, fieldControlClass } from '../../../components/ui';
import { isDateKey } from '../../../utils/dates';

export interface DateRange {
  /** AAAA-MM-DD ou '' (sem limite). */
  from: string;
  to: string;
}

interface DateRangeFilterProps {
  from: string;
  to: string;
  /** Chamado só com um intervalo válido (início não depois do fim). */
  onChange: (range: DateRange) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Filtro de período (De/Até) das listas do superpainel. As datas valem o dia inteiro no fuso da plataforma
 * (regra da API). Intervalo invertido mostra o erro e não é aplicado.
 */
export default function DateRangeFilter({ from, to, onChange, disabled = false, className }: DateRangeFilterProps) {
  const errorId = useId();
  const [draft, setDraft] = useState<DateRange>({ from, to });
  // Valor alterado por fora (ex.: "Limpar filtros"): os campos acompanham
  const [synced, setSynced] = useState<DateRange>({ from, to });
  if (synced.from !== from || synced.to !== to) {
    setSynced({ from, to });
    setDraft({ from, to });
  }

  const inverted = !!draft.from && !!draft.to && draft.from > draft.to;
  const invalidProps = inverted ? { 'aria-invalid': true as const, 'aria-describedby': errorId } : {};

  function update(next: DateRange) {
    setDraft(next);
    const complete = (!next.from || isDateKey(next.from)) && (!next.to || isDateKey(next.to));
    const ordered = !next.from || !next.to || next.from <= next.to;
    if (complete && ordered && (next.from !== from || next.to !== to)) onChange(next);
  }

  return (
    <div className={cx('space-y-1.5', className)}>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="De">
          {(field) => (
            <input
              {...field}
              {...invalidProps}
              type="date"
              value={draft.from}
              max={draft.to || undefined}
              onChange={(event) => update({ ...draft, from: event.target.value })}
              disabled={disabled}
              className={fieldControlClass(inverted)}
            />
          )}
        </FormField>
        <FormField label="Até">
          {(field) => (
            <input
              {...field}
              {...invalidProps}
              type="date"
              value={draft.to}
              min={draft.from || undefined}
              onChange={(event) => update({ ...draft, to: event.target.value })}
              disabled={disabled}
              className={fieldControlClass(inverted)}
            />
          )}
        </FormField>
      </div>
      {inverted && (
        <p id={errorId} role="alert" className="flex items-start gap-1 text-xs font-semibold text-red-600 dark:text-red-400">
          <AlertCircle size={13} className="shrink-0 mt-px" aria-hidden="true" /> <span>A data inicial não pode ser depois da final.</span>
        </p>
      )}
    </div>
  );
}
