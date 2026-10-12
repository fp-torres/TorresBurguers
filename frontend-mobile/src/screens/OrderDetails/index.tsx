import React, { useState, useEffect, useContext, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator, Alert, RefreshControl } from 'react-native';
import { RouteProp, useRoute, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';

import { AppStackParamList } from '../../routes/app.routes';
import { ThemeContext } from '../../contexts/ThemeContext';
import api, { LONG_TIMEOUT_MS } from '../../services/api';
import RemoteImage from '../../components/RemoteImage';
import {
  Order, addressLines, changeInfo, isRefundableOnCancel, itemAddons, itemName, orderAddress,
  orderPaymentStatusLabel, orderStatusBadge, paymentDescription, paymentMethodLabel,
  paymentStatusTextClass, removedIngredients,
} from '../../utils/orders';
import { formatDateTime, formatPrice } from '../../utils/format';
import { getErrorMessage, getErrorStatus } from '../../utils/errors';

/** Mensagem depois do cancelamento, conforme o estorno do pagamento feito pelo app. */
function cancelResultMessage(refundable: boolean, paymentStatus?: string | null): string {
  if (paymentStatus === 'REFUNDED') return 'Seu pedido foi cancelado e o valor pago foi estornado.';
  if (paymentStatus === 'REFUND_PENDING') {
    return 'Seu pedido foi cancelado. O estorno ainda está sendo processado e a loja vai concluir a devolução do valor.';
  }
  if (refundable) return 'Seu pedido foi cancelado e o estorno do valor pago foi solicitado.';
  return 'Seu pedido foi cancelado com sucesso.';
}

export default function OrderDetails() {
  const route = useRoute<RouteProp<AppStackParamList, 'OrderDetails'>>();
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const { activeTheme } = useContext(ThemeContext);
  const insets = useSafeAreaInsets();
  const { order_id } = route.params;

  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);

  const fetchOrderDetails = useCallback(async () => {
    try {
      const response = await api.get<Order | null>(`/orders/${order_id}`);
      if (!response.data) {
        setErrorMessage('Pedido não encontrado.');
      } else {
        setOrder(response.data);
        setErrorMessage(null);
      }
    } catch (error) {
      const status = getErrorStatus(error);
      setErrorMessage(status === 404 ? 'Pedido não encontrado.'
        : status === 403 ? 'Este pedido pertence a outra conta.'
        : getErrorMessage(error, 'Não foi possível carregar os detalhes do pedido.'));
    } finally {
      setLoading(false);
    }
  }, [order_id]);

  useEffect(() => {
    fetchOrderDetails();
  }, [fetchOrderDetails]);

  async function handleRefresh() {
    setRefreshing(true);
    await fetchOrderDetails();
    setRefreshing(false);
  }

  function handleGoBack() {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.popTo('MyOrders');
  }

  async function cancelOrder(refundable: boolean) {
    setCanceling(true);
    try {
      // Pedido pago pelo app: o backend estorna pelo Mercado Pago antes de responder
      const { data } = await api.patch<Order | null>(`/orders/${order_id}/cancel`, undefined, { timeout: LONG_TIMEOUT_MS });
      Alert.alert('Pedido cancelado', cancelResultMessage(refundable, data?.payment_status));
    } catch (error) {
      Alert.alert('Ops', getErrorMessage(error, 'Erro ao cancelar pedido.'));
    } finally {
      setCanceling(false);
      fetchOrderDetails(); // Mostra o status atual (CANCELED e a situação do estorno)
    }
  }

  function handleCancelOrder() {
    if (!order) return;
    // Pedido já pago pelo app: avisa do estorno antes de confirmar
    const refundable = isRefundableOnCancel(order);
    const message = refundable
      ? `Este pedido já foi pago pelo app (${paymentMethodLabel(order.payment_method)}). Ao cancelar, o valor de ${formatPrice(order.total_price)} será estornado para a mesma forma de pagamento.\n\nDeseja cancelar o pedido?`
      : 'Tem certeza que deseja cancelar este pedido?';
    Alert.alert('Cancelar Pedido', message, [
      { text: 'Não', style: 'cancel' },
      { text: refundable ? 'Cancelar e estornar' : 'Sim, cancelar', style: 'destructive', onPress: () => cancelOrder(refundable) },
    ]);
  }

  if (loading) {
    return (
      <View className="flex-1 bg-gray-50 dark:bg-slate-900 justify-center items-center">
        <ActivityIndicator size="large" color="#f97316" />
      </View>
    );
  }

  if (!order) {
    return (
      <View className="flex-1 bg-gray-50 dark:bg-slate-900 justify-center items-center px-8">
        <Feather name="alert-circle" size={48} color={activeTheme === 'dark' ? '#475569' : '#94a3b8'} />
        <Text className="text-slate-600 dark:text-slate-300 text-center text-base mt-4 mb-6">
          {errorMessage ?? 'Pedido não encontrado.'}
        </Text>
        <TouchableOpacity className="bg-orange-600 px-6 py-3 rounded-xl" onPress={handleGoBack}>
          <Text className="text-white font-bold">Voltar</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const badge = orderStatusBadge(order.status, order.type);
  const deliveryFee = Number(order.delivery_fee) || 0;
  const total = Number(order.total_price) || 0;
  const change = changeInfo(order);
  const iconColor = activeTheme === 'dark' ? '#9ca3af' : '#64748b';
  const address = order.type === 'DELIVERY' ? orderAddress(order) : null;
  const [addressStreet, addressPlace] = address ? addressLines(address) : ['', ''];
  const refundable = isRefundableOnCancel(order);

  return (
    <View className="flex-1 bg-gray-50 dark:bg-slate-900">
      <View className="px-6 pb-4 bg-white dark:bg-slate-800 shadow-sm z-10 flex-row items-center justify-between" style={{ paddingTop: insets.top + 16 }}>
        <View className="flex-row items-center">
          <TouchableOpacity
            onPress={handleGoBack}
            accessibilityRole="button"
            accessibilityLabel="Voltar"
            className="w-10 h-10 bg-gray-100 dark:bg-slate-900 rounded-full justify-center items-center"
          >
            <Feather name="arrow-left" size={24} color="#f97316" />
          </TouchableOpacity>
          <Text className="text-xl font-bold text-slate-900 dark:text-white ml-4">Pedido #{order.id}</Text>
        </View>

        <View className={`px-3 py-1.5 rounded-full ${badge.bg}`}>
          <Text className={`font-bold text-xs ${badge.text}`}>{badge.label}</Text>
        </View>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 24, paddingBottom: insets.bottom + 100 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#f97316" colors={['#f97316']} />}
      >

        {/* INFORMAÇÕES GERAIS */}
        <View className="bg-white dark:bg-slate-800 p-5 rounded-2xl mb-6 shadow-sm dark:shadow-none border border-gray-100 dark:border-slate-700">
          <Text className="text-slate-500 dark:text-slate-400 text-sm mb-4">Realizado em {formatDateTime(order.created_at)}</Text>

          <View className="flex-row items-center mb-3">
            <Feather name={order.type === 'DELIVERY' ? 'truck' : 'shopping-bag'} size={20} color={iconColor} />
            <Text className="text-slate-900 dark:text-white font-bold ml-3 text-base">
              {order.type === 'DELIVERY' ? 'Entrega' : 'Retirada na Loja'}
            </Text>
          </View>

          {/* Endereço gravado no pedido (não muda se o cliente editar/apagar o endereço depois) */}
          {address && (
            <View className="ml-8 mb-4">
              {address.nickname ? (
                <Text className="text-slate-500 dark:text-slate-400 text-xs font-bold uppercase mb-0.5">{address.nickname}</Text>
              ) : null}
              <Text className="text-slate-600 dark:text-slate-300">{addressStreet}</Text>
              <Text className="text-slate-500 dark:text-slate-400 text-sm">{addressPlace}</Text>
            </View>
          )}

          {order.estimated_delivery_time && order.status !== 'DONE' && order.status !== 'CANCELED' && (
            <View className="flex-row items-center mb-3">
              <Feather name="clock" size={20} color={iconColor} />
              <Text className="text-slate-600 dark:text-slate-300 ml-3">Previsão: {order.estimated_delivery_time}</Text>
            </View>
          )}

          {order.driver && order.status === 'DELIVERING' && (
            <View className="flex-row items-center mb-3">
              <Feather name="navigation" size={20} color={iconColor} />
              <Text className="text-slate-600 dark:text-slate-300 ml-3">Entregador: {order.driver.name}</Text>
            </View>
          )}

          <View className="flex-row items-center">
            <Feather name="credit-card" size={20} color={iconColor} />
            <View className="ml-3 flex-1">
              <Text className="text-slate-900 dark:text-white font-bold text-base">{paymentDescription(order)}</Text>
              {order.payment_status ? (
                <Text className={`text-sm font-medium ${paymentStatusTextClass(order.payment_status)}`}>
                  {orderPaymentStatusLabel(order)}
                </Text>
              ) : null}
            </View>
          </View>

          {change && (
            <Text className="text-slate-500 dark:text-slate-400 ml-8 mt-1 text-sm">
              Troco para {formatPrice(change.paidWith)} (troco de {formatPrice(change.change)})
            </Text>
          )}

          {order.payment_status === 'REFUNDED' && (
            <Text className="text-slate-500 dark:text-slate-400 ml-8 mt-2 text-sm">
              O valor pago foi devolvido para a forma de pagamento usada. No cartão, o crédito pode levar alguns dias para aparecer na fatura.
            </Text>
          )}

          {order.payment_status === 'REFUND_PENDING' && (
            <View className="flex-row items-start bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/40 rounded-xl p-3 mt-3">
              <Feather name="alert-triangle" size={16} color="#d97706" style={{ marginTop: 1 }} />
              <Text className="text-amber-800 dark:text-amber-300 text-sm ml-2 flex-1">
                O estorno ainda não foi concluído. Ele aparece para a equipe da loja, que vai finalizar a devolução do valor pago.
              </Text>
            </View>
          )}
        </View>

        {/* LISTA DE ITENS EXATOS DO PEDIDO */}
        <Text className="text-lg font-bold text-slate-900 dark:text-white mb-4">Itens do Pedido</Text>

        {(order.items ?? []).map((item, index) => {
          const addons = itemAddons(item);
          const removed = removedIngredients(item);
          return (
            <View key={item.id ?? index} className="bg-white dark:bg-slate-800 p-4 rounded-2xl mb-4 flex-row shadow-sm dark:shadow-none border border-gray-100 dark:border-slate-700">
              <View className="w-20 h-20 rounded-xl overflow-hidden bg-gray-200 dark:bg-slate-700">
                <RemoteImage path={item.product?.image} className="w-full h-full" />
              </View>
              <View className="flex-1 ml-4">
                <Text className="text-slate-900 dark:text-white font-bold text-base">
                  {item.quantity}x {itemName(item)}
                </Text>
                {item.unit_price !== undefined && item.unit_price !== null && (
                  <Text className="text-slate-500 dark:text-slate-400 text-sm">{formatPrice(item.unit_price)} cada</Text>
                )}

                {item.meat_point ? (
                  <Text className="text-orange-500 text-sm mt-1">Ponto: {item.meat_point}</Text>
                ) : null}

                {removed.length > 0 && (
                  <Text className="text-red-500 dark:text-red-400 text-sm mt-1">Sem: {removed.join(', ')}</Text>
                )}

                {addons.length > 0 && (
                  <View className="mt-1">
                    <Text className="text-slate-600 dark:text-slate-400 text-sm font-medium">Adicionais:</Text>
                    {addons.map((addon) => (
                      <Text key={addon.name} className="text-slate-500 dark:text-slate-400 text-sm">
                        • {addon.quantity > 1 ? `${addon.quantity}x ` : ''}{addon.name}
                      </Text>
                    ))}
                  </View>
                )}

                {item.observation ? (
                  <Text className="text-slate-500 dark:text-slate-400 text-sm italic mt-2">Obs: {item.observation}</Text>
                ) : null}
              </View>
            </View>
          );
        })}

        {/* RESUMO DE VALORES */}
        <View className="mt-4 bg-white dark:bg-slate-800 p-5 rounded-2xl shadow-sm dark:shadow-none border border-gray-100 dark:border-slate-700">
          <View className="flex-row justify-between mb-2">
            <Text className="text-slate-500 dark:text-slate-400">Subtotal</Text>
            <Text className="text-slate-900 dark:text-white">{formatPrice(total - deliveryFee)}</Text>
          </View>
          <View className="flex-row justify-between mb-4">
            <Text className="text-slate-500 dark:text-slate-400">Taxa de Entrega</Text>
            <Text className="text-slate-900 dark:text-white">{deliveryFee > 0 ? formatPrice(deliveryFee) : 'Grátis'}</Text>
          </View>
          <View className="flex-row justify-between pt-4 border-t border-gray-100 dark:border-slate-700">
            <Text className="text-slate-900 dark:text-white font-bold text-lg">Total</Text>
            <Text className="text-orange-600 dark:text-orange-500 font-bold text-lg">{formatPrice(total)}</Text>
          </View>
        </View>

        {/* BOTÃO DE CANCELAR (Apenas se o status ainda for PENDENTE) */}
        {order.status === 'PENDING' && (
          <>
            <TouchableOpacity
              className="mt-8 bg-red-50 border border-red-200 dark:bg-red-900/10 dark:border-red-900/30 rounded-xl py-4 flex-row justify-center items-center active:scale-95"
              onPress={handleCancelOrder}
              disabled={canceling}
            >
              {canceling ? (
                <ActivityIndicator size="small" color="#ef4444" />
              ) : (
                <Text className="text-red-600 dark:text-red-400 font-bold text-lg">Cancelar Pedido</Text>
              )}
            </TouchableOpacity>
            {refundable && (
              <Text className="text-slate-500 dark:text-slate-400 text-xs text-center mt-2">
                Pedido pago pelo app: ao cancelar, o valor será estornado.
              </Text>
            )}
          </>
        )}

      </ScrollView>
    </View>
  );
}
