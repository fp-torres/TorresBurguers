import { useId, type FormEvent, type ReactNode } from 'react';
import { CheckCircle2, Loader2, Lock, Save } from 'lucide-react';
import { CARD_CLASS, buttonClass, cx } from '../../components/ui';
import { useSettingsLock } from './lock';

interface SettingsSectionProps {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  /** Há alterações não salvas. */
  dirty?: boolean;
  saving?: boolean;
  /** Somente consulta (sessão de suporte ou loja que não pode ser alterada): salvar fica desabilitado. */
  readOnly?: boolean;
  /** Salvar (o formulário já impediu o envio padrão). Sem ele, a seção não tem rodapé de salvar. */
  onSubmit?: () => void;
  /** Descartar as alterações (volta aos valores salvos). */
  onDiscard?: () => void;
  saveLabel?: string;
  className?: string;
}

/** Cartão de uma seção das configurações: título, campos e rodapé com Descartar/Salvar. */
export default function SettingsSection({
  title,
  description,
  icon,
  children,
  dirty = false,
  saving = false,
  readOnly = false,
  onSubmit,
  onDiscard,
  saveLabel = 'Salvar alterações',
  className,
}: SettingsSectionProps) {
  const headingId = useId();
  const statusId = useId();
  const lockMessage = useSettingsLock();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!saving && !readOnly) onSubmit?.();
  }

  return (
    <form onSubmit={handleSubmit} noValidate aria-labelledby={headingId} className={cx(CARD_CLASS, 'overflow-hidden', className)}>
      <div className="flex items-start gap-3 px-5 sm:px-6 py-4 border-b border-gray-100 dark:border-slate-700">
        {icon && (
          <div className="shrink-0 p-2 rounded-xl bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400" aria-hidden="true">
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <h2 id={headingId} className="text-lg font-bold text-gray-800 dark:text-white">{title}</h2>
          {description && <div className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{description}</div>}
        </div>
      </div>

      <div className="p-5 sm:p-6 space-y-5">{children}</div>

      {onSubmit && (
        <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 px-5 sm:px-6 py-4 bg-gray-50 dark:bg-slate-900/40 border-t border-gray-100 dark:border-slate-700">
          <p id={statusId} aria-live="polite" className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400">
            {readOnly ? (
              <><Lock size={14} aria-hidden="true" /> {lockMessage ?? 'Somente leitura.'}</>
            ) : dirty ? (
              <><span className="w-2 h-2 rounded-full bg-orange-500" aria-hidden="true" /> Alterações não salvas.</>
            ) : (
              <><CheckCircle2 size={14} className="text-green-600 dark:text-green-400" aria-hidden="true" /> Tudo salvo.</>
            )}
          </p>
          <div className="flex flex-col-reverse sm:flex-row gap-2">
            {onDiscard && (
              <button type="button" onClick={onDiscard} disabled={!dirty || saving} className={buttonClass('secondary')}>
                Descartar
              </button>
            )}
            <button
              type="submit"
              disabled={!dirty || saving || readOnly}
              aria-describedby={statusId}
              className={buttonClass('primary')}
            >
              {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
              {saving ? 'Salvando...' : saveLabel}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
