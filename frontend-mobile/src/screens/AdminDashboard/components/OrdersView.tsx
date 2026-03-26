import React, { useState, useEffect, useContext } from 'react';
import { 
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator, 
  Alert, Linking 
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import api from '../../../services/api';
import { AuthContext } from '../../../contexts/AuthContext';
import { ThemeContext } from '../../../contexts/ThemeContext';

interface OrderItem {
  id: number;
  quantity: number;
  product: { id: number; name: string; };
  observation?: string;
  addons: any[];
  meat_point?: string;
  removed_ingredients?: string | string[];
}

interface Order {
  id: number;
  status: string;
  total_price: number | string;
  payment_method: string;
  change_for?: string | number | null;
  created_at: string;
  type: 'DELIVERY' | 'TAKEOUT';
  user: { name: string; phone?: string; };
  driver?: { name: string; phone?: string; };
  address?: { street: string; number: string; neighborhood: string; city: string; complement?: string; };
  items: OrderItem[];
}

export default function OrdersView() {
  const { user } = useContext(AuthContext) as any;
  const { activeTheme } = useContext(ThemeContext);
  
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  const userRole = user?.role || 'ADMIN';

  useEffect(() => {
    loadOrders();
    // Atualiza a cada 5 segundos igual ao Web
    const interval = setInterval(loadOrders, 5000); 
    return () => clearInterval(interval);
  }, []);

  async function loadOrders() {
    try {
      const { data } = await api.get('/orders');
      setOrders(data.sort((a: Order, b: Order) => b.id - a.id));
    } catch (error) {
      console.log("Erro ao carregar pedidos", error);
    } finally {
      setLoading(false);
    }
  }

  async function updateStatus(id: number, newStatus: string) {
    try {
      // Atualização Otimista
      setOrders(prev => prev.map(o => o.id === id ? { ...o, status: newStatus } : o));
      await api.patch(`/orders/${id}`, { status: newStatus });
      loadOrders();
    } catch (error) {
      Alert.alert('Erro', 'Falha ao atualizar o status do pedido.');
      loadOrders(); // Reverte em caso de erro
    }
  }

  function handleRequestCancel(id: number) {
    Alert.alert(
      'Cancelar Pedido?',
      'Deseja realmente cancelar este pedido? O cliente será notificado.',
      [
        { text: 'Não', style: 'cancel' },
        { text: 'Sim, Cancelar', style: 'destructive', onPress: () => updateStatus(id, 'CANCELED') }
      ]
    );
  }

  // Abre o endereço no Google Maps nativo
  function openMaps(address: any) {
    if (!address) return;
    const query = encodeURIComponent(`${address.street}, ${address.number} - ${address.neighborhood}, ${address.city}`);
    Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${query}`);
  }

  const formatPrice = (price: any) => Number(price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // Converte "R$ 50,00" para 50 (se vier como string) para calcular o troco
  const parseCurrency = (val: any) => {
    if (!val) return 0;
    if (typeof val === 'number') return val;
    return Number(val.replace(/\D/g, '')) / 100;
  };

  // --- COMPONENTE DO CARD DO PEDIDO ---
  const OrderCard = ({ order }: { order: Order }) => {
    const isDelivery = order.type === 'DELIVERY';
    const totalOrder = Number(order.total_price);
    const changeForValue = order.change_for ? parseCurrency(order.change_for) : 0;
    const changeToReturn = changeForValue > totalOrder ? (changeForValue - totalOrder) : 0;

    const renderActions = () => {
      // 1. PENDENTE -> PREPARANDO
      if (order.status === 'PENDING' && (userRole === 'ADMIN' || userRole === 'KITCHEN')) {
        return (
          <TouchableOpacity onPress={() => updateStatus(order.id, 'PREPARING')} className="w-full bg-blue-600 py-3 rounded-xl flex-row justify-center items-center shadow-sm shadow-blue-600/30">
            <Feather name="play" size={16} color="#fff" />
            <Text className="text-white font-bold ml-2">Aceitar e Preparar</Text>
          </TouchableOpacity>
        );
      }
      // 2. PREPARANDO -> PRONTO
      if (order.status === 'PREPARING' && (userRole === 'ADMIN' || userRole === 'KITCHEN')) {
        return (
          <TouchableOpacity onPress={() => updateStatus(order.id, 'READY_FOR_PICKUP')} className="w-full bg-orange-600 py-3 rounded-xl flex-row justify-center items-center shadow-sm shadow-orange-600/30">
            <Feather name={isDelivery ? "bell" : "check-circle"} size={16} color="#fff" />
            <Text className="text-white font-bold ml-2">{isDelivery ? 'Chamar Motoboy' : 'Pronto (Balcão)'}</Text>
          </TouchableOpacity>
        );
      }
      // 3. PRONTO -> ENTREGA / FINALIZADO
      if (order.status === 'READY_FOR_PICKUP') {
        if (isDelivery) {
           if (userRole === 'ADMIN') {
             return (
               <TouchableOpacity onPress={() => updateStatus(order.id, 'DELIVERING')} className="w-full bg-indigo-600 py-3 rounded-xl flex-row justify-center items-center shadow-sm shadow-indigo-600/30">
                 <Feather name="truck" size={16} color="#fff" />
                 <Text className="text-white font-bold ml-2">Despachar Entrega</Text>
               </TouchableOpacity>
             );
           }
           if (userRole === 'COURIER') {
             return (
               <TouchableOpacity onPress={() => updateStatus(order.id, 'DELIVERING')} className="w-full bg-indigo-600 py-3 rounded-xl flex-row justify-center items-center shadow-sm shadow-indigo-600/30">
                 <Feather name="navigation" size={16} color="#fff" />
                 <Text className="text-white font-bold ml-2">Pegar para Entrega</Text>
               </TouchableOpacity>
             );
           }
        } else if (userRole === 'ADMIN') {
          return (
            <TouchableOpacity onPress={() => updateStatus(order.id, 'DONE')} className="w-full bg-teal-600 py-3 rounded-xl flex-row justify-center items-center shadow-sm shadow-teal-600/30">
              <Feather name="check" size={16} color="#fff" />
              <Text className="text-white font-bold ml-2">Entregue ao Cliente</Text>
            </TouchableOpacity>
          );
        }
      }
      // 4. EM ENTREGA -> FINALIZADO
      if (order.status === 'DELIVERING' && (userRole === 'ADMIN' || userRole === 'COURIER')) {
        return (
          <TouchableOpacity onPress={() => updateStatus(order.id, 'DONE')} className="w-full bg-green-600 py-3 rounded-xl flex-row justify-center items-center shadow-sm shadow-green-600/30">
            <Feather name="check-circle" size={16} color="#fff" />
            <Text className="text-white font-bold ml-2">Confirmar Entrega</Text>
          </TouchableOpacity>
        );
      }
      return null;
    };

    return (
      <View className="bg-white dark:bg-slate-800 border border-gray-100 dark:border-slate-700 rounded-2xl p-4 shadow-sm mb-4">
        {/* Header do Card */}
        <View className="flex-row justify-between items-start border-b border-gray-50 dark:border-slate-700 pb-3 mb-3">
          <View>
            <View className="flex-row items-center mb-1">
              <Text className="font-bold text-gray-800 dark:text-white text-lg mr-2">#{order.id}</Text>
              <View className="bg-gray-100 dark:bg-slate-700 px-2 py-0.5 rounded-full border border-gray-200 dark:border-slate-600">
                <Text className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                  {new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Text>
              </View>
            </View>
            <View className="flex-row items-center">
              <Feather name="user" size={12} color={activeTheme === 'dark' ? '#94a3b8' : '#64748b'} />
              <Text className="text-xs font-bold text-gray-600 dark:text-gray-300 ml-1">{order.user?.name || 'Cliente'}</Text>
            </View>
          </View>
          <View className={`px-2 py-1 rounded-lg border ${
            order.status === 'PENDING' ? 'bg-yellow-50 dark:bg-yellow-900/30 border-yellow-200 dark:border-yellow-800' :
            order.status === 'PREPARING' ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800' :
            order.status === 'READY_FOR_PICKUP' ? 'bg-purple-50 dark:bg-purple-900/30 border-purple-200 dark:border-purple-800' :
            order.status === 'DELIVERING' ? 'bg-orange-50 dark:bg-orange-900/30 border-orange-200 dark:border-orange-800' :
            order.status === 'DONE' ? 'bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800'
          }`}>
            <Text className={`text-[10px] font-bold uppercase ${
              order.status === 'PENDING' ? 'text-yellow-700 dark:text-yellow-400' :
              order.status === 'PREPARING' ? 'text-blue-700 dark:text-blue-400' :
              order.status === 'READY_FOR_PICKUP' ? 'text-purple-700 dark:text-purple-400' :
              order.status === 'DELIVERING' ? 'text-orange-700 dark:text-orange-400' :
              order.status === 'DONE' ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'
            }`}>{order.status === 'READY_FOR_PICKUP' ? (isDelivery ? 'Aguardando' : 'Balcão') : order.status}</Text>
          </View>
        </View>

        {/* Info Financeira */}
        <View className="flex-row justify-between items-center bg-gray-50 dark:bg-slate-700 p-3 rounded-xl mb-3">
           <Text className="text-xs font-bold text-gray-500 dark:text-gray-300 uppercase">
             {order.payment_method === 'CREDIT_CARD' ? 'Cartão' : order.payment_method === 'MONEY' ? 'Dinheiro' : order.payment_method}
           </Text>
           <Text className="font-bold text-gray-900 dark:text-white text-base">
             {formatPrice(order.total_price)}
           </Text>
        </View>

        {/* Alerta de Troco */}
        {order.payment_method === 'MONEY' && changeForValue > 0 && (userRole === 'ADMIN' || userRole === 'COURIER') && (
          <View className="bg-green-100 dark:bg-green-900/20 border border-green-200 dark:border-green-800 p-3 rounded-xl mb-3">
            <View className="flex-row items-center mb-1">
              <Feather name="dollar-sign" size={14} color={activeTheme === 'dark' ? '#86efac' : '#166534'} />
              <Text className="text-green-800 dark:text-green-300 font-bold text-xs ml-1">TROCO NECESSÁRIO</Text>
            </View>
            <View className="flex-row justify-between">
              <Text className="text-xs text-green-700 dark:text-green-400">Paga com: {formatPrice(changeForValue)}</Text>
              <Text className="text-xs text-green-700 dark:text-green-400 font-bold">Levar: {formatPrice(changeToReturn)}</Text>
            </View>
          </View>
        )}

        {/* Endereço / Balcão */}
        {isDelivery && order.address ? (
           <View className="bg-gray-50 dark:bg-slate-700 p-3 rounded-xl border border-dashed border-gray-200 dark:border-slate-600 mb-3">
             <View className="flex-row items-start mb-2">
               <Feather name="map-pin" size={14} color="#ea580c" style={{ marginTop: 2 }} />
               <View className="ml-2 flex-1">
                 <Text className="font-bold text-gray-800 dark:text-white text-xs">{order.address.street}, {order.address.number}</Text>
                 <Text className="text-gray-600 dark:text-gray-300 text-xs">{order.address.neighborhood} - {order.address.city}</Text>
                 {order.address.complement && (
                   <Text className="text-blue-600 dark:text-blue-400 text-xs mt-1 font-medium bg-blue-50 dark:bg-blue-900/20 self-start px-1.5 py-0.5 rounded">
                     Ref: {order.address.complement}
                   </Text>
                 )}
               </View>
             </View>
             {(userRole === 'COURIER' || userRole === 'ADMIN') && (
               <TouchableOpacity onPress={() => openMaps(order.address)} className="flex-row items-center justify-center bg-white dark:bg-slate-600 border border-gray-200 dark:border-slate-500 py-2 rounded-lg mt-1 active:scale-95">
                 <Feather name="navigation" size={12} color={activeTheme === 'dark' ? '#93c5fd' : '#2563eb'} />
                 <Text className="text-blue-600 dark:text-blue-300 text-xs font-bold ml-1.5">Abrir no GPS</Text>
               </TouchableOpacity>
             )}
           </View>
        ) : (
           <View className="bg-teal-50 dark:bg-teal-900/20 p-2 rounded-lg mb-3 border border-teal-100 dark:border-teal-800 flex-row justify-center items-center">
             <Feather name="package" size={12} color={activeTheme === 'dark' ? '#5eead4' : '#0f766e'} />
             <Text className="text-xs text-teal-700 dark:text-teal-300 font-bold ml-1.5">Retirada no Balcão</Text>
           </View>
        )}

        {/* Itens do Pedido */}
        <View className="space-y-2 mb-4">
          {order.items.map((item, index) => (
            <View key={index} className="border-b border-gray-50 dark:border-slate-700/50 pb-2 mb-2 last:border-0 last:mb-0 last:pb-0">
              <View className="flex-row">
                <View className="bg-gray-100 dark:bg-slate-700 px-1.5 py-0.5 rounded mr-2 self-start">
                  <Text className="font-bold text-gray-900 dark:text-white text-xs">{item.quantity}x</Text>
                </View>
                <View className="flex-1">
                  <Text className="text-gray-800 dark:text-white text-sm font-medium">{item.product?.name}</Text>
                  
                  {item.meat_point && <Text className="text-orange-600 dark:text-orange-400 font-bold text-xs mt-0.5">🔥 Ponto: {item.meat_point}</Text>}
                  
                  {item.removed_ingredients && item.removed_ingredients.length > 0 && (
                    <Text className="text-red-500 dark:text-red-400 font-bold text-xs bg-red-50 dark:bg-red-900/20 self-start px-1 rounded mt-0.5">
                      🚫 Sem: {Array.isArray(item.removed_ingredients) ? item.removed_ingredients.join(', ') : item.removed_ingredients}
                    </Text>
                  )}
                  
                  {item.addons && item.addons.length > 0 && (
                    <Text className="text-green-600 dark:text-green-400 font-bold text-xs mt-0.5">
                      ✨ + {item.addons.map(a => a.name).join(', ')}
                    </Text>
                  )}
                  
                  {item.observation && (
                    <View className="bg-yellow-50 dark:bg-yellow-900/10 p-1.5 rounded border border-yellow-100 dark:border-yellow-900/30 mt-1">
                      <Text className="text-gray-500 dark:text-gray-400 italic text-[10px]">Obs: {item.observation}</Text>
                    </View>
                  )}
                </View>
              </View>
            </View>
          ))}
        </View>

        {/* Ações */}
        <View className="pt-2">
          {renderActions()}
          {order.status !== 'DONE' && order.status !== 'CANCELED' && userRole === 'ADMIN' && (
             <TouchableOpacity onPress={() => handleRequestCancel(order.id)} className="mt-3 py-2 items-center">
               <Text className="text-red-400 dark:text-red-500 text-xs font-bold underline">Cancelar Pedido</Text>
             </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  // Filtros de Colunas
  const pendingOrders = orders.filter(o => o.status === 'PENDING');
  const preparingOrders = orders.filter(o => o.status === 'PREPARING');
  const readyDeliveryOrders = orders.filter(o => o.status === 'READY_FOR_PICKUP' && o.type === 'DELIVERY');
  const readyTakeoutOrders = orders.filter(o => o.status === 'READY_FOR_PICKUP' && o.type === 'TAKEOUT'); 
  const deliveringOrders = orders.filter(o => o.status === 'DELIVERING');

  const showNew = ['ADMIN', 'KITCHEN'].includes(userRole);
  const showKitchen = ['ADMIN', 'KITCHEN'].includes(userRole);
  const showReadyDelivery = ['ADMIN', 'COURIER'].includes(userRole); 
  const showReadyTakeout = ['ADMIN'].includes(userRole); 
  const showDelivery = ['ADMIN', 'COURIER'].includes(userRole); 

  if (loading && orders.length === 0) {
    return (
      <View className="flex-1 justify-center items-center">
        <ActivityIndicator size="large" color="#ea580c" />
        <Text className="text-gray-400 mt-4">Carregando painel...</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-gray-50 dark:bg-slate-900">
      <View className="px-4 py-4 bg-white dark:bg-slate-800 border-b border-gray-100 dark:border-slate-700 flex-row justify-between items-center">
        <View>
          <Text className="text-xl font-bold text-gray-800 dark:text-white">
            {userRole === 'KITCHEN' ? 'Monitor da Cozinha 🍳' : userRole === 'COURIER' ? 'Entregas 🏍️' : 'Gestão de Pedidos'}
          </Text>
          <Text className="text-xs text-gray-500 dark:text-gray-400">Arraste para o lado para ver as colunas</Text>
        </View>
        <TouchableOpacity onPress={loadOrders} className="p-2 bg-gray-100 dark:bg-slate-700 rounded-full active:scale-95">
          <Feather name="refresh-cw" size={16} color={activeTheme === 'dark' ? '#cbd5e1' : '#475569'} />
        </TouchableOpacity>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-1 p-4" contentContainerStyle={{ paddingRight: 32 }}>
        
        {/* COLUNA: NOVOS */}
        {showNew && (
          <View className="w-80 mr-4">
            <View className="bg-yellow-50 dark:bg-yellow-900/30 p-3 rounded-xl border border-yellow-100 dark:border-yellow-800 mb-3 flex-row justify-between items-center">
              <View className="flex-row items-center">
                <Feather name="alert-circle" size={16} color={activeTheme === 'dark' ? '#facc15' : '#854d0e'} />
                <Text className="font-bold text-yellow-800 dark:text-yellow-400 ml-2">Novos</Text>
              </View>
              <View className="bg-white dark:bg-slate-800 px-2 py-0.5 rounded-md shadow-sm"><Text className="text-xs font-bold text-gray-800 dark:text-white">{pendingOrders.length}</Text></View>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
              {pendingOrders.map(o => <OrderCard key={o.id} order={o} />)}
              {pendingOrders.length === 0 && <Text className="text-center text-gray-400 italic mt-10">Sem novos pedidos</Text>}
            </ScrollView>
          </View>
        )}

        {/* COLUNA: PREPARANDO */}
        {showKitchen && (
          <View className="w-80 mr-4">
            <View className="bg-blue-50 dark:bg-blue-900/30 p-3 rounded-xl border border-blue-100 dark:border-blue-800 mb-3 flex-row justify-between items-center">
              <View className="flex-row items-center">
                <Feather name="play-circle" size={16} color={activeTheme === 'dark' ? '#60a5fa' : '#1e40af'} />
                <Text className="font-bold text-blue-800 dark:text-blue-400 ml-2">Preparando</Text>
              </View>
              <View className="bg-white dark:bg-slate-800 px-2 py-0.5 rounded-md shadow-sm"><Text className="text-xs font-bold text-gray-800 dark:text-white">{preparingOrders.length}</Text></View>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
              {preparingOrders.map(o => <OrderCard key={o.id} order={o} />)}
              {preparingOrders.length === 0 && <Text className="text-center text-gray-400 italic mt-10">Cozinha livre</Text>}
            </ScrollView>
          </View>
        )}

        {/* COLUNA: AGUARDANDO MOTOBOY */}
        {showReadyDelivery && (
          <View className="w-80 mr-4">
            <View className="bg-purple-50 dark:bg-purple-900/30 p-3 rounded-xl border border-purple-100 dark:border-purple-800 mb-3 flex-row justify-between items-center">
              <View className="flex-row items-center">
                <Feather name="bell" size={16} color={activeTheme === 'dark' ? '#c084fc' : '#6b21a8'} />
                <Text className="font-bold text-purple-800 dark:text-purple-400 ml-2">Aguardando Motoboy</Text>
              </View>
              <View className="bg-white dark:bg-slate-800 px-2 py-0.5 rounded-md shadow-sm"><Text className="text-xs font-bold text-gray-800 dark:text-white">{readyDeliveryOrders.length}</Text></View>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
              {readyDeliveryOrders.map(o => <OrderCard key={o.id} order={o} />)}
              {readyDeliveryOrders.length === 0 && <Text className="text-center text-gray-400 italic mt-10">Nenhum delivery pronto</Text>}
            </ScrollView>
          </View>
        )}

        {/* COLUNA: RETIRAR BALCÃO */}
        {showReadyTakeout && (
          <View className="w-80 mr-4">
            <View className="bg-teal-50 dark:bg-teal-900/30 p-3 rounded-xl border border-teal-100 dark:border-teal-800 mb-3 flex-row justify-between items-center">
              <View className="flex-row items-center">
                <Feather name="package" size={16} color={activeTheme === 'dark' ? '#2dd4bf' : '#115e59'} />
                <Text className="font-bold text-teal-800 dark:text-teal-400 ml-2">Retirar no Balcão</Text>
              </View>
              <View className="bg-white dark:bg-slate-800 px-2 py-0.5 rounded-md shadow-sm"><Text className="text-xs font-bold text-gray-800 dark:text-white">{readyTakeoutOrders.length}</Text></View>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
              {readyTakeoutOrders.map(o => <OrderCard key={o.id} order={o} />)}
              {readyTakeoutOrders.length === 0 && <Text className="text-center text-gray-400 italic mt-10">Nenhum pedido no balcão</Text>}
            </ScrollView>
          </View>
        )}

        {/* COLUNA: EM ENTREGA */}
        {showDelivery && (
          <View className="w-80 mr-4">
            <View className="bg-orange-50 dark:bg-orange-900/30 p-3 rounded-xl border border-orange-100 dark:border-orange-800 mb-3 flex-row justify-between items-center">
              <View className="flex-row items-center">
                <Feather name="truck" size={16} color={activeTheme === 'dark' ? '#fb923c' : '#9a3412'} />
                <Text className="font-bold text-orange-800 dark:text-orange-400 ml-2">Em Entrega</Text>
              </View>
              <View className="bg-white dark:bg-slate-800 px-2 py-0.5 rounded-md shadow-sm"><Text className="text-xs font-bold text-gray-800 dark:text-white">{deliveringOrders.length}</Text></View>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
              {deliveringOrders.map(o => <OrderCard key={o.id} order={o} />)}
              {deliveringOrders.length === 0 && <Text className="text-center text-gray-400 italic mt-10">Nenhuma entrega ativa</Text>}
            </ScrollView>
          </View>
        )}

      </ScrollView>
    </View>
  );
}