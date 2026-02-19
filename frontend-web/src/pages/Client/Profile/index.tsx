import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { 
  User as UserIcon, Phone, Lock, Save, Camera, 
  Eye, EyeOff, Check, X, Mail, ArrowLeft 
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../../contexts/AuthContext';
import { userService } from '../../../services/userService';
import { maskPhone } from '../../../utils/masks';
import ConfirmModal from '../../../components/ConfirmModal';

const FUN_AVATARS = [
  "https://cdn-icons-png.flaticon.com/512/3075/3075977.png", // Burger
  "https://cdn-icons-png.flaticon.com/512/1046/1046784.png", // Fries
  "https://cdn-icons-png.flaticon.com/512/2405/2405597.png", // Soda
  "https://cdn-icons-png.flaticon.com/512/4264/4264632.png", // Pizza
  "https://cdn-icons-png.flaticon.com/512/2819/2819194.png", // Hotdog
];

export default function ClientProfile() {
  const { user, updateUser, signOut } = useAuth();
  const navigate = useNavigate();
  
  // Estados dos campos
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [avatar, setAvatar] = useState(''); // Armazena a URL do ícone ou a imagem do banco
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  
  // Estados de Senha
  const [newPassword, setNewPassword] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [showPass, setShowPass] = useState(false);
  
  // Validação de Força
  const [strength, setStrength] = useState(0);
  const [checks, setChecks] = useState({ length: false, upper: false, special: false });

  const [loading, setLoading] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  useEffect(() => {
    if (user) {
      setName(user.name);
      setPhone(user.phone || '');
      setAvatar(user.avatar || '');
    }
  }, [user]);

  // Lógica de Senha Forte
  useEffect(() => {
    if (newPassword) {
      const c = {
        length: newPassword.length >= 9,
        upper: /[A-Z]/.test(newPassword),
        special: /[!@#$%^&*(),.?":{}|<>]/.test(newPassword) || /[0-9]/.test(newPassword)
      };
      setChecks(c);
      let score = 0;
      if (c.length) score++;
      if (c.upper) score++;
      if (c.special) score++;
      setStrength(score);
    } else {
      setStrength(0);
    }
  }, [newPassword]);

  // Handle Foto do Dispositivo
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) { // 5MB
        toast.error("Imagem muito grande! O limite é 5MB.");
        return;
      }
      setSelectedFile(file);
      setPreviewUrl(URL.createObjectURL(file));
      setAvatar(''); // Limpa a URL do ícone se a pessoa fizer upload
    }
  };

  // Handle Ícone Divertido
  const handleSelectIcon = (url: string) => {
    setAvatar(url);
    setSelectedFile(null); // Remove o arquivo se a pessoa preferir o ícone
    setPreviewUrl('');
  };

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    // --- CORREÇÃO: Verificação de "Nenhuma alteração" ---
    if (
      name === user.name && 
      phone === (user.phone || '') && 
      avatar === (user.avatar || '') && 
      !selectedFile && 
      !newPassword
    ) {
      toast("Nenhuma alteração para salvar!", { icon: "👍" });
      return;
    }

    if (newPassword && (strength < 3 || newPassword !== confirmPass)) {
      toast.error('Para alterar a senha, ela precisa ser FORTE e confirmada corretamente.');
      return;
    }

    setLoading(true);
    try {
      const data: any = {};
      if (name !== user.name) data.name = name;
      if (phone !== user.phone) data.phone = phone;
      if (newPassword) data.password = newPassword;
      if (avatar && avatar !== user.avatar) data.avatar = avatar;

      const updated = await userService.update(user.id, data, selectedFile || undefined);
      
      updateUser(updated);
      toast.success('Perfil atualizado com sucesso!');
      
      setNewPassword('');
      setConfirmPass('');
      setSelectedFile(null);

      // --- CORREÇÃO: Redirecionamento em 10 segundos ---
      setTimeout(() => {
        navigate('/');
      }, 10000); 

    } catch (error) {
      toast.error('Erro ao atualizar perfil.');
    } finally {
      setLoading(false);
    }
  };

  // Monta a imagem correta para exibir (Sem usar variável de ambiente)
  const getDisplayImage = () => {
    if (previewUrl) return previewUrl; // Imagem que acabou de subir (Preview)
    if (avatar) {
      // Se for um link de ícone (http...), usa direto. Se for foto do backend (/uploads...), coloca localhost na frente.
      return avatar.startsWith('http') ? avatar : `http://localhost:3000${avatar}`; 
    }
    return null;
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8 p-4 animate-in fade-in slide-in-from-bottom-4">
      
      {/* Botão Voltar */}
      <Link to="/" className="text-gray-500 flex items-center gap-2 mb-2 hover:text-orange-600 transition-colors w-fit font-medium">
        <ArrowLeft size={20}/> Voltar ao cardápio
      </Link>

      <div className="text-center">
        <h1 className="text-3xl font-bold text-gray-800">Meus Dados 🍔</h1>
        <p className="text-gray-500">Mantenha seu perfil atualizado</p>
      </div>

      <form onSubmit={handleUpdateProfile} className="bg-white p-6 md:p-8 rounded-3xl shadow-sm border space-y-8">
        
        {/* AVATAR: Foto ou Ícone */}
        <div className="flex flex-col items-center gap-4">
          <div className="relative w-28 h-28 rounded-full border-4 border-orange-100 overflow-hidden bg-gray-50 group shadow-inner">
            {getDisplayImage() ? (
              <img src={getDisplayImage()!} alt="Avatar" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-orange-300">
                <UserIcon size={48} />
              </div>
            )}
            
            <label className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 cursor-pointer transition-opacity">
              <Camera className="text-white" size={24} />
              <input type="file" className="hidden" accept="image/*" onChange={handleFileChange} />
            </label>
          </div>
          
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest text-center">Toque na foto para enviar (Máx 5MB) <br/> OU escolha um ícone abaixo</p>
          
          <div className="flex justify-center gap-3 flex-wrap">
            {FUN_AVATARS.map((url, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => handleSelectIcon(url)}
                className={`w-10 h-10 rounded-full border-2 transition-all hover:scale-110 p-1 bg-gray-50 ${avatar === url && !previewUrl ? 'border-orange-500 scale-110' : 'border-transparent'}`}
              >
                <img src={url} className="w-full h-full object-contain" />
              </button>
            ))}
          </div>
        </div>

        {/* DADOS (OPCIONAIS NA EDIÇÃO) */}
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-xs font-bold text-gray-400 uppercase ml-1">Nome</label>
            <div className="relative">
              <UserIcon size={18} className="absolute left-3 top-3 text-gray-300" />
              <input value={name} onChange={e => setName(e.target.value)} className="w-full pl-10 p-3 bg-gray-50 border border-gray-100 rounded-xl outline-none focus:ring-2 focus:ring-orange-500 transition-all" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-bold text-gray-400 uppercase ml-1">Celular</label>
            <div className="relative">
              <Phone size={18} className="absolute left-3 top-3 text-gray-300" />
              <input value={phone} onChange={e => setPhone(maskPhone(e.target.value))} className="w-full pl-10 p-3 bg-gray-50 border border-gray-100 rounded-xl outline-none focus:ring-2 focus:ring-orange-500 transition-all" />
            </div>
          </div>
        </div>

        {/* CAMPO DE EMAIL BLOQUEADO */}
        <div className="pt-2">
          <label className="text-xs font-bold text-gray-400 uppercase ml-1">Email (Não editável)</label>
          <div className="relative opacity-70 mt-1">
            <Mail size={18} className="absolute left-3 top-3 text-gray-400" />
            <input 
              disabled 
              value={user?.email || ''} 
              className="w-full pl-10 p-3 bg-gray-100 border border-gray-200 rounded-xl text-gray-500 cursor-not-allowed" 
            />
          </div>
          <span className="text-[10px] text-orange-600 mt-1 block ml-1">Para alterar seu email, entre em contato com o suporte.</span>
        </div>

        {/* SENHA FORTE (OPCIONAL) */}
        <div className="bg-gray-50 p-5 rounded-2xl border border-gray-100 space-y-4">
          <h3 className="font-bold text-gray-700 text-sm flex items-center gap-2"><Lock size={18} className="text-orange-500"/> Alterar Senha</h3>
          
          <div className="relative">
            <input 
              type={showPass ? "text" : "password"} 
              placeholder="Nova senha (deixe vazio para não alterar)"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              className="w-full p-3 bg-white border border-gray-200 rounded-xl outline-none pr-10" 
            />
            <button type="button" onClick={() => setShowPass(!showPass)} className="absolute right-3 top-3.5 text-gray-400">
              {showPass ? <EyeOff size={18}/> : <Eye size={18}/>}
            </button>
          </div>

          {newPassword && (
            <div className="space-y-3 animate-in slide-in-from-top-2">
              <div className="h-1.5 w-full bg-gray-200 rounded-full overflow-hidden">
                <div className={`h-full transition-all duration-500 ${strength === 3 ? 'bg-green-500 w-full' : strength === 2 ? 'bg-yellow-500 w-2/3' : 'bg-red-500 w-1/3'}`} />
              </div>
              <div className="flex flex-wrap gap-3 text-[10px]">
                <span className={`flex items-center gap-1 ${checks.length ? 'text-green-600 font-bold' : 'text-gray-400'}`}>
                  {checks.length ? <Check size={10}/> : <X size={10}/>} 9+ caracteres
                </span>
                <span className={`flex items-center gap-1 ${checks.upper ? 'text-green-600 font-bold' : 'text-gray-400'}`}>
                  {checks.upper ? <Check size={10}/> : <X size={10}/>} Maiúscula
                </span>
                <span className={`flex items-center gap-1 ${checks.special ? 'text-green-600 font-bold' : 'text-gray-400'}`}>
                  {checks.special ? <Check size={10}/> : <X size={10}/>} Número/Símbolo
                </span>
              </div>
              
              <input 
                type="password" 
                placeholder="Confirme a nova senha" 
                value={confirmPass}
                onChange={e => setConfirmPass(e.target.value)}
                className={`w-full p-3 bg-white border rounded-xl outline-none ${confirmPass && confirmPass !== newPassword ? 'border-red-500' : 'border-gray-200'}`}
              />
            </div>
          )}
        </div>

        <button type="submit" disabled={loading} className="w-full bg-green-600 text-white font-bold py-4 rounded-xl hover:bg-green-700 transition-all shadow-lg flex justify-center items-center gap-2 disabled:opacity-50">
           {loading ? <Save className="animate-spin" /> : <><Save size={20}/> Salvar Alterações</>}
        </button>

        <button 
          type="button" 
          onClick={() => setDeleteModalOpen(true)}
          className="w-full text-red-400 text-xs font-bold hover:text-red-600 transition-colors pt-4"
        >
          Excluir minha conta
        </button>
      </form>

      <ConfirmModal 
        isOpen={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        onConfirm={async () => {
          await userService.deleteAccount(user!.id);
          signOut();
          navigate('/'); // Redireciona para o início após apagar a conta
        }}
        title="Excluir Conta?"
        message="Seus dados serão enviados para a lixeira do sistema. Esta ação pode ser revertida apenas pelo administrador."
        confirmLabel="Sim, excluir"
        isDestructive
      />
    </div>
  );
}