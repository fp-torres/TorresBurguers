import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Copy, Eye, EyeOff } from 'lucide-react';
import toast from 'react-hot-toast';
import { copyText } from '../../utils/clipboard';
import { buttonClass, cx } from './styles';

export interface CopyFieldProps {
  /** Rótulo do campo (ex.: "Link de convite", "Link de redefinição de senha"). */
  label: string;
  value: string;
  /**
   * Valor de uso único, exibido só agora (padrão: true): mostra o aviso para copiar e guardar,
   * porque a API não o mostra de novo.
   */
  oneTime?: boolean;
  /** Texto do aviso (padrão: aviso de exibição única). */
  notice?: ReactNode;
  /** Mascara o valor até a pessoa pedir para ver (ex.: segredos). */
  secret?: boolean;
  /** Chamado depois de copiar com sucesso. */
  onCopied?: () => void;
  className?: string;
}

const DEFAULT_NOTICE = 'Exibido só agora: copie e envie ou guarde em local seguro. Por segurança, ele não poderá ser visto de novo.';

/** Mostra um link ou segredo de uso único com botão copiar e o aviso "exibido só agora". */
export default function CopyField({ label, value, oneTime = true, notice, secret = false, onCopied, className }: CopyFieldProps) {
  const inputId = useId();
  const noticeId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(!secret);
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  async function handleCopy() {
    if (await copyText(value)) {
      setCopied(true);
      window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 2500);
      onCopied?.();
      return;
    }
    // Navegador recusou: deixa o texto visível e selecionado para copiar à mão
    setRevealed(true);
    window.setTimeout(() => inputRef.current?.select(), 0);
    toast.error('Não foi possível copiar automaticamente. O texto foi selecionado: use Ctrl+C.', { id: 'copy-field' });
  }

  return (
    <div className={cx('space-y-2', className)}>
      <label htmlFor={inputId} className="block text-xs font-bold uppercase tracking-wide text-gray-700 dark:text-gray-300">
        {label}
      </label>

      <div className="flex gap-2">
        <input
          ref={inputRef}
          id={inputId}
          type={revealed ? 'text' : 'password'}
          value={value}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
          aria-describedby={oneTime ? noticeId : undefined}
          autoComplete="off"
          spellCheck={false}
          className="flex-1 min-w-0 px-4 py-2.5 rounded-xl border outline-none transition-all font-mono text-xs sm:text-sm bg-gray-50 dark:bg-slate-900 text-gray-900 dark:text-white border-gray-200 dark:border-slate-700 focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
        />
        {secret && (
          <button
            type="button"
            onClick={() => setRevealed((current) => !current)}
            aria-pressed={revealed}
            aria-label={revealed ? 'Ocultar' : 'Mostrar'}
            className={buttonClass('secondary', 'icon', 'shrink-0')}
          >
            {revealed ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
          </button>
        )}
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? `${label} copiado` : `Copiar ${label.toLowerCase()}`}
          className={buttonClass(copied ? 'secondary' : 'primary', 'md', 'shrink-0')}
        >
          {copied ? <Check size={18} className="text-green-600 dark:text-green-400" aria-hidden="true" /> : <Copy size={18} aria-hidden="true" />}
          <span className="hidden sm:inline">{copied ? 'Copiado' : 'Copiar'}</span>
        </button>
      </div>

      <span className="sr-only" aria-live="polite">{copied ? `${label} copiado para a área de transferência.` : ''}</span>

      {oneTime && (
        <p
          id={noticeId}
          className="flex items-start gap-2 px-3 py-2 rounded-xl text-xs font-medium bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800"
        >
          <AlertTriangle size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>{notice ?? DEFAULT_NOTICE}</span>
        </p>
      )}
    </div>
  );
}
