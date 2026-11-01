import { useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { cx } from '../../components/ui';

interface TagInputProps {
  /** id do campo de texto (para o <label htmlFor>). */
  id: string;
  values: string[];
  onChange: (values: string[]) => void;
  /** Nome de um item, para os botões de remover (ex.: "bairro"). */
  itemLabel: string;
  /** Nome da lista para leitores de tela (ex.: "Bairros da zona 1"). */
  listLabel: string;
  placeholder?: string;
  maxItems: number;
  maxLength: number;
  disabled?: boolean;
  invalid?: boolean;
  'aria-describedby'?: string;
}

/** Compara nomes sem diferenciar maiúsculas e acentos (mesma regra do cálculo do frete). */
function normalizeName(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Lista de nomes (bairros, cidades): digite e tecle Enter ou vírgula para adicionar; cole vários
 * separados por vírgula ou linha; Backspace no campo vazio remove o último.
 */
export default function TagInput({
  id,
  values,
  onChange,
  itemLabel,
  listLabel,
  placeholder,
  maxItems,
  maxLength,
  disabled = false,
  invalid = false,
  'aria-describedby': describedBy,
}: TagInputProps) {
  const [text, setText] = useState('');
  const [notice, setNotice] = useState('');

  function addNames(rawNames: string[]) {
    const next = [...values];
    const known = new Set(next.map(normalizeName));
    let skipped = 0;
    for (const raw of rawNames) {
      const name = raw.replace(/\s+/g, ' ').trim().slice(0, maxLength);
      if (!name) continue;
      const key = normalizeName(name);
      if (known.has(key) || next.length >= maxItems) {
        skipped += 1;
        continue;
      }
      known.add(key);
      next.push(name);
    }
    if (next.length !== values.length) onChange(next);
    setNotice(
      skipped > 0
        ? next.length >= maxItems ? `Limite de ${maxItems} itens atingido.` : 'Itens repetidos foram ignorados.'
        : '',
    );
  }

  function commitText() {
    if (!text.trim()) return;
    addNames([text]);
    setText('');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',' || event.key === ';') {
      event.preventDefault();
      commitText();
    } else if (event.key === 'Backspace' && text === '' && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData('text');
    if (!/[,;\n]/.test(pasted)) return;
    event.preventDefault();
    addNames(pasted.split(/[,;\n]/));
  }

  function remove(index: number) {
    onChange(values.filter((_, position) => position !== index));
  }

  return (
    <div>
      <div
        className={cx(
          'flex flex-wrap items-center gap-1.5 w-full min-h-11 px-2 py-1.5 rounded-xl border transition-all text-sm',
          'bg-white dark:bg-slate-800 focus-within:ring-2',
          invalid
            ? 'border-red-400 dark:border-red-500 focus-within:ring-red-200 dark:focus-within:ring-red-900/60'
            : 'border-gray-200 dark:border-slate-700 focus-within:ring-orange-500 focus-within:border-orange-500',
          disabled && 'opacity-60',
        )}
      >
        {values.length > 0 && (
          <ul aria-label={listLabel} className="contents">
            {values.map((value, index) => (
              <li
                key={`${value}-${index}`}
                className="inline-flex items-center gap-1 max-w-full pl-2.5 pr-1 py-1 rounded-lg bg-orange-50 dark:bg-orange-900/30 text-orange-800 dark:text-orange-200 border border-orange-100 dark:border-orange-800 text-xs font-semibold"
              >
                <span className="truncate">{value}</span>
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => remove(index)}
                    aria-label={`Remover ${itemLabel} ${value}`}
                    className="p-0.5 rounded-md hover:bg-orange-100 dark:hover:bg-orange-800/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <input
          id={id}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={commitText}
          disabled={disabled}
          maxLength={maxLength}
          placeholder={values.length >= maxItems ? '' : placeholder}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          className="flex-1 min-w-32 px-1.5 py-1 bg-transparent outline-none text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
        />
      </div>
      <p className="sr-only" aria-live="polite">{notice}</p>
      {notice && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300" aria-hidden="true">{notice}</p>}
    </div>
  );
}
