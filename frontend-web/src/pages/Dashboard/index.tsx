import { useEffect, useState } from 'react';
import { DollarSign, ShoppingBag, Clock, AlertCircle, Power, Store, Lock, Loader2, TrendingUp, PieChart as PieIcon } from 'lucide-react';
import { orderService } from '../../services/orderService';
import api from '../../services/api';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell
} from 'recharts';

export default function Dashboard() {
  const [summary, setSummary] = useState({
    totalOrders: 0, revenue: 0, pendingOrders: 0, preparingOrders: 0, pendingPayments: 0
  });
  
  const [chartsData, setChartsData] = useState({
    revenueChart: [] as any[],
    productsChart: [] as any[]
  });

  const [loading, setLoading] = useState(true);
  const [isStoreOpen, setIsStoreOpen] = useState(true);

  useEffect(() => {
    loadAllData();
    const interval = setInterval(loadAllData, 15000);
    return () => clearInterval(interval);
  }, []);

  async function loadAllData() {
    try {
      const [dashData, charts, statusRes] = await Promise.all([
        orderService.getDashboard(),
        orderService.getCharts(),
        api.get('/store/status').catch(() => ({ data: { is_open: false } }))
      ]);

      setSummary({
        totalOrders: Number(dashData.totalOrders || 0),
        revenue: Number(dashData.revenue || 0),
        pendingOrders: Number(dashData.pendingOrders || 0),
        preparingOrders: Number(dashData.preparingOrders || 0),
        pendingPayments: Number(dashData.pendingPayments || 0)
      });

      setChartsData(charts);
      setIsStoreOpen(statusRes.data.is_open);

    } catch (error) {
      console.error('Erro ao carregar dados', error);
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

  const StatCard = ({ title, value, icon: Icon, color, subtext }: any) => (
    <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex items-start justify-between hover:shadow-md transition-all group">
      <div className="flex-1 min-w-0 pr-4">
        <p className="text-gray-500 text-xs font-bold uppercase tracking-wider mb-1">{title}</p>
        <h3 className="text-2xl font-bold text-gray-800 truncate">
          {loading ? <Loader2 className="animate-spin w-6 h-6 text-gray-400" /> : value}
        </h3>
        {subtext && <p className="text-xs text-gray-400 mt-2 truncate">{subtext}</p>}
      </div>
      <div className={`p-3 rounded-xl ${color} text-white shadow-lg shadow-gray-200 group-hover:scale-110 transition-transform`}>
        <Icon size={24} />
      </div>
    </div>
  );

  return (
    <div className="space-y-8 animate-in fade-in duration-500 pb-20">
      
      {/* STATUS DA LOJA */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Visão Geral</h1>
          <p className="text-gray-500">Acompanhe o desempenho em tempo real.</p>
        </div>
        <button 
          onClick={toggleStore}
          className={`flex items-center gap-4 px-6 py-3 rounded-xl font-bold text-white shadow-md transition-all hover:scale-105 active:scale-95 ${
            isStoreOpen 
              ? 'bg-gradient-to-r from-green-600 to-green-500 shadow-green-200' 
              : 'bg-gradient-to-r from-red-600 to-red-500 shadow-red-200'
          }`}
        >
          <div className="bg-white/20 p-2 rounded-lg">{isStoreOpen ? <Store size={24} /> : <Lock size={24} />}</div>
          <div className="text-left">
            <p className="text-[10px] uppercase opacity-90 font-bold tracking-wider">Status da Loja</p>
            <p className="text-xl leading-none">{isStoreOpen ? 'ABERTA' : 'FECHADA'}</p>
          </div>
          <Power size={20} className="opacity-50 ml-2" />
        </button>
      </div>

      {/* CARDS */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard title="Faturamento" value={Number(summary.revenue).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} icon={DollarSign} color="bg-green-500" subtext="Total acumulado" />
        <StatCard title="Pedidos Totais" value={summary.totalOrders} icon={ShoppingBag} color="bg-blue-500" subtext="Histórico completo" />
        <StatCard title="Fila de Produção" value={summary.pendingOrders + summary.preparingOrders} icon={Clock} color="bg-orange-500" subtext="Pendentes e Preparando" />
        <StatCard title="Aguardando Pagto." value={summary.pendingPayments} icon={AlertCircle} color="bg-red-500" subtext="Pedidos não pagos" />
      </div>

      {/* ÁREA DE GRÁFICOS */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* GRÁFICO 1: VENDAS ÚLTIMOS 7 DIAS */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 min-w-0">
          <div className="flex items-center justify-between mb-6">
            <h3 className="font-bold text-gray-800 flex items-center gap-2"><TrendingUp size={20} className="text-orange-600"/> Vendas (7 dias)</h3>
          </div>
          
          <div className="h-[300px] w-full">
            {loading ? (
              <div className="h-full w-full flex items-center justify-center text-gray-400">
                <Loader2 className="animate-spin" size={32} />
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <AreaChart data={chartsData.revenueChart}>
                  <defs>
                    <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#ea580c" stopOpacity={0.2}/>
                      <stop offset="95%" stopColor="#ea580c" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                  <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{fill: '#9ca3af', fontSize: 12}} dy={10} />
                  <YAxis axisLine={false} tickLine={false} tick={{fill: '#9ca3af', fontSize: 12}} tickFormatter={(value) => `R$${value}`} />
                  <Tooltip 
                    formatter={(value: any) => [Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }), 'Vendas']}
                    contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                  />
                  <Area type="monotone" dataKey="total" stroke="#ea580c" strokeWidth={3} fillOpacity={1} fill="url(#colorTotal)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* GRÁFICO 2: PRODUTOS MAIS VENDIDOS */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 min-w-0">
          <div className="flex items-center justify-between mb-6">
            <h3 className="font-bold text-gray-800 flex items-center gap-2"><PieIcon size={20} className="text-blue-600"/> Top 5 Produtos</h3>
          </div>
          
          <div className="h-[300px] w-full">
            {loading ? (
              <div className="h-full w-full flex items-center justify-center text-gray-400">
                <Loader2 className="animate-spin" size={32} />
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={chartsData.productsChart} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f0f0f0" />
                  <XAxis type="number" hide />
                  <YAxis dataKey="name" type="category" width={100} axisLine={false} tickLine={false} tick={{fill: '#4b5563', fontSize: 11, fontWeight: 'bold'}} />
                  <Tooltip cursor={{fill: '#f9fafb'}} contentStyle={{ borderRadius: '8px' }} />
                  <Bar dataKey="quantity" fill="#3b82f6" radius={[0, 4, 4, 0]} barSize={20}>
                    {chartsData.productsChart.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={index === 0 ? '#ea580c' : '#3b82f6'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}