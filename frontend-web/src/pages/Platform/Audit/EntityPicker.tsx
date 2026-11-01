import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Loader2, Search, X } from 'lucide-react';
import { cx } from '../../../components/ui';
import { useDebouncedValue } from '../../../hooks/useDebouncedValue';
import { getApiErrorMessage } from '../../../services/api';
import type { PickerOption } from './pickerOptions';

export interface EntityPickerProps {
  /** id do campo (o rótulo vem de fora: use dentro de um FormField e repasse as props dele). */
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  value: PickerOption | null;
  onChange: (option: PickerOption | null) => void;
  /** Busca as opções (termo vazio = primeiras opções). Use o signal na requisição. */
  search: (term: string, signal: AbortSignal) => Promise<PickerOption[]>;
  placeholder?: string;
  /** Nome acessível da lista de resultados (ex.: "Lojas encontradas"). */
  listLabel: string;
  noResultsText?: string;
  /** Nome acessível do botão de limpar (ex.: "Remover o filtro de loja"). */
  clearLabel?: string;
  disabled?: boolean;
  className?: string;
}

interface SettledSearch {
  term: string;
  items: PickerOption[];
  error: string | null;
}

/**
 * Seletor com busca na API (combobox acessível, padrão WAI-ARIA 1.2): digitar busca com pausa, setas
 * ↑/↓ escolhem, Enter confirma, Esc fecha e devolve o texto escolhido. O botão X limpa a escolha.
 */
export default function EntityPicker({
  id,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  value,
  onChange,
  search,
  placeholder = 'Buscar...',
  listLabel,
  noResultsText = 'Nenhum resultado.',
  clearLabel = 'Limpar',
  disabled = false,
  className,
}: EntityPickerProps) {
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedLabel = value?.label ?? '';
  const [text, setText] = useState(selectedLabel);
  // Escolha alterada por fora (ex.: "Limpar filtros"): o campo acompanha
  const [syncedLabel, setSyncedLabel] = useState(selectedLabel);
  if (selectedLabel !== syncedLabel) {
    setSyncedLabel(selectedLabel);
    setText(selectedLabel);
  }

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [settled, setSettled] = useState<SettledSearch | null>(null);

  // Com o texto da escolha atual no campo, a lista mostra as primeiras opções (sem filtrar por ele)
  const term = text === selectedLabel ? '' : text.trim();
  const debouncedTerm = useDebouncedValue(term, 250);

  const searchRef = useRef(search);
  useEffect(() => {
    searchRef.current = search;
  });

  useEffect(() => {
    if (!open || disabled) return;
    const controller = new AbortController();
    Promise.resolve()
      .then(() => searchRef.current(debouncedTerm, controller.signal))
      .then((items) => {
        if (!controller.signal.aborted) setSettled({ term: debouncedTerm, items, error: null });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setSettled({ term: debouncedTerm, items: [], error: getApiErrorMessage(error, 'Não foi possível buscar agora.') });
        }
      });
    return () => controller.abort();
  }, [open, disabled, debouncedTerm]);

  const ready = settled !== null && settled.term === debouncedTerm && debouncedTerm === term;
  const items = ready ? settled.items : [];
  const loading = open && !ready;
  const activeIndex = active >= 0 && active < items.length ? active : -1;

  useEffect(() => {
    if (open && activeIndex >= 0) document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' });
  });

  function close() {
    setOpen(false);
    setActive(-1);
    setText(selectedLabel);
  }

  function select(option: PickerOption) {
    if (option.disabledReason) return;
    onChange(option);
    setText(option.label);
    setOpen(false);
    setActive(-1);
  }

  function clear() {
    onChange(null);
    setText('');
    setActive(-1);
    inputRef.current?.focus();
  }

  function move(step: 1 | -1) {
    if (!open) {
      setOpen(true);
      return;
    }
    if (items.length === 0) return;
    setActive((current) => {
      const start = current >= 0 && current < items.length ? current : step === 1 ? -1 : items.length;
      return (start + step + items.length) % items.length;
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      // Com a lista aberta, Enter escolhe (e nunca envia um formulário em volta por engano)
      if (open) {
        event.preventDefault();
        if (activeIndex >= 0) select(items[activeIndex]);
      }
    } else if (event.key === 'Escape') {
      if (open) {
        // Fecha só a lista (sem fechar um modal em volta)
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }
  }

  return (
    <div className={cx('relative', className)}>
      <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 pointer-events-none" aria-hidden="true" />
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={close}
        onKeyDown={handleKeyDown}
        className={cx(
          'w-full pl-10 py-2.5 rounded-xl border outline-none transition-all text-sm',
          value && !disabled ? 'pr-10' : 'pr-4',
          'bg-white dark:bg-slate-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500',
          'focus:ring-2 disabled:opacity-60 disabled:cursor-not-allowed',
          invalid
            ? 'border-red-400 dark:border-red-500 focus:ring-red-200 dark:focus:ring-red-900/60'
            : 'border-gray-200 dark:border-slate-700 focus:ring-orange-500 focus:border-orange-500',
        )}
      />
      {value && !disabled && (
        <button
          type="button"
          onClick={clear}
          aria-label={clearLabel}
          title={clearLabel}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
        >
          <X size={16} aria-hidden="true" />
        </button>
      )}

      <div
        hidden={!open}
        // Clicar na lista não tira o foco do campo (o blur fecharia a lista antes do clique)
        onMouseDown={(event) => event.preventDefault()}
        className="absolute z-30 left-0 right-0 mt-1 rounded-xl border shadow-lg overflow-hidden bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700"
      >
        <p role="status" className={cx('px-4 text-xs text-gray-500 dark:text-gray-400', (loading || (ready && (settled?.error || items.length === 0))) && 'py-3')}>
          {loading ? (
            <span className="inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Buscando...</span>
          ) : ready && settled?.error ? (
            <span className="text-red-600 dark:text-red-400">{settled.error}</span>
          ) : ready && items.length === 0 ? (
            noResultsText
          ) : null}
        </p>
        <ul id={listId} role="listbox" aria-label={listLabel} className="max-h-72 overflow-y-auto custom-scrollbar">
          {items.map((option, index) => {
            const isActive = index === activeIndex;
            const isSelected = value?.id === option.id;
            return (
              <li
                key={option.id}
                id={optionId(index)}
                role="option"
                aria-selected={isActive}
                aria-disabled={option.disabledReason ? true : undefined}
                onClick={() => select(option)}
                onMouseEnter={() => setActive(index)}
                className={cx(
                  'flex items-start gap-2 px-4 py-2.5 text-sm',
                  option.disabledReason ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                  isActive ? 'bg-orange-50 dark:bg-slate-700' : '',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-gray-800 dark:text-gray-100 truncate">{option.label}</span>
                  {option.description && <span className="block text-xs text-gray-500 dark:text-gray-400 truncate">{option.description}</span>}
                  {option.disabledReason && <span className="block text-xs font-semibold text-amber-700 dark:text-amber-300">{option.disabledReason}</span>}
                </span>
                {isSelected && <Check size={16} className="shrink-0 mt-0.5 text-orange-600 dark:text-orange-400" aria-label="Escolhida" />}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
