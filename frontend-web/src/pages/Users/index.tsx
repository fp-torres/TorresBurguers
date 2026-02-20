import { useEffect, useState, useMemo } from 'react';
import type { ChangeEvent, FormEvent } from 'react'; 
import { Plus, Trash2, Shield, Mail, X, Loader2, Edit, Phone, ChefHat, Truck, User as UserIcon, Search, Users as UsersGroup, Camera, ZoomIn } from 'lucide-react';
import { userService, type User, type CreateUserDTO } from '../../services/userService';
import toast from 'react-hot-toast';
import ConfirmModal from '../../components/ConfirmModal';
import { normalizePhone } from '../../utils/masks'; 

const ROLES = [
  { id: 'ALL', label: 'Todos', icon: UsersGroup },
  { id: 'ADMIN', label: 'Administradores', icon: Shield },
  { id: 'KITCHEN', label: 'Cozinha', icon: ChefHat },
  { id: 'COURIER', label: 'Motoboys', icon: Truck },
  { id: 'CLIENT', label: 'Clientes', icon: UserIcon },
];

export default function Users() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState('ALL');
  
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  
  // Estado para Zoom da Imagem
  const [selectedImage, setSelectedImage] = useState<string | null>(null);

  // Estados do Formulário
  const [formData, setFormData] = useState<CreateUserDTO>({
    name: '', email: '', confirmEmail: '', password: '', confirmPassword: '', phone: '', role: 'ADMIN'
  });
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  
  const [saving, setSaving] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState<number | null>(null);

  useEffect(() => { loadUsers(); }, []);

  async function loadUsers() {
    try {
      const data = await userService.getAll();
      setUsers(data.sort((a, b) => b.id - a.id));
    } catch (error) { toast.error('Erro ao buscar usuários'); } finally { setLoading(false); }
  }

  function openCreateModal() {
    setEditingUser(null);
    setFormData({ name: '', email: '', confirmEmail: '', password: '', confirmPassword: '', phone: '', role: 'ADMIN' });
    setAvatarFile(null);
    setAvatarPreview(null);
    setIsModalOpen(true);
  }

  function openEditModal(user: User) {
    setEditingUser(user);
    setFormData({ 
      name: user.name, 
      email: user.email, 
      confirmEmail: user.email, 
      password: '', 
      confirmPassword: '',
      phone: normalizePhone(user.phone || ''), 
      role: user.role 
    });
    setAvatarFile(null);
    setAvatarPreview(getDisplayAvatar(user.avatar)); 
    setIsModalOpen(true);
  }

  function handlePhoneChange(e: ChangeEvent<HTMLInputElement>) {
    setFormData({ ...formData, phone: normalizePhone(e.target.value) });
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setAvatarFile(file);
      setAvatarPreview(URL.createObjectURL(file));
    }
  }

  const passwordStrength = useMemo(() => {
    const pass = formData.password || '';
    let score = 0;
    if (pass.length > 7) score++;
    if (/[A-Z]/.test(pass)) score++;
    if (/[0-9]/.test(pass)) score++;
    if (/[^A-Za-z0-9]/.test(pass)) score++;
    return score; 
  }, [formData.password]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (formData.email !== formData.confirmEmail) { toast.error('Os e-mails não coincidem.'); return; }
    if (!editingUser) {
      if (formData.password !== formData.confirmPassword) { toast.error('As senhas não coincidem.'); return; }
      if (!formData.password) { toast.error('Senha é obrigatória para novos usuários.'); return; }
    } else {
      if (formData.password && formData.password !== formData.confirmPassword) { toast.error('As senhas não coincidem.'); return; }
    }

    setSaving(true);
    try {
      if (editingUser) {
        const payload: any = { ...formData };
        if (!payload.password) delete payload.password; 
        delete payload.confirmEmail;
        delete payload.confirmPassword;
        await userService.update(editingUser.id, payload, avatarFile || undefined);
        toast.success('Membro atualizado com sucesso!');
      } else {
        await userService.create(formData, avatarFile || undefined);
        toast.success('Novo membro cadastrado!');
      }
      setIsModalOpen(false);
      loadUsers();
    } catch (error) { toast.error('Erro ao salvar usuário.'); } finally { setSaving(false); }
  }

  function requestDelete(id: number) { setUserToDelete(id); setConfirmDeleteOpen(true); }

  async function executeDelete() {
    if (!userToDelete) return;
    try { await userService.delete(userToDelete); toast.success('Usuário removido.'); loadUsers(); } 
    catch (error) { toast.error('Erro ao excluir usuário.'); } finally { setConfirmDeleteOpen(false); setUserToDelete(null); }
  }

  const filteredUsers = useMemo(() => {
    return users.filter(user => {
      const matchesSearch = user.name.toLowerCase().includes(searchTerm.toLowerCase()) || String(user.id).includes(searchTerm);
      const matchesRole = activeTab === 'ALL' || user.role === activeTab;
      return matchesSearch && matchesRole;
    });
  }, [users, searchTerm, activeTab]);

  const getDisplayAvatar = (avatar?: string | null) => {
    if (!avatar) return null;
    return avatar.startsWith('http') ? avatar : `http://localhost:3000${avatar}`;
  };

  return (
    <div className="space-y-6 pb-20 h-full flex flex-col">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-700 shrink-0 transition-colors">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white">Equipe</h1>
          <p className="text-gray-500 dark:text-gray-400">Gerencie permissões e membros</p>
        </div>
        <button onClick={openCreateModal} className="bg-orange-600 hover:bg-orange-700 text-white px-6 py-3 rounded-xl flex items-center gap-2 transition-all font-bold shadow-lg shadow-orange-200 dark:shadow-none">
          <Plus size={20} /> Novo Membro
        </button>
      </div>

      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-700 shrink-0 transition-colors">
        <div className="flex overflow-x-auto p-2 border-b border-gray-100 dark:border-slate-700 custom-scrollbar gap-2">
          {ROLES.map(role => (
            <button
              key={role.id}
              onClick={() => setActiveTab(role.id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-sm whitespace-nowrap transition-all ${
                activeTab === role.id 
                  ? 'bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 shadow-sm border border-orange-100 dark:border-orange-800' 
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-slate-700 hover:text-gray-700 dark:hover:text-white'
              }`}
            >
              <role.icon size={18} />
              {role.label}
              <span className={`ml-1 text-xs px-2 py-0.5 rounded-full ${activeTab === role.id ? 'bg-orange-200 dark:bg-orange-800 text-orange-800 dark:text-orange-200' : 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-gray-300'}`}>
                {role.id === 'ALL' ? users.length : users.filter(u => u.role === role.id).length}
              </span>
            </button>
          ))}
        </div>

        <div className="p-4 bg-gray-50 dark:bg-slate-900/50 flex gap-3 items-center">
          <Search className="text-gray-400 dark:text-gray-500" />
          <input 
            placeholder="Buscar por Nome ou ID..." 
            className="bg-transparent outline-none flex-1 text-sm font-medium text-gray-700 dark:text-white placeholder-gray-400 dark:placeholder-gray-600" 
            value={searchTerm} 
            onChange={e => setSearchTerm(e.target.value)} 
          />
        </div>
      </div>

      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-700 overflow-hidden flex-1 flex flex-col transition-colors">
        <div className="overflow-auto custom-scrollbar flex-1">
          <table className="w-full text-left">
            <thead className="bg-gray-50 dark:bg-slate-900 border-b border-gray-100 dark:border-slate-700 sticky top-0 z-10 shadow-sm">
              <tr>
                <th className="px-6 py-4 text-gray-600 dark:text-gray-400 font-semibold text-sm">Membro</th>
                <th className="px-6 py-4 text-gray-600 dark:text-gray-400 font-semibold text-sm">Contato</th>
                <th className="px-6 py-4 text-gray-600 dark:text-gray-400 font-semibold text-sm">Cargo</th>
                <th className="px-6 py-4 text-right text-gray-600 dark:text-gray-400 font-semibold text-sm">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
              {loading ? (
                <tr><td colSpan={4} className="p-12 text-center text-gray-500 dark:text-gray-400 italic">Carregando membros...</td></tr>
              ) : filteredUsers.map((user) => (
                <tr key={user.id} className="hover:bg-gray-50 dark:hover:bg-slate-700/50 transition-colors group">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      {user.avatar ? (
                        <div className="relative group cursor-pointer" onClick={() => setSelectedImage(getDisplayAvatar(user.avatar))}>
                          <img src={getDisplayAvatar(user.avatar)!} alt={user.name} className="w-10 h-10 rounded-full object-cover border border-gray-200 dark:border-slate-600 shadow-sm bg-white dark:bg-slate-700" />
                          <div className="absolute inset-0 bg-black/20 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                            <ZoomIn size={14} className="text-white drop-shadow-md" />
                          </div>
                        </div>
                      ) : (
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold border ${user.role === 'ADMIN' ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800' : user.role === 'KITCHEN' ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 border-orange-200 dark:border-orange-800' : user.role === 'COURIER' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800' : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700'}`}>
                          {user.name[0]?.toUpperCase()}
                        </div>
                      )}
                      <div>
                        <p className="font-bold text-gray-800 dark:text-white">{user.name}</p>
                        <p className="text-xs text-gray-400 dark:text-gray-500 font-mono">ID: {user.id}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-gray-600 dark:text-gray-300 text-sm">
                    <div className="flex items-center gap-2 mb-1"><Mail size={14} className="text-gray-400 dark:text-gray-500"/> {user.email}</div>
                    {user.phone && <div className="flex items-center gap-2"><Phone size={14} className="text-gray-400 dark:text-gray-500"/> {user.phone}</div>}
                  </td>
                  <td className="px-6 py-4">
                    <span className={`px-3 py-1.5 rounded-lg text-xs font-bold border flex items-center gap-1.5 w-fit ${user.role === 'ADMIN' ? 'bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 border-purple-100 dark:border-purple-800' : user.role === 'KITCHEN' ? 'bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300 border-orange-100 dark:border-orange-800' : user.role === 'COURIER' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-blue-100 dark:border-blue-800' : 'bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-100 dark:border-gray-700'}`}>
                      {user.role}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right space-x-2">
                    <button onClick={() => openEditModal(user)} className="p-2 text-blue-400 dark:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 hover:text-blue-600 dark:hover:text-blue-300 rounded-lg transition-colors" title="Editar"><Edit size={18} /></button>
                    <button onClick={() => requestDelete(user.id)} className="p-2 text-red-400 dark:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-300 rounded-lg transition-colors" title="Excluir"><Trash2 size={18} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* MODAL DE CADASTRO / EDIÇÃO */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-slate-900 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200 max-h-[90vh] flex flex-col transition-colors border border-gray-100 dark:border-slate-800">
            <div className="bg-gray-50 dark:bg-slate-900/50 px-6 py-4 border-b border-gray-100 dark:border-slate-800 flex justify-between items-center shrink-0">
              <h2 className="text-lg font-bold text-gray-800 dark:text-white">{editingUser ? 'Editar Membro' : 'Novo Membro'}</h2>
              <button onClick={() => setIsModalOpen(false)}><X size={20} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" /></button>
            </div>
            
            <div className="overflow-y-auto p-6 custom-scrollbar">
              <form onSubmit={handleSave} className="space-y-4">
                
                <div className="flex flex-col items-center mb-6">
                  <div className="relative group cursor-pointer">
                    <div className="w-24 h-24 rounded-full bg-gray-100 dark:bg-slate-800 border-2 border-dashed border-gray-300 dark:border-slate-600 flex items-center justify-center overflow-hidden hover:border-orange-500 transition-colors">
                      {avatarPreview ? (
                        <img src={avatarPreview} alt="Preview" className="w-full h-full object-cover" />
                      ) : (
                        <Camera size={32} className="text-gray-400 dark:text-gray-500" />
                      )}
                    </div>
                    <input type="file" accept="image/*" onChange={handleFileChange} className="absolute inset-0 opacity-0 cursor-pointer" />
                    <div className="absolute bottom-0 right-0 bg-orange-600 text-white p-1.5 rounded-full shadow-sm border-2 border-white dark:border-slate-900">
                      <Edit size={12} />
                    </div>
                  </div>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">Clique para alterar a foto</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 uppercase mb-1">Nome Completo</label>
                    <input required value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} className="w-full px-4 py-2 border border-gray-200 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none transition-all bg-white dark:bg-slate-800 text-gray-900 dark:text-white" placeholder="Ex: João Silva" />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 uppercase mb-1">Celular</label>
                    <input value={formData.phone} onChange={handlePhoneChange} className="w-full px-4 py-2 border border-gray-200 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none bg-white dark:bg-slate-800 text-gray-900 dark:text-white" placeholder="(99) 99999-9999" />
                  </div>
                </div>

                <div>
                   <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 uppercase mb-1">Email</label>
                   <input required type="email" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} className="w-full px-4 py-2 border border-gray-200 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none mb-2 bg-white dark:bg-slate-800 text-gray-900 dark:text-white" />
                   
                   <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 uppercase mb-1">Confirmar Email</label>
                   <input required type="email" value={formData.confirmEmail} onChange={e => setFormData({...formData, confirmEmail: e.target.value})} className={`w-full px-4 py-2 border rounded-lg focus:ring-2 outline-none transition-all bg-white dark:bg-slate-800 text-gray-900 dark:text-white ${formData.confirmEmail && formData.email !== formData.confirmEmail ? 'border-red-300 focus:ring-red-200' : 'border-gray-200 dark:border-slate-700 focus:ring-orange-500'}`} placeholder="Repita o email" />
                   {formData.confirmEmail && formData.email !== formData.confirmEmail && <p className="text-xs text-red-500 mt-1">Os e-mails não conferem.</p>}
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-700 dark:text-gray-300 uppercase mb-1">Cargo / Função</label>
                  <select 
                    value={formData.role} 
                    onChange={e => setFormData({...formData, role: e.target.value})} 
                    className="w-full px-4 py-2 border border-gray-200 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none bg-white dark:bg-slate-800 text-gray-900 dark:text-white"
                  >
                    <option value="ADMIN">Administrador (Acesso Total)</option>
                    <option value="KITCHEN">Cozinha (Ver Pedidos)</option>
                    <option value="COURIER">Motoboy (Ver Entregas)</option>
                    <option value="CLIENT">Cliente (Apenas Teste)</option>
                  </select>
                </div>

                <div className="bg-gray-50 dark:bg-slate-800/50 p-4 rounded-xl border border-gray-100 dark:border-slate-700 space-y-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Shield size={14} className="text-orange-600 dark:text-orange-400"/>
                    <span className="text-xs font-bold text-gray-700 dark:text-gray-300 uppercase">Segurança</span>
                  </div>
                  
                  <div>
                    <input 
                      type="password" 
                      value={formData.password} 
                      onChange={e => setFormData({...formData, password: e.target.value})} 
                      className="w-full px-4 py-2 border border-gray-200 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none bg-white dark:bg-slate-800 text-gray-900 dark:text-white" 
                      placeholder={editingUser ? "Nova Senha (opcional)" : "Senha de Acesso"} 
                      required={!editingUser} 
                    />
                    {formData.password && (
                      <div className="flex gap-1 mt-2 h-1">
                        {[1, 2, 3, 4].map((level) => (
                          <div 
                            key={level} 
                            className={`flex-1 rounded-full transition-all duration-300 ${passwordStrength >= level 
                              ? (passwordStrength <= 2 ? 'bg-red-400' : passwordStrength === 3 ? 'bg-yellow-400' : 'bg-green-500') 
                              : 'bg-gray-200 dark:bg-slate-600'}`} 
                          />
                        ))}
                      </div>
                    )}
                    {formData.password && <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1 text-right">{['Fraca', 'Média', 'Boa', 'Forte'][passwordStrength - 1] || 'Muito Fraca'}</p>}
                  </div>

                  <div>
                    <input 
                      type="password" 
                      value={formData.confirmPassword} 
                      onChange={e => setFormData({...formData, confirmPassword: e.target.value})} 
                      className={`w-full px-4 py-2 border rounded-lg focus:ring-2 outline-none bg-white dark:bg-slate-800 text-gray-900 dark:text-white ${formData.confirmPassword && formData.password !== formData.confirmPassword ? 'border-red-300 focus:ring-red-200' : 'border-gray-200 dark:border-slate-600 focus:ring-orange-500'}`}
                      placeholder="Confirmar Senha" 
                      required={!editingUser || !!formData.password} 
                    />
                     {formData.confirmPassword && formData.password !== formData.confirmPassword && <p className="text-xs text-red-500 mt-1">As senhas não conferem.</p>}
                  </div>
                </div>
                
                <button disabled={saving} className="w-full bg-orange-600 hover:bg-orange-700 text-white font-bold py-3 rounded-xl transition-all flex justify-center items-center gap-2 mt-4 shadow-lg shadow-orange-200 dark:shadow-none">
                  {saving ? <Loader2 className="animate-spin" size={20} /> : (editingUser ? <Edit size={18}/> : <Plus size={18}/>)}
                  {editingUser ? 'Salvar Alterações' : 'Cadastrar Membro'}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* MODAL DE ZOOM */}
      {selectedImage && (
        <div className="fixed inset-0 z-[60] bg-black/90 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-300" onClick={() => setSelectedImage(null)}>
          <button className="absolute top-6 right-6 text-white/50 hover:text-white transition-colors" onClick={() => setSelectedImage(null)}><X size={32} /></button>
          <img src={selectedImage} alt="Zoom" className="max-w-full max-h-[85vh] rounded-lg shadow-2xl object-contain animate-in zoom-in-50 duration-300" onClick={(e) => e.stopPropagation()} />
        </div>
      )}

      <ConfirmModal isOpen={confirmDeleteOpen} onClose={() => setConfirmDeleteOpen(false)} onConfirm={executeDelete} title="Remover Membro?" message="Tem certeza que deseja remover este usuário? Essa ação não pode ser desfeita." confirmLabel="Sim, Remover" isDestructive />
    </div>
  );
}