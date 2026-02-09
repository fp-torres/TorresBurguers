import { useEffect, useState } from 'react';
import { Plus, Trash2, Shield, Mail, X, Loader2 } from 'lucide-react'; // Removido UserIcon
import { userService, type User } from '../../services/userService';

export default function Users() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Estados do Modal
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadUsers();
  }, []);

  async function loadUsers() {
    try {
      const data = await userService.getAll();
      setUsers(data);
    } catch (error) {
      console.error('Erro ao buscar usuários', error);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: number) {
    if (confirm('Tem certeza que deseja remover este usuário?')) {
      try {
        await userService.delete(id);
        loadUsers();
      } catch (error) {
        alert('Erro ao excluir usuário. Verifique se ele não tem pedidos vinculados.');
      }
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await userService.create({
        name: newName,
        email: newEmail,
        password: newPassword,
        role: 'ADMIN' 
      });
      setIsModalOpen(false);
      setNewName(''); setNewEmail(''); setNewPassword('');
      loadUsers();
    } catch (error) {
      alert('Erro ao criar usuário.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Equipe</h1>
          <p className="text-gray-500">Gerencie os administradores do sistema</p>
        </div>
        <button 
          onClick={() => setIsModalOpen(true)}
          className="bg-orange-600 hover:bg-orange-700 text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-colors font-medium shadow-sm"
        >
          <Plus size={20} />
          Novo Membro
        </button>
      </div>

      {/* Lista de Usuários */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="px-6 py-4 text-gray-600 font-semibold text-sm">Nome</th>
              <th className="px-6 py-4 text-gray-600 font-semibold text-sm">Email</th>
              <th className="px-6 py-4 text-gray-600 font-semibold text-sm">Função</th>
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
                    <span className="font-medium text-gray-800">{user.name}</span>
                  </div>
                </td>
                <td className="px-6 py-4 text-gray-600 flex items-center gap-2">
                  <Mail size={16} className="text-gray-400" />
                  {user.email}
                </td>
                <td className="px-6 py-4">
                  <span className={`px-2 py-1 rounded-full text-xs font-bold border flex items-center gap-1 w-fit ${
                    user.role === 'ADMIN' 
                      ? 'bg-purple-100 text-purple-700 border-purple-200' 
                      : 'bg-blue-100 text-blue-700 border-blue-200'
                  }`}>
                    <Shield size={12} />
                    {user.role}
                  </span>
                </td>
                <td className="px-6 py-4 text-right">
                  <button 
                    onClick={() => handleDelete(user.id)}
                    className="p-2 text-red-400 hover:bg-red-50 hover:text-red-600 rounded-lg transition-colors"
                  >
                    <Trash2 size={18} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Modal Simplificado */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl p-6 animate-in fade-in zoom-in duration-200">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-gray-800">Novo Administrador</h2>
              <button onClick={() => setIsModalOpen(false)}><X className="text-gray-400 hover:text-gray-600" /></button>
            </div>
            
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Nome Completo</label>
                <input required value={newName} onChange={e => setNewName(e.target.value)} className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-orange-500 outline-none" placeholder="Ex: João Silva" />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Email de Acesso</label>
                <input required type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-orange-500 outline-none" placeholder="joao@torresburgers.com" />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase mb-1">Senha Provisória</label>
                <input required type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-orange-500 outline-none" placeholder="******" />
              </div>
              
              <button disabled={saving} className="w-full bg-orange-600 hover:bg-orange-700 text-white font-bold py-3 rounded-xl transition-colors flex justify-center gap-2 mt-4">
                {saving && <Loader2 className="animate-spin" />}
                Cadastrar Membro
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}