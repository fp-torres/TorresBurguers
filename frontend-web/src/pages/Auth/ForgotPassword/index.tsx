import { useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Loader2, MailCheck, Send } from 'lucide-react';
import toast from 'react-hot-toast';
import AuthShell from '../components/AuthShell';
import { FormField, buttonClass, fieldControlClass } from '../../../components/ui';
import { authService } from '../../../services/authService';
import { getApiErrorMessage } from '../../../services/api';
import { BRAND } from '../../../config/brand';

/** E-mail digitado no login (enviado no estado da navegação, nunca na URL). */
function emailFromState(state: unknown): string {
  const email = (state as { email?: unknown } | null)?.email;
  return typeof email === 'string' ? email.slice(0, 254) : '';
}

/** Texto de confirmação quando a API não manda a mensagem (é o mesmo que ela usa). */
const DEFAULT_SENT_MESSAGE = 'Se houver uma conta com este e-mail, enviaremos um link para criar uma nova senha. Confira também a caixa de spam.';

/**
 * Esqueci a senha (/esqueci-senha): pede o link de redefinição (POST /auth/forgot-password → 202 { message }).
 * A API responde sempre com a mesma mensagem, exista ou não a conta (não revela e-mails cadastrados), e a
 * página mostra essa mensagem. O link (/redefinir-senha/:token) é de uso único e vence em pouco tempo; sem
 * provedor de e-mail configurado, o suporte da plataforma pode gerar o link pelo superpainel.
 */
export default function ForgotPassword() {
  const location = useLocation();
  const [email, setEmail] = useState(() => emailFromState(location.state));
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState<{ email: string; message: string } | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const value = email.trim();
    if (!value) return;

    setLoading(true);
    try {
      const message = await authService.forgotPassword(value);
      setSent({ email: value, message: message || DEFAULT_SENT_MESSAGE });
    } catch (error) {
      // Ex.: muitas tentativas (429) ou API fora do ar
      toast.error(getApiErrorMessage(error, 'Não foi possível enviar o pedido agora. Tente novamente em instantes.'));
    } finally {
      setLoading(false);
    }
  }

  const footer = (
    <>
      <p>
        Lembrou a senha?{' '}
        <Link to="/signin" className="font-bold text-orange-600 dark:text-orange-400 hover:underline">Entrar na loja</Link>
        {' · '}
        <Link to="/login" className="font-bold text-orange-600 dark:text-orange-400 hover:underline">Entrar no painel</Link>
      </p>
    </>
  );

  if (sent) {
    return (
      <AuthShell title="Verifique seu e-mail" footer={footer}>
        <div role="status" className="flex flex-col items-center text-center gap-4">
          <div className="p-4 rounded-full bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400" aria-hidden="true">
            <MailCheck size={36} />
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Pedido enviado para <span className="font-bold text-gray-700 dark:text-gray-200 break-all">{sent.email}</span>
          </p>
          <p>{sent.message}</p>
          <p className="text-sm text-gray-500 dark:text-gray-400">O link vale por pouco tempo e só pode ser usado uma vez.</p>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Não recebeu? Peça um novo link em alguns minutos ou fale com o suporte, que também pode gerar o link para você:{' '}
            <a href={`mailto:${BRAND.supportEmail}`} className="font-bold text-orange-600 dark:text-orange-400 hover:underline break-all">{BRAND.supportEmail}</a>
          </p>
          <button type="button" onClick={() => setSent(null)} className={buttonClass('secondary')}>
            Pedir outro link
          </button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Esqueceu a senha?"
      subtitle="Informe o e-mail da sua conta e enviaremos um link para criar uma nova senha."
      footer={footer}
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <FormField label="E-mail" required>
          {(field) => (
            <input
              {...field}
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="seu@email.com"
              maxLength={254}
              className={fieldControlClass()}
            />
          )}
        </FormField>

        <button type="submit" disabled={loading || !email.trim()} className={buttonClass('primary', 'lg', 'w-full')}>
          {loading ? <Loader2 size={18} className="animate-spin" aria-hidden="true" /> : <Send size={18} aria-hidden="true" />}
          Enviar link de redefinição
        </button>
      </form>
    </AuthShell>
  );
}
