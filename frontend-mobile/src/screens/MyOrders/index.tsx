import React, { useState, useCallback, useContext } from 'react';
import { View, Text, TouchableOpacity, FlatList, ActivityIndicator, Alert } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Feather from '@expo/vector-icons/Feather';

import { AppStackParamList } from '../../routes/app.routes';
import { ThemeContext } from '../../contexts/ThemeContext';
import api from '../../services/api';

// Mapeamento baseado no backend
interface Order {
  id: number;
  status: string;
  type: string;
  total_price: string;
  created_at: string;
  items: any[];
}

export default function MyOrders() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const { activeTheme } = useContext(ThemeContext);

  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  // useFocusEffect faz a tela recarregar a API toda vez que for aberta
  useFocusEffect(
    useCallback(() => {
      async function fetchMyOrders() {
        setLoading(true);
        try {
          const response = await api.get('/orders/my-orders');
          setOrders(response.data);
        } catch (error) {
          console.error('Erro ao buscar pedidos:', error);
          Alert.alert('Ops!', 'Não foi possível carregar seus pedidos.');
        } finally {
          setLoading(false);
        }
      }
      fetchMyOrders();
    }, [])
  );

  const formatPrice = (price: string | number) => {
    return Number(price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'PENDING':
        return { label: 'Aguardando', bg: 'bg-orange-100 dark:bg-orange-900/30', text: 'text-orange-600 dark:text-orange-400' };
      case 'PREPARING':
        return { label: 'Preparando', bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-600 dark:text-blue-400' };
      case 'READY_FOR_PICKUP':
        return { label: 'Pronto p/ Retirar', bg: 'bg-purple-100 dark:bg-purple-900/30', text: 'text-purple-600 dark:text-purple-400' };
      case 'DELIVERING':
        return { label: 'Saiu p/ Entrega', bg: 'bg-indigo-100 dark:bg-indigo-900/30', text: 'text-indigo-600 dark:text-indigo-400' };
      case 'DONE':
        return { label: 'Concluído', bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-600 dark:text-green-400' };
      case 'CANCELED':
        return { label: 'Cancelado', bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-600 dark:text-red-400' };
      default:
        return { label: status, bg: 'bg-gray-100 dark:bg-slate-700', text: 'text-gray-600 dark:text-slate-300' };
    }
  };

  const renderOrder = ({ item }: { item: Order }) => {
    const badge = getStatusBadge(item.status);
    const totalItems = item.items ? item.items.reduce((acc, curr) => acc + curr.quantity, 0) : 0;

    return (
      <View className="bg-white dark:bg-slate-800 p-5 rounded-2xl mb-4 border border-gray-100 dark:border-transparent shadow-sm dark:shadow-md">
        <View className="flex-row justify-between items-start mb-3">
          <View>
            <Text className="text-slate-900 dark:text-white font-bold text-lg mb-1">
              Pedido #{item.id}
            </Text>
            <Text className="text-slate-500 dark:text-slate-400 text-sm">
              {formatDate(item.created_at)}
            </Text>
          </View>
          
          <View className={`px-3 py-1.5 rounded-full ${badge.bg}`}>
            <Text className={`font-bold text-xs ${badge.text}`}>{badge.label}</Text>
          </View>
        </View>

        <View className="flex-row items-center mb-4">
          <Feather name={item.type === 'DELIVERY' ? 'truck' : 'shopping-bag'} size={16} color={activeTheme === 'dark' ? '#9ca3af' : '#64748b'} />
          <Text className="text-slate-600 dark:text-slate-300 ml-2 text-sm">
            {item.type === 'DELIVERY' ? 'Entrega' : 'Retirada'} • {totalItems} {totalItems === 1 ? 'item' : 'itens'}
          </Text>
        </View>

        <View className="flex-row justify-between items-center pt-3 border-t border-gray-100 dark:border-slate-700">
          <Text className="text-slate-900 dark:text-white font-bold text-lg">
            {formatPrice(item.total_price)}
          </Text>
          
          {/* BOTÃO CONECTADO NA NAVEGAÇÃO AGORA */}
          <TouchableOpacity 
            className="flex-row items-center px-4 py-2 bg-orange-50 dark:bg-orange-600/10 rounded-lg"
            onPress={() => navigation.navigate('OrderDetails', { order_id: item.id })}
          >
            <Text className="text-orange-600 dark:text-orange-500 font-bold mr-2">Ver detalhes</Text>
            <Feather name="chevron-right" size={16} color="#f97316" />
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <View className="flex-1 bg-gray-50 dark:bg-slate-900 pt-16">
      <View className="flex-row items-center px-6 mb-6">
        <TouchableOpacity 
          onPress={() => navigation.goBack()}
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
          contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 40 }}
          ListEmptyComponent={
            <View className="items-center justify-center mt-20">
              <Feather name="list" size={64} className="text-gray-300 dark:text-slate-700 mb-4" />
              <Text className="text-slate-500 dark:text-slate-400 text-lg text-center leading-7">
                Você ainda não fez nenhum pedido.{"\n"}Que tal experimentar nosso cardápio hoje?
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}