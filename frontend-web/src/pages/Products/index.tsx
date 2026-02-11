import { useState, useEffect } from 'react';
import { Plus, Edit2, Trash2, Search, PackageX, CheckCircle2, AlertTriangle } from 'lucide-react';
import { productService, type Product } from '../../services/productService';
import CreateProductModal from '../../components/CreateProductModal';
import ConfirmModal from '../../components/ConfirmModal';
import toast from 'react-hot-toast'; 

export default function Products() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [productToEdit, setProductToEdit] = useState<Product | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  // Estados para o Modal de Confirmação
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [actionToConfirm, setActionToConfirm] = useState<() => void>(() => {});
  const [confirmMessage, setConfirmMessage] = useState({ title: '', desc: '' });

  useEffect(() => {
    loadProducts();
  }, []);

  async function loadProducts() {
    try {
      const data = await productService.getAll();
      setProducts(data);
    } catch {
      toast.error("Erro ao carregar produtos");
    } finally {
      setLoading(false);
    }
  }

  function handleOpenCreate() {
    setProductToEdit(null);
    setIsModalOpen(true);
  }

  function handleOpenEdit(product: Product) {
    setProductToEdit(product);
    setIsModalOpen(true);
  }

  // --- ALTERAR STATUS ---
  async function toggleAvailability(product: Product) {
    try {
      const formData = new FormData();
      const newStatus = !product.available;
      formData.append('available', String(newStatus));
      
      await productService.update(product.id, formData);
      await loadProducts();
      toast.success(`Produto ${newStatus ? 'ativado' : 'desativado'} com sucesso!`);
    } catch {
      toast.error('Erro ao atualizar status.');
    }
  }

  // --- PREPARAR EXCLUSÃO ---
  function requestDelete(product: Product) {
    if (product.available) {
      setConfirmMessage({
        title: 'Desativar Produto?',
        desc: `O produto "${product.name}" está visível no cardápio. Deseja ocultá-lo?`
      });
      setActionToConfirm(() => () => toggleAvailability(product));
    } else {
      setConfirmMessage({
        title: 'Excluir Permanentemente?',
        desc: `Tem certeza que deseja apagar "${product.name}"? Se houver vendas vinculadas, ele será apenas arquivado.`
      });
      setActionToConfirm(() => () => executeDelete(product));
    }
    setConfirmOpen(true);
  }

  // --- EXECUTAR EXCLUSÃO ---
  async function executeDelete(product: Product) {
    try {
      await productService.deletePermanent(product.id);
      
      setTimeout(async () => {
        const updatedList = await productService.getAll();
        const stillExists = updatedList.find(p => p.id === product.id);
        
        if (stillExists) {
          toast('Produto arquivado (histórico de vendas preservado)', { icon: '📁' });
        } else {
          toast.success('Produto excluído permanentemente!');
          setProducts(updatedList);
        }
      }, 500);
    } catch (error) {
      toast.error('Erro ao processar exclusão.');
    }
  }

  const filteredProducts = products.filter(p => p.name.toLowerCase().includes(searchTerm.toLowerCase()));

  return (
    <div className="space-y-6 pb-20">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Cardápio</h1>
          <p className="text-gray-500">Gerencie seus produtos e estoque.</p>
        </div>
        <button onClick={handleOpenCreate} className="bg-orange-600 text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 hover:bg-orange-700 transition-all shadow-lg shadow-orange-200">
          <Plus size={20} /> Novo Produto
        </button>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-4 border-b border-gray-100 bg-gray-50 flex gap-3">
          <Search className="text-gray-400" />
          <input 
            placeholder="Buscar produto..." 
            className="bg-transparent outline-none flex-1 text-sm"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 text-gray-500 font-medium">
              <tr>
                <th className="p-4">Produto</th>
                <th className="p-4">Categoria</th>
                <th className="p-4">Preço</th>
                <th className="p-4 text-center">Estoque</th>
                <th className="p-4 text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredProducts.map(product => (
                <tr key={product.id} className={`transition-colors group ${!product.available ? 'bg-gray-50 opacity-75' : 'hover:bg-gray-50'}`}>
                  <td className="p-4 flex items-center gap-4">
                    <div className="w-12 h-12 bg-gray-200 rounded-lg overflow-hidden shrink-0 relative">
                      {product.image ? (
                        <img src={`http://localhost:3000/uploads/${product.image}`} className="w-full h-full object-cover" />
                      ) : (
                        <div className="flex items-center justify-center h-full text-gray-400"><PackageX size={20}/></div>
                      )}
                    </div>
                    <div>
                      <p className={`font-bold ${product.available ? 'text-gray-800' : 'text-gray-500 line-through'}`}>{product.name}</p>
                      <p className="text-xs text-gray-500 truncate max-w-[200px]">{product.description}</p>
                    </div>
                  </td>
                  <td className="p-4"><span className="bg-blue-50 text-blue-600 px-2 py-1 rounded-md text-xs font-bold uppercase">{product.category}</span></td>
                  <td className="p-4 font-medium text-gray-800">{Number(product.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</td>
                  <td className="p-4 text-center">
                    <button 
                      onClick={() => toggleAvailability(product)}
                      className={`px-3 py-1.5 rounded-full text-xs font-bold flex items-center justify-center gap-1.5 mx-auto w-28 border transition-all ${
                        product.available 
                          ? 'bg-green-100 text-green-700 border-green-200 hover:bg-red-100 hover:text-red-700' 
                          : 'bg-red-100 text-red-700 border-red-200 hover:bg-green-100 hover:text-green-700'
                      }`}
                    >
                      {product.available ? <><CheckCircle2 size={14}/> Disponível</> : <><AlertTriangle size={14}/> Esgotado</>}
                    </button>
                  </td>
                  <td className="p-4 text-right">
                    <div className="flex justify-end gap-2">
                      <button onClick={() => handleOpenEdit(product)} className="p-2 hover:bg-blue-50 text-blue-600 rounded-lg transition-colors"><Edit2 size={18} /></button>
                      <button onClick={() => requestDelete(product)} className="p-2 hover:bg-red-50 text-red-600 rounded-lg transition-colors"><Trash2 size={18} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <CreateProductModal 
        isOpen={isModalOpen} 
        onClose={() => setIsModalOpen(false)} 
        onSuccess={() => { loadProducts(); toast.success('Produto salvo!'); }} 
        productToEdit={productToEdit} 
      />

      <ConfirmModal 
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={actionToConfirm}
        title={confirmMessage.title}
        message={confirmMessage.desc}
        isDestructive
        confirmLabel="Sim, confirmar"
      />
    </div>
  );
}