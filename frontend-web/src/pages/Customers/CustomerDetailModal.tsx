import { useId, useState } from 'react';
import { Ban, Mail, MessageCircle, Phone, ShieldCheck, ShoppingBag } from 'lucide-react';
import { DataTable, ErrorState, Modal, StatusBadge, buttonClass, type DataTableColumn } from '../../components/ui';
import PageLoader from '../../components/PageLoader';
import { storeCustomerService, type StoreCustomerSummary } from '../../services/storeCustomerService';
import { orderLabel, type Order } from '../../services/orderService';
import { useResource } from '../../hooks/useResource';
import { PAYMENT_STATUS_TONES, orderStatusTone } from '../../layouts/DefaultLayout/orderTones';
import { formatDate } from '../../utils/dates';
import { formatCurrency, formatDateTime } from '../../utils/format';
import { customerPhoneDigits, formatCustomerPhone } from './phone';
import BlockCustomerDialog, { type BlockAction } from './BlockCustomerDialog';
import {
  addonSummary, orderItemName, orderStatusLabel, paymentMethodLabel, paymentStatusLabel, paymentStatusTone,
} from '../../utils/orders';

interface CustomerDetailModalProps {
  /** Cliente escolhido na lista (null = fechado). */
  customer: StoreCustomerSummary | null;
  onClose: () => void;
  /** Administrador: bloquear/desbloquear o cliente neste estabelecimento. */
  canBlock?: boolean;
  /** Depois de bloquear ou desbloquear (a lista recarrega). */
  onBlockChanged?: () => void;
}

/** Resumo dos itens: "2x X-Burguer (+ Bacon), 1x Refrigerante". */
function itemsSummary(order: Order): string {
  return order.items
    .map((item) => {
      const addons = addonSummary(item);
      return `${item.quantity}x ${orderItemName(item)}${addons.length ? ` (+ ${addons.join(', ')})` : ''}`;
    })
    .join(', ');
}

/** Histórico de um cliente NESTA loja: contato, estatísticas, bloqueio e pedidos. */
export default function CustomerDetailModal({ customer, onClose, canBlock = false, onBlockChanged }: CustomerDetailModalProps) {
  return (
    <Modal
      open={!!customer}
      onClose={onClose}
      size="xl"
      title={customer?.name || 'Cliente'}
      description="Histórico de compras nesta loja"
      footer={<button type="button" onClick={onClose} className={buttonClass('secondary')}>Fechar</button>}
    >
      {customer && <CustomerDetail customerId={customer.id} canBlock={canBlock} onBlockChanged={onBlockChanged} />}
    </Modal>
  );
}

function CustomerDetail({
  customerId, canBlock, onBlockChanged,
}: { customerId: number; canBlock: boolean; onBlockChanged?: () => void }) {
  const ordersTitleId = useId();
  const [blockAction, setBlockAction] = useState<BlockAction | null>(null);
  const detail = useResource((signal) => storeCustomerService.detail(customerId, signal), {
    key: String(customerId),
    errorMessage: 'Não foi possível carregar o histórico do cliente.',
  });
  const data = detail.data;

  if (!data) {
    return detail.error ? (
      <ErrorState
        compact
        message={detail.errorStatus === 404 ? 'Este cliente não tem pedidos nesta loja.' : detail.error}
        onRetry={detail.errorStatus === 404 ? undefined : () => void detail.reload()}
        retrying={detail.loading}
      />
    ) : (
      <PageLoader />
    );
  }

  const { customer, stats, orders, block } = data;
  // DDD + número (null quando o telefone cadastrado não tem esse formato: aparece sem link)
  const phoneDigits = customerPhoneDigits(customer.phone);

  const columns: DataTableColumn<Order>[] = [
    {
      key: 'order',
      header: 'Pedido',
      cell: (order) => (
        <div className="whitespace-nowrap">
          <p className="font-bold text-gray-800 dark:text-white">{orderLabel(order)}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">{formatDateTime(order.created_at)}</p>
        </div>
      ),
    },
    {
      key: 'items',
      header: 'Itens',
      className: 'hidden md:table-cell',
      headerClassName: 'hidden md:table-cell',
      cell: (order) => (
        <p className="text-xs text-gray-600 dark:text-gray-300 line-clamp-2 max-w-72" title={itemsSummary(order)}>
          {itemsSummary(order) || '—'}
        </p>
      ),
    },
    {
      key: 'status',
      header: 'Situação',
      cell: (order) => (
        <div className="flex flex-col gap-1">
          <StatusBadge tone={orderStatusTone(order.status)}>{orderStatusLabel(order.status, order.type)}</StatusBadge>
          <span className="text-xs text-gray-500 dark:text-gray-400">{order.type === 'TAKEOUT' ? 'Retirada' : 'Entrega'}</span>
        </div>
      ),
    },
    {
      key: 'payment',
      header: 'Pagamento',
      className: 'hidden sm:table-cell',
      headerClassName: 'hidden sm:table-cell',
      cell: (order) => (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">{paymentMethodLabel(order.payment_method)}</span>
          <StatusBadge tone={PAYMENT_STATUS_TONES[paymentStatusTone(order)]}>{paymentStatusLabel(order)}</StatusBadge>
        </div>
      ),
    },
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      className: 'tabular-nums whitespace-nowrap font-bold',
      cell: (order) => formatCurrency(order.total_price),
    },
  ];

  return (
    <div className="space-y-6">
      {block ? (
        <section
          aria-label="Cliente bloqueado"
          className="p-4 rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 flex flex-col sm:flex-row sm:items-start gap-3 justify-between"
        >
          <div className="space-y-1 min-w-0">
            <p className="font-bold text-red-700 dark:text-red-300 flex items-center gap-2">
              <Ban size={16} aria-hidden="true" />
              <StatusBadge tone="danger">Bloqueado</StatusBadge>
              <span className="text-sm">Não faz pedidos neste estabelecimento</span>
            </p>
            <p className="text-sm text-gray-700 dark:text-gray-200 break-words">
              <span className="font-semibold">Motivo:</span> {block.reason}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {block.blocked_by ? `Por ${block.blocked_by.name}` : 'Por um administrador'}
              {block.blocked_at ? ` em ${formatDateTime(block.blocked_at)}` : ''}
            </p>
          </div>
          {canBlock && (
            <button type="button" onClick={() => setBlockAction('unblock')} className={buttonClass('secondary', 'sm')}>
              <ShieldCheck size={14} aria-hidden="true" /> Desbloquear
            </button>
          )}
        </section>
      ) : canBlock ? (
        <div className="flex justify-end">
          <button type="button" onClick={() => setBlockAction('block')} className={buttonClass('danger', 'sm')}>
            <Ban size={14} aria-hidden="true" /> Bloquear neste estabelecimento
          </button>
        </div>
      ) : null}

      <section aria-label="Contato" className="flex flex-wrap gap-2">
        <a href={`mailto:${customer.email}`} className={buttonClass('secondary', 'sm')}>
          <Mail size={14} aria-hidden="true" /> {customer.email}
        </a>
        {customer.phone && (phoneDigits ? (
          <a href={`tel:+55${phoneDigits}`} className={buttonClass('secondary', 'sm')}>
            <Phone size={14} aria-hidden="true" /> {formatCustomerPhone(customer.phone)}
          </a>
        ) : (
          <span className="inline-flex items-center gap-2 px-3 py-2 text-xs font-bold text-gray-700 dark:text-gray-200">
            <Phone size={14} aria-hidden="true" /> {formatCustomerPhone(customer.phone)}
          </span>
        ))}
        {phoneDigits && (
          <a
            href={`https://wa.me/55${phoneDigits}`}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass('secondary', 'sm')}
          >
            <MessageCircle size={14} aria-hidden="true" /> WhatsApp<span className="sr-only"> (abre em outra aba)</span>
          </a>
        )}
      </section>

      <dl className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Pedidos', value: stats.orders_count },
          { label: 'Total gasto', value: formatCurrency(stats.total_spent), hint: 'Pagos e não cancelados' },
          { label: 'Primeiro pedido', value: formatDate(stats.first_order_at) },
          { label: 'Último pedido', value: formatDate(stats.last_order_at) },
        ].map((stat) => (
          <div key={stat.label} className="p-3 rounded-xl bg-gray-50 dark:bg-slate-800 border border-gray-100 dark:border-slate-700">
            <dt className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">{stat.label}</dt>
            <dd className="mt-1 text-lg font-bold text-gray-800 dark:text-white">{stat.value}</dd>
            {stat.hint && <dd className="text-[11px] text-gray-500 dark:text-gray-400">{stat.hint}</dd>}
          </div>
        ))}
      </dl>

      <section aria-labelledby={ordersTitleId} className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id={ordersTitleId} className="text-base font-bold text-gray-800 dark:text-white flex items-center gap-2">
            <ShoppingBag size={18} className="text-orange-600 dark:text-orange-400" aria-hidden="true" /> Pedidos nesta loja
          </h3>
          {stats.orders_count > orders.length && (
            <p className="text-xs text-gray-500 dark:text-gray-400">Mostrando os {orders.length} mais recentes de {stats.orders_count}.</p>
          )}
        </div>
        <DataTable
          stackOnMobile
          caption="Pedidos do cliente nesta loja"
          columns={columns}
          rows={orders}
          rowKey={(order) => order.id}
          loading={detail.loading}
          scrollClassName="max-h-[45vh]"
          emptyTitle="Nenhum pedido nesta loja"
        />
      </section>

      <BlockCustomerDialog
        customer={blockAction ? customer : null}
        action={blockAction}
        onClose={() => setBlockAction(null)}
        onDone={() => {
          void detail.reload();
          onBlockChanged?.();
        }}
      />
    </div>
  );
}
