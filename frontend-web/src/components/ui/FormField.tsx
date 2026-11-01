import { useId, type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { cx } from './styles';

/** Atributos de acessibilidade que o FormField entrega ao controle (input, select, textarea...). */
export interface FormFieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  required?: boolean;
}

export interface FormFieldProps {
  label: ReactNode;
  /**
   * Renderiza o controle com as props de acessibilidade. Ex.:
   * <FormField label="Nome" error={errors.name}>{(field) => <input {...field} className={fieldControlClass(!!errors.name)} />}</FormField>
   */
  children: (control: FormFieldControlProps) => ReactNode;
  /** Dica abaixo do campo (ligada por aria-describedby). */
  hint?: ReactNode;
  /** Erro de validação: marca o campo como inválido e é lido junto com ele. */
  error?: ReactNode;
  /** Campo obrigatório: asterisco no rótulo e required no controle. */
  required?: boolean;
  /** id do controle (padrão: gerado com useId). */
  id?: string;
  /** Rótulo só para leitores de tela. */
  hideLabel?: boolean;
  className?: string;
}

/** Campo de formulário: rótulo ligado ao controle (htmlFor/id), dica e mensagem de erro acessíveis. */
export default function FormField({ label, children, hint, error, required = false, id, hideLabel = false, className }: FormFieldProps) {
  const generatedId = useId();
  const controlId = id ?? `field-${generatedId}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cx('space-y-1.5', className)}>
      <label
        htmlFor={controlId}
        className={cx('block text-xs font-bold uppercase tracking-wide text-gray-700 dark:text-gray-300', hideLabel && 'sr-only')}
      >
        {label}
        {required && <span className="ml-0.5 text-red-500" aria-hidden="true">*</span>}
      </label>

      {children({
        id: controlId,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        required: required || undefined,
      })}

      {hint && <div id={hintId} className="text-xs text-gray-500 dark:text-gray-400">{hint}</div>}
      {error && (
        <p id={errorId} className="flex items-start gap-1 text-xs font-semibold text-red-600 dark:text-red-400">
          <AlertCircle size={13} className="shrink-0 mt-px" aria-hidden="true" /> <span>{error}</span>
        </p>
      )}
    </div>
  );
}
