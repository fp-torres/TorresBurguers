import { useEffect, useState } from 'react';
import { Plus, Trash2, Edit, Search } from 'lucide-react';
import { productService, type Product } from '../../services/productService'; // Import corrigido
import ProductModal from '../../components/ProductModal';

export default function Products() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);

  useEffect(() => {
    loadProducts();
  }, []);

  async function loadProducts() {
    try {
      const data = await productService.getAll();
      setProducts(data);
    } catch (error) {
      console.error("Erro:", error);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: number) {
    if (confirm('Tem certeza?')) {
      try {
        await productService.delete(id);
        loadProducts();
      } catch (error) {
        alert('Erro ao excluir');
      }
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Cardápio</h1>
          <p className="text-gray-500">Gerencie seus hambúrgueres, bebidas e acompanhamentos</p>
        </div>
        
        <button 
          onClick={() => setIsModalOpen(true)}
          className="bg-orange-600 hover:bg-orange-700 text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-colors font-medium shadow-sm hover:shadow-md"
        >
          <Plus size={20} />
          Novo Produto
        </button>
      </div>

      <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-3 text-gray-400 w-5 h-5" />
          <input type="text" placeholder="Buscar..." className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-orange-500" />
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="px-6 py-4 text-gray-600 font-semibold text-sm">Produto</th>
              <th className="px-6 py-4 text-gray-600 font-semibold text-sm">Categoria</th>
              <th className="px-6 py-4 text-gray-600 font-semibold text-sm">Preço</th>
              <th className="px-6 py-4 text-gray-600 font-semibold text-sm">Status</th>
              <th className="px-6 py-4 text-right text-gray-600 font-semibold text-sm">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={5} className="p-8 text-center text-gray-500">Carregando...</td></tr>
            ) : products.map((product) => (
              <tr key={product.id} className="hover:bg-orange-50/50 transition-colors group">
                <td className="px-6 py-4">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-lg bg-gray-100 overflow-hidden border border-gray-200 shadow-sm">
                      {product.image ? (
                        <img src={`http://localhost:3000/uploads/${product.image}`} alt={product.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-400 text-xs">Sem foto</div>
                      )}
                    </div>
                    <div>
                      <p className="font-bold text-gray-800">{product.name}</p>
                      <p className="text-xs text-gray-500 line-clamp-1 max-w-[200px]">{product.description}</p>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <span className="bg-blue-50 text-blue-700 px-2 py-1 rounded-md text-xs font-bold uppercase border border-blue-100">{product.category}</span>
                </td>
                <td className="px-6 py-4 font-medium text-gray-700">
                  {Number(product.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                </td>
                <td className="px-6 py-4">
                  <span className={`px-2 py-1 rounded-full text-xs font-bold border ${product.available ? 'bg-green-100 text-green-700 border-green-200' : 'bg-red-100 text-red-700 border-red-200'}`}>
                    {product.available ? 'Disponível' : 'Esgotado'}
                  </span>
                </td>
                <td className="px-6 py-4 text-right flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg" title="Editar"><Edit size={18} /></button>
                  <button onClick={() => handleDelete(product.id)} className="p-2 text-red-600 hover:bg-red-50 rounded-lg" title="Excluir"><Trash2 size={18} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ProductModal 
        isOpen={isModalOpen} 
        onClose={() => setIsModalOpen(false)} 
        onSuccess={() => {
          loadProducts(); 
        }} 
      />
    </div>
  );
}