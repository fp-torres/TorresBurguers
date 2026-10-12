import React, { memo, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator,
  Alert, Linking, Modal, AppState, useWindowDimensions,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import api, { LONG_TIMEOUT_MS } from '../../../services/api';
import { AuthContext } from '../../../contexts/AuthContext';
import { ThemeContext } from '../../../contexts/ThemeContext';
import { StoreContext, useStoreToggle } from '../../../contexts/StoreContext';
import type { FeatherIconName } from '../../../utils/catalog';
import { formatPrice, formatTime } from '../../../utils/format';
import { getErrorMessage } from '../../../utils/errors';
import {
  Order, OrderAction, OrderPerson, changeInfo, isPaidOnline, isRefundableOnCancel, isTerminalStatus,
  itemAddons, itemName, orderAddress, orderPaymentStatusLabel, paymentDescription, paymentMethodLabel,
  paymentStatusTextClass, removedIngredients, staffActions, staffStatusLabel,
} from '../../../utils/orders';

const POLL_INTERVAL_MS = 5000;

/** Largura de cada coluna (w-80) + espaço entre elas (mr-4): o quadro para sempre no início de uma coluna. */
const COLUMN_WIDTH = 320;
const COLUMN_GAP = 16;

/** Versão do pedido: updated_at muda a cada alteração (status e pagamento entram por garantia). */
function orderSignature(order: Order): string {
  return `${order.id}:${order.updated_at ?? ''}:${order.status}:${order.payment_status ?? ''}`;
}

/** Assinatura da lista para o polling: muda quando um pedido entra, sai ou é alterado. */
function listSignature(list: Order[]): string {
  return list.map(orderSignature).join('|');
}

interface Column {
  key: string;
  title: string;
  icon: FeatherIconName;
  empty: string;
  headerClass: string;
  titleClass: string;
  iconColor: { light: string; dark: string };
  filter: (order: Order) => boolean;
}

const TONES = {
  yellow: {
    headerClass: 'bg-yellow-50 dark:bg-yellow-900/30 border-yellow-100 dark:border-yellow-800',
    titleClass: 'text-yellow-800 dark:text-yellow-400',
    iconColor: { light: '#854d0e', dark: '#facc15' },
  },
  blue: {
    headerClass: 'bg-blue-50 dark:bg-blue-900/30 border-blue-100 dark:border-blue-800',
    titleClass: 'text-blue-800 dark:text-blue-400',
    iconColor: { light: '#1e40af', dark: '#60a5fa' },
  },
  purple: {
    headerClass: 'bg-purple-50 dark:bg-purple-900/30 border-purple-100 dark:border-purple-800',
    titleClass: 'text-purple-800 dark:text-purple-400',
    iconColor: { light: '#6b21a8', dark: '#c084fc' },
  },
  teal: {
    headerClass: 'bg-teal-50 dark:bg-teal-900/30 border-teal-100 dark:border-teal-800',
    titleClass: 'text-teal-800 dark:text-teal-400',
    iconColor: { light: '#115e59', dark: '#2dd4bf' },
  },
  orange: {
    headerClass: 'bg-orange-50 dark:bg-orange-900/30 border-orange-100 dark:border-orange-800',
    titleClass: 'text-orange-800 dark:text-orange-400',
    iconColor: { light: '#9a3412', dark: '#fb923c' },
  },
  gray: {
    headerClass: 'bg-gray-100 dark:bg-slate-800 border-gray-200 dark:border-slate-700',
    titleClass: 'text-gray-700 dark:text-slate-300',
    iconColor: { light: '#374151', dark: '#cbd5e1' },
  },
};

/** Colunas do quadro de acordo com o perfil (o backend valida cada transição de novo). */
function columnsFor(role: string, userId?: number): Column[] {
  const isMine = (order: Order) => !!order.driver && order.driver.id === userId;

  const pending: Column = { key: 'pending', title: 'Novos', icon: 'alert-circle', empty: 'Sem novos pedidos', ...TONES.yellow, filter: (o) => o.status === 'PENDING' };
  const preparing: Column = { key: 'preparing', title: 'Em preparo', icon: 'play-circle', empty: 'Cozinha livre', ...TONES.blue, filter: (o) => o.status === 'PREPARING' };

  if (role === 'KITCHEN') return [pending, preparing];

  if (role === 'COURIER') {
    return [
      {
        key: 'ready', title: 'Prontos para entrega', icon: 'bell', empty: 'Nenhuma entrega aguardando', ...TONES.purple,
        filter: (o) => o.status === 'READY_FOR_PICKUP' && o.type === 'DELIVERY' && (!o.driver || isMine(o)),
      },
      {
        key: 'mine', title: 'Minhas entregas', icon: 'truck', empty: 'Nenhuma entrega em andamento', ...TONES.orange,
        filter: (o) => o.status === 'DELIVERING' && isMine(o),
      },
    ];
  }

  // Administrador e Atendente acompanham todo o fluxo (e os encerrados recentes, com os estornos)
  return [
    pending,
    preparing,
    { key: 'ready-delivery', title: 'Aguardando entregador', icon: 'bell', empty: 'Nenhum delivery pronto', ...TONES.purple, filter: (o) => o.status === 'READY_FOR_PICKUP' && o.type === 'DELIVERY' },
    { key: 'ready-takeout', title: 'Pronto para retirada', icon: 'package', empty: 'Nenhum pedido no balcão', ...TONES.teal, filter: (o) => o.status === 'READY_FOR_PICKUP' && o.type !== 'DELIVERY' },
    { key: 'delivering', title: 'Em entrega', icon: 'truck', empty: 'Nenhuma entrega ativa', ...TONES.orange, filter: (o) => o.status === 'DELIVERING' },
    { key: 'closed', title: 'Encerrados (24 h)', icon: 'archive', empty: 'Nenhum pedido encerrado nas últimas 24 h', ...TONES.gray, filter: (o) => isTerminalStatus(o.status) },
  ];
}

/** Estornos pendentes primeiro (precisam de ação da loja); o resto segue do mais novo para o mais antigo. */
function sortForColumn(list: Order[]): Order[] {
  return [...list].sort((a, b) => Number(b.payment_status === 'REFUND_PENDING') - Number(a.payment_status === 'REFUND_PENDING') || b.id - a.id);
}

function headerTitle(role: string) {
  if (role === 'KITCHEN') return 'Monitor da Cozinha 🍳';
  if (role === 'COURIER') return 'Minhas Entregas 🏍️';
  return 'Gestão de Pedidos';
}

function minutesSince(date: string) {
  const diff = Math.floor((Date.now() - new Date(date).getTime()) / 60000);
  return Number.isFinite(diff) && diff >= 0 ? diff : 0;
}

function openMaps(order: Order) {
  const address = orderAddress(order);
  if (!address) return;
  const { street, number, neighborhood, city, state } = address;
  const query = encodeURIComponent(`${street}, ${number} - ${neighborhood}, ${city}${state ? ` - ${state}` : ''}`);
  Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${query}`).catch(() => undefined);
}

function callPhone(phone?: string | null) {
  if (!phone) return;
  Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`).catch(() => undefined);
}

// --- CARD DO PEDIDO (fora do componente principal para não remontar a cada atualização) ---

interface OrderCardProps {
  order: Order;
  role: string;
  userId?: number;
  isDark: boolean;
  busy: boolean;
  /** Muda a cada minuto só para recalcular o tempo de espera. */
  minuteTick: number;
  onAction: (order: Order, action: OrderAction) => void;
}

const OrderCard = memo(function OrderCard({ order, role, userId, isDark, busy, onAction }: OrderCardProps) {
  const isDelivery = order.type === 'DELIVERY';
  const showFinance = role !== 'KITCHEN';
  const showAddress = role !== 'KITCHEN';
  const address = isDelivery ? orderAddress(order) : null;
  const change = changeInfo(order);
  const actions = staffActions(order, role, userId);
  const primary = actions.filter((action) => action.kind !== 'cancel');
  const cancel = actions.find((action) => action.kind === 'cancel');
  const waitingMinutes = minutesSince(order.created_at);

  return (
    <View className="bg-white dark:bg-slate-800 border border-gray-100 dark:border-slate-700 rounded-2xl p-4 shadow-sm mb-4">
      {/* Header do Card: número e status na primeira linha; horário, espera e cliente embaixo */}
      <View className="border-b border-gray-50 dark:border-slate-700 pb-3 mb-3">
        <View className="flex-row justify-between items-center">
          <Text className="font-bold text-gray-800 dark:text-white text-lg mr-2">#{order.id}</Text>
          <View className={`flex-shrink-0 px-2 py-1 rounded-lg ${isDelivery ? 'bg-orange-50 dark:bg-orange-900/30' : 'bg-teal-50 dark:bg-teal-900/30'}`}>
            <Text className={`text-[10px] font-bold uppercase ${isDelivery ? 'text-orange-700 dark:text-orange-400' : 'text-teal-700 dark:text-teal-400'}`} numberOfLines={1}>
              {isDelivery ? 'Entrega' : 'Retirada'} • {staffStatusLabel(order.status, order.type)}
            </Text>
          </View>
        </View>
        <View className="flex-row flex-wrap items-center mt-1">
          <View className="bg-gray-100 dark:bg-slate-700 px-2 py-0.5 rounded-full border border-gray-200 dark:border-slate-600 mr-2">
            <Text className="text-xs text-gray-500 dark:text-gray-400 font-mono">{formatTime(order.created_at)}</Text>
          </View>
          {order.status === 'PENDING' || order.status === 'PREPARING' ? (
            <Text className={`text-xs ${waitingMinutes >= 30 ? 'text-red-500 font-bold' : 'text-gray-400'}`}>há {waitingMinutes} min</Text>
          ) : null}
        </View>
        <View className="flex-row items-center mt-1.5">
          <Feather name="user" size={12} color={isDark ? '#94a3b8' : '#64748b'} />
          <Text className="text-xs font-bold text-gray-600 dark:text-gray-300 ml-1 flex-1" numberOfLines={1}>{order.user?.name || 'Cliente'}</Text>
        </View>
      </View>

      {/* Info Financeira */}
      {showFinance && (
        <View className="flex-row justify-between items-center bg-gray-50 dark:bg-slate-700 p-3 rounded-xl mb-3">
          <View className="flex-1 mr-2">
            <Text className="text-xs font-bold text-gray-500 dark:text-gray-300" numberOfLines={2}>
              {paymentDescription(order)}
            </Text>
            {order.payment_status ? (
              <Text className={`text-[11px] font-bold mt-0.5 ${paymentStatusTextClass(order.payment_status)}`}>
                {orderPaymentStatusLabel(order)}
              </Text>
            ) : null}
          </View>
          <Text className="font-bold text-gray-900 dark:text-white text-base">
            {formatPrice(order.total_price)}
          </Text>
        </View>
      )}

      {/* Estorno que falhou: a loja precisa concluir a devolução */}
      {showFinance && order.payment_status === 'REFUND_PENDING' && (
        <View className="flex-row items-start bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/40 p-3 rounded-xl mb-3">
          <Feather name="alert-triangle" size={14} color={isDark ? '#fbbf24' : '#b45309'} style={{ marginTop: 1 }} />
          <Text className="text-xs text-amber-800 dark:text-amber-300 ml-2 flex-1">
            Estorno pendente: o Mercado Pago não confirmou a devolução de {formatPrice(order.total_price)}. Conclua o estorno no painel do Mercado Pago.
          </Text>
        </View>
      )}

      {/* Alerta de Troco / cobrança na entrega (só em pedidos em andamento) */}
      {showFinance && change && !isTerminalStatus(order.status) && (
        <View className="bg-green-100 dark:bg-green-900/20 border border-green-200 dark:border-green-800 p-3 rounded-xl mb-3">
          <View className="flex-row items-center mb-1">
            <Feather name="dollar-sign" size={14} color={isDark ? '#86efac' : '#166534'} />
            <Text className="text-green-800 dark:text-green-300 font-bold text-xs ml-1">TROCO NECESSÁRIO</Text>
          </View>
          <View className="flex-row justify-between">
            <Text className="text-xs text-green-700 dark:text-green-400">Paga com: {formatPrice(change.paidWith)}</Text>
            <Text className="text-xs text-green-700 dark:text-green-400 font-bold">Levar: {formatPrice(change.change)}</Text>
          </View>
        </View>
      )}
      {showFinance && !isPaidOnline(order) && order.payment_status !== 'PAID' && role === 'COURIER' && !isTerminalStatus(order.status) && (
        <Text className="text-xs font-bold text-amber-600 dark:text-amber-400 mb-3">
          Receber {formatPrice(order.total_price)} na entrega.
        </Text>
      )}

      {/* Endereço (retrato gravado no pedido) / Balcão */}
      {showAddress && address ? (
        <View className="bg-gray-50 dark:bg-slate-700 p-3 rounded-xl border border-dashed border-gray-200 dark:border-slate-600 mb-3">
          <View className="flex-row items-start mb-2">
            <Feather name="map-pin" size={14} color="#ea580c" style={{ marginTop: 2 }} />
            <View className="ml-2 flex-1">
              <Text className="font-bold text-gray-800 dark:text-white text-xs">{address.street}, {address.number}</Text>
              <Text className="text-gray-600 dark:text-gray-300 text-xs">
                {address.neighborhood} - {address.city}{address.state ? `/${address.state}` : ''}
              </Text>
              {address.complement ? (
                <Text className="text-blue-600 dark:text-blue-400 text-xs mt-1 font-medium bg-blue-50 dark:bg-blue-900/20 self-start px-1.5 py-0.5 rounded">
                  Ref: {address.complement}
                </Text>
              ) : null}
            </View>
          </View>
          <View className="flex-row">
            <TouchableOpacity onPress={() => openMaps(order)} className="flex-1 flex-row items-center justify-center bg-white dark:bg-slate-600 border border-gray-200 dark:border-slate-500 py-2 rounded-lg mt-1 active:scale-95">
              <Feather name="navigation" size={12} color={isDark ? '#93c5fd' : '#2563eb'} />
              <Text className="text-blue-600 dark:text-blue-300 text-xs font-bold ml-1.5">Abrir no GPS</Text>
            </TouchableOpacity>
            {order.user?.phone ? (
              <TouchableOpacity onPress={() => callPhone(order.user?.phone)} className="flex-row items-center justify-center bg-white dark:bg-slate-600 border border-gray-200 dark:border-slate-500 py-2 px-3 rounded-lg mt-1 ml-2 active:scale-95">
                <Feather name="phone" size={12} color={isDark ? '#86efac' : '#16a34a'} />
                <Text className="text-green-700 dark:text-green-300 text-xs font-bold ml-1.5">Ligar</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      ) : !isDelivery ? (
        <View className="bg-teal-50 dark:bg-teal-900/20 p-2 rounded-lg mb-3 border border-teal-100 dark:border-teal-800 flex-row justify-center items-center">
          <Feather name="package" size={12} color={isDark ? '#5eead4' : '#0f766e'} />
          <Text className="text-xs text-teal-700 dark:text-teal-300 font-bold ml-1.5">Retirada no Balcão</Text>
        </View>
      ) : null}

      {order.driver && role !== 'COURIER' && (
        <View className="flex-row items-center mb-3">
          <Feather name="navigation" size={12} color={isDark ? '#a5b4fc' : '#4f46e5'} />
          <Text className="text-xs text-indigo-600 dark:text-indigo-300 font-bold ml-1.5">Entregador: {order.driver.name}</Text>
        </View>
      )}

      {/* Itens do Pedido */}
      <View className="mb-4">
        {(order.items ?? []).map((item, index) => {
          const addons = itemAddons(item);
          const removed = removedIngredients(item);
          return (
            <View key={item.id ?? index} className="border-b border-gray-50 dark:border-slate-700/50 pb-2 mb-2">
              <View className="flex-row">
                <View className="bg-gray-100 dark:bg-slate-700 px-1.5 py-0.5 rounded mr-2 self-start">
                  <Text className="font-bold text-gray-900 dark:text-white text-xs">{item.quantity}x</Text>
                </View>
                <View className="flex-1">
                  <Text className="text-gray-800 dark:text-white text-sm font-medium">{itemName(item)}</Text>

                  {item.meat_point ? <Text className="text-orange-600 dark:text-orange-400 font-bold text-xs mt-0.5">🔥 Ponto: {item.meat_point}</Text> : null}

                  {removed.length > 0 && (
                    <Text className="text-red-500 dark:text-red-400 font-bold text-xs bg-red-50 dark:bg-red-900/20 self-start px-1 rounded mt-0.5">
                      🚫 Sem: {removed.join(', ')}
                    </Text>
                  )}

                  {addons.length > 0 && (
                    <Text className="text-green-600 dark:text-green-400 font-bold text-xs mt-0.5">
                      ✨ + {addons.map((addon) => `${addon.quantity > 1 ? `${addon.quantity}x ` : ''}${addon.name}`).join(', ')}
                    </Text>
                  )}

                  {item.observation ? (
                    <View className="bg-yellow-50 dark:bg-yellow-900/10 p-1.5 rounded border border-yellow-100 dark:border-yellow-900/30 mt-1">
                      <Text className="text-gray-500 dark:text-gray-400 italic text-[10px]">Obs: {item.observation}</Text>
                    </View>
                  ) : null}
                </View>
              </View>
            </View>
          );
        })}
      </View>

      {/* Ações */}
      <View className="pt-2">
        {primary.map((action, index) => (
          <TouchableOpacity
            key={action.key}
            disabled={busy}
            onPress={() => onAction(order, action)}
            className={`w-full ${action.color} py-3 rounded-xl flex-row justify-center items-center ${index > 0 ? 'mt-2' : ''} ${busy ? 'opacity-60' : ''}`}
          >
            {busy && index === 0 ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Feather name={action.icon} size={16} color="#fff" />
                <Text className="text-white font-bold ml-2">{action.label}</Text>
              </>
            )}
          </TouchableOpacity>
        ))}
        {cancel && (
          <TouchableOpacity disabled={busy} onPress={() => onAction(order, cancel)} className="mt-3 py-2 items-center">
            <Text className="text-red-400 dark:text-red-500 text-xs font-bold underline">{cancel.label}</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
});

// --- QUADRO DE PEDIDOS ---

export default function OrdersView() {
  const { user } = useContext(AuthContext);
  const { activeTheme } = useContext(ThemeContext);
  const { refresh: refreshStore } = useContext(StoreContext);
  // Abrir/fechar a loja pede confirmação (o mesmo fluxo do card do Dashboard)
  const { isOpen, toggling: togglingStore, requestToggle: handleToggleStore } = useStoreToggle();
  const isDark = activeTheme === 'dark';
  const { width: windowWidth } = useWindowDimensions();

  const role = String(user?.role ?? '');
  const userId = user?.id;
  const canManageStore = role === 'ADMIN' || role === 'EMPLOYEE';

  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<number[]>([]);
  const [minuteTick, setMinuteTick] = useState(0);

  // Atribuição de entregador
  const [assignOrder, setAssignOrder] = useState<Order | null>(null);
  const [drivers, setDrivers] = useState<OrderPerson[]>([]);
  const [loadingDrivers, setLoadingDrivers] = useState(false);

  const lastSignature = useRef('');
  // Uma consulta por vez no polling, e só a resposta da consulta mais recente é aplicada:
  // uma resposta atrasada não faz o card "voltar" de coluna.
  const latestRequest = useRef(0);
  const loadInFlight = useRef(false);

  /** GET /orders?scope=active (ativos + encerrados nas últimas 24 h). force = não espera a consulta em andamento. */
  const loadOrders = useCallback(async (force = false) => {
    if (loadInFlight.current && !force) return;
    const requestId = ++latestRequest.current;
    loadInFlight.current = true;
    try {
      const { data } = await api.get<Order[] | null>('/orders', { params: { scope: 'active' } });
      if (requestId !== latestRequest.current) return; // Chegou depois de uma consulta mais nova
      const list = (Array.isArray(data) ? data : []).sort((a, b) => b.id - a.id);
      // Só atualiza a tela quando algo mudou (evita redesenhar tudo a cada 5 s)
      const signature = listSignature(list);
      if (signature !== lastSignature.current) {
        lastSignature.current = signature;
        // Pedidos que não mudaram mantêm o mesmo objeto: os cards deles (memo) não são redesenhados
        setOrders((current) => {
          const previous = new Map(current.map((order) => [order.id, order]));
          return list.map((order) => {
            const old = previous.get(order.id);
            return old && orderSignature(old) === orderSignature(order) ? old : order;
          });
        });
      }
      setLoadError(null);
    } catch (error) {
      if (requestId !== latestRequest.current) return;
      setLoadError(getErrorMessage(error, 'Não foi possível carregar os pedidos.'));
    } finally {
      if (requestId === latestRequest.current) {
        loadInFlight.current = false;
        setLoading(false);
      }
    }
  }, []);

  /** Antes de alterar um pedido: descarta as consultas em andamento (trariam o estado anterior). */
  const discardPendingLoads = useCallback(() => {
    latestRequest.current += 1;
    loadInFlight.current = false;
  }, []);

  /**
   * Alteração aceita pelo servidor: o card muda de coluna na hora, com o pedido devolvido pela API
   * (sem ele, aplica só o que mudou). A consulta seguinte confirma a lista inteira.
   */
  const applyUpdatedOrder = useCallback((target: Order, updated: Order | null | undefined, changes: Partial<Order>) => {
    setOrders((current) => current.map((order) => {
      if (order.id !== target.id) return order;
      return updated && typeof updated === 'object' && updated.id === target.id ? { ...order, ...updated } : { ...order, ...changes };
    }));
    lastSignature.current = ''; // a próxima consulta reaplica a lista do servidor
  }, []);

  useEffect(() => {
    loadOrders();
    const interval = setInterval(() => {
      if (AppState.currentState === 'active') loadOrders();
    }, POLL_INTERVAL_MS);
    // Atualiza o "há X min" dos cards mesmo sem mudança nos pedidos
    const clock = setInterval(() => setMinuteTick((tick) => tick + 1), 60_000);
    return () => {
      clearInterval(interval);
      clearInterval(clock);
    };
  }, [loadOrders]);

  useEffect(() => {
    if (canManageStore) refreshStore();
  }, [canManageStore, refreshStore]);

  const setBusy = (id: number, value: boolean) =>
    setBusyIds((current) => (value ? [...current, id] : current.filter((busyId) => busyId !== id)));

  const changeStatus = useCallback(async (order: Order, status: string) => {
    setBusy(order.id, true);
    discardPendingLoads();
    try {
      // O backend aceita somente {status} neste endpoint e devolve o pedido atualizado
      const { data } = await api.patch<Order | null>(`/orders/${order.id}`, { status }, { timeout: LONG_TIMEOUT_MS });
      applyUpdatedOrder(order, data, { status });
    } catch (error) {
      Alert.alert('Não foi possível atualizar', getErrorMessage(error, 'Falha ao atualizar o status do pedido.'));
    } finally {
      setBusy(order.id, false);
      loadOrders(true); // confirma em segundo plano
    }
  }, [loadOrders, discardPendingLoads, applyUpdatedOrder]);

  const cancelOrder = useCallback((order: Order) => {
    // Pedido pago pelo app: o backend estorna o valor pelo Mercado Pago ao cancelar
    const refundable = isRefundableOnCancel(order);
    Alert.alert(
      'Cancelar Pedido?',
      refundable
        ? `O pedido #${order.id} foi pago pelo app (${paymentMethodLabel(order.payment_method)}). Ao cancelar, o valor de ${formatPrice(order.total_price)} será estornado ao cliente.`
        : `Deseja realmente cancelar o pedido #${order.id}? O cliente verá o pedido como cancelado.`,
      [
        { text: 'Não', style: 'cancel' },
        {
          text: refundable ? 'Cancelar e estornar' : 'Sim, Cancelar', style: 'destructive', onPress: async () => {
            setBusy(order.id, true);
            discardPendingLoads();
            try {
              const { data } = await api.patch<Order | null>(`/orders/${order.id}/cancel`, undefined, { timeout: LONG_TIMEOUT_MS });
              applyUpdatedOrder(order, data, { status: 'CANCELED' });
              if (data?.payment_status === 'REFUND_PENDING') {
                Alert.alert(
                  'Estorno pendente',
                  `O pedido #${order.id} foi cancelado, mas o Mercado Pago não confirmou o estorno. Conclua a devolução no painel do Mercado Pago.`
                );
              }
            } catch (error) {
              Alert.alert('Não foi possível cancelar', getErrorMessage(error, 'Falha ao cancelar o pedido.'));
            } finally {
              setBusy(order.id, false);
              loadOrders(true);
            }
          },
        },
      ]
    );
  }, [loadOrders, discardPendingLoads, applyUpdatedOrder]);

  const openAssign = useCallback(async (order: Order) => {
    setAssignOrder(order);
    setLoadingDrivers(true);
    try {
      const { data } = await api.get<OrderPerson[] | null>('/orders/drivers/list');
      setDrivers(Array.isArray(data) ? data : []);
    } catch (error) {
      setDrivers([]);
      Alert.alert('Entregadores', getErrorMessage(error, 'Não foi possível carregar os entregadores.'));
    } finally {
      setLoadingDrivers(false);
    }
  }, []);

  async function assignDriver(driver: OrderPerson) {
    if (!assignOrder) return;
    const order = assignOrder;
    setAssignOrder(null);
    setBusy(order.id, true);
    discardPendingLoads();
    try {
      const { data } = await api.patch<Order | null>(`/orders/${order.id}/assign`, { driverId: driver.id }, { timeout: LONG_TIMEOUT_MS });
      applyUpdatedOrder(order, data, { status: 'DELIVERING', driver });
    } catch (error) {
      Alert.alert('Não foi possível atribuir', getErrorMessage(error, 'Falha ao atribuir o entregador.'));
    } finally {
      setBusy(order.id, false);
      loadOrders(true);
    }
  }

  const handleAction = useCallback((order: Order, action: OrderAction) => {
    if (action.kind === 'cancel') cancelOrder(order);
    else if (action.kind === 'assign') openAssign(order);
    else if (action.to) changeStatus(order, action.to);
  }, [cancelOrder, openAssign, changeStatus]);

  const columns = columnsFor(role, userId);
  const refundPendingCount = orders.filter((order) => order.payment_status === 'REFUND_PENDING').length;

  if (loading && orders.length === 0) {
    return (
      <View className="flex-1 justify-center items-center">
        <ActivityIndicator size="large" color="#ea580c" />
        <Text className="text-gray-400 mt-4">Carregando pedidos...</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-gray-50 dark:bg-slate-900">
      <View className="px-4 py-4 bg-white dark:bg-slate-800 border-b border-gray-100 dark:border-slate-700 flex-row justify-between items-center">
        <View className="flex-1 mr-2">
          <Text className="text-xl font-bold text-gray-800 dark:text-white">{headerTitle(role)}</Text>
          <Text className="text-xs text-gray-500 dark:text-gray-400">
            Arraste para o lado para ver as colunas • atualiza a cada 5 s
          </Text>
        </View>
        {canManageStore && (
          <TouchableOpacity
            onPress={handleToggleStore}
            disabled={togglingStore}
            className={`flex-row items-center px-3 py-2 rounded-full mr-2 ${isOpen ? 'bg-emerald-100 dark:bg-emerald-900/30' : 'bg-red-100 dark:bg-red-900/30'}`}
          >
            {togglingStore ? (
              <ActivityIndicator size="small" color={isOpen ? '#059669' : '#ef4444'} />
            ) : (
              <Feather name={isOpen ? 'unlock' : 'lock'} size={14} color={isOpen ? '#059669' : '#ef4444'} />
            )}
            <Text className={`text-xs font-bold ml-1.5 ${isOpen ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}`}>
              {isOpen ? 'Loja aberta' : 'Loja fechada'}
            </Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          onPress={() => loadOrders(true)}
          accessibilityRole="button"
          accessibilityLabel="Atualizar pedidos"
          className="p-2 bg-gray-100 dark:bg-slate-700 rounded-full active:scale-95"
        >
          <Feather name="refresh-cw" size={16} color={isDark ? '#cbd5e1' : '#475569'} />
        </TouchableOpacity>
      </View>

      {loadError && (
        <View className="mx-4 mt-3 flex-row items-center bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/40 rounded-xl p-3">
          <Feather name="wifi-off" size={16} color="#ef4444" />
          <Text className="text-red-700 dark:text-red-300 text-xs ml-2 flex-1">{loadError}</Text>
        </View>
      )}

      {canManageStore && refundPendingCount > 0 && (
        <View className="mx-4 mt-3 flex-row items-center bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/40 rounded-xl p-3">
          <Feather name="alert-triangle" size={16} color={isDark ? '#fbbf24' : '#b45309'} />
          <Text className="text-amber-800 dark:text-amber-300 text-xs ml-2 flex-1">
            {refundPendingCount === 1 ? '1 estorno pendente' : `${refundPendingCount} estornos pendentes`} — veja a coluna "Encerrados (24 h)".
          </Text>
        </View>
      )}

      {/* Quadro: cada arraste para no início de uma coluna */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="flex-1 p-4"
        // Sobra no fim para a última coluna também parar alinhada no início
        contentContainerStyle={{ paddingRight: Math.max(32, windowWidth - COLUMN_WIDTH - COLUMN_GAP) }}
        snapToInterval={COLUMN_WIDTH + COLUMN_GAP}
        snapToAlignment="start"
        decelerationRate="fast"
        disableIntervalMomentum
      >
        {columns.map((column) => {
          const list = sortForColumn(orders.filter(column.filter));
          return (
            <View key={column.key} className="w-80 mr-4">
              <View className={`p-3 rounded-xl border mb-3 flex-row justify-between items-center ${column.headerClass}`}>
                <View className="flex-row items-center">
                  <Feather name={column.icon} size={16} color={isDark ? column.iconColor.dark : column.iconColor.light} />
                  <Text className={`font-bold ml-2 ${column.titleClass}`}>{column.title}</Text>
                </View>
                <View className="bg-white dark:bg-slate-800 px-2 py-0.5 rounded-md shadow-sm">
                  <Text className="text-xs font-bold text-gray-800 dark:text-white">{list.length}</Text>
                </View>
              </View>
              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
                {list.map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    role={role}
                    userId={userId}
                    isDark={isDark}
                    busy={busyIds.includes(order.id)}
                    minuteTick={minuteTick}
                    onAction={handleAction}
                  />
                ))}
                {list.length === 0 && <Text className="text-center text-gray-400 italic mt-10">{column.empty}</Text>}
              </ScrollView>
            </View>
          );
        })}
      </ScrollView>

      {/* MODAL: escolher entregador */}
      <Modal visible={!!assignOrder} transparent animationType="fade" onRequestClose={() => setAssignOrder(null)}>
        <View className="flex-1 bg-black/50 justify-center px-6">
          <View className="bg-white dark:bg-slate-800 rounded-3xl p-6 max-h-[80%]">
            <View className="flex-row justify-between items-center mb-4">
              <Text className="text-lg font-bold text-gray-800 dark:text-white">
                Entregador do pedido #{assignOrder?.id}
              </Text>
              <TouchableOpacity onPress={() => setAssignOrder(null)} accessibilityRole="button" accessibilityLabel="Fechar">
                <Feather name="x" size={22} color={isDark ? '#94a3b8' : '#64748b'} />
              </TouchableOpacity>
            </View>

            {loadingDrivers ? (
              <ActivityIndicator size="large" color="#ea580c" className="my-6" />
            ) : drivers.length === 0 ? (
              <Text className="text-gray-500 dark:text-gray-400 text-center my-6">
                Nenhum entregador ativo. {role === 'ADMIN' ? 'Cadastre um usuário com o perfil Entregador na aba Usuários.' : 'Peça ao administrador para cadastrar um entregador.'}
              </Text>
            ) : (
              <ScrollView>
                {drivers.map((driver) => {
                  const current = assignOrder?.driver?.id === driver.id;
                  return (
                    <TouchableOpacity
                      key={driver.id}
                      disabled={current}
                      onPress={() => assignDriver(driver)}
                      className={`flex-row items-center p-3 rounded-xl mb-2 border ${current ? 'border-indigo-300 bg-indigo-50 dark:bg-indigo-900/20 dark:border-indigo-800' : 'border-gray-100 dark:border-slate-700'}`}
                    >
                      <View className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 items-center justify-center mr-3">
                        <Feather name="truck" size={16} color="#2563eb" />
                      </View>
                      <View className="flex-1">
                        <Text className="font-bold text-gray-800 dark:text-white">{driver.name}</Text>
                        {driver.phone ? <Text className="text-xs text-gray-500 dark:text-gray-400">{driver.phone}</Text> : null}
                      </View>
                      {current ? <Text className="text-xs font-bold text-indigo-600 dark:text-indigo-300">Atual</Text> : <Feather name="chevron-right" size={18} color="#94a3b8" />}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}
