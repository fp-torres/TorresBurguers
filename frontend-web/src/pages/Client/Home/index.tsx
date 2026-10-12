import { useState, useEffect, useMemo, useCallback, type ReactNode } from 'react';
import { Search, ShoppingBag, Flame, ChevronRight, Star, Utensils, Coffee, IceCream, Plus, Clock, Trophy, Bike, Lock, Soup, Droplets, RotateCcw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { productService, type Product } from '../../../services/productService';
import { promotionService, type HomeBanner } from '../../../services/promotionService';
import { assetUrl } from '../../../services/api';
import { useStoreStatus } from '../../../contexts/StoreStatusContext';
import ProductModal from '../../../components/ProductModal';
import { effectivePrice, hasPromotion, normalizeSearch } from '../../../utils/catalog';
import { formatCurrency } from '../../../utils/format';

interface BannerVisual {
  image: string;
  icon: ReactNode;
}

// Imagem e ícone do banner de cada dia da semana (0 = domingo).
// Os textos da promoção vêm da API (GET /promotions/banner).
const DAILY_VISUALS: Record<number, BannerVisual> = {
  0: { image: "https://images.unsplash.com/photo-1594212699903-ec8a3eca50f5?q=80&w=1600&auto=format&fit=crop", icon: <ShoppingBag size={48} className="text-white/80" /> },
  1: { image: "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?q=80&w=1600&auto=format&fit=crop", icon: <Flame size={48} className="text-white/80" /> },
  2: { image: "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?q=80&w=1600&auto=format&fit=crop", icon: <Flame size={48} className="text-white/80" /> },
  3: { image: "https://images.unsplash.com/photo-1550989460-0adf9ea622e2?q=80&w=1600&auto=format&fit=crop", icon: <Bike size={48} className="text-white/80" /> },
  4: { image: "https://images.unsplash.com/photo-1541592106381-b31e9677c0e5?q=80&w=1600&auto=format&fit=crop", icon: <Utensils size={48} className="text-white/80" /> },
  5: { image: "https://images.unsplash.com/photo-1607013251379-e6eecfffe234?q=80&w=1600&auto=format&fit=crop", icon: <Flame size={48} className="text-white/80" /> },
  6: { image: "https://images.unsplash.com/photo-1598182198871-d3f4ab4fd181?q=80&w=1600&auto=format&fit=crop", icon: <Coffee size={48} className="text-white/80" /> },
};

const FOOTBALL_VISUAL: BannerVisual = {
  image: "https://images.unsplash.com/photo-1574629810360-7efbbe195018?q=80&w=1600&auto=format&fit=crop",
  icon: <Trophy size={48} className="text-yellow-400 animate-bounce" />,
};

const CLOSED_VISUAL: BannerVisual = {
  image: "https://images.unsplash.com/photo-1559339352-11d035aa65de?q=80&w=1600&auto=format&fit=crop",
  icon: <Lock size={48} className="text-white/80" />,
};

// Texto enquanto o banner da API não chega (ou se a API não responder)
const FALLBACK_BANNER: HomeBanner = {
  type: 'promo',
  title: 'Peça agora mesmo 🍔',
  message: 'Escolha seus favoritos no cardápio e acompanhe o pedido em tempo real.',
};

const DEFAULT_CLOSED_MESSAGE = 'No momento não estamos recebendo pedidos. Volte mais tarde!';

const CATEGORIES: { id: string; label: string; icon: LucideIcon }[] = [
  { id: 'combos', label: 'Combos', icon: ShoppingBag },
  { id: 'hamburgueres', label: 'Burgers', icon: Utensils },
  { id: 'entradas', label: 'Entradas', icon: Soup },
  { id: 'acompanhamentos', label: 'Acomp.', icon: Utensils },
  { id: 'bebidas', label: 'Bebidas', icon: Coffee },
  { id: 'sobremesas', label: 'Doces', icon: IceCream },
  { id: 'molhos', label: 'Molhos', icon: Droplets },
  { id: 'todos', label: 'Tudo', icon: Star },
];

// Categorias que aparecem enquanto o cardápio carrega (as demais só se tiverem produtos)
const MAIN_CATEGORY_IDS = new Set(['combos', 'hamburgueres', 'acompanhamentos', 'bebidas', 'sobremesas', 'todos']);

/** Dia da semana (0 = domingo) no fuso da loja: o mesmo que a API usa para escolher a promoção. */
function storeWeekday(): number {
  try {
    const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date());
    const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(day);
    if (index >= 0) return index;
  } catch {
    // Navegador sem suporte ao fuso: usa o relógio local
  }
  return new Date().getDay();
}

export default function ClientHome() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [banner, setBanner] = useState<HomeBanner | null>(null);
  // null = categoria padrão: Combos (quando houver combos) ou Tudo
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Status real da loja (GET /store/status): fechada → cardápio só para consulta
  const { status: storeStatus, isClosed } = useStoreStatus();
  const closedMessage = storeStatus?.closing_message?.trim() || DEFAULT_CLOSED_MESSAGE;
  const openingMessage = storeStatus?.is_open ? storeStatus.opening_message?.trim() : '';

  const weekday = useMemo(storeWeekday, []);

  const loadCatalog = useCallback(async () => {
    try {
      const data = await productService.getAll();
      setProducts(data.filter(p => p.available));
      setLoadError(false);
    } catch {
      // A tela mostra o erro com "Tentar novamente"
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    let active = true;
    promotionService.getBanner()
      .then(data => { if (active && data?.title) setBanner(data); })
      .catch(() => { /* Sem banner da API: fica o texto padrão */ });
    return () => { active = false; };
  }, []);

  function retryCatalog() {
    setLoading(true);
    setLoadError(false);
    loadCatalog();
  }

  function openProductModal(product: Product) {
    if (isClosed) return;
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
  // Imperdíveis: produtos em promoção e hambúrgueres abaixo de R$ 30
  const promoProducts = useMemo(
    () => products.filter(p => hasPromotion(p) || (p.category === 'hamburgueres' && effectivePrice(p) < 30)),
    [products],
  );

  const visibleCategories = useMemo(
    () => CATEGORIES.filter(cat =>
      loading ? MAIN_CATEGORY_IDS.has(cat.id) : cat.id === 'todos' || products.some(p => p.category === cat.id),
    ),
    [loading, products],
  );
  const activeCategory = selectedCategory ?? (comboProducts.length > 0 || loading ? 'combos' : 'todos');

  // A busca procura no cardápio inteiro (nome e descrição, sem diferenciar acentos)
  const search = normalizeSearch(searchTerm);
  const mainList = products.filter(product => {
    if (search) {
      return normalizeSearch(product.name).includes(search) || normalizeSearch(product.description ?? '').includes(search);
    }
    return activeCategory === 'todos' || product.category === activeCategory;
  });

  // Conteúdo do banner: loja fechada > jogo do dia > promoção do dia
  const isFootball = !isClosed && banner?.type === 'football';
  const bannerTexts = banner ?? FALLBACK_BANNER;
  const visual = isClosed ? CLOSED_VISUAL : isFootball ? FOOTBALL_VISUAL : DAILY_VISUALS[weekday] ?? DAILY_VISUALS[0];
  const bannerTitle = isClosed ? 'Estamos fechados agora 🔒' : bannerTexts.title;
  const bannerMessage = isClosed ? closedMessage : bannerTexts.message;
  const bannerSubtitle = isClosed ? undefined : bannerTexts.subtitle;
  const matchDetails = isFootball ? banner?.details : undefined;

  return (
    <div className="space-y-10 pb-20 animate-in fade-in duration-500 relative">

      {/* --- BANNER PRINCIPAL --- */}
      <div className="relative w-full min-h-64 sm:min-h-80 rounded-3xl overflow-hidden shadow-2xl group mx-auto max-w-[98%] mt-4 flex">
        <img
          src={visual.image}
          alt=""
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-1000 group-hover:scale-105"
        />
        <div className={`absolute inset-0 ${isClosed ? 'bg-black/80' : 'bg-gradient-to-r from-black/90 via-black/50 to-transparent'}`}></div>
        <div className="relative z-10 w-full p-6 sm:p-12 flex flex-col justify-center">
          <div className="max-w-xl">
            <span className={`${isClosed ? 'bg-red-600' : isFootball ? 'bg-green-600' : 'bg-orange-600'} text-white text-xs font-bold px-3 py-1 rounded-full mb-4 inline-flex items-center gap-1 shadow-lg`}>
              {isClosed ? <Lock size={12}/> : isFootball ? <Trophy size={12}/> : <Clock size={12}/>}
              {isClosed ? 'LOJA FECHADA' : isFootball ? 'Jogo de Hoje' : 'Oferta de Hoje'}
            </span>
            <h2 className="text-3xl sm:text-5xl font-extrabold text-white mb-3 leading-tight drop-shadow-lg">
              {bannerTitle}
            </h2>
            <p className="text-gray-200 text-sm sm:text-xl font-medium drop-shadow-md max-w-md mb-3">
              {bannerMessage}
            </p>
            {bannerSubtitle && (
              <p className="text-gray-300 text-xs sm:text-sm font-medium drop-shadow-md max-w-md mb-3">{bannerSubtitle}</p>
            )}

            {/* Placar do jogo do dia */}
            {matchDetails && (
              <div className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 bg-white/10 backdrop-blur-sm border border-white/20 rounded-2xl px-4 py-2 mb-3 text-white">
                <span className="font-extrabold">{matchDetails.home}</span>
                <span className="text-xs font-bold bg-white/20 px-2 py-0.5 rounded-lg">x</span>
                <span className="font-extrabold">{matchDetails.away}</span>
                <span className="text-xs text-gray-200 sm:border-l sm:border-white/20 sm:pl-3">
                  {matchDetails.tournament} · {matchDetails.time}
                </span>
              </div>
            )}

            <button
              onClick={scrollToMenu}
              className={`mt-3 px-8 py-3.5 rounded-2xl font-bold text-sm transition-all shadow-xl flex items-center gap-2 w-fit transform
                ${isClosed
                  ? 'bg-gray-800 text-gray-200 border border-gray-700 hover:bg-gray-700'
                  : 'bg-white text-gray-900 hover:bg-orange-500 hover:text-white hover:-translate-y-1'
                }`}
            >
              {isClosed ? 'Ver Cardápio' : 'Fazer Pedido'}
              <ChevronRight size={16}/>
            </button>
          </div>
          <div className="absolute right-8 bottom-8 opacity-30 sm:opacity-60 hidden sm:block transform rotate-12">
            {visual.icon}
          </div>
        </div>
      </div>

      {/* Aviso da loja (mensagem configurada no painel) */}
      {openingMessage && (
        <p className="mx-4 sm:mx-auto max-w-4xl text-center text-sm font-medium text-green-700 dark:text-green-300 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-2xl px-4 py-3">
          {openingMessage}
        </p>
      )}

      {/* --- BARRA DE PESQUISA COM DESTAQUE DARK MODE --- */}
      <div className="relative mt-8 mx-4 z-20 max-w-4xl sm:mx-auto">
        <div className="absolute inset-y-0 left-0 pl-5 flex items-center pointer-events-none">
          <Search className="h-5 w-5 text-orange-500" />
        </div>
        <input
          type="search"
          placeholder="O que você quer comer hoje?"
          aria-label="Buscar no cardápio"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="block w-full pl-12 pr-4 py-5 border-0 rounded-2xl bg-white dark:bg-slate-800 shadow-2xl shadow-orange-100/50 dark:shadow-none text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-500 ring-1 ring-orange-100 dark:ring-slate-700 transition-all text-base font-medium"
        />
      </div>

      {/* --- SEÇÃO: COMBOS MATADORES (só em 'Tudo'; em 'Combos' eles já estão na lista principal) --- */}
      {activeCategory === 'todos' && !searchTerm && comboProducts.length > 0 && (
        <section className="px-2">
          <div className="flex items-center justify-between px-1 mb-4">
            <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
              <ShoppingBag className="text-orange-600" size={22}/> Combos Matadores
            </h2>
          </div>
          <div className="flex gap-4 overflow-x-auto pb-6 no-scrollbar -mx-4 px-4">
            {comboProducts.map(product => (
              <ProductHorizontalCard
                key={product.id}
                product={product}
                onClick={() => openProductModal(product)}
                disabled={isClosed}
              />
            ))}
          </div>
        </section>
      )}

      {/* --- SEÇÃO: IMPERDÍVEIS (sempre, exceto durante a busca) --- */}
      {!searchTerm && promoProducts.length > 0 && (
        <section className="px-2">
          <div className="flex items-center justify-between px-1 mb-4">
            <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
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
                disabled={isClosed}
              />
            ))}
          </div>
        </section>
      )}

      {/* --- SEÇÃO PRINCIPAL DO MENU (DARK MODE) --- */}
      <section id="menu-section" className="pt-4 px-2 scroll-mt-20">
        {isClosed && (
          <div role="status" className="mb-6 flex items-start gap-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 p-4 rounded-2xl">
            <Lock size={20} className="shrink-0 mt-0.5" />
            <p className="text-sm">
              <span className="font-bold">Pedidos pausados.</span> Você pode ver o cardápio, mas não é possível adicionar itens ao carrinho enquanto a loja estiver fechada.
            </p>
          </div>
        )}

        <div className="flex items-center gap-2 mb-6 overflow-x-auto pb-2 no-scrollbar sticky top-0 bg-gray-50/95 dark:bg-slate-950/95 backdrop-blur-sm z-10 py-2 transition-colors">
          {visibleCategories.map(cat => {
            const Icon = cat.icon;
            const isSelected = !search && activeCategory === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => { setSelectedCategory(cat.id); setSearchTerm(''); }}
                aria-pressed={isSelected}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold transition-all whitespace-nowrap
                  ${isSelected
                    ? 'bg-gray-900 dark:bg-orange-600 text-white shadow-lg scale-105'
                    : 'bg-white dark:bg-slate-800 text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-slate-700 hover:bg-gray-100 dark:hover:bg-slate-700'
                  }`}
              >
                <Icon size={16} className={isSelected ? 'text-orange-400 dark:text-white' : 'text-gray-400'} />
                {cat.label}
              </button>
            )
          })}
        </div>

        {search && !loading && (
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4 px-1">
            {mainList.length} {mainList.length === 1 ? 'resultado' : 'resultados'} para "{searchTerm.trim()}" em todo o cardápio
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {loading ? (
             [1,2,3,4].map(i => <div key={i} className="h-32 bg-gray-200 dark:bg-slate-800 rounded-3xl animate-pulse"></div>)
          ) : loadError ? (
            <div className="col-span-full text-center py-20 text-gray-500 dark:text-gray-400 flex flex-col items-center gap-4">
              <ShoppingBag size={48} className="text-gray-300 dark:text-gray-700"/>
              <p>Não foi possível carregar o cardápio. Verifique sua conexão.</p>
              <button onClick={retryCatalog} className="flex items-center gap-2 bg-orange-600 hover:bg-orange-700 text-white px-5 py-2.5 rounded-xl font-bold text-sm transition-colors">
                <RotateCcw size={16}/> Tentar novamente
              </button>
            </div>
          ) : mainList.length === 0 ? (
            <div className="col-span-full text-center py-20 text-gray-400 dark:text-gray-600 flex flex-col items-center">
              <ShoppingBag size={48} className="mb-4 text-gray-300 dark:text-gray-700"/>
              <p>{search ? 'Nenhum produto encontrado para esta busca.' : 'Nenhum produto encontrado nesta categoria.'}</p>
            </div>
          ) : (
            mainList.map(product => (
              <div
                key={product.id}
                onClick={() => openProductModal(product)}
                className={`bg-white dark:bg-slate-900 p-4 rounded-3xl border border-gray-100 dark:border-slate-800 shadow-sm transition-all group flex flex-row gap-4 items-center
                  ${isClosed
                    ? 'opacity-75 cursor-not-allowed grayscale-[0.5]'
                    : 'cursor-pointer hover:shadow-xl dark:hover:shadow-slate-900/50 hover:-translate-y-1'}
                `}
              >
                <div className="w-24 h-24 bg-gray-50 dark:bg-slate-800 rounded-2xl overflow-hidden shrink-0 relative">
                  {product.image ? (
                    <img src={assetUrl(product.image)} alt={product.name} loading="lazy" className="w-full h-full object-cover" />
                  ) : <div className="w-full h-full flex items-center justify-center text-gray-300"><Utensils/></div>}
                  {hasPromotion(product) && (
                    <span className="absolute top-0 left-0 bg-red-600 text-white text-[9px] font-bold px-2 py-0.5 rounded-br-xl">OFERTA</span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-gray-800 dark:text-white line-clamp-1 group-hover:text-orange-600 dark:group-hover:text-orange-400 transition-colors">{product.name}</h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2 my-1">{product.description}</p>
                  <div className="flex justify-between items-center mt-2">
                    <PriceTag product={product} className="font-bold text-lg text-gray-900 dark:text-gray-100" />
                    <button
                      disabled={isClosed}
                      aria-label={isClosed ? `${product.name}: loja fechada` : `Adicionar ${product.name}`}
                      className={`p-2 rounded-xl transition-all shadow-sm ${isClosed ? 'bg-gray-200 text-gray-400 dark:bg-slate-800 dark:text-gray-600' : 'bg-gray-100 dark:bg-slate-800 text-gray-900 dark:text-white hover:bg-orange-500 hover:text-white'}`}
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

/** Preço do produto; em promoção mostra o preço cheio riscado. */
function PriceTag({ product, className }: { product: Product, className: string }) {
  if (!hasPromotion(product)) return <span className={className}>{formatCurrency(effectivePrice(product))}</span>;
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-xs text-gray-400 line-through">{formatCurrency(product.price)}</span>
      <span className={`${className} text-red-600 dark:text-red-400`}>{formatCurrency(effectivePrice(product))}</span>
    </span>
  );
}

// --- SUB-COMPONENTE: CARD HORIZONTAL (DARK MODE) ---
function ProductHorizontalCard({ product, onClick, isPromo, disabled }: { product: Product, onClick: () => void, isPromo?: boolean, disabled?: boolean }) {
  return (
    <div
      onClick={!disabled ? onClick : undefined}
      className={`min-w-[260px] max-w-[260px] bg-white dark:bg-slate-900 p-4 rounded-3xl border border-gray-100 dark:border-slate-800 shadow-sm transition-all group relative overflow-hidden
        ${disabled ? 'opacity-80 cursor-not-allowed' : 'cursor-pointer hover:shadow-lg dark:hover:shadow-slate-900/50 hover:-translate-y-1'}
      `}
    >
      {isPromo && <span className="absolute top-0 right-0 bg-red-600 text-white text-[10px] font-bold px-3 py-1.5 rounded-bl-2xl z-10 shadow-sm">OFERTA</span>}

      <div className="h-36 bg-gray-50 dark:bg-slate-800 rounded-2xl mb-4 overflow-hidden relative">
         {product.image ? (
            <img src={assetUrl(product.image)} alt={product.name} loading="lazy" className={`w-full h-full object-cover transition-transform duration-700 ${!disabled ? 'group-hover:scale-110' : ''}`} />
         ) : <div className="w-full h-full flex items-center justify-center text-gray-300"><Utensils/></div>}
      </div>

      <h3 className="font-bold text-gray-800 dark:text-white line-clamp-1 text-lg mb-1">{product.name}</h3>
      <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-1 mb-4">{product.description}</p>

      <div className="flex justify-between items-center">
        <PriceTag product={product} className="font-extrabold text-xl text-gray-900 dark:text-gray-100" />
        <button
          disabled={disabled}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors shadow-lg
            ${disabled
              ? 'bg-gray-400 text-white dark:bg-slate-700 dark:text-gray-500'
              : 'bg-black dark:bg-orange-600 text-white hover:bg-orange-600 dark:hover:bg-orange-700'}
          `}
        >
          {disabled ? 'Fechado' : 'Adicionar'}
        </button>
      </div>
    </div>
  )
}
