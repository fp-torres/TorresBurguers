import React, { useContext, useEffect, useState } from 'react';
import { 
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator, 
  Dimensions, Modal, Alert 
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useNavigation } from '@react-navigation/native';

import { AuthContext } from '../../contexts/AuthContext';
import { ThemeContext } from '../../contexts/ThemeContext';
import api from '../../services/api';

const { width, height } = Dimensions.get('window');

interface Order {
  id: number;
  total_price: number;
  status: string;
  created_at: string;
  items: any[];
  payment_method: string;
}

export default function AdminDashboard() {
  const { signOut } = useContext(AuthContext) as any;
  const { themeMode, activeTheme, cycleTheme } = useContext(ThemeContext);
  const navigation = useNavigation<any>();

  const [orders, setOrders] = useState<Order[]>([]);
  const [summary, setSummary] = useState({
    totalOrders: 0, revenue: 0, activeOrders: 0, avgTicket: 0
  });
  
  const [loading, setLoading] = useState(true);
  const [isStoreOpen, setIsStoreOpen] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  useEffect(() => {
    fetchIntelligence();
    const interval = setInterval(fetchIntelligence, 15000);
    return () => clearInterval(interval);
  }, []);

  async function fetchIntelligence() {
    try {
      // Fazendo as requisições (ajuste as rotas de pedidos conforme seu backend)
      const [ordersRes, statusRes] = await Promise.all([
        api.get('/orders').catch(() => ({ data: [] })),
        api.get('/store/status').catch(() => ({ data: { is_open: false } }))
      ]);

      const allOrders: Order[] = ordersRes.data || [];
      
      const finishedOrders = allOrders.filter(o => o.status === 'DONE' || o.status === 'FINISHED');
      const activeOrdersList = allOrders.filter(o => 
        ['PENDING', 'PREPARING', 'READY_FOR_PICKUP', 'DELIVERING'].includes(o.status)
      );

      const totalRevenue = finishedOrders.reduce((acc, curr) => acc + Number(curr.total_price), 0);
      const ticket = finishedOrders.length > 0 ? totalRevenue / finishedOrders.length : 0;

      setOrders(allOrders.sort((a, b) => b.id - a.id));
      setSummary({
        totalOrders: allOrders.length,
        revenue: totalRevenue,
        activeOrders: activeOrdersList.length,
        avgTicket: ticket
      });

      setIsStoreOpen(statusRes.data.is_open);

    } catch (error) {
      console.error('Erro ao processar dados do painel', error);
    } finally {
      setLoading(false);
    }
  }

  async function toggleStore() {
    try {
      const newState = !isStoreOpen;
      await api.patch('/store/status', { is_open: newState });
      setIsStoreOpen(newState);
      Alert.alert('Sucesso', `A loja foi ${newState ? 'ABERTA' : 'FECHADA'}!`);
    } catch { 
      Alert.alert('Erro', 'Não foi possível alterar o status da loja.'); 
    }
  }

  const formatPrice = (price: number) => Number(price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const getThemeIcon = () => {
    if (themeMode === 'system') return 'smartphone';
    return themeMode === 'dark' ? 'moon' : 'sun';
  };

  // --- COMPONENTE: KPI CARD ---
  const KpiCard = ({ title, value, icon, colorClass, subtext }: any) => (
    <View className="w-[48%] bg-white dark:bg-slate-800 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-700 mb-4 overflow-hidden relative">
      <View className="flex-row justify-between items-start mb-3 z-10">
        <View className={`p-2 rounded-xl ${colorClass}`}>
          <Feather name={icon} size={20} color="#fff" />
        </View>
      </View>
      <View className="z-10">
        <Text className="text-xl font-bold text-gray-800 dark:text-white" numberOfLines={1}>
          {loading ? '...' : value}
        </Text>
        <Text className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider mt-1">{title}</Text>
        {subtext && <Text className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">{subtext}</Text>}
      </View>
    </View>
  );

  return (
    <View className="flex-1 bg-gray-50 dark:bg-slate-900">
      
      {/* HEADER NAVBAR */}
      <View className="pt-14 pb-4 px-6 flex-row items-center justify-between bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 z-10">
        <View className="flex-row items-center">
          <TouchableOpacity 
            onPress={() => setIsSidebarOpen(true)}
            className="p-2 mr-3 bg-gray-100 dark:bg-slate-700 rounded-lg active:scale-95"
          >
            <Feather name="menu" size={24} color={activeTheme === 'dark' ? '#f8fafc' : '#334155'} />
          </TouchableOpacity>
          <Text className="text-xl font-bold text-slate-900 dark:text-white">Painel</Text>
        </View>
        <TouchableOpacity 
          onPress={cycleTheme} 
          className="p-2.5 bg-gray-100 dark:bg-slate-700 rounded-xl active:scale-95"
        >
          <Feather name={getThemeIcon() as any} size={20} color={activeTheme === 'dark' ? '#fbbf24' : '#475569'} />
        </TouchableOpacity>
      </View>

      {/* SIDEBAR MODAL (OVERLAY) */}
      <Modal visible={isSidebarOpen} transparent animationType="fade">
        <View className="flex-1 flex-row">
          {/* Fundo escuro que fecha ao clicar */}
          <TouchableOpacity 
            className="absolute inset-0 bg-black/50 z-0" 
            activeOpacity={1} 
            onPress={() => setIsSidebarOpen(false)} 
          />
          
          {/* Menu Lateral em si */}
          <View className="w-64 h-full bg-white dark:bg-slate-800 shadow-2xl z-10 flex-col py-12 px-6">
            <View className="flex-row justify-between items-center mb-8 border-b border-gray-100 dark:border-slate-700 pb-4">
              <Text className="text-xl font-black text-slate-900 dark:text-white">
                Torres<Text className="text-orange-500">Admin</Text>
              </Text>
              <TouchableOpacity onPress={() => setIsSidebarOpen(false)}>
                <Feather name="x" size={24} color={activeTheme === 'dark' ? '#94a3b8' : '#64748b'} />
              </TouchableOpacity>
            </View>

            <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
              <TouchableOpacity className="flex-row items-center py-4 bg-orange-50 dark:bg-orange-900/20 px-4 rounded-xl mb-2">
                <Feather name="layout" size={20} color="#ea580c" />
                <Text className="ml-3 font-bold text-orange-600 dark:text-orange-500">Dashboard</Text>
              </TouchableOpacity>
              
              <TouchableOpacity className="flex-row items-center py-4 px-4 mb-2">
                <Feather name="shopping-bag" size={20} color={activeTheme === 'dark' ? '#cbd5e1' : '#475569'} />
                <Text className="ml-3 font-medium text-slate-600 dark:text-slate-300">Pedidos</Text>
              </TouchableOpacity>
              
              <TouchableOpacity className="flex-row items-center py-4 px-4 mb-2">
                <Feather name="box" size={20} color={activeTheme === 'dark' ? '#cbd5e1' : '#475569'} />
                <Text className="ml-3 font-medium text-slate-600 dark:text-slate-300">Produtos</Text>
              </TouchableOpacity>

              <TouchableOpacity className="flex-row items-center py-4 px-4 mb-2">
                <Feather name="users" size={20} color={activeTheme === 'dark' ? '#cbd5e1' : '#475569'} />
                <Text className="ml-3 font-medium text-slate-600 dark:text-slate-300">Usuários</Text>
              </TouchableOpacity>
            </ScrollView>

            <View className="border-t border-gray-100 dark:border-slate-700 pt-4 mt-auto">
              <TouchableOpacity onPress={signOut} className="flex-row items-center py-3 px-4 rounded-xl hover:bg-red-50 active:bg-red-100 dark:active:bg-red-900/30">
                <Feather name="log-out" size={20} color="#ef4444" />
                <Text className="ml-3 font-bold text-red-500">Sair</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ÁREA PRINCIPAL DA TELA */}
      <ScrollView className="flex-1 px-4 pt-6" showsVerticalScrollIndicator={false}>
        
        {/* CABEÇALHO DO DASHBOARD */}
        <View className="mb-6">
          <Text className="text-2xl font-bold text-gray-800 dark:text-white mb-1">Visão Geral</Text>
          <Text className="text-sm text-gray-500 dark:text-gray-400">Gerencie sua operação em tempo real.</Text>
        </View>

        {/* BOTÃO GRANDÃO DA LOJA */}
        <TouchableOpacity 
          activeOpacity={0.8}
          onPress={toggleStore}
          className={`w-full flex-row items-center p-6 rounded-3xl shadow-md mb-6 relative overflow-hidden ${
            isStoreOpen ? 'bg-emerald-500' : 'bg-red-500'
          }`}
        >
          <View className="bg-white/20 p-4 rounded-2xl mr-4">
            <Feather name={isStoreOpen ? "unlock" : "lock"} size={32} color="#fff" />
          </View>
          <View className="z-10">
            <Text className="text-[10px] text-white/80 font-black uppercase tracking-widest mb-1">Loja Online</Text>
            <Text className="text-3xl font-bold text-white tracking-tight">{isStoreOpen ? 'ABERTA' : 'FECHADA'}</Text>
          </View>
          <Feather 
            name="power" 
            size={140} 
            color="rgba(255,255,255,0.1)" 
            style={{ position: 'absolute', right: -30, bottom: -40, transform: [{ rotate: '20deg' }] }} 
          />
        </TouchableOpacity>

        {/* GRADE DE KPIs (2 COLUNAS) */}
        <View className="flex-row flex-wrap justify-between mb-2">
          <KpiCard 
            title="Faturamento" 
            value={formatPrice(summary.revenue)} 
            icon="dollar-sign" 
            colorClass="bg-emerald-500" 
          />
          <KpiCard 
            title="Pedidos Hoje" 
            value={summary.totalOrders} 
            icon="shopping-bag" 
            colorClass="bg-blue-500" 
          />
          <KpiCard 
            title="Ticket Médio" 
            value={formatPrice(summary.avgTicket)} 
            icon="trending-up" 
            colorClass="bg-violet-500" 
          />
          <KpiCard 
            title="Fila (Ativos)" 
            value={summary.activeOrders} 
            icon="clock" 
            colorClass="bg-orange-500" 
          />
        </View>

        {/* FEED DE ATIVIDADES RECENTES */}
        <View className="bg-white dark:bg-slate-800 p-5 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-700 mb-8">
          <View className="flex-row justify-between items-center mb-5">
            <View className="flex-row items-center">
              <Feather name="activity" size={20} color={activeTheme === 'dark' ? '#94a3b8' : '#64748b'} />
              <Text className="text-base font-bold text-gray-800 dark:text-white ml-2">Atividade Recente</Text>
            </View>
            <View className="bg-gray-100 dark:bg-slate-700 px-2 py-1 rounded">
              <Text className="text-[10px] font-bold text-gray-500 dark:text-gray-300">Últimos 5</Text>
            </View>
          </View>
          
          <View>
            {loading ? (
              <ActivityIndicator size="small" color="#f97316" className="py-4" />
            ) : orders.length === 0 ? (
              <Text className="text-center text-gray-400 text-xs py-4">Nenhuma atividade recente encontrada.</Text>
            ) : (
              orders.slice(0, 5).map(order => (
                <View key={order.id} className="flex-row justify-between items-center py-3 border-b border-gray-50 dark:border-slate-700/50 last:border-0">
                  <View className="flex-row items-center flex-1">
                    <View className={`p-2.5 rounded-full mr-3 ${
                      order.status === 'DONE' || order.status === 'FINISHED' 
                        ? 'bg-green-100 dark:bg-green-900/30' 
                        : 'bg-orange-100 dark:bg-orange-900/30'
                    }`}>
                      <Feather 
                        name={order.status === 'DONE' || order.status === 'FINISHED' ? 'check' : 'clock'} 
                        size={14} 
                        color={order.status === 'DONE' || order.status === 'FINISHED' ? '#16a34a' : '#ea580c'} 
                      />
                    </View>
                    <View>
                      <Text className="text-sm font-bold text-gray-800 dark:text-gray-200">Pedido #{order.id}</Text>
                      <Text className="text-[10px] text-gray-400 mt-0.5">
                        {order.created_at ? new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--'} • {order.items?.length || 0} itens
                      </Text>
                    </View>
                  </View>
                  <Text className="text-sm font-bold text-gray-800 dark:text-white">
                    {formatPrice(order.total_price)}
                  </Text>
                </View>
              ))
            )}
          </View>
        </View>

      </ScrollView>
    </View>
  );
}