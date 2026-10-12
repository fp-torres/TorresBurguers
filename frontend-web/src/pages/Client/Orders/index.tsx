import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Clock, Package, Truck, CheckCircle, XCircle, MapPin, RotateCcw,
  ShoppingBag, ChevronDown, ChevronUp, LayoutDashboard, ShieldAlert, Bell
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { orderService, type Order } from '../../../services/orderService';
import { useAuth } from '../../../contexts/AuthContext';
import ConfirmModal from '../../../components/ConfirmModal';
import toast from 'react-hot-toast';
import { getApiErrorMessage } from '../../../services/api';
import { homePathForRole, isStaffRole, roleLabel } from '../../../utils/roles';
import {
  addonSummary, addressAreaLine, addressStreetLine, customerPaymentStatusLabel, customerStatusLabel, isCashPayment,
  isRefundableOnCancel, orderAddress, orderItemName, paymentMethodLabel,
} from '../../../utils/orders';
import { formatCurrency, formatDateTime, parseMoney } from '../../../utils/format';

// Pedidos novos e mudanças de status aparecem sozinhos
const POLL_INTERVAL_MS = 10000;

// Cor e ícone de cada status (o texto vem de customerStatusLabel, que diferencia retirada e entrega)
const STATUS_STYLES: Record<string, { color: string; icon: LucideIcon }> = {
  PENDING: { color: 'text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800', icon: Clock },
  PREPARING: { color: 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800', icon: Package },
  READY_FOR_PICKUP: { color: 'text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800', icon: Bell },
  DELIVERING: { color: 'text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800', icon: Truck },
  DONE: { color: 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800', icon: CheckCircle },
  FINISHED: { color: 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800', icon: CheckCircle },
  CANCELED: { color: 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800', icon: XCircle },
};

/** Aviso depois do cancelamento, conforme o estorno devolvido pela API. */
function canceledToast(order?: Order | null): string {
  if (order?.payment_status === 'REFUNDED') return 'Pedido cancelado com sucesso. O valor foi estornado pelo Mercado Pago.';
  if (order?.payment_status === 'REFUND_PENDING') {
    return 'Pedido cancelado com sucesso. O estorno ainda está sendo processado; a loja vai concluir a devolução.';
  }
  return 'Pedido cancelado com sucesso.';
}

export default function ClientOrders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [expandedOrderId, setExpandedOrderId] = useState<number | null>(null);

  // Guarda o pedido para avisar sobre o estorno de pedidos pagos online
  const [orderToCancel, setOrderToCancel] = useState<Order | null>(null);

  const { isAuthenticated, user } = useAuth();
  const isStaff = isStaffRole(user?.role);

  // Só a consulta mais recente é aplicada, e a automática não começa com outra em andamento
  const requestSeq = useRef(0);
  const loadInFlight = useRef(false);

  const loadOrders = useCallback(async (trigger: 'poll' | 'manual' = 'manual') => {
    if (trigger === 'poll' && loadInFlight.current) return;
    const requestId = ++requestSeq.current;
    loadInFlight.current = true;
    try {
      const data = await orderService.getMyOrders();
      if (requestId !== requestSeq.current) return;
      setOrders([...data].sort((a, b) => b.id - a.id));
      setLoadFailed(false);
    } catch {
      // Falha numa atualização automática mantém a lista na tela; sem lista, a tela oferece nova tentativa
      if (requestId === requestSeq.current) setLoadFailed(true);
    } finally {
      if (requestId === requestSeq.current) {
        loadInFlight.current = false;
        setLoading(false);
      }
    }
  }, []);

  // Os hooks ficam antes de qualquer retorno antecipado (regra dos hooks); a equipe não carrega o histórico
  useEffect(() => {
    if (isAuthenticated && !isStaff) {
      loadOrders();
      const interval = setInterval(() => loadOrders('poll'), POLL_INTERVAL_MS);
      return () => clearInterval(interval);
    }
  }, [isAuthenticated, isStaff, loadOrders]);

  // --- BLOQUEIO VISUAL PARA EQUIPE ---
  if (isStaff && user) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center space-y-6 animate-in fade-in">
        <div className="bg-red-50 dark:bg-red-900/20 p-6 rounded-full text-red-500 dark:text-red-400 border border-red-100 dark:border-red-900">
          <ShieldAlert size={48} />
        </div>
        <div className="max-w-md px-4">
          <h2 className="text-xl font-bold text-gray-800 dark:text-white">Modo Equipe</h2>
          <p className="text-gray-500 dark:text-gray-400 mt-2">
            Você entrou como {roleLabel(user.role)}. Para acompanhar os pedidos da loja, utilize o painel da equipe.
          </p>
        </div>
        <Link
          to={homePathForRole(user.role)}
          className="bg-gray-800 dark:bg-slate-700 text-white px-6 py-3 rounded-xl font-bold hover:bg-gray-900 dark:hover:bg-slate-600 transition-colors flex items-center gap-2"
        >
          <LayoutDashboard size={18} />
          Ir para o Painel
        </Link>
      </div>
    );
  }

  async function executeCancel() {
    const order = orderToCancel;
    if (!order) return;
    try {
      const canceled = await orderService.cancel(order.id);
      // Mostra o cancelamento (e o estorno) na hora; a consulta seguinte confirma
      setOrders(prev => prev.map(o => (o.id === order.id ? { ...o, ...(canceled?.id === order.id ? canceled : { status: 'CANCELED' as const }) } : o)));
      toast.success(canceledToast(canceled));
      loadOrders();
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Não foi possível cancelar o pedido.'));
    }
  }

  // Pedido pago online: o cliente é avisado de que o valor será estornado
  const cancelMessage = orderToCancel && isRefundableOnCancel(orderToCancel)
    ? 'Tem certeza que deseja cancelar? Este pedido foi pago online: o valor será estornado pelo Mercado Pago na mesma forma de pagamento.'
    : 'Tem certeza que deseja cancelar? O pedido será removido da fila de produção.';

  if (loading) return <div className="p-10 text-center text-gray-500 dark:text-gray-400">Carregando seus pedidos...</div>;

  if (orders.length === 0 && loadFailed) {
    return (
      <div role="alert" className="flex flex-col items-center justify-center py-20 text-center space-y-4 animate-in fade-in">
        <div className="bg-gray-100 dark:bg-slate-800 p-6 rounded-full text-gray-400 dark:text-gray-500"><ShoppingBag size={48} /></div>
        <h2 className="text-xl font-bold text-gray-800 dark:text-white">Não foi possível carregar seus pedidos</h2>
        <p className="text-gray-500 dark:text-gray-400">Verifique sua conexão e tente de novo.</p>
        <button onClick={() => { setLoading(true); loadOrders(); }} className="flex items-center gap-2 bg-orange-600 text-white px-6 py-2 rounded-xl font-bold hover:bg-orange-700 transition-colors">
          <RotateCcw size={16} /> Tentar novamente
        </button>
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center space-y-4 animate-in fade-in">
        <div className="bg-gray-100 dark:bg-slate-800 p-6 rounded-full text-gray-400 dark:text-gray-500"><ShoppingBag size={48} /></div>
        <h2 className="text-xl font-bold text-gray-800 dark:text-white">Nenhum pedido ainda</h2>
        <Link to="/" className="bg-orange-600 text-white px-6 py-2 rounded-xl font-bold hover:bg-orange-700 transition-colors">
          Fazer Pedido
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-20">
      <h1 className="text-2xl font-bold text-gray-800 dark:text-white">Meus Pedidos</h1>
      <div className="space-y-4">
        {orders.map(order => {
          const Status = STATUS_STYLES[order.status] || STATUS_STYLES.PENDING;
          const isExpanded = expandedOrderId === order.id;
          const detailsId = `pedido-${order.id}-detalhes`;
          const address = order.type === 'DELIVERY' ? orderAddress(order) : null;
          const changeFor = isCashPayment(order.payment_method) && order.status !== 'CANCELED' ? parseMoney(order.change_for) : 0;

          return (
            <div key={order.id} className="bg-white dark:bg-slate-900 border border-gray-100 dark:border-slate-800 rounded-xl overflow-hidden shadow-sm hover:shadow-md dark:hover:shadow-slate-800 transition-all">

              {/* CARD HEADER: botão que abre/fecha os detalhes (teclado e leitores de tela) */}
              <button
                type="button"
                onClick={() => setExpandedOrderId(isExpanded ? null : order.id)}
                aria-expanded={isExpanded}
                aria-controls={detailsId}
                className="w-full p-4 cursor-pointer flex justify-between items-center text-left rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500"
              >
                <span className="flex items-center gap-4">
                  <span className={`p-3 rounded-full border ${Status.color}`}><Status.icon size={20} /></span>
                  <span className="block">
                    <strong className="block font-bold text-gray-800 dark:text-white text-lg">Pedido #{order.id}</strong>
                    <small className="block text-xs text-gray-400 dark:text-gray-500">{formatDateTime(order.created_at)} · {order.type === 'DELIVERY' ? 'Entrega' : 'Retirada'}</small>
                    <span className={`text-xs font-bold mt-1 inline-block px-2 py-0.5 rounded ${Status.color.replace('border-', '')}`}>
                      {customerStatusLabel(order.status, order.type)}
                    </span>
                  </span>
                </span>
                <span className="text-right">
                  <span className="block font-bold text-gray-800 dark:text-white">{formatCurrency(order.total_price)}</span>
                  {isExpanded ? <ChevronUp size={18} className="text-gray-400 inline-block"/> : <ChevronDown size={18} className="text-gray-400 inline-block"/>}
                </span>
              </button>

              {/* DETALHES */}
              {isExpanded && (
                <div id={detailsId} className="bg-gray-50 dark:bg-slate-950/50 p-4 border-t border-gray-100 dark:border-slate-800 space-y-4 animate-in slide-in-from-top-2">

                  {/* Lista de Itens (nome como foi vendido) */}
                  <div className="space-y-3">
                    {order.items.map(item => (
                       <div key={item.id} className="text-sm text-gray-700 dark:text-gray-300">
                         <div className="flex justify-between items-start">
                           <span><span className="font-bold">{item.quantity}x</span> {orderItemName(item)}</span>
                         </div>

                         <div className="pl-6 text-xs text-gray-500 dark:text-gray-400 space-y-0.5 mt-1">
                           {item.meat_point && <p className="text-orange-600 dark:text-orange-400 font-bold">🔥 {item.meat_point}</p>}

                           {item.removed_ingredients && item.removed_ingredients.length > 0 && (
                             <p className="text-red-500 dark:text-red-400">🚫 Sem: {Array.isArray(item.removed_ingredients) ? item.removed_ingredients.join(', ') : item.removed_ingredients}</p>
                           )}

                           {item.addons?.length > 0 && (
                             <p className="text-green-600 dark:text-green-400 font-medium">✨ + {addonSummary(item).join(', ')}</p>
                           )}

                           {item.observation && <p className="italic text-gray-400">"{item.observation}"</p>}
                         </div>
                       </div>
                    ))}
                  </div>

                  {/* Endereço de entrega como estava na hora do pedido */}
                  {address && (
                    <div className="pt-3 border-t border-gray-200 dark:border-slate-800 flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400">
                      <MapPin size={14} className="mt-0.5 shrink-0 text-orange-500" />
                      <div>
                        <span className="block font-bold text-gray-700 dark:text-gray-300">
                          Endereço de entrega{address.nickname ? ` (${address.nickname})` : ''}
                        </span>
                        <span className="block">{addressStreetLine(address)}{address.complement ? ` - ${address.complement}` : ''}</span>
                        <span className="block">{addressAreaLine(address)}</span>
                      </div>
                    </div>
                  )}

                  {/* Infos Adicionais */}
                  {Number(order.delivery_fee ?? 0) > 0 && (
                    <div className="pt-3 border-t border-gray-200 dark:border-slate-800 text-xs text-gray-500 dark:text-gray-400 flex justify-between">
                      <span>Taxa de entrega</span>
                      <span>{formatCurrency(order.delivery_fee)}</span>
                    </div>
                  )}

                  <div className="pt-3 border-t border-gray-200 dark:border-slate-800 text-sm flex justify-between items-center gap-3">
                     <div>
                        <span className="text-gray-500 dark:text-gray-400 block text-xs">Pagamento</span>
                        <span className="font-bold text-gray-700 dark:text-gray-300">
                          {paymentMethodLabel(order.payment_method)}
                        </span>
                        <span className="block text-xs text-gray-500 dark:text-gray-400">
                          {customerPaymentStatusLabel(order)}
                          {changeFor > 0 && ` · troco para ${formatCurrency(changeFor)}`}
                        </span>
                        {order.payment_status === 'REFUNDED' && (
                          <span className="block text-xs text-blue-600 dark:text-blue-400 mt-0.5">O valor foi devolvido pelo Mercado Pago.</span>
                        )}
                        {order.payment_status === 'REFUND_PENDING' && (
                          <span className="block text-xs text-amber-600 dark:text-amber-400 mt-0.5">A devolução ainda não foi concluída; a loja vai finalizá-la.</span>
                        )}
                     </div>

                     {order.status === 'PENDING' && (
                       <button
                         onClick={() => setOrderToCancel(order)}
                         className="shrink-0 text-red-500 dark:text-red-400 text-xs font-bold hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 px-3 py-1.5 rounded-lg transition-colors border border-red-100 dark:border-red-900"
                       >
                         Cancelar Pedido
                       </button>
                     )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <ConfirmModal
        isOpen={!!orderToCancel}
        onClose={() => setOrderToCancel(null)}
        onConfirm={executeCancel}
        title="Cancelar Pedido?"
        message={cancelMessage}
        confirmLabel="Sim, Cancelar"
        isDestructive
      />
    </div>
  );
}
