import { useEffect, useState } from 'react';
import { Plus, Trash2, Shield, Mail, X, Loader2, Edit, Phone, ChefHat, Truck } from 'lucide-react';
import { userService, type User, type CreateUserDTO } from '../../services/userService';

export default function Users() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  
  // CORREÇÃO: Tipagem explícita para evitar erros de inferência
  const [formData, setFormData] = useState<CreateUserDTO>({
    name: '', 
    email: '', 
    password: '', 
    phone: '', 
    role: 'ADMIN'
  });
  
  const [saving, setSaving] = useState(false);

  useEffect(() => { loadUsers(); }, []);

  async function loadUsers() {
    try {
      const data = await userService.getAll();
      setUsers(data);
    } catch (error) { console.error('Erro ao buscar usuários', error); } finally { setLoading(false); }
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
      phone: user.phone || '', 
      role: user.role 
    });
    setIsModalOpen(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      if (editingUser) {
        const payload: any = { ...formData };
        if (!payload.password) delete payload.password;
        await userService.update(editingUser.id, payload);
      } else {
        await userService.create(formData);
      }
      setIsModalOpen(false);
      loadUsers();
    } catch (error) {
      alert('Erro ao salvar usuário.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    if (confirm('Tem certeza que deseja remover este usuário?')) {
      try {
        await userService.delete(id);
        loadUsers();
      } catch (error) {
        alert('Erro ao excluir usuário.');
      }
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Equipe</h1>
          <p className="text-gray-500">Gerencie permissões e membros</p>
        </div>
        <button onClick={openCreateModal} className="bg-orange-600 hover:bg-orange-700 text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-colors font-bold shadow-sm">
          <Plus size={20} /> Novo Membro
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="px-6 py-4 text-gray-600 font-semibold text-sm">Membro</th>
              <th className="px-6 py-4 text-gray-600 font-semibold text-sm">Contato</th>
              <th className="px-6 py-4 text-gray-600 font-semibold text-sm">Cargo</th>
              <th className="px-6 py-4 text-right text-gray-600 font-semibold text-sm">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={4} className="p-8 text-center text-gray-500">Carregando...</td></tr>
            ) : users.map((user) => (
              <tr key={user.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-orange-100 rounded-full flex items-center justify-center text-orange-600 font-bold">
                      {user.name[0].toUpperCase()}
                    </div>
                    <div>
                      <p className="font-medium text-gray-800">{user.name}</p>
                      <p className="text-xs text-gray-400">ID: {user.id}</p>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4 text-gray-600 text-sm">
                  <div className="flex items-center gap-2 mb-1"><Mail size={14} className="text-gray-400"/> {user.email}</div>
                  {user.phone && <div className="flex items-center gap-2"><Phone size={14} className="text-gray-400"/> {user.phone}</div>}
                </td>
                <td className="px-6 py-4">
                  <span className={`px-2 py-1 rounded-full text-xs font-bold border flex items-center gap-1 w-fit ${
                    user.role === 'ADMIN' ? 'bg-purple-100 text-purple-700 border-purple-200' :
                    user.role === 'KITCHEN' ? 'bg-orange-100 text-orange-700 border-orange-200' :
                    user.role === 'COURIER' ? 'bg-blue-100 text-blue-700 border-blue-200' :
                    'bg-gray-100 text-gray-600'
                  }`}>
                    {user.role === 'ADMIN' && <Shield size={12} />}
                    {user.role === 'KITCHEN' && <ChefHat size={12} />}
                    {user.role === 'COURIER' && <Truck size={12} />}
                    {user.role}
                  </span>
                </td>
                <td className="px-6 py-4 text-right space-x-2">
                  <button onClick={() => openEditModal(user)} className="p-2 text-blue-400 hover:bg-blue-50 hover:text-blue-600 rounded-lg transition-colors" title="Editar">
                    <Edit size={18} />
                  </button>
                  <button onClick={() => handleDelete(user.id)} className="p-2 text-red-400 hover:bg-red-50 hover:text-red-600 rounded-lg transition-colors" title="Excluir">
                    <Trash2 size={18} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl p-6 animate-in fade-in zoom-in duration-200">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-gray-800">{editingUser ? 'Editar Membro' : 'Novo Membro'}</h2>
              <button onClick={() => setIsModalOpen(false)}><X className="text-gray-400 hover:text-gray-600" /></button>
            </div>
            
            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Nome Completo</label>
                <input required value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-orange-500 outline-none" placeholder="Ex: João Silva" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                   <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Email</label>
                   <input required type="email" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-orange-500 outline-none" />
                </div>
                <div>
                   <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Celular</label>
                   <input value={formData.phone} onChange={e => setFormData({...formData, phone: e.target.value})} className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-orange-500 outline-none" placeholder="(99) 99999-9999" />
                </div>
              </div>
              
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Cargo / Função</label>
                <select 
                  value={formData.role} 
                  onChange={e => setFormData({...formData, role: e.target.value})} 
                  className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-orange-500 outline-none bg-white"
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
                  className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-orange-500 outline-none" 
                  placeholder="******" 
                  required={!editingUser} 
                />
              </div>
              
              <button disabled={saving} className="w-full bg-orange-600 hover:bg-orange-700 text-white font-bold py-3 rounded-xl transition-colors flex justify-center gap-2 mt-4">
                {saving && <Loader2 className="animate-spin" />}
                {editingUser ? 'Salvar Alterações' : 'Cadastrar Membro'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}