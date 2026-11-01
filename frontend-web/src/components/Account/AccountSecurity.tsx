import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { KeyRound, Loader2, Mail, MailCheck, MailWarning, Send, ShieldCheck, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { ErrorState, FormField, StatusBadge, buttonClass, cx, fieldControlClass } from '../ui';
import PasswordChecklist from '../../pages/Auth/components/PasswordChecklist';
import { useAuth } from '../../contexts/AuthContext';
import { getApiErrorMessage } from '../../services/api';
import { accountService, type AccountSecurity as SecurityState } from '../../services/accountService';
import { formatDateTime } from '../../utils/format';
import { PASSWORD_RULES_MESSAGE, PASSWORD_TOO_LONG_MESSAGE, isPasswordTooLong, isStrongPassword } from '../../utils/password';

interface AccountSecurityProps {
  className?: string;
  /** Título da seção (h2). */
  title?: string;
}

/**
 * "Segurança da conta" (GET/POST /account/*): situação do e-mail (confirmado ou não, com reenvio do link), troca
 * do e-mail com confirmação no endereço novo (pendente até confirmar, com cancelar) e troca da senha com a senha
 * atual. Usado em "Meus Dados" (clientes e superadmin) e em "Minha conta" no menu do painel e do superpainel.
 * Numa sessão de suporte (somente leitura) só mostra a situação, sem ações.
 */
export default function AccountSecurity({ className, title = 'Segurança da conta' }: AccountSecurityProps) {
  const { user } = useAuth();
  const inSupport = !!user?.support_session;
  const [state, setState] = useState<SecurityState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const userId = user?.id;

  // Carga em segundo plano: um 401 aqui não encerra a sessão (a próxima ação do usuário encerra)
  const load = useCallback(
    () =>
      accountService.getSecurity({ keepSessionOn401: true }).then(
        (next) => {
          setState(next);
          setError(null);
        },
        (loadError: unknown) => setError(getApiErrorMessage(loadError, 'Não foi possível carregar a segurança da conta.')),
      ),
    [],
  );

  useEffect(() => {
    if (userId === undefined) return;
    void load();
  }, [load, userId]);

  async function retry() {
    setRetrying(true);
    await load();
    setRetrying(false);
  }

  if (!user) return null;

  return (
    <section aria-labelledby="account-security-title" className={cx('space-y-5', className)}>
      <div className="min-w-0">
        <h2 id="account-security-title" className="text-lg font-bold text-gray-800 dark:text-white flex items-center gap-2">
          <ShieldCheck size={20} aria-hidden="true" className="text-orange-600 dark:text-orange-400" /> {title}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {inSupport
            ? 'Sessão de suporte: somente leitura. Nada pode ser alterado aqui.'
            : 'E-mail de acesso e senha. Para trocar qualquer um deles, confirme a senha atual.'}
        </p>
      </div>

      {error && !state ? (
        <ErrorState compact message={error} onRetry={() => void retry()} retrying={retrying} />
      ) : !state ? (
        <p className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400" role="status">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Carregando...
        </p>
      ) : (
        <>
          <EmailStatusCard state={state} readOnly={inSupport} onChanged={load} />
          {!inSupport && (
            <>
              <ChangeEmailForm state={state} onChanged={load} />
              <ChangePasswordForm />
            </>
          )}
        </>
      )}
    </section>
  );
}

const PANEL_CLASS = 'rounded-2xl border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/60 p-4 sm:p-5 space-y-4';

function EmailStatusCard({ state, readOnly, onChanged }: { state: SecurityState; readOnly: boolean; onChanged: () => Promise<void> }) {
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleResend() {
    setSending(true);
    try {
      const result = await accountService.resendVerification();
      setNotice(result.message || 'Enviamos um link de confirmação para o seu e-mail.');
      if (result.alreadyVerified) await onChanged();
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Não foi possível enviar o link agora.'));
    } finally {
      setSending(false);
    }
  }

  async function handleCancel() {
    setCancelling(true);
    try {
      await accountService.cancelEmailChange();
      toast.success('Troca de e-mail cancelada.');
      await onChanged();
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Não foi possível cancelar a troca.'));
    } finally {
      setCancelling(false);
    }
  }

  const pending = state.email_change;

  return (
    <div className={PANEL_CLASS} data-testid="account-email-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">E-mail da conta</p>
          <p className="flex items-center gap-2 font-semibold text-gray-800 dark:text-white break-all">
            <Mail size={16} aria-hidden="true" className="shrink-0 text-gray-400" /> {state.email}
          </p>
        </div>
        {state.email_verified ? (
          <StatusBadge tone="success" icon={<MailCheck size={12} aria-hidden="true" />}>Confirmado</StatusBadge>
        ) : (
          <StatusBadge tone="warning" icon={<MailWarning size={12} aria-hidden="true" />}>Não confirmado</StatusBadge>
        )}
      </div>

      {state.email_verified && state.email_verified_at && (
        <p className="text-xs text-gray-500 dark:text-gray-400">Confirmado em {formatDateTime(state.email_verified_at)}.</p>
      )}

      {!state.email_verified && !readOnly && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-gray-600 dark:text-gray-300 flex-1 min-w-[12rem]">
            Confirme que este e-mail é seu: assim você recebe os avisos da conta e recupera a senha por ele.
          </p>
          <button type="button" onClick={() => void handleResend()} disabled={sending} className={buttonClass('secondary', 'sm')}>
            {sending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />}
            Enviar link de confirmação
          </button>
        </div>
      )}
      {notice && <p role="status" className="text-sm font-semibold text-green-700 dark:text-green-400">{notice}</p>}

      {pending && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3 space-y-2" data-testid="account-email-pending">
          <p className="text-sm text-amber-800 dark:text-amber-200">
            Troca pendente para <span className="font-bold break-all">{pending.email}</span>. Abra o link enviado a esse endereço
            para confirmar{pending.expires_at ? <> (vale até {formatDateTime(pending.expires_at)})</> : null}. Até lá, o e-mail da conta continua o
            mesmo.
          </p>
          {!readOnly && (
            <button type="button" onClick={() => void handleCancel()} disabled={cancelling} className={buttonClass('ghost', 'sm')}>
              {cancelling ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <X size={14} aria-hidden="true" />}
              Cancelar troca
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ChangeEmailForm({ state, onChanged }: { state: SecurityState; onChanged: () => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  const normalized = email.trim().toLowerCase();
  const mismatch = confirmation !== '' && normalized !== confirmation.trim().toLowerCase();

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) { toast.error('Informe um e-mail válido.'); return; }
    if (normalized !== confirmation.trim().toLowerCase()) { toast.error('Os e-mails não conferem.'); return; }
    if (normalized === state.email.toLowerCase()) { toast.error('Este já é o e-mail da sua conta.'); return; }
    if (!currentPassword) { toast.error('Informe a senha atual.'); return; }

    setSaving(true);
    try {
      const result = await accountService.requestEmailChange(normalized, currentPassword);
      setSent(result.message || `Enviamos um link de confirmação para ${normalized}.`);
      setEmail('');
      setConfirmation('');
      setCurrentPassword('');
      await onChanged();
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Não foi possível pedir a troca de e-mail.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className={PANEL_CLASS} aria-labelledby="change-email-title" noValidate>
      <h3 id="change-email-title" className="font-bold text-gray-800 dark:text-white flex items-center gap-2">
        <Mail size={18} aria-hidden="true" className="text-orange-600 dark:text-orange-400" /> Trocar e-mail
      </h3>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        O e-mail só muda depois que você abrir o link enviado ao endereço novo. O endereço atual recebe um aviso com a opção de desfazer.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Novo e-mail" required>
          {(field) => (
            <input {...field} type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className={fieldControlClass()} />
          )}
        </FormField>
        <FormField label="Repita o novo e-mail" required error={mismatch ? 'Os e-mails não conferem.' : undefined}>
          {(field) => (
            <input {...field} type="email" autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className={fieldControlClass(mismatch)} />
          )}
        </FormField>
      </div>
      <FormField label="Senha atual" required>
        {(field) => (
          <input {...field} type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} className={fieldControlClass()} />
        )}
      </FormField>
      {sent && <p role="status" className="text-sm font-semibold text-green-700 dark:text-green-400">{sent}</p>}
      <button type="submit" disabled={saving} className={buttonClass('primary', 'md', 'w-full sm:w-auto')}>
        {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
        Enviar link de confirmação
      </button>
    </form>
  );
}

function ChangePasswordForm() {
  const { applyAuthResponse, signOut } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saving, setSaving] = useState(false);
  const mismatch = confirmation !== '' && confirmation !== password;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!currentPassword) { toast.error('Informe a senha atual.'); return; }
    if (isPasswordTooLong(password)) { toast.error(PASSWORD_TOO_LONG_MESSAGE); return; }
    if (!isStrongPassword(password)) { toast.error(PASSWORD_RULES_MESSAGE); return; }
    if (password !== confirmation) { toast.error('A confirmação não confere com a nova senha.'); return; }

    setSaving(true);
    try {
      const session = await accountService.changePassword(currentPassword, password);
      // As outras sessões caíram; esta continua com o token novo
      try {
        applyAuthResponse(session);
      } catch {
        signOut({ keepLocalData: true });
        toast.success('Senha alterada. Entre novamente com a nova senha.');
        return;
      }
      setCurrentPassword('');
      setPassword('');
      setConfirmation('');
      toast.success('Senha alterada. As sessões em outros aparelhos foram encerradas.');
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Não foi possível trocar a senha.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className={PANEL_CLASS} aria-labelledby="change-password-title" noValidate>
      <h3 id="change-password-title" className="font-bold text-gray-800 dark:text-white flex items-center gap-2">
        <KeyRound size={18} aria-hidden="true" className="text-orange-600 dark:text-orange-400" /> Trocar senha
      </h3>
      <FormField label="Senha atual" required>
        {(field) => (
          <input {...field} type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} className={fieldControlClass()} />
        )}
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Nova senha" required hint={<PasswordChecklist password={password} />}>
          {(field) => (
            <input {...field} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className={fieldControlClass()} />
          )}
        </FormField>
        <FormField label="Confirmar nova senha" required error={mismatch ? 'As senhas não conferem.' : undefined}>
          {(field) => (
            <input {...field} type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className={fieldControlClass(mismatch)} />
          )}
        </FormField>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Ao trocar a senha, as sessões abertas em outros aparelhos são encerradas; este navegador continua conectado.
      </p>
      <button type="submit" disabled={saving} className={buttonClass('primary', 'md', 'w-full sm:w-auto')}>
        {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <KeyRound size={16} aria-hidden="true" />}
        Salvar nova senha
      </button>
    </form>
  );
}
