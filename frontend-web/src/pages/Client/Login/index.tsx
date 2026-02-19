import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Lock, Mail, Loader2, ArrowLeft } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { useCart } from '../../../contexts/CartContext'; 
import toast from 'react-hot-toast';

export default function ClientLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  
  const navigate = useNavigate();
  const { signIn } = useAuth();
  const { cartItems } = useCart(); 

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      // Chama o AuthContext, que faz o request e já salva no localStorage
      const loggedUser = await signIn({ email, password });
      
      toast.success(`Bem-vindo, ${loggedUser.name.split(' ')[0]}!`); 

      if (cartItems.length > 0) {
        navigate('/cart');
      } else {
        navigate('/');
      }

    } catch (error) {
      toast.error('Email ou senha inválidos.'); 
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-md space-y-8 animate-in fade-in slide-in-from-bottom-4">
        
        <Link to="/" className="text-gray-500 flex items-center gap-2 mb-4 hover:text-orange-600 transition-colors w-fit">
          <ArrowLeft size={20}/> Voltar ao cardápio
        </Link>
        
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900">Bem-vindo de volta! 🍔</h1>
          <p className="text-gray-500 mt-2">Faça login para continuar seu pedido.</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-6">
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
            <div className="flex justify-end mt-1">
              <a 
                href="#" 
                onClick={(e) => { e.preventDefault(); toast('Envie um e-mail para contato@torresburgers.com', { icon: '📧' }); }} 
                className="text-sm text-orange-600 hover:text-orange-800 font-medium"
              >
                Esqueceu a senha?
              </a>
            </div>
          </div>

          <button disabled={loading} className="w-full flex justify-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-sm font-bold text-white bg-orange-600 hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500 disabled:opacity-50 transition-colors">
            {loading ? <Loader2 className="animate-spin" /> : 'Entrar'}
          </button>
        </form>

        <div className="text-center space-y-4">
          <p className="text-sm text-gray-600">
            Ainda não tem conta?{' '}
            <Link to="/signup" className="font-medium text-orange-600 hover:text-orange-500">
              Crie agora
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}