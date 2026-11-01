import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { KeyRound, Link2Off, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import AuthShell from '../components/AuthShell';
import PasswordChecklist from '../components/PasswordChecklist';
import { EmptyState, ErrorState, FormField, buttonClass, fieldControlClass } from '../../../components/ui';
import { authService, type ResetTokenInfo } from '../../../services/authService';
import { getApiErrorMessage, getApiErrorStatus } from '../../../services/api';
import { useAuth } from '../../../contexts/AuthContext';
import { formatDateTime } from '../../../utils/format';
import { PASSWORD_RULES_MESSAGE, PASSWORD_TOO_LONG_MESSAGE, isPasswordTooLong, isStrongPassword } from '../../../utils/password';

type LinkCheck =
  | { status: 'valid'; info: ResetTokenInfo }
  | { status: 'invalid' }
  | { status: 'error'; message: string };

/**
 * Link inválido, já usado ou expirado: a API responde 404 (sempre a mesma mensagem). Um 400 no envio é
 * validação da nova senha (o link continua valendo); 429 = muitas tentativas.
 */
function isInvalidLinkError(error: unknown): boolean {
  return getApiErrorStatus(error) === 404;
}

/**
 * O e-mail mascarado pela API ("jo***@email.com": 2 primeiras letras + domínio) bate com o e-mail da
 * sessão aberta neste navegador? Usado para encerrar aqui a sessão que a redefinição invalidou.
 */
function maskedEmailMatches(masked: string, email: string | undefined): boolean {
  const match = /^(.*)\*\*\*@(.+)$/.exec(masked.trim().toLowerCase());
  if (!match || !email) return false;
  const [, prefix, domain] = match;
  const [local, emailDomain] = email.trim().toLowerCase().split('@');
  return !!local && emailDomain === domain && local.startsWith(prefix);
}

/**
 * Redefinir a senha (/redefinir-senha/:token): confere o link (GET /auth/reset-password/:token →
 * { email_masked, expires_at } ou 404) e grava a nova senha (POST /auth/reset-password { token, password }
 * → { message }). A API encerra todas as sessões da conta e não abre uma nova: a pessoa entra de novo
 * pelo /signin, que leva cada perfil à sua área (cliente à loja, equipe ao painel, superadmin ao superpainel).
 */
export default function ResetPassword() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();

  // Resultado da conferência por link (e por tentativa): sem resultado para o link atual = conferindo
  const [attempt, setAttempt] = useState(0);
  const checkKey = `${token}#${attempt}`;
  const [check, setCheck] = useState<{ key: string; result: LinkCheck } | null>(null);
  const linkCheck = check?.key === checkKey ? check.result : null;

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    authService.checkResetToken(token)
      .then((info) => {
        if (active) setCheck({ key: checkKey, result: { status: 'valid', info } });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setCheck({
          key: checkKey,
          result: isInvalidLinkError(error)
            ? { status: 'invalid' }
            : { status: 'error', message: getApiErrorMessage(error, 'Não foi possível conferir o link agora.') },
        });
      });
    return () => {
      active = false;
    };
  }, [token, checkKey]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (isPasswordTooLong(password)) { toast.error(PASSWORD_TOO_LONG_MESSAGE); return; }
    if (!isStrongPassword(password)) { toast.error(PASSWORD_RULES_MESSAGE); return; }
    if (password !== confirmation) { toast.error('A confirmação não confere com a nova senha.'); return; }

    setSaving(true);
    try {
      const message = await authService.resetPassword(token, password);
      // A sessão desta conta aberta neste navegador deixou de valer: sai dela agora (e não no próximo 401).
      // É a mesma pessoa no aparelho: o carrinho e a última loja continuam
      if (linkCheck?.status === 'valid' && maskedEmailMatches(linkCheck.info.email_masked, user?.email)) signOut({ keepLocalData: true });
      toast.success(message || 'Senha redefinida. Entre com a nova senha.', { duration: 6000 });
      navigate('/signin', { replace: true });
    } catch (error) {
      if (isInvalidLinkError(error)) setCheck({ key: checkKey, result: { status: 'invalid' } });
      toast.error(getApiErrorMessage(error, 'Não foi possível redefinir a senha.'));
    } finally {
      setSaving(false);
    }
  }

  const footer = (
    <p>
      <Link to="/signin" className="font-bold text-orange-600 dark:text-orange-400 hover:underline">Entrar na loja</Link>
      {' · '}
      <Link to="/login" className="font-bold text-orange-600 dark:text-orange-400 hover:underline">Entrar no painel</Link>
    </p>
  );

  if (!linkCheck) {
    return (
      <AuthShell title="Redefinir senha" footer={footer}>
        <div role="status" className="flex flex-col items-center gap-3 py-6 text-gray-500 dark:text-gray-400">
          <Loader2 size={28} className="animate-spin text-orange-600" aria-hidden="true" />
          <span className="text-sm">Conferindo o link...</span>
        </div>
      </AuthShell>
    );
  }

  if (linkCheck.status === 'invalid') {
    return (
      <AuthShell title="Link inválido" footer={footer}>
        <EmptyState
          compact
          icon={<Link2Off size={28} />}
          title="Este link não vale mais"
          description="Ele pode ter expirado ou já ter sido usado. Peça um novo link para redefinir a senha."
          action={<Link to="/esqueci-senha" className={buttonClass('primary')}>Pedir novo link</Link>}
        />
      </AuthShell>
    );
  }

  if (linkCheck.status === 'error') {
    return (
      <AuthShell title="Redefinir senha" footer={footer}>
        <ErrorState compact message={linkCheck.message} onRetry={() => setAttempt((value) => value + 1)} />
      </AuthShell>
    );
  }

  const { info } = linkCheck;
  const mismatch = confirmation !== '' && confirmation !== password;

  return (
    <AuthShell
      title="Crie uma nova senha"
      subtitle={(
        <>
          {info.email_masked && <>Conta <span className="font-bold text-gray-700 dark:text-gray-200">{info.email_masked}</span>. </>}
          {info.expires_at && <>Link válido até {formatDateTime(info.expires_at)}.</>}
        </>
      )}
      footer={footer}
    >
      <form onSubmit={handleSubmit} className="space-y-5">
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
          {saving ? <Loader2 size={18} className="animate-spin" aria-hidden="true" /> : <KeyRound size={18} aria-hidden="true" />}
          Salvar nova senha
        </button>
        <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
          Por segurança, as sessões abertas com a senha antiga serão encerradas.
        </p>
      </form>
    </AuthShell>
  );
}
