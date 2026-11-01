import { Link } from 'react-router-dom';
import { CalendarClock, CreditCard, Settings2 } from 'lucide-react';
import {
  DataTable, FilterTabs, FormField, Pagination, SearchInput, StatusBadge, buttonClass, fieldControlClass,
  type DataTableColumn, type FilterTabOption,
} from '../../../components/ui';
import type { PaginatedQuery } from '../../../hooks/usePaginatedQuery';
import type { PlatformPlan, PlatformSubscriptionItem } from '../../../services/platform/billingParsers';
import type { SubscriptionStatus } from '../../../types/saas';
import { STORE_ACCOUNT_STATUS, SUBSCRIPTION_STATUS, statusMeta } from '../../../utils/saasStatus';
import { planPriceLabel, providerShortLabel } from './billingDisplay';
import { formatDate } from '../../../utils/dates';

export type SubscriptionStatusFilter = 'ALL' | SubscriptionStatus;
export type SubscriptionFilters = { status: SubscriptionStatusFilter; plan_id: number | null };

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

const STATUS_TABS: FilterTabOption<SubscriptionStatusFilter>[] = [
  { value: 'ALL', label: 'Todas' },
  { value: 'TRIALING', label: 'Em teste' },
  { value: 'ACTIVE', label: 'Ativas' },
  { value: 'PAST_DUE', label: 'Inadimplentes' },
  { value: 'SUSPENDED', label: 'Suspensas' },
  { value: 'CANCELED', label: 'Canceladas' },
];

interface SubscriptionsListProps {
  /** GET /platform/subscriptions (a tela recarrega depois das ações do diálogo de detalhe). */
  query: PaginatedQuery<PlatformSubscriptionItem, SubscriptionFilters>;
  /** Planos do filtro. */
  plans: PlatformPlan[];
  /** Abre o detalhe (diálogo) de uma assinatura. */
  onOpen: (subscription: PlatformSubscriptionItem) => void;
}

/** Lista paginada de assinaturas com filtro por situação, plano e busca pela loja (nome ou slug). */
export default function SubscriptionsList({ query, plans, onOpen }: SubscriptionsListProps) {
  const filtered = query.search.trim() !== '' || query.filters.status !== 'ALL' || query.filters.plan_id !== null;

  const columns: DataTableColumn<PlatformSubscriptionItem>[] = [
    {
      key: 'store',
      header: 'Estabelecimento',
      cell: (item) => (
        <div className="min-w-0">
          {item.store ? (
            <Link
              to={`/platform/stores/${item.store.id}?tab=subscription`}
              className="font-bold text-gray-800 dark:text-white hover:text-orange-700 dark:hover:text-orange-400 hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              {item.store.name}
            </Link>
          ) : (
            <span className="font-bold text-gray-800 dark:text-white">Estabelecimento #{item.store_id}</span>
          )}
          <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
            {item.store?.slug && <span className="font-mono text-xs text-gray-500 dark:text-gray-400">/{item.store.slug}</span>}
            {item.store && item.store.account_status !== 'ACTIVE' && (
              <StatusBadge tone={statusMeta(STORE_ACCOUNT_STATUS, item.store.account_status).tone}>
                Loja {statusMeta(STORE_ACCOUNT_STATUS, item.store.account_status).label.toLowerCase()}
              </StatusBadge>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'plan',
      header: 'Plano',
      cell: (item) => (
        <div>
          <p className="font-semibold text-gray-800 dark:text-gray-100">{item.plan?.name ?? `Plano #${item.plan_id}`}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
            {item.plan ? planPriceLabel(item.plan.price, item.plan.billing_interval) : '—'}
            {item.plan?.status === 'INACTIVE' && ' · indisponível'}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Situação',
      cell: (item) => {
        const meta = statusMeta(SUBSCRIPTION_STATUS, item.status);
        return (
          <div className="flex flex-col gap-1">
            <StatusBadge tone={meta.tone} dot>{meta.label}</StatusBadge>
            {item.cancel_at_period_end && item.status !== 'CANCELED' && (
              <StatusBadge tone="warning" icon={<CalendarClock size={12} />}>Cancelamento agendado</StatusBadge>
            )}
          </div>
        );
      },
    },
    {
      key: 'period',
      header: 'Período',
      className: 'hidden md:table-cell whitespace-nowrap text-xs',
      headerClassName: 'hidden md:table-cell',
      cell: (item) => <PeriodSummary item={item} />,
    },
    {
      key: 'provider',
      header: 'Cobrança',
      className: 'hidden xl:table-cell text-xs',
      headerClassName: 'hidden xl:table-cell',
      cell: (item) => providerShortLabel(item.billing_provider),
    },
    {
      key: 'created',
      header: 'Criada em',
      className: 'hidden lg:table-cell whitespace-nowrap',
      headerClassName: 'hidden lg:table-cell',
      cell: (item) => formatDate(item.created_at),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Ações</span>,
      align: 'right',
      cell: (item) => (
        <button
          type="button"
          onClick={() => onOpen(item)}
          aria-label={`Gerenciar a assinatura de ${item.store?.name ?? `estabelecimento #${item.store_id}`}`}
          className={buttonClass('secondary', 'sm')}
        >
          <Settings2 size={14} aria-hidden="true" /> <span className="hidden sm:inline">Gerenciar</span>
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col lg:flex-row lg:items-end gap-3">
        <SearchInput
          value={query.search}
          onChange={query.setSearch}
          placeholder="Buscar pela loja (nome ou endereço)..."
          label="Buscar assinaturas pela loja"
          className="flex-1 lg:max-w-md"
        />
        <FormField label="Plano" className="lg:w-72">
          {(field) => (
            <select
              {...field}
              value={query.filters.plan_id ?? ''}
              onChange={(event) => query.setFilter('plan_id', event.target.value ? Number(event.target.value) : null)}
              className={fieldControlClass()}
            >
              <option value="">Todos os planos</option>
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>{plan.name} ({plan.code}){plan.status === 'INACTIVE' ? ' · indisponível' : ''}</option>
              ))}
            </select>
          )}
        </FormField>
        {filtered && (
          <button type="button" onClick={query.reset} className={buttonClass('ghost')}>Limpar filtros</button>
        )}
      </div>

      <FilterTabs
        label="Filtrar por situação da assinatura"
        options={STATUS_TABS}
        value={query.filters.status}
        onChange={(value) => query.setFilter('status', value)}
        className="-mx-2"
      />

      <DataTable
        stackOnMobile
        caption="Assinaturas dos estabelecimentos"
        columns={columns}
        rows={query.items}
        rowKey={(item) => item.id}
        loading={query.loading}
        error={query.error}
        onRetry={() => void query.reload()}
        emptyIcon={<CreditCard size={32} />}
        emptyTitle={filtered ? 'Nenhuma assinatura encontrada' : 'Nenhuma assinatura ainda'}
        emptyDescription={filtered
          ? 'Ajuste a busca ou os filtros.'
          : 'As assinaturas aparecem aqui quando um estabelecimento contrata um plano.'}
        emptyAction={filtered ? <button type="button" onClick={query.reset} className={buttonClass('secondary', 'sm')}>Limpar filtros</button> : undefined}
        footer={query.total > 0 ? (
          <Pagination
            page={query.page}
            pageSize={query.pageSize}
            total={query.total}
            onPageChange={query.setPage}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            onPageSizeChange={query.setPageSize}
            disabled={query.loading}
            itemLabel="assinaturas"
          />
        ) : undefined}
      />
    </div>
  );
}

function PeriodSummary({ item }: { item: PlatformSubscriptionItem }) {
  if (item.status === 'CANCELED') return <span>Cancelada em {formatDate(item.canceled_at)}</span>;
  return (
    <div className="space-y-0.5">
      {item.status === 'TRIALING' && item.trial_ends_at && <p>Teste até {formatDate(item.trial_ends_at)}</p>}
      {item.status !== 'TRIALING' && (
        <p>{item.current_period_end ? `${item.cancel_at_period_end ? 'Termina' : 'Renova'} em ${formatDate(item.current_period_end)}` : 'Sem vencimento'}</p>
      )}
      {item.past_due_since && <p className="text-amber-700 dark:text-amber-300">Em atraso desde {formatDate(item.past_due_since)}</p>}
      {item.grace_period_ends_at && <p className="text-amber-700 dark:text-amber-300">Tolerância até {formatDate(item.grace_period_ends_at)}</p>}
    </div>
  );
}
