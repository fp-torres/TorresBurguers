import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Icon } from '@iconify/react';
import { CalendarClock, ChevronRight, Plus, Store } from 'lucide-react';
import {
  DataTable, FilterTabs, FormField, PageHeader, Pagination, SearchInput, StatusBadge, buttonClass, fieldControlClass,
  type DataTableColumn, type FilterTabOption,
} from '../../../components/ui';
import StoreLogo from '../../../components/BrandLogo/StoreLogo';
import { usePaginatedQuery } from '../../../hooks/usePaginatedQuery';
import { DEFAULT_PAGE_SIZE } from '../../../services/api';
import {
  platformStoresService, type PlatformStoreListItem, type SortOrder, type StoreSortField, type StoreSubscriptionFilter,
} from '../../../services/platform/storesService';
import type { StoreAccountStatus } from '../../../types/saas';
import { STORE_ACCOUNT_STATUS, SUBSCRIPTION_STATUS, statusMeta } from '../../../utils/saasStatus';
import { formatCurrency } from '../../../utils/format';
import { usePlanOptions } from '../Plans/usePlanOptions';
import { formatDate } from '../../../utils/dates';

type AccountFilter = 'ALL' | StoreAccountStatus;
type SubscriptionFilter = 'ALL' | StoreSubscriptionFilter;
type SortValue = `${StoreSortField}:${SortOrder}`;
type StoreFilters = { account_status: AccountFilter; plan_id: number | null; subscription_status: SubscriptionFilter; sort: SortValue };

const DEFAULT_FILTERS: StoreFilters = { account_status: 'ALL', plan_id: null, subscription_status: 'ALL', sort: 'created_at:desc' };
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

const ACCOUNT_TABS: FilterTabOption<AccountFilter>[] = [
  { value: 'ALL', label: 'Todos' },
  { value: 'ACTIVE', label: 'Ativos' },
  { value: 'SUSPENDED', label: 'Suspensos' },
  { value: 'INACTIVE', label: 'Desativados' },
];

const SUBSCRIPTION_OPTIONS: { value: SubscriptionFilter; label: string }[] = [
  { value: 'ALL', label: 'Todas as situações' },
  { value: 'TRIALING', label: 'Em teste' },
  { value: 'ACTIVE', label: 'Ativa' },
  { value: 'PAST_DUE', label: 'Inadimplente' },
  { value: 'SUSPENDED', label: 'Suspensa' },
  { value: 'CANCELED', label: 'Cancelada (sem outra vigente)' },
  { value: 'NONE', label: 'Sem assinatura' },
];

const SORT_OPTIONS: { value: SortValue; label: string }[] = [
  { value: 'created_at:desc', label: 'Mais recentes' },
  { value: 'created_at:asc', label: 'Mais antigos' },
  { value: 'name:asc', label: 'Nome (A–Z)' },
  { value: 'name:desc', label: 'Nome (Z–A)' },
  { value: 'slug:asc', label: 'Endereço (A–Z)' },
  { value: 'slug:desc', label: 'Endereço (Z–A)' },
];

function pick<T extends string>(value: string | null, options: readonly { value: T }[], fallback: T): T {
  return options.find((option) => option.value === value)?.value ?? fallback;
}

/** Estado inicial a partir da URL (?q=&situacao=&plano=&assinatura=&ordem=&pagina=&por_pagina=). */
function readUrlState(params: URLSearchParams) {
  const planId = Number(params.get('plano'));
  const page = Number(params.get('pagina'));
  const pageSize = Number(params.get('por_pagina'));
  return {
    search: params.get('q') ?? '',
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: PAGE_SIZE_OPTIONS.includes(pageSize) ? pageSize : DEFAULT_PAGE_SIZE,
    filters: {
      account_status: pick(params.get('situacao'), ACCOUNT_TABS, 'ALL'),
      plan_id: Number.isInteger(planId) && planId > 0 ? planId : null,
      subscription_status: pick(params.get('assinatura'), SUBSCRIPTION_OPTIONS, 'ALL'),
      sort: pick(params.get('ordem'), SORT_OPTIONS, DEFAULT_FILTERS.sort),
    } satisfies StoreFilters,
  };
}

function urlFor(state: { search: string; page: number; pageSize: number; filters: StoreFilters }): string {
  const params = new URLSearchParams();
  if (state.search.trim()) params.set('q', state.search.trim());
  if (state.filters.account_status !== 'ALL') params.set('situacao', state.filters.account_status);
  if (state.filters.plan_id !== null) params.set('plano', String(state.filters.plan_id));
  if (state.filters.subscription_status !== 'ALL') params.set('assinatura', state.filters.subscription_status);
  if (state.filters.sort !== DEFAULT_FILTERS.sort) params.set('ordem', state.filters.sort);
  if (state.page > 1) params.set('pagina', String(state.page));
  if (state.pageSize !== DEFAULT_PAGE_SIZE) params.set('por_pagina', String(state.pageSize));
  return params.toString();
}

/** Marca, no estado da navegação, as atualizações da URL feitas pela própria lista. */
const LIST_SYNC_STATE = { storesListSync: true };

function isListSync(state: unknown): boolean {
  return !!state && typeof state === 'object' && (state as { storesListSync?: unknown }).storesListSync === true;
}

/**
 * Superpainel › Estabelecimentos (/platform/stores): lista paginada no servidor (GET /platform/stores) com busca,
 * filtros por situação, plano e assinatura, ordenação e os indicadores de 30 dias (pedidos e GMV). Filtros ficam na
 * URL: voltar do detalhe mantém a mesma lista. Uma navegação de fora (ex.: o menu) recomeça a lista pela URL nova.
 */
export default function PlatformStores() {
  const location = useLocation();
  const [listKey, setListKey] = useState(location.key);
  if (!isListSync(location.state) && location.key !== listKey) setListKey(location.key);
  return <StoresList key={listKey} />;
}

function StoresList() {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [initial] = useState(() => readUrlState(searchParams));
  const planOptions = usePlanOptions();

  const query = usePaginatedQuery<PlatformStoreListItem, StoreFilters>({
    fetcher: ({ page, pageSize, search, filters, signal }) => {
      const [sort, order] = filters.sort.split(':') as [StoreSortField, SortOrder];
      return platformStoresService.list({
        page,
        pageSize,
        search,
        account_status: filters.account_status === 'ALL' ? undefined : filters.account_status,
        plan_id: filters.plan_id ?? undefined,
        subscription_status: filters.subscription_status === 'ALL' ? undefined : filters.subscription_status,
        sort,
        order,
      }, signal);
    },
    initialFilters: initial.filters,
    initialPage: initial.page,
    initialPageSize: initial.pageSize,
    initialSearch: initial.search,
    errorMessage: 'Não foi possível carregar os estabelecimentos.',
  });

  // A URL acompanha a lista (substitui a entrada do histórico: voltar sai da tela, não desfaz filtros)
  const nextUrl = urlFor({ search: query.search, page: query.page, pageSize: query.pageSize, filters: query.filters });
  const lastUrl = useRef(searchParams.toString());
  useEffect(() => {
    if (nextUrl === lastUrl.current) return;
    lastUrl.current = nextUrl;
    setSearchParams(new URLSearchParams(nextUrl), { replace: true, state: LIST_SYNC_STATE });
  }, [nextUrl, setSearchParams]);

  const { filters } = query;
  const filtered = query.search.trim() !== '' || filters.account_status !== 'ALL' || filters.plan_id !== null || filters.subscription_status !== 'ALL';
  const backState = { from: `${location.pathname}${location.search}` };

  function clearFilters() {
    query.setFilters({ ...DEFAULT_FILTERS, sort: filters.sort });
    query.setSearch('');
  }

  const columns: DataTableColumn<PlatformStoreListItem>[] = [
    {
      key: 'store',
      header: 'Estabelecimento',
      cell: (store) => (
        <div className="flex items-center gap-3 min-w-0">
          <StoreLogo name={store.name} logo={store.logo} size={36} decorative />
          <div className="min-w-0">
            <Link
              to={`/platform/stores/${store.id}`}
              state={backState}
              className="font-bold text-gray-800 dark:text-white hover:text-orange-700 dark:hover:text-orange-400 hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 wrap-break-word"
            >
              {store.name}
            </Link>
            <p className="font-mono text-xs text-gray-500 dark:text-gray-400 truncate max-w-56">/{store.slug}</p>
            {store.owner && <p className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-56" title={store.owner.email}>{store.owner.name || store.owner.email}</p>}
            <p className="2xl:hidden text-xs text-gray-400 dark:text-gray-500">Criado em {formatDate(store.created_at)}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'account',
      header: 'Situação',
      cell: (store) => {
        const meta = statusMeta(STORE_ACCOUNT_STATUS, store.account_status);
        return (
          <div className="flex flex-col gap-1">
            <StatusBadge tone={meta.tone} dot>{meta.label}</StatusBadge>
            {store.account_status === 'ACTIVE' && (
              <span className="text-xs text-gray-500 dark:text-gray-400">{store.is_open ? 'Aberta agora' : 'Fechada agora'}</span>
            )}
          </div>
        );
      },
    },
    {
      key: 'plan',
      header: 'Plano e assinatura',
      cell: (store) => {
        if (!store.subscription) {
          return <StatusBadge tone="danger">Sem assinatura</StatusBadge>;
        }
        const meta = statusMeta(SUBSCRIPTION_STATUS, store.subscription.status);
        return (
          <div className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">{store.plan?.name ?? 'Plano não informado'}</span>
            <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
            {store.subscription.status === 'TRIALING' && store.subscription.trial_ends_at && (
              <span className="text-xs text-gray-500 dark:text-gray-400">Teste até {formatDate(store.subscription.trial_ends_at)}</span>
            )}
            {store.subscription.cancel_at_period_end && store.subscription.status !== 'CANCELED' && (
              <StatusBadge tone="warning" icon={<CalendarClock size={12} />}>Cancela em {formatDate(store.subscription.current_period_end)}</StatusBadge>
            )}
          </div>
        );
      },
    },
    {
      key: 'staff',
      header: 'Equipe',
      align: 'center',
      className: 'hidden md:table-cell tabular-nums',
      headerClassName: 'hidden md:table-cell',
      cell: (store) => store.staff_count,
    },
    {
      key: 'orders',
      mobileLabel: 'Pedidos 30d',
      header: <span title="Pedidos não cancelados nos últimos 30 dias">Pedidos 30d</span>,
      align: 'right',
      className: 'hidden md:table-cell tabular-nums',
      headerClassName: 'hidden md:table-cell',
      cell: (store) => store.orders_30d,
    },
    {
      key: 'gmv',
      mobileLabel: 'GMV 30d',
      header: <span title="Pedidos pagos e não cancelados nos últimos 30 dias (vendas da loja, não receita da plataforma)">GMV 30d</span>,
      align: 'right',
      className: 'hidden lg:table-cell tabular-nums whitespace-nowrap',
      headerClassName: 'hidden lg:table-cell',
      cell: (store) => formatCurrency(store.gmv_30d),
    },
    {
      key: 'created',
      mobile: 'hidden',
      header: 'Criado em',
      className: 'hidden 2xl:table-cell whitespace-nowrap',
      headerClassName: 'hidden 2xl:table-cell',
      cell: (store) => formatDate(store.created_at),
    },
    {
      key: 'open',
      mobile: 'actions',
      header: <span className="sr-only">Abrir</span>,
      align: 'right',
      className: 'w-12',
      cell: (store) => (
        <Link
          to={`/platform/stores/${store.id}`}
          state={backState}
          aria-label={`Ver detalhes de ${store.name}`}
          title="Ver detalhes"
          className={buttonClass('ghost', 'icon')}
        >
          <ChevronRight size={18} aria-hidden="true" />
        </Link>
      ),
    },
  ];

  return (
    <div className="space-y-6 pb-20">
      <PageHeader
        title="Estabelecimentos"
        subtitle="Lojas da plataforma, situação cadastral, plano e assinatura"
        icon={<Icon icon="solar:shop-bold-duotone" width={26} />}
        actions={(
          <Link to="/platform/stores/new" className={buttonClass('primary')}>
            <Plus size={18} aria-hidden="true" /> Novo estabelecimento
          </Link>
        )}
      >
        <div className="space-y-3">
          <div className="flex flex-col lg:flex-row lg:items-end gap-3">
            <SearchInput
              value={query.search}
              onChange={query.setSearch}
              placeholder="Buscar por nome, endereço, razão social, e-mail ou CNPJ..."
              label="Buscar estabelecimentos"
              className="flex-1 lg:max-w-md"
            />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 flex-1">
              <FormField label="Plano">
                {(field) => (
                  <select
                    {...field}
                    value={filters.plan_id ?? ''}
                    onChange={(event) => query.setFilter('plan_id', event.target.value ? Number(event.target.value) : null)}
                    className={fieldControlClass()}
                  >
                    <option value="">Todos os planos</option>
                    {planOptions.plans.map((plan) => (
                      <option key={plan.id} value={plan.id}>{plan.name}{plan.status === 'INACTIVE' ? ' (indisponível)' : ''}</option>
                    ))}
                  </select>
                )}
              </FormField>
              <FormField label="Assinatura">
                {(field) => (
                  <select
                    {...field}
                    value={filters.subscription_status}
                    onChange={(event) => query.setFilter('subscription_status', pick(event.target.value, SUBSCRIPTION_OPTIONS, 'ALL'))}
                    className={fieldControlClass()}
                  >
                    {SUBSCRIPTION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                )}
              </FormField>
              <FormField label="Ordenar por">
                {(field) => (
                  <select
                    {...field}
                    value={filters.sort}
                    onChange={(event) => query.setFilter('sort', pick(event.target.value, SORT_OPTIONS, DEFAULT_FILTERS.sort))}
                    className={fieldControlClass()}
                  >
                    {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                )}
              </FormField>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <FilterTabs
              label="Filtrar por situação da loja"
              options={ACCOUNT_TABS}
              value={filters.account_status}
              onChange={(value) => query.setFilter('account_status', value)}
              className="-mx-2"
            />
            {filtered && <button type="button" onClick={clearFilters} className={buttonClass('ghost', 'sm')}>Limpar filtros</button>}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Pedidos 30d: não cancelados. GMV 30d: pedidos pagos e não cancelados nos últimos 30 dias — dinheiro das lojas, não é receita da plataforma.
          </p>
        </div>
      </PageHeader>

      <DataTable
        stackOnMobile
        caption="Estabelecimentos da plataforma"
        columns={columns}
        rows={query.items}
        rowKey={(store) => store.id}
        loading={query.loading}
        error={query.error}
        onRetry={() => void query.reload()}
        rowClassName={(store) => (store.account_status === 'INACTIVE' ? 'opacity-75' : undefined)}
        emptyIcon={<Store size={32} />}
        emptyTitle={filtered ? 'Nenhum estabelecimento encontrado' : 'Nenhum estabelecimento ainda'}
        emptyDescription={filtered ? 'Ajuste a busca ou os filtros.' : 'Cadastre o primeiro estabelecimento da plataforma.'}
        emptyAction={filtered
          ? <button type="button" onClick={clearFilters} className={buttonClass('secondary', 'sm')}>Limpar filtros</button>
          : <Link to="/platform/stores/new" className={buttonClass('primary', 'sm')}><Plus size={14} aria-hidden="true" /> Novo estabelecimento</Link>}
        footer={query.total > 0 ? (
          <Pagination
            page={query.page}
            pageSize={query.pageSize}
            total={query.total}
            onPageChange={query.setPage}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            onPageSizeChange={query.setPageSize}
            disabled={query.loading}
            itemLabel="estabelecimentos"
          />
        ) : undefined}
      />
    </div>
  );
}
