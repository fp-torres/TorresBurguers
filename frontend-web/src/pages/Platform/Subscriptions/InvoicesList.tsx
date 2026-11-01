import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, CircleSlash, Receipt, Settings2, XCircle } from 'lucide-react';
import {
  DataTable, FilterTabs, Pagination, SearchInput, StatusBadge, buttonClass, type DataTableColumn, type FilterTabOption,
} from '../../../components/ui';
import type { PaginatedQuery } from '../../../hooks/usePaginatedQuery';
import type { PlatformInvoiceItem } from '../../../services/platform/billingParsers';
import type { InvoiceStatus } from '../../../types/saas';
import { INVOICE_STATUS, statusMeta } from '../../../utils/saasStatus';
import { formatCurrency, formatDateTime } from '../../../utils/format';
import AuditLink from '../Audit/AuditLink';
import { auditUrl } from '../Audit/urlFilters';
import { InvoiceReasonDialog, MarkInvoicePaidDialog, type InvoiceTarget } from './InvoiceDialogs';
import { invoiceMethodLabel, isInvoiceOverdue, isInvoiceUnpaid } from './billingDisplay';
import { formatDate } from '../../../utils/dates';

export type InvoiceStatusFilter = 'ALL' | InvoiceStatus;
export type InvoiceFilters = { status: InvoiceStatusFilter };

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

const STATUS_TABS: FilterTabOption<InvoiceStatusFilter>[] = [
  { value: 'ALL', label: 'Todas' },
  { value: 'OPEN', label: 'Em aberto' },
  { value: 'FAILED', label: 'Falharam' },
  { value: 'PAID', label: 'Pagas' },
  { value: 'VOID', label: 'Anuladas' },
];

interface InvoicesListProps {
  /** GET /platform/invoices. */
  query: PaginatedQuery<PlatformInvoiceItem, InvoiceFilters>;
  now: number;
  /** Abre a assinatura da fatura (diálogo de detalhe). */
  onOpenSubscription: (invoice: PlatformInvoiceItem) => void;
  /** Uma fatura mudou (a tela recarrega as listas). */
  onChanged: () => void;
}

/**
 * Faturas SaaS de todas as lojas (receita da plataforma), com filtro por situação e busca pela loja, as ações de
 * pagamento e o link para a auditoria de cada fatura (alvo subscription_invoice).
 */
export default function InvoicesList({ query, now, onOpenSubscription, onChanged }: InvoicesListProps) {
  const [paidTarget, setPaidTarget] = useState<InvoiceTarget | null>(null);
  const [reasonTarget, setReasonTarget] = useState<{ target: InvoiceTarget; action: 'fail' | 'void' } | null>(null);
  const filtered = query.search.trim() !== '' || query.filters.status !== 'ALL';

  const columns: DataTableColumn<PlatformInvoiceItem>[] = [
    {
      key: 'invoice',
      header: 'Fatura',
      className: 'whitespace-nowrap',
      cell: (invoice) => (
        <div>
          <p className="font-bold text-gray-800 dark:text-white">#{invoice.id}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">{formatDate(invoice.period_start)} – {formatDate(invoice.period_end)}</p>
        </div>
      ),
    },
    {
      key: 'store',
      header: 'Estabelecimento',
      cell: (invoice) => (invoice.store ? (
        <div className="min-w-0">
          <Link
            to={`/platform/stores/${invoice.store.id}?tab=subscription`}
            className="font-semibold text-gray-800 dark:text-white hover:text-orange-700 dark:hover:text-orange-400 hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            {invoice.store.name}
          </Link>
          <p className="font-mono text-xs text-gray-500 dark:text-gray-400">/{invoice.store.slug}</p>
        </div>
      ) : <span>Estabelecimento #{invoice.store_id}</span>),
    },
    {
      key: 'due',
      header: 'Vencimento',
      className: 'whitespace-nowrap',
      cell: (invoice) => (
        <div className="flex flex-col gap-1">
          <span>{formatDate(invoice.due_at)}</span>
          {isInvoiceOverdue(invoice, now) && <StatusBadge tone="danger" icon={<AlertTriangle size={12} />}>Vencida</StatusBadge>}
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Valor',
      align: 'right',
      className: 'tabular-nums whitespace-nowrap font-bold',
      cell: (invoice) => formatCurrency(invoice.amount),
    },
    {
      key: 'status',
      header: 'Situação',
      cell: (invoice) => {
        const meta = statusMeta(INVOICE_STATUS, invoice.status);
        return (
          <div className="flex flex-col gap-1 max-w-52">
            <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
            {invoice.status === 'FAILED' && invoice.failure_reason && (
              <span className="text-xs text-red-700 dark:text-red-400">{invoice.failure_reason}</span>
            )}
          </div>
        );
      },
    },
    {
      key: 'payment',
      header: 'Pagamento',
      className: 'hidden lg:table-cell text-xs',
      headerClassName: 'hidden lg:table-cell',
      cell: (invoice) => (invoice.paid_at
        ? <span>{formatDateTime(invoice.paid_at)} · {invoiceMethodLabel(invoice.payment_method)}</span>
        : <span className="text-gray-400">—</span>),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Ações</span>,
      align: 'right',
      cell: (invoice) => {
        const target: InvoiceTarget = { invoice, storeName: invoice.store?.name };
        return (
          <div className="flex flex-wrap justify-end gap-1.5">
            {isInvoiceUnpaid(invoice) && (
              <>
                <button type="button" onClick={() => setPaidTarget(target)} aria-label={`Registrar o pagamento da fatura #${invoice.id}`} title="Registrar pagamento" className={buttonClass('secondary', 'sm')}>
                  <CheckCircle2 size={14} aria-hidden="true" /> <span className="hidden 2xl:inline">Pagamento</span>
                </button>
                <button type="button" onClick={() => setReasonTarget({ target, action: 'fail' })} aria-label={`Marcar o pagamento da fatura #${invoice.id} como recusado`} title="Pagamento recusado" className={buttonClass('ghost', 'sm')}>
                  <XCircle size={14} aria-hidden="true" /> <span className="hidden 2xl:inline">Recusado</span>
                </button>
                <button type="button" onClick={() => setReasonTarget({ target, action: 'void' })} aria-label={`Anular a fatura #${invoice.id}`} title="Anular fatura" className={buttonClass('ghost', 'sm', 'text-red-600 dark:text-red-400')}>
                  <CircleSlash size={14} aria-hidden="true" /> <span className="hidden 2xl:inline">Anular</span>
                </button>
              </>
            )}
            <button type="button" onClick={() => onOpenSubscription(invoice)} aria-label={`Abrir a assinatura da fatura #${invoice.id}`} title="Abrir a assinatura" className={buttonClass('ghost', 'sm')}>
              <Settings2 size={14} aria-hidden="true" /> <span className="hidden 2xl:inline">Assinatura</span>
            </button>
            <AuditLink
              to={auditUrl({ target_type: 'subscription_invoice', target_id: invoice.id })}
              label={`Ver auditoria da fatura #${invoice.id}`}
              variant="ghost"
            >
              <span className="hidden 2xl:inline">Auditoria</span>
            </AuditLink>
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <SearchInput
          value={query.search}
          onChange={query.setSearch}
          placeholder="Buscar pela loja (nome ou endereço)..."
          label="Buscar faturas pela loja"
          className="flex-1 sm:max-w-md"
        />
        {filtered && <button type="button" onClick={query.reset} className={buttonClass('ghost')}>Limpar filtros</button>}
      </div>

      <FilterTabs
        label="Filtrar por situação da fatura"
        options={STATUS_TABS}
        value={query.filters.status}
        onChange={(value) => query.setFilter('status', value)}
        className="-mx-2"
      />

      <DataTable
        stackOnMobile
        caption="Faturas das assinaturas"
        columns={columns}
        rows={query.items}
        rowKey={(invoice) => invoice.id}
        loading={query.loading}
        error={query.error}
        onRetry={() => void query.reload()}
        rowClassName={(invoice) => (isInvoiceOverdue(invoice, now) ? 'bg-red-50/40 dark:bg-red-900/10' : undefined)}
        emptyIcon={<Receipt size={32} />}
        emptyTitle={filtered ? 'Nenhuma fatura encontrada' : 'Nenhuma fatura ainda'}
        emptyDescription={filtered
          ? 'Ajuste a busca ou o filtro.'
          : 'As faturas aparecem quando uma assinatura de plano pago entra em um período (ou ao gerar uma fatura avulsa).'}
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
            itemLabel="faturas"
          />
        ) : undefined}
      />

      <MarkInvoicePaidDialog target={paidTarget} now={now} onClose={() => setPaidTarget(null)} onDone={onChanged} />
      <InvoiceReasonDialog
        target={reasonTarget?.target ?? null}
        action={reasonTarget?.action ?? 'fail'}
        onClose={() => setReasonTarget(null)}
        onDone={onChanged}
      />
    </div>
  );
}
