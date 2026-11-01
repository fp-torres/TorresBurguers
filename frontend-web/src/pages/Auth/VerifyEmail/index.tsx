import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Loader2, MailCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import AuthShell from '../components/AuthShell';
import LinkStatus, { AccountLinksFooter } from '../components/LinkStatus';
import { useLinkCheck, isInvalidLinkError } from '../components/useLinkCheck';
import { EmptyState, buttonClass } from '../../../components/ui';
import { useAuth } from '../../../contexts/AuthContext';
import { getApiErrorMessage } from '../../../services/api';
import { accountService } from '../../../services/accountService';
import { formatDateTime } from '../../../utils/format';

/**
 * Confirmar o e-mail da conta (/verificar-email/:token): ao abrir, só confere o link
 * (GET /account/email-verification/:token → { email_masked, expires_at } ou 404); a confirmação exige o clique
 * (POST /account/email-verification/confirm). Não muda a sessão.
 */
export default function VerifyEmail() {
  const { token = '' } = useParams();
  const { user } = useAuth();
  const { linkCheck, retry, markInvalid } = useLinkCheck(token, accountService.inspectVerification);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const accountPath = user ? (user.role === 'CLIENT' ? '/profile' : '/login') : '/signin';

  async function handleConfirm() {
    setSaving(true);
    try {
      const result = await accountService.confirmVerification(token);
      setDone(result.message || 'E-mail confirmado.');
      toast.success(result.message || 'E-mail confirmado.');
    } catch (error) {
      if (isInvalidLinkError(error)) markInvalid();
      toast.error(getApiErrorMessage(error, 'Não foi possível confirmar o e-mail.'));
    } finally {
      setSaving(false);
    }
  }

  if (done) {
    return (
      <AuthShell title="E-mail confirmado" footer={<AccountLinksFooter />}>
        <EmptyState
          compact
          icon={<MailCheck size={28} />}
          title={done}
          description="Pronto: os avisos da conta e a recuperação de senha chegam a este endereço."
          action={<Link to={accountPath} className={buttonClass('primary')}>{user ? 'Voltar para a conta' : 'Entrar'}</Link>}
        />
      </AuthShell>
    );
  }

  if (linkCheck?.status !== 'valid') {
    return (
      <LinkStatus
        title="Confirmar e-mail"
        linkCheck={linkCheck}
        onRetry={retry}
        invalidDescription="Ele pode ter expirado, já ter sido usado ou o e-mail da conta mudou. Peça um novo link em Minha conta."
      />
    );
  }

  const { info } = linkCheck;
  return (
    <AuthShell
      title="Confirme o seu e-mail"
      subtitle={(
        <>
          Conta <span className="font-bold text-gray-700 dark:text-gray-200">{info.email_masked}</span>.{' '}
          {info.expires_at && <>Link válido até {formatDateTime(info.expires_at)}.</>}
        </>
      )}
      footer={<AccountLinksFooter />}
    >
      <div className="space-y-4 text-center">
        <p className="text-sm text-gray-600 dark:text-gray-300">Confirme que este endereço é seu para receber os avisos da conta.</p>
        <button type="button" onClick={() => void handleConfirm()} disabled={saving} className={buttonClass('primary', 'lg', 'w-full')}>
          {saving ? <Loader2 size={18} className="animate-spin" aria-hidden="true" /> : <MailCheck size={18} aria-hidden="true" />}
          Confirmar e-mail
        </button>
      </div>
    </AuthShell>
  );
}
