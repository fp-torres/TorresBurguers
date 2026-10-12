import { useState, useEffect, useId, useMemo, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  User as UserIcon, Phone, Lock, Save, Camera,
  Eye, EyeOff, Check, X, Mail, ArrowLeft
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../../contexts/AuthContext';
import { userService, type UpdateUserPayload } from '../../../services/userService';
import { assetUrl, getApiErrorMessage } from '../../../services/api';
import { maskPhone } from '../../../utils/masks';
import { PASSWORD_RULES_MESSAGE, PASSWORD_TOO_LONG_MESSAGE, checkPassword, isPasswordTooLong, passwordScore } from '../../../utils/password';
import ConfirmModal from '../../../components/ConfirmModal';

// Depois de salvar, volta ao cardápio (cancelado se a pessoa sair da página antes)
const REDIRECT_AFTER_SAVE_MS = 10000;

const FUN_AVATARS = [
  "https://cdn-icons-png.flaticon.com/512/3075/3075977.png", 
  "https://cdn-icons-png.flaticon.com/512/1046/1046784.png", 
  "https://cdn-icons-png.flaticon.com/512/2405/2405597.png", 
  "https://cdn-icons-png.flaticon.com/512/4264/4264632.png", 
  "https://cdn-icons-png.flaticon.com/512/2819/2819194.png", 
];

export default function ClientProfile() {
  const { user, updateUser, signOut } = useAuth();
  const navigate = useNavigate();
  const photoInputId = useId();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [avatar, setAvatar] = useState(''); 
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  
  const [newPassword, setNewPassword] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [showPass, setShowPass] = useState(false);

  // Mesmas regras de senha da API (inclusive o limite de 72 bytes)
  const checks = useMemo(() => checkPassword(newPassword), [newPassword]);
  const strength = useMemo(() => passwordScore(newPassword), [newPassword]);
  const passwordTooLong = useMemo(() => isPasswordTooLong(newPassword), [newPassword]);

  const [loading, setLoading] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const redirectTimer = useRef<number | null>(null);

  useEffect(() => {
    if (user) {
      setName(user.name);
      setPhone(user.phone || '');
      setAvatar(user.avatar || '');
    }
  }, [user]);

  // Saiu da página antes do redirecionamento: cancela o timer
  useEffect(() => () => {
    if (redirectTimer.current) window.clearTimeout(redirectTimer.current);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { toast.error('Use uma imagem JPG, PNG ou WebP.'); return; }
      if (file.size > 5 * 1024 * 1024) { toast.error("Imagem muito grande! O limite é 5MB."); return; }
      setSelectedFile(file);
      setPreviewUrl(URL.createObjectURL(file));
      setAvatar('');
    }
  };

  const handleSelectIcon = (url: string) => {
    setAvatar(url);
    setSelectedFile(null); 
    setPreviewUrl('');
  };

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    // Só os campos alterados (a API recusa campos desconhecidos e nunca recebe o perfil daqui).
    // Telefone apagado vai vazio: a API limpa o telefone.
    const data: UpdateUserPayload = {};
    if (name.trim() !== user.name) data.name = name.trim();
    if (phone.trim() !== (user.phone || '')) data.phone = phone.trim();
    if (newPassword) data.password = newPassword;
    if (avatar && avatar !== user.avatar) data.avatar = avatar;

    // Sucesso só quando algo foi de fato enviado
    if (Object.keys(data).length === 0 && !selectedFile) {
      toast("Nenhuma alteração para salvar!", { icon: "👍" });
      return;
    }

    if (newPassword && strength < 3) {
      toast.error(PASSWORD_RULES_MESSAGE);
      return;
    }
    if (passwordTooLong) {
      toast.error(PASSWORD_TOO_LONG_MESSAGE);
      return;
    }
    if (newPassword && newPassword !== confirmPass) {
      toast.error('A confirmação não confere com a nova senha.');
      return;
    }
    if (!name.trim()) {
      toast.error('Informe seu nome.');
      return;
    }

    setLoading(true);
    try {
      const updated = await userService.update(user.id, data, selectedFile || undefined);

      // A sessão guarda só os campos públicos (o AuthContext descarta o resto)
      updateUser({
        ...user,
        name: updated.name ?? user.name,
        email: updated.email ?? user.email,
        phone: updated.phone ?? undefined,
        avatar: updated.avatar ?? undefined,
      });
      toast.success('Perfil atualizado com sucesso!');

      setNewPassword('');
      setConfirmPass('');
      setSelectedFile(null);
      setPreviewUrl('');

      if (redirectTimer.current) window.clearTimeout(redirectTimer.current);
      redirectTimer.current = window.setTimeout(() => { navigate('/'); }, REDIRECT_AFTER_SAVE_MS);

    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Erro ao atualizar perfil.'));
    } finally {
      setLoading(false);
    }
  };

  async function handleDeleteAccount() {
    if (!user) return;
    try {
      await userService.deleteAccount(user.id);
      signOut();
      toast.success('Sua conta foi excluída.');
      navigate('/');
    } catch (error) {
      // Ex.: um Administrador não pode excluir a própria conta (400)
      toast.error(getApiErrorMessage(error, 'Não foi possível excluir a conta.'));
    }
  }

  const getDisplayImage = () => {
    if (previewUrl) return previewUrl;
    return assetUrl(avatar) ?? null;
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8 p-4 animate-in fade-in slide-in-from-bottom-4">
      
      <Link to="/" className="text-gray-500 dark:text-gray-400 flex items-center gap-2 mb-2 hover:text-orange-600 dark:hover:text-orange-400 transition-colors w-fit font-medium">
        <ArrowLeft size={20}/> Voltar ao cardápio
      </Link>

      <div className="text-center">
        <h1 className="text-3xl font-bold text-gray-800 dark:text-white">Meus Dados 🍔</h1>
        <p className="text-gray-500 dark:text-gray-400">Mantenha seu perfil atualizado</p>
      </div>

      <form onSubmit={handleUpdateProfile} className="bg-white dark:bg-slate-900 p-6 md:p-8 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-800 space-y-8 transition-colors">
        
        {/* AVATAR */}
        <div className="flex flex-col items-center gap-4">
          <div className="relative w-28 h-28 rounded-full border-4 border-orange-100 dark:border-orange-900/50 overflow-hidden bg-gray-50 dark:bg-slate-800 group shadow-inner">
            {getDisplayImage() ? (
              <img src={getDisplayImage()!} alt="Avatar" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-orange-300 dark:text-orange-700">
                <UserIcon size={48} />
              </div>
            )}
            
            {/* Campo de arquivo visualmente oculto, mas focável pelo teclado (o rótulo aparece ao focar) */}
            <input
              id={photoInputId}
              type="file"
              className="sr-only peer"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleFileChange}
            />
            <label
              htmlFor={photoInputId}
              title="Enviar foto"
              className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 peer-focus-visible:opacity-100 peer-focus-visible:ring-4 peer-focus-visible:ring-inset peer-focus-visible:ring-orange-500 rounded-full cursor-pointer transition-opacity"
            >
              <Camera className="text-white" size={24} />
              <span className="sr-only">Enviar foto de perfil (JPG, PNG ou WebP até 5MB)</span>
            </label>
          </div>
          
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest text-center">Toque na foto para enviar (Máx 5MB) <br/> OU escolha um ícone</p>
          
          <div className="flex justify-center gap-3 flex-wrap">
            {FUN_AVATARS.map((url, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => handleSelectIcon(url)}
                aria-label={`Usar o ícone ${idx + 1} como foto`}
                aria-pressed={avatar === url && !previewUrl}
                className={`w-10 h-10 rounded-full border-2 transition-all hover:scale-110 p-1 bg-gray-50 dark:bg-slate-800 ${avatar === url && !previewUrl ? 'border-orange-500 scale-110' : 'border-transparent'}`}
              >
                <img src={url} alt="" className="w-full h-full object-contain" />
              </button>
            ))}
          </div>
        </div>

        {/* DADOS */}
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-xs font-bold text-gray-400 uppercase ml-1">Nome</label>
            <div className="relative">
              <UserIcon size={18} className="absolute left-3 top-3 text-gray-300" />
              <input value={name} onChange={e => setName(e.target.value)} className="w-full pl-10 p-3 bg-gray-50 dark:bg-slate-800 border border-gray-100 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-orange-500 dark:text-white transition-all" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-bold text-gray-400 uppercase ml-1">Celular</label>
            <div className="relative">
              <Phone size={18} className="absolute left-3 top-3 text-gray-300" />
              <input value={phone} onChange={e => setPhone(maskPhone(e.target.value))} className="w-full pl-10 p-3 bg-gray-50 dark:bg-slate-800 border border-gray-100 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-orange-500 dark:text-white transition-all" />
            </div>
          </div>
        </div>

        {/* EMAIL (READONLY) */}
        <div className="pt-2">
          <label className="text-xs font-bold text-gray-400 uppercase ml-1">Email (Não editável)</label>
          <div className="relative opacity-70 mt-1">
            <Mail size={18} className="absolute left-3 top-3 text-gray-400" />
            <input 
              disabled 
              value={user?.email || ''} 
              className="w-full pl-10 p-3 bg-gray-100 dark:bg-slate-700 border border-gray-200 dark:border-slate-600 rounded-xl text-gray-500 dark:text-gray-300 cursor-not-allowed" 
            />
          </div>
        </div>

        {/* SENHA */}
        <div className="bg-gray-50 dark:bg-slate-800 p-5 rounded-2xl border border-gray-100 dark:border-slate-700 space-y-4">
          <h3 className="font-bold text-gray-700 dark:text-gray-200 text-sm flex items-center gap-2"><Lock size={18} className="text-orange-500"/> Alterar Senha</h3>
          
          <div className="relative">
            <input 
              type={showPass ? "text" : "password"} 
              placeholder="Nova senha (deixe vazio para não alterar)"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              className="w-full p-3 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-600 rounded-xl outline-none pr-10 dark:text-white" 
            />
            <button type="button" onClick={() => setShowPass(!showPass)} aria-label={showPass ? 'Ocultar senha' : 'Mostrar senha'} className="absolute right-3 top-3.5 text-gray-400">
              {showPass ? <EyeOff size={18}/> : <Eye size={18}/>}
            </button>
          </div>

          {newPassword && (
            <div className="space-y-3 animate-in slide-in-from-top-2">
              <div className="h-1.5 w-full bg-gray-200 dark:bg-slate-700 rounded-full overflow-hidden">
                <div className={`h-full transition-all duration-500 ${strength === 3 ? 'bg-green-500 w-full' : strength === 2 ? 'bg-yellow-500 w-2/3' : 'bg-red-500 w-1/3'}`} />
              </div>
              <div className="flex flex-wrap gap-3 text-[10px]">
                <span className={`flex items-center gap-1 ${checks.length ? 'text-green-600 font-bold' : 'text-gray-400'}`}>
                  {checks.length ? <Check size={10}/> : <X size={10}/>} 9+ caracteres
                </span>
                <span className={`flex items-center gap-1 ${checks.upper ? 'text-green-600 font-bold' : 'text-gray-400'}`}>
                  {checks.upper ? <Check size={10}/> : <X size={10}/>} Maiúscula
                </span>
                <span className={`flex items-center gap-1 ${checks.numberOrSymbol ? 'text-green-600 font-bold' : 'text-gray-400'}`}>
                  {checks.numberOrSymbol ? <Check size={10}/> : <X size={10}/>} Número/Símbolo
                </span>
              </div>
              {passwordTooLong && (
                <p role="alert" className="text-[11px] font-bold text-red-500">{PASSWORD_TOO_LONG_MESSAGE}</p>
              )}
              
              <input 
                type="password" 
                placeholder="Confirme a nova senha" 
                value={confirmPass}
                onChange={e => setConfirmPass(e.target.value)}
                className={`w-full p-3 bg-white dark:bg-slate-900 border rounded-xl outline-none dark:text-white ${confirmPass && confirmPass !== newPassword ? 'border-red-500' : 'border-gray-200 dark:border-slate-600'}`}
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
        onConfirm={handleDeleteAccount}
        title="Excluir Conta?"
        message="Seus dados serão enviados para a lixeira do sistema. Esta ação pode ser revertida apenas pelo administrador."
        confirmLabel="Sim, excluir"
        isDestructive
      />
    </div>
  );
}