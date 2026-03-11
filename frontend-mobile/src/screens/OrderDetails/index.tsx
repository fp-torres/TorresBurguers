import React, { useState, useEffect, useContext } from 'react';
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator, Alert, Image } from 'react-native';
import { useRoute, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Feather from '@expo/vector-icons/Feather';

import { AppStackParamList } from '../../routes/app.routes';
import { ThemeContext } from '../../contexts/ThemeContext';
import api from '../../services/api';

type OrderDetailsRouteProp = {
  key: string;
  name: "OrderDetails";
  params: { order_id: number };
};

export default function OrderDetails() {
  const route = useRoute<OrderDetailsRouteProp>();
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const { activeTheme } = useContext(ThemeContext);
  const { order_id } = route.params;

  const [order, setOrder] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [canceling, setCanceling] = useState(false);

  useEffect(() => {
    fetchOrderDetails();
  }, [order_id]);

  async function fetchOrderDetails() {
    try {
      const response = await api.get(`/orders/${order_id}`);
      setOrder(response.data);
    } catch (error) {
      console.error('Erro ao buscar detalhes do pedido:', error);
      Alert.alert('Erro', 'Não foi possível carregar os detalhes do pedido.');
      navigation.goBack();
    } finally {
      setLoading(false);
    }
  }

  async function handleCancelOrder() {
    Alert.alert('Cancelar Pedido', 'Tem certeza que deseja cancelar este pedido?', [
      { text: 'Não', style: 'cancel' },
      { 
        text: 'Sim, cancelar', 
        style: 'destructive',
        onPress: async () => {
          setCanceling(true);
          try {
            await api.patch(`/orders/${order_id}/cancel`);
            Alert.alert('Cancelado', 'Seu pedido foi cancelado com sucesso.');
            fetchOrderDetails(); // Atualiza a tela para mostrar o status CANCELED
          } catch (error: any) {
            const msg = error.response?.data?.message || 'Erro ao cancelar pedido.';
            Alert.alert('Ops', msg);
          } finally {
            setCanceling(false);
          }
        }
      }
    ]);
  }

  const formatPrice = (price: string | number) => {
    return Number(price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'PENDING': return { label: 'Aguardando', bg: 'bg-orange-100 dark:bg-orange-900/30', text: 'text-orange-600 dark:text-orange-400' };
      case 'PREPARING': return { label: 'Preparando', bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-600 dark:text-blue-400' };
      case 'READY_FOR_PICKUP': return { label: 'Pronto p/ Retirar', bg: 'bg-purple-100 dark:bg-purple-900/30', text: 'text-purple-600 dark:text-purple-400' };
      case 'DELIVERING': return { label: 'Saiu p/ Entrega', bg: 'bg-indigo-100 dark:bg-indigo-900/30', text: 'text-indigo-600 dark:text-indigo-400' };
      case 'DONE': return { label: 'Concluído', bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-600 dark:text-green-400' };
      case 'CANCELED': return { label: 'Cancelado', bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-600 dark:text-red-400' };
      default: return { label: status, bg: 'bg-gray-100 dark:bg-slate-700', text: 'text-gray-600 dark:text-slate-300' };
    }
  };

  const getImageUrl = (imagePath: string | null | undefined) => {
    if (!imagePath) return 'https://via.placeholder.com/100?text=Sem+Foto';
    let cleanPath = imagePath.replace(/^\//, ''); 
    if (!cleanPath.startsWith('uploads/')) cleanPath = `uploads/${cleanPath}`;
    const base = api.defaults.baseURL?.replace(/\/$/, '') || '';
    return `${base}/${cleanPath}`;
  };

  if (loading || !order) {
    return (
      <View className="flex-1 bg-gray-50 dark:bg-slate-900 justify-center items-center">
        <ActivityIndicator size="large" color="#f97316" />
      </View>
    );
  }

  const badge = getStatusBadge(order.status);

  return (
    <View className="flex-1 bg-gray-50 dark:bg-slate-900">
      <View className="pt-16 px-6 pb-4 bg-white dark:bg-slate-800 shadow-sm z-10 flex-row items-center justify-between">
        <View className="flex-row items-center">
          <TouchableOpacity 
            onPress={() => navigation.goBack()}
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

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: 24, paddingBottom: 100 }}>
        
        {/* INFORMAÇÕES GERAIS */}
        <View className="bg-white dark:bg-slate-800 p-5 rounded-2xl mb-6 shadow-sm dark:shadow-none border border-gray-100 dark:border-slate-700">
          <Text className="text-slate-500 dark:text-slate-400 text-sm mb-4">Realizado em {formatDate(order.created_at)}</Text>
          
          <View className="flex-row items-center mb-3">
            <Feather name={order.type === 'DELIVERY' ? 'truck' : 'shopping-bag'} size={20} color={activeTheme === 'dark' ? '#9ca3af' : '#64748b'} />
            <Text className="text-slate-900 dark:text-white font-bold ml-3 text-base">
              {order.type === 'DELIVERY' ? 'Entrega' : 'Retirada na Loja'}
            </Text>
          </View>

          {order.type === 'DELIVERY' && order.address && (
            <View className="ml-8 mb-4">
              <Text className="text-slate-600 dark:text-slate-300">
                {order.address.street}, {order.address.number} {order.address.complement ? `- ${order.address.complement}` : ''}
              </Text>
              <Text className="text-slate-500 dark:text-slate-400 text-sm">
                {order.address.neighborhood}, {order.address.city} - {order.address.state}
              </Text>
            </View>
          )}

          <View className="flex-row items-center">
            <Feather name="credit-card" size={20} color={activeTheme === 'dark' ? '#9ca3af' : '#64748b'} />
            <Text className="text-slate-900 dark:text-white font-bold ml-3 text-base">
              Pagamento: {order.payment_method?.replace('_', ' ')}
            </Text>
          </View>
          
          {order.payment_method === 'DINHEIRO' && order.change_for && (
            <Text className="text-slate-500 dark:text-slate-400 ml-8 mt-1 text-sm">Troco para: R$ {order.change_for}</Text>
          )}
        </View>

        {/* LISTA DE ITENS EXATOS DO PEDIDO */}
        <Text className="text-lg font-bold text-slate-900 dark:text-white mb-4">Itens do Pedido</Text>
        
        {order.items?.map((item: any, index: number) => (
          <View key={index} className="bg-white dark:bg-slate-800 p-4 rounded-2xl mb-4 flex-row shadow-sm dark:shadow-none border border-gray-100 dark:border-slate-700">
            <Image 
              source={{ uri: getImageUrl(item.product?.image) }}
              className="w-20 h-20 rounded-xl bg-gray-200 dark:bg-slate-700"
            />
            <View className="flex-1 ml-4">
              <Text className="text-slate-900 dark:text-white font-bold text-base">
                {item.quantity}x {item.product?.name}
              </Text>

              {/* Detalhes específicos baseados no seu DTO */}
              {item.meat_point && (
                <Text className="text-orange-500 text-sm mt-1">Ponto: {item.meat_point}</Text>
              )}
              
              {item.removed_ingredients && item.removed_ingredients.length > 0 && (
                <Text className="text-red-500 dark:text-red-400 text-sm mt-1">Sem: {item.removed_ingredients.join(', ')}</Text>
              )}

              {item.addons && item.addons.length > 0 && (
                <View className="mt-1">
                  <Text className="text-slate-600 dark:text-slate-400 text-sm font-medium">Adicionais:</Text>
                  {item.addons.map((addon: any, idx: number) => (
                    <Text key={idx} className="text-slate-500 dark:text-slate-400 text-sm">• {addon.name}</Text>
                  ))}
                </View>
              )}

              {item.observation && (
                <Text className="text-slate-500 dark:text-slate-400 text-sm italic mt-2">Obs: {item.observation}</Text>
              )}
            </View>
          </View>
        ))}

        {/* RESUMO DE VALORES */}
        <View className="mt-4 bg-white dark:bg-slate-800 p-5 rounded-2xl shadow-sm dark:shadow-none border border-gray-100 dark:border-slate-700">
          <View className="flex-row justify-between mb-2">
            <Text className="text-slate-500 dark:text-slate-400">Subtotal</Text>
            <Text className="text-slate-900 dark:text-white">{formatPrice(order.total_price - (order.delivery_fee || 0))}</Text>
          </View>
          <View className="flex-row justify-between mb-4">
            <Text className="text-slate-500 dark:text-slate-400">Taxa de Entrega</Text>
            <Text className="text-slate-900 dark:text-white">{formatPrice(order.delivery_fee || 0)}</Text>
          </View>
          <View className="flex-row justify-between pt-4 border-t border-gray-100 dark:border-slate-700">
            <Text className="text-slate-900 dark:text-white font-bold text-lg">Total</Text>
            <Text className="text-orange-600 dark:text-orange-500 font-bold text-lg">{formatPrice(order.total_price)}</Text>
          </View>
        </View>

        {/* BOTÃO DE CANCELAR (Apenas se o status ainda for PENDENTE) */}
        {order.status === 'PENDING' && (
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
        )}

      </ScrollView>
    </View>
  );
}