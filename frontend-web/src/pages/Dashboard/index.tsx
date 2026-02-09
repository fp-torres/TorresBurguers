import { useEffect, useState } from 'react';
import { DollarSign, ShoppingBag, Clock, AlertCircle } from 'lucide-react';
import { orderService } from '../../services/orderService';

export default function Dashboard() {
  const [summary, setSummary] = useState({
    totalOrders: 0,
    revenue: 0,
    pendingOrders: 0,
    preparingOrders: 0,
    pendingPayments: 0
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      try {
        const data = await orderService.getDashboard();
        setSummary(data);
      } catch (error) {
        console.error('Erro ao carregar dashboard', error);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  // Componente visual do Card
  const StatCard = ({ title, value, icon: Icon, color, subtext }: any) => (
    <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex items-center gap-4 hover:shadow-md transition-shadow">
      <div className={`p-4 rounded-xl ${color} text-white`}>
        <Icon size={28} />
      </div>
      <div>
        <p className="text-gray-500 text-sm font-medium">{title}</p>
        <h3 className="text-2xl font-bold text-gray-800">
          {loading ? '...' : value}
        </h3>
        {subtext && <p className="text-xs text-gray-400 mt-1">{subtext}</p>}
      </div>
    </div>
  );

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold text-gray-800">Visão Geral</h1>
        <p className="text-gray-500">Resumo da operação do TorresBurgers</p>
      </div>

      {/* Grid de Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        
        <StatCard 
          title="Faturamento Total" 
          value={Number(summary.revenue).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
          icon={DollarSign}
          color="bg-green-500"
          subtext="Receita bruta acumulada"
        />

        <StatCard 
          title="Total de Pedidos" 
          value={summary.totalOrders}
          icon={ShoppingBag}
          color="bg-blue-500"
          subtext="Desde o início"
        />

        <StatCard 
          title="Fila de Pedidos" 
          value={summary.pendingOrders + summary.preparingOrders}
          icon={Clock}
          color="bg-orange-500"
          subtext="Pendentes + Preparando"
        />

        <StatCard 
          title="Pagamentos Pendentes" 
          value={summary.pendingPayments}
          icon={AlertCircle}
          color="bg-red-500"
          subtext="Aguardando confirmação"
        />

      </div>

      {/* Área Placeholder para Gráficos Futuros */}
      <div className="bg-white p-8 rounded-2xl border border-gray-100 shadow-sm text-center py-20">
        <div className="flex justify-center mb-4">
          <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center text-gray-400">
            <ShoppingBag size={32} />
          </div>
        </div>
        <h3 className="text-lg font-bold text-gray-700">Mais métricas em breve</h3>
        <p className="text-gray-500 max-w-md mx-auto">
          Aqui implementaremos gráficos de vendas semanais e produtos mais vendidos nas próximas atualizações.
        </p>
      </div>
    </div>
  );
}