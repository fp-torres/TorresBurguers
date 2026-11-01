import { Suspense, lazy, useEffect, useId, useState, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  User as UserIcon, Phone, Save, Camera, Mail, ArrowLeft, Loader2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../../contexts/AuthContext';
import { customerService, type ProfileUpdatePayload } from '../../../services/customerService';
import { avatarUrl, getApiErrorMessage } from '../../../services/api';
import { maskPhone } from '../../../utils/masks';
import { readLastStore, storePath } from '../../../utils/lastStore';
import ConfirmModal from '../../../components/ConfirmModal';

// "Sessões ativas" e "Segurança da conta" (os mesmos do menu do painel) em pacotes à parte: fora do
// carregamento inicial da loja
const ActiveSessions = lazy(() => import('../../../components/Sidebar/ActiveSessions'));
const AccountSecurity = lazy(() => import('../../../components/Account/AccountSecurity'));

const SECTION_CLASS = 'bg-white dark:bg-slate-900 p-6 md:p-8 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-800 transition-colors';

const FUN_AVATARS = [
  'https://cdn-icons-png.flaticon.com/512/3075/3075977.png',
  'https://cdn-icons-png.flaticon.com/512/1046/1046784.png',
  'https://cdn-icons-png.flaticon.com/512/2405/2405597.png',
  'https://cdn-icons-png.flaticon.com/512/4264/4264632.png',
  'https://cdn-icons-png.flaticon.com/512/2819/2819194.png',
];

const LABEL_CLASS = 'text-xs font-bold text-gray-500 dark:text-gray-400 uppercase ml-1';
const INPUT_CLASS = 'w-full pl-10 p-3 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-orange-500 text-gray-900 dark:text-white transition-all';

/**
 * Meus Dados (/profile): conta global do cliente (vale em todas as lojas). Layout da plataforma. O formulário
 * de dados envia só nome, telefone e foto (PATCH /users/:id); e-mail e senha ficam em "Segurança da conta"
 * (rotas /account, com a senha atual e a confirmação do e-mail novo).
 */
export default function ClientProfile() {
  const { user, updateUser, signOut } = useAuth();
  const navigate = useNavigate();
  const photoInputId = useId();
  const nameId = useId();
  const phoneId = useId();
  const emailId = useId();

  const [formUserId, setFormUserId] = useState(user?.id ?? null);
  const [name, setName] = useState(user?.name ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [avatar, setAvatar] = useState(user?.avatar ?? '');
  // Outra conta entrou nesta aba: o formulário passa a ser dela
  if (user && user.id !== formUserId) {
    setFormUserId(user.id);
    setName(user.name);
    setPhone(user.phone ?? '');
    setAvatar(user.avatar ?? '');
  }

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');

  const [loading, setLoading] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [lastStore] = useState(readLastStore);
  const backTo = lastStore ? storePath(lastStore) : '/';

  // A prévia da foto escolhida é liberada da memória quando trocada ou ao sair da página
  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { toast.error('Use uma imagem JPG, PNG ou WebP.'); return; }
    if (file.size > 5 * 1024 * 1024) { toast.error('Imagem muito grande! O limite é 5MB.'); return; }
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
    setAvatar('');
  };

  const handleSelectIcon = (url: string) => {
    setAvatar(url);
    setSelectedFile(null);
    setPreviewUrl('');
  };

  const handleUpdateProfile = async (event: FormEvent) => {
    event.preventDefault();
    if (!user) return;

    // Só os campos alterados (a API recusa campos desconhecidos e nunca recebe o perfil daqui): nome,
    // telefone e foto. Telefone apagado vai vazio: a API limpa o telefone.
    const data: ProfileUpdatePayload = {};
    if (name.trim() !== user.name) data.name = name.trim();
    if (phone.trim() !== (user.phone || '')) data.phone = phone.trim();
    if (avatar && avatar !== user.avatar) data.avatar = avatar;

    // Sucesso só quando algo foi de fato enviado
    if (Object.keys(data).length === 0 && !selectedFile) {
      toast('Nenhuma alteração para salvar!', { icon: '👍' });
      return;
    }
    if (!name.trim()) {
      toast.error('Informe seu nome.');
      return;
    }

    setLoading(true);
    try {
      const updated = await customerService.updateProfile(user.id, data, selectedFile || undefined);
      // A sessão guarda só os campos públicos (o AuthContext descarta o resto)
      updateUser({
        ...user,
        name: updated?.name ?? user.name,
        email: updated?.email ?? user.email,
        phone: updated?.phone ?? undefined,
        avatar: updated?.avatar ?? undefined,
      });
      setAvatar(updated?.avatar ?? '');
      toast.success('Perfil atualizado com sucesso!');

      setSelectedFile(null);
      setPreviewUrl('');
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Erro ao atualizar perfil.'));
    } finally {
      setLoading(false);
    }
  };

  async function handleDeleteAccount() {
    if (!user) return;
    try {
      await customerService.deleteAccount(user.id);
      signOut();
      toast.success('Sua conta foi excluída.');
      navigate('/');
    } catch (error) {
      // Ex.: um Administrador não pode excluir a própria conta (400)
      toast.error(getApiErrorMessage(error, 'Não foi possível excluir a conta.'));
    }
  }

  const displayImage = previewUrl || avatarUrl(avatar) || null;

  return (
    <div className="max-w-2xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4">

      <Link to={backTo} className="text-gray-500 dark:text-gray-400 flex items-center gap-2 mb-2 hover:text-orange-700 dark:hover:text-orange-400 transition-colors w-fit font-medium">
        <ArrowLeft size={20} aria-hidden="true" /> {lastStore ? 'Voltar para a loja' : 'Ver estabelecimentos'}
      </Link>

      <div className="text-center">
        <h1 className="text-3xl font-bold text-gray-800 dark:text-white">Meus Dados</h1>
        <p className="text-gray-500 dark:text-gray-400">Sua conta vale para pedir em todos os estabelecimentos.</p>
      </div>

      <form onSubmit={handleUpdateProfile} className="bg-white dark:bg-slate-900 p-6 md:p-8 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-800 space-y-8 transition-colors">

        {/* AVATAR */}
        <div className="flex flex-col items-center gap-4">
          <div className="relative w-28 h-28 rounded-full border-4 border-orange-100 dark:border-orange-900/50 overflow-hidden bg-gray-50 dark:bg-slate-800 group shadow-inner">
            {displayImage ? (
              <img src={displayImage} alt="Sua foto de perfil" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-orange-300 dark:text-orange-700" aria-hidden="true">
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
              <Camera className="text-white" size={24} aria-hidden="true" />
              <span className="sr-only">Enviar foto de perfil (JPG, PNG ou WebP até 5MB)</span>
            </label>
          </div>

          <p className="text-[10px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest text-center">Toque na foto para enviar (Máx 5MB) <br /> OU escolha um ícone</p>

          <div className="flex justify-center gap-3 flex-wrap">
            {FUN_AVATARS.map((url, index) => (
              <button
                key={url}
                type="button"
                onClick={() => handleSelectIcon(url)}
                aria-label={`Usar o ícone ${index + 1} como foto`}
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
            <label htmlFor={nameId} className={LABEL_CLASS}>Nome</label>
            <div className="relative">
              <UserIcon size={18} className="absolute left-3 top-3.5 text-gray-400" aria-hidden="true" />
              <input id={nameId} autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} maxLength={50} className={INPUT_CLASS} />
            </div>
          </div>
          <div className="space-y-1">
            <label htmlFor={phoneId} className={LABEL_CLASS}>Celular</label>
            <div className="relative">
              <Phone size={18} className="absolute left-3 top-3.5 text-gray-400" aria-hidden="true" />
              <input id={phoneId} type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(maskPhone(event.target.value))} className={INPUT_CLASS} />
            </div>
          </div>
        </div>

        {/* E-MAIL (somente leitura aqui: a troca, com confirmação no endereço novo, fica em "Segurança da conta") */}
        <div className="space-y-1">
          <label htmlFor={emailId} className={LABEL_CLASS}>E-mail</label>
          <div className="relative opacity-80">
            <Mail size={18} className="absolute left-3 top-3.5 text-gray-400" aria-hidden="true" />
            <input
              id={emailId}
              readOnly
              aria-describedby={`${emailId}-hint`}
              value={user?.email || ''}
              className="w-full pl-10 p-3 bg-gray-100 dark:bg-slate-700 border border-gray-200 dark:border-slate-600 rounded-xl text-gray-600 dark:text-gray-300"
            />
          </div>
          <p id={`${emailId}-hint`} className="text-xs text-gray-500 dark:text-gray-400 ml-1">
            Para trocar o e-mail ou a senha, use <a href="#account-security-title" className="font-bold text-orange-700 dark:text-orange-400 hover:underline">Segurança da conta</a>, abaixo.
          </p>
        </div>

        <button type="submit" disabled={loading} className="w-full bg-green-600 text-white font-bold py-4 rounded-xl hover:bg-green-700 transition-all shadow-lg flex justify-center items-center gap-2 disabled:opacity-50">
          {loading ? <><Loader2 className="animate-spin" size={20} aria-hidden="true" /> Salvando...</> : <><Save size={20} aria-hidden="true" /> Salvar Alterações</>}
        </button>

        <button
          type="button"
          onClick={() => setDeleteModalOpen(true)}
          className="w-full text-red-600 dark:text-red-400 text-xs font-bold hover:text-red-700 transition-colors pt-4"
        >
          Excluir minha conta
        </button>
      </form>

      <Suspense fallback={null}>
        <AccountSecurity className={SECTION_CLASS} />
        <ActiveSessions loginPath="/signin" className={SECTION_CLASS} />
      </Suspense>

      <ConfirmModal
        isOpen={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        onConfirm={() => void handleDeleteAccount()}
        title="Excluir Conta?"
        message="Seus dados serão enviados para a lixeira do sistema. Esta ação pode ser revertida apenas pelo suporte da plataforma."
        confirmLabel="Sim, excluir"
        isDestructive
      />
    </div>
  );
}
