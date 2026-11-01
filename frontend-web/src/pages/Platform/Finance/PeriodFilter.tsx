import { useId, useState, type FormEvent } from 'react';
import { AlertCircle, CalendarRange, Check } from 'lucide-react';
import { FilterTabs, FormField, buttonClass, fieldControlClass } from '../../../components/ui';
import { PERIOD_PRESETS, matchPreset, periodError, presetRange, type PeriodPreset, type PeriodRange } from './period';

interface PeriodFilterProps {
  /** Período pedido à API ('' = padrão da API). */
  range: PeriodRange;
  /** Período que a API usou (preenche o "Personalizado"). */
  effective: PeriodRange | null;
  /** Hoje no fuso da plataforma ("AAAA-MM-DD"). */
  today: string;
  onApply: (range: PeriodRange) => void;
  disabled?: boolean;
}

/**
 * Seletor de período do Financeiro: atalhos (padrão: últimos 12 meses do calendário) e intervalo
 * personalizado com as mesmas regras da API (datas válidas, início antes do fim, até 3 anos).
 * Quem usa remonta o componente (key) quando o período aplicado muda.
 */
export default function PeriodFilter({ range, effective, today, onApply, disabled = false }: PeriodFilterProps) {
  const errorId = useId();
  const applied = matchPreset(range, today);
  const [customOpen, setCustomOpen] = useState(applied === 'custom');
  const [draft, setDraft] = useState<PeriodRange>(() => (range.from && range.to ? range : effective ?? { from: '', to: '' }));
  const [submitted, setSubmitted] = useState(false);
  const selected: PeriodPreset = customOpen ? 'custom' : applied;
  const error = submitted ? periodError(draft) : null;

  function choose(preset: PeriodPreset) {
    if (preset === 'custom') {
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    setSubmitted(false);
    const next = presetRange(preset, today);
    if (next && (next.from !== range.from || next.to !== range.to)) onApply(next);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (periodError(draft)) return;
    onApply({ from: draft.from, to: draft.to });
  }

  const invalidProps = error ? { 'aria-invalid': true as const, 'aria-describedby': errorId } : {};

  return (
    <div className="space-y-3">
      <FilterTabs
        options={PERIOD_PRESETS.map((preset) => ({
          value: preset.value,
          label: preset.label,
          icon: preset.value === 'custom' ? <CalendarRange size={16} /> : undefined,
        }))}
        value={selected}
        onChange={choose}
        label="Período do financeiro"
        className="-mx-2"
      />

      {customOpen && (
        <form onSubmit={handleSubmit} noValidate className="space-y-2">
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <FormField label="De" className="sm:w-48">
              {(field) => (
                <input
                  {...field}
                  {...invalidProps}
                  type="date"
                  value={draft.from}
                  onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
                  disabled={disabled}
                  className={fieldControlClass(!!error)}
                />
              )}
            </FormField>
            <FormField label="Até" className="sm:w-48">
              {(field) => (
                <input
                  {...field}
                  {...invalidProps}
                  type="date"
                  value={draft.to}
                  min={draft.from || undefined}
                  onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
                  disabled={disabled}
                  className={fieldControlClass(!!error)}
                />
              )}
            </FormField>
            <button type="submit" disabled={disabled} className={buttonClass('primary')}>
              <Check size={16} aria-hidden="true" /> Aplicar período
            </button>
          </div>
          {error && (
            <p id={errorId} role="alert" className="flex items-start gap-1 text-xs font-semibold text-red-600 dark:text-red-400">
              <AlertCircle size={13} className="shrink-0 mt-px" aria-hidden="true" /> <span>{error}</span>
            </p>
          )}
        </form>
      )}
    </div>
  );
}
