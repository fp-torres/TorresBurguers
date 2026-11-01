import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Bike, ChevronRight, Clock, Coffee, Droplets, Flame, IceCream, Lock, Plus, Search, ShoppingBag, Soup, Sparkles,
  Star, Store as StoreIcon, Tag, Trophy, Utensils, Ban,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useStorefront } from '../../../contexts/StorefrontContext';
import { publicStoreService, type StorefrontProduct } from '../../../services/publicStoreService';
import { promotionService, type HomeBanner } from '../../../services/promotionService';
import { assetUrl, getApiErrorMessage } from '../../../services/api';
import type { Addon } from '../../../services/productService';
import { weekdayInTimeZone } from '../../../services/storefrontDisplay';
import ProductModal from '../../../components/ProductModal';
import StoreLogo from '../../../components/BrandLogo/StoreLogo';
import { ErrorState } from '../../../components/ui';
import { categoryLabel, effectivePrice, hasPromotion, normalizeSearch } from '../../../utils/catalog';
import { formatCurrency } from '../../../utils/format';

// Ícone decorativo do banner de cada dia da semana (0 = domingo), no fuso da loja.
// Os textos vêm da API (GET /stores/:slug/promotions/banner).
const DAILY_ICONS: LucideIcon[] = [ShoppingBag, Flame, Flame, Bike, Utensils, Sparkles, Coffee];

const DEFAULT_CLOSED_MESSAGE = 'No momento não estamos recebendo pedidos. Volte mais tarde!';

/** Categorias conhecidas (enum da API): nome curto do filtro e ícone, nesta ordem. */
const CATEGORY_META: Record<string, { label: string; icon: LucideIcon }> = {
  combos: { label: 'Combos', icon: ShoppingBag },
  hamburgueres: { label: 'Burgers', icon: Utensils },
  entradas: { label: 'Entradas', icon: Soup },
  acompanhamentos: { label: 'Acomp.', icon: Utensils },
  bebidas: { label: 'Bebidas', icon: Coffee },
  sobremesas: { label: 'Doces', icon: IceCream },
  molhos: { label: 'Molhos', icon: Droplets },
  adicionais: { label: 'Extras', icon: Plus },
};
const CATEGORY_ORDER = Object.keys(CATEGORY_META);
const ALL_CATEGORY = 'todos';

interface CategoryOption {
  id: string;
  label: string;
  /** Nome completo (dica ao passar o mouse). */
  title: string;
  icon: LucideIcon;
}

function categoryRank(id: string): number {
  const index = CATEGORY_ORDER.indexOf(id);
  return index === -1 ? CATEGORY_ORDER.length : index;
}

/** Filtros a partir das categorias que existem no cardápio da loja (mais "Tudo"). */
function deriveCategories(products: StorefrontProduct[]): CategoryOption[] {
  const ids = Array.from(new Set(products.map((product) => product.category).filter(Boolean)));
  ids.sort((a, b) => categoryRank(a) - categoryRank(b) || a.localeCompare(b, 'pt-BR'));
  const options = ids.map((id) => {
    const full = categoryLabel(id);
    const pretty = full ? full.charAt(0).toUpperCase() + full.slice(1) : id;
    return { id, label: CATEGORY_META[id]?.label ?? pretty, title: pretty, icon: CATEGORY_META[id]?.icon ?? Tag };
  });
  return [...options, { id: ALL_CATEGORY, label: 'Tudo', title: 'Todo o cardápio', icon: Star }];
}

/**
 * Adicionais do produto conferidos com a lista atual da loja (GET /stores/:slug/addons): só os que ainda
 * existem e estão disponíveis, com nome e preço atuais. Sem a lista (falhou), vale o que veio no produto.
 */
function withLiveAddons(product: StorefrontProduct, liveAddons: Map<number, Addon> | null): StorefrontProduct {
  const allowed = (product.allowed_addons ?? [])
    .map((addon) => (liveAddons ? liveAddons.get(addon.id) : addon))
    .filter((addon): addon is Addon => !!addon && addon.available !== false);
  return { ...product, allowed_addons: allowed };
}

interface CatalogData {
  products: StorefrontProduct[];
  addons: Addon[] | null;
}

export default function ClientHome() {
  const { slug, store, status, isClosed, orderingAvailable, canOrder, unavailableMessage } = useStorefront();

  // Cardápio da loja do slug (a resposta de outra loja nunca é aplicada: a página é remontada por loja)
  const [catalog, setCatalog] = useState<CatalogData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [banner, setBanner] = useState<HomeBanner | null>(null);

  // null = categoria padrão: Combos (quando houver combos) ou Tudo
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<StorefrontProduct | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      publicStoreService.getProducts(slug, controller.signal),
      // Adicionais são um complemento: sem eles, valem os que vieram em cada produto
      publicStoreService.getAddons(slug, controller.signal).catch(() => null),
    ])
      .then(([products, addons]) => {
        setCatalog({ products, addons });
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(getApiErrorMessage(error, 'Não foi possível carregar o cardápio. Verifique sua conexão.'));
      });
    return () => controller.abort();
  }, [slug, attempt]);

  useEffect(() => {
    const controller = new AbortController();
    promotionService.getStoreBanner(slug, controller.signal)
      .then((data) => {
        if (data) setBanner(data);
      })
      .catch(() => {
        // Sem banner da API: fica o texto padrão
      });
    return () => controller.abort();
  }, [slug]);

  const loading = catalog === null && loadError === null;
  const weekday = useMemo(() => weekdayInTimeZone(store.time_zone), [store.time_zone]);

  const products = useMemo(() => {
    if (!catalog) return [];
    const liveAddons = catalog.addons ? new Map(catalog.addons.map((addon) => [addon.id, addon])) : null;
    return catalog.products.filter((product) => product.available).map((product) => withLiveAddons(product, liveAddons));
  }, [catalog]);

  const categories = useMemo(() => deriveCategories(products), [products]);
  const comboProducts = useMemo(() => products.filter((product) => product.category === 'combos'), [products]);
  // Imperdíveis: promoções de verdade (preço promocional menor que o preço) e os destaques marcados pela loja
  const featuredProducts = useMemo(
    () => products.filter((product) => hasPromotion(product) || product.is_highlight === true),
    [products],
  );

  const defaultCategory = comboProducts.length > 0 ? 'combos' : ALL_CATEGORY;
  const activeCategory = selectedCategory && categories.some((category) => category.id === selectedCategory)
    ? selectedCategory
    : defaultCategory;

  // A busca procura no cardápio inteiro (nome e descrição, sem diferenciar acentos)
  const search = normalizeSearch(searchTerm);
  const mainList = products.filter((product) => {
    if (search) {
      return normalizeSearch(product.name).includes(search) || normalizeSearch(product.description ?? '').includes(search);
    }
    return activeCategory === ALL_CATEGORY || product.category === activeCategory;
  });

  function retryCatalog() {
    setLoadError(null);
    setAttempt((value) => value + 1);
  }

  function openProductModal(product: StorefrontProduct) {
    if (!canOrder) return;
    setSelectedProduct(product);
  }

  function scrollToMenu() {
    document.getElementById('menu-section')?.scrollIntoView({ behavior: 'smooth' });
  }

  // Conteúdo do banner: loja sem vendas > loja fechada > jogo do dia > sugestão do dia
  const closedMessage = status?.closing_message?.trim() || DEFAULT_CLOSED_MESSAGE;
  const openingMessage = status?.is_open ? status.opening_message?.trim() : '';
  const isFootball = canOrder && banner?.type === 'football';
  const bannerTitle = !orderingAvailable
    ? 'Pedidos indisponíveis no momento'
    : isClosed
      ? 'Estamos fechados agora 🔒'
      : banner?.title ?? 'Peça agora mesmo';
  const bannerMessage = !orderingAvailable
    ? unavailableMessage
    : isClosed
      ? closedMessage
      : banner?.message ?? `Escolha seus favoritos no cardápio de ${store.name} e acompanhe o pedido em tempo real.`;
  const bannerSubtitle = canOrder ? banner?.subtitle : undefined;
  const matchDetails = isFootball ? banner?.details : undefined;
  const BannerIcon = !orderingAvailable ? Ban : isClosed ? Lock : isFootball ? Trophy : DAILY_ICONS[weekday] ?? ShoppingBag;
  const blockedLabel = orderingAvailable ? 'loja fechada' : 'pedidos indisponíveis';

  return (
    <div className="space-y-8 pb-20 animate-in fade-in duration-500 relative">

      {/* --- APRESENTAÇÃO DA LOJA --- */}
      <section aria-labelledby="store-title" className="rounded-3xl overflow-hidden bg-white dark:bg-slate-900 border border-gray-100 dark:border-slate-800 shadow-sm">
        <div className="h-24 sm:h-32 bg-brand relative" aria-hidden="true">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_20%,rgba(255,255,255,0.28),transparent_55%)]" />
          <div className="absolute inset-0 bg-linear-to-t from-black/25 to-transparent" />
        </div>
        <div className="px-5 sm:px-8 pb-6">
          {/* Só o logo avança sobre a faixa colorida; o nome fica sempre sobre o fundo do cartão */}
          <div className="relative -mt-10 sm:-mt-12 flex flex-col sm:flex-row sm:items-start gap-3 sm:gap-5">
            <StoreLogo name={store.name} logo={store.logo} size={88} decorative className="ring-4 ring-white dark:ring-slate-900 shadow-lg" />
            <div className="min-w-0 flex-1 sm:pt-14">
              <h1 id="store-title" className="text-2xl sm:text-3xl font-extrabold text-gray-900 dark:text-white wrap-break-word">{store.name}</h1>
              {store.description && <p className="text-sm sm:text-base text-gray-500 dark:text-gray-400 mt-1 max-w-3xl">{store.description}</p>}
            </div>
          </div>
          <ul className="mt-4 flex flex-wrap gap-2 text-xs font-bold" aria-label="Informações da loja">
            <li>
              {!orderingAvailable ? (
                <Chip tone="amber" icon={<Ban size={14} />}>Pedidos indisponíveis</Chip>
              ) : status === null ? (
                <Chip tone="neutral" icon={<StoreIcon size={14} />}>Verificando...</Chip>
              ) : status.is_open ? (
                <Chip tone="green" icon={<StoreIcon size={14} />}>Aberto agora</Chip>
              ) : (
                <Chip tone="red" icon={<Lock size={14} />}>Fechado agora</Chip>
              )}
            </li>
            {store.delivery_enabled && <li><Chip tone="neutral" icon={<Bike size={14} />}>Entrega</Chip></li>}
            {store.takeout_enabled && (
              <li>
                <Chip tone="neutral" icon={<Clock size={14} />}>
                  Retirada{store.takeout_estimate ? ` em ${store.takeout_estimate}` : ''}
                </Chip>
              </li>
            )}
          </ul>
        </div>
      </section>

      {/* --- BANNER DO DIA (texto da API) --- */}
      <section aria-labelledby="banner-title" className="relative overflow-hidden rounded-3xl bg-gray-900 dark:bg-slate-900 border border-gray-800 dark:border-slate-800 shadow-xl text-white">
        <div className="absolute -right-10 -top-10 w-56 h-56 rounded-full bg-brand/40 blur-3xl" aria-hidden="true" />
        <div className="absolute right-6 bottom-6 opacity-20 sm:opacity-40 rotate-12 hidden sm:block" aria-hidden="true">
          <BannerIcon size={88} className={isFootball ? 'text-yellow-400' : 'text-white'} />
        </div>
        <div className="relative p-6 sm:p-10 max-w-2xl">
          <span className={`${!orderingAvailable ? 'bg-amber-500 text-gray-900' : isClosed ? 'bg-red-600 text-white' : isFootball ? 'bg-green-600 text-white' : 'bg-brand text-brand-contrast'} text-xs font-bold px-3 py-1 rounded-full mb-4 inline-flex items-center gap-1 shadow-lg`}>
            <BannerIcon size={12} aria-hidden="true" />
            {!orderingAvailable ? 'PEDIDOS INDISPONÍVEIS' : isClosed ? 'LOJA FECHADA' : isFootball ? 'Jogo de Hoje' : 'Sugestão de Hoje'}
          </span>
          <h2 id="banner-title" className="text-2xl sm:text-4xl font-extrabold mb-3 leading-tight">{bannerTitle}</h2>
          <p className="text-gray-200 text-sm sm:text-lg font-medium max-w-md mb-3">{bannerMessage}</p>
          {bannerSubtitle && <p className="text-gray-300 text-xs sm:text-sm font-medium max-w-md mb-3">{bannerSubtitle}</p>}

          {/* Placar do jogo do dia */}
          {matchDetails && (
            <div className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 bg-white/10 border border-white/20 rounded-2xl px-4 py-2 mb-3">
              <span className="font-extrabold">{matchDetails.home}</span>
              <span className="text-xs font-bold bg-white/20 px-2 py-0.5 rounded-lg">x</span>
              <span className="font-extrabold">{matchDetails.away}</span>
              {(matchDetails.tournament || matchDetails.time) && (
                <span className="text-xs text-gray-200 sm:border-l sm:border-white/20 sm:pl-3">
                  {[matchDetails.tournament, matchDetails.time].filter(Boolean).join(' · ')}
                </span>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={scrollToMenu}
            className={`mt-3 px-7 py-3 rounded-2xl font-bold text-sm transition-all shadow-xl flex items-center gap-2 w-fit focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900
              ${canOrder ? 'bg-brand text-brand-contrast hover:bg-brand-hover hover:-translate-y-0.5' : 'bg-gray-800 text-gray-100 border border-gray-700 hover:bg-gray-700'}`}
          >
            {canOrder ? 'Fazer Pedido' : 'Ver Cardápio'}
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      </section>

      {/* Aviso da loja (mensagem configurada no painel) */}
      {openingMessage && canOrder && (
        <p className="max-w-4xl mx-auto text-center text-sm font-medium text-green-700 dark:text-green-300 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-2xl px-4 py-3">
          {openingMessage}
        </p>
      )}

      {/* --- BUSCA --- */}
      <div className="relative max-w-4xl mx-auto z-20">
        <div className="absolute inset-y-0 left-0 pl-5 flex items-center pointer-events-none">
          <Search className="h-5 w-5 text-brand-ink dark:text-brand-ink-dark" aria-hidden="true" />
        </div>
        <input
          type="search"
          placeholder="O que você quer comer hoje?"
          aria-label="Buscar no cardápio"
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          className="block w-full pl-12 pr-4 py-4 sm:py-5 border-0 rounded-2xl bg-white dark:bg-slate-800 shadow-xl shadow-black/5 dark:shadow-none text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand ring-1 ring-gray-100 dark:ring-slate-700 transition-all text-base font-medium"
        />
      </div>

      {/* --- COMBOS (só em "Tudo"; em "Combos" eles já estão na lista principal) --- */}
      {activeCategory === ALL_CATEGORY && !search && comboProducts.length > 0 && (
        <section aria-labelledby="combos-title">
          <h2 id="combos-title" className="text-xl font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2 px-1 mb-4">
            <ShoppingBag className="text-brand-ink dark:text-brand-ink-dark" size={22} aria-hidden="true" /> Combos da casa
          </h2>
          <div className="flex gap-4 overflow-x-auto pb-4 -mx-4 px-4 [scrollbar-width:thin]">
            {comboProducts.map((product) => (
              <ProductHorizontalCard key={product.id} product={product} onOpen={() => openProductModal(product)} disabled={!canOrder} blockedLabel={blockedLabel} />
            ))}
          </div>
        </section>
      )}

      {/* --- IMPERDÍVEIS: promoções reais e destaques da loja (exceto durante a busca) --- */}
      {!search && featuredProducts.length > 0 && (
        <section aria-labelledby="featured-title">
          <h2 id="featured-title" className="text-xl font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2 px-1 mb-4">
            <Flame className="text-red-500 fill-red-500" size={22} aria-hidden="true" /> Imperdíveis
          </h2>
          <div className="flex gap-4 overflow-x-auto pb-4 -mx-4 px-4 [scrollbar-width:thin]">
            {featuredProducts.map((product) => (
              <ProductHorizontalCard key={product.id} product={product} onOpen={() => openProductModal(product)} disabled={!canOrder} blockedLabel={blockedLabel} />
            ))}
          </div>
        </section>
      )}

      {/* --- CARDÁPIO --- */}
      <section id="menu-section" aria-labelledby="menu-title" className="pt-2 scroll-mt-20">
        <h2 id="menu-title" className="sr-only">Cardápio</h2>
        {!canOrder && (
          <div role="status" className={`mb-6 flex items-start gap-3 p-4 rounded-2xl border ${orderingAvailable ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300' : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200'}`}>
            <Lock size={20} className="shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-sm">
              {orderingAvailable ? (
                <><span className="font-bold">Pedidos pausados.</span> Você pode ver o cardápio, mas não é possível adicionar itens ao carrinho enquanto a loja estiver fechada.</>
              ) : (
                <><span className="font-bold">Pedidos indisponíveis.</span> Você pode ver o cardápio, mas esta loja não está recebendo pedidos pelo site no momento.</>
              )}
            </p>
          </div>
        )}

        <div className="flex items-center gap-2 mb-6 overflow-x-auto pb-2 sticky top-16 bg-gray-50/95 dark:bg-slate-950/95 backdrop-blur-sm z-10 py-2 transition-colors [scrollbar-width:thin]" role="group" aria-label="Categorias do cardápio">
          {loading
            ? [1, 2, 3, 4].map((index) => <div key={index} className="h-10 w-24 shrink-0 rounded-full bg-gray-200 dark:bg-slate-800 animate-pulse" aria-hidden="true" />)
            : categories.map((category) => {
              const Icon = category.icon;
              const isSelected = !search && activeCategory === category.id;
              return (
                <button
                  key={category.id}
                  type="button"
                  title={category.title}
                  onClick={() => { setSelectedCategory(category.id); setSearchTerm(''); }}
                  aria-pressed={isSelected}
                  className={`flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold transition-all whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-brand
                    ${isSelected
                      ? 'bg-brand text-brand-contrast shadow-lg'
                      : 'bg-white dark:bg-slate-800 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-slate-700 hover:bg-gray-100 dark:hover:bg-slate-700'}`}
                >
                  <Icon size={16} className={isSelected ? undefined : 'text-gray-400'} aria-hidden="true" />
                  {category.label}
                </button>
              );
            })}
        </div>

        {search && !loading && !loadError && (
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4 px-1" role="status">
            {mainList.length} {mainList.length === 1 ? 'resultado' : 'resultados'} para "{searchTerm.trim()}" em todo o cardápio
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
          {loading ? (
            <>
              {[1, 2, 3, 4, 5, 6].map((index) => <div key={index} className="h-32 bg-gray-200 dark:bg-slate-800 rounded-3xl animate-pulse" aria-hidden="true" />)}
              <span className="sr-only" role="status">Carregando o cardápio...</span>
            </>
          ) : loadError ? (
            <div className="col-span-full bg-white dark:bg-slate-900 rounded-3xl border border-gray-100 dark:border-slate-800">
              <ErrorState title="Não foi possível carregar o cardápio" message={loadError} onRetry={retryCatalog} />
            </div>
          ) : mainList.length === 0 ? (
            <div className="col-span-full text-center py-16 text-gray-500 dark:text-gray-400 flex flex-col items-center">
              <ShoppingBag size={48} className="mb-4 text-gray-300 dark:text-gray-700" aria-hidden="true" />
              <p>
                {search
                  ? 'Nenhum produto encontrado para esta busca.'
                  : products.length === 0
                    ? 'Esta loja ainda não tem produtos disponíveis no cardápio.'
                    : 'Nenhum produto encontrado nesta categoria.'}
              </p>
            </div>
          ) : (
            mainList.map((product) => (
              <div
                key={product.id}
                onClick={() => openProductModal(product)}
                className={`bg-white dark:bg-slate-900 p-4 rounded-3xl border border-gray-100 dark:border-slate-800 shadow-sm transition-all group flex flex-row gap-4 items-center
                  ${canOrder ? 'cursor-pointer hover:shadow-xl dark:hover:shadow-slate-900/50 hover:-translate-y-1' : 'opacity-75 cursor-not-allowed grayscale-[0.5]'}`}
              >
                <div className="w-24 h-24 bg-gray-50 dark:bg-slate-800 rounded-2xl overflow-hidden shrink-0 relative">
                  {product.image ? (
                    <img src={assetUrl(product.image)} alt={product.name} loading="lazy" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-300 dark:text-slate-600"><Utensils aria-hidden="true" /></div>
                  )}
                  <ProductBadge product={product} />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-gray-800 dark:text-white line-clamp-1 group-hover:text-brand-ink dark:group-hover:text-brand-ink-dark transition-colors">{product.name}</h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2 my-1">{product.description}</p>
                  <div className="flex justify-between items-center mt-2 gap-2">
                    <PriceTag product={product} className="font-bold text-lg text-gray-900 dark:text-gray-100" />
                    <button
                      type="button"
                      disabled={!canOrder}
                      onClick={(event) => {
                        event.stopPropagation();
                        openProductModal(product);
                      }}
                      aria-label={canOrder ? `Adicionar ${product.name}` : `${product.name}: ${blockedLabel}`}
                      className={`p-2 rounded-xl transition-all shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-brand ${canOrder ? 'bg-gray-100 dark:bg-slate-800 text-gray-900 dark:text-white hover:bg-brand hover:text-brand-contrast' : 'bg-gray-200 text-gray-400 dark:bg-slate-800 dark:text-gray-600'}`}
                    >
                      <Plus size={16} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <ProductModal product={selectedProduct} isOpen={selectedProduct !== null} onClose={() => setSelectedProduct(null)} />
    </div>
  );
}

type ChipTone = 'green' | 'red' | 'amber' | 'neutral';

const CHIP_TONES: Record<ChipTone, string> = {
  green: 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800',
  red: 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800',
  amber: 'bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  neutral: 'bg-gray-50 dark:bg-slate-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-slate-700',
};

function Chip({ tone, icon, children }: { tone: ChipTone; icon: ReactNode; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border ${CHIP_TONES[tone]}`}>
      <span aria-hidden="true" className="inline-flex">{icon}</span>
      {children}
    </span>
  );
}

/** Selo do produto: OFERTA só com promoção de verdade (promocional menor que o preço); DESTAQUE para os marcados pela loja. */
function ProductBadge({ product, corner = 'left' }: { product: StorefrontProduct; corner?: 'left' | 'right' }) {
  const position = corner === 'left' ? 'top-0 left-0 rounded-br-xl' : 'top-0 right-0 rounded-bl-2xl';
  if (hasPromotion(product)) {
    return <span className={`absolute ${position} bg-red-600 text-white text-[10px] font-bold px-2.5 py-1 z-10 shadow-sm`}>OFERTA</span>;
  }
  if (product.is_highlight) {
    return (
      <span className={`absolute ${position} bg-amber-400 text-gray-900 text-[10px] font-bold px-2.5 py-1 z-10 shadow-sm inline-flex items-center gap-1`}>
        <Star size={10} className="fill-current" aria-hidden="true" /> DESTAQUE
      </span>
    );
  }
  return null;
}

/** Preço do produto; em promoção mostra o preço cheio riscado. */
function PriceTag({ product, className }: { product: StorefrontProduct; className: string }) {
  if (!hasPromotion(product)) return <span className={className}>{formatCurrency(effectivePrice(product))}</span>;
  return (
    <span className="flex items-baseline gap-1.5 flex-wrap">
      <span className="text-xs text-gray-400 line-through"><span className="sr-only">De </span>{formatCurrency(product.price)}</span>
      <span className={`${className} text-red-600 dark:text-red-400`}><span className="sr-only">por </span>{formatCurrency(effectivePrice(product))}</span>
    </span>
  );
}

// --- CARTÃO HORIZONTAL (combos e imperdíveis) ---
function ProductHorizontalCard({
  product, onOpen, disabled, blockedLabel,
}: { product: StorefrontProduct; onOpen: () => void; disabled: boolean; blockedLabel: string }) {
  return (
    <div
      onClick={disabled ? undefined : onOpen}
      className={`min-w-62.5 max-w-62.5 bg-white dark:bg-slate-900 p-4 rounded-3xl border border-gray-100 dark:border-slate-800 shadow-sm transition-all group relative overflow-hidden
        ${disabled ? 'opacity-80 cursor-not-allowed' : 'cursor-pointer hover:shadow-lg dark:hover:shadow-slate-900/50 hover:-translate-y-1'}`}
    >
      <ProductBadge product={product} corner="right" />

      <div className="h-36 bg-gray-50 dark:bg-slate-800 rounded-2xl mb-4 overflow-hidden relative">
        {product.image ? (
          <img src={assetUrl(product.image)} alt={product.name} loading="lazy" className={`w-full h-full object-cover transition-transform duration-700 ${disabled ? '' : 'group-hover:scale-110'}`} />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-300 dark:text-slate-600"><Utensils aria-hidden="true" /></div>
        )}
      </div>

      <h3 className="font-bold text-gray-800 dark:text-white line-clamp-1 text-lg mb-1">{product.name}</h3>
      <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-1 mb-4">{product.description}</p>

      <div className="flex justify-between items-center gap-2">
        <PriceTag product={product} className="font-extrabold text-xl text-gray-900 dark:text-gray-100" />
        <button
          type="button"
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          aria-label={disabled ? `${product.name}: ${blockedLabel}` : `Adicionar ${product.name}`}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-colors shadow-lg shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand
            ${disabled ? 'bg-gray-400 text-white dark:bg-slate-700 dark:text-gray-400' : 'bg-gray-900 dark:bg-brand text-white dark:text-brand-contrast hover:bg-brand hover:text-brand-contrast dark:hover:bg-brand-hover'}`}
        >
          {disabled ? (blockedLabel === 'loja fechada' ? 'Fechado' : 'Indisponível') : 'Adicionar'}
        </button>
      </div>
    </div>
  );
}
