import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Lock, Mail, Loader2, ArrowLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../../contexts/AuthContext';
import { getApiErrorMessage, safeRedirect } from '../../../services/api';
import { hasInternalAccess, homePathForUser, isPlatformAdmin, roleLabel } from '../../../utils/roles';
import { defaultClientDestination, readLastStore, storePath } from '../../../utils/lastStore';
import { storedCartCountBySlug } from '../../../contexts/cartStorage';
import BrandLogo from '../../../components/BrandLogo';

const INPUT_CLASS = 'pl-10 block w-full border-gray-300 dark:border-slate-700 rounded-xl border p-3 focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none bg-white dark:bg-slate-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500';

/**
 * Login do cliente (/signin). ?redirect= (só caminhos internos, via safeRedirect) leva de volta para onde a
 * pessoa estava — ex.: o carrinho da loja ao finalizar o pedido. Sem ele, vai para o carrinho da última loja
 * visitada (se tiver itens), para o cardápio dela ou para o diretório.
 */
export default function ClientLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const emailId = useId();
  const passwordId = useId();

  const navigate = useNavigate();
  const { signIn } = useAuth();

  const [searchParams] = useSearchParams();
  const redirectTo = safeRedirect(searchParams.get('redirect'));
  const [lastStore] = useState(readLastStore);
  // Sem destino: o carrinho da última loja (se tiver itens), o cardápio dela ou o diretório
  const [fallback] = useState(() => defaultClientDestination(storedCartCountBySlug));
  const afterLogin = redirectTo ?? fallback;
  const signupTo = redirectTo ? `/signup?redirect=${encodeURIComponent(redirectTo)}` : '/signup';

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      const loggedUser = await signIn({ email, password });
      toast.success(`Bem-vindo, ${loggedUser.name.split(' ')[0]}!`);

      // Contas da equipe vão direto para o painel do seu perfil; o superadministrador, para o superpainel
      if (hasInternalAccess(loggedUser)) {
        toast(
          isPlatformAdmin(loggedUser)
            ? 'Você entrou como superadministrador. Abrindo o superpainel.'
            : `Você entrou como ${roleLabel(loggedUser.role)}. Abrindo o painel da equipe.`,
          { icon: '🧑‍🍳' },
        );
        navigate(homePathForUser(loggedUser), { replace: true });
        return;
      }

      navigate(afterLogin, { replace: true });
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Não foi possível entrar. Tente novamente.', { 401: 'Email ou senha inválidos.' }));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-white dark:bg-slate-900 flex flex-col items-center justify-center p-6 transition-colors duration-300">
      <main className="w-full max-w-md space-y-8 animate-in fade-in slide-in-from-bottom-4">

        <Link to={redirectTo ?? (lastStore ? storePath(lastStore) : '/')} className="text-gray-500 dark:text-gray-400 flex items-center gap-2 mb-4 hover:text-orange-700 dark:hover:text-orange-400 transition-colors w-fit">
          <ArrowLeft size={20} aria-hidden="true" /> Voltar
        </Link>

        <div className="text-center">
          <Link to="/" className="inline-flex mb-6 hover:opacity-90 transition-opacity" aria-label="Página inicial">
            <BrandLogo size={48} />
          </Link>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Bem-vindo de volta!</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-2">
            {redirectTo ? 'Entre para continuar de onde parou.' : 'Uma conta para pedir em todos os estabelecimentos.'}
          </p>
        </div>

        <form onSubmit={handleLogin} className="space-y-6">
          <div>
            <label htmlFor={emailId} className="block text-sm font-medium text-gray-700 dark:text-gray-300">Email</label>
            <div className="mt-1 relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Mail className="h-5 w-5 text-gray-400" aria-hidden="true" />
              </div>
              <input id={emailId} required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className={INPUT_CLASS} placeholder="seu@email.com" />
            </div>
          </div>

          <div>
            <label htmlFor={passwordId} className="block text-sm font-medium text-gray-700 dark:text-gray-300">Senha</label>
            <div className="mt-1 relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock className="h-5 w-5 text-gray-400" aria-hidden="true" />
              </div>
              <input id={passwordId} required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className={INPUT_CLASS} placeholder="******" />
            </div>
            <div className="flex justify-end mt-1">
              {/* Recuperação por link de uso único; o e-mail digitado já vai preenchido */}
              <Link
                to="/esqueci-senha"
                state={email.trim() ? { email: email.trim() } : undefined}
                className="text-sm text-orange-700 hover:text-orange-800 dark:text-orange-400 dark:hover:text-orange-300 font-medium"
              >
                Esqueceu a senha?
              </Link>
            </div>
          </div>

          <button type="submit" disabled={loading} className="w-full flex justify-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-sm font-bold text-white bg-orange-600 hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500 dark:focus:ring-offset-slate-900 disabled:opacity-50 transition-colors">
            {loading ? <Loader2 className="animate-spin" aria-label="Entrando" /> : 'Entrar'}
          </button>
        </form>

        <div className="text-center space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Ainda não tem conta?{' '}
            <Link to={signupTo} className="font-bold text-orange-700 dark:text-orange-400 hover:underline">
              Crie agora
            </Link>
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            É da equipe de uma loja? <Link to="/login" className="font-bold hover:underline">Entre no painel</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
