import { useCallback, useRef, useState } from 'react';
import {
  Clock, CheckCircle, XCircle, AlertTriangle, ShieldAlert, RotateCcw, Undo2,
  MapPin, User, AlertCircle, ChefHat, Bike, Bell, ExternalLink, Navigation, Banknote, Package, RefreshCw
} from 'lucide-react';
import { orderLabel, orderService, type Order, type OrderItem, type OrderStatus } from '../../services/orderService';
import { getApiErrorMessage, getApiErrorStatus } from '../../services/api';
import ConfirmModal from '../../components/ConfirmModal';
import DriverModal from '../../components/Driver/DriverModal';
import StoreToggle from '../../components/StoreToggle';
import toast from 'react-hot-toast';
import { useAuth } from '../../contexts/AuthContext';
import { usePolling } from '../../hooks/usePolling';
import { isOrderManager, roleLabel } from '../../utils/roles';
import {
  addonSummary, addressAreaLine, addressStreetLine, isCashPayment, isOrderPaid, isPaymentReversed, isRefundableOnCancel, isTerminalStatus,
  mapsSearchUrl, orderAddress, orderItemName, orderStatusLabel, paymentMethodLabel, paymentStatusLabel, paymentStatusTone,
  type PaymentTone,
} from '../../utils/orders';
import { formatCurrency, formatTime, parseMoney } from '../../utils/format';

// Novos pedidos aparecem no quadro sem recarregar a página
const POLL_INTERVAL_MS = 5000;

const STATUS_MESSAGES: Partial<Record<OrderStatus, string>> = {
  PREPARING: 'Enviado para a cozinha! 🔥',
  READY_FOR_PICKUP: 'Pedido Liberado! ✅',
  DELIVERING: 'Saiu para entrega! 🏍️',
  DONE: 'Pedido finalizado! 🎉',
  CANCELED: 'Pedido cancelado.'
};

const STATUS_BADGE_CLASSES: Record<OrderStatus, string> = {
  PENDING: 'bg-yellow-50 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 border-yellow-100 dark:border-yellow-800',
  PREPARING: 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border-blue-100 dark:border-blue-800',
  READY_FOR_PICKUP: 'bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 border-purple-100 dark:border-purple-800',
  DELIVERING: 'bg-orange-50 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 border-orange-100 dark:border-orange-800',
  DONE: 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 border-green-100 dark:border-green-800',
  CANCELED: 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 border-red-100 dark:border-red-800',
};

const PAYMENT_TONE_CLASSES: Record<PaymentTone, string> = {
  paid: 'text-green-600 dark:text-green-400',
  refunded: 'text-blue-600 dark:text-blue-400',
  alert: 'text-red-600 dark:text-red-400',
  pending: 'text-amber-600 dark:text-amber-400',
  none: 'text-gray-500 dark:text-gray-400',
};

interface LoadError {
  /** 403: o perfil logado não tem acesso aos pedidos (ex.: o cargo foi alterado por um Administrador). */
  forbidden: boolean;
  message: string;
}

/** Texto da confirmação de cancelamento: pedido pago online é estornado pela API. */
function cancelConfirmMessage(order: Order | null): string {
  const base = 'Deseja realmente cancelar este pedido? Ele sai da fila e não pode ser reaberto.';
  if (order && isRefundableOnCancel(order)) return `${base} O pagamento online será estornado ao cliente pelo Mercado Pago.`;
  return `${base} O cliente verá o pedido como cancelado em Meus Pedidos.`;
}

/** Aviso depois do cancelamento, conforme o resultado do estorno devolvido pela API. */
function canceledToast(order?: Order | null): string {
  if (order?.payment_status === 'REFUNDED') return 'Pedido cancelado. Pagamento estornado ao cliente.';
  if (order?.payment_status === 'REFUND_PENDING') {
    return 'Pedido cancelado. O estorno não foi concluído: faça a devolução pelo painel do Mercado Pago.';
  }
  return 'Pedido cancelado.';
}

export default function Orders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<LoadError | null>(null);

  // Modal de Cancelamento (guarda o pedido para avisar sobre o estorno)
  const [orderToCancel, setOrderToCancel] = useState<Order | null>(null);

  // --- Estado do Modal de Motoboy (Logística) ---
  const [driverModalOpen, setDriverModalOpen] = useState(false);
  const [selectedOrderForDriver, setSelectedOrderForDriver] = useState<Order | null>(null);

  // Perfil logado. Administrador e Atendente conduzem o fluxo completo; Cozinha e Entregador, só a sua etapa.
  const { user, refreshUser } = useAuth();
  const userRole = user?.role;
  const canManage = isOrderManager(userRole);
  const isKitchen = userRole === 'KITCHEN';
  const isCourier = userRole === 'COURIER';
  // Sessão de suporte: o quadro é só para consulta (a API recusa qualquer alteração)
  const readOnly = !!user?.support_session;

  // Cada consulta recebe um número e só a mais recente é aplicada (respostas fora de ordem não fazem
  // um card voltar de coluna). A consulta automática não começa com outra consulta ou ação em andamento.
  const requestSeq = useRef(0);
  const loadInFlight = useRef(false);
  const actionsInFlight = useRef(0);
  const forbidden = useRef(false);
  // Última resposta aplicada: a consulta de 5 s que volta igual não re-renderiza o quadro inteiro
  const lastSnapshot = useRef<string | null>(null);

  const loadOrders = useCallback(async (trigger: 'poll' | 'manual' = 'manual') => {
    if (trigger === 'poll' && (loadInFlight.current || actionsInFlight.current > 0 || forbidden.current)) return;
    const requestId = ++requestSeq.current;
    loadInFlight.current = true;
    try {
      // Pedidos em andamento + concluídos/cancelados das últimas 24 h (o histórico completo fica fora do quadro)
      const data = await orderService.getActive();
      if (requestId !== requestSeq.current) return;
      const snapshot = JSON.stringify(data);
      if (snapshot !== lastSnapshot.current) {
        lastSnapshot.current = snapshot;
        setOrders([...data].sort((a, b) => b.id - a.id));
      }
      setLoadError(null);
      forbidden.current = false;
    } catch (error) {
      if (requestId !== requestSeq.current) return;
      const isForbidden = getApiErrorStatus(error) === 403;
      setLoadError({ forbidden: isForbidden, message: getApiErrorMessage(error, 'Não foi possível atualizar os pedidos.') });
      // Sem permissão: o perfil pode ter mudado; a sessão é atualizada e o usuário vai para a página certa
      if (isForbidden && !forbidden.current) void refreshUser();
      forbidden.current = isForbidden;
    } finally {
      if (requestId === requestSeq.current) {
        loadInFlight.current = false;
        setLoading(false);
      }
    }
  }, [refreshUser]);

  // Primeira carga na hora e depois a cada 5 s; pausa com a aba oculta e atualiza ao voltar
  usePolling(() => loadOrders('poll'), POLL_INTERVAL_MS, { immediate: true });

  /**
   * Erro de uma ação no quadro. 403: o perfil (ou a situação da loja) mudou e a sessão é conferida;
   * 404: o pedido não existe nesta loja (ou saiu dela) — não é troca de perfil, só recarrega o quadro.
   */
  function handleActionError(error: unknown, fallback: string) {
    const status = getApiErrorStatus(error);
    if (status === 404) {
      toast.error('Este pedido não foi encontrado nesta loja. O quadro foi atualizado.');
      return;
    }
    toast.error(getApiErrorMessage(error, fallback));
    if (status === 403) void refreshUser();
  }

  /** Ação no quadro: descarta consultas em andamento (trariam o status anterior) e recarrega no fim. */
  async function runAction(change: (order: Order) => Order, orderId: number, action: () => Promise<void>) {
    actionsInFlight.current += 1;
    requestSeq.current += 1;
    // O quadro deixa de ser igual à última resposta: a próxima consulta sempre é aplicada (desfaz o otimista se a ação falhar)
    lastSnapshot.current = null;
    // Atualização otimista (feedback visual imediato)
    setOrders(prev => prev.map(o => o.id === orderId ? change(o) : o));
    try {
      await action();
    } finally {
      actionsInFlight.current -= 1;
      loadOrders(); // Recarrega para garantir sincronia com o backend
    }
  }

  function updateStatus(id: number, newStatus: OrderStatus) {
    // Entregador que pega a entrega passa a ser o responsável (a API registra o mesmo)
    const change = (order: Order): Order => ({
      ...order,
      status: newStatus,
      driver: isCourier && user && newStatus === 'DELIVERING' && !order.driver
        ? { id: user.id, name: user.name, phone: user.phone ?? '' }
        : order.driver,
    });
    return runAction(change, id, async () => {
      try {
        await orderService.updateStatus(id, newStatus);
        toast.success(STATUS_MESSAGES[newStatus] || 'Status atualizado');
      } catch (error) {
        // Mostra o motivo do backend (ex.: transição inválida ou perfil sem permissão)
        handleActionError(error, 'Erro ao atualizar status.');
      }
    });
  }

  function executeCancel() {
    const order = orderToCancel;
    if (!order) return;
    setOrderToCancel(null);
    return runAction((o) => ({ ...o, status: 'CANCELED' }), order.id, async () => {
      try {
        // Rota de cancelamento: pedido pago online é estornado pela API
        const canceled = await orderService.cancel(order.id);
        toast.success(canceledToast(canceled));
      } catch (error) {
        handleActionError(error, 'Não foi possível cancelar o pedido.');
      }
    });
  }

  // --- LÓGICA DO BOTÃO DESPACHAR ---
  function openDriverModal(order: Order) {
    if (!orderAddress(order)) {
      toast.error('Este pedido não tem endereço de entrega.');
      return;
    }
    setSelectedOrderForDriver(order);
    setDriverModalOpen(true);
  }

  // Filtros de Colunas
  const pendingOrders = orders.filter(o => o.status === 'PENDING');
  const preparingOrders = orders.filter(o => o.status === 'PREPARING');
  // Filtro de Delivery pronto
  const readyDeliveryOrders = orders.filter(o => o.status === 'READY_FOR_PICKUP' && o.type === 'DELIVERY');
  // Filtro de Balcão pronto
  const readyTakeoutOrders = orders.filter(o => o.status === 'READY_FOR_PICKUP' && o.type === 'TAKEOUT');
  const deliveringOrders = orders.filter(o => o.status === 'DELIVERING');
  const doneOrders = orders.filter(o => o.status === 'DONE').slice(0, 10);
  // Estorno pendente fica sempre visível (a loja precisa concluí-lo); dos demais cancelados, os 5 mais recentes
  const allCanceled = orders.filter(o => o.status === 'CANCELED');
  const refundPendingOrders = allCanceled.filter(o => o.payment_status === 'REFUND_PENDING');
  const canceledOrders = [...refundPendingOrders, ...allCanceled.filter(o => o.payment_status !== 'REFUND_PENDING').slice(0, 5)];
  // Pagamento desfeito no Mercado Pago (estorno ou contestação) com o pedido ainda em andamento: a loja não vai receber
  const reversedOrders = orders.filter(o => isPaymentReversed(o) && !isTerminalStatus(o.status));

  // Regras de Visibilidade das Colunas (Administrador e Atendente veem todas)
  const showNew = canManage || isKitchen;
  const showKitchen = canManage || isKitchen;
  const showReadyDelivery = canManage || isCourier; // Entregador vê isso
  const showReadyTakeout = canManage;
  const showDelivery = canManage || isCourier; // Entregador vê isso
  const showDone = canManage;
  const showCanceled = canManage;

  const renderCard = (order: Order) => (
    <OrderCard
      key={order.id}
      order={order}
      canManage={canManage}
      isKitchen={isKitchen}
      isCourier={isCourier}
      readOnly={readOnly}
      currentUserId={user?.id}
      onUpdateStatus={updateStatus}
      onDispatch={openDriverModal}
      onCancel={setOrderToCancel}
    />
  );

  if (loading) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-500">
        <Clock className="animate-spin mb-2" size={32} />
        <p>Carregando painel de pedidos...</p>
      </div>
    );
  }

  // Sem permissão (403): explica em vez de mostrar colunas vazias
  if (loadError?.forbidden) {
    return (
      <div role="alert" className="h-full flex flex-col items-center justify-center text-center gap-4 p-6">
        <div className="bg-red-50 dark:bg-red-900/20 p-5 rounded-full text-red-500 dark:text-red-400 border border-red-100 dark:border-red-900">
          <ShieldAlert size={44} />
        </div>
        <h1 className="text-xl font-bold text-gray-800 dark:text-white">Sem acesso aos pedidos</h1>
        <p className="text-gray-500 dark:text-gray-400 max-w-md">
          {loadError.message} Se o seu cargo foi alterado, a página certa abre em instantes.
        </p>
        <button onClick={() => loadOrders()} className="flex items-center gap-2 bg-orange-600 hover:bg-orange-700 text-white px-5 py-2.5 rounded-xl font-bold text-sm transition-colors">
          <RotateCcw size={16} /> Tentar novamente
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-20 h-full flex flex-col">
      <div className="flex flex-wrap justify-between items-center gap-4 bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-700 shrink-0 transition-colors">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-800 dark:text-white">
            {userRole === 'KITCHEN' ? 'Monitor da Cozinha 🍳' :
             userRole === 'COURIER' ? 'Painel de Entregas 🏍️' :
             'Gestão de Pedidos'}
          </h1>
          <p className="text-xs text-gray-400 dark:text-gray-500 hidden sm:block">Logado como: <span className="font-bold text-orange-600">{roleLabel(userRole)}</span></p>
        </div>
        <div className="flex items-center gap-3">
          {/* Administrador e Atendente abrem/fecham a loja daqui */}
          {canManage && <StoreToggle variant="compact" />}
          <button onClick={() => loadOrders()} className="p-2 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-full transition-colors text-gray-600 dark:text-gray-300" title="Atualizar" aria-label="Atualizar"><RefreshCw size={20}/></button>
        </div>
      </div>

      {/* Falha de conexão: o quadro continua com os últimos dados e tenta de novo sozinho */}
      {loadError && (
        <div role="alert" className="flex flex-wrap items-center gap-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 px-4 py-3 rounded-2xl text-sm shrink-0">
          <AlertTriangle size={18} className="shrink-0" />
          <span className="flex-1 min-w-50">{loadError.message} Os pedidos abaixo podem estar desatualizados.</span>
          <button onClick={() => loadOrders()} className="flex items-center gap-1.5 font-bold hover:underline">
            <RotateCcw size={14} /> Tentar novamente
          </button>
        </div>
      )}

      {/* Estorno que o Mercado Pago não confirmou: a gestão precisa concluir a devolução */}
      {canManage && refundPendingOrders.length > 0 && (
        <div className="flex items-start gap-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 px-4 py-3 rounded-2xl text-sm shrink-0">
          <AlertTriangle size={18} className="shrink-0 mt-0.5" />
          <p>
            <span className="font-bold">Estorno pendente em {refundPendingOrders.length} pedido(s) cancelado(s)</span>
            {' '}({refundPendingOrders.map(o => orderLabel(o)).join(', ')}). O Mercado Pago não confirmou a devolução: conclua o estorno pelo painel do Mercado Pago.
          </p>
        </div>
      )}

      {/* Estorno ou contestação feitos no Mercado Pago com o pedido em andamento: não entregar sem receber */}
      {reversedOrders.length > 0 && (
        <div role="alert" className="flex items-start gap-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 px-4 py-3 rounded-2xl text-sm shrink-0">
          <Undo2 size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
          <p>
            <span className="font-bold">Pagamento estornado no Mercado Pago em {reversedOrders.length} pedido(s) em andamento</span>
            {' '}({reversedOrders.map(o => orderLabel(o)).join(', ')}). O valor foi devolvido ao cliente (estorno ou contestação):
            não entregue sem receber de outra forma{canManage ? ', ou cancele o pedido' : ''}.
          </p>
        </div>
      )}

      <div className="flex-1 overflow-x-auto pb-4 -mx-4 px-4 lg:mx-0 lg:px-0">
        <div className="flex gap-6 min-w-max lg:min-w-0 h-full">

          {showNew && (
            <div className="w-[320px] flex flex-col gap-4">
              <div className="bg-yellow-50 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-400 p-3 rounded-xl font-bold flex justify-between items-center border border-yellow-100 dark:border-yellow-800 sticky top-0 z-10 shadow-sm transition-colors">
                 <span className="flex items-center gap-2"><AlertCircle size={18}/> Novos</span>
                 <span className="bg-white dark:bg-slate-800 px-2 py-0.5 rounded-md text-xs shadow-sm">{pendingOrders.length}</span>
              </div>
              <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar h-full">
                {pendingOrders.map(renderCard)}
                {pendingOrders.length === 0 && <div className="text-center text-gray-400 dark:text-gray-600 py-10 italic text-sm">Sem novos pedidos</div>}
              </div>
            </div>
          )}

          {showKitchen && (
            <div className="w-[320px] flex flex-col gap-4">
              <div className="bg-blue-50 dark:bg-blue-900/30 text-blue-800 dark:text-blue-400 p-3 rounded-xl font-bold flex justify-between items-center border border-blue-100 dark:border-blue-800 sticky top-0 z-10 shadow-sm transition-colors">
                 <span className="flex items-center gap-2"><ChefHat size={18}/> Preparando</span>
                 <span className="bg-white dark:bg-slate-800 px-2 py-0.5 rounded-md text-xs shadow-sm">{preparingOrders.length}</span>
              </div>
              <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar h-full">
                {preparingOrders.map(renderCard)}
                {preparingOrders.length === 0 && <div className="text-center text-gray-400 dark:text-gray-600 py-10 italic text-sm">Cozinha livre</div>}
              </div>
            </div>
          )}

          {showReadyDelivery && (
            <div className="w-[320px] flex flex-col gap-4">
              <div className="bg-purple-50 dark:bg-purple-900/30 text-purple-800 dark:text-purple-400 p-3 rounded-xl font-bold flex justify-between items-center border border-purple-100 dark:border-purple-800 sticky top-0 z-10 shadow-sm transition-colors">
                 <span className="flex items-center gap-2"><Bell size={18}/> Aguardando Motoboy</span>
                 <span className="bg-white dark:bg-slate-800 px-2 py-0.5 rounded-md text-xs shadow-sm">{readyDeliveryOrders.length}</span>
              </div>
              <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar h-full">
                {readyDeliveryOrders.map(renderCard)}
                {readyDeliveryOrders.length === 0 && <div className="text-center text-gray-400 dark:text-gray-600 py-10 italic text-sm">Nenhum delivery pronto</div>}
              </div>
            </div>
          )}

          {showReadyTakeout && (
            <div className="w-[320px] flex flex-col gap-4">
              <div className="bg-teal-50 dark:bg-teal-900/30 text-teal-800 dark:text-teal-400 p-3 rounded-xl font-bold flex justify-between items-center border border-teal-100 dark:border-teal-800 sticky top-0 z-10 shadow-sm transition-colors">
                 <span className="flex items-center gap-2"><Package size={18}/> Retirar no Balcão</span>
                 <span className="bg-white dark:bg-slate-800 px-2 py-0.5 rounded-md text-xs shadow-sm">{readyTakeoutOrders.length}</span>
              </div>
              <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar h-full">
                {readyTakeoutOrders.map(renderCard)}
                {readyTakeoutOrders.length === 0 && <div className="text-center text-gray-400 dark:text-gray-600 py-10 italic text-sm">Nenhum pedido no balcão</div>}
              </div>
            </div>
          )}

          {showDelivery && (
            <div className="w-[320px] flex flex-col gap-4">
              <div className="bg-orange-50 dark:bg-orange-900/30 text-orange-800 dark:text-orange-400 p-3 rounded-xl font-bold flex justify-between items-center border border-orange-100 dark:border-orange-800 sticky top-0 z-10 shadow-sm transition-colors">
                 <span className="flex items-center gap-2"><Bike size={18}/> Em Entrega</span>
                 <span className="bg-white dark:bg-slate-800 px-2 py-0.5 rounded-md text-xs shadow-sm">{deliveringOrders.length}</span>
              </div>
              <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar h-full">
                {deliveringOrders.map(renderCard)}
                {deliveringOrders.length === 0 && <div className="text-center text-gray-400 dark:text-gray-600 py-10 italic text-sm">Nenhuma entrega em andamento</div>}
              </div>
            </div>
          )}

          {showDone && (
            <div className="w-[320px] flex flex-col gap-4">
              <div className="bg-green-50 dark:bg-green-900/30 text-green-800 dark:text-green-400 p-3 rounded-xl font-bold flex justify-between items-center border border-green-100 dark:border-green-800 sticky top-0 z-10 shadow-sm transition-colors">
                 <span className="flex items-center gap-2"><CheckCircle size={18}/> Concluídos</span>
                 <span className="bg-white dark:bg-slate-800 px-2 py-0.5 rounded-md text-xs shadow-sm">{doneOrders.length}</span>
              </div>
              <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar h-full">
                {doneOrders.map(renderCard)}
              </div>
            </div>
          )}

          {showCanceled && (
            <div className="w-[320px] flex flex-col gap-4 opacity-75">
              <div className="bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-gray-400 p-3 rounded-xl font-bold flex justify-between items-center border border-gray-200 dark:border-slate-700 sticky top-0 z-10 shadow-sm transition-colors">
                 <span className="flex items-center gap-2"><XCircle size={18}/> Cancelados</span>
                 <span className="bg-white dark:bg-slate-900 px-2 py-0.5 rounded-md text-xs shadow-sm">{canceledOrders.length}</span>
              </div>
              <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar h-full">
                {canceledOrders.map(renderCard)}
              </div>
            </div>
          )}

        </div>
      </div>

      <ConfirmModal
        isOpen={!!orderToCancel}
        onClose={() => setOrderToCancel(null)}
        onConfirm={executeCancel}
        title="Cancelar Pedido?"
        message={cancelConfirmMessage(orderToCancel)}
        confirmLabel="Sim, Cancelar Pedido"
        isDestructive
      />

      <DriverModal
        isOpen={driverModalOpen}
        onClose={() => setDriverModalOpen(false)}
        targetOrder={selectedOrderForDriver}
        onSuccess={() => {
          loadOrders(); // Recarrega tudo após o despacho
          setDriverModalOpen(false);
        }}
      />
    </div>
  );
}

interface OrderCardProps {
  order: Order;
  canManage: boolean;
  isKitchen: boolean;
  isCourier: boolean;
  /** Sessão de suporte: sem botões de ação. */
  readOnly: boolean;
  currentUserId?: number;
  onUpdateStatus: (id: number, status: OrderStatus) => void;
  onDispatch: (order: Order) => void;
  onCancel: (order: Order) => void;
}

/** Texto do selo de status; no "pronto", a palavra principal fica em destaque (AGUARDANDO entregador, pronto no BALCÃO). */
function StatusBadgeText({ order }: { order: Order }) {
  if (order.status === 'READY_FOR_PICKUP') {
    return order.type === 'TAKEOUT'
      ? <>Pronto no <span className="font-black">Balcão</span></>
      : <><span className="font-black">Aguardando</span> entregador</>;
  }
  return <>{orderStatusLabel(order.status, order.type)}</>;
}

// --- CARD DO PEDIDO (componente próprio: não é recriado a cada atualização do quadro) ---
function OrderCard({ order, canManage, isKitchen, isCourier, readOnly, currentUserId, onUpdateStatus, onDispatch, onCancel }: OrderCardProps) {
  const isDelivery = order.type === 'DELIVERY';
  const totalOrder = Number(order.total_price);
  // Endereço salvo no pedido (retrato); pedidos antigos usam o endereço cadastrado
  const address = isDelivery ? orderAddress(order) : null;
  // Regras da API para o entregador: pega a entrega pronta sem responsável (ou já atribuída a ele)
  // e só confirma a entrega que está no nome dele
  const isAssignedToMe = currentUserId !== undefined && order.driver?.id === currentUserId;
  const canTakeDelivery = currentUserId !== undefined && (!order.driver || isAssignedToMe);

  // Troco: "R$ 50,00" (ou valores antigos como "50")
  const changeForValue = isCashPayment(order.payment_method) ? parseMoney(order.change_for) : 0;
  const changeToReturn = changeForValue > 0 ? Math.max(0, changeForValue - totalOrder) : 0;
  const showChangeAlert = changeForValue > 0 && !isOrderPaid(order) && order.status !== 'CANCELED' && (canManage || isCourier);
  // Estorno ou contestação no Mercado Pago sem o pedido ter sido cancelado
  const paymentReversed = isPaymentReversed(order);
  const reversedActive = paymentReversed && !isTerminalStatus(order.status);

  // RENDERIZAÇÃO DOS BOTÕES DE AÇÃO (só as transições permitidas ao perfil logado)
  const renderActions = () => {
    if (readOnly) return null;
    // 1. PENDENTE -> PREPARANDO
    if (order.status === 'PENDING' && (canManage || isKitchen)) {
      return (
        <button onClick={() => onUpdateStatus(order.id, 'PREPARING')} className="w-full bg-blue-600 text-white py-2.5 rounded-xl text-sm font-bold flex justify-center items-center gap-2 hover:bg-blue-700 shadow-sm transition-colors shadow-blue-200 dark:shadow-none">
          <ChefHat size={18}/> Aceitar e Preparar
        </button>
      );
    }

    // 2. PREPARANDO -> PRONTO
    if (order.status === 'PREPARING' && (canManage || isKitchen)) {
      return (
        <button onClick={() => onUpdateStatus(order.id, 'READY_FOR_PICKUP')} className="w-full bg-orange-600 text-white py-2.5 rounded-xl text-sm font-bold flex justify-center items-center gap-2 hover:bg-orange-700 shadow-sm transition-colors shadow-orange-200 dark:shadow-none">
          {isDelivery ? <><Bell size={18}/> Chamar Motoboy</> : <><CheckCircle size={18}/> Pronto (Balcão)</>}
        </button>
      );
    }

    // 3. PRONTO -> ENTREGA / FINALIZADO
    if (order.status === 'READY_FOR_PICKUP') {
      if (isDelivery) {
         // ADMINISTRADOR / ATENDENTE: ABRE O MODAL DE LOGÍSTICA
         if (canManage) {
           return (
             <button onClick={() => onDispatch(order)} className="w-full bg-indigo-600 text-white py-2.5 rounded-xl text-sm font-bold flex justify-center items-center gap-2 hover:bg-indigo-700 shadow-sm transition-colors animate-pulse shadow-indigo-200 dark:shadow-none">
               <Bike size={18}/> Despachar (Logística)
             </button>
           );
         }
         // ENTREGADOR: PEGA DIRETO (o backend atribui a entrega a ele); não pega a de outro entregador
         if (isCourier && canTakeDelivery) {
           return (
             <button onClick={() => onUpdateStatus(order.id, 'DELIVERING')} className="w-full bg-indigo-600 text-white py-2.5 rounded-xl text-sm font-bold flex justify-center items-center gap-2 hover:bg-indigo-700 shadow-sm transition-colors">
               <Bike size={18}/> Pegar para Entrega
             </button>
           );
         }
      } else if (canManage) {
        // Balcão
        return (
          <button onClick={() => onUpdateStatus(order.id, 'DONE')} className="w-full bg-teal-600 text-white py-2.5 rounded-xl text-sm font-bold flex justify-center items-center gap-2 hover:bg-teal-700 shadow-sm transition-colors shadow-teal-200 dark:shadow-none">
            <CheckCircle size={18}/> Entregue ao Cliente
          </button>
        );
      }
    }

    // 4. EM ENTREGA -> FINALIZADO (o entregador só confirma a entrega que está no nome dele)
    if (order.status === 'DELIVERING' && (canManage || (isCourier && isAssignedToMe))) {
      return (
        <button onClick={() => onUpdateStatus(order.id, 'DONE')} className="w-full bg-green-600 text-white py-2.5 rounded-xl text-sm font-bold flex justify-center items-center gap-2 hover:bg-green-700 shadow-sm transition-colors shadow-green-200 dark:shadow-none">
          <CheckCircle size={18}/> Confirmar Entrega
        </button>
      );
    }
    return null;
  };

  return (
    <div
      data-order-id={order.id}
      className={`bg-white dark:bg-slate-800 border rounded-2xl p-4 shadow-sm hover:shadow-md transition-all flex flex-col gap-3 min-w-[300px] ${reversedActive ? 'border-red-300 dark:border-red-800 ring-1 ring-red-200 dark:ring-red-900/60' : 'border-gray-100 dark:border-slate-700'}`}
    >
      {/* Header do Card */}
      <div className="flex justify-between items-start gap-2 border-b border-gray-50 dark:border-slate-700 pb-3">
        <div className="min-w-0">
          {/* Número do pedido NA LOJA; o id interno (rotas, suporte) fica no title */}
          <h3 className="font-bold text-gray-800 dark:text-white text-lg flex items-center gap-2" title={`ID interno ${order.id}`}>
            {orderLabel(order)}
            <span className="text-xs font-normal text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-slate-700 px-2 py-0.5 rounded-full border border-gray-100 dark:border-slate-600">
              {formatTime(order.created_at)}
            </span>
          </h3>
          <div className="flex items-center gap-1 text-sm font-bold text-gray-600 dark:text-gray-300 mt-1">
            <User size={14} /> {order.user?.name || 'Cliente'}
          </div>

          {/* EXIBE MOTOBOY SE JÁ TIVER UM ATRIBUÍDO */}
          {order.driver && (
            <div className="flex items-center gap-1 text-xs font-bold text-indigo-600 dark:text-indigo-400 mt-1 bg-indigo-50 dark:bg-indigo-900/20 px-2 py-0.5 rounded w-fit">
              <Bike size={12} /> Motoboy: {order.driver.name}
            </div>
          )}
        </div>
        <span className={`px-2 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wide border text-center shrink-0 max-w-38 ${STATUS_BADGE_CLASSES[order.status] ?? STATUS_BADGE_CLASSES.CANCELED}`}>
          <StatusBadgeText order={order} />
        </span>
      </div>

      {/* Info Financeira (nos cancelados mostra se houve estorno) */}
      <div className="flex justify-between items-center gap-2 bg-gray-50 dark:bg-slate-700 p-2 rounded-lg">
         <div className="min-w-0">
           <span className="block text-xs font-bold text-gray-500 dark:text-gray-300 uppercase truncate">
             {paymentMethodLabel(order.payment_method)}
           </span>
           <span className={`text-[10px] font-bold flex items-center gap-1 ${PAYMENT_TONE_CLASSES[paymentStatusTone(order)]}`}>
             {(order.payment_status === 'REFUND_PENDING' || paymentReversed) && <AlertTriangle size={10} aria-hidden="true" />}
             {paymentStatusLabel(order)}
           </span>
         </div>
         <span className="font-bold text-gray-900 dark:text-white shrink-0">
           {formatCurrency(order.total_price)}
         </span>
      </div>

      {/* Pagamento desfeito no Mercado Pago (estorno ou contestação): a loja não recebe por este pedido */}
      {paymentReversed && (
        <div role="alert" className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 rounded-xl text-red-800 dark:text-red-300">
          <div className="flex items-center gap-2 font-bold text-sm mb-1">
            <Undo2 size={18} aria-hidden="true" /> PAGAMENTO ESTORNADO
          </div>
          <p className="text-xs">
            {reversedActive
              ? `O pagamento online foi desfeito no Mercado Pago (estorno ou contestação). Não entregue sem receber de outra forma${canManage ? ', ou cancele o pedido' : ''}.`
              : 'O pagamento online foi desfeito no Mercado Pago (estorno ou contestação) depois da entrega. Confira no painel do Mercado Pago.'}
          </p>
        </div>
      )}

      {/* Alerta de Troco */}
      {showChangeAlert && (
        <div className="bg-green-100 dark:bg-green-900/20 border border-green-200 dark:border-green-800 p-3 rounded-xl animate-pulse">
          <div className="flex items-center gap-2 text-green-800 dark:text-green-300 font-bold text-sm mb-1">
            <Banknote size={18}/> TROCO NECESSÁRIO
          </div>
          <div className="text-xs text-green-700 dark:text-green-400 space-y-1">
            <p>Paga com: <b>{formatCurrency(changeForValue)}</b></p>
            <p className="text-sm border-t border-green-200 dark:border-green-800 pt-1 mt-1">
              Levar: <b className="text-lg">{formatCurrency(changeToReturn)}</b>
            </p>
          </div>
        </div>
      )}

      {/* Endereço com Link do Maps */}
      {address ? (
         <div className="bg-gray-50 dark:bg-slate-700 p-3 rounded-xl border border-dashed border-gray-200 dark:border-slate-600">
           <div className="flex items-start gap-2">
             <MapPin size={16} className="text-orange-600 dark:text-orange-400 mt-0.5 shrink-0"/>
             <div className="text-xs text-gray-600 dark:text-gray-300">
               <p className="font-bold text-gray-800 dark:text-white">{addressStreetLine(address)}</p>
               <p>{addressAreaLine(address)}</p>
               {address.complement && <p className="text-blue-600 dark:text-blue-400 mt-1 font-medium bg-blue-50 dark:bg-blue-900/20 inline-block px-1 rounded">Ref: {address.complement}</p>}
             </div>
           </div>

           {(isCourier || canManage) && (
             <a
               href={mapsSearchUrl(address)}
               target="_blank"
               rel="noopener noreferrer"
               className="mt-2 flex items-center justify-center gap-2 w-full bg-white dark:bg-slate-600 border border-gray-200 dark:border-slate-500 py-2 rounded-lg text-xs font-bold text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-slate-500 transition-colors"
             >
               <Navigation size={14}/> Abrir no Google Maps <ExternalLink size={10}/>
             </a>
           )}
         </div>
      ) : isDelivery && isKitchen ? (
         // A cozinha não recebe o endereço do cliente (só precisa saber que é entrega)
         <div className="bg-orange-50 dark:bg-orange-900/20 p-2 rounded-lg text-xs text-orange-700 dark:text-orange-300 font-bold text-center border border-orange-100 dark:border-orange-800">
           <Bike size={14} className="inline mr-1"/> Entrega (delivery)
         </div>
      ) : isDelivery ? (
         <div className="bg-red-50 dark:bg-red-900/20 p-2 rounded-lg text-xs text-red-700 dark:text-red-300 font-bold text-center border border-red-100 dark:border-red-800">
           <MapPin size={14} className="inline mr-1"/> Entrega sem endereço informado
         </div>
      ) : (
         <div className="bg-teal-50 dark:bg-teal-900/20 p-2 rounded-lg text-xs text-teal-700 dark:text-teal-300 font-bold text-center border border-teal-100 dark:border-teal-800">
           <Package size={14} className="inline mr-1"/> Retirada no Balcão
         </div>
      )}

      {/* Lista de Itens (nome como foi vendido) */}
      <div className="space-y-2 py-2">
        {order.items.map((item: OrderItem) => (
          <div key={item.id} className="text-sm border-b border-gray-50 dark:border-slate-700 last:border-0 pb-2 last:pb-0">
            <div className="flex justify-between items-start">
              <span className="text-gray-800 dark:text-white">
                <span className="font-bold bg-gray-100 dark:bg-slate-700 px-1.5 py-0.5 rounded text-gray-900 dark:text-white mr-2">{item.quantity}x</span>
                {orderItemName(item)}
              </span>
            </div>
            <div className="pl-8 text-xs space-y-0.5 mt-1">
              {item.meat_point && <p className="text-orange-600 dark:text-orange-400 font-bold">🔥 Ponto: {item.meat_point}</p>}
              {item.removed_ingredients && item.removed_ingredients.length > 0 && (
                <p className="text-red-500 dark:text-red-400 font-bold bg-red-50 dark:bg-red-900/20 inline-block px-1 rounded">
                  🚫 Sem: {Array.isArray(item.removed_ingredients) ? item.removed_ingredients.join(', ') : item.removed_ingredients}
                </p>
              )}
              {item.addons && item.addons.length > 0 && (
                <p className="text-green-600 dark:text-green-400 font-bold">
                  ✨ + {addonSummary(item).join(', ')}
                </p>
              )}
              {item.observation && (
                <p className="text-gray-500 dark:text-gray-400 italic bg-yellow-50 dark:bg-yellow-900/10 p-1 rounded border border-yellow-100 dark:border-yellow-900/30 mt-1">
                  "Obs: {item.observation}"
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Footer: Botões de Ação */}
      <div className="pt-2 mt-auto">
        {renderActions()}
        {!isTerminalStatus(order.status) && canManage && !readOnly && (
           <button onClick={() => onCancel(order)} className="w-full text-center text-red-400 hover:text-red-600 dark:hover:text-red-300 text-xs hover:underline mt-2">
             Cancelar Pedido
           </button>
        )}
      </div>
    </div>
  );
}
