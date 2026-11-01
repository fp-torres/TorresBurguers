import { useEffect } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { SearchX } from 'lucide-react';
import ClientLayout from '../ClientLayout';
import NotFound from '../../pages/NotFound';
import PageLoader from '../../components/PageLoader';
import { CARD_CLASS, ErrorState, buttonClass } from '../../components/ui';
import { CartProvider } from '../../contexts/CartContext';
import { StorefrontProvider, useOptionalStorefront } from '../../contexts/StorefrontContext';
import { APP_TITLE, BRAND } from '../../config/brand';
import { brandCssVariables, themeColorFor } from '../../services/storefrontDisplay';
import { forgetLastStore, rememberLastStore, storePath } from '../../utils/lastStore';
import { isValidStoreSlug } from '../../utils/validation';

/**
 * Vitrine de uma loja: /loja/:slug (cardápio), /loja/:slug/cart e /loja/:slug/order-success.
 * - StorefrontProvider (key = slug): perfil público, status com atualização automática e disponibilidade;
 * - CartProvider (key = id da loja): carrinho próprio de cada loja;
 * - identidade da loja: título da aba "<loja> | <plataforma>", cor principal (tokens --store-brand*) e
 *   cor da barra do navegador; tudo volta ao padrão da plataforma ao sair da loja;
 * - guarda a loja visitada (comestra.lastStore) e a esquece se a API responder 404;
 * - endereço alternativo (o perfil volta com outro slug, ex.: /loja/default): segue para o endereço canônico.
 */
export default function StoreLayout() {
  const { slug } = useParams();

  // Endereço fora do formato de slug: 404 com o layout da plataforma
  if (!slug || !isValidStoreSlug(slug)) {
    return (
      <ClientLayout>
        <NotFound />
      </ClientLayout>
    );
  }

  return (
    <StorefrontProvider key={slug} slug={slug}>
      <StoreShell />
    </StorefrontProvider>
  );
}

function StoreShell() {
  const storefront = useOptionalStorefront();
  const location = useLocation();
  const loadState = storefront?.loadState ?? 'loading';
  const store = storefront?.store ?? null;
  const slug = storefront?.slug ?? '';
  // O perfil veio com outro endereço (ex.: /loja/default → GET /stores/default responde a loja padrão):
  // a vitrine segue para o endereço canônico, porque as demais chamadas usam o slug da rota
  const canonicalSlug = loadState === 'ready' && store && store.slug !== slug && isValidStoreSlug(store.slug) ? store.slug : null;

  // Loja encontrada: vira a "última loja" (endereços antigos /cart e /order-success); 404: esquecida
  useEffect(() => {
    if (loadState === 'ready' && !canonicalSlug) rememberLastStore(slug);
    else if (loadState === 'not_found') forgetLastStore(slug);
  }, [loadState, slug, canonicalSlug]);

  const storeName = store?.name ?? null;
  const primaryColor = store?.primary_color ?? null;

  // Título da aba com o nome da loja (volta ao da plataforma ao sair)
  useEffect(() => {
    if (!storeName) return;
    document.title = `${storeName} | ${BRAND.name}`;
    return () => {
      document.title = APP_TITLE;
    };
  }, [storeName]);

  // Cor da loja nos tokens da vitrine (src/index.css) e na barra do navegador; inválida → laranja da plataforma
  useEffect(() => {
    if (loadState !== 'ready') return;
    const root = document.documentElement;
    const variables = brandCssVariables(primaryColor) ?? {};
    Object.entries(variables).forEach(([name, value]) => root.style.setProperty(name, value));

    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const previousThemeColor = meta?.content ?? null;
    if (meta) meta.content = themeColorFor(primaryColor);

    return () => {
      Object.keys(variables).forEach((name) => root.style.removeProperty(name));
      if (meta && previousThemeColor !== null) meta.content = previousThemeColor;
    };
  }, [loadState, primaryColor]);

  if (canonicalSlug) {
    const base = storePath(slug);
    const rest = location.pathname.startsWith(base) ? location.pathname.slice(base.length) : '';
    return (
      <Navigate
        to={{ pathname: `${storePath(canonicalSlug)}${rest}`, search: location.search, hash: location.hash }}
        state={location.state}
        replace
      />
    );
  }

  if (loadState === 'not_found') {
    return (
      <ClientLayout>
        <StoreNotFound slug={slug} />
      </ClientLayout>
    );
  }

  if (loadState === 'error') {
    return (
      <ClientLayout>
        <div className={`${CARD_CLASS} max-w-xl mx-auto mt-8`}>
          <ErrorState
            title="Não foi possível abrir a loja"
            message={storefront?.loadError ?? 'Verifique sua conexão e tente de novo.'}
            onRetry={storefront?.retry}
            action={<Link to="/" className={buttonClass('secondary')}>Ver outros estabelecimentos</Link>}
          />
        </div>
      </ClientLayout>
    );
  }

  if (loadState !== 'ready' || !store) return <StoreLoading />;

  return (
    <CartProvider key={store.id} storeId={store.id} storeSlug={store.slug}>
      <ClientLayout />
    </CartProvider>
  );
}

/** Loja inexistente ou desativada (404 da API). Mesmo visual do EmptyState do kit, com o título como h1. */
function StoreNotFound({ slug }: { slug: string }) {
  return (
    <section aria-labelledby="store-not-found-title" className={`${CARD_CLASS} max-w-xl mx-auto mt-8 flex flex-col items-center justify-center text-center gap-3 px-6 py-16`}>
      <div className="p-4 rounded-full bg-gray-100 dark:bg-slate-700/60 text-gray-400 dark:text-gray-500" aria-hidden="true">
        <SearchX size={36} />
      </div>
      <h1 id="store-not-found-title" className="text-lg font-bold text-gray-800 dark:text-gray-100">Loja não encontrada</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400 max-w-md">
        Não encontramos a loja <span className="font-mono font-bold text-gray-700 dark:text-gray-200 break-all">{slug}</span>.
        Ela pode ter mudado de endereço ou não estar mais disponível em {BRAND.name}.
      </p>
      <div className="mt-2 flex flex-col sm:flex-row gap-2">
        <Link to="/" className={buttonClass('primary')}>Ver estabelecimentos</Link>
        <Link to="/my-orders" className={buttonClass('secondary')}>Meus pedidos</Link>
      </div>
    </section>
  );
}

/** Primeira carga do perfil da loja: cabeçalho neutro (sem marca de outra loja) e indicador de carregamento. */
function StoreLoading() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950 flex flex-col transition-colors duration-300">
      <header className="bg-white dark:bg-slate-900 shadow-sm h-16 px-4 lg:px-8 flex items-center gap-3 border-b border-gray-100 dark:border-slate-800" aria-hidden="true">
        <div className="w-10 h-10 rounded-xl bg-gray-200 dark:bg-slate-800 animate-pulse" />
        <div className="h-5 w-40 rounded-lg bg-gray-200 dark:bg-slate-800 animate-pulse" />
      </header>
      <main className="flex-1">
        <PageLoader />
      </main>
    </div>
  );
}
