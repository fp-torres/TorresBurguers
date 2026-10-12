import { useState, useEffect, useCallback } from 'react';
import { RotateCcw, XCircle, Trash2, Package, User, Loader2 } from 'lucide-react';
import api, { getApiErrorMessage } from '../../services/api';
import toast from 'react-hot-toast';
import ConfirmModal from '../../components/ConfirmModal';
import { roleLabel } from '../../utils/roles';
import { formatDateTime } from '../../utils/format';

interface DeletedItem {
  id: number;
  name: string;
  description?: string;
  email?: string;
  role?: string;
  /** Produtos: disponibilidade que voltará com a restauração. */
  available?: boolean;
  deleted_at: string;
}

type TrashTab = 'products' | 'users';

export default function Trash() {
  const [activeTab, setActiveTab] = useState<TrashTab>('products');
  const [items, setItems] = useState<DeletedItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [actionToConfirm, setActionToConfirm] = useState<() => void>(() => {});
  const [modalConfig, setModalConfig] = useState({ title: '', msg: '', isDestructive: false });

  const fetchItems = useCallback(async (tab: TrashTab) => {
    const endpoint = tab === 'products' ? '/products/trash' : '/users/trash';
    const { data } = await api.get<DeletedItem[]>(endpoint);
    return data;
  }, []);

  // Recarrega ao trocar de aba; respostas de uma aba anterior são ignoradas
  useEffect(() => {
    let active = true;
    fetchItems(activeTab)
      .then(data => { if (active) setItems(data); })
      .catch(error => { if (active) toast.error(getApiErrorMessage(error, 'Erro ao carregar lixeira.')); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [activeTab, fetchItems]);

  function changeTab(tab: TrashTab) {
    if (tab === activeTab) return;
    setItems([]);
    setLoading(true);
    setActiveTab(tab);
  }

  async function reload() {
    try {
      setItems(await fetchItems(activeTab));
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Erro ao carregar lixeira.'));
    }
  }

  function handleRestore(item: DeletedItem) {
    const isProduct = activeTab === 'products';
    // Produtos voltam com a disponibilidade que tinham antes da exclusão
    const msg = isProduct
      ? item.available === false
        ? `O produto "${item.name}" voltará para o cardápio, mas continuará Esgotado até ser ativado.`
        : `O produto "${item.name}" voltará para o cardápio.`
      : `O usuário "${item.name}" voltará a ter acesso ao sistema.`;
    setModalConfig({ title: 'Restaurar Item?', msg, isDestructive: false });
    setActionToConfirm(() => async () => {
      try {
        const endpoint = isProduct ? `/products/${item.id}/restore` : `/users/${item.id}/restore`;
        await api.patch(endpoint); toast.success('Item restaurado com sucesso!'); reload();
      } catch (error) { toast.error(getApiErrorMessage(error, 'Erro ao restaurar.')); }
      setConfirmOpen(false);
    });
    setConfirmOpen(true);
  }

  function handleHardDelete(item: DeletedItem) {
    const isProduct = activeTab === 'products';
    setModalConfig({
      title: 'Excluir Definitivamente?',
      msg: `ATENÇÃO: "${item.name}" será apagado para sempre. ${isProduct ? 'Produtos' : 'Usuários'} que aparecem em pedidos não podem ser apagados, para preservar o histórico.`,
      isDestructive: true,
    });
    setActionToConfirm(() => async () => {
      try {
        const endpoint = isProduct ? `/products/${item.id}/permanent` : `/users/${item.id}/permanent`;
        await api.delete(endpoint); toast.success('Item excluído permanentemente.'); reload();
      } catch (error) {
        // 409: item referenciado por pedidos (a API explica o motivo)
        toast.error(getApiErrorMessage(error, 'Erro ao excluir.'), { duration: 6000 });
      }
      setConfirmOpen(false);
    });
    setConfirmOpen(true);
  }

  return (
    <div className="space-y-6 pb-20">
      <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-700 flex justify-between items-center transition-colors">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white flex items-center gap-2">
            <Trash2 className="text-red-500" /> Lixeira do Sistema
          </h1>
          <p className="text-gray-500 dark:text-gray-400">Recupere itens excluídos ou limpe definitivamente.</p>
        </div>
      </div>

      <div className="flex gap-4 border-b border-gray-200 dark:border-slate-700">
        <button
          onClick={() => changeTab('products')}
          className={`flex items-center gap-2 px-6 py-3 border-b-2 font-bold transition-all ${
            activeTab === 'products'
              ? 'border-orange-500 text-orange-600 dark:text-orange-400'
              : 'border-transparent text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'
          }`}
        >
          <Package size={20}/> Produtos
        </button>
        <button
          onClick={() => changeTab('users')}
          className={`flex items-center gap-2 px-6 py-3 border-b-2 font-bold transition-all ${
            activeTab === 'users'
              ? 'border-orange-500 text-orange-600 dark:text-orange-400'
              : 'border-transparent text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'
          }`}
        >
          <User size={20}/> Usuários
        </button>
      </div>

      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-700 overflow-hidden transition-colors">
        {loading ? (
          <div className="p-12 flex justify-center text-gray-400 dark:text-gray-500"><Loader2 className="animate-spin" size={32}/></div>
        ) : items.length === 0 ? (
          <div className="p-12 text-center text-gray-400 dark:text-gray-600 italic flex flex-col items-center gap-2">
            <Trash2 size={48} className="opacity-20"/>
            <p>A lixeira está vazia.</p>
          </div>
        ) : (
          <table className="w-full text-left">
            <thead className="bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 font-bold border-b border-red-100 dark:border-red-900/30">
              <tr>
                <th className="px-6 py-4">Item Excluído</th>
                <th className="px-6 py-4">Detalhes</th>
                <th className="px-6 py-4">Data de Exclusão</th>
                <th className="px-6 py-4 text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
              {items.map(item => (
                <tr key={item.id} className="hover:bg-gray-50 dark:hover:bg-slate-700/50 transition-colors">
                  <td className="px-6 py-4">
                    <div className="font-bold text-gray-800 dark:text-white">{item.name}</div>
                    <div className="text-xs text-gray-400 dark:text-gray-500">ID: {item.id}</div>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-300">
                    {activeTab === 'products' ? (
                       <span className="truncate max-w-[200px] block" title={item.description}>{item.description || '-'}</span>
                    ) : (
                       <div className="flex flex-col">
                         <span>{item.email}</span>
                         <span className="text-xs bg-gray-100 dark:bg-slate-700 w-fit px-1 rounded mt-1">{roleLabel(item.role)}</span>
                       </div>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">
                    {formatDateTime(item.deleted_at)}
                  </td>
                  <td className="px-6 py-4 text-right space-x-2">
                    <button
                      onClick={() => handleRestore(item)}
                      className="px-3 py-1.5 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 rounded-lg hover:bg-green-100 dark:hover:bg-green-900/40 font-bold text-xs inline-flex items-center gap-1 transition-colors"
                    >
                      <RotateCcw size={14} /> Restaurar
                    </button>
                    <button
                      onClick={() => handleHardDelete(item)}
                      className="px-3 py-1.5 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/40 font-bold text-xs inline-flex items-center gap-1 transition-colors"
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
