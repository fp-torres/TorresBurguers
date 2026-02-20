import { useEffect, useState } from 'react';
import { 
  DollarSign, ShoppingBag, Clock, Power, Store, Lock, 
  Loader2, TrendingUp, PieChart as PieIcon, Wallet 
} from 'lucide-react';
import { orderService, type Order } from '../../services/orderService';
import api from '../../services/api';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell, PieChart, Pie, Legend
} from 'recharts';

export default function Dashboard() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [summary, setSummary] = useState({
    totalOrders: 0, revenue: 0, activeOrders: 0, avgTicket: 0
  });
  
  // Dados calculados para gráficos
  const [revenueData, setRevenueData] = useState<any[]>([]);
  const [productsData, setProductsData] = useState<any[]>([]);
  const [paymentData, setPaymentData] = useState<any[]>([]);

  const [loading, setLoading] = useState(true);
  const [isStoreOpen, setIsStoreOpen] = useState(true);

  useEffect(() => {
    loadIntelligence();
    const interval = setInterval(loadIntelligence, 15000);
    return () => clearInterval(interval);
  }, []);

  async function loadIntelligence() {
    try {
      // 1. Buscamos TODOS os dados brutos para calcular métricas no Front
      const [allOrders, charts, statusRes] = await Promise.all([
        orderService.getAll(),
        orderService.getCharts(),
        api.get('/store/status').catch(() => ({ data: { is_open: false } }))
      ]);

      const finishedOrders = allOrders.filter(o => o.status === 'DONE' || o.status === 'FINISHED');
      const activeOrdersList = allOrders.filter(o => ['PENDING', 'PREPARING', 'READY_FOR_PICKUP', 'DELIVERING'].includes(o.status));

      // 2. Cálculos de Business Intelligence (BI)
      const totalRevenue = finishedOrders.reduce((acc, curr) => acc + Number(curr.total_price), 0);
      const ticket = finishedOrders.length > 0 ? totalRevenue / finishedOrders.length : 0;

      // 3. Processamento de Métodos de Pagamento
      const payMap: Record<string, number> = {};
      finishedOrders.forEach(o => {
        const method = o.payment_method === 'CREDIT_CARD' ? 'Cartão' : o.payment_method === 'MONEY' ? 'Dinheiro' : 'Pix/Outros';
        payMap[method] = (payMap[method] || 0) + 1;
      });
      const payChart = Object.keys(payMap).map(k => ({ name: k, value: payMap[k] }));

      setOrders(allOrders.sort((a, b) => b.id - a.id)); // Mais recentes primeiro
      setSummary({
        totalOrders: allOrders.length,
        revenue: totalRevenue,
        activeOrders: activeOrdersList.length,
        avgTicket: ticket
      });

      setRevenueData(charts.revenueChart || []);
      setProductsData(charts.productsChart || []);
      setPaymentData(payChart);
      setIsStoreOpen(statusRes.data.is_open);

    } catch (error) {
      console.error('Erro ao processar inteligência', error);
    } finally {
      setLoading(false);
    }
  }

  async function toggleStore() {
    try {
      const newState = !isStoreOpen;
      await api.patch('/store/status', { is_open: newState });
      setIsStoreOpen(newState);
    } catch { alert('Erro ao alterar status.'); }
  }

  // --- COMPONENTES VISUAIS ---
  const KpiCard = ({ title, value, icon: Icon, color, subtext, trend }: any) => (
    <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-700 flex flex-col justify-between hover:shadow-lg transition-all group h-full relative overflow-hidden">
      <div className={`absolute -right-4 -top-4 w-24 h-24 rounded-full opacity-10 ${color}`}></div>
      <div className="flex justify-between items-start mb-4 relative z-10">
        <div className={`p-3 rounded-xl ${color} text-white shadow-md`}>
          <Icon size={22} />
        </div>
        {trend && (
          <span className="flex items-center text-xs font-bold text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 px-2 py-1 rounded-lg">
            <TrendingUp size={12} className="mr-1"/> {trend}
          </span>
        )}
      </div>
      <div className="relative z-10">
        <h3 className="text-2xl font-bold text-gray-800 dark:text-white">{loading ? '...' : value}</h3>
        <p className="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider mt-1">{title}</p>
        {subtext && <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">{subtext}</p>}
      </div>
    </div>
  );

  return (
    // CORREÇÃO: max-w-[1600px] -> max-w-400 (no Tailwind v4 isso equivale a 1600px)
    <div className="space-y-6 pb-20 animate-in fade-in duration-500 max-w-400 mx-auto">
      
      {/* HEADER E CONTROLE DE LOJA */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 bg-white dark:bg-slate-800 p-6 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-700 transition-colors">
        <div>
          <h1 className="text-3xl font-bold text-gray-800 dark:text-white flex items-center gap-2">
            Dashboard <span className="text-xs bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 px-2 py-1 rounded-lg border border-orange-200 dark:border-orange-800">PRO</span>
          </h1>
          <p className="text-gray-500 dark:text-gray-400 font-medium">Visão geral estratégica do seu negócio.</p>
        </div>
        
        {/* CORREÇÃO: bg-gradient -> bg-linear */}
        <button 
          onClick={toggleStore}
          className={`relative overflow-hidden flex items-center gap-4 px-8 py-4 rounded-2xl font-bold text-white shadow-xl transition-all hover:scale-105 active:scale-95 group ${
            isStoreOpen 
              ? 'bg-linear-to-br from-green-500 to-green-700 shadow-green-200 dark:shadow-none' 
              : 'bg-linear-to-br from-red-500 to-red-700 shadow-red-200 dark:shadow-none'
          }`}
        >
          <div className="bg-white/20 p-2 rounded-xl backdrop-blur-sm">
            {isStoreOpen ? <Store size={24} /> : <Lock size={24} />}
          </div>
          <div className="text-left z-10">
            <p className="text-[10px] uppercase opacity-80 font-black tracking-widest">Loja Online</p>
            <p className="text-2xl leading-none tracking-tight">{isStoreOpen ? 'ABERTA' : 'FECHADA'}</p>
          </div>
          <Power size={120} className="absolute -right-6 -bottom-8 opacity-10 rotate-12 group-hover:rotate-45 transition-transform duration-500" />
        </button>
      </div>

      {/* KPI GRID */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <KpiCard 
          title="Faturamento Total" 
          value={Number(summary.revenue).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} 
          icon={DollarSign} 
          color="bg-emerald-500" 
          subtext="Receita bruta acumulada"
        />
        <KpiCard 
          title="Pedidos Realizados" 
          value={summary.totalOrders} 
          icon={ShoppingBag} 
          color="bg-blue-500" 
          subtext={`${summary.activeOrders} ativos agora`}
        />
        <KpiCard 
          title="Ticket Médio" 
          value={Number(summary.avgTicket).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} 
          icon={Wallet} 
          color="bg-violet-500" 
          subtext="Média por pedido"
          trend="+4.5%"
        />
        <KpiCard 
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
              <select className="bg-gray-50 dark:bg-slate-700 border border-gray-200 dark:border-slate-600 text-xs rounded-lg px-3 py-1 outline-none text-gray-600 dark:text-gray-300 font-bold">
                <option>Últimos 7 dias</option>
              </select>
            </div>
            {/* CORREÇÃO: h-[320px] -> h-80 */}
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
                      formatter={(val: any) => [`R$ ${val}`, 'Vendas']}
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
            {/* CORREÇÃO: h-[250px] -> h-62.5 */}
            <div className="h-62.5 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={productsData} layout="vertical" margin={{ left: 40, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#94a3b8" strokeOpacity={0.1} />
                  <XAxis type="number" hide />
                  <YAxis dataKey="name" type="category" width={100} axisLine={false} tickLine={false} tick={{fill: '#94a3b8', fontSize: 12, fontWeight: 600}} />
                  <Tooltip cursor={{fill: 'rgba(255,255,255,0.05)'}} contentStyle={{ backgroundColor: '#1e293b', borderRadius: '12px', border: 'none', color: '#fff' }} />
                  <Bar dataKey="quantity" fill="#3b82f6" radius={[0, 6, 6, 0]} barSize={24}>
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
          {/* CORREÇÃO: min-h-[300px] -> min-h-75 */}
          <div className="bg-white dark:bg-slate-800 p-6 rounded-3xl shadow-sm border border-gray-100 dark:border-slate-700 min-h-75 transition-colors">
            <h3 className="font-bold text-gray-800 dark:text-white flex items-center gap-2 mb-2">
              <PieIcon size={20} className="text-violet-600 dark:text-violet-400"/> Pagamentos
            </h3>
            {/* CORREÇÃO: h-[250px] -> h-62.5 */}
            <div className="h-62.5">
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
                      <Cell key={`cell-${index}`} fill={['#8b5cf6', '#ec4899', '#f59e0b'][index % 3]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ backgroundColor: '#1e293b', borderRadius: '12px', border: 'none', color: '#fff' }} />
                  <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ color: '#94a3b8' }}/>
                </PieChart>
              </ResponsiveContainer>
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
                      <p className="text-[10px] text-gray-400 font-medium">{new Date(order.created_at).toLocaleTimeString().slice(0,5)} • {order.items.length} itens</p>
                    </div>
                  </div>
                  <span className="text-xs font-bold text-gray-800 dark:text-white">
                    {Number(order.total_price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
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