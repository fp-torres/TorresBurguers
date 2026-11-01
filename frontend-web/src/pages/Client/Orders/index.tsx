import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Clock, Package, Truck, CheckCircle, XCircle, MapPin, ShoppingBag, ChevronDown, ChevronUp, LayoutDashboard,
  ShieldAlert, Bell, Store as StoreIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import toast from 'react-hot-toast';
import { customerService, type CustomerOrder } from '../../../services/customerService';
import { orderNumber } from '../../../services/orderService';
import { useAuth } from '../../../contexts/AuthContext';
import { usePolling } from '../../../hooks/usePolling';
import ConfirmModal from '../../../components/ConfirmModal';
import StoreLogo from '../../../components/BrandLogo/StoreLogo';
import { EmptyState, ErrorState, buttonClass, fieldControlClass } from '../../../components/ui';
import { getApiErrorMessage } from '../../../services/api';
import { homePathForUser, isStaffRole, roleLabel } from '../../../utils/roles';
import {
  addonSummary, addressAreaLine, addressStreetLine, customerPaymentStatusLabel, customerStatusLabel, isCashPayment,
  isPaymentReversed, isRefundableOnCancel, orderAddress, orderItemName, paymentMethodLabel,
} from '../../../utils/orders';
import { formatCurrency, formatDateTime, parseMoney } from '../../../utils/format';
import { readLastStore, storePath } from '../../../utils/lastStore';
import { isValidStoreSlug } from '../../../utils/validation';

// Pedidos novos e mudanças de status aparecem sozinhos
const POLL_INTERVAL_MS = 10_000;
const ALL_STORES = 'todas';

// Cor e ícone de cada status (o texto vem de customerStatusLabel, que diferencia retirada e entrega)
const STATUS_STYLES: Record<string, { color: string; icon: LucideIcon }> = {
  PENDING: { color: 'text-yellow-700 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800', icon: Clock },
  PREPARING: { color: 'text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800', icon: Package },
  READY_FOR_PICKUP: { color: 'text-purple-700 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800', icon: Bell },
  DELIVERING: { color: 'text-orange-700 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800', icon: Truck },
  DONE: { color: 'text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800', icon: CheckCircle },
  FINISHED: { color: 'text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800', icon: CheckCircle },
  CANCELED: { color: 'text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800', icon: XCircle },
};

/** Aviso depois do cancelamento, conforme o estorno devolvido pela API. */
function canceledToast(order?: { payment_status?: string } | null): string {
  if (order?.payment_status === 'REFUNDED') return 'Pedido cancelado com sucesso. O valor foi estornado pelo Mercado Pago.';
  if (order?.payment_status === 'REFUND_PENDING') {
    return 'Pedido cancelado com sucesso. O estorno ainda está sendo processado; a loja vai concluir a devolução.';
  }
  return 'Pedido cancelado com sucesso.';
}

/**
 * Meus Pedidos (/my-orders): pedidos do cliente em TODAS as lojas (GET /orders/my-orders), cada um com a
 * loja (nome, logo e link para a vitrine), atualizados a cada 10 s. Cancelamento enquanto aguarda confirmação.
 */
export default function ClientOrders() {
  const { user } = useAuth();
  const isStaff = isStaffRole(user?.role);

  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedOrderId, setExpandedOrderId] = useState<number | null>(null);
  const [storeFilter, setStoreFilter] = useState(ALL_STORES);
  // Guarda o pedido para avisar sobre o estorno de pedidos pagos online
  const [orderToCancel, setOrderToCancel] = useState<CustomerOrder | null>(null);
  const filterId = useId();
  const [lastStoreSlug] = useState(readLastStore);

  // Só a consulta mais recente é aplicada
  const requestSeq = useRef(0);

  const loadOrders = useCallback(async () => {
    const requestId = ++requestSeq.current;
    try {
      const data = await customerService.getMyOrders();
      if (requestId !== requestSeq.current) return;
      setOrders([...data].sort((a, b) => b.id - a.id));
      setLoadError(null);
    } catch (error) {
      // Falha numa atualização automática mantém a lista na tela; sem lista, a tela oferece nova tentativa
      if (requestId === requestSeq.current) setLoadError(getApiErrorMessage(error, 'Não foi possível carregar seus pedidos.'));
    } finally {
      if (requestId === requestSeq.current) setLoading(false);
    }
  }, []);

  // A equipe não carrega o histórico (a rota já exige login)
  usePolling(loadOrders, POLL_INTERVAL_MS, { enabled: !!user && !isStaff, immediate: true });

  // Lojas dos pedidos (filtro quando há pedidos de mais de uma loja)
  const stores = useMemo(() => {
    const byId = new Map<number, NonNullable<CustomerOrder['store']>>();
    orders.forEach((order) => {
      if (order.store) byId.set(order.store.id, order.store);
    });
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }, [orders]);
  const activeFilter = storeFilter !== ALL_STORES && stores.some((store) => String(store.id) === storeFilter) ? storeFilter : ALL_STORES;
  const visibleOrders = activeFilter === ALL_STORES ? orders : orders.filter((order) => String(order.store?.id) === activeFilter);

  // --- BLOQUEIO VISUAL PARA EQUIPE ---
  if (isStaff && user) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center space-y-6 animate-in fade-in">
        <div className="bg-red-50 dark:bg-red-900/20 p-6 rounded-full text-red-500 dark:text-red-400 border border-red-100 dark:border-red-900" aria-hidden="true">
          <ShieldAlert size={48} />
        </div>
        <div className="max-w-md px-4">
          <h1 className="text-xl font-bold text-gray-800 dark:text-white">Modo Equipe</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-2">
            Você entrou como {roleLabel(user.role)}. Para acompanhar os pedidos da loja, utilize o painel da equipe.
          </p>
        </div>
        <Link to={homePathForUser(user)} className={buttonClass('secondary', 'lg')}>
          <LayoutDashboard size={18} aria-hidden="true" />
          Ir para o Painel
        </Link>
      </div>
    );
  }

  async function executeCancel() {
    const order = orderToCancel;
    if (!order) return;
    try {
      const canceled = await customerService.cancelOrder(order.id);
      // Mostra o cancelamento (e o estorno) na hora; a consulta seguinte confirma
      setOrders((previous) => previous.map((item) => (item.id === order.id
        ? { ...item, ...(canceled?.id === order.id ? canceled : { status: 'CANCELED' as const }), store: item.store }
        : item)));
      toast.success(canceledToast(canceled));
      void loadOrders();
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Não foi possível cancelar o pedido.'));
    }
  }

  // Pedido pago online: o cliente é avisado de que o valor será estornado
  const cancelMessage = orderToCancel && isRefundableOnCancel(orderToCancel)
    ? 'Tem certeza que deseja cancelar? Este pedido foi pago online: o valor será estornado pelo Mercado Pago na mesma forma de pagamento.'
    : 'Tem certeza que deseja cancelar? O pedido será removido da fila de produção da loja.';

  const lastStore = lastStoreSlug;
  const shopTo = lastStore ? storePath(lastStore) : '/';

  const pageTitle = (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 dark:text-white">Meus Pedidos</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400">Pedidos de todos os estabelecimentos, atualizados automaticamente.</p>
    </div>
  );

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto space-y-4" aria-busy="true">
        {pageTitle}
        {[1, 2, 3].map((index) => <div key={index} className="h-24 rounded-xl bg-gray-200 dark:bg-slate-800 animate-pulse" aria-hidden="true" />)}
        <p className="sr-only" role="status">Carregando seus pedidos...</p>
      </div>
    );
  }

  if (orders.length === 0 && loadError) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        {pageTitle}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-gray-100 dark:border-slate-800">
          <ErrorState
            title="Não foi possível carregar seus pedidos"
            message={loadError}
            onRetry={() => {
              setLoading(true);
              void loadOrders();
            }}
          />
        </div>
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        {pageTitle}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-gray-100 dark:border-slate-800">
          <EmptyState
            icon={<ShoppingBag size={36} />}
            title="Nenhum pedido ainda"
            description="Seus pedidos de todos os estabelecimentos aparecem aqui, com a situação atualizada."
            action={<Link to={shopTo} className={buttonClass('primary')}>{lastStore ? 'Voltar para a última loja' : 'Escolher um estabelecimento'}</Link>}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-20">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        {pageTitle}
        {stores.length > 1 && (
          <div className="sm:w-56">
            <label htmlFor={filterId} className="block text-xs font-bold uppercase tracking-wide text-gray-600 dark:text-gray-300 mb-1">Loja</label>
            <select id={filterId} value={activeFilter} onChange={(event) => setStoreFilter(event.target.value)} className={fieldControlClass()}>
              <option value={ALL_STORES}>Todas as lojas</option>
              {stores.map((store) => <option key={store.id} value={String(store.id)}>{store.name}</option>)}
            </select>
          </div>
        )}
      </div>

      {loadError && (
        <p role="status" className="text-xs text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl px-3 py-2">
          Não foi possível atualizar agora ({loadError}). Mostrando a última lista recebida.
        </p>
      )}

      <ul className="space-y-4">
        {visibleOrders.map((order) => {
          const Status = STATUS_STYLES[order.status] || STATUS_STYLES.PENDING;
          const isExpanded = expandedOrderId === order.id;
          const detailsId = `pedido-${order.id}-detalhes`;
          const address = order.type === 'DELIVERY' ? orderAddress(order) : null;
          const changeFor = isCashPayment(order.payment_method) && order.status !== 'CANCELED' ? parseMoney(order.change_for) : 0;
          const store = order.store;
          const storeLink = store && isValidStoreSlug(store.slug) ? storePath(store.slug) : null;

          return (
            <li key={order.id} className="bg-white dark:bg-slate-900 border border-gray-100 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm hover:shadow-md dark:hover:shadow-slate-800 transition-all">

              {/* Loja do pedido (link para a vitrine dela) */}
              {store && (
                <div className="flex items-center justify-between gap-3 px-4 pt-3">
                  {storeLink ? (
                    <Link to={storeLink} className="inline-flex items-center gap-2 min-w-0 text-sm font-bold text-gray-700 dark:text-gray-200 hover:text-orange-700 dark:hover:text-orange-400 transition-colors">
                      <StoreLogo name={store.name} logo={store.logo} size={24} decorative />
                      <span className="truncate">{store.name}</span>
                      <span className="sr-only">(ver cardápio)</span>
                    </Link>
                  ) : (
                    <span className="inline-flex items-center gap-2 min-w-0 text-sm font-bold text-gray-700 dark:text-gray-200">
                      <StoreIcon size={18} aria-hidden="true" /> <span className="truncate">{store.name}</span>
                    </span>
                  )}
                </div>
              )}

              {/* Cabeçalho: botão que abre/fecha os detalhes (teclado e leitores de tela) */}
              <button
                type="button"
                onClick={() => setExpandedOrderId(isExpanded ? null : order.id)}
                aria-expanded={isExpanded}
                aria-controls={detailsId}
                className="w-full p-4 cursor-pointer flex justify-between items-center gap-3 text-left rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500"
              >
                <span className="flex items-center gap-4 min-w-0">
                  <span className={`p-3 rounded-full border shrink-0 ${Status.color}`} aria-hidden="true"><Status.icon size={20} /></span>
                  <span className="block min-w-0">
                    <strong className="block font-bold text-gray-800 dark:text-white text-lg">Pedido #{orderNumber(order)}</strong>
                    <small className="block text-xs text-gray-500 dark:text-gray-400">{formatDateTime(order.created_at)} · {order.type === 'DELIVERY' ? 'Entrega' : 'Retirada'}</small>
                    <span className={`text-xs font-bold mt-1 inline-block px-2 py-0.5 rounded border ${Status.color}`}>
                      {customerStatusLabel(order.status, order.type)}
                    </span>
                  </span>
                </span>
                <span className="text-right shrink-0">
                  <span className="block font-bold text-gray-800 dark:text-white">{formatCurrency(order.total_price)}</span>
                  {isExpanded ? <ChevronUp size={18} className="text-gray-400 inline-block" aria-hidden="true" /> : <ChevronDown size={18} className="text-gray-400 inline-block" aria-hidden="true" />}
                  <span className="sr-only">{isExpanded ? 'Ocultar detalhes' : 'Ver detalhes'}</span>
                </span>
              </button>

              {/* DETALHES */}
              {isExpanded && (
                <div id={detailsId} className="bg-gray-50 dark:bg-slate-950/50 p-4 border-t border-gray-100 dark:border-slate-800 space-y-4 animate-in slide-in-from-top-2">

                  {/* Itens (nome como foi vendido) */}
                  <ul className="space-y-3">
                    {order.items.map((item) => (
                      <li key={item.id} className="text-sm text-gray-700 dark:text-gray-300">
                        <span><span className="font-bold">{item.quantity}x</span> {orderItemName(item)}</span>
                        <div className="pl-6 text-xs text-gray-500 dark:text-gray-400 space-y-0.5 mt-1">
                          {item.meat_point && <p className="text-orange-700 dark:text-orange-400 font-bold">🔥 {item.meat_point}</p>}
                          {item.removed_ingredients && item.removed_ingredients.length > 0 && (
                            <p className="text-red-600 dark:text-red-400">🚫 Sem: {Array.isArray(item.removed_ingredients) ? item.removed_ingredients.join(', ') : item.removed_ingredients}</p>
                          )}
                          {item.addons?.length > 0 && (
                            <p className="text-green-700 dark:text-green-400 font-medium">✨ + {addonSummary(item).join(', ')}</p>
                          )}
                          {item.observation && <p className="italic text-gray-500 dark:text-gray-400">"{item.observation}"</p>}
                        </div>
                      </li>
                    ))}
                  </ul>

                  {/* Endereço de entrega como estava na hora do pedido */}
                  {address && (
                    <div className="pt-3 border-t border-gray-200 dark:border-slate-800 flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400">
                      <MapPin size={14} className="mt-0.5 shrink-0 text-orange-600 dark:text-orange-400" aria-hidden="true" />
                      <div>
                        <span className="block font-bold text-gray-700 dark:text-gray-300">
                          Endereço de entrega{address.nickname ? ` (${address.nickname})` : ''}
                        </span>
                        <span className="block">{addressStreetLine(address)}{address.complement ? ` - ${address.complement}` : ''}</span>
                        <span className="block">{addressAreaLine(address)}</span>
                      </div>
                    </div>
                  )}

                  {Number(order.delivery_fee ?? 0) > 0 && (
                    <div className="pt-3 border-t border-gray-200 dark:border-slate-800 text-xs text-gray-500 dark:text-gray-400 flex justify-between">
                      <span>Taxa de entrega</span>
                      <span>{formatCurrency(order.delivery_fee)}</span>
                    </div>
                  )}

                  <div className="pt-3 border-t border-gray-200 dark:border-slate-800 text-sm flex justify-between items-center gap-3">
                    <div>
                      <span className="text-gray-500 dark:text-gray-400 block text-xs">Pagamento</span>
                      <span className="font-bold text-gray-700 dark:text-gray-300">{paymentMethodLabel(order.payment_method)}</span>
                      <span className="block text-xs text-gray-500 dark:text-gray-400">
                        {customerPaymentStatusLabel(order)}
                        {changeFor > 0 && ` · troco para ${formatCurrency(changeFor)}`}
                      </span>
                      {order.payment_status === 'REFUNDED' && !isPaymentReversed(order) && (
                        <span className="block text-xs text-blue-700 dark:text-blue-400 mt-0.5">O valor foi devolvido pelo Mercado Pago.</span>
                      )}
                      {isPaymentReversed(order) && (
                        <span className="block text-xs text-red-700 dark:text-red-400 mt-0.5">
                          O pagamento foi desfeito no Mercado Pago (estorno ou contestação). Combine o pagamento com a loja.
                        </span>
                      )}
                      {order.payment_status === 'REFUND_PENDING' && (
                        <span className="block text-xs text-amber-700 dark:text-amber-400 mt-0.5">A devolução ainda não foi concluída; a loja vai finalizá-la.</span>
                      )}
                    </div>

                    {order.status === 'PENDING' && (
                      <button
                        type="button"
                        onClick={() => setOrderToCancel(order)}
                        className="shrink-0 text-red-600 dark:text-red-400 text-xs font-bold hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 px-3 py-1.5 rounded-lg transition-colors border border-red-100 dark:border-red-900"
                      >
                        Cancelar Pedido
                      </button>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <ConfirmModal
        isOpen={!!orderToCancel}
        onClose={() => setOrderToCancel(null)}
        onConfirm={() => void executeCancel()}
        title="Cancelar Pedido?"
        message={cancelMessage}
        confirmLabel="Sim, Cancelar"
        isDestructive
      />
    </div>
  );
}
