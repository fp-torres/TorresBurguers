import React, { useState, useCallback, useContext } from 'react';
import { View, Text, TouchableOpacity, FlatList, ActivityIndicator, RefreshControl } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';

import { AppStackParamList } from '../../routes/app.routes';
import { ThemeContext } from '../../contexts/ThemeContext';
import api from '../../services/api';
import {
  Order, addressLines, itemCountLabel, itemsSummary, orderAddress, orderPaymentStatusLabel, orderStatusBadge,
  paymentMethodLabel, paymentStatusTextClass,
} from '../../utils/orders';
import { formatDateTime, formatPrice } from '../../utils/format';
import { getErrorMessage } from '../../utils/errors';

export default function MyOrders() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const { activeTheme } = useContext(ThemeContext);
  const insets = useSafeAreaInsets();

  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fetchMyOrders = useCallback(async () => {
    try {
      const response = await api.get<Order[] | null>('/orders/my-orders');
      const list = Array.isArray(response.data) ? response.data : [];
      // Mais recentes primeiro
      setOrders([...list].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(getErrorMessage(error, 'Não foi possível carregar seus pedidos.'));
    } finally {
      setLoading(false);
    }
  }, []);

  // useFocusEffect faz a tela recarregar a API toda vez que for aberta
  useFocusEffect(
    useCallback(() => {
      fetchMyOrders();
    }, [fetchMyOrders])
  );

  async function handleRefresh() {
    setRefreshing(true);
    await fetchMyOrders();
    setRefreshing(false);
  }

  function handleGoBack() {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.popTo('Home');
  }

  const renderOrder = ({ item }: { item: Order }) => {
    const badge = orderStatusBadge(item.status, item.type);
    const summary = itemsSummary(item);
    const address = item.type === 'DELIVERY' ? orderAddress(item) : null;
    const paymentStatus = item.payment_status ? orderPaymentStatusLabel(item) : '';

    return (
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={() => navigation.navigate('OrderDetails', { order_id: item.id })}
        className="bg-white dark:bg-slate-800 p-5 rounded-2xl mb-4 border border-gray-100 dark:border-transparent shadow-sm dark:shadow-md"
      >
        <View className="flex-row justify-between items-start mb-3">
          <View className="flex-1 mr-2">
            <Text className="text-slate-900 dark:text-white font-bold text-lg mb-1">
              Pedido #{item.id}
            </Text>
            <Text className="text-slate-500 dark:text-slate-400 text-sm">
              {formatDateTime(item.created_at)}
            </Text>
          </View>

          <View className={`px-3 py-1.5 rounded-full ${badge.bg}`}>
            <Text className={`font-bold text-xs ${badge.text}`}>{badge.label}</Text>
          </View>
        </View>

        <View className="flex-row items-center mb-2">
          <Feather name={item.type === 'DELIVERY' ? 'truck' : 'shopping-bag'} size={16} color={activeTheme === 'dark' ? '#9ca3af' : '#64748b'} />
          <Text className="text-slate-600 dark:text-slate-300 ml-2 text-sm flex-1" numberOfLines={1}>
            {item.type === 'DELIVERY' ? 'Entrega' : 'Retirada'} • {itemCountLabel(item)} • {paymentMethodLabel(item.payment_method)}
          </Text>
        </View>

        {summary ? (
          <Text className="text-slate-500 dark:text-slate-400 text-sm mb-1" numberOfLines={2}>{summary}</Text>
        ) : null}

        {address ? (
          <View className="flex-row items-center mb-1">
            <Feather name="map-pin" size={12} color={activeTheme === 'dark' ? '#9ca3af' : '#64748b'} />
            <Text className="text-slate-500 dark:text-slate-400 text-xs ml-1.5 flex-1" numberOfLines={1}>
              {addressLines(address).join(' • ')}
            </Text>
          </View>
        ) : null}

        {paymentStatus ? (
          <Text className={`text-xs font-bold mb-3 ${paymentStatusTextClass(item.payment_status)}`}>
            Pagamento: {paymentStatus}
          </Text>
        ) : <View className="mb-3" />}

        <View className="flex-row justify-between items-center pt-3 border-t border-gray-100 dark:border-slate-700">
          <Text className="text-slate-900 dark:text-white font-bold text-lg">
            {formatPrice(item.total_price)}
          </Text>

          <View className="flex-row items-center px-4 py-2 bg-orange-50 dark:bg-orange-600/10 rounded-lg">
            <Text className="text-orange-600 dark:text-orange-500 font-bold mr-2">Ver detalhes</Text>
            <Feather name="chevron-right" size={16} color="#f97316" />
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View className="flex-1 bg-gray-50 dark:bg-slate-900" style={{ paddingTop: insets.top + 16 }}>
      <View className="flex-row items-center px-6 mb-6">
        <TouchableOpacity
          onPress={handleGoBack}
          accessibilityRole="button"
          accessibilityLabel="Voltar"
          className="w-10 h-10 bg-white dark:bg-slate-800 rounded-full justify-center items-center shadow-sm dark:shadow-none border border-gray-200 dark:border-transparent"
        >
          <Feather name="arrow-left" size={24} color="#f97316" />
        </TouchableOpacity>
        <Text className="text-2xl font-bold text-slate-900 dark:text-white ml-4">Meus Pedidos</Text>
      </View>

      {loading ? (
        <View className="flex-1 justify-center items-center">
          <ActivityIndicator size="large" color="#f97316" />
        </View>
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderOrder}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: insets.bottom + 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#f97316" colors={['#f97316']} />}
          ListEmptyComponent={
            <View className="items-center justify-center mt-20">
              <Feather name={errorMessage ? 'wifi-off' : 'list'} size={64} color={activeTheme === 'dark' ? '#334155' : '#cbd5e1'} />
              <Text className="text-slate-500 dark:text-slate-400 text-lg text-center leading-7 mt-4">
                {errorMessage ?? 'Você ainda não fez nenhum pedido.\nQue tal experimentar nosso cardápio hoje?'}
              </Text>
              {!errorMessage && (
                <TouchableOpacity className="mt-6 bg-orange-600 px-6 py-3 rounded-xl" onPress={() => navigation.popTo('Home')}>
                  <Text className="text-white font-bold">Ver cardápio</Text>
                </TouchableOpacity>
              )}
            </View>
          }
        />
      )}
    </View>
  );
}
