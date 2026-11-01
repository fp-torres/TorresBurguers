import { useId, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Lock, Mail, Loader2, ArrowLeft, Info } from 'lucide-react';
import { getApiErrorMessage } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import { hasInternalAccess, homePathForUser } from '../../utils/roles';
import BrandLogo from '../../components/BrandLogo';
import toast from 'react-hot-toast';

/** Login do painel da loja (equipe) e do superpainel (superadministrador). */
export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { user, signIn, signOut } = useAuth();
  const emailId = useId();
  const passwordId = useId();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const signedIn = await signIn({ email, password });

      // Clientes não usam o painel: a sessão é descartada e o cliente volta para a loja, com o carrinho
      // e a última loja deste aparelho preservados (é a mesma pessoa)
      if (!hasInternalAccess(signedIn)) {
        signOut({ keepLocalData: true });
        toast('Esta área é exclusiva da equipe. Para fazer pedidos, entre pelo login da loja.', { icon: '🛍️' });
        navigate('/', { replace: true });
        return;
      }

      toast.success(`Bem-vindo, ${signedIn.name.split(' ')[0]}!`);
      // Superadministrador → superpainel; Administrador → Dashboard; Atendente, Cozinha e Entregador → Pedidos
      navigate(homePathForUser(signedIn), { replace: true });
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Não foi possível entrar. Tente novamente.', { 401: 'Credenciais inválidas.' }));
    } finally {
      setLoading(false);
    }
  }

  // Já conectado com acesso ao painel ou ao superpainel: vai direto para a página inicial do seu acesso
  if (user && hasInternalAccess(user)) return <Navigate to={homePathForUser(user)} replace />;

  return (
    <div className="min-h-screen bg-gray-600 dark:bg-slate-900 flex items-center justify-center p-4 transition-colors duration-300">
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-300 border border-transparent dark:border-slate-700">

        {/* Cabeçalho Laranja */}
        <div className="bg-[#bf3b0b] p-8 text-center">
          <h1 className="flex justify-center">
            <BrandLogo size={52} tone="dark" />
          </h1>
          <p className="text-orange-100 text-sm mt-3">Acesso Corporativo</p>
        </div>

        <div className="p-8">
          {/* Cliente conectado neste navegador: entrar aqui troca a sessão por uma conta da equipe */}
          {user && (
            <div role="status" className="flex items-start gap-2 mb-6 px-3 py-2.5 rounded-xl text-xs bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
              <Info size={16} className="shrink-0 mt-px" aria-hidden="true" />
              <span>Você está conectado como cliente ({user.email}). Para usar o painel, entre com uma conta da equipe.</span>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-6">
            <div>
              <label htmlFor={emailId} className="block text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1">Email Corporativo</label>
              <div className="relative">
                <Mail className="absolute left-3 top-3 text-gray-400" size={20} aria-hidden="true" />
                <input
                  id={emailId}
                  required
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-gray-50 dark:bg-slate-700 border border-gray-200 dark:border-slate-600 rounded-xl focus:ring-2 focus:ring-[#bf3b0b] focus:border-[#bf3b0b] outline-none transition-all text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
                  placeholder="nome@empresa.com.br"
                />
              </div>
            </div>

            <div>
              <label htmlFor={passwordId} className="block text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1">Senha</label>
              <div className="relative">
                <Lock className="absolute left-3 top-3 text-gray-400" size={20} aria-hidden="true" />
                <input
                  id={passwordId}
                  required
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-gray-50 dark:bg-slate-700 border border-gray-200 dark:border-slate-600 rounded-xl focus:ring-2 focus:ring-[#bf3b0b] focus:border-[#bf3b0b] outline-none transition-all text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
                  placeholder="••••••••"
                />
              </div>
              <div className="text-right mt-2">
                {/* Recuperação por link de uso único; o e-mail digitado já vai preenchido */}
                <Link
                  to="/esqueci-senha"
                  state={email.trim() ? { email: email.trim() } : undefined}
                  className="text-xs font-bold text-[#bf3b0b] dark:text-orange-400 hover:underline"
                >
                  Esqueci a senha
                </Link>
              </div>
            </div>

            <button
              disabled={loading}
              className="w-full bg-[#bf3b0b] hover:bg-[#9a2f08] text-white font-bold py-3 rounded-xl shadow-lg shadow-orange-900/20 transition-all flex justify-center items-center disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {loading ? <Loader2 className="animate-spin" /> : 'Acessar Sistema'}
            </button>
          </form>

          <div className="mt-6 pt-6 border-t border-gray-100 dark:border-slate-700 text-center">
             <button onClick={() => navigate('/')} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm flex items-center justify-center gap-2 mx-auto transition-colors">
               <ArrowLeft size={16}/> Não é da equipe? Voltar ao início
             </button>
          </div>
        </div>
      </div>
    </div>
  );
}
