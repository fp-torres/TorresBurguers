import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Lock, Mail, User, Loader2, ArrowLeft } from 'lucide-react';
import api from '../../../services/api';

export default function ClientSignup() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      // Cria usuário com role CLIENT
      await api.post('/users', { name, email, password, role: 'CLIENT' });
      alert('Conta criada! Faça login para continuar.');
      navigate('/signin');
    } catch (error) {
      alert('Erro ao criar conta. Tente outro email.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-md space-y-8 animate-in fade-in slide-in-from-bottom-4">
        <Link to="/signin" className="text-gray-500 flex items-center gap-2 mb-4 hover:text-orange-600"><ArrowLeft size={20}/> Voltar ao Login</Link>
        
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">Crie sua conta 🚀</h1>
          <p className="text-gray-500 mt-2">Para acompanhar seus pedidos em tempo real.</p>
        </div>

        <form onSubmit={handleSignup} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Nome Completo</label>
            <div className="mt-1 relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <User className="h-5 w-5 text-gray-400" />
              </div>
              <input required value={name} onChange={e => setName(e.target.value)} className="pl-10 block w-full border-gray-300 rounded-xl border p-3 focus:ring-orange-500 focus:border-orange-500" placeholder="Seu Nome" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Email</label>
            <div className="mt-1 relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Mail className="h-5 w-5 text-gray-400" />
              </div>
              <input required type="email" value={email} onChange={e => setEmail(e.target.value)} className="pl-10 block w-full border-gray-300 rounded-xl border p-3 focus:ring-orange-500 focus:border-orange-500" placeholder="seu@email.com" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Senha</label>
            <div className="mt-1 relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock className="h-5 w-5 text-gray-400" />
              </div>
              <input required type="password" value={password} onChange={e => setPassword(e.target.value)} className="pl-10 block w-full border-gray-300 rounded-xl border p-3 focus:ring-orange-500 focus:border-orange-500" placeholder="******" />
            </div>
          </div>

          <button disabled={loading} className="w-full flex justify-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-sm font-bold text-white bg-orange-600 hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500 disabled:opacity-50 transition-colors">
            {loading ? <Loader2 className="animate-spin" /> : 'Criar Conta'}
          </button>
        </form>
      </div>
    </div>
  );
}