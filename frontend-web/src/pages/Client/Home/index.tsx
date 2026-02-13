import { useEffect, useState, useMemo } from 'react';
import { Search, ShoppingBag, Flame, ChevronRight, Star, Utensils, Coffee, IceCream, Plus, Clock, Trophy } from 'lucide-react'; 
import { productService, type Product } from '../../../services/productService';
import api from '../../../services/api';
import ProductModal from '../../../components/ProductModal';

// Configuração Estática dos Banners (Fallback)
const DAILY_OFFERS: Record<number, any> = {
  0: { title: "Domingo em Família 👨‍👩‍👧‍👦", subtitle: "Combos gigantes para fechar o fim de semana.", color: "from-blue-600 to-indigo-600", icon: <ShoppingBag size={48} className="text-white/20 absolute right-4 bottom-4 -rotate-12" /> },
  1: { title: "Segunda Leve 🥗", subtitle: "Opções leves e saborosas para começar a semana.", color: "from-green-600 to-emerald-600", icon: <Star size={48} className="text-white/20 absolute right-4 bottom-4" /> },
  2: { title: "Terça do Smash 🍔", subtitle: "Smash burgers a partir de R$ 19,90.", color: "from-orange-500 to-red-500", icon: <Flame size={48} className="text-white/20 absolute right-4 bottom-4" /> },
  3: { title: "Quarta do Futebol ⚽", subtitle: "Frete grátis para acompanhar o jogão.", color: "from-green-700 to-green-500", icon: <Trophy size={48} className="text-white/20 absolute right-4 bottom-4 rotate-12" /> },
  4: { title: "Quinta dos Acompanhamentos 🍟", subtitle: "Batata pela metade do preço na compra de 2 burgers.", color: "from-yellow-500 to-orange-500", icon: <Utensils size={48} className="text-white/20 absolute right-4 bottom-4" /> },
  5: { title: "Sexta do Bacon 🥓", subtitle: "Todo o cardápio de bacon com adicionais em dobro!", color: "from-red-700 to-orange-700", icon: <Flame size={48} className="text-white/20 absolute right-4 bottom-4 rotate-12" /> },
  6: { title: "Sabadou com Torres 🍻", subtitle: "Bebidas geladas e os melhores burgers.", color: "from-purple-600 to-pink-600", icon: <Coffee size={48} className="text-white/20 absolute right-4 bottom-4" /> }
};

const CATEGORIES = [
  { id: 'todos', label: 'Tudo', icon: Star },
  { id: 'hamburgueres', label: 'Burgers', icon: Utensils },
  { id: 'combos', label: 'Combos', icon: ShoppingBag },
  { id: 'bebidas', label: 'Bebidas', icon: Coffee },
  { id: 'acompanhamentos', label: 'Acomp.', icon: ShoppingBag },
  { id: 'sobremesas', label: 'Doces', icon: IceCream },
];

export default function ClientHome() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<any>(DAILY_OFFERS[0]);
  
  const [selectedCategory, setSelectedCategory] = useState('todos');
  const [searchTerm, setSearchTerm] = useState('');
  
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  useEffect(() => {
    loadCatalog();
    loadBanner();
  }, []);

  async function loadBanner() {
    // =================================================================
    // 🎛️ ÁREA DE SIMULAÇÃO (FRONTEND)
    // Para testar visualmente, descomente a linha abaixo.
    // =================================================================
    
    const simulacaoDia = null; // (Produção: Usa data real)
    // const simulacaoDia = 3; // (Teste: Força banner de Quarta)

    const todayIndex = simulacaoDia !== null ? simulacaoDia : new Date().getDay();
    
    // 1. Define o banner base
    setBanner(DAILY_OFFERS[todayIndex] || DAILY_OFFERS[0]);

    // 2. Se for Quarta (3), busca dados dinâmicos no backend
    if (todayIndex === 3) {
      try {
        const { data } = await api.get('/promotions/football');
        
        if (data && data.hasGame) {
          setBanner({
            title: "Quarta de Futebol ⚽",
            subtitle: `${data.home} x ${data.away} às ${data.time} - ${data.tournament}. Peça agora!`,
            color: "from-green-800 to-emerald-600",
            icon: <Trophy size={48} className="text-white/20 absolute right-4 bottom-4 rotate-12" />
          });
        }
      } catch (error) {
        console.log("Mantendo banner padrão.");
      }
    }
  }

  async function loadCatalog() {
    try {
      const data = await productService.getAll();
      setProducts(data.filter(p => p.available));
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  function openProductModal(product: Product) {
    setSelectedProduct(product);
    setIsModalOpen(true);
  }

  const comboProducts = useMemo(() => products.filter(p => p.category === 'combos'), [products]);
  const promoProducts = useMemo(() => products.filter(p => Number(p.price) < 30 && p.category === 'hamburgueres'), [products]);

  const mainList = products.filter(product => {
    const matchesCategory = selectedCategory === 'todos' || product.category === selectedCategory;
    const matchesSearch = product.name.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  return (
    <div className="space-y-10 pb-20 animate-in fade-in duration-500">
      
      {/* Banner Principal */}
      <div className="relative w-full h-48 sm:h-64 rounded-3xl overflow-hidden shadow-xl group">
        <div className={`absolute inset-0 bg-gradient-to-r ${banner.color} p-8 flex flex-col justify-center transition-all duration-700`}>
          <div className="relative z-10 max-w-lg">
            <span className="bg-white/20 text-white text-xs font-bold px-3 py-1 rounded-full backdrop-blur-md mb-3 inline-block shadow-sm flex items-center gap-1 w-fit">
              <Clock size={12}/> Oferta de Hoje
            </span>
            <h2 className="text-3xl sm:text-4xl font-extrabold text-white mb-2 leading-tight drop-shadow-md">{banner.title}</h2>
            <p className="text-white/95 text-sm sm:text-lg font-medium drop-shadow-sm">{banner.subtitle}</p>
            <button className="mt-6 bg-white text-gray-900 px-6 py-2.5 rounded-xl font-bold text-sm hover:scale-105 transition-transform shadow-lg flex items-center gap-2">
              Peça Agora <ChevronRight size={16}/>
            </button>
          </div>
          {banner.icon}
        </div>
      </div>

      {/* Busca */}
      <div className="relative -mt-6 mx-4">
        <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
          <Search className="h-5 w-5 text-gray-400" />
        </div>
        <input
          type="text"
          placeholder="Busque por lanche, ingrediente ou categoria..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="block w-full pl-11 pr-4 py-4 border border-gray-100 rounded-2xl bg-white shadow-lg shadow-gray-200/50 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-500 transition-all"
        />
      </div>

      {/* Seções */}
      {selectedCategory === 'todos' && !searchTerm && comboProducts.length > 0 && (
        <section>
          <div className="flex items-center justify-between px-1 mb-4">
            <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
              <ShoppingBag className="text-orange-600" size={22}/> Combos Matadores
            </h2>
            <button onClick={() => setSelectedCategory('combos')} className="text-xs font-bold text-orange-600 hover:underline">Ver todos</button>
          </div>
          <div className="flex gap-4 overflow-x-auto pb-6 no-scrollbar -mx-4 px-4">
            {comboProducts.map(product => (
              <ProductHorizontalCard key={product.id} product={product} onClick={() => openProductModal(product)} />
            ))}
          </div>
        </section>
      )}

      {selectedCategory === 'todos' && !searchTerm && promoProducts.length > 0 && (
        <section>
          <div className="flex items-center justify-between px-1 mb-4">
            <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
              <Flame className="text-red-500 fill-red-500" size={22}/> Promoções & Destaques
            </h2>
          </div>
          <div className="flex gap-4 overflow-x-auto pb-6 no-scrollbar -mx-4 px-4">
            {promoProducts.map(product => (
              <ProductHorizontalCard key={product.id} product={product} onClick={() => openProductModal(product)} isPromo />
            ))}
          </div>
        </section>
      )}

      {/* Lista Principal */}
      <section>
        <div className="flex items-center gap-2 mb-6 overflow-x-auto pb-2 no-scrollbar">
          {CATEGORIES.map(cat => {
            const Icon = cat.icon;
            const isSelected = selectedCategory === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat.id)}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold transition-all whitespace-nowrap ${isSelected ? 'bg-gray-800 text-white shadow-lg scale-105' : 'bg-white text-gray-500 border border-gray-100'}`}
              >
                <Icon size={16} className={isSelected ? 'text-orange-400' : 'text-gray-400'} />
                {cat.label}
              </button>
            )
          })}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {loading ? (
             [1,2,3].map(i => <div key={i} className="h-32 bg-gray-200 rounded-2xl animate-pulse"></div>)
          ) : mainList.length === 0 ? (
            <div className="col-span-full text-center py-20 text-gray-400">
              <p>Nenhum produto encontrado nesta categoria.</p>
            </div>
          ) : (
            mainList.map(product => (
              <div 
                key={product.id} 
                onClick={() => openProductModal(product)}
                className="bg-white p-4 rounded-3xl border border-gray-100 shadow-sm hover:shadow-xl transition-all cursor-pointer group flex flex-row gap-4 items-center"
              >
                <div className="w-24 h-24 bg-gray-50 rounded-2xl overflow-hidden shrink-0">
                  {product.image ? (
                    <img src={`http://localhost:3000/uploads/${product.image}`} className="w-full h-full object-cover" />
                  ) : <div className="w-full h-full flex items-center justify-center text-gray-300"><Utensils/></div>}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-gray-800 line-clamp-1">{product.name}</h3>
                  <p className="text-xs text-gray-500 line-clamp-2 my-1">{product.description}</p>
                  <div className="flex justify-between items-center mt-2">
                    <span className="font-bold text-lg text-gray-900">{Number(product.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</span>
                    <button className="bg-orange-100 text-orange-700 p-1.5 rounded-lg hover:bg-orange-200 transition-colors"><Plus size={18}/></button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <ProductModal product={selectedProduct} isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />
    </div>
  );
}

function ProductHorizontalCard({ product, onClick, isPromo }: { product: Product, onClick: () => void, isPromo?: boolean }) {
  return (
    <div 
      onClick={onClick}
      className="min-w-[260px] max-w-[260px] bg-white p-4 rounded-2xl border border-gray-100 shadow-sm cursor-pointer hover:shadow-md transition-all group relative overflow-hidden"
    >
      {isPromo && <span className="absolute top-0 right-0 bg-red-500 text-white text-[10px] font-bold px-3 py-1 rounded-bl-xl z-10">OFERTA</span>}
      
      <div className="h-32 bg-gray-50 rounded-xl mb-3 overflow-hidden relative">
         {product.image ? (
            <img src={`http://localhost:3000/uploads/${product.image}`} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" />
         ) : <div className="w-full h-full flex items-center justify-center text-gray-300"><Utensils/></div>}
      </div>
      
      <h3 className="font-bold text-gray-800 line-clamp-1">{product.name}</h3>
      <p className="text-xs text-gray-500 line-clamp-1 mb-3">{product.description}</p>
      
      <div className="flex justify-between items-center">
        <span className="font-extrabold text-lg text-gray-900">
          {Number(product.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
        </span>
        <button className="bg-orange-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-orange-700 transition-colors shadow-lg shadow-orange-200">
          Eu quero
        </button>
      </div>
    </div>
  )
}