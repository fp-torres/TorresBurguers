import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Lock, Mail, User, Loader2, ArrowLeft, Phone, Check, X, ShieldCheck, MailCheck } from 'lucide-react';
import api, { getApiErrorMessage } from '../../../services/api';
import toast from 'react-hot-toast';
import { maskPhone } from '../../../utils/masks';
import { PASSWORD_TOO_LONG_MESSAGE, checkPassword, isPasswordTooLong, passwordScore } from '../../../utils/password';
import BrandLogo from '../../../components/BrandLogo';

export default function ClientSignup() {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState(''); 
  
  // Estados de Email
  const [email, setEmail] = useState('');
  const [confirmEmail, setConfirmEmail] = useState('');

  // Estados de Senha
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  // Força da senha calculada a cada digitação (mesmas regras da API, inclusive o limite de 72 bytes)
  const checks = useMemo(() => checkPassword(password), [password]);
  const strength = useMemo(() => passwordScore(password), [password]);
  const passwordTooLong = useMemo(() => isPasswordTooLong(password), [password]);

  // Validações Lógicas
  const passwordsMatch = password === confirmPassword && password.length > 0;
  
  // Regex simples de email
  const isEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const emailsMatch = isEmailValid && email.trim().toLowerCase() === confirmEmail.trim().toLowerCase();

  const isFormValid = strength === 3 && !passwordTooLong && passwordsMatch && emailsMatch && !!name.trim() && phone.length >= 14;

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPhone(maskPhone(e.target.value));
  };

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();

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
      await api.post('/users', { name: name.trim(), email: email.trim(), password, phone });
      toast.success('Conta criada com sucesso! Faça login.');
      navigate('/signin');
    } catch (error) {
      // Ex.: 409 "E-mail já cadastrado" ou as regras de senha (400)
      toast.error(getApiErrorMessage(error, 'Erro ao criar conta.'));
    } finally {
      setLoading(false);
    }
  }

  const getStrengthColor = () => {
    if (strength === 1) return 'bg-red-500';
    if (strength === 2) return 'bg-yellow-500';
    if (strength === 3) return 'bg-green-500';
    return 'bg-gray-200 dark:bg-slate-700';
  };

  const getStrengthLabel = () => {
    if (strength === 0) return '';
    if (strength === 1) return 'Senha Fraca';
    if (strength === 2) return 'Senha Média';
    return 'Senha Forte';
  };

  return (
    <div className="min-h-screen bg-white dark:bg-slate-900 flex flex-col items-center justify-center p-6 transition-colors duration-300">
      <div className="w-full max-w-md space-y-6 animate-in fade-in slide-in-from-bottom-4 my-10">
        <Link to="/signin" className="text-gray-500 dark:text-gray-400 flex items-center gap-2 mb-4 hover:text-orange-600 dark:hover:text-orange-400 w-fit transition-colors">
          <ArrowLeft size={20}/> Voltar ao Login
        </Link>
        
        <div className="text-center">
          <Link to="/" className="inline-flex mb-6 hover:opacity-90 transition-opacity" aria-label="Página inicial">
            <BrandLogo size={48} />
          </Link>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Crie sua conta 🚀</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-2">Para acompanhar seus pedidos em tempo real.</p>
        </div>

        <form onSubmit={handleSignup} className="space-y-4">
          {/* Nome */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Nome Completo</label>
            <div className="mt-1 relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <User className="h-5 w-5 text-gray-400" />
              </div>
              <input 
                required 
                value={name} 
                onChange={e => setName(e.target.value)} 
                className="pl-10 block w-full border-gray-300 dark:border-slate-700 rounded-xl border p-3 focus:ring-orange-500 focus:border-orange-500 bg-white dark:bg-slate-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500" 
                placeholder="Seu Nome" 
                maxLength={50} // <--- CORREÇÃO AQUI
              />
            </div>
          </div>

          {/* Telefone */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Celular / WhatsApp</label>
            <div className="mt-1 relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Phone className="h-5 w-5 text-gray-400" />
              </div>
              <input 
                required 
                value={phone} 
                onChange={handlePhoneChange} 
                className="pl-10 block w-full border-gray-300 dark:border-slate-700 rounded-xl border p-3 focus:ring-orange-500 focus:border-orange-500 bg-white dark:bg-slate-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500" 
                placeholder="(21) 99999-9999" 
                maxLength={15}
              />
            </div>
          </div>

          {/* --- BLOCO DE EMAIL --- */}
          <div className="bg-blue-50 dark:bg-slate-800/50 p-4 rounded-xl border border-blue-100 dark:border-slate-700 space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Email</label>
              <div className="mt-1 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Mail className="h-5 w-5 text-gray-400" />
                </div>
                <input 
                  required 
                  type="email" 
                  value={email} 
                  onChange={e => setEmail(e.target.value)} 
                  className="pl-10 block w-full border-gray-300 dark:border-slate-600 rounded-xl border p-3 focus:ring-orange-500 focus:border-orange-500 bg-white dark:bg-slate-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500" 
                  placeholder="seu@email.com" 
                />
              </div>
            </div>

            {/* Confirmar Email */}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Confirmar Email</label>
              <div className="mt-1 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <MailCheck className={`h-5 w-5 ${emailsMatch ? 'text-green-500' : 'text-gray-400'}`} />
                </div>
                <input 
                  required 
                  type="email" 
                  value={confirmEmail} 
                  onChange={e => setConfirmEmail(e.target.value)} 
                  className={`pl-10 block w-full rounded-xl border p-3 focus:ring-orange-500 focus:border-orange-500 bg-white dark:bg-slate-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 ${
                    confirmEmail && !emailsMatch ? 'border-red-300 bg-red-50 dark:bg-red-900/10' : 'border-gray-300 dark:border-slate-600'
                  }`}
                  placeholder="Repita o email" 
                />
              </div>
              {confirmEmail && !emailsMatch && (
                <p className="text-xs text-red-500 mt-1 flex items-center gap-1"><X size={12}/> Os emails não conferem</p>
              )}
              {emailsMatch && (
                <p className="text-xs text-green-600 dark:text-green-400 mt-1 flex items-center gap-1 font-bold animate-in slide-in-from-left-2"><Check size={12}/> Email confirmado!</p>
              )}
            </div>
          </div>

          {/* --- BLOCO DE SENHA --- */}
          <div className="bg-gray-50 dark:bg-slate-800/30 p-4 rounded-xl border border-gray-200 dark:border-slate-700 space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Senha</label>
              <div className="mt-1 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Lock className="h-5 w-5 text-gray-400" />
                </div>
                <input 
                  required 
                  type="password" 
                  value={password} 
                  onChange={e => setPassword(e.target.value)} 
                  className="pl-10 block w-full border-gray-300 dark:border-slate-600 rounded-xl border p-3 focus:ring-orange-500 focus:border-orange-500 bg-white dark:bg-slate-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500" 
                  placeholder="Crie uma senha forte" 
                />
              </div>
            </div>

            {/* Barra de Força */}
            {password.length > 0 && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs font-bold text-gray-600 dark:text-gray-400">
                  <span>Força: {getStrengthLabel()}</span>
                </div>
                <div className="w-full h-2 bg-gray-200 dark:bg-slate-700 rounded-full overflow-hidden">
                  <div className={`h-full transition-all duration-500 ${getStrengthColor()}`} style={{ width: `${(strength / 3) * 100}%` }}></div>
                </div>
              </div>
            )}

            {/* Requisitos */}
            <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1 pl-1">
              <p className={`flex items-center gap-1 ${checks.length ? 'text-green-600 dark:text-green-400 font-bold' : ''}`}>
                {checks.length ? <Check size={12}/> : <span className="w-3 h-3 block rounded-full bg-gray-300 dark:bg-slate-600"></span>} Mínimo 9 caracteres
              </p>
              <p className={`flex items-center gap-1 ${checks.upper ? 'text-green-600 dark:text-green-400 font-bold' : ''}`}>
                {checks.upper ? <Check size={12}/> : <span className="w-3 h-3 block rounded-full bg-gray-300 dark:bg-slate-600"></span>} Letra Maiúscula
              </p>
              <p className={`flex items-center gap-1 ${checks.numberOrSymbol ? 'text-green-600 dark:text-green-400 font-bold' : ''}`}>
                {checks.numberOrSymbol ? <Check size={12}/> : <span className="w-3 h-3 block rounded-full bg-gray-300 dark:bg-slate-600"></span>} Número ou Símbolo
              </p>
              {passwordTooLong && (
                <p role="alert" className="flex items-start gap-1 text-red-500 font-bold">
                  <X size={12} className="mt-0.5 shrink-0"/> {PASSWORD_TOO_LONG_MESSAGE}
                </p>
              )}
            </div>

            {/* Confirmar Senha */}
            <div className="pt-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Confirmar Senha</label>
              <div className="mt-1 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <ShieldCheck className={`h-5 w-5 ${passwordsMatch ? 'text-green-500' : 'text-gray-400'}`} />
                </div>
                <input 
                  required 
                  type="password" 
                  value={confirmPassword} 
                  onChange={e => setConfirmPassword(e.target.value)} 
                  className={`pl-10 block w-full rounded-xl border p-3 focus:ring-orange-500 focus:border-orange-500 bg-white dark:bg-slate-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 ${
                    confirmPassword && !passwordsMatch ? 'border-red-300 bg-red-50 dark:bg-red-900/10' : 'border-gray-300 dark:border-slate-600'
                  }`}
                  placeholder="Repita a senha" 
                />
              </div>
              {confirmPassword && !passwordsMatch && (
                <p className="text-xs text-red-500 mt-1 flex items-center gap-1"><X size={12}/> As senhas não coincidem</p>
              )}
              {passwordsMatch && (
                <p className="text-xs text-green-600 dark:text-green-400 mt-1 flex items-center gap-1 font-bold animate-in slide-in-from-left-2"><Check size={12}/> Senhas conferem!</p>
              )}
            </div>
          </div>

          <button 
            disabled={loading || !isFormValid} 
            className="w-full flex justify-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-sm font-bold text-white bg-orange-600 hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? <Loader2 className="animate-spin" /> : 'Criar Conta Segura'}
          </button>
        </form>
      </div>
    </div>
  );
}