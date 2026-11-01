import type { ReactNode } from 'react';
import { FormField, fieldControlClass } from '../../../components/ui';
import { reasonProblem } from './formRules';

interface ReasonFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Obrigatório: asterisco no rótulo e erro quando vazio (exibido só com showError). */
  required?: boolean;
  /** Mínimo de caracteres (sem espaços nas pontas). */
  minLength?: number;
  maxLength?: number;
  placeholder?: string;
  hint?: ReactNode;
  /** Mostra o erro de validação (ex.: depois da primeira tentativa de confirmar). */
  showError?: boolean;
  rows?: number;
  disabled?: boolean;
}

/** Campo de motivo/observação com contador (ações críticas do superpainel; vai para o histórico e a auditoria). */
export default function ReasonField({
  label, value, onChange, required = false, minLength = 0, maxLength = 300, placeholder, hint, showError = false, rows = 3, disabled,
}: ReasonFieldProps) {
  const problem = reasonProblem(value, { required, minLength, maxLength });
  const error = showError ? problem : null;
  return (
    <FormField
      label={label}
      required={required}
      error={error ?? undefined}
      hint={(
        <span className="flex items-start justify-between gap-3">
          <span>{hint}</span>
          <span className="shrink-0 tabular-nums" aria-hidden="true">{value.length}/{maxLength}</span>
        </span>
      )}
    >
      {(field) => (
        <textarea
          {...field}
          rows={rows}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          maxLength={maxLength}
          placeholder={placeholder}
          disabled={disabled}
          className={fieldControlClass(!!error, 'resize-y')}
        />
      )}
    </FormField>
  );
}
