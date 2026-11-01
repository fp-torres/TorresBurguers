import { useState } from 'react';
import { Icon } from '@iconify/react';
import { Ban, History, ShieldCheck, Users } from 'lucide-react';
import {
  DataTable, FilterTabs, PageHeader, Pagination, SearchInput, StatusBadge, buttonClass,
  type DataTableColumn, type FilterTabOption,
} from '../../components/ui';
import { useAuth } from '../../contexts/AuthContext';
import { usePaginatedQuery } from '../../hooks/usePaginatedQuery';
import { storeCustomerService, type StoreCustomerSummary } from '../../services/storeCustomerService';
import { formatCurrency, formatDateTime } from '../../utils/format';
import BlockCustomerDialog, { type BlockAction } from './BlockCustomerDialog';
import CustomerDetailModal from './CustomerDetailModal';
import { formatCustomerPhone } from './phone';

const PAGE_SIZE_OPTIONS = [10, 20, 50];

type CustomerView = 'all' | 'blocked';
const VIEW_OPTIONS: FilterTabOption<CustomerView>[] = [
  { value: 'all', label: 'Todos' },
  { value: 'blocked', label: 'Bloqueados' },
];

/**
 * Painel da loja › Clientes (/customers; Administrador e Atendente): quem já comprou NESTA loja, com busca
 * por nome, e-mail ou telefone (GET /store/customers) e o histórico de pedidos daqui (GET /store/customers/:id).
 * Clientes têm conta global e editam os próprios dados na vitrine. O Administrador pode bloquear um cliente
 * NESTA loja (pedidos falsos, abuso): ele deixa de comprar aqui e continua comprando nas outras lojas.
 */
export default function Customers() {
  const { user } = useAuth();
  const canBlock = user?.role === 'ADMIN';
  const [selected, setSelected] = useState<StoreCustomerSummary | null>(null);
  const [view, setView] = useState<CustomerView>('all');
  const [blocking, setBlocking] = useState<{ customer: StoreCustomerSummary; action: BlockAction } | null>(null);

  const query = usePaginatedQuery<StoreCustomerSummary, { blocked?: boolean }>({
    fetcher: ({ page, pageSize, search, filters, signal }) =>
      storeCustomerService.list({ page, pageSize, search, blocked: filters.blocked }, signal),
    initialFilters: {},
    errorMessage: 'Não foi possível carregar os clientes.',
  });

  const searching = query.search.trim() !== '';
  const onlyBlocked = view === 'blocked';

  function changeView(next: CustomerView) {
    setView(next);
    query.setFilters(next === 'blocked' ? { blocked: true } : {});
  }

  const columns: DataTableColumn<StoreCustomerSummary>[] = [
    {
      key: 'customer',
      header: 'Cliente',
      cell: (customer) => (
        <div className="flex items-center gap-3 min-w-0">
          <span
            aria-hidden="true"
            className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center font-bold text-sm bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300"
          >
            {(customer.name.trim()[0] ?? '?').toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="font-bold text-gray-800 dark:text-white truncate max-w-56 flex items-center gap-2">
              <span className="truncate">{customer.name || 'Cliente'}</span>
              {customer.blocked && (
                <StatusBadge tone="danger" icon={<Ban size={12} aria-hidden="true" />} title={customer.block?.reason || undefined}>
                  Bloqueado
                </StatusBadge>
              )}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-56">{customer.email}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'phone',
      header: 'Telefone',
      className: 'hidden md:table-cell whitespace-nowrap',
      headerClassName: 'hidden md:table-cell',
      cell: (customer) => (customer.phone ? formatCustomerPhone(customer.phone) : <span className="text-gray-400">—</span>),
    },
    {
      key: 'orders',
      header: 'Pedidos',
      align: 'center',
      className: 'tabular-nums',
      cell: (customer) => customer.orders_count,
    },
    {
      key: 'spent',
      header: 'Total gasto',
      align: 'right',
      className: 'tabular-nums whitespace-nowrap font-bold',
      cell: (customer) => formatCurrency(customer.total_spent),
    },
    {
      key: 'last',
      header: 'Último pedido',
      className: 'hidden lg:table-cell whitespace-nowrap',
      headerClassName: 'hidden lg:table-cell',
      cell: (customer) => formatDateTime(customer.last_order_at),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Ações</span>,
      align: 'right',
      cell: (customer) => (
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setSelected(customer)}
            aria-label={`Ver o histórico de ${customer.name || 'cliente'}`}
            className={buttonClass('secondary', 'sm')}
          >
            <History size={14} aria-hidden="true" /> <span className="hidden sm:inline">Histórico</span>
          </button>
          {canBlock && (customer.blocked ? (
            <button
              type="button"
              onClick={() => setBlocking({ customer, action: 'unblock' })}
              aria-label={`Desbloquear ${customer.name || 'cliente'}`}
              className={buttonClass('secondary', 'sm')}
            >
              <ShieldCheck size={14} aria-hidden="true" /> <span className="hidden sm:inline">Desbloquear</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setBlocking({ customer, action: 'block' })}
              aria-label={`Bloquear ${customer.name || 'cliente'}`}
              className={buttonClass('danger', 'sm')}
            >
              <Ban size={14} aria-hidden="true" /> <span className="hidden sm:inline">Bloquear</span>
            </button>
          ))}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6 pb-20">
      <PageHeader
        title="Clientes"
        subtitle="Quem já comprou no seu estabelecimento"
        icon={<Icon icon="solar:user-heart-bold-duotone" width={26} />}
      >
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <SearchInput
            value={query.search}
            onChange={query.setSearch}
            placeholder="Buscar por nome, e-mail ou telefone..."
            label="Buscar clientes"
            className="sm:max-w-md flex-1"
          />
          <FilterTabs options={VIEW_OPTIONS} value={view} onChange={changeView} label="Filtrar clientes" className="p-0" />
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Total gasto = pedidos pagos e não cancelados nesta loja.
          </p>
        </div>
      </PageHeader>

      <DataTable
        stackOnMobile
        caption="Clientes da loja"
        columns={columns}
        rows={query.items}
        rowKey={(customer) => customer.id}
        loading={query.loading}
        error={query.error}
        onRetry={() => void query.reload()}
        emptyIcon={<Users size={32} />}
        emptyTitle={searching ? 'Nenhum cliente encontrado' : onlyBlocked ? 'Nenhum cliente bloqueado' : 'Nenhum cliente ainda'}
        emptyDescription={searching
          ? 'Confira a grafia ou busque por outro dado (e-mail ou telefone).'
          : onlyBlocked
            ? 'Clientes bloqueados não fazem pedidos neste estabelecimento e aparecem aqui.'
            : 'Os clientes aparecem aqui depois do primeiro pedido feito na sua loja.'}
        emptyAction={searching ? (
          <button type="button" onClick={() => query.setSearch('')} className={buttonClass('secondary', 'sm')}>Limpar busca</button>
        ) : undefined}
        footer={query.total > 0 ? (
          <Pagination
            page={query.page}
            pageSize={query.pageSize}
            total={query.total}
            onPageChange={query.setPage}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            onPageSizeChange={query.setPageSize}
            disabled={query.loading}
            itemLabel="clientes"
          />
        ) : undefined}
      />

      <CustomerDetailModal
        customer={selected}
        onClose={() => setSelected(null)}
        canBlock={canBlock}
        onBlockChanged={() => void query.reload()}
      />
      <BlockCustomerDialog
        customer={blocking?.customer ?? null}
        action={blocking?.action ?? null}
        onClose={() => setBlocking(null)}
        onDone={() => void query.reload()}
      />
    </div>
  );
}
