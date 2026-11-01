import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { cx } from './styles';

export interface SearchInputProps {
  /** Valor confirmado (ex.: query.search do usePaginatedQuery). Mudar por fora atualiza o campo. */
  value: string;
  /** Chamado depois de uma pausa na digitação (debounce), ao apertar Enter ou ao limpar. */
  onChange: (value: string) => void;
  /** Pausa na digitação antes de chamar onChange, em ms (padrão: 400). */
  delay?: number;
  placeholder?: string;
  /** Nome acessível (padrão: o placeholder). */
  label?: string;
  id?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  className?: string;
}

/** Campo de busca com debounce: a lista só é consultada quando a pessoa para de digitar. */
export default function SearchInput({
  value,
  onChange,
  delay = 400,
  placeholder = 'Buscar...',
  label,
  id,
  autoFocus,
  disabled,
  className,
}: SearchInputProps) {
  const [text, setText] = useState(value);
  // Valor alterado por fora (ex.: "limpar filtros"): o campo acompanha
  const [syncedValue, setSyncedValue] = useState(value);
  if (value !== syncedValue) {
    setSyncedValue(value);
    setText(value);
  }

  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function emit(next: string, wait: number) {
    window.clearTimeout(timer.current);
    if (wait <= 0) onChangeRef.current(next);
    else timer.current = window.setTimeout(() => onChangeRef.current(next), wait);
  }

  function clear() {
    setText('');
    emit('', 0);
    inputRef.current?.focus();
  }

  return (
    <div className={cx('relative', className)}>
      <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500 pointer-events-none" aria-hidden="true" />
      <input
        ref={inputRef}
        id={id}
        type="search"
        role="searchbox"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          emit(event.target.value, delay);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            emit(text, 0);
          } else if (event.key === 'Escape' && text) {
            // Esc limpa a busca (sem fechar um modal em volta)
            event.preventDefault();
            event.stopPropagation();
            clear();
          }
        }}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        className={cx(
          'w-full pl-10 pr-10 py-2.5 rounded-xl border outline-none transition-all text-sm',
          'bg-white dark:bg-slate-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500',
          'border-gray-200 dark:border-slate-700 focus:ring-2 focus:ring-orange-500 focus:border-orange-500',
          'disabled:opacity-60 [&::-webkit-search-cancel-button]:appearance-none',
        )}
      />
      {text && !disabled && (
        <button
          type="button"
          onClick={clear}
          aria-label="Limpar busca"
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
        >
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
