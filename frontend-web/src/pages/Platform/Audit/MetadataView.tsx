import { useId, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import toast from 'react-hot-toast';
import { buttonClass } from '../../../components/ui';
import { copyText } from '../../../utils/clipboard';
import { maskSensitive } from './auditLabels';

interface MetadataViewProps {
  metadata: Record<string, unknown> | null;
  /** Título da área (padrão: "Metadados"). */
  title?: string;
}

/**
 * Metadados de um registro da auditoria em JSON formatado (já sem segredos: a API grava sanitizado e a
 * tela ainda oculta chaves sensíveis por garantia), com botão para copiar.
 */
export default function MetadataView({ metadata, title = 'Metadados' }: MetadataViewProps) {
  const titleId = useId();
  const [copied, setCopied] = useState(false);
  const json = metadata && Object.keys(metadata).length > 0 ? JSON.stringify(maskSensitive(metadata), null, 2) : null;

  async function handleCopy() {
    if (!json) return;
    if (await copyText(json)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error('Não foi possível copiar automaticamente. Selecione o texto e use Ctrl+C.');
    }
  }

  return (
    <section aria-labelledby={titleId} className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 id={titleId} className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">{title}</h3>
        {json && (
          <button type="button" onClick={() => void handleCopy()} className={buttonClass('ghost', 'sm')}>
            {copied ? <Check size={14} className="text-green-600 dark:text-green-400" aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            {copied ? 'Copiado' : 'Copiar JSON'}
          </button>
        )}
      </div>
      {json ? (
        <pre
          tabIndex={0}
          aria-label={`${title} em JSON`}
          className="max-h-80 overflow-auto custom-scrollbar p-3 rounded-xl text-xs leading-relaxed font-mono whitespace-pre-wrap wrap-break-word bg-gray-50 dark:bg-slate-950 text-gray-800 dark:text-gray-200 border border-gray-100 dark:border-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
        >
          {json}
        </pre>
      ) : (
        <p className="text-sm text-gray-500 dark:text-gray-400">Sem metadados neste registro.</p>
      )}
      <span className="sr-only" aria-live="polite">{copied ? 'JSON copiado.' : ''}</span>
    </section>
  );
}
