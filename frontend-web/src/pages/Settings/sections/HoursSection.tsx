import { useId, useState } from 'react';
import { CalendarClock, Copy, Moon, Plus, X } from 'lucide-react';
import { Switch, buttonClass, cx, fieldControlClass } from '../../../components/ui';
import type { OpeningHoursEntry, StoreSettings } from '../../../services/storeSettingsService';
import SettingsSection from '../SettingsSection';
import { changedFields, type SectionProps } from '../types';
import { useReportDirty, useSettingsSave } from '../useSettingsSave';
import { MAX_OPENING_HOURS_ENTRIES, MAX_SHIFTS_PER_DAY, isValidTime } from '../validation';

interface Shift {
  key: number;
  open: string;
  close: string;
}

interface DayDraft {
  open: boolean;
  shifts: Shift[];
}

type Draft = Record<number, DayDraft>;

/** Dias na ordem da semana comercial (segunda a domingo); day 0 = domingo, como na API. */
const DAYS: { day: number; label: string }[] = [
  { day: 1, label: 'Segunda-feira' },
  { day: 2, label: 'Terça-feira' },
  { day: 3, label: 'Quarta-feira' },
  { day: 4, label: 'Quinta-feira' },
  { day: 5, label: 'Sexta-feira' },
  { day: 6, label: 'Sábado' },
  { day: 0, label: 'Domingo' },
];

const DEFAULT_SHIFT = { open: '18:00', close: '23:00' };

let shiftKeySequence = 0;
function nextShiftKey(): number {
  shiftKeySequence += 1;
  return shiftKeySequence;
}

function newShift(open = DEFAULT_SHIFT.open, close = DEFAULT_SHIFT.close): Shift {
  return { key: nextShiftKey(), open, close };
}

function draftFrom(settings: StoreSettings): Draft {
  const draft: Draft = {};
  for (const { day } of DAYS) {
    const entries = (settings.opening_hours ?? []).filter((entry) => entry.day === day);
    draft[day] = entries.length
      ? { open: true, shifts: entries.map((entry) => newShift(entry.open, entry.close)) }
      : { open: false, shifts: [newShift()] };
  }
  return draft;
}

/** Lista para a API, ordenada por dia e horário (mesma ordem que a API grava). null = sem horários. */
function toEntries(draft: Draft): OpeningHoursEntry[] | null {
  const entries: OpeningHoursEntry[] = [];
  for (let day = 0; day <= 6; day += 1) {
    const current = draft[day];
    if (!current?.open) continue;
    current.shifts.forEach((shift) => entries.push({ day, open: shift.open, close: shift.close }));
  }
  entries.sort((a, b) => a.day - b.day || a.open.localeCompare(b.open));
  return entries.length ? entries : null;
}

/** Problemas por dia (mesmas regras da API). */
function validate(draft: Draft): Record<number, string> {
  const errors: Record<number, string> = {};
  for (const { day } of DAYS) {
    const current = draft[day];
    if (!current?.open) continue;
    const seen = new Set<string>();
    for (const shift of current.shifts) {
      if (!isValidTime(shift.open) || !isValidTime(shift.close)) {
        errors[day] = 'Preencha a abertura e o fechamento no formato HH:MM.';
        break;
      }
      if (shift.open === shift.close) {
        errors[day] = `Um turno abre e fecha no mesmo horário (${shift.open}).`;
        break;
      }
      const key = `${shift.open}-${shift.close}`;
      if (seen.has(key)) {
        errors[day] = 'Há turnos repetidos neste dia.';
        break;
      }
      seen.add(key);
    }
  }
  return errors;
}

/** Horários de funcionamento exibidos na vitrine (informativos: abrir/fechar é manual). */
export default function HoursSection({ settings, readOnly, onSaved, onDirtyChange }: SectionProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(settings));
  const [showErrors, setShowErrors] = useState(false);
  const { saving, save } = useSettingsSave(onSaved);

  const entries = toEntries(draft);
  const changes = changedFields(settings, { opening_hours: entries });
  const dirty = Object.keys(changes).length > 0;
  useReportDirty('horarios', dirty, onDirtyChange);

  const dayErrors = showErrors ? validate(draft) : {};
  const tooMany = (entries?.length ?? 0) > MAX_OPENING_HOURS_ENTRIES;

  function updateDay(day: number, update: (current: DayDraft) => DayDraft) {
    setDraft((current) => ({ ...current, [day]: update(current[day]) }));
  }

  function copyToAll(day: number) {
    setDraft((current) => {
      const source = current[day];
      const next: Draft = {};
      for (const { day: target } of DAYS) {
        next[target] = { open: source.open, shifts: source.shifts.map((shift) => newShift(shift.open, shift.close)) };
      }
      return next;
    });
  }

  async function handleSubmit() {
    if (Object.keys(validate(draft)).length > 0 || tooMany) {
      setShowErrors(true);
      return;
    }
    await save(changes, 'Horários de funcionamento salvos.');
  }

  const openDays = DAYS.filter(({ day }) => draft[day]?.open).length;

  return (
    <SettingsSection
      title="Horários de funcionamento"
      description="Exibidos na vitrine. Abrir e fechar a loja continua manual (Operação). Fechamento antes da abertura = vira a madrugada."
      icon={<CalendarClock size={20} />}
      dirty={dirty}
      saving={saving}
      readOnly={readOnly}
      onSubmit={handleSubmit}
      onDiscard={() => {
        setDraft(draftFrom(settings));
        setShowErrors(false);
      }}
    >
      {openDays === 0 && (
        <p className="px-4 py-3 rounded-xl text-sm bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200 border border-blue-200 dark:border-blue-800">
          Nenhum dia aberto: a vitrine não mostra horários.
        </p>
      )}
      {showErrors && tooMany && (
        <p role="alert" className="px-4 py-3 rounded-xl text-sm font-semibold bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800">
          Informe no máximo {MAX_OPENING_HOURS_ENTRIES} turnos na semana.
        </p>
      )}

      <ul className="divide-y divide-gray-100 dark:divide-slate-700 -my-2">
        {DAYS.map(({ day, label }) => (
          <li key={day} className="py-4">
            <DayRow
              label={label}
              value={draft[day]}
              error={dayErrors[day]}
              readOnly={readOnly}
              onChange={(update) => updateDay(day, update)}
              onCopyToAll={() => copyToAll(day)}
            />
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
}

interface DayRowProps {
  label: string;
  value: DayDraft;
  error?: string;
  readOnly: boolean;
  onChange: (update: (current: DayDraft) => DayDraft) => void;
  onCopyToAll: () => void;
}

function DayRow({ label, value, error, readOnly, onChange, onCopyToAll }: DayRowProps) {
  const errorId = useId();

  return (
    <div className="flex flex-col lg:flex-row lg:items-start gap-3 lg:gap-6">
      <div className="lg:w-56 shrink-0">
        <Switch
          checked={value.open}
          onChange={(open) => onChange((current) => ({ ...current, open }))}
          label={label}
          description={value.open ? 'Aberto' : 'Fechado'}
          disabled={readOnly}
        />
      </div>

      {value.open ? (
        <div className="flex-1 min-w-0 space-y-2">
          {value.shifts.map((shift, index) => {
            const overnight = isValidTime(shift.open) && isValidTime(shift.close) && shift.close < shift.open;
            return (
              <div key={shift.key} className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor={`open-${shift.key}`}>{label}: abre (turno {index + 1})</label>
                <input
                  id={`open-${shift.key}`}
                  type="time"
                  value={shift.open}
                  onChange={(event) => {
                    const time = event.target.value;
                    onChange((current) => ({
                      ...current,
                      shifts: current.shifts.map((item) => (item.key === shift.key ? { ...item, open: time } : item)),
                    }));
                  }}
                  disabled={readOnly}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  className={fieldControlClass(!!error, 'w-32')}
                />
                <span className="text-sm text-gray-500 dark:text-gray-400" aria-hidden="true">às</span>
                <label className="sr-only" htmlFor={`close-${shift.key}`}>{label}: fecha (turno {index + 1})</label>
                <input
                  id={`close-${shift.key}`}
                  type="time"
                  value={shift.close}
                  onChange={(event) => {
                    const time = event.target.value;
                    onChange((current) => ({
                      ...current,
                      shifts: current.shifts.map((item) => (item.key === shift.key ? { ...item, close: time } : item)),
                    }));
                  }}
                  disabled={readOnly}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  className={fieldControlClass(!!error, 'w-32')}
                />
                {overnight && (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 dark:text-indigo-300">
                    <Moon size={12} aria-hidden="true" /> até a madrugada seguinte
                  </span>
                )}
                {!readOnly && value.shifts.length > 1 && (
                  <button
                    type="button"
                    onClick={() => onChange((current) => ({ ...current, shifts: current.shifts.filter((item) => item.key !== shift.key) }))}
                    aria-label={`Remover o turno ${index + 1} de ${label}`}
                    className={buttonClass('ghost', 'icon', 'text-red-600 dark:text-red-400')}
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                )}
              </div>
            );
          })}
          {error && <p id={errorId} className="text-xs font-semibold text-red-600 dark:text-red-400">{error}</p>}
          {!readOnly && (
            <div className="flex flex-wrap gap-2 pt-1">
              {value.shifts.length < MAX_SHIFTS_PER_DAY && (
                <button
                  type="button"
                  onClick={() => onChange((current) => ({ ...current, shifts: [...current.shifts, newShift()] }))}
                  className={buttonClass('ghost', 'sm')}
                >
                  <Plus size={14} aria-hidden="true" /> Turno
                </button>
              )}
              <button type="button" onClick={onCopyToAll} className={buttonClass('ghost', 'sm')}>
                <Copy size={14} aria-hidden="true" /> Copiar para todos os dias
              </button>
            </div>
          )}
        </div>
      ) : (
        <p className={cx('flex-1 text-sm text-gray-400 dark:text-gray-500 lg:pt-1')}>Fechado o dia todo.</p>
      )}
    </div>
  );
}
