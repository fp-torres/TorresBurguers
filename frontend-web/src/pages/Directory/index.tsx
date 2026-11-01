import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Bike, CreditCard, MapPin, Store, Utensils, Zap } from 'lucide-react';
import ClientLayout from '../../layouts/ClientLayout';
import StoreLogo from '../../components/BrandLogo/StoreLogo';
import { EmptyState, ErrorState, Pagination, SearchInput, StatusBadge, buttonClass } from '../../components/ui';
import { usePaginatedQuery } from '../../hooks/usePaginatedQuery';
import { publicStoreService, type PublicStoreSummary } from '../../services/publicStoreService';
import { normalizeHexColor } from '../../services/storefrontDisplay';
import { BRAND } from '../../config/brand';
import { readLastStore, storePath } from '../../utils/lastStore';
import { isValidStoreSlug } from '../../utils/validation';

const PAGE_SIZE = 12;
/** Tamanho máximo da busca aceito pela API (GET /stores?search=). */
const SEARCH_MAX_LENGTH = 100;

const MERCHANT_BENEFITS = [
  { icon: Utensils, text: 'Cardápio digital com fotos, adicionais e promoções' },
  { icon: Bike, text: 'Pedidos para entrega e retirada no balcão' },
  { icon: CreditCard, text: 'PIX e cartão online na conta da sua loja' },
  { icon: Zap, text: 'Quadro de pedidos para cozinha, atendimento e entregadores' },
];

/**
 * Início da plataforma (/): apresentação, diretório de lojas (GET /stores?page&pageSize&search: só lojas
 * vendendo, abertas primeiro) com busca e paginação, atalho para a última loja visitada e o convite para
 * cadastrar um estabelecimento (/cadastrar-loja). Cabeçalho e rodapé da plataforma (ClientLayout): entrar,
 * conta, tema e o carrinho da última loja.
 */
export default function Directory() {
  const [lastStore] = useState(readLastStore);

  const query = usePaginatedQuery<PublicStoreSummary>({
    fetcher: ({ page, pageSize, search, signal }) =>
      publicStoreService.list({ page, pageSize, search: search.slice(0, SEARCH_MAX_LENGTH) }, signal),
    initialPageSize: PAGE_SIZE,
    errorMessage: 'Não foi possível carregar os estabelecimentos.',
  });

  // Só lojas com endereço válido viram cartões clicáveis
  const stores = query.items.filter((store) => isValidStoreSlug(store.slug));
  const showSkeleton = query.loading && stores.length === 0;
  const searching = query.search.trim() !== '';

  return (
    <ClientLayout fullWidth>
      {/* --- APRESENTAÇÃO DA PLATAFORMA --- */}
      <section aria-labelledby="hero-title" className="relative overflow-hidden bg-linear-to-br from-orange-600 to-orange-700 dark:from-orange-700 dark:to-orange-900 text-white">
        <div className="absolute -right-24 -top-24 w-96 h-96 rounded-full bg-white/10 blur-2xl" aria-hidden="true" />
        <div className="absolute -left-16 bottom-0 w-72 h-72 rounded-full bg-black/10 blur-2xl" aria-hidden="true" />
        <div className="relative max-w-4xl mx-auto px-4 lg:px-8 py-12 sm:py-16 text-center space-y-5">
          <p className="text-xs font-bold uppercase tracking-widest text-orange-100">{BRAND.name}</p>
          <h1 id="hero-title" className="text-3xl sm:text-5xl font-extrabold leading-tight">
            Peça nos estabelecimentos da sua região
          </h1>
          <p className="text-orange-50 text-base sm:text-lg max-w-2xl mx-auto">
            {BRAND.tagline} Escolha uma loja, monte o pedido e acompanhe tudo em tempo real.
          </p>
          <div className="max-w-xl mx-auto text-left">
            <SearchInput
              value={query.search}
              onChange={query.setSearch}
              placeholder="Buscar por nome, bairro ou cidade"
              label="Buscar estabelecimento"
            />
          </div>
          {lastStore && (
            <Link
              to={storePath(lastStore)}
              className="inline-flex items-center gap-1.5 text-sm font-bold text-white bg-white/15 hover:bg-white/25 px-4 py-2 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              Continuar na última loja visitada <ArrowRight size={16} aria-hidden="true" />
            </Link>
          )}
        </div>
      </section>

      {/* --- DIRETÓRIO --- */}
      <section id="estabelecimentos" aria-labelledby="directory-title" className="max-w-7xl mx-auto px-4 lg:px-8 py-10 space-y-5 scroll-mt-20">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="directory-title" className="text-xl font-bold text-gray-800 dark:text-gray-100">
              {searching ? 'Resultados da busca' : 'Estabelecimentos'}
            </h2>
            {!showSkeleton && !query.error && (
              <p className="text-sm text-gray-500 dark:text-gray-400" aria-live="polite">
                {query.total === 1 ? '1 estabelecimento' : `${query.total} estabelecimentos`}
                {searching ? ` para "${query.search.trim()}"` : ' recebendo pedidos pelo site'}
              </p>
            )}
          </div>
        </div>

        {showSkeleton ? (
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" aria-busy="true">
            {Array.from({ length: 6 }, (_, index) => (
              <li key={index} className="h-32 rounded-2xl bg-gray-200 dark:bg-slate-800 animate-pulse" aria-hidden="true" />
            ))}
            <li className="sr-only" role="status">Carregando estabelecimentos...</li>
          </ul>
        ) : query.error && stores.length === 0 ? (
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-gray-100 dark:border-slate-800">
            <ErrorState message={query.error} onRetry={() => void query.reload()} />
          </div>
        ) : stores.length === 0 ? (
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-gray-100 dark:border-slate-800">
            <EmptyState
              icon={<Store size={36} />}
              title={searching ? 'Nenhum estabelecimento encontrado' : 'Nenhum estabelecimento disponível ainda'}
              description={searching ? 'Confira o nome ou tente outra busca.' : 'Em breve novas lojas por aqui. Tem um estabelecimento? Cadastre-se!'}
              action={searching ? (
                <button type="button" onClick={() => query.setSearch('')} className={buttonClass('secondary')}>Limpar busca</button>
              ) : (
                <Link to="/cadastrar-loja" className={buttonClass('primary')}>Cadastre seu estabelecimento</Link>
              )}
            />
          </div>
        ) : (
          <ul className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 ${query.loading ? 'opacity-60 transition-opacity' : ''}`}>
            {stores.map((store) => (
              <li key={store.slug}>
                <StoreCard store={store} />
              </li>
            ))}
          </ul>
        )}

        {query.total > query.pageSize && (
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-gray-100 dark:border-slate-800">
            <Pagination
              page={query.page}
              pageSize={query.pageSize}
              total={query.total}
              onPageChange={query.setPage}
              disabled={query.loading}
              itemLabel="estabelecimentos"
            />
          </div>
        )}
      </section>

      {/* --- CONVITE PARA LOJISTAS --- */}
      <section aria-labelledby="merchant-title" className="max-w-7xl mx-auto px-4 lg:px-8 pb-12">
        <div className="rounded-3xl bg-white dark:bg-slate-900 border border-gray-100 dark:border-slate-800 shadow-sm p-6 sm:p-10 grid gap-8 lg:grid-cols-2 lg:items-center">
          <div className="space-y-3">
            <p className="text-xs font-bold uppercase tracking-widest text-orange-700 dark:text-orange-400">Para estabelecimentos</p>
            <h2 id="merchant-title" className="text-2xl sm:text-3xl font-extrabold text-gray-900 dark:text-white">
              Venda online com a sua marca no {BRAND.name}
            </h2>
            <p className="text-gray-500 dark:text-gray-400">
              Crie a loja em poucos minutos, monte o cardápio e comece a receber pedidos pelo site.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 pt-2">
              <Link to="/cadastrar-loja" className={buttonClass('primary', 'lg')}>
                Cadastre seu estabelecimento <ArrowRight size={16} aria-hidden="true" />
              </Link>
              <Link to="/login" className={buttonClass('secondary', 'lg')}>Já tenho conta</Link>
            </div>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {MERCHANT_BENEFITS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 rounded-2xl bg-gray-50 dark:bg-slate-800 p-4 text-sm font-medium text-gray-700 dark:text-gray-200">
                <span className="p-2 rounded-xl bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 shrink-0" aria-hidden="true"><Icon size={18} /></span>
                {text}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </ClientLayout>
  );
}

/** Cartão de uma loja no diretório: logo (ou inicial na cor da loja), nome, descrição, cidade e se está aberta. */
function StoreCard({ store }: { store: PublicStoreSummary }) {
  const name = typeof store.name === 'string' && store.name.trim() ? store.name.trim() : store.slug;
  const place = [store.address_city, store.address_state].filter(Boolean).join(' - ');
  const color = normalizeHexColor(store.primary_color);

  return (
    <Link
      to={storePath(store.slug)}
      className="group relative flex items-start gap-4 h-full p-4 pt-5 rounded-2xl bg-white dark:bg-slate-900 border border-gray-100 dark:border-slate-800 shadow-sm hover:shadow-lg hover:-translate-y-0.5 transition-all overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
    >
      {/* Faixa com a cor da loja (ou o laranja da plataforma) */}
      <span className="absolute inset-x-0 top-0 h-1.5" style={{ backgroundColor: color ?? BRAND.color }} aria-hidden="true" />
      <StoreLogo name={name} logo={store.logo} color={color ?? BRAND.color} size={64} decorative />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="font-bold text-gray-800 dark:text-white truncate group-hover:text-orange-700 dark:group-hover:text-orange-400 transition-colors">{name}</p>
        {store.description && <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">{store.description}</p>}
        <div className="flex flex-wrap items-center gap-2">
          {typeof store.is_open === 'boolean' && (
            <StatusBadge tone={store.is_open ? 'success' : 'neutral'} dot>{store.is_open ? 'Aberto agora' : 'Fechado'}</StatusBadge>
          )}
          {place && (
            <span className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 min-w-0">
              <MapPin size={12} className="shrink-0" aria-hidden="true" /> <span className="truncate">{place}</span>
            </span>
          )}
        </div>
      </div>
      <ArrowRight size={18} className="text-gray-300 dark:text-slate-600 group-hover:text-orange-500 shrink-0 self-center transition-colors" aria-hidden="true" />
    </Link>
  );
}
