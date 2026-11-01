import { useId, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, Mail, Send, XCircle } from 'lucide-react';
import { CARD_CLASS, FormField, StatusBadge, buttonClass, cx, fieldControlClass } from '../../../components/ui';
import { useAuth } from '../../../contexts/AuthContext';
import { getApiErrorMessage } from '../../../services/api';
import { platformSettingsService, type MailStatus, type TestEmailResult } from '../../../services/platform/settingsService';
import { isValidEmail } from '../../../utils/validation';

type Outcome = { tone: 'success' | 'info' | 'error'; message: string; detail?: string };

const OUTCOME_CLASSES: Record<Outcome['tone'], string> = {
  success: 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300 border-green-200 dark:border-green-800',
  info: 'bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  error: 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 border-red-200 dark:border-red-800',
};

function outcomeOf(result: TestEmailResult): Outcome {
  if (result.delivered) {
    return {
      tone: 'success',
      message: result.message || `E-mail de teste enviado para ${result.to}.`,
      detail: result.message_id ? `Message-ID: ${result.message_id}` : undefined,
    };
  }
  if (result.error) {
    return { tone: 'error', message: result.message || `O e-mail de teste não foi enviado. ${result.error}` };
  }
  return { tone: 'info', message: result.message || 'Driver de log ativo: nenhum e-mail foi enviado.' };
}

function smtpSummary(smtp: NonNullable<MailStatus['smtp']>): string {
  return [
    `${smtp.host}:${smtp.port}`,
    smtp.secure ? 'TLS direto' : 'STARTTLS',
    smtp.auth ? 'com autenticação' : 'sem autenticação',
  ].join(' · ');
}

export interface MailCardProps {
  /** Situação do e-mail (GET /platform/settings); null enquanto carrega ou se falhou. */
  mail: MailStatus | null;
  loading?: boolean;
}

/**
 * Superpainel › Configurações › E-mail transacional: driver ativo (MAIL_DRIVER), situação do SMTP — sem
 * usuário nem senha, que ficam só no ambiente da API — e o envio de um e-mail de teste
 * (POST /platform/settings/test-email, auditado e limitado por operador).
 */
export default function MailCard({ mail, loading = false }: MailCardProps) {
  const titleId = useId();
  const { user } = useAuth();
  const [to, setTo] = useState(user?.email ?? '');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    const address = to.trim();
    // Conferência antes de chamar a API (a validação definitiva é a do backend)
    if (!isValidEmail(address)) {
      setFieldError('Informe um e-mail válido.');
      return;
    }
    setFieldError(null);
    setOutcome(null);
    setSending(true);
    try {
      setOutcome(outcomeOf(await platformSettingsService.sendTestEmail(address)));
    } catch (error) {
      setOutcome({ tone: 'error', message: getApiErrorMessage(error, 'Não foi possível enviar o e-mail de teste.') });
    } finally {
      setSending(false);
    }
  }

  const smtpWarning = mail?.driver === 'smtp' && !mail.smtp_configured;

  return (
    <section aria-labelledby={titleId} className={CARD_CLASS}>
      <div className="flex items-start gap-3 px-5 sm:px-6 py-4 border-b border-gray-100 dark:border-slate-700">
        <div className="shrink-0 p-2 rounded-xl bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400" aria-hidden="true">
          <Mail size={20} />
        </div>
        <div className="min-w-0">
          <h2 id={titleId} className="text-lg font-bold text-gray-800 dark:text-white">E-mail transacional</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Convites e redefinição de senha saem pelo driver configurado no ambiente da API (MAIL_DRIVER).
          </p>
        </div>
      </div>

      <div className="p-5 sm:p-6 space-y-5">
        {mail ? (
          <dl className="grid gap-4 sm:grid-cols-3 text-sm">
            <div className="space-y-1">
              <dt className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">Driver ativo</dt>
              <dd>
                {mail.driver === 'smtp' ? (
                  <StatusBadge tone={mail.smtp_configured ? 'success' : 'danger'} dot>
                    SMTP{mail.smtp_configured ? '' : ' (incompleto)'}
                  </StatusBadge>
                ) : (
                  <StatusBadge tone="warning" dot title="Nenhum e-mail sai: as mensagens vão só para o log da API">
                    Log (não envia)
                  </StatusBadge>
                )}
              </dd>
            </div>
            <div className="space-y-1 min-w-0">
              <dt className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">Servidor SMTP</dt>
              <dd className="text-gray-800 dark:text-gray-100 break-words">
                {mail.smtp ? smtpSummary(mail.smtp) : 'Não configurado'}
                {mail.smtp && !mail.smtp_configured && (
                  <span className="block text-xs text-gray-500 dark:text-gray-400">Configuração incompleta</span>
                )}
              </dd>
            </div>
            <div className="space-y-1 min-w-0">
              <dt className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">Remetente</dt>
              <dd className="text-gray-800 dark:text-gray-100 break-words">{mail.from ?? 'Não definido (MAIL_FROM)'}</dd>
            </div>
          </dl>
        ) : (
          <p className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            {loading && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
            {loading ? 'Carregando a situação do e-mail...' : 'Não foi possível carregar a situação do e-mail.'}
          </p>
        )}

        {mail && mail.issues.length > 0 && (
          <div
            role={smtpWarning ? 'alert' : undefined}
            className="flex items-start gap-2 px-3 py-2 rounded-xl text-sm border bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800"
          >
            <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
            <ul className="space-y-1">
              {mail.issues.map((issue) => <li key={issue}>{issue}</li>)}
            </ul>
          </div>
        )}

        <p className="text-xs text-gray-500 dark:text-gray-400">
          Usuário e senha do SMTP ficam só nas variáveis de ambiente da API e nunca aparecem aqui. Para trocar o driver ou o
          servidor, ajuste o ambiente e reinicie a API.
        </p>

        <form onSubmit={(event) => void handleSubmit(event)} noValidate className="flex flex-col sm:flex-row sm:items-start gap-3">
          <FormField label="Enviar e-mail de teste para" error={fieldError} required className="flex-1 min-w-0">
            {(field) => (
              <input
                {...field}
                type="email"
                inputMode="email"
                autoComplete="email"
                value={to}
                onChange={(event) => {
                  setTo(event.target.value);
                  if (fieldError) setFieldError(null);
                }}
                placeholder="voce@suaempresa.com.br"
                maxLength={254}
                className={fieldControlClass(!!fieldError)}
              />
            )}
          </FormField>
          <button
            type="submit"
            disabled={sending}
            aria-busy={sending || undefined}
            className={buttonClass('primary', 'md', 'shrink-0 sm:mt-6')}
          >
            {sending ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
            {sending ? 'Enviando...' : 'Enviar e-mail de teste'}
          </button>
        </form>

        {outcome && (
          <div
            role={outcome.tone === 'error' ? 'alert' : 'status'}
            className={cx('flex items-start gap-2 px-3 py-2 rounded-xl text-sm border', OUTCOME_CLASSES[outcome.tone])}
          >
            {outcome.tone === 'success' ? (
              <CheckCircle2 size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
            ) : outcome.tone === 'info' ? (
              <Info size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
            ) : (
              <XCircle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
            )}
            <div className="min-w-0 space-y-0.5">
              <p className="break-words">{outcome.message}</p>
              {outcome.detail && <p className="text-xs opacity-80 break-all">{outcome.detail}</p>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
