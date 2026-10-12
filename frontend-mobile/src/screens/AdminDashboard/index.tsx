import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator,
  Modal, AppState, BackHandler, RefreshControl,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';

import { AuthContext } from '../../contexts/AuthContext';
import { ThemeContext } from '../../contexts/ThemeContext';
import { StoreContext, useStoreToggle } from '../../contexts/StoreContext';
import api from '../../services/api';
import BrandWordmark from '../../components/BrandWordmark';
import type { FeatherIconName } from '../../utils/catalog';
import { ACTIVE_STATUSES, Order, OrderStatus, itemCountLabel, staffStatusLabel } from '../../utils/orders';
import { firstName, formatPrice, formatTime, isSameStoreDay } from '../../utils/format';
import { ROLE_LABELS, StaffRole, isStaffRole } from '../../utils/roles';

import OrdersView from './components/OrdersView';
import ProductsView from './components/ProductsView';
import UsersView from './components/UsersView';

type Section = 'overview' | 'orders' | 'products' | 'users';

const SECTION_INFO: Record<Section, { label: string; title: string; icon: FeatherIconName }> = {
  overview: { label: 'Dashboard', title: 'Painel', icon: 'layout' },
  orders: { label: 'Pedidos', title: 'Pedidos', icon: 'shopping-bag' },
  products: { label: 'Produtos', title: 'Cardápio', icon: 'box' },
  users: { label: 'Usuários', title: 'Equipe', icon: 'users' },
};

/** Seções do painel por perfil: só o administrador vê financeiro, cardápio e usuários. */
const SECTIONS_BY_ROLE: Record<StaffRole, Section[]> = {
  ADMIN: ['overview', 'orders', 'products', 'users'],
  EMPLOYEE: ['orders'],
  KITCHEN: ['orders'],
  COURIER: ['orders'],
};

const ORDERS_LABEL_BY_ROLE: Partial<Record<StaffRole, string>> = {
  KITCHEN: 'Cozinha',
  COURIER: 'Entregas',
};

export default function AdminDashboard() {
  const { signOut, user } = useContext(AuthContext);
  const { themeMode, activeTheme, cycleTheme } = useContext(ThemeContext);
  const { refresh: refreshStore } = useContext(StoreContext);
  // Abrir/fechar a loja pede confirmação (o mesmo fluxo do quadro de pedidos)
  const { isOpen: isStoreOpen, toggling: togglingStore, requestToggle: requestStoreToggle } = useStoreToggle();
  const insets = useSafeAreaInsets();

  // Sem perfil de equipe (instante do logout) usa o conjunto mais restrito de seções
  const rawRole = user?.role;
  const role: StaffRole = isStaffRole(rawRole) ? rawRole : 'EMPLOYEE';
  const sections = SECTIONS_BY_ROLE[role];
  const defaultSection = sections[0];

  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const [activeTab, setActiveTab] = useState<Section>(defaultSection);

  // Se o perfil mudar (ex.: atualizado pelo servidor), volta para uma seção permitida
  useEffect(() => {
    if (!sections.includes(activeTab)) setActiveTab(defaultSection);
  }, [sections, activeTab, defaultSection]);

  // Botão voltar do Android: fecha o menu (Modal) ou volta para a seção inicial antes de sair do app
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        if (activeTab !== defaultSection) {
          setActiveTab(defaultSection);
          return true;
        }
        return false;
      });
      return () => subscription.remove();
    }, [activeTab, defaultSection])
  );

  // Uma consulta por vez no polling, e só a resposta mais recente é aplicada
  const latestRequest = useRef(0);
  const loadInFlight = useRef(false);

  /**
   * GET /orders?scope=active: pedidos ativos + encerrados nas últimas 24 h — cobre todos os
   * pedidos de hoje usados nos indicadores, sem baixar o histórico inteiro a cada 15 s.
   */
  const fetchIntelligence = useCallback(async (force = false) => {
    if (loadInFlight.current && !force) return;
    const requestId = ++latestRequest.current;
    loadInFlight.current = true;
    try {
      const [ordersRes] = await Promise.all([
        api.get<Order[] | null>('/orders', { params: { scope: 'active' } }),
        refreshStore(),
      ]);
      if (requestId !== latestRequest.current) return; // Chegou depois de uma consulta mais nova
      const allOrders = Array.isArray(ordersRes.data) ? ordersRes.data : [];
      setOrders([...allOrders].sort((a, b) => b.id - a.id));
    } catch {
      // Sem rede: mantém os últimos números e tenta de novo no próximo ciclo
    } finally {
      if (requestId === latestRequest.current) {
        loadInFlight.current = false;
        setLoading(false);
      }
    }
  }, [refreshStore]);

  useEffect(() => {
    if (activeTab === 'overview') {
      fetchIntelligence();
      const interval = setInterval(() => {
        if (AppState.currentState === 'active') fetchIntelligence();
      }, 15000);
      return () => clearInterval(interval);
    }
  }, [activeTab, fetchIntelligence]);

  // Indicadores do dia (faturamento só de pedidos pagos e não cancelados, como no backend).
  // "Hoje" é o dia no fuso da loja (America/Sao_Paulo por padrão), não o do aparelho.
  const summary = useMemo(() => {
    const today = orders.filter((order) => isSameStoreDay(order.created_at));
    const todayValid = today.filter((order) => order.status !== 'CANCELED');
    const paidToday = todayValid.filter((order) => order.payment_status === 'PAID');
    const revenue = paidToday.reduce((acc, order) => acc + (Number(order.total_price) || 0), 0);
    return {
      todayOrders: todayValid.length,
      canceledToday: today.length - todayValid.length,
      revenue,
      avgTicket: paidToday.length > 0 ? revenue / paidToday.length : 0,
      activeOrders: orders.filter((order) => ACTIVE_STATUSES.includes(order.status as OrderStatus)).length,
    };
  }, [orders]);

  async function handleRefresh() {
    setRefreshing(true);
    await fetchIntelligence(true);
    setRefreshing(false);
  }

  function handleSignOut() {
    setIsSidebarOpen(false);
    // A sessão é encerrada no AuthContext: as rotas trocam para a tela de acesso sozinhas
    signOut();
  }

  function changeTab(tab: Section) {
    setActiveTab(tab);
    setIsSidebarOpen(false);
  }

  const getThemeIcon = (): FeatherIconName => {
    if (themeMode === 'system') return 'smartphone';
    return themeMode === 'dark' ? 'moon' : 'sun';
  };

  const sectionLabel = (section: Section) =>
    section === 'orders' ? (ORDERS_LABEL_BY_ROLE[role] ?? SECTION_INFO.orders.label) : SECTION_INFO[section].label;

  const sectionTitle = (section: Section) =>
    section === 'orders' ? (ORDERS_LABEL_BY_ROLE[role] ?? SECTION_INFO.orders.title) : SECTION_INFO[section].title;

  const KpiCard = ({ title, value, icon, colorClass, subtext }: { title: string; value: string | number; icon: FeatherIconName; colorClass: string; subtext?: string }) => (
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
        {subtext ? <Text className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">{subtext}</Text> : null}
      </View>
    </View>
  );

  const renderOverview = () => (
    <ScrollView
      className="flex-1 px-4 pt-6"
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#f97316" colors={['#f97316']} />}
    >
      <View className="mb-6">
        <Text className="text-2xl font-bold text-gray-800 dark:text-white mb-1">Visão Geral</Text>
        <Text className="text-sm text-gray-500 dark:text-gray-400">Gerencie sua operação em tempo real.</Text>
      </View>

      <TouchableOpacity
        activeOpacity={0.8}
        onPress={requestStoreToggle}
        disabled={togglingStore}
        accessibilityRole="button"
        accessibilityLabel={`Loja online ${isStoreOpen ? 'aberta' : 'fechada'}`}
        accessibilityHint={isStoreOpen ? 'Pede confirmação para fechar a loja' : 'Pede confirmação para abrir a loja'}
        className={`w-full flex-row items-center p-6 rounded-3xl shadow-md mb-6 relative overflow-hidden ${
          isStoreOpen ? 'bg-emerald-500' : 'bg-red-500'
        }`}
      >
        <View className="bg-white/20 p-4 rounded-2xl mr-4">
          {togglingStore
            ? <ActivityIndicator color="#fff" />
            : <Feather name={isStoreOpen ? "unlock" : "lock"} size={32} color="#fff" />}
        </View>
        <View className="z-10">
          <Text className="text-[10px] text-white/80 font-black uppercase tracking-widest mb-1">Loja Online • toque para alterar</Text>
          <Text className="text-3xl font-bold text-white tracking-tight">{isStoreOpen ? 'ABERTA' : 'FECHADA'}</Text>
        </View>
        <Feather name="power" size={140} color="rgba(255,255,255,0.1)" style={{ position: 'absolute', right: -30, bottom: -40, transform: [{ rotate: '20deg' }] }} />
      </TouchableOpacity>

      <View className="flex-row flex-wrap justify-between mb-2">
        <KpiCard title="Faturamento Hoje" value={formatPrice(summary.revenue)} icon="dollar-sign" colorClass="bg-emerald-500" subtext="Pedidos pagos" />
        <KpiCard
          title="Pedidos Hoje"
          value={summary.todayOrders}
          icon="shopping-bag"
          colorClass="bg-blue-500"
          subtext={summary.canceledToday > 0 ? `${summary.canceledToday} cancelado(s)` : undefined}
        />
        <KpiCard title="Ticket Médio" value={formatPrice(summary.avgTicket)} icon="trending-up" colorClass="bg-violet-500" subtext="Hoje" />
        <KpiCard title="Fila (Ativos)" value={summary.activeOrders} icon="clock" colorClass="bg-orange-500" />
      </View>

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
            orders.slice(0, 5).map(order => {
              const done = order.status === 'DONE';
              const canceled = order.status === 'CANCELED';
              return (
                <View key={order.id} className="flex-row justify-between items-center py-3 border-b border-gray-50 dark:border-slate-700/50">
                  <View className="flex-row items-center flex-1">
                    <View className={`p-2.5 rounded-full mr-3 ${
                      done ? 'bg-green-100 dark:bg-green-900/30' : canceled ? 'bg-red-100 dark:bg-red-900/30' : 'bg-orange-100 dark:bg-orange-900/30'
                    }`}>
                      <Feather
                        name={done ? 'check' : canceled ? 'x' : 'clock'}
                        size={14}
                        color={done ? '#16a34a' : canceled ? '#ef4444' : '#ea580c'}
                      />
                    </View>
                    <View>
                      <Text className="text-sm font-bold text-gray-800 dark:text-gray-200">Pedido #{order.id}</Text>
                      <Text className="text-[10px] text-gray-400 mt-0.5">
                        {formatTime(order.created_at)} • {itemCountLabel(order)} • {staffStatusLabel(order.status, order.type)}
                      </Text>
                    </View>
                  </View>
                  <Text className="text-sm font-bold text-gray-800 dark:text-white">
                    {formatPrice(order.total_price)}
                  </Text>
                </View>
              );
            })
          )}
        </View>
      </View>
    </ScrollView>
  );

  const renderContent = () => {
    switch (activeTab) {
      case 'orders':
        return <OrdersView />;
      case 'products':
        return <ProductsView />;
      case 'users':
        return <UsersView />;
      default:
        return renderOverview();
    }
  };

  const badge = role === 'ADMIN' ? 'Admin' : ROLE_LABELS[role];

  return (
    <View className="flex-1 bg-gray-50 dark:bg-slate-900" style={{ paddingTop: insets.top }}>

      {/* HEADER NAVBAR */}
      <View className="px-6 py-4 flex-row items-center justify-between bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 z-10">
        <View className="flex-row items-center flex-1">
          <TouchableOpacity
            onPress={() => setIsSidebarOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Abrir menu"
            className="p-2 mr-3 bg-gray-100 dark:bg-slate-700 rounded-lg active:scale-95"
          >
            <Feather name="menu" size={24} color={activeTheme === 'dark' ? '#f8fafc' : '#334155'} />
          </TouchableOpacity>
          <View className="flex-1">
            <Text className="text-xl font-bold text-slate-900 dark:text-white" numberOfLines={1}>
              {sectionTitle(activeTab)}
            </Text>
            <Text className="text-[10px] font-bold uppercase text-orange-600 dark:text-orange-400">{ROLE_LABELS[role]}</Text>
          </View>
        </View>
        <TouchableOpacity
          onPress={cycleTheme}
          accessibilityRole="button"
          accessibilityLabel={`Tema ${themeMode === 'system' ? 'do sistema' : themeMode === 'dark' ? 'escuro' : 'claro'}`}
          accessibilityHint="Alterna entre o tema do sistema, claro e escuro"
          className="p-2.5 bg-gray-100 dark:bg-slate-700 rounded-xl active:scale-95"
        >
          <Feather name={getThemeIcon()} size={20} color={activeTheme === 'dark' ? '#fbbf24' : '#475569'} />
        </TouchableOpacity>
      </View>

      {/* SIDEBAR MODAL (o botão voltar do Android fecha via onRequestClose) */}
      <Modal visible={isSidebarOpen} transparent animationType="fade" onRequestClose={() => setIsSidebarOpen(false)}>
        <View className="flex-1 flex-row">
          <TouchableOpacity className="absolute inset-0 bg-black/60 z-0" activeOpacity={1} onPress={() => setIsSidebarOpen(false)} />

          <View
            className="w-64 h-full bg-white dark:bg-slate-800 shadow-2xl z-10 flex-col px-6"
            style={{ paddingTop: insets.top + 32, paddingBottom: insets.bottom + 16 }}
          >
            <View className="flex-row justify-between items-center mb-8 border-b border-gray-100 dark:border-slate-700 pb-4">
              <View className="flex-1 mr-2">
                <BrandWordmark size="md" badge={badge} />
                <Text className="text-xs text-gray-500 dark:text-gray-400 mt-1">Olá, {firstName(user?.name)}</Text>
              </View>
              <TouchableOpacity onPress={() => setIsSidebarOpen(false)} accessibilityRole="button" accessibilityLabel="Fechar menu">
                <Feather name="x" size={24} color={activeTheme === 'dark' ? '#94a3b8' : '#64748b'} />
              </TouchableOpacity>
            </View>

            <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
              {sections.map((section) => {
                const active = activeTab === section;
                return (
                  <TouchableOpacity
                    key={section}
                    onPress={() => changeTab(section)}
                    className={`flex-row items-center py-4 px-4 rounded-xl mb-2 ${active ? 'bg-orange-50 dark:bg-orange-900/20' : ''}`}
                  >
                    <Feather name={SECTION_INFO[section].icon} size={20} color={active ? '#ea580c' : (activeTheme === 'dark' ? '#cbd5e1' : '#475569')} />
                    <Text className={`ml-3 font-bold ${active ? 'text-orange-600 dark:text-orange-500' : 'text-slate-600 dark:text-slate-300'}`}>
                      {sectionLabel(section)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <View className="border-t border-gray-100 dark:border-slate-700 pt-4 mt-auto">
              <TouchableOpacity onPress={handleSignOut} className="flex-row items-center py-3 px-4 rounded-xl active:bg-red-100 dark:active:bg-red-900/30">
                <Feather name="log-out" size={20} color="#ef4444" />
                <Text className="ml-3 font-bold text-red-500">Sair</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ÁREA PRINCIPAL DINÂMICA */}
      <View className="flex-1" style={{ paddingBottom: insets.bottom }}>
        {renderContent()}
      </View>

    </View>
  );
}
