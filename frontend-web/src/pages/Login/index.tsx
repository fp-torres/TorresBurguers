import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock, Mail, Loader2, ArrowLeft } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast'; 

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  function parseJwt(token: string) {
    try {
      const base64Url = token.split('.')[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(window.atob(base64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
      return JSON.parse(jsonPayload);
    } catch { return null; }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const response = await api.post('/auth/login', { email, password });
      
      const token = response.data.access_token || response.data.token;
      let user = response.data.user;

      if (!user && token) {
        const decoded = parseJwt(token);
        if (decoded) user = { name: decoded.name || 'Usuário', email: decoded.email, role: decoded.role };
      }

      if (token && user) {
        localStorage.setItem('torresburgers.token', token);
        localStorage.setItem('torresburgers.user', JSON.stringify(user));
        
        toast.success(`Bem-vindo, ${user.name.split(' ')[0]}!`);

        if (user.role === 'ADMIN') {
          navigate('/dashboard');
        } else {
          navigate('/orders');
        }
      } else {
        toast.error('Erro ao recuperar dados.');
      }
    } catch (error) {
      toast.error('Credenciais inválidas.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-600 dark:bg-slate-900 flex items-center justify-center p-4 transition-colors duration-300">
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-300 border border-transparent dark:border-slate-700">
        
        {/* Cabeçalho Laranja */}
        <div className="bg-[#bf3b0b] p-8 text-center">
          <div className="w-16 h-16 bg-white/20 backdrop-blur-sm rounded-full flex items-center justify-center mx-auto mb-4 border border-white/30">
             <span className="text-3xl">👨‍🍳</span>
          </div>
          <h1 className="text-2xl font-bold text-white">TorresBurgers</h1>
          <p className="text-orange-100 text-sm mt-1">Acesso Corporativo</p>
        </div>

        <div className="p-8">
          <form onSubmit={handleLogin} className="space-y-6">
            <div>
              <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1">Email Corporativo</label>
              <div className="relative">
                <Mail className="absolute left-3 top-3 text-gray-400" size={20}/>
                <input 
                  required 
                  type="email" 
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-gray-50 dark:bg-slate-700 border border-gray-200 dark:border-slate-600 rounded-xl focus:ring-2 focus:ring-[#bf3b0b] focus:border-[#bf3b0b] outline-none transition-all text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
                  placeholder="admin@torresburgers.com"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 uppercase mb-1">Senha</label>
              <div className="relative">
                <Lock className="absolute left-3 top-3 text-gray-400" size={20}/>
                <input 
                  required 
                  type="password" 
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-gray-50 dark:bg-slate-700 border border-gray-200 dark:border-slate-600 rounded-xl focus:ring-2 focus:ring-[#bf3b0b] focus:border-[#bf3b0b] outline-none transition-all text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
                  placeholder="••••••••"
                />
              </div>
              <div className="text-right mt-2">
                <a href="#" onClick={(e) => {e.preventDefault(); toast('Contate o gerente da loja.', { icon: '🔑' })}} className="text-xs font-bold text-[#bf3b0b] hover:underline">Esqueci a senha</a>
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
               <ArrowLeft size={16}/> Não é funcionário? Voltar ao Cardápio
             </button>
          </div>
        </div>
      </div>
    </div>
  );
}