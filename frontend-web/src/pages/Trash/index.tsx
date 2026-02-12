import { useState, useEffect } from 'react';
import { RotateCcw, XCircle, Trash2, Package, User, ShoppingBag, Loader2 } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';
import ConfirmModal from '../../components/ConfirmModal';

// Interfaces Básicas para Tipagem
interface DeletedItem {
  id: number;
  name: string;
  description?: string; // Produto
  email?: string;       // Usuário
  role?: string;        // Usuário
  deleted_at: string;
}

export default function Trash() {
  const [activeTab, setActiveTab] = useState<'products' | 'users'>('products');
  const [items, setItems] = useState<DeletedItem[]>([]);
  const [loading, setLoading] = useState(false);

  // Estados do Modal
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [actionToConfirm, setActionToConfirm] = useState<() => void>(() => {});
  const [modalConfig, setModalConfig] = useState({ title: '', msg: '', isDestructive: false });

  useEffect(() => {
    loadItems();
  }, [activeTab]);

  async function loadItems() {
    setLoading(true);
    setItems([]);
    try {
      const endpoint = activeTab === 'products' ? '/products/trash' : '/users/trash';
      const { data } = await api.get(endpoint);
      setItems(data);
    } catch {
      toast.error('Erro ao carregar lixeira.');
    } finally {
      setLoading(false);
    }
  }

  // AÇÃO: Restaurar
  function handleRestore(item: DeletedItem) {
    setModalConfig({
      title: 'Restaurar Item?',
      msg: `O item "${item.name}" voltará a ficar ativo no sistema.`,
      isDestructive: false
    });
    setActionToConfirm(() => async () => {
      try {
        const endpoint = activeTab === 'products' ? `/products/${item.id}/restore` : `/users/${item.id}/restore`;
        await api.patch(endpoint);
        toast.success('Item restaurado com sucesso!');
        loadItems();
      } catch { toast.error('Erro ao restaurar.'); }
      setConfirmOpen(false);
    });
    setConfirmOpen(true);
  }

  // AÇÃO: Excluir Permanentemente
  function handleHardDelete(item: DeletedItem) {
    setModalConfig({
      title: 'Excluir Definitivamente?',
      msg: `ATENÇÃO: "${item.name}" será apagado para sempre do banco de dados. Essa ação NÃO pode ser desfeita.`,
      isDestructive: true
    });
    setActionToConfirm(() => async () => {
      try {
        const endpoint = activeTab === 'products' ? `/products/${item.id}/permanent` : `/users/${item.id}/permanent`;
        await api.delete(endpoint);
        toast.success('Item excluído permanentemente.');
        loadItems();
      } catch { toast.error('Erro ao excluir.'); }
      setConfirmOpen(false);
    });
    setConfirmOpen(true);
  }

  return (
    <div className="space-y-6 pb-20">
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <Trash2 className="text-red-500" /> Lixeira do Sistema
          </h1>
          <p className="text-gray-500">Recupere itens excluídos ou limpe definitivamente.</p>
        </div>
      </div>

      {/* Abas */}
      <div className="flex gap-4 border-b border-gray-200">
        <button 
          onClick={() => setActiveTab('products')}
          className={`flex items-center gap-2 px-6 py-3 border-b-2 font-bold transition-colors ${activeTab === 'products' ? 'border-orange-500 text-orange-600' : 'border-transparent text-gray-400 hover:text-gray-600'}`}
        >
          <Package size={20}/> Produtos
        </button>
        <button 
          onClick={() => setActiveTab('users')}
          className={`flex items-center gap-2 px-6 py-3 border-b-2 font-bold transition-colors ${activeTab === 'users' ? 'border-orange-500 text-orange-600' : 'border-transparent text-gray-400 hover:text-gray-600'}`}
        >
          <User size={20}/> Usuários
        </button>
      </div>

      {/* Lista */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        {loading ? (
          <div className="p-12 flex justify-center text-gray-400"><Loader2 className="animate-spin" size={32}/></div>
        ) : items.length === 0 ? (
          <div className="p-12 text-center text-gray-400 italic flex flex-col items-center gap-2">
            <Trash2 size={48} className="opacity-20"/>
            <p>A lixeira está vazia.</p>
          </div>
        ) : (
          <table className="w-full text-left">
            <thead className="bg-red-50 text-red-800 font-bold border-b border-red-100">
              <tr>
                <th className="px-6 py-4">Item Excluído</th>
                <th className="px-6 py-4">Detalhes</th>
                <th className="px-6 py-4">Data de Exclusão</th>
                <th className="px-6 py-4 text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map(item => (
                <tr key={item.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4">
                    <div className="font-bold text-gray-800">{item.name}</div>
                    <div className="text-xs text-gray-400">ID: {item.id}</div>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {activeTab === 'products' ? (
                       <span className="truncate max-w-[200px] block" title={item.description}>{item.description || '-'}</span>
                    ) : (
                       <div className="flex flex-col">
                         <span>{item.email}</span>
                         <span className="text-xs bg-gray-100 w-fit px-1 rounded mt-1">{item.role}</span>
                       </div>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {new Date(item.deleted_at).toLocaleString('pt-BR')}
                  </td>
                  <td className="px-6 py-4 text-right space-x-2">
                    <button 
                      onClick={() => handleRestore(item)}
                      className="px-3 py-1.5 bg-green-50 text-green-700 rounded-lg hover:bg-green-100 font-bold text-xs inline-flex items-center gap-1 transition-colors"
                    >
                      <RotateCcw size={14} /> Restaurar
                    </button>
                    <button 
                      onClick={() => handleHardDelete(item)}
                      className="px-3 py-1.5 bg-red-50 text-red-700 rounded-lg hover:bg-red-100 font-bold text-xs inline-flex items-center gap-1 transition-colors"
                    >
                      <XCircle size={14} /> Excluir
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ConfirmModal 
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={actionToConfirm}
        title={modalConfig.title}
        message={modalConfig.msg}
        confirmLabel={modalConfig.isDestructive ? "Sim, Excluir" : "Sim, Restaurar"}
        isDestructive={modalConfig.isDestructive}
      />
    </div>
  );
}