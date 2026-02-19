import { useEffect, useState, useMemo } from 'react';
import type { ChangeEvent, FormEvent } from 'react'; 
import { Plus, Trash2, Shield, Mail, X, Loader2, Edit, Phone, ChefHat, Truck, User as UserIcon, Search, Users as UsersGroup } from 'lucide-react';
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
  
  const [formData, setFormData] = useState<CreateUserDTO>({
    name: '', email: '', password: '', phone: '', role: 'ADMIN'
  });
  
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
    setFormData({ name: '', email: '', password: '', phone: '', role: 'ADMIN' });
    setIsModalOpen(true);
  }

  function openEditModal(user: User) {
    setEditingUser(user);
    setFormData({ 
      name: user.name, 
      email: user.email, 
      password: '', 
      phone: normalizePhone(user.phone || ''), 
      role: user.role 
    });
    setIsModalOpen(true);
  }

  function handlePhoneChange(e: ChangeEvent<HTMLInputElement>) {
    setFormData({ ...formData, phone: normalizePhone(e.target.value) });
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      if (editingUser) {
        const payload: any = { ...formData };
        if (!payload.password) delete payload.password;
        await userService.update(editingUser.id, payload);
        toast.success('Membro atualizado com sucesso!');
      } else {
        await userService.create(formData);
        toast.success('Novo membro cadastrado!');
      }
      setIsModalOpen(false);
      loadUsers();
    } catch (error) {
      toast.error('Erro ao salvar usuário.');
    } finally {
      setSaving(false);
    }
  }

  function requestDelete(id: number) {
    setUserToDelete(id);
    setConfirmDeleteOpen(true);
  }

  async function executeDelete() {
    if (!userToDelete) return;
    try {
      await userService.delete(userToDelete);
      toast.success('Usuário removido.');
      loadUsers();
    } catch (error) { toast.error('Erro ao excluir usuário.'); } finally { setConfirmDeleteOpen(false); setUserToDelete(null); }
  }

  const filteredUsers = useMemo(() => {
    return users.filter(user => {
      const matchesSearch = user.name.toLowerCase().includes(searchTerm.toLowerCase()) || String(user.id).includes(searchTerm);
      const matchesRole = activeTab === 'ALL' || user.role === activeTab;
      return matchesSearch && matchesRole;
    });
  }, [users, searchTerm, activeTab]);

  // Função para montar a URL correta do Avatar
  const getDisplayAvatar = (avatar?: string) => {
    if (!avatar) return null;
    return avatar.startsWith('http') ? avatar : `http://localhost:3000${avatar}`;
  };

  return (
    <div className="space-y-6 pb-20 h-full flex flex-col">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white p-6 rounded-2xl shadow-sm border border-gray-100 shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Equipe</h1>
          <p className="text-gray-500">Gerencie permissões e membros</p>
        </div>
        <button onClick={openCreateModal} className="bg-orange-600 hover:bg-orange-700 text-white px-6 py-3 rounded-xl flex items-center gap-2 transition-colors font-bold shadow-lg shadow-orange-200">
          <Plus size={20} /> Novo Membro
        </button>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 shrink-0">
        <div className="flex overflow-x-auto p-2 border-b border-gray-100 custom-scrollbar gap-2">
          {ROLES.map(role => (
            <button
              key={role.id}
              onClick={() => setActiveTab(role.id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-sm whitespace-nowrap transition-all ${
                activeTab === role.id 
                  ? 'bg-orange-50 text-orange-600 shadow-sm border border-orange-100' 
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
              }`}
            >
              <role.icon size={18} />
              {role.label}
              <span className={`ml-1 text-xs px-2 py-0.5 rounded-full ${activeTab === role.id ? 'bg-orange-200 text-orange-800' : 'bg-gray-100 text-gray-500'}`}>
                {role.id === 'ALL' ? users.length : users.filter(u => u.role === role.id).length}
              </span>
            </button>
          ))}
        </div>

        <div className="p-4 bg-gray-50 flex gap-3 items-center">
          <Search className="text-gray-400" />
          <input placeholder="Buscar por Nome ou ID..." className="bg-transparent outline-none flex-1 text-sm font-medium text-gray-700 placeholder-gray-400" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden flex-1 flex flex-col">
        <div className="overflow-auto custom-scrollbar flex-1">
          <table className="w-full text-left">
            <thead className="bg-gray-50 border-b border-gray-100 sticky top-0 z-10 shadow-sm">
              <tr>
                <th className="px-6 py-4 text-gray-600 font-semibold text-sm">Membro</th>
                <th className="px-6 py-4 text-gray-600 font-semibold text-sm">Contato</th>
                <th className="px-6 py-4 text-gray-600 font-semibold text-sm">Cargo</th>
                <th className="px-6 py-4 text-right text-gray-600 font-semibold text-sm">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={4} className="p-12 text-center text-gray-500 italic">Carregando membros...</td></tr>
              ) : filteredUsers.map((user) => (
                <tr key={user.id} className="hover:bg-gray-50 transition-colors group">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      
                      {/* CORREÇÃO: Renderiza Avatar Real ou Fallback */}
                      {user.avatar ? (
                        <img 
                          src={getDisplayAvatar(user.avatar)!} 
                          alt={user.name} 
                          className="w-10 h-10 rounded-full object-cover border border-gray-200 shadow-sm bg-white" 
                        />
                      ) : (
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold border ${user.role === 'ADMIN' ? 'bg-purple-100 text-purple-600 border-purple-200' : user.role === 'KITCHEN' ? 'bg-orange-100 text-orange-600 border-orange-200' : user.role === 'COURIER' ? 'bg-blue-100 text-blue-600 border-blue-200' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>
                          {user.name[0]?.toUpperCase()}
                        </div>
                      )}

                      <div>
                        <p className="font-bold text-gray-800">{user.name}</p>
                        <p className="text-xs text-gray-400 font-mono">ID: {user.id}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-gray-600 text-sm">
                    <div className="flex items-center gap-2 mb-1"><Mail size={14} className="text-gray-400"/> {user.email}</div>
                    {user.phone && <div className="flex items-center gap-2"><Phone size={14} className="text-gray-400"/> {user.phone}</div>}
                  </td>
                  <td className="px-6 py-4">
                    <span className={`px-3 py-1.5 rounded-lg text-xs font-bold border flex items-center gap-1.5 w-fit ${user.role === 'ADMIN' ? 'bg-purple-50 text-purple-700 border-purple-100' : user.role === 'KITCHEN' ? 'bg-orange-50 text-orange-700 border-orange-100' : user.role === 'COURIER' ? 'bg-blue-50 text-blue-700 border-blue-100' : 'bg-gray-50 text-gray-600 border-gray-100'}`}>
                      {user.role === 'ADMIN' && <Shield size={14} />}
                      {user.role === 'KITCHEN' && <ChefHat size={14} />}
                      {user.role === 'COURIER' && <Truck size={14} />}
                      {user.role === 'CLIENT' && <UserIcon size={14} />}
                      {user.role}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right space-x-2">
                    <button onClick={() => openEditModal(user)} className="p-2 text-blue-400 hover:bg-blue-50 hover:text-blue-600 rounded-lg transition-colors" title="Editar"><Edit size={18} /></button>
                    <button onClick={() => requestDelete(user.id)} className="p-2 text-red-400 hover:bg-red-50 hover:text-red-600 rounded-lg transition-colors" title="Excluir"><Trash2 size={18} /></button>
                  </td>
                </tr>
              ))}
              {filteredUsers.length === 0 && !loading && (
                <tr><td colSpan={4} className="p-12 text-center text-gray-400 italic">Nenhum membro encontrado.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="bg-gray-50 px-6 py-4 border-b border-gray-100 flex justify-between items-center">
              <h2 className="text-lg font-bold text-gray-800">{editingUser ? 'Editar Membro' : 'Novo Membro'}</h2>
              <button onClick={() => setIsModalOpen(false)}><X size={20} className="text-gray-400 hover:text-gray-600" /></button>
            </div>
            
            <form onSubmit={handleSave} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Nome Completo</label>
                <input required value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} className="w-full px-4 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none transition-all" placeholder="Ex: João Silva" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                   <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Email</label>
                   <input required type="email" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} className="w-full px-4 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none" />
                </div>
                <div>
                   <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Celular</label>
                   <input 
                      value={formData.phone} 
                      onChange={handlePhoneChange} 
                      className="w-full px-4 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none" 
                      placeholder="(99) 99999-9999" 
                    />
                </div>
              </div>
              
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Cargo / Função</label>
                <select 
                  value={formData.role} 
                  onChange={e => setFormData({...formData, role: e.target.value})} 
                  className="w-full px-4 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none bg-white"
                >
                  <option value="ADMIN">Administrador (Acesso Total)</option>
                  <option value="KITCHEN">Cozinha (Ver Pedidos)</option>
                  <option value="COURIER">Motoboy (Ver Entregas)</option>
                  <option value="CLIENT">Cliente (Apenas Teste)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase mb-1">
                   {editingUser ? 'Nova Senha (Deixe vazio para manter)' : 'Senha de Acesso'}
                </label>
                <input 
                  type="password" 
                  value={formData.password} 
                  onChange={e => setFormData({...formData, password: e.target.value})} 
                  className="w-full px-4 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-orange-500 outline-none" 
                  placeholder="******" 
                  required={!editingUser} 
                />
              </div>
              
              <button disabled={saving} className="w-full bg-orange-600 hover:bg-orange-700 text-white font-bold py-3 rounded-xl transition-colors flex justify-center items-center gap-2 mt-4 shadow-lg shadow-orange-200">
                {saving ? <Loader2 className="animate-spin" size={20} /> : (editingUser ? <Edit size={18}/> : <Plus size={18}/>)}
                {editingUser ? 'Salvar Alterações' : 'Cadastrar Membro'}
              </button>
            </form>
          </div>
        </div>
      )}
      <ConfirmModal isOpen={confirmDeleteOpen} onClose={() => setConfirmDeleteOpen(false)} onConfirm={executeDelete} title="Remover Membro?" message="Tem certeza que deseja remover este usuário? Essa ação não pode ser desfeita." confirmLabel="Sim, Remover" isDestructive />
    </div>
  );
}