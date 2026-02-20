import { useState, useEffect, useMemo } from 'react';
import { Plus, Edit2, Trash2, Search, PackageX, CheckCircle2, AlertTriangle, Utensils, Coffee, IceCream, Box, Grid, RotateCcw, XCircle } from 'lucide-react';
import { productService, type Product } from '../../services/productService';
import CreateProductModal from '../../components/CreateProductModal';
import ConfirmModal from '../../components/ConfirmModal';
import toast from 'react-hot-toast'; 
import api from '../../services/api';

const CATEGORIES = [
  { id: 'todos', label: 'Todos', icon: Grid },
  { id: 'hamburgueres', label: 'Hambúrgueres', icon: Utensils },
  { id: 'combos', label: 'Combos', icon: Box },
  { id: 'acompanhamentos', label: 'Acomp.', icon: Utensils },
  { id: 'bebidas', label: 'Bebidas', icon: Coffee },
  { id: 'sobremesas', label: 'Sobremesas', icon: IceCream },
  { id: 'lixeira', label: 'Lixeira', icon: Trash2 },
];

export default function Products() {
  const [products, setProducts] = useState<Product[]>([]);
  const [deletedProducts, setDeletedProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [productToEdit, setProductToEdit] = useState<Product | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState('todos');

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [actionToConfirm, setActionToConfirm] = useState<() => void>(() => {});
  const [confirmMessage, setConfirmMessage] = useState({ title: '', desc: '', confirmLabel: 'Sim, confirmar', isDestructive: true });

  useEffect(() => {
    loadProducts();
    loadDeletedProducts();
  }, []);

  async function loadProducts() {
    try {
      const data = await productService.getAll();
      setProducts(data);
    } catch { toast.error("Erro ao carregar produtos"); } finally { setLoading(false); }
  }

  async function loadDeletedProducts() {
    try {
      const { data } = await api.get('/products/trash'); 
      setDeletedProducts(data);
    } catch { console.log("Erro ao carregar lixeira"); }
  }

  function handleOpenCreate() {
    setProductToEdit(null);
    setIsModalOpen(true);
  }

  function handleOpenEdit(product: Product) {
    setProductToEdit(product);
    setIsModalOpen(true);
  }

  async function toggleAvailability(product: Product) {
    try {
      const newStatus = !product.available;

      setProducts(prevProducts => 
        prevProducts.map(p => p.id === product.id ? { ...p, available: newStatus } : p)
      );

      const formData = new FormData();
      formData.append('available', String(newStatus));
      await productService.update(product.id, formData);
      
      toast.success(newStatus ? 'Produto Ativado!' : 'Produto Pausado!');
    } catch { 
      toast.error('Erro ao atualizar.');
      loadProducts();
    }
  }

  function requestDelete(product: Product) {
    setConfirmMessage({
      title: 'Mover para Lixeira?',
      desc: `O produto "${product.name}" deixará de aparecer no cardápio, mas poderá ser recuperado depois.`,
      confirmLabel: 'Mover para Lixeira',
      isDestructive: true
    });
    setActionToConfirm(() => async () => {
      try {
        await api.delete(`/products/${product.id}`);
        toast.success('Produto movido para a lixeira.');
        loadProducts();
        loadDeletedProducts();
      } catch { toast.error('Erro ao excluir.'); }
    });
    setConfirmOpen(true);
  }

  function requestRestore(product: Product) {
    setConfirmMessage({
      title: 'Restaurar Produto?',
      desc: `O produto "${product.name}" voltará para o cardápio (como Indisponível).`,
      confirmLabel: 'Sim, Restaurar',
      isDestructive: false
    });
    setActionToConfirm(() => async () => {
      try {
        await api.patch(`/products/${product.id}/restore`);
        toast.success('Produto restaurado!');
        loadProducts();
        loadDeletedProducts();
      } catch { toast.error('Erro ao restaurar.'); }
    });
    setConfirmOpen(true);
  }

  function requestPermanentDelete(product: Product) {
    setConfirmMessage({
      title: 'Excluir Permanentemente?',
      desc: `ATENÇÃO: "${product.name}" será apagado para sempre. Histórico de vendas pode ser afetado.`,
      confirmLabel: 'Apagar para Sempre',
      isDestructive: true
    });
    setActionToConfirm(() => async () => {
      try {
        await api.delete(`/products/${product.id}/permanent`);
        toast.success('Produto excluído definitivamente.');
        loadDeletedProducts();
      } catch { toast.error('Erro ao excluir.'); }
    });
    setConfirmOpen(true);
  }

  const currentList = activeTab === 'lixeira' ? deletedProducts : products;

  const filteredList = useMemo(() => {
    return currentList.filter(p => {
      const matchesSearch = p.name.toLowerCase().includes(searchTerm.toLowerCase());
      if (activeTab === 'lixeira') return matchesSearch;
      const matchesCategory = activeTab === 'todos' || p.category === activeTab;
      return matchesSearch && matchesCategory;
    });
  }, [currentList, searchTerm, activeTab]);

  return (
    <div className="space-y-6 pb-20 h-full flex flex-col">
      {/* HEADER */}
      <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-700 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 shrink-0 transition-colors">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white">Cardápio</h1>
          <p className="text-gray-500 dark:text-gray-400">Gerencie seus produtos e estoque.</p>
        </div>
        {activeTab !== 'lixeira' && (
          <button onClick={handleOpenCreate} className="bg-orange-600 text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 hover:bg-orange-700 transition-all shadow-lg shadow-orange-200 dark:shadow-none">
            <Plus size={20} /> Novo Produto
          </button>
        )}
      </div>

      {/* SEARCH E FILTROS */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-700 shrink-0 transition-colors">
        <div className="flex overflow-x-auto p-2 border-b border-gray-100 dark:border-slate-700 custom-scrollbar gap-2">
          {CATEGORIES.map(cat => (
            <button
              key={cat.id}
              onClick={() => setActiveTab(cat.id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-sm whitespace-nowrap transition-all ${
                activeTab === cat.id 
                  ? 'bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 shadow-sm border border-orange-100 dark:border-orange-800' 
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-slate-700 hover:text-gray-700 dark:hover:text-white'
              }`}
            >
              <cat.icon size={18} />
              {cat.label}
              <span className={`ml-1 text-xs px-2 py-0.5 rounded-full ${
                activeTab === cat.id 
                  ? 'bg-orange-200 dark:bg-orange-800 text-orange-800 dark:text-orange-200' 
                  : 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-gray-300'
              }`}>
                {cat.id === 'todos' ? products.length : cat.id === 'lixeira' ? deletedProducts.length : products.filter(p => p.category === cat.id).length}
              </span>
            </button>
          ))}
        </div>

        <div className="p-4 bg-gray-50 dark:bg-slate-900/50 flex gap-3 items-center">
          <Search className="text-gray-400 dark:text-gray-500" />
          <input 
            placeholder={activeTab === 'lixeira' ? "Buscar na lixeira..." : "Buscar produto..."} 
            className="bg-transparent outline-none flex-1 text-sm font-medium text-gray-700 dark:text-white placeholder-gray-400 dark:placeholder-gray-600"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
        </div>
      </div>

      {/* TABELA DE PRODUTOS */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-700 overflow-hidden flex-1 flex flex-col transition-colors">
        <div className="overflow-auto custom-scrollbar flex-1">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 dark:bg-slate-900 text-gray-500 dark:text-gray-400 font-medium sticky top-0 z-10 shadow-sm">
              <tr>
                <th className="p-4 w-[40%]">Produto</th>
                {activeTab !== 'lixeira' && <th className="p-4">Categoria</th>}
                <th className="p-4">Preço</th>
                {activeTab !== 'lixeira' && <th className="p-4 text-center">Status</th>}
                <th className="p-4 text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
              {filteredList.map(product => (
                <tr key={product.id} className={`transition-colors group ${
                  activeTab === 'lixeira' || !product.available 
                    ? 'bg-gray-50 dark:bg-slate-800/50' 
                    : 'hover:bg-gray-50 dark:hover:bg-slate-700'
                }`}>
                  <td className="p-4">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-gray-100 dark:bg-slate-700 rounded-lg overflow-hidden shrink-0 relative border border-gray-200 dark:border-slate-600">
                        {product.image ? (
                          <img 
                            src={`http://localhost:3000/uploads/${product.image}`} 
                            className={`w-full h-full object-cover transition-all duration-300 ${(!product.available || activeTab === 'lixeira') ? 'grayscale opacity-75' : ''}`} 
                          />
                        ) : (
                          <div className="flex items-center justify-center h-full text-gray-400 dark:text-gray-500"><PackageX size={20}/></div>
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className={`font-bold truncate ${
                          !product.available || activeTab === 'lixeira' 
                            ? 'text-gray-500 dark:text-gray-500' 
                            : 'text-gray-800 dark:text-white'
                        }`}>
                          {product.name}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-[250px]">{product.description}</p>
                      </div>
                    </div>
                  </td>
                  
                  {activeTab !== 'lixeira' && (
                    <td className="p-4">
                      <span className="bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 px-2 py-1 rounded-md text-xs font-bold uppercase">
                        {product.category}
                      </span>
                    </td>
                  )}

                  <td className="p-4 font-bold text-gray-700 dark:text-gray-200">
                    {Number(product.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                  </td>
                  
                  {activeTab !== 'lixeira' && (
                    <td className="p-4 text-center">
                      <button 
                        onClick={() => toggleAvailability(product)} 
                        className={`px-3 py-1.5 rounded-full text-xs font-bold flex items-center justify-center gap-1.5 mx-auto w-28 border transition-all active:scale-95 ${
                          product.available 
                            ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 hover:border-red-200 dark:hover:border-red-800' 
                            : 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800 hover:bg-green-50 dark:hover:bg-green-900/20 hover:text-green-700 dark:hover:text-green-400 hover:border-green-200 dark:hover:border-green-800'
                        }`}
                      >
                        {product.available ? <><CheckCircle2 size={14}/> Disponível</> : <><AlertTriangle size={14}/> Esgotado</>}
                      </button>
                    </td>
                  )}
                  
                  <td className="p-4 text-right">
                    <div className="flex justify-end gap-2">
                      {activeTab === 'lixeira' ? (
                        <>
                          <button onClick={() => requestRestore(product)} className="p-2 text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 hover:bg-green-100 dark:hover:bg-green-900/40 rounded-lg transition-colors" title="Restaurar">
                            <RotateCcw size={18} />
                          </button>
                          <button onClick={() => requestPermanentDelete(product)} className="p-2 text-white bg-red-500 hover:bg-red-600 rounded-lg transition-colors" title="Excluir Definitivamente">
                            <XCircle size={18} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => handleOpenEdit(product)} className="p-2 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded-lg">
                            <Edit2 size={18} />
                          </button>
                          <button onClick={() => requestDelete(product)} className="p-2 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg">
                            <Trash2 size={18} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <CreateProductModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} onSuccess={() => { loadProducts(); toast.success('Salvo!'); }} productToEdit={productToEdit} />
      <ConfirmModal isOpen={confirmOpen} onClose={() => setConfirmOpen(false)} onConfirm={actionToConfirm} title={confirmMessage.title} message={confirmMessage.desc} isDestructive={confirmMessage.isDestructive} confirmLabel={confirmMessage.confirmLabel} />
    </div>
  );
}