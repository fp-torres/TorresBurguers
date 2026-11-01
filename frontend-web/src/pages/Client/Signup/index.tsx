import { useId, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Lock, Mail, User, Loader2, ArrowLeft, Phone, Check, X, ShieldCheck, MailCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { getApiErrorMessage, safeRedirect } from '../../../services/api';
import { customerService } from '../../../services/customerService';
import { useAuth } from '../../../contexts/AuthContext';
import { maskPhone } from '../../../utils/masks';
import { PASSWORD_TOO_LONG_MESSAGE, checkPassword, isPasswordTooLong, passwordScore } from '../../../utils/password';
import { defaultClientDestination } from '../../../utils/lastStore';
import { isValidEmail } from '../../../utils/validation';
import { storedCartCountBySlug } from '../../../contexts/cartStorage';
import BrandLogo from '../../../components/BrandLogo';

const INPUT_BASE = 'pl-10 block w-full rounded-xl border p-3 focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none bg-white dark:bg-slate-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500';

/**
 * Cadastro de cliente (/signup): conta global, vale em todas as lojas. Depois de criar a conta, entra
 * automaticamente e volta para onde a pessoa estava (?redirect=, ex.: o carrinho da loja) ou, sem ele,
 * para o carrinho da última loja visitada (se tiver itens), o cardápio dela ou o diretório.
 */
export default function ClientSignup() {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const navigate = useNavigate();
  const { signIn } = useAuth();
  const [searchParams] = useSearchParams();
  const redirectTo = safeRedirect(searchParams.get('redirect'));
  // Sem destino: o carrinho da última loja (se tiver itens), o cardápio dela ou o diretório
  const [fallback] = useState(() => defaultClientDestination(storedCartCountBySlug));
  const afterSignup = redirectTo ?? fallback;
  const signinTo = redirectTo ? `/signin?redirect=${encodeURIComponent(redirectTo)}` : '/signin';

  const ids = {
    name: useId(),
    phone: useId(),
    email: useId(),
    confirmEmail: useId(),
    password: useId(),
    confirmPassword: useId(),
    rules: useId(),
  };

  // Força da senha calculada a cada digitação (mesmas regras da API, inclusive o limite de 72 bytes)
  const checks = useMemo(() => checkPassword(password), [password]);
  const strength = useMemo(() => passwordScore(password), [password]);
  const passwordTooLong = useMemo(() => isPasswordTooLong(password), [password]);

  const passwordsMatch = password === confirmPassword && password.length > 0;
  const isEmailValid = isValidEmail(email);
  const emailsMatch = isEmailValid && email.trim().toLowerCase() === confirmEmail.trim().toLowerCase();
  const isFormValid = strength === 3 && !passwordTooLong && passwordsMatch && emailsMatch && !!name.trim() && phone.length >= 14;

  const handlePhoneChange = (event: ChangeEvent<HTMLInputElement>) => {
    setPhone(maskPhone(event.target.value));
  };

  async function handleSignup(event: FormEvent) {
    event.preventDefault();

    if (passwordTooLong) {
      toast.error(PASSWORD_TOO_LONG_MESSAGE);
      return;
    }
    if (!isFormValid) {
      toast.error('Preencha todos os campos corretamente.');
      return;
    }

    setLoading(true);
    try {
      // Cadastro público: a API sempre cria um Cliente (o perfil não é enviado)
      await customerService.signup({ name: name.trim(), email: email.trim(), password, phone });
    } catch (error) {
      // Ex.: 409 "E-mail já cadastrado" ou as regras de senha (400)
      toast.error(getApiErrorMessage(error, 'Erro ao criar conta.'));
      setLoading(false);
      return;
    }

    // A API envia em segundo plano o link de confirmação do e-mail (outro pode ser pedido em Meus Dados)
    toast(`Enviamos um link para confirmar o e-mail ${email.trim()}. Confira a sua caixa de entrada.`, {
      id: 'signup-email-verification',
      duration: 8000,
    });

    // Conta criada: entra direto e volta para a loja (sem login, cai na tela de login com o mesmo destino)
    try {
      const user = await signIn({ email: email.trim(), password });
      toast.success(`Conta criada! Bem-vindo, ${user.name.split(' ')[0]}!`);
      navigate(afterSignup, { replace: true });
    } catch {
      toast.success('Conta criada com sucesso! Faça login para continuar.');
      navigate(signinTo, { replace: true });
    } finally {
      setLoading(false);
    }
  }

  const strengthColor = strength === 1 ? 'bg-red-500' : strength === 2 ? 'bg-yellow-500' : strength === 3 ? 'bg-green-500' : 'bg-gray-200 dark:bg-slate-700';
  const strengthLabel = strength === 0 ? '' : strength === 1 ? 'Senha Fraca' : strength === 2 ? 'Senha Média' : 'Senha Forte';
  const rules = [
    { ok: checks.length, label: 'Mínimo 9 caracteres' },
    { ok: checks.upper, label: 'Letra Maiúscula' },
    { ok: checks.numberOrSymbol, label: 'Número ou Símbolo' },
  ];

  return (
    <div className="min-h-screen bg-white dark:bg-slate-900 flex flex-col items-center justify-center p-6 transition-colors duration-300">
      <main className="w-full max-w-md space-y-6 animate-in fade-in slide-in-from-bottom-4 my-10">
        <Link to={signinTo} className="text-gray-500 dark:text-gray-400 flex items-center gap-2 mb-4 hover:text-orange-700 dark:hover:text-orange-400 w-fit transition-colors">
          <ArrowLeft size={20} aria-hidden="true" /> Voltar ao Login
        </Link>

        <div className="text-center">
          <Link to="/" className="inline-flex mb-6 hover:opacity-90 transition-opacity" aria-label="Página inicial">
            <BrandLogo size={48} />
          </Link>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Crie sua conta</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-2">Uma conta para pedir e acompanhar seus pedidos em todos os estabelecimentos.</p>
        </div>

        <form onSubmit={handleSignup} className="space-y-4" noValidate>
          <div>
            <label htmlFor={ids.name} className="block text-sm font-medium text-gray-700 dark:text-gray-300">Nome Completo</label>
            <div className="mt-1 relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <User className="h-5 w-5 text-gray-400" aria-hidden="true" />
              </div>
              <input id={ids.name} required autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} className={`${INPUT_BASE} border-gray-300 dark:border-slate-700`} placeholder="Seu Nome" maxLength={50} />
            </div>
          </div>

          <div>
            <label htmlFor={ids.phone} className="block text-sm font-medium text-gray-700 dark:text-gray-300">Celular / WhatsApp</label>
            <div className="mt-1 relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Phone className="h-5 w-5 text-gray-400" aria-hidden="true" />
              </div>
              <input id={ids.phone} required type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={handlePhoneChange} className={`${INPUT_BASE} border-gray-300 dark:border-slate-700`} placeholder="(21) 99999-9999" maxLength={15} />
            </div>
          </div>

          {/* --- E-MAIL --- */}
          <div className="bg-blue-50 dark:bg-slate-800/50 p-4 rounded-xl border border-blue-100 dark:border-slate-700 space-y-3">
            <div>
              <label htmlFor={ids.email} className="block text-sm font-medium text-gray-700 dark:text-gray-300">Email</label>
              <div className="mt-1 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Mail className="h-5 w-5 text-gray-400" aria-hidden="true" />
                </div>
                <input id={ids.email} required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className={`${INPUT_BASE} border-gray-300 dark:border-slate-600`} placeholder="seu@email.com" />
              </div>
            </div>

            <div>
              <label htmlFor={ids.confirmEmail} className="block text-sm font-medium text-gray-700 dark:text-gray-300">Confirmar Email</label>
              <div className="mt-1 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <MailCheck className={`h-5 w-5 ${emailsMatch ? 'text-green-500' : 'text-gray-400'}`} aria-hidden="true" />
                </div>
                <input
                  id={ids.confirmEmail}
                  required
                  type="email"
                  autoComplete="email"
                  value={confirmEmail}
                  onChange={(event) => setConfirmEmail(event.target.value)}
                  aria-invalid={confirmEmail && !emailsMatch ? true : undefined}
                  className={`${INPUT_BASE} ${confirmEmail && !emailsMatch ? 'border-red-300 bg-red-50 dark:bg-red-900/10' : 'border-gray-300 dark:border-slate-600'}`}
                  placeholder="Repita o email"
                />
              </div>
              {confirmEmail && !emailsMatch && (
                <p className="text-xs text-red-600 dark:text-red-400 mt-1 flex items-center gap-1"><X size={12} aria-hidden="true" /> Os emails não conferem</p>
              )}
              {emailsMatch && (
                <p className="text-xs text-green-700 dark:text-green-400 mt-1 flex items-center gap-1 font-bold animate-in slide-in-from-left-2"><Check size={12} aria-hidden="true" /> Email confirmado!</p>
              )}
            </div>
          </div>

          {/* --- SENHA --- */}
          <div className="bg-gray-50 dark:bg-slate-800/30 p-4 rounded-xl border border-gray-200 dark:border-slate-700 space-y-3">
            <div>
              <label htmlFor={ids.password} className="block text-sm font-medium text-gray-700 dark:text-gray-300">Senha</label>
              <div className="mt-1 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Lock className="h-5 w-5 text-gray-400" aria-hidden="true" />
                </div>
                <input id={ids.password} required type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby={ids.rules} className={`${INPUT_BASE} border-gray-300 dark:border-slate-600`} placeholder="Crie uma senha forte" />
              </div>
            </div>

            {password.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-bold text-gray-600 dark:text-gray-400">Força: {strengthLabel}</p>
                <div className="w-full h-2 bg-gray-200 dark:bg-slate-700 rounded-full overflow-hidden" aria-hidden="true">
                  <div className={`h-full transition-all duration-500 ${strengthColor}`} style={{ width: `${(strength / 3) * 100}%` }} />
                </div>
              </div>
            )}

            <ul id={ids.rules} className="text-xs text-gray-500 dark:text-gray-400 space-y-1 pl-1" aria-label="Requisitos da senha">
              {rules.map((rule) => (
                <li key={rule.label} className={`flex items-center gap-1 ${rule.ok ? 'text-green-700 dark:text-green-400 font-bold' : ''}`}>
                  {rule.ok ? <Check size={12} aria-hidden="true" /> : <span className="w-3 h-3 block rounded-full bg-gray-300 dark:bg-slate-600" aria-hidden="true" />} {rule.label}
                  <span className="sr-only">{rule.ok ? '(atendido)' : '(pendente)'}</span>
                </li>
              ))}
              {passwordTooLong && (
                <li role="alert" className="flex items-start gap-1 text-red-600 dark:text-red-400 font-bold">
                  <X size={12} className="mt-0.5 shrink-0" aria-hidden="true" /> {PASSWORD_TOO_LONG_MESSAGE}
                </li>
              )}
            </ul>

            <div className="pt-2">
              <label htmlFor={ids.confirmPassword} className="block text-sm font-medium text-gray-700 dark:text-gray-300">Confirmar Senha</label>
              <div className="mt-1 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <ShieldCheck className={`h-5 w-5 ${passwordsMatch ? 'text-green-500' : 'text-gray-400'}`} aria-hidden="true" />
                </div>
                <input
                  id={ids.confirmPassword}
                  required
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  aria-invalid={confirmPassword && !passwordsMatch ? true : undefined}
                  className={`${INPUT_BASE} ${confirmPassword && !passwordsMatch ? 'border-red-300 bg-red-50 dark:bg-red-900/10' : 'border-gray-300 dark:border-slate-600'}`}
                  placeholder="Repita a senha"
                />
              </div>
              {confirmPassword && !passwordsMatch && (
                <p className="text-xs text-red-600 dark:text-red-400 mt-1 flex items-center gap-1"><X size={12} aria-hidden="true" /> As senhas não coincidem</p>
              )}
              {passwordsMatch && (
                <p className="text-xs text-green-700 dark:text-green-400 mt-1 flex items-center gap-1 font-bold animate-in slide-in-from-left-2"><Check size={12} aria-hidden="true" /> Senhas conferem!</p>
              )}
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || !isFormValid}
            className="w-full flex justify-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-sm font-bold text-white bg-orange-600 hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500 dark:focus:ring-offset-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? <Loader2 className="animate-spin" aria-label="Criando conta" /> : 'Criar Conta Segura'}
          </button>
        </form>

        <p className="text-center text-sm text-gray-600 dark:text-gray-400">
          Já tem conta? <Link to={signinTo} className="font-bold text-orange-700 dark:text-orange-400 hover:underline">Entrar</Link>
        </p>
      </main>
    </div>
  );
}
