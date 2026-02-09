import { useEffect, useState } from 'react';
import { Search, Star } from 'lucide-react';
import { productService, type Product } from '../../../services/productService';

export default function ClientHome() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState('todos');

  const categories = [
    { id: 'todos', label: 'Tudo' },
    { id: 'hamburgueres', label: 'Burgers' },
    { id: 'bebidas', label: 'Bebidas' },
    { id: 'acompanhamentos', label: 'Acomp.' },
    { id: 'sobremesas', label: 'Doces' },
  ];

  useEffect(() => {
    loadCatalog();
  }, []);

  async function loadCatalog() {
    try {
      // Reutilizamos o mesmo service do Admin!
      const data = await productService.getAll();
      // Filtramos apenas o que está disponível
      setProducts(data.filter(p => p.available));
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  const filteredProducts = selectedCategory === 'todos' 
    ? products 
    : products.filter(p => p.category === selectedCategory);

  return (
    <div className="space-y-6">
      {/* Banner de Boas Vindas */}
      <div className="bg-gradient-to-r from-orange-600 to-red-600 rounded-2xl p-6 text-white shadow-lg mb-8">
        <h1 className="text-2xl font-bold mb-2">Fome de quê hoje? 😋</h1>
        <p className="opacity-90 text-sm mb-4">Os melhores burgers artesanais da região, entregues quentinhos.</p>
        
        {/* Barra de Busca */}
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-3 text-gray-400 w-5 h-5" />
          <input 
            type="text" 
            placeholder="Buscar lanche..." 
            className="w-full pl-10 pr-4 py-2.5 rounded-xl text-gray-800 focus:ring-2 focus:ring-yellow-400 outline-none"
          />
        </div>
      </div>

      {/* Categorias (Scroll Horizontal no Mobile) */}
      <div className="flex gap-3 overflow-x-auto pb-2 no-scrollbar">
        {categories.map(cat => (
          <button
            key={cat.id}
            onClick={() => setSelectedCategory(cat.id)}
            className={`
              whitespace-nowrap px-4 py-2 rounded-full text-sm font-bold transition-all
              ${selectedCategory === cat.id 
                ? 'bg-orange-600 text-white shadow-md' 
                : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'}
            `}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Lista de Produtos (Grid Responsivo) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {loading ? (
          <p className="text-center col-span-full py-10 text-gray-400">Carregando cardápio...</p>
        ) : filteredProducts.map(product => (
          <div key={product.id} className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm hover:shadow-md transition-all flex gap-4 cursor-pointer group">
            {/* Imagem */}
            <div className="w-24 h-24 bg-gray-100 rounded-xl flex-shrink-0 overflow-hidden">
              {product.image ? (
                <img src={`http://localhost:3000/uploads/${product.image}`} className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xs text-gray-400">Sem foto</div>
              )}
            </div>

            {/* Infos */}
            <div className="flex-1 flex flex-col justify-between">
              <div>
                <h3 className="font-bold text-gray-800 line-clamp-1">{product.name}</h3>
                <p className="text-xs text-gray-500 line-clamp-2 mt-1">{product.description}</p>
              </div>
              <div className="flex justify-between items-end mt-2">
                <span className="font-bold text-green-700">
                  {Number(product.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                </span>
                <button className="bg-gray-100 text-gray-600 p-2 rounded-lg hover:bg-orange-600 hover:text-white transition-colors">
                  <span className="text-xs font-bold">Adicionar</span>
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}