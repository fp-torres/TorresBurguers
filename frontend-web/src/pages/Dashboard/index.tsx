import { useCallback, useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  DollarSign, ShoppingBag, Clock, Store,
  Loader2, TrendingUp, PieChart as PieIcon, Wallet, AlertTriangle
} from 'lucide-react';
import { orderService, type Order } from '../../services/orderService';
import { getApiErrorMessage, getApiErrorStatus } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import { useStoreStatus } from '../../contexts/StoreStatusContext';
import StoreToggle from '../../components/StoreToggle';
import { isOrderPaid, paymentMethodLabel } from '../../utils/orders';
import { formatCurrency, formatTime } from '../../utils/format';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell, PieChart, Pie, Legend
} from 'recharts';

interface RevenuePoint { date: string; total: number }
interface ProductPoint { name: string; quantity: number }
interface PaymentSlice { name: string; value: number }

const ACTIVE_STATUSES: Order['status'][] = ['PENDING', 'PREPARING', 'READY_FOR_PICKUP', 'DELIVERING'];

// Indicadores atualizados a cada 15 s
const POLL_INTERVAL_MS = 15000;

/** Faturamento conta só pedidos pagos e não cancelados (mesma regra da API). */
function isRevenueOrder(order: Order): boolean {
  return isOrderPaid(order) && order.status !== 'CANCELED';
}

export default function Dashboard() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [summary, setSummary] = useState({
    totalOrders: 0, revenue: 0, activeOrders: 0, avgTicket: 0, paidOrders: 0
  });

  // Dados calculados para gráficos
  const [revenueData, setRevenueData] = useState<RevenuePoint[]>([]);
  const [productsData, setProductsData] = useState<ProductPoint[]>([]);
  const [paymentData, setPaymentData] = useState<PaymentSlice[]>([]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Status da loja compartilhado (o mesmo do selo da vitrine e do quadro de pedidos)
  const { refresh: refreshStoreStatus } = useStoreStatus();
  const { refreshUser } = useAuth();

  // Só a consulta mais recente é aplicada, e a automática não começa com outra em andamento
  const requestSeq = useRef(0);
  const loadInFlight = useRef(false);

  const loadIntelligence = useCallback(async (trigger: 'poll' | 'manual' = 'manual') => {
    if (trigger === 'poll' && loadInFlight.current) return;
    const requestId = ++requestSeq.current;
    loadInFlight.current = true;
    try {
      // 1. Movimento recente (pedidos em andamento + concluídos/cancelados nas últimas 24 h) e gráficos dos 7 dias
      const [allOrders, charts] = await Promise.all([
        orderService.getActive(),
        orderService.getCharts(),
      ]);
      if (requestId !== requestSeq.current) return;

      const revenueOrders = allOrders.filter(isRevenueOrder);
      const activeOrdersList = allOrders.filter(o => ACTIVE_STATUSES.includes(o.status));

      // 2. Cálculos de Business Intelligence (BI)
      const totalRevenue = revenueOrders.reduce((acc, curr) => acc + Number(curr.total_price), 0);
      const ticket = revenueOrders.length > 0 ? totalRevenue / revenueOrders.length : 0;

      // 3. Formas de pagamento dos pedidos faturados
      const payMap: Record<string, number> = {};
      revenueOrders.forEach(o => {
        const method = paymentMethodLabel(o.payment_method);
        payMap[method] = (payMap[method] || 0) + 1;
      });
      const payChart = Object.keys(payMap).map(k => ({ name: k, value: payMap[k] }));

      setOrders([...allOrders].sort((a, b) => b.id - a.id)); // Mais recentes primeiro
      setSummary({
        totalOrders: allOrders.length,
        revenue: totalRevenue,
        activeOrders: activeOrdersList.length,
        avgTicket: ticket,
        paidOrders: revenueOrders.length,
      });

      setRevenueData(charts.revenueChart || []);
      setProductsData(charts.productsChart || []);
      setPaymentData(payChart);
      setLoadError(null);
    } catch (error) {
      if (requestId !== requestSeq.current) return;
      // Mantém os últimos números na tela; 403 = o perfil mudou (a sessão é atualizada e leva à página certa)
      if (getApiErrorStatus(error) === 403) void refreshUser();
      setLoadError(getApiErrorMessage(error, 'Não foi possível atualizar os indicadores.'));
    } finally {
      if (requestId === requestSeq.current) {
        loadInFlight.current = false;
        setLoading(false);
      }
    }
  }, [refreshUser]);

  useEffect(() => {
    loadIntelligence();
    refreshStoreStatus();
    const interval = setInterval(() => loadIntelligence('poll'), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadIntelligence, refreshStoreStatus]);

  return (
    <div className="space-y-6 pb-20 animate-in fade-in duration-500 max-w-400 mx-auto">

      {/* HEADER E CONTROLE DE LOJA */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 bg-white dark:bg-slate-800 p-6 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-700 transition-colors">
        <div>
          <h1 className="text-3xl font-bold text-gray-800 dark:text-white flex items-center gap-2">
            Dashboard <span className="text-xs bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 px-2 py-1 rounded-lg border border-orange-200 dark:border-orange-800">PRO</span>
          </h1>
          <p className="text-gray-500 dark:text-gray-400 font-medium">Movimento das últimas 24 horas e pedidos em andamento.</p>
        </div>

        <StoreToggle variant="hero" />
      </div>

      {loadError && (
        <div role="alert" className="flex items-center gap-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 px-4 py-3 rounded-2xl text-sm">
          <AlertTriangle size={18} className="shrink-0" />
          <span>{loadError} Os números abaixo podem estar desatualizados; uma nova tentativa é feita a cada 15 segundos.</span>
        </div>
      )}

      {/* KPI GRID */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <KpiCard
          loading={loading}
          title="Faturamento Total"
          value={formatCurrency(summary.revenue)}
          icon={DollarSign}
          color="bg-emerald-500"
          subtext={`${summary.paidOrders} pedidos pagos (sem cancelados)`}
        />
        <KpiCard
          loading={loading}
          title="Pedidos Realizados"
          value={summary.totalOrders}
          icon={ShoppingBag}
          color="bg-blue-500"
          subtext={`${summary.activeOrders} ativos agora`}
        />
        <KpiCard
          loading={loading}
          title="Ticket Médio"
          value={formatCurrency(summary.avgTicket)}
          icon={Wallet}
          color="bg-violet-500"
          subtext="Média por pedido pago"
        />
        <KpiCard
          loading={loading}
          title="Fila de Produção"
          value={summary.activeOrders}
          icon={Clock}
          color="bg-orange-500"
          subtext="Pedidos em andamento"
        />
      </div>

      {/* PAINEL CENTRAL */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 h-full">

        {/* ESQUERDA: GRÁFICOS FINANCEIROS (Ocupa 2 colunas) */}
        <div className="xl:col-span-2 space-y-6">

          {/* GRÁFICO DE FATURAMENTO */}
          <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-700 transition-colors">
            <div className="flex justify-between items-center mb-6">
              <h3 className="font-bold text-gray-800 dark:text-white flex items-center gap-2">
                <TrendingUp size={20} className="text-emerald-600 dark:text-emerald-400"/> Desempenho Financeiro
              </h3>
              <span className="bg-gray-50 dark:bg-slate-700 border border-gray-200 dark:border-slate-600 text-xs rounded-lg px-3 py-1 text-gray-600 dark:text-gray-300 font-bold">
                Últimos 7 dias
              </span>
            </div>
            <div className="h-80 w-full">
              {loading ? (
                <div className="h-full flex items-center justify-center"><Loader2 className="animate-spin text-gray-300"/></div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={revenueData}>
                    <defs>
                      <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.1}/>
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#94a3b8" strokeOpacity={0.1} />
                    <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{fill: '#94a3b8', fontSize: 12}} dy={10} />
                    <YAxis axisLine={false} tickLine={false} tick={{fill: '#94a3b8', fontSize: 12}} tickFormatter={(val) => `R$${val}`} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1e293b', borderRadius: '16px', border: 'none', color: '#fff', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.3)' }}
                      itemStyle={{ color: '#fff' }}
                      formatter={(val) => [formatCurrency(Number(val)), 'Vendas']}
                    />
                    <Area type="monotone" dataKey="total" stroke="#10b981" strokeWidth={3} fillOpacity={1} fill="url(#colorRevenue)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* GRÁFICO DE PRODUTOS */}
          <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-700 transition-colors">
            <h3 className="font-bold text-gray-800 dark:text-white flex items-center gap-2 mb-6">
              <ShoppingBag size={20} className="text-blue-600 dark:text-blue-400"/> Produtos Campeões
            </h3>
            <div className="h-62.5 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={productsData} layout="vertical" margin={{ left: 40, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#94a3b8" strokeOpacity={0.1} />
                  <XAxis type="number" hide />
                  <YAxis dataKey="name" type="category" width={100} axisLine={false} tickLine={false} tick={{fill: '#94a3b8', fontSize: 12, fontWeight: 600}} />
                  <Tooltip cursor={{fill: 'rgba(255,255,255,0.05)'}} contentStyle={{ backgroundColor: '#1e293b', borderRadius: '12px', border: 'none', color: '#fff' }} />
                  <Bar dataKey="quantity" name="Quantidade" fill="#3b82f6" radius={[0, 6, 6, 0]} barSize={24}>
                    {productsData.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={index === 0 ? '#f59e0b' : '#3b82f6'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* DIREITA: DETALHES E FEED (Ocupa 1 coluna) */}
        <div className="space-y-6">

          {/* MEIOS DE PAGAMENTO (PIZZA) */}
          <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-700 min-h-75 transition-colors">
            <h3 className="font-bold text-gray-800 dark:text-white flex items-center gap-2 mb-2">
              <PieIcon size={20} className="text-violet-600 dark:text-violet-400"/> Pagamentos
            </h3>
            <div className="h-62.5">
              {!loading && paymentData.length === 0 ? (
                <p className="h-full flex items-center justify-center text-center text-gray-400 text-xs">Nenhum pedido pago ainda.</p>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={paymentData}
                      innerRadius={60}
                      outerRadius={80}
                      paddingAngle={5}
                      dataKey="value"
                    >
                      {paymentData.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={['#8b5cf6', '#ec4899', '#f59e0b', '#10b981'][index % 4]} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={{ backgroundColor: '#1e293b', borderRadius: '12px', border: 'none', color: '#fff' }} />
                    <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ color: '#94a3b8' }}/>
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* ATIVIDADE RECENTE (FEED) */}
          <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-700 flex-1 transition-colors">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-gray-800 dark:text-white flex items-center gap-2">
                <Clock size={20} className="text-gray-400"/> Atividade
              </h3>
              <span className="text-[10px] font-bold bg-gray-100 dark:bg-slate-700 dark:text-gray-300 px-2 py-1 rounded text-gray-500">Últimos 5</span>
            </div>

            <div className="space-y-4">
              {orders.slice(0, 5).map(order => (
                <div key={order.id} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-slate-900 rounded-xl border border-gray-100 dark:border-slate-700">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-full ${order.status === 'DONE' ? 'bg-green-100 dark:bg-green-900/30 text-green-600' : 'bg-orange-100 dark:bg-orange-900/30 text-orange-600'}`}>
                      {order.status === 'DONE' ? <Store size={14}/> : <Clock size={14}/>}
                    </div>
                    <div>
                      <p className="text-xs font-bold text-gray-700 dark:text-gray-200">Pedido #{order.id}</p>
                      <p className="text-[10px] text-gray-400 font-medium">{formatTime(order.created_at)} • {order.items.length} {order.items.length === 1 ? 'item' : 'itens'}</p>
                    </div>
                  </div>
                  <span className="text-xs font-bold text-gray-800 dark:text-white">
                    {formatCurrency(order.total_price)}
                  </span>
                </div>
              ))}
              {orders.length === 0 && <p className="text-center text-gray-400 text-xs py-4">Sem atividade recente.</p>}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

interface KpiCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  color: string;
  subtext?: string;
  loading: boolean;
}

// --- COMPONENTES VISUAIS ---
function KpiCard({ title, value, icon: Icon, color, subtext, loading }: KpiCardProps) {
  return (
    <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-700 flex flex-col justify-between hover:shadow-lg transition-all group h-full relative overflow-hidden">
      <div className={`absolute -right-4 -top-4 w-24 h-24 rounded-full opacity-10 ${color}`}></div>
      <div className="flex justify-between items-start mb-4 relative z-10">
        <div className={`p-3 rounded-xl ${color} text-white shadow-md`}>
          <Icon size={22} />
        </div>
      </div>
      <div className="relative z-10">
        <h3 className="text-2xl font-bold text-gray-800 dark:text-white">{loading ? '...' : value}</h3>
        <p className="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider mt-1">{title}</p>
        {subtext && <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">{subtext}</p>}
      </div>
    </div>
  );
}
