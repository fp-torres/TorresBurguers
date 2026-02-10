import { useEffect, useState } from 'react';
import { DollarSign, ShoppingBag, Clock, AlertCircle, Power, Store, Lock, Loader2 } from 'lucide-react';
import { orderService } from '../../services/orderService';
import api from '../../services/api';

export default function Dashboard() {
  const [summary, setSummary] = useState({
    totalOrders: 0,
    revenue: 0,
    pendingOrders: 0,
    preparingOrders: 0,
    pendingPayments: 0
  });
  const [loading, setLoading] = useState(true);
  
  // Estado da Loja
  const [isStoreOpen, setIsStoreOpen] = useState(true);

  useEffect(() => {
    loadDashboard();
    loadStoreStatus();
    
    // Atualiza dashboard e status a cada 15s
    const interval = setInterval(() => {
       loadDashboard();
       loadStoreStatus();
    }, 15000);
    
    return () => clearInterval(interval);
  }, []);

  async function loadDashboard() {
    try {
      const data = await orderService.getDashboard();
      // Blinda os dados: converte para número e evita NaN/Null
      setSummary({
        totalOrders: Number(data.totalOrders || data.total_orders || 0),
        revenue: Number(data.revenue || 0),
        pendingOrders: Number(data.pendingOrders || data.pending_orders || 0),
        preparingOrders: Number(data.preparingOrders || data.preparing_orders || 0),
        pendingPayments: Number(data.pendingPayments || data.pending_payments || 0)
      });
    } catch (error) {
      console.error('Erro ao carregar dashboard', error);
    } finally {
      setLoading(false);
    }
  }

  async function loadStoreStatus() {
    try {
      const response = await api.get('/store/status');
      setIsStoreOpen(response.data.is_open);
    } catch (error) {
      console.log("Erro ao carregar status da loja", error);
    }
  }

  async function toggleStore() {
    try {
      const newState = !isStoreOpen;
      await api.patch('/store/status', { is_open: newState });
      setIsStoreOpen(newState);
      alert(newState ? 'Loja ABERTA! 🟢' : 'Loja FECHADA! 🔴 - Clientes não podem mais pedir.');
    } catch (error) {
      alert('Erro ao alterar status da loja.');
    }
  }

  // Componente interno para os Cards
  const StatCard = ({ title, value, icon: Icon, color, subtext }: any) => (
    <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex items-start justify-between hover:shadow-md transition-all duration-300 group">
      <div className="flex-1 min-w-0 pr-4">
        <p className="text-gray-500 text-xs font-bold uppercase tracking-wider mb-1">{title}</p>
        <h3 className="text-2xl font-bold text-gray-800 truncate" title={String(value)}>
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
    <div className="space-y-8 animate-in fade-in duration-500 pb-10">
      {/* CABEÇALHO COM CONTROLE DA LOJA */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Visão Geral</h1>
          <p className="text-gray-500">Acompanhe o desempenho em tempo real.</p>
        </div>

        <button 
          onClick={toggleStore}
          className={`flex items-center gap-4 px-6 py-3 rounded-xl font-bold text-white shadow-md transition-all hover:scale-105 active:scale-95 ${
            isStoreOpen 
              ? 'bg-gradient-to-r from-green-600 to-green-500 hover:from-green-700 hover:to-green-600 shadow-green-200' 
              : 'bg-gradient-to-r from-red-600 to-red-500 hover:from-red-700 hover:to-red-600 shadow-red-200'
          }`}
        >
          <div className="bg-white/20 p-2 rounded-lg">
            {isStoreOpen ? <Store size={24} /> : <Lock size={24} />}
          </div>
          <div className="text-left">
            <p className="text-[10px] uppercase opacity-90 font-bold tracking-wider">Status da Loja</p>
            <p className="text-xl leading-none">{isStoreOpen ? 'ABERTA' : 'FECHADA'}</p>
          </div>
          <Power size={20} className="opacity-50 ml-2" />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard 
          title="Faturamento" 
          value={Number(summary.revenue).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
          icon={DollarSign}
          color="bg-green-500"
          subtext="Total acumulado"
        />

        <StatCard 
          title="Pedidos Totais" 
          value={summary.totalOrders}
          icon={ShoppingBag}
          color="bg-blue-500"
          subtext="Histórico completo"
        />

        <StatCard 
          title="Fila de Produção" 
          value={summary.pendingOrders + summary.preparingOrders}
          icon={Clock}
          color="bg-orange-500"
          subtext="Pendentes e Preparando"
        />

        <StatCard 
          title="Aguardando Pagto." 
          value={summary.pendingPayments}
          icon={AlertCircle}
          color="bg-red-500"
          subtext="Pedidos não pagos"
        />
      </div>

      <div className="bg-white p-10 rounded-2xl border border-gray-100 shadow-sm text-center">
        <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center text-gray-300 mx-auto mb-6">
          <ShoppingBag size={40} />
        </div>
        <h3 className="text-lg font-bold text-gray-700">Gráficos em Desenvolvimento</h3>
        <p className="text-gray-500 max-w-md mx-auto mt-2">
          Em breve você verá gráficos detalhados de vendas semanais, produtos mais vendidos e horários de pico aqui.
        </p>
      </div>
    </div>
  );
}