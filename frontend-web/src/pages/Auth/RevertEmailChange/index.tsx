import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Loader2, ShieldAlert } from 'lucide-react';
import toast from 'react-hot-toast';
import AuthShell from '../components/AuthShell';
import PasswordChecklist from '../components/PasswordChecklist';
import LinkStatus, { AccountLinksFooter } from '../components/LinkStatus';
import { useLinkCheck, isInvalidLinkError } from '../components/useLinkCheck';
import { FormField, buttonClass, fieldControlClass } from '../../../components/ui';
import { useAuth } from '../../../contexts/AuthContext';
import { getApiErrorMessage } from '../../../services/api';
import { accountService, maskedEmailMatches } from '../../../services/accountService';
import { formatDateTime } from '../../../utils/format';
import { PASSWORD_RULES_MESSAGE, PASSWORD_TOO_LONG_MESSAGE, isPasswordTooLong, isStrongPassword } from '../../../utils/password';

/**
 * "Não fui eu" (/desfazer-troca-de-email/:token), aberto no endereço ANTIGO depois de uma troca: confere o link
 * (GET /account/email-revert/:token) e, com uma senha nova, devolve o e-mail antigo à conta
 * (POST /account/email-revert). A API encerra todas as sessões; a deste navegador sai aqui se for a da conta.
 */
export default function RevertEmailChange() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { linkCheck, retry, markInvalid } = useLinkCheck(token, accountService.inspectEmailRevert);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saving, setSaving] = useState(false);
  const mismatch = confirmation !== '' && confirmation !== password;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (linkCheck?.status !== 'valid') return;
    if (isPasswordTooLong(password)) { toast.error(PASSWORD_TOO_LONG_MESSAGE); return; }
    if (!isStrongPassword(password)) { toast.error(PASSWORD_RULES_MESSAGE); return; }
    if (password !== confirmation) { toast.error('A confirmação não confere com a nova senha.'); return; }

    setSaving(true);
    try {
      const result = await accountService.revertEmailChange(token, password);
      const { info } = linkCheck;
      if (maskedEmailMatches(info.replaced_email_masked, user?.email) || maskedEmailMatches(info.restored_email_masked, user?.email)) {
        signOut({ keepLocalData: true });
      }
      toast.success(result.message || 'Troca de e-mail desfeita. Entre com a nova senha.', { duration: 8000 });
      navigate('/signin', { replace: true });
    } catch (error) {
      if (isInvalidLinkError(error)) markInvalid();
      toast.error(getApiErrorMessage(error, 'Não foi possível desfazer a troca.'));
    } finally {
      setSaving(false);
    }
  }

  if (linkCheck?.status !== 'valid') {
    return (
      <LinkStatus
        title="Desfazer troca de e-mail"
        linkCheck={linkCheck}
        onRetry={retry}
        invalidDescription='Ele pode ter expirado ou já ter sido usado. Para recuperar o acesso, use "Esqueci minha senha" ou fale com o suporte.'
      />
    );
  }

  const { info } = linkCheck;
  return (
    <AuthShell
      title="Não foi você?"
      subtitle={(
        <>
          O e-mail <span className="font-bold text-gray-700 dark:text-gray-200">{info.restored_email_masked}</span> volta para a conta
          {info.replaced_email_masked ? <> no lugar de <span className="font-bold text-gray-700 dark:text-gray-200">{info.replaced_email_masked}</span></> : null}.
          {info.expires_at && <> Link válido até {formatDateTime(info.expires_at)}.</>}
        </>
      )}
      footer={<AccountLinksFooter />}
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <p className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
          <ShieldAlert size={18} aria-hidden="true" className="shrink-0 mt-0.5 text-orange-600 dark:text-orange-400" />
          Crie uma senha nova: quem trocou o e-mail pode saber a senha atual. Todas as sessões da conta serão encerradas.
        </p>
        <FormField label="Nova senha" required hint={<PasswordChecklist password={password} />}>
          {(field) => (
            <input
              {...field}
              type="password"
              autoComplete="new-password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={fieldControlClass()}
            />
          )}
        </FormField>
        <FormField label="Confirmar nova senha" required error={mismatch ? 'As senhas não conferem.' : undefined}>
          {(field) => (
            <input
              {...field}
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              className={fieldControlClass(mismatch)}
            />
          )}
        </FormField>
        <button type="submit" disabled={saving} className={buttonClass('primary', 'lg', 'w-full')}>
          {saving ? <Loader2 size={18} className="animate-spin" aria-hidden="true" /> : <ShieldAlert size={18} aria-hidden="true" />}
          Desfazer a troca e salvar a senha
        </button>
      </form>
    </AuthShell>
  );
}
