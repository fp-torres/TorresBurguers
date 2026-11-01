import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowRight, Loader2, MailCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import AuthShell from '../components/AuthShell';
import LinkStatus, { AccountLinksFooter } from '../components/LinkStatus';
import { useLinkCheck, isInvalidLinkError } from '../components/useLinkCheck';
import { EmptyState, buttonClass } from '../../../components/ui';
import { useAuth } from '../../../contexts/AuthContext';
import { getApiErrorMessage, getApiErrorStatus } from '../../../services/api';
import { accountService, maskedEmailMatches } from '../../../services/accountService';
import { formatDateTime } from '../../../utils/format';

/**
 * Confirmar a troca de e-mail (/confirmar-email/:token), aberta no endereço NOVO: ao abrir, só confere o link
 * (GET /account/email-change/:token); a troca exige o clique (POST /account/email-change/confirm). A API
 * encerra todas as sessões da conta: se a sessão deste navegador é a da conta, ela sai aqui também (sem apagar
 * o carrinho). 409 = o endereço passou a ser de outra conta.
 */
export default function ConfirmEmailChange() {
  const { token = '' } = useParams();
  const { user, signOut } = useAuth();
  const { linkCheck, retry, markInvalid } = useLinkCheck(token, accountService.inspectEmailChange);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ message: string; email: string | null } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  async function handleConfirm() {
    if (linkCheck?.status !== 'valid') return;
    setSaving(true);
    try {
      const result = await accountService.confirmEmailChange(token);
      // A sessão desta conta neste navegador deixou de valer: sai agora (e não no próximo 401)
      if (maskedEmailMatches(linkCheck.info.current_email_masked, user?.email)) signOut({ keepLocalData: true });
      setDone({ message: result.message || 'E-mail alterado. Entre com o novo e-mail.', email: result.email });
      toast.success(result.message || 'E-mail alterado.', { duration: 6000 });
    } catch (error) {
      if (isInvalidLinkError(error)) markInvalid();
      else if (getApiErrorStatus(error) === 409) setConflict(getApiErrorMessage(error, 'Este e-mail passou a ser usado por outra conta.'));
      toast.error(getApiErrorMessage(error, 'Não foi possível confirmar a troca.'));
    } finally {
      setSaving(false);
    }
  }

  if (done) {
    return (
      <AuthShell title="E-mail alterado" footer={<AccountLinksFooter />}>
        <EmptyState
          compact
          icon={<MailCheck size={28} />}
          title={done.message}
          description={done.email ? `Use ${done.email} para entrar. Por segurança, as sessões abertas foram encerradas.` : 'Por segurança, as sessões abertas foram encerradas.'}
          action={<Link to="/signin" className={buttonClass('primary')}>Entrar</Link>}
        />
      </AuthShell>
    );
  }

  if (linkCheck?.status !== 'valid') {
    return (
      <LinkStatus
        title="Confirmar novo e-mail"
        linkCheck={linkCheck}
        onRetry={retry}
        invalidDescription="Ele pode ter expirado, já ter sido usado ou a troca foi cancelada. Peça a troca de novo em Minha conta."
      />
    );
  }

  const { info } = linkCheck;
  return (
    <AuthShell
      title="Confirme o novo e-mail"
      subtitle={info.expires_at ? <>Link válido até {formatDateTime(info.expires_at)}.</> : undefined}
      footer={<AccountLinksFooter />}
    >
      <div className="space-y-5">
        <p className="flex flex-wrap items-center justify-center gap-2 text-center text-sm text-gray-700 dark:text-gray-200">
          <span className="font-bold break-all">{info.current_email_masked}</span>
          <ArrowRight size={16} aria-label="para" className="text-gray-400" />
          <span className="font-bold break-all">{info.new_email_masked}</span>
        </p>
        <p className="text-sm text-gray-600 dark:text-gray-300 text-center">
          Depois da confirmação, a conta passa a usar o novo e-mail e todas as sessões são encerradas.
        </p>
        {conflict && <p role="alert" className="text-sm font-semibold text-red-600 dark:text-red-400">{conflict}</p>}
        <button type="button" onClick={() => void handleConfirm()} disabled={saving} className={buttonClass('primary', 'lg', 'w-full')}>
          {saving ? <Loader2 size={18} className="animate-spin" aria-hidden="true" /> : <MailCheck size={18} aria-hidden="true" />}
          Confirmar troca de e-mail
        </button>
      </div>
    </AuthShell>
  );
}
