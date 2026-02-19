import { useState, useEffect, useMemo } from 'react';
import { Search, ShoppingBag, Flame, ChevronRight, Star, Utensils, Coffee, IceCream, Plus, Clock, Trophy, Bike, Lock, Settings } from 'lucide-react'; 
import { productService, type Product } from '../../../services/productService';
import api from '../../../services/api';
import ProductModal from '../../../components/ProductModal';

const API_URL = 'http://localhost:3000'; 

// =================================================================
// 🎛️ PAINEL DE SIMULAÇÃO (CONTROLE TOTAL AQUI)
// =================================================================
const TEST_DAY: number | null = null; 
const FORCE_GAME_DAY = false; 
// =================================================================

const DAILY_OFFERS: Record<number, any> = {
  0: { 
    title: "Domingo em Família 👨‍👩‍👧‍👦", 
    subtitle: "Combos gigantes para fechar o fim de semana com chave de ouro.", 
    image: "https://images.unsplash.com/photo-1594212699903-ec8a3eca50f5?q=80&w=1600&auto=format&fit=crop", 
    icon: <ShoppingBag size={48} className="text-white/80" />,
    isClosed: false
  },
  1: { 
    title: "Loja Fechada 🔒", 
    subtitle: "Segunda é dia de pausa! Recarregando as energias para te entregar o melhor sabor amanhã.", 
    image: "https://images.unsplash.com/photo-1559339352-11d035aa65de?q=80&w=1600&auto=format&fit=crop", 
    icon: <Lock size={48} className="text-white/80" />,
    isClosed: true 
  },
  2: { 
    title: "Terça do Smash 🍔", 
    subtitle: "O verdadeiro sabor da chapa. Smashs a partir de R$ 19,90.", 
    image: "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?q=80&w=1600&auto=format&fit=crop", 
    icon: <Flame size={48} className="text-white/80" />,
    isClosed: false
  },
  3: { 
    title: "Quarta do Delivery 🛵", 
    subtitle: "Hoje a entrega é por nossa conta! Peça no conforto de casa.", 
    image: "https://images.unsplash.com/photo-1550989460-0adf9ea622e2?q=80&w=1600&auto=format&fit=crop", 
    icon: <Bike size={48} className="text-white/80" />,
    isClosed: false
  },
  4: { 
    title: "Quinta da Batata 🍟", 
    subtitle: "Comprou burger, a batata sai pela metade do preço.", 
    image: "https://images.unsplash.com/photo-1541592106381-b31e9677c0e5?q=80&w=1600&auto=format&fit=crop", 
    icon: <Utensils size={48} className="text-white/80" />,
    isClosed: false
  },
  5: { 
    title: "Sextou com Bacon 🥓", 
    subtitle: "Tudo fica melhor com bacon. Adicionais em dobro hoje!", 
    image: "https://images.unsplash.com/photo-1607013251379-e6eecfffe234?q=80&w=1600&auto=format&fit=crop", 
    icon: <Flame size={48} className="text-white/80" />,
    isClosed: false
  },
  6: { 
    title: "Sabadou com Torres 🍻", 
    subtitle: "Chame os amigos! Balde de Cerveja + Combo Monster.", 
    image: "https://images.unsplash.com/photo-1598182198871-d3f4ab4fd181?q=80&w=1600&auto=format&fit=crop", 
    icon: <Coffee size={48} className="text-white/80" />,
    isClosed: false
  }
};

// --- CORREÇÃO: Ordem das Categorias Ajustada ---
const CATEGORIES = [
  { id: 'combos', label: 'Combos', icon: ShoppingBag },
  { id: 'hamburgueres', label: 'Burgers', icon: Utensils },
  { id: 'acompanhamentos', label: 'Acomp.', icon: Utensils }, // Usando Utensils para diferenciar de Combos
  { id: 'bebidas', label: 'Bebidas', icon: Coffee },
  { id: 'sobremesas', label: 'Doces', icon: IceCream },
  { id: 'todos', label: 'Tudo', icon: Star },
];

export default function ClientHome() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  
  const [banner, setBanner] = useState<any>(DAILY_OFFERS[0]);
  const [selectedCategory, setSelectedCategory] = useState('todos');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const isTestMode = TEST_DAY !== null || FORCE_GAME_DAY;

  useEffect(() => {
    loadCatalog();
    loadBanner();
  }, []);

  async function loadBanner() {
    const todayIndex = TEST_DAY !== null ? TEST_DAY : new Date().getDay();
    
    let currentBanner = DAILY_OFFERS[todayIndex] || DAILY_OFFERS[0];
    
    if ((todayIndex === 3 || todayIndex === 0) && !currentBanner.isClosed) {
      if (FORCE_GAME_DAY) {
         currentBanner = {
            title: "Hoje tem Jogão! ⚽",
            subtitle: `SIMULAÇÃO: Flamengo x Vasco às 21:30 - Brasileirão.`,
            image: "https://images.unsplash.com/photo-1574629810360-7efbbe195018?q=80&w=1600&auto=format&fit=crop", 
            icon: <Trophy size={48} className="text-yellow-400 animate-bounce" />,
            isClosed: false
         };
      } else {
        try {
          const { data } = await api.get('/promotions/football');
          if (data && data.hasGame) {
            currentBanner = {
              title: "Hoje tem Jogão! ⚽",
              subtitle: `${data.home} x ${data.away} às ${data.time} - ${data.tournament}.`,
              image: "https://images.unsplash.com/photo-1574629810360-7efbbe195018?q=80&w=1600&auto=format&fit=crop", 
              icon: <Trophy size={48} className="text-yellow-400 animate-bounce" />,
              isClosed: false
            };
          }
        } catch (error) {
          console.log("Sem jogo hoje ou erro na API.");
        }
      }
    }

    setBanner(currentBanner);
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
    if (banner.isClosed) return;
    setSelectedProduct(product);
    setIsModalOpen(true);
  }

  function scrollToMenu() {
    const element = document.getElementById('menu-section');
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  }

  const comboProducts = useMemo(() => products.filter(p => p.category === 'combos'), [products]);
  const promoProducts = useMemo(() => products.filter(p => Number(p.price) < 30 && p.category === 'hamburgueres'), [products]);

  const mainList = products.filter(product => {
    const matchesCategory = selectedCategory === 'todos' || product.category === selectedCategory;
    const matchesSearch = product.name.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  return (
    <div className="space-y-10 pb-20 animate-in fade-in duration-500 relative">
      
      {isTestMode && (
        <div className="bg-yellow-100 border-l-4 border-yellow-500 text-yellow-700 p-2 text-xs font-bold text-center mx-4 rounded mb-[-20px] shadow-sm flex items-center justify-center gap-2">
          <Settings size={14}/> 
          MODO SIMULAÇÃO ATIVO: Dia {TEST_DAY} {FORCE_GAME_DAY ? '(Com Jogo)' : ''}
        </div>
      )}

      {/* --- BANNER PRINCIPAL --- */}
      <div className="relative w-full h-64 sm:h-80 rounded-3xl overflow-hidden shadow-2xl group mx-auto max-w-[98%] mt-4">
        
        <img 
          src={banner.image} 
          alt={banner.title}
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-1000 group-hover:scale-105"
        />
        
        <div className={`absolute inset-0 ${banner.isClosed ? 'bg-black/80' : 'bg-gradient-to-r from-black/90 via-black/50 to-transparent'}`}></div>

        <div className="absolute inset-0 p-6 sm:p-12 flex flex-col justify-center">
          <div className="relative z-10 max-w-xl">
            
            <span className={`${banner.isClosed ? 'bg-red-600' : 'bg-orange-600'} text-white text-xs font-bold px-3 py-1 rounded-full mb-4 inline-flex items-center gap-1 shadow-lg`}>
              {banner.isClosed ? <Lock size={12}/> : <Clock size={12}/>} 
              {banner.isClosed ? 'LOJA FECHADA' : 'Oferta de Hoje'}
            </span>
            
            <h2 className="text-3xl sm:text-5xl font-extrabold text-white mb-3 leading-tight drop-shadow-lg">
              {banner.title}
            </h2>
            <p className="text-gray-200 text-sm sm:text-xl font-medium drop-shadow-md max-w-md mb-6">
              {banner.subtitle}
            </p>
            
            <button 
              onClick={scrollToMenu}
              className={`px-8 py-3.5 rounded-2xl font-bold text-sm transition-all shadow-xl flex items-center gap-2 w-fit transform 
                ${banner.isClosed 
                  ? 'bg-gray-800 text-gray-400 cursor-not-allowed border border-gray-700' 
                  : 'bg-white text-gray-900 hover:bg-orange-500 hover:text-white hover:-translate-y-1'
                }`}
            >
              {banner.isClosed ? 'Ver Cardápio (Indisponível)' : 'Fazer Pedido'} 
              {!banner.isClosed && <ChevronRight size={16}/>}
            </button>
          </div>
          
          <div className="absolute right-8 bottom-8 opacity-30 sm:opacity-60 hidden sm:block transform rotate-12">
            {banner.icon}
          </div>
        </div>
      </div>

      <div className="relative -mt-10 mx-4 z-20 max-w-4xl sm:mx-auto">
        <div className="absolute inset-y-0 left-0 pl-5 flex items-center pointer-events-none">
          <Search className="h-5 w-5 text-gray-400" />
        </div>
        <input
          type="text"
          placeholder="O que você quer comer hoje?"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="block w-full pl-12 pr-4 py-4 border-0 rounded-2xl bg-white shadow-xl shadow-gray-200/40 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-500 transition-all text-base"
        />
      </div>

      {selectedCategory === 'todos' && !searchTerm && comboProducts.length > 0 && (
        <section className="px-2">
          <div className="flex items-center justify-between px-1 mb-4">
            <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
              <ShoppingBag className="text-orange-600" size={22}/> Combos Matadores
            </h2>
          </div>
          <div className="flex gap-4 overflow-x-auto pb-6 no-scrollbar -mx-4 px-4">
            {comboProducts.map(product => (
              <ProductHorizontalCard 
                key={product.id} 
                product={product} 
                onClick={() => openProductModal(product)} 
                disabled={banner.isClosed} 
              />
            ))}
          </div>
        </section>
      )}

      {selectedCategory === 'todos' && !searchTerm && promoProducts.length > 0 && (
        <section className="px-2">
          <div className="flex items-center justify-between px-1 mb-4">
            <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
              <Flame className="text-red-500 fill-red-500" size={22}/> Imperdíveis
            </h2>
          </div>
          <div className="flex gap-4 overflow-x-auto pb-6 no-scrollbar -mx-4 px-4">
            {promoProducts.map(product => (
              <ProductHorizontalCard 
                key={product.id} 
                product={product} 
                onClick={() => openProductModal(product)} 
                isPromo 
                disabled={banner.isClosed}
              />
            ))}
          </div>
        </section>
      )}

      <section id="menu-section" className="pt-4 px-2">
        <div className="flex items-center gap-2 mb-6 overflow-x-auto pb-2 no-scrollbar sticky top-0 bg-gray-50/95 backdrop-blur-sm z-10 py-2">
          {CATEGORIES.map(cat => {
            const Icon = cat.icon;
            const isSelected = selectedCategory === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat.id)}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold transition-all whitespace-nowrap ${isSelected ? 'bg-gray-900 text-white shadow-lg scale-105' : 'bg-white text-gray-500 border border-gray-200 hover:bg-gray-100'}`}
              >
                <Icon size={16} className={isSelected ? 'text-orange-400' : 'text-gray-400'} />
                {cat.label}
              </button>
            )
          })}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {loading ? (
             [1,2,3,4].map(i => <div key={i} className="h-32 bg-gray-200 rounded-3xl animate-pulse"></div>)
          ) : mainList.length === 0 ? (
            <div className="col-span-full text-center py-20 text-gray-400 flex flex-col items-center">
              <ShoppingBag size={48} className="mb-4 text-gray-300"/>
              <p>Nenhum produto encontrado nesta categoria.</p>
            </div>
          ) : (
            mainList.map(product => (
              <div 
                key={product.id} 
                onClick={() => openProductModal(product)}
                className={`bg-white p-4 rounded-3xl border border-gray-100 shadow-sm transition-all group flex flex-row gap-4 items-center
                  ${banner.isClosed ? 'opacity-75 cursor-not-allowed grayscale-[0.5]' : 'hover:shadow-xl hover:-translate-y-1 cursor-pointer'}
                `}
              >
                <div className="w-24 h-24 bg-gray-50 rounded-2xl overflow-hidden shrink-0 relative">
                  {product.image ? (
                    <img src={`${API_URL}/uploads/${product.image}`} className="w-full h-full object-cover" />
                  ) : <div className="w-full h-full flex items-center justify-center text-gray-300"><Utensils/></div>}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-gray-800 line-clamp-1 group-hover:text-orange-600 transition-colors">{product.name}</h3>
                  <p className="text-xs text-gray-500 line-clamp-2 my-1">{product.description}</p>
                  <div className="flex justify-between items-center mt-2">
                    <span className="font-bold text-lg text-gray-900">{Number(product.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</span>
                    <button 
                      disabled={banner.isClosed}
                      className={`p-2 rounded-xl transition-all shadow-sm ${banner.isClosed ? 'bg-gray-200 text-gray-400' : 'bg-gray-100 text-gray-900 hover:bg-orange-500 hover:text-white'}`}
                    >
                      <Plus size={16}/>
                    </button>
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

function ProductHorizontalCard({ product, onClick, isPromo, disabled }: { product: Product, onClick: () => void, isPromo?: boolean, disabled?: boolean }) {
  const API_URL = 'http://localhost:3000'; 

  return (
    <div 
      onClick={!disabled ? onClick : undefined}
      className={`min-w-[260px] max-w-[260px] bg-white p-4 rounded-3xl border border-gray-100 shadow-sm transition-all group relative overflow-hidden
        ${disabled ? 'opacity-80 cursor-not-allowed' : 'cursor-pointer hover:shadow-lg hover:-translate-y-1'}
      `}
    >
      {isPromo && <span className="absolute top-0 right-0 bg-red-600 text-white text-[10px] font-bold px-3 py-1.5 rounded-bl-2xl z-10 shadow-sm">OFERTA</span>}
      
      <div className="h-36 bg-gray-50 rounded-2xl mb-4 overflow-hidden relative">
         {product.image ? (
            <img src={`${API_URL}/uploads/${product.image}`} className={`w-full h-full object-cover transition-transform duration-700 ${!disabled && 'group-hover:scale-110'}`} />
         ) : <div className="w-full h-full flex items-center justify-center text-gray-300"><Utensils/></div>}
      </div>
      
      <h3 className="font-bold text-gray-800 line-clamp-1 text-lg mb-1">{product.name}</h3>
      <p className="text-xs text-gray-500 line-clamp-1 mb-4">{product.description}</p>
      
      <div className="flex justify-between items-center">
        <span className="font-extrabold text-xl text-gray-900">
          {Number(product.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
        </span>
        <button 
          disabled={disabled}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors shadow-lg
            ${disabled ? 'bg-gray-400 text-white' : 'bg-black text-white hover:bg-orange-600'}
          `}
        >
          {disabled ? 'Fechado' : 'Adicionar'}
        </button>
      </div>
    </div>
  )
}