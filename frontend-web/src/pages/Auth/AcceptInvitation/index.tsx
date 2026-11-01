import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Info, Link2Off, Loader2, Store, UserPlus, UserX } from 'lucide-react';
import toast from 'react-hot-toast';
import AuthShell from '../components/AuthShell';
import PasswordChecklist from '../components/PasswordChecklist';
import { EmptyState, ErrorState, FormField, StatusBadge, buttonClass, fieldControlClass } from '../../../components/ui';
import { invitationService, type InvitationInfo } from '../../../services/invitationService';
import { isAuthResponse } from '../../../services/authService';
import { assetUrl, getApiErrorMessage, getApiErrorStatus } from '../../../services/api';
import { useAuth } from '../../../contexts/AuthContext';
import { homePathForUser, roleLabel } from '../../../utils/roles';
import { maskPhone } from '../../../utils/masks';
import { formatDateTime } from '../../../utils/format';
import { PASSWORD_RULES_MESSAGE, PASSWORD_TOO_LONG_MESSAGE, isPasswordTooLong, isStrongPassword } from '../../../utils/password';

type InvitationCheck =
  | { status: 'valid'; info: InvitationInfo }
  | { status: 'invalid' }
  | { status: 'error'; message: string };

/**
 * Convite inválido, usado, revogado ou expirado (ou da loja desativada): a API responde 404, sempre com a
 * mesma mensagem. Um 400 no aceite é validação dos campos (nome, senha, telefone): o convite continua valendo.
 */
function isInvalidInvitationError(error: unknown): boolean {
  return getApiErrorStatus(error) === 404;
}

/**
 * Aceitar convite da equipe (/convite/:token): mostra a loja e o perfil (GET /invitations/:token),
 * cria a conta da equipe e entra (POST /invitations/:token/accept { name, password, phone? } →
 * { access_token, user }). O e-mail, a loja e o perfil vêm do convite.
 * E-mail que já tem conta (ex.: um cliente): a API responde 409 — o convite cria sempre uma conta NOVA
 * da equipe (uma conta de cliente não vira equipe), então a página explica as saídas possíveis.
 */
export default function AcceptInvitation() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { user, applyAuthResponse } = useAuth();

  const [attempt, setAttempt] = useState(0);
  const checkKey = `${token}#${attempt}`;
  const [check, setCheck] = useState<{ key: string; result: InvitationCheck } | null>(null);
  const invitationCheck = check?.key === checkKey ? check.result : null;

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saving, setSaving] = useState(false);
  // E-mail do convite já tem conta (409): o formulário dá lugar à explicação
  const [accountExists, setAccountExists] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    invitationService.get(token)
      .then((info) => {
        if (active) setCheck({ key: checkKey, result: { status: 'valid', info } });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setCheck({
          key: checkKey,
          result: isInvalidInvitationError(error)
            ? { status: 'invalid' }
            : { status: 'error', message: getApiErrorMessage(error, 'Não foi possível abrir o convite agora.') },
        });
      });
    return () => {
      active = false;
    };
  }, [token, checkKey]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) { toast.error('Informe seu nome.'); return; }
    if (phone && phone.replace(/\D/g, '').length < 10) { toast.error('Informe o celular com DDD (ou deixe o campo vazio).'); return; }
    if (isPasswordTooLong(password)) { toast.error(PASSWORD_TOO_LONG_MESSAGE); return; }
    if (!isStrongPassword(password)) { toast.error(PASSWORD_RULES_MESSAGE); return; }
    if (password !== confirmation) { toast.error('A confirmação não confere com a senha.'); return; }

    setSaving(true);
    try {
      const data = await invitationService.accept(token, { name: trimmedName, password, ...(phone ? { phone } : {}) });
      const storeName = invitationCheck?.status === 'valid' ? invitationCheck.info.store.name : '';
      if (isAuthResponse(data)) {
        const sessionUser = applyAuthResponse(data);
        toast.success(storeName ? `Bem-vindo à equipe de ${storeName}!` : 'Conta criada! Bem-vindo à equipe.');
        navigate(homePathForUser(sessionUser), { replace: true });
      } else {
        toast.success('Conta criada! Entre com o seu e-mail e a senha escolhida.');
        navigate('/login', { replace: true });
      }
    } catch (error) {
      const status = getApiErrorStatus(error);
      if (isInvalidInvitationError(error)) {
        setCheck({ key: checkKey, result: { status: 'invalid' } });
      } else if (status === 409) {
        setAccountExists(getApiErrorMessage(error, 'Já existe uma conta com este e-mail.'));
        return;
      }
      // Ex.: limite de equipe do plano ou regras dos campos (400), muitas tentativas (429)
      toast.error(getApiErrorMessage(error, 'Não foi possível aceitar o convite.'), { duration: 6000 });
    } finally {
      setSaving(false);
    }
  }

  const footer = (
    <p>
      Já tem acesso?{' '}
      <Link to="/login" className="font-bold text-orange-600 dark:text-orange-400 hover:underline">Entrar no painel</Link>
    </p>
  );

  if (!invitationCheck) {
    return (
      <AuthShell title="Convite para a equipe" footer={footer}>
        <div role="status" className="flex flex-col items-center gap-3 py-6 text-gray-500 dark:text-gray-400">
          <Loader2 size={28} className="animate-spin text-orange-600" aria-hidden="true" />
          <span className="text-sm">Abrindo o convite...</span>
        </div>
      </AuthShell>
    );
  }

  if (invitationCheck.status === 'invalid') {
    return (
      <AuthShell title="Convite indisponível" footer={footer}>
        <EmptyState
          compact
          icon={<Link2Off size={28} />}
          title="Este convite não vale mais"
          description="Ele pode ter expirado, sido usado ou cancelado. Peça um novo convite ao administrador do estabelecimento."
        />
      </AuthShell>
    );
  }

  if (invitationCheck.status === 'error') {
    return (
      <AuthShell title="Convite para a equipe" footer={footer}>
        <ErrorState compact message={invitationCheck.message} onRetry={() => setAttempt((value) => value + 1)} />
      </AuthShell>
    );
  }

  const { info } = invitationCheck;
  const logo = assetUrl(info.store.logo);
  const mismatch = confirmation !== '' && confirmation !== password;
  const storeLabel = info.store.name || 'o estabelecimento';

  return (
    <AuthShell
      title="Convite para a equipe"
      subtitle="Crie seu acesso para começar a usar o painel do estabelecimento."
      footer={footer}
    >
      <div className="flex items-center gap-4 p-4 mb-6 rounded-xl bg-gray-50 dark:bg-slate-800 border border-gray-100 dark:border-slate-700">
        {logo ? (
          <img src={logo} alt="" className="w-14 h-14 rounded-xl object-cover bg-white dark:bg-slate-700 shrink-0" />
        ) : (
          <div className="w-14 h-14 rounded-xl bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 flex items-center justify-center shrink-0" aria-hidden="true">
            <Store size={26} />
          </div>
        )}
        <div className="min-w-0 space-y-1">
          <p className="font-bold text-gray-900 dark:text-white truncate">{info.store.name || 'Estabelecimento'}</p>
          <StatusBadge tone="info">{roleLabel(info.role)}</StatusBadge>
          <p className="text-xs text-gray-500 dark:text-gray-400 break-all">
            {info.email_masked && <>Convite para {info.email_masked}. </>}
            {info.expires_at && <>Válido até {formatDateTime(info.expires_at)}.</>}
          </p>
        </div>
      </div>

      {accountExists ? (
        // E-mail do convite já tem conta (409): o convite só cria contas novas da equipe
        <div role="alert" className="space-y-4">
          <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-900 dark:text-amber-200">
            <UserX size={20} className="shrink-0 mt-0.5" aria-hidden="true" />
            <div className="space-y-2">
              <p className="font-bold">{accountExists}</p>
              <p>
                O convite cria uma conta nova da equipe de {storeLabel} e não pode ser usado com uma conta que já
                existe (por exemplo, a conta de cliente usada para fazer pedidos).
              </p>
              <p>Peça ao administrador um convite para outro e-mail. Se você já faz parte desta equipe, entre no painel com a sua conta.</p>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <Link to="/login" className={buttonClass('primary', 'md', 'flex-1')}>Entrar no painel</Link>
            <Link to="/esqueci-senha" className={buttonClass('secondary', 'md', 'flex-1')}>Esqueci a senha</Link>
          </div>
        </div>
      ) : (
        <>
          {/* Alguém já conectado neste navegador: aceitar troca a sessão pela nova conta */}
          {user && (
            <div role="status" className="flex items-start gap-2 mb-5 px-3 py-2.5 rounded-xl text-xs bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
              <Info size={16} className="shrink-0 mt-px" aria-hidden="true" />
              <span>Você está conectado como {user.email}. Ao aceitar o convite, você entrará com a nova conta da equipe.</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5" noValidate>
            <FormField label="Nome completo" required>
              {(field) => (
                <input
                  {...field}
                  autoComplete="name"
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={50}
                  placeholder="Ex.: João Silva"
                  className={fieldControlClass()}
                />
              )}
            </FormField>

            <FormField label="Celular" hint="Opcional. Com DDD.">
              {(field) => (
                <input
                  {...field}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(event) => setPhone(maskPhone(event.target.value))}
                  maxLength={15}
                  placeholder="(21) 99999-9999"
                  className={fieldControlClass()}
                />
              )}
            </FormField>

            <FormField label="Senha" required hint={<PasswordChecklist password={password} />}>
              {(field) => (
                <input
                  {...field}
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className={fieldControlClass()}
                />
              )}
            </FormField>

            <FormField label="Confirmar senha" required error={mismatch ? 'As senhas não conferem.' : undefined}>
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
              {saving ? <Loader2 size={18} className="animate-spin" aria-hidden="true" /> : <UserPlus size={18} aria-hidden="true" />}
              Aceitar convite e entrar
            </button>
          </form>
        </>
      )}
    </AuthShell>
  );
}
