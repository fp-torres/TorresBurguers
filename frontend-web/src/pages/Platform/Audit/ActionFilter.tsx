import { useId, useState, type FormEvent } from 'react';
import { AlertCircle, Check } from 'lucide-react';
import { FormField, buttonClass, cx, fieldControlClass } from '../../../components/ui';
import { AUDIT_ACTION_PATTERN } from '../../../services/platform/auditService';
import { ACTION_GROUPS } from './auditLabels';

const CUSTOM = '__custom';

interface ActionFilterProps {
  /** Ação ou grupo aplicado ('' = todas). */
  value: string;
  onChange: (action: string) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Filtro de ação da auditoria: grupos prontos ou o nome digitado de uma ação ou de um grupo, validado como a
 * API valida. A API respeita os segmentos do nome: "platform.store" traz platform.store e platform.store.*
 * (nunca platform.store_x), "auth.login.failure" traz só ela e um nome terminado em ponto ("plan.") traz só as
 * ações do grupo.
 */
export default function ActionFilter({ value, onChange, disabled = false, className }: ActionFilterProps) {
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const isGroup = (action: string) => action === '' || ACTION_GROUPS.some((group) => group.value === action);

  const [custom, setCustom] = useState(!isGroup(value));
  const [text, setText] = useState(isGroup(value) ? '' : value);
  const [submitted, setSubmitted] = useState(false);
  // Valor alterado por fora (ex.: "Limpar filtros"): o filtro acompanha
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setCustom(!isGroup(value));
    setText(isGroup(value) ? '' : value);
    setSubmitted(false);
  }

  const normalized = text.trim().toLowerCase();
  const error = submitted && normalized !== '' && !AUDIT_ACTION_PATTERN.test(normalized)
    ? 'Use o nome de uma ação ou de um grupo: letras minúsculas, números, "_" e "." (ex.: platform.store.suspend ou platform.store).'
    : null;

  function applyCustom(event?: FormEvent) {
    event?.preventDefault();
    setSubmitted(true);
    if (normalized !== '' && !AUDIT_ACTION_PATTERN.test(normalized)) return;
    if (normalized !== value) onChange(normalized);
  }

  return (
    <div className={cx('space-y-2', className)}>
      <FormField label="Ação">
        {(field) => (
          <select
            {...field}
            value={custom ? CUSTOM : value}
            disabled={disabled}
            onChange={(event) => {
              const next = event.target.value;
              if (next === CUSTOM) {
                // Começa do grupo escolhido (ex.: "auth.") para refinar (ex.: "auth.login.failure")
                setCustom(true);
                setText(value);
                setSubmitted(false);
                return;
              }
              setCustom(false);
              setText('');
              onChange(next);
            }}
            className={fieldControlClass()}
          >
            <option value="">Todas as ações</option>
            {ACTION_GROUPS.map((group) => <option key={group.value} value={group.value}>{group.label}</option>)}
            <option value={CUSTOM}>Outra ação ou grupo (digitar o nome)</option>
          </select>
        )}
      </FormField>
      {custom && (
        <>
          <form onSubmit={applyCustom} noValidate className="flex gap-2">
            <input
              id={inputId}
              type="text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onBlur={() => applyCustom()}
              placeholder="ex.: platform.store.suspend"
              aria-label="Nome da ação ou do grupo de ações"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${errorId} ${hintId}` : hintId}
              disabled={disabled}
              maxLength={80}
              autoComplete="off"
              spellCheck={false}
              className={fieldControlClass(!!error, 'font-mono')}
            />
            <button type="submit" disabled={disabled} aria-label="Aplicar ação" className={buttonClass('secondary', 'icon', 'shrink-0')}>
              <Check size={18} aria-hidden="true" />
            </button>
          </form>
          <p id={hintId} className="text-xs text-gray-500 dark:text-gray-400">
            Um grupo traz as ações dele: <code className="font-mono">platform.store</code> traz platform.store e
            platform.store.*; termine com ponto (<code className="font-mono">plan.</code>) para trazer só as do grupo.
          </p>
        </>
      )}
      {error && (
        <p id={errorId} role="alert" className="flex items-start gap-1 text-xs font-semibold text-red-600 dark:text-red-400">
          <AlertCircle size={13} className="shrink-0 mt-px" aria-hidden="true" /> <span>{error}</span>
        </p>
      )}
    </div>
  );
}
