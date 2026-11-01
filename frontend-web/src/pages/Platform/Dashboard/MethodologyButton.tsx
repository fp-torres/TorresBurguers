import { useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Modal, buttonClass, cx } from '../../../components/ui';

interface MethodologyButtonProps {
  /** Nome do indicador (ex.: "MRR"). */
  metric: string;
  /** Metodologia devolvida pela API (texto). */
  methodology: string;
  /** Observação da API (ex.: por que o valor está zerado). */
  note?: string | null;
  /** Conteúdo extra (ex.: tabela de apoio). */
  children?: ReactNode;
  /** "icon" (padrão): botão ⓘ; "link": texto "Como calculamos". */
  variant?: 'icon' | 'link';
  className?: string;
}

/**
 * "Como calculamos": abre a metodologia do indicador exatamente como a API a descreve (acessível por
 * teclado e no celular, ao contrário de um title). Sem metodologia, não renderiza nada.
 */
export default function MethodologyButton({ metric, methodology, note, children, variant = 'icon', className }: MethodologyButtonProps) {
  const [open, setOpen] = useState(false);
  if (!methodology && !note) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`Como calculamos: ${metric}`}
        title={`Como calculamos: ${metric}`}
        className={cx(
          variant === 'icon'
            ? 'inline-flex items-center justify-center w-6 h-6 -my-1 rounded-full align-middle text-gray-400 hover:text-orange-600 dark:text-gray-500 dark:hover:text-orange-400 hover:bg-orange-50 dark:hover:bg-slate-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500'
            : 'inline-flex items-center gap-1 text-xs font-bold text-gray-500 dark:text-gray-400 hover:text-orange-600 dark:hover:text-orange-400 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500',
          className,
        )}
      >
        <Info size={variant === 'icon' ? 15 : 14} aria-hidden="true" />
        {variant === 'link' && 'Como calculamos'}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="md"
        title={`Como calculamos: ${metric}`}
        footer={<button type="button" onClick={() => setOpen(false)} className={buttonClass('secondary')}>Fechar</button>}
      >
        <div className="space-y-3 text-sm leading-relaxed">
          {methodology && <p className="text-gray-700 dark:text-gray-200 whitespace-pre-line">{methodology}</p>}
          {note && (
            <p className="px-3 py-2 rounded-xl bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200 border border-blue-200 dark:border-blue-800">
              {note}
            </p>
          )}
          {children}
        </div>
      </Modal>
    </>
  );
}
