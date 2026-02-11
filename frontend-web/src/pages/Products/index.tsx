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
  { id: 'lixeira', label: 'Lixeira', icon: Trash2 }, // <--- NOVA ABA
];

export default function Products() {
  const [products, setProducts] = useState<Product[]>([]);
  const [deletedProducts, setDeletedProducts] = useState<Product[]>([]); // Lista da Lixeira
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
      // Endpoint novo que você deve criar no controller: GET /products/trash
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
      const formData = new FormData();
      formData.append('available', String(!product.available));
      await productService.update(product.id, formData);
      toast.success(`Status atualizado!`);
      loadProducts();
    } catch { toast.error('Erro ao atualizar.'); }
  }

  // Lógica de Exclusão (Soft Delete)
  function requestDelete(product: Product) {
    setConfirmMessage({
      title: 'Mover para Lixeira?',
      desc: `O produto "${product.name}" deixará de aparecer no cardápio, mas poderá ser recuperado depois.`,
      confirmLabel: 'Mover para Lixeira',
      isDestructive: true
    });
    setActionToConfirm(() => async () => {
      try {
        await api.delete(`/products/${product.id}`); // Soft Delete
        toast.success('Produto movido para a lixeira.');
        loadProducts();
        loadDeletedProducts();
      } catch { toast.error('Erro ao excluir.'); }
    });
    setConfirmOpen(true);
  }

  // Lógica de Restauração
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

  // Lógica de Exclusão Permanente
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
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Cardápio</h1>
          <p className="text-gray-500">Gerencie seus produtos e estoque.</p>
        </div>
        {activeTab !== 'lixeira' && (
          <button onClick={handleOpenCreate} className="bg-orange-600 text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 hover:bg-orange-700 transition-all shadow-lg shadow-orange-200">
            <Plus size={20} /> Novo Produto
          </button>
        )}
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 shrink-0">
        <div className="flex overflow-x-auto p-2 border-b border-gray-100 custom-scrollbar gap-2">
          {CATEGORIES.map(cat => (
            <button
              key={cat.id}
              onClick={() => setActiveTab(cat.id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-sm whitespace-nowrap transition-all ${
                activeTab === cat.id 
                  ? 'bg-orange-50 text-orange-600 shadow-sm border border-orange-100' 
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
              }`}
            >
              <cat.icon size={18} />
              {cat.label}
              <span className={`ml-1 text-xs px-2 py-0.5 rounded-full ${activeTab === cat.id ? 'bg-orange-200 text-orange-800' : 'bg-gray-100 text-gray-500'}`}>
                {cat.id === 'todos' ? products.length : cat.id === 'lixeira' ? deletedProducts.length : products.filter(p => p.category === cat.id).length}
              </span>
            </button>
          ))}
        </div>

        <div className="p-4 bg-gray-50 flex gap-3 items-center">
          <Search className="text-gray-400" />
          <input 
            placeholder={activeTab === 'lixeira' ? "Buscar na lixeira..." : "Buscar produto..."} 
            className="bg-transparent outline-none flex-1 text-sm font-medium text-gray-700 placeholder-gray-400"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden flex-1 flex flex-col">
        <div className="overflow-auto custom-scrollbar flex-1">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 text-gray-500 font-medium sticky top-0 z-10 shadow-sm">
              <tr>
                <th className="p-4 w-[40%]">Produto</th>
                {activeTab !== 'lixeira' && <th className="p-4">Categoria</th>}
                <th className="p-4">Preço</th>
                {activeTab !== 'lixeira' && <th className="p-4 text-center">Status</th>}
                <th className="p-4 text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredList.map(product => (
                <tr key={product.id} className={`transition-colors group ${activeTab === 'lixeira' ? 'opacity-60 bg-red-50/30' : 'hover:bg-gray-50'}`}>
                  <td className="p-4">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-gray-100 rounded-lg overflow-hidden shrink-0 relative border border-gray-200">
                        {product.image ? (
                          <img src={`http://localhost:3000/uploads/${product.image}`} className="w-full h-full object-cover grayscale" />
                        ) : (
                          <div className="flex items-center justify-center h-full text-gray-400"><PackageX size={20}/></div>
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="font-bold text-gray-800 truncate">{product.name}</p>
                        <p className="text-xs text-gray-500 truncate max-w-[250px]">{product.description}</p>
                      </div>
                    </div>
                  </td>
                  
                  {activeTab !== 'lixeira' && (
                    <td className="p-4"><span className="bg-blue-50 text-blue-600 px-2 py-1 rounded-md text-xs font-bold uppercase">{product.category}</span></td>
                  )}

                  <td className="p-4 font-bold text-gray-700">{Number(product.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</td>
                  
                  {activeTab !== 'lixeira' && (
                    <td className="p-4 text-center">
                      <button onClick={() => toggleAvailability(product)} className={`px-3 py-1.5 rounded-full text-xs font-bold flex items-center justify-center gap-1.5 mx-auto w-28 border ${product.available ? 'bg-green-50 text-green-700 border-green-200' : 'bg-red-50 text-red-600 border-red-200'}`}>
                        {product.available ? <><CheckCircle2 size={14}/> Disponível</> : <><AlertTriangle size={14}/> Esgotado</>}
                      </button>
                    </td>
                  )}
                  
                  <td className="p-4 text-right">
                    <div className="flex justify-end gap-2">
                      {activeTab === 'lixeira' ? (
                        <>
                          <button onClick={() => requestRestore(product)} className="p-2 text-green-600 bg-green-50 hover:bg-green-100 rounded-lg transition-colors" title="Restaurar">
                            <RotateCcw size={18} />
                          </button>
                          <button onClick={() => requestPermanentDelete(product)} className="p-2 text-white bg-red-500 hover:bg-red-600 rounded-lg transition-colors" title="Excluir Definitivamente">
                            <XCircle size={18} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => handleOpenEdit(product)} className="p-2 hover:bg-blue-50 text-blue-600 rounded-lg"><Edit2 size={18} /></button>
                          <button onClick={() => requestDelete(product)} className="p-2 hover:bg-red-50 text-red-600 rounded-lg"><Trash2 size={18} /></button>
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