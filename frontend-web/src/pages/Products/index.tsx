import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Beef, Box, CheckCircle2, CirclePlus, CupSoda, Droplets, Edit2, IceCreamCone, LayoutGrid, PackageX, Plus,
  Popcorn, RotateCcw, Salad, Trash2, X, XCircle,
} from 'lucide-react';
import { Icon } from '@iconify/react';
import toast from 'react-hot-toast';
import {
  DataTable, FilterTabs, PageHeader, SearchInput, StatusBadge, buttonClass, cx, type DataTableColumn, type FilterTabOption,
} from '../../components/ui';
import CreateProductModal from '../../components/CreateProductModal';
import ConfirmModal from '../../components/ConfirmModal';
import { assetUrl, getApiErrorMessage } from '../../services/api';
import { productService, type Product } from '../../services/productService';
import { planRestrictionMessage } from '../../services/storeSubscriptionService';
import { usePanelStore } from '../../layouts/DefaultLayout/panelStore';
import { useResource } from '../../hooks/useResource';
import { toastPlanLimit } from '../../layouts/DefaultLayout/planLimit';
import LockedNotice from '../../layouts/DefaultLayout/LockedNotice';
import { PRODUCT_CATEGORIES, categoryLabel, effectivePrice, hasPromotion, normalizeSearch } from '../../utils/catalog';
import { formatCurrency } from '../../utils/format';

type CategoryId = (typeof PRODUCT_CATEGORIES)[number]['id'];
type Tab = 'todos' | CategoryId | 'lixeira';

/** Ícone de cada categoria do cardápio (as abas vêm de PRODUCT_CATEGORIES). */
const CATEGORY_ICONS: Record<CategoryId, ReactNode> = {
  hamburgueres: <Beef size={16} />,
  combos: <Box size={16} />,
  entradas: <Salad size={16} />,
  acompanhamentos: <Popcorn size={16} />,
  bebidas: <CupSoda size={16} />,
  sobremesas: <IceCreamCone size={16} />,
  molhos: <Droplets size={16} />,
  adicionais: <CirclePlus size={16} />,
};

interface PendingConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  isDestructive: boolean;
  action: () => Promise<void>;
}

/**
 * Painel da loja › Cardápio (/products; só Administrador): produtos da loja por categoria, disponibilidade,
 * edição, lixeira e restauração. Limites do plano (403) aparecem como aviso com o atalho para a Assinatura.
 */
export default function Products() {
  const panel = usePanelStore();
  const [activeTab, setActiveTab] = useState<Tab>('todos');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<{ open: boolean; product: Product | null }>({ open: false, product: null });
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [limitMessage, setLimitMessage] = useState<string | null>(null);

  const products = useResource((signal) => productService.getAll(signal), { errorMessage: 'Erro ao carregar produtos.' });
  const trash = useResource((signal) => productService.getTrash(signal), { errorMessage: 'Erro ao carregar a lixeira de produtos.' });

  const productList = useMemo(() => products.data ?? [], [products.data]);
  const trashList = useMemo(() => trash.data ?? [], [trash.data]);
  const inTrash = activeTab === 'lixeira';
  // Sessão de suporte ou loja que não pode ser alterada: a API recusaria qualquer mudança no cardápio (403)
  const locked = panel.locked;
  const lockTitle = panel.lockReason ?? undefined;

  // Uso de produtos no plano (GET /store/subscription, lido pelo layout); sem assinatura vigente não há limite a mostrar
  const planOverview = panel.subscription;
  const productUsage = planOverview?.limitsAvailable ? planOverview.usage.find((item) => item.key === 'products') ?? null : null;
  const atProductLimit = !!productUsage && productUsage.limit !== null && productUsage.used !== null && productUsage.used >= productUsage.limit;

  const tabs: FilterTabOption<Tab>[] = [
    { value: 'todos', label: 'Todos', count: productList.length, icon: <LayoutGrid size={16} /> },
    ...PRODUCT_CATEGORIES.map((category) => ({
      value: category.id,
      label: category.label,
      count: productList.filter((product) => product.category === category.id).length,
      icon: CATEGORY_ICONS[category.id],
    })),
    { value: 'lixeira', label: 'Lixeira', count: trashList.length, icon: <Trash2 size={16} /> },
  ];

  const filtered = useMemo(() => {
    const term = normalizeSearch(search);
    const source = inTrash ? trashList : productList;
    return source.filter((product) => {
      const matchesSearch = !term || normalizeSearch(product.name).includes(term) || normalizeSearch(product.description ?? '').includes(term);
      const matchesCategory = inTrash || activeTab === 'todos' || product.category === activeTab;
      return matchesSearch && matchesCategory;
    });
  }, [search, inTrash, trashList, productList, activeTab]);

  function reloadAll() {
    void products.reload({ silent: true });
    void trash.reload({ silent: true });
    void panel.refresh();
  }

  /** Limite/recurso do plano (403): aviso na tela e uso do plano atualizado no selo. */
  function showLimit(message: string) {
    setLimitMessage(message);
    void panel.refresh();
  }

  function handleRestricted(error: unknown, fallback: string) {
    const planMessage = planRestrictionMessage(error);
    if (planMessage) {
      showLimit(planMessage);
      toastPlanLimit(planMessage);
    } else {
      toast.error(getApiErrorMessage(error, fallback), { duration: 6000 });
    }
  }

  async function toggleAvailability(product: Product) {
    const available = !product.available;
    // Atualização otimista; a resposta da API confirma (ou a lista volta ao que estava)
    products.setData((current) => (current ?? []).map((item) => (item.id === product.id ? { ...item, available } : item)));
    try {
      const formData = new FormData();
      formData.append('available', String(available));
      await productService.update(product.id, formData);
      toast.success(available ? 'Produto Ativado!' : 'Produto Pausado!');
    } catch (error) {
      handleRestricted(error, 'Erro ao atualizar.');
      void products.reload({ silent: true });
    }
  }

  async function runConfirmed() {
    if (!pendingConfirm) return;
    setConfirming(true);
    try {
      await pendingConfirm.action();
    } finally {
      setConfirming(false);
      setPendingConfirm(null);
    }
  }

  function requestDelete(product: Product) {
    setPendingConfirm({
      title: 'Mover para Lixeira?',
      message: `O produto "${product.name}" deixará de aparecer no cardápio, mas poderá ser recuperado depois.`,
      confirmLabel: 'Mover para Lixeira',
      isDestructive: true,
      action: async () => {
        try {
          await productService.remove(product.id);
          toast.success('Produto movido para a lixeira.');
          reloadAll();
        } catch (error) {
          handleRestricted(error, 'Erro ao excluir.');
        }
      },
    });
  }

  function requestRestore(product: Product) {
    // A restauração mantém a disponibilidade que o produto tinha antes de ir para a lixeira
    setPendingConfirm({
      title: 'Restaurar Produto?',
      message: product.available
        ? `O produto "${product.name}" voltará para o cardápio como Disponível.`
        : `O produto "${product.name}" voltará para o cardápio, mas continuará Esgotado até você ativá-lo.`,
      confirmLabel: 'Sim, Restaurar',
      isDestructive: false,
      action: async () => {
        try {
          await productService.restore(product.id);
          toast.success('Produto restaurado!');
          reloadAll();
        } catch (error) {
          // 403 = limite de produtos do plano
          handleRestricted(error, 'Erro ao restaurar.');
        }
      },
    });
  }

  function requestPermanentDelete(product: Product) {
    setPendingConfirm({
      title: 'Excluir Permanentemente?',
      message: `ATENÇÃO: "${product.name}" será apagado para sempre. Produtos que já aparecem em pedidos não podem ser apagados (o histórico de vendas é preservado).`,
      confirmLabel: 'Apagar para Sempre',
      isDestructive: true,
      action: async () => {
        try {
          await productService.deletePermanent(product.id);
          toast.success('Produto excluído definitivamente.');
          void trash.reload({ silent: true });
        } catch (error) {
          // 409: o produto aparece em pedidos (a API explica o motivo)
          toast.error(getApiErrorMessage(error, 'Erro ao excluir.'), { duration: 6000 });
        }
      },
    });
  }

  const columns: DataTableColumn<Product>[] = [
    {
      key: 'product',
      header: 'Produto',
      className: 'w-[40%]',
      cell: (product) => {
        const muted = inTrash || !product.available;
        return (
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-gray-100 dark:bg-slate-700 rounded-lg overflow-hidden shrink-0 border border-gray-200 dark:border-slate-600">
              {product.image ? (
                <img
                  src={assetUrl(product.image)}
                  alt={product.name}
                  loading="lazy"
                  className={cx('w-full h-full object-cover transition-all duration-300', muted && 'grayscale opacity-75')}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-gray-400 dark:text-gray-500" aria-hidden="true"><PackageX size={20} /></div>
              )}
            </div>
            <div className="min-w-0">
              <p className={cx('font-bold truncate max-w-64', muted ? 'text-gray-500 dark:text-gray-400' : 'text-gray-800 dark:text-white')}>{product.name}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-64">{product.description}</p>
            </div>
          </div>
        );
      },
    },
    ...(!inTrash ? [{
      key: 'category',
      header: 'Categoria',
      className: 'hidden md:table-cell',
      headerClassName: 'hidden md:table-cell',
      cell: (product: Product) => (
        <span className="bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-2 py-1 rounded-md text-xs font-bold uppercase whitespace-nowrap">
          {categoryLabel(product.category)}
        </span>
      ),
    }] : []),
    {
      key: 'price',
      header: 'Preço',
      className: 'font-bold whitespace-nowrap',
      cell: (product) => (hasPromotion(product) ? (
        <div className="flex flex-col">
          <span className="text-xs font-medium text-gray-400 line-through">{formatCurrency(product.price)}</span>
          <span className="text-red-600 dark:text-red-400" title="Preço promocional">{formatCurrency(effectivePrice(product))}</span>
        </div>
      ) : formatCurrency(product.price)),
    },
    ...(!inTrash ? [{
      key: 'status',
      header: 'Status',
      align: 'center' as const,
      cell: (product: Product) => (
        <button
          type="button"
          onClick={() => void toggleAvailability(product)}
          disabled={locked}
          title={lockTitle ?? (product.available ? 'Clique para pausar (esgotado)' : 'Clique para voltar a vender')}
          className={cx(
            'px-3 py-1.5 rounded-full text-xs font-bold inline-flex items-center justify-center gap-1.5 w-28 border transition-all active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500',
            product.available
              ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 hover:border-red-200 dark:hover:border-red-800'
              : 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800 hover:bg-green-50 dark:hover:bg-green-900/20 hover:text-green-700 dark:hover:text-green-400 hover:border-green-200 dark:hover:border-green-800',
          )}
        >
          {product.available ? <><CheckCircle2 size={14} aria-hidden="true" /> Disponível</> : <><AlertTriangle size={14} aria-hidden="true" /> Esgotado</>}
        </button>
      ),
    }] : []),
    {
      key: 'actions',
      header: <span className="sr-only">Ações</span>,
      align: 'right',
      cell: (product) => (
        <div className="flex justify-end gap-2">
          {inTrash ? (
            <>
              <button type="button" onClick={() => requestRestore(product)} disabled={locked} aria-label="Restaurar" title={lockTitle ?? 'Restaurar'} className="p-2 text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 hover:bg-green-100 dark:hover:bg-green-900/40 rounded-lg transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
                <RotateCcw size={18} aria-hidden="true" />
              </button>
              <button type="button" onClick={() => requestPermanentDelete(product)} disabled={locked} aria-label="Excluir Definitivamente" title={lockTitle ?? 'Excluir Definitivamente'} className="p-2 text-white bg-red-500 hover:bg-red-600 rounded-lg transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
                <XCircle size={18} aria-hidden="true" />
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setModal({ open: true, product })} disabled={locked} aria-label="Editar" title={lockTitle ?? 'Editar'} className="p-2 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded-lg disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
                <Edit2 size={18} aria-hidden="true" />
              </button>
              <button type="button" onClick={() => requestDelete(product)} disabled={locked} aria-label="Mover para Lixeira" title={lockTitle ?? 'Mover para Lixeira'} className="p-2 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
                <Trash2 size={18} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      ),
    },
  ];

  const current = inTrash ? trash : products;
  const searching = search.trim() !== '';

  return (
    <div className="space-y-6 pb-20">
      <PageHeader
        title="Cardápio"
        subtitle="Gerencie seus produtos e estoque."
        icon={<Icon icon="solar:chef-hat-bold-duotone" width={26} />}
        actions={!inTrash && !locked ? (
          <button type="button" onClick={() => setModal({ open: true, product: null })} className={buttonClass('primary', 'lg')}>
            <Plus size={20} aria-hidden="true" /> Novo Produto
          </button>
        ) : undefined}
      >
        {productUsage && productUsage.limit !== null && (
          <StatusBadge tone={atProductLimit ? 'danger' : 'info'}>
            {productUsage.used ?? '—'} de {productUsage.limit} produtos do plano{planOverview?.plan?.name ? ` ${planOverview.plan.name}` : ''}
          </StatusBadge>
        )}
      </PageHeader>

      <LockedNotice subject="Cardápio" />

      {(limitMessage || atProductLimit) && (
        <div role="status" className="flex flex-wrap items-start gap-3 px-4 py-3 rounded-2xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
          <AlertTriangle size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
          <p className="flex-1 min-w-48">
            {limitMessage ?? 'O cardápio atingiu o limite de produtos do plano: novos produtos e restaurações da lixeira serão recusados.'}{' '}
            <Link to="/subscription" className="font-bold underline">Ver plano e limites</Link>
          </p>
          {limitMessage && (
            <button type="button" onClick={() => setLimitMessage(null)} aria-label="Fechar aviso" className="p-1 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/40">
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-700 transition-colors">
        {/* relative: os contadores (texto só para leitores de tela) ficam presos na área rolável das abas no celular */}
        <FilterTabs
          options={tabs}
          value={activeTab}
          onChange={setActiveTab}
          label="Filtrar por categoria"
          className="relative border-b border-gray-100 dark:border-slate-700"
        />
        <div className="p-4 bg-gray-50 dark:bg-slate-900/50 rounded-b-2xl">
          <SearchInput
            value={search}
            onChange={setSearch}
            delay={150}
            placeholder={inTrash ? 'Buscar na lixeira...' : 'Buscar produto...'}
            label={inTrash ? 'Buscar na lixeira de produtos' : 'Buscar produto no cardápio'}
          />
        </div>
      </div>

      <DataTable
        stackOnMobile
        caption={inTrash ? 'Produtos na lixeira' : 'Produtos do cardápio'}
        columns={columns}
        rows={filtered}
        rowKey={(product) => product.id}
        loading={current.loading}
        error={current.error}
        onRetry={() => void current.reload()}
        rowClassName={(product) => (inTrash || !product.available ? 'bg-gray-50 dark:bg-slate-800/50' : undefined)}
        emptyIcon={inTrash ? <Trash2 size={28} /> : <PackageX size={28} />}
        emptyTitle={inTrash && !searching ? 'A lixeira de produtos está vazia.' : 'Nenhum produto encontrado.'}
        emptyDescription={!inTrash && !searching && productList.length === 0 ? 'Cadastre o primeiro produto do cardápio.' : undefined}
        emptyAction={!inTrash && !searching && productList.length === 0 && !locked ? (
          <button type="button" onClick={() => setModal({ open: true, product: null })} className={buttonClass('primary', 'sm')}>
            <Plus size={14} aria-hidden="true" /> Novo Produto
          </button>
        ) : undefined}
      />

      <CreateProductModal
        isOpen={modal.open}
        onClose={() => setModal({ open: false, product: null })}
        onSuccess={reloadAll}
        productToEdit={modal.product}
        onLimitReached={showLimit}
      />
      <ConfirmModal
        isOpen={!!pendingConfirm}
        onClose={() => setPendingConfirm(null)}
        onConfirm={() => void runConfirmed()}
        closeOnConfirm={false}
        loading={confirming}
        title={pendingConfirm?.title ?? ''}
        message={pendingConfirm?.message ?? ''}
        confirmLabel={pendingConfirm?.confirmLabel}
        isDestructive={pendingConfirm?.isDestructive}
      />
    </div>
  );
}
