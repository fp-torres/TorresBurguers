import { useState, useEffect } from 'react';
import { 
  User as UserIcon, Mail, Phone, Lock, Save, Trash2, Camera, 
  ShieldCheck, Eye, EyeOff, Check, X, Upload 
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../../contexts/AuthContext';
import { userService } from '../../../services/userService';
import { maskPhone } from '../../../utils/masks';
import ConfirmModal from '../../../components/ConfirmModal';

export default function ClientProfile() {
  const { user, updateUser, signOut } = useAuth();
  
  // Estados dos campos
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [avatar, setAvatar] = useState(''); // URL atual do banco
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

  // Lógica de Senha Forte (Igual ao Cadastro)
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

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) { // 5MB
        toast.error("Imagem muito grande! O limite é 5MB.");
        return;
      }
      setSelectedFile(file);
      setPreviewUrl(URL.createObjectURL(file));
    }
  };

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    // Se tentar mudar a senha, deve ser FORTE
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

      const updated = await userService.update(user.id, data, selectedFile || undefined);
      
      updateUser(updated);
      toast.success('Perfil atualizado com sucesso!');
      
      // Limpa campos de senha e arquivos após sucesso
      setNewPassword('');
      setConfirmPass('');
      setSelectedFile(null);
    } catch (error) {
      toast.error('Erro ao atualizar perfil.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8 p-4 animate-in fade-in slide-in-from-bottom-4">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-gray-800">Meus Dados 🍔</h1>
        <p className="text-gray-500">Mantenha seu perfil atualizado</p>
      </div>

      <form onSubmit={handleUpdateProfile} className="bg-white p-6 md:p-8 rounded-3xl shadow-sm border space-y-8">
        
        {/* AVATAR COM UPLOAD REAL */}
        <div className="flex flex-col items-center gap-4">
          <div className="relative w-28 h-28 rounded-full border-4 border-orange-100 overflow-hidden bg-gray-50 group shadow-inner">
            {previewUrl || avatar ? (
              <img 
                src={previewUrl || (avatar.startsWith('http') ? avatar : `http://localhost:3000${avatar}`)} 
                alt="Avatar" 
                className="w-full h-full object-cover" 
              />
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
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Toque na foto para alterar (Máx 5MB)</p>
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
        }}
        title="Excluir Conta?"
        message="Seus dados serão enviados para a lixeira do sistema. Esta ação pode ser revertida apenas pelo administrador."
        confirmLabel="Sim, excluir"
        isDestructive
      />
    </div>
  );
}