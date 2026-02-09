import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ChefHat, Lock, Mail, Loader2, AlertCircle, ArrowLeft } from 'lucide-react';
import api from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';

export default function Login() {
  const navigate = useNavigate();
  const { signIn } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function parseJwt(token: string) {
    try {
      const base64Url = token.split('.')[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(window.atob(base64).split('').map(function(c) {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(''));
      return JSON.parse(jsonPayload);
    } catch (e) {
      return null;
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await api.post('/auth/login', {
        email,
        password
      });

      const access_token = response.data.access_token || response.data.token;
      let user = response.data.user;

      if (!user && access_token) {
        const decoded = parseJwt(access_token);
        if (decoded) {
          user = {
            id: decoded.sub || decoded.id,
            name: decoded.name || decoded.username || 'Admin',
            email: decoded.email || email,
            role: decoded.role 
          };
        }
      }

      if (!user || !user.role) {
        throw new Error("Não foi possível identificar o nível de acesso.");
      }

      if (user.role === 'CLIENT') {
        setError('Acesso negado. Clientes devem usar o login do site.');
        setLoading(false);
        return;
      }

      signIn(access_token, user);
      navigate('/dashboard');
      
    } catch (err) {
      console.error(err);
      setError('Email ou senha incorretos, ou erro de conexão.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-orange-50 flex items-center justify-center p-4">
      <div className="bg-white w-full max-w-md rounded-2xl shadow-xl overflow-hidden animate-in fade-in slide-in-from-bottom-4 relative">
        
        {/* Cabeçalho */}
        <div className="bg-orange-600 p-8 text-center">
          <div className="mx-auto bg-white/20 w-16 h-16 rounded-full flex items-center justify-center mb-4 backdrop-blur-sm shadow-lg">
            <ChefHat className="text-white w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold text-white">TorresBurgers</h1>
          <p className="text-orange-100 mt-2 font-medium">Painel Administrativo</p>
        </div>

        {/* Formulário */}
        <div className="p-8 pb-6">
          <form onSubmit={handleLogin} className="space-y-6">
            
            {error && (
              <div className="p-3 bg-red-50 text-red-600 text-sm rounded-lg flex items-center gap-2 border border-red-100 animate-in shake">
                <AlertCircle size={16} />
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-bold text-gray-700 mb-2">Email Corporativo</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Mail className="text-gray-400 w-5 h-5" />
                </div>
                <input 
                  type="email" 
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none transition-all"
                  placeholder="admin@torresburgers.com"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-bold text-gray-700 mb-2">Senha</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Lock className="text-gray-400 w-5 h-5" />
                </div>
                <input 
                  type="password" 
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-orange-500 focus:border-orange-500 outline-none transition-all"
                  placeholder="••••••••"
                  required
                />
              </div>
              <div className="flex justify-end mt-1">
                <a href="#" onClick={(e) => {e.preventDefault(); alert("Contate o administrador do sistema para resetar sua senha.")}} className="text-xs text-orange-600 hover:text-orange-800 font-bold">
                  Esqueci a senha
                </a>
              </div>
            </div>

            <button 
              type="submit" 
              disabled={loading}
              className="w-full bg-orange-600 hover:bg-orange-700 text-white font-bold py-3.5 rounded-xl transition-all shadow-lg shadow-orange-600/20 hover:shadow-orange-600/40 flex items-center justify-center disabled:opacity-70 disabled:cursor-not-allowed mt-2"
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Acessar Sistema'}
            </button>
          </form>
        </div>

        {/* Rodapé do Card: Voltar ao Cardápio */}
        <div className="bg-gray-50 p-4 text-center border-t border-gray-100">
           <Link to="/" className="text-sm text-gray-500 hover:text-orange-600 font-medium flex items-center justify-center gap-2 transition-colors">
             <ArrowLeft size={16} />
             Não é funcionário? Voltar ao Cardápio
           </Link>
        </div>
      </div>
    </div>
  );
}