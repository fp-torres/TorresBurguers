import { useEffect, useState } from 'react';
import { Clock, CheckCircle, Package, Truck, XCircle, ChevronDown, ChevronUp, AlertCircle, RefreshCw, MapPin, DollarSign } from 'lucide-react';
import api from '../../../services/api';
import { useAuth } from '../../../contexts/AuthContext';
import { Link, useNavigate } from 'react-router-dom';

export default function ClientOrders() {
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedOrder, setExpandedOrder] = useState<number | null>(null);
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/signin');
      return;
    }
    loadOrders();
    const interval = setInterval(() => loadOrders(true), 15000); 
    return () => clearInterval(interval);
  }, [isAuthenticated]);

  async function loadOrders(silent = false) {
    if (!silent) setLoading(true);
    if (silent) setRefreshing(true);
    try {
      const response = await api.get('/orders');
      console.log("API PEDIDOS (Debug):", response.data); // Confirme os nomes aqui se der erro
      const sorted = response.data.sort((a: any, b: any) => b.id - a.id);
      setOrders(sorted);
    } catch (error) {
      console.error("Erro ao carregar pedidos", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  // Mapa de Tradução de Pagamento
  const paymentMap: any = {
    PIX: 'PIX',
    CREDIT_CARD: 'Cartão de Crédito',
    MONEY: 'Dinheiro',
    CASH: 'Dinheiro', // Caso venha CASH do backend
    OFFLINE: 'Pagar na Entrega'
  };

  const statusConfig: any = {
    PENDING: { color: 'bg-yellow-100 text-yellow-700 border-yellow-200', icon: Clock, label: 'Aguardando Confirmação' },
    PREPARING: { color: 'bg-blue-100 text-blue-700 border-blue-200', icon: Package, label: 'Em Preparo 👨‍🍳' },
    DELIVERY: { color: 'bg-orange-100 text-orange-700 border-orange-200', icon: Truck, label: 'Saiu para Entrega 🛵' },
    DELIVERING: { color: 'bg-orange-100 text-orange-700 border-orange-200', icon: Truck, label: 'Saiu para Entrega 🛵' },
    DONE: { color: 'bg-green-100 text-green-700 border-green-200', icon: CheckCircle, label: 'Entregue ✅' },
    FINISHED: { color: 'bg-green-100 text-green-700 border-green-200', icon: CheckCircle, label: 'Entregue ✅' },
    CANCELED: { color: 'bg-red-100 text-red-700 border-red-200', icon: XCircle, label: 'Cancelado ❌' },
    UNKNOWN: { color: 'bg-gray-100 text-gray-500 border-gray-200', icon: AlertCircle, label: 'Processando...' }
  };

  if (loading && !refreshing && orders.length === 0) return <div className="p-20 text-center text-gray-500">Carregando seus pedidos...</div>;

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-20">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-gray-800">Meus Pedidos 🧾</h1>
        {refreshing && <span className="text-xs text-orange-600 font-bold animate-pulse">Atualizando...</span>}
      </div>

      {orders.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-3xl shadow-sm border border-gray-100">
          <Package size={64} className="mx-auto text-gray-200 mb-4" />
          <h2 className="text-xl font-bold text-gray-800 mb-2">Sem pedidos recentes</h2>
          <Link to="/" className="bg-orange-600 text-white px-6 py-2 rounded-xl font-bold hover:bg-orange-700 transition-colors inline-block mt-4">
            Ver Cardápio
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {orders.map(order => {
            // CORREÇÃO: Usa os nomes do Banco de Dados (snake_case)
            const rawStatus = order.status ? order.status.toUpperCase() : 'UNKNOWN';
            const StatusInfo = statusConfig[rawStatus] || statusConfig.UNKNOWN;
            const isExpanded = expandedOrder === order.id;

            // CORREÇÃO: Data e Preço Total
            const orderDate = order.created_at ? new Date(order.created_at) : new Date();
            const orderTotal = Number(order.total_price || 0);
            const deliveryFee = Number(order.delivery_fee || 0);

            // Tradução do Pagamento
            const paymentMethod = paymentMap[order.payment_method] || order.payment_method || 'Não informado';

            return (
              <div key={order.id} className="bg-white border border-gray-100 rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-all duration-300">
                <div 
                  onClick={() => setExpandedOrder(isExpanded ? null : order.id)}
                  className="p-5 flex items-center justify-between cursor-pointer bg-gray-50/30 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <div className={`p-3 rounded-full border ${StatusInfo.color}`}>
                      <StatusInfo.icon size={22} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                         <p className="font-bold text-gray-800 text-lg">Pedido #{order.id}</p>
                         <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide border ${StatusInfo.color}`}>
                           {StatusInfo.label}
                         </span>
                      </div>
                      <p className="text-sm text-gray-500 mt-1">
                        {orderDate.toLocaleDateString('pt-BR')} • {orderDate.toLocaleTimeString('pt-BR', {hour: '2-digit', minute:'2-digit'})}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-gray-900 text-lg">
                      {orderTotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                    </p>
                    {isExpanded ? <ChevronUp className="ml-auto text-gray-400 mt-1" /> : <ChevronDown className="ml-auto text-gray-400 mt-1" />}
                  </div>
                </div>

                {isExpanded && (
                  <div className="p-5 border-t border-gray-100 bg-white animate-in slide-in-from-top-1">
                    
                    {/* Lista de Itens */}
                    <h4 className="text-xs font-bold text-gray-400 uppercase mb-3 tracking-wider">Itens do Pedido</h4>
                    <ul className="space-y-3 mb-6">
                      {order.items?.map((item: any) => {
                        // CORREÇÃO: Pega o preço de dentro do produto, pois OrderItem não tem price salvo
                        const itemPrice = Number(item.product?.price || 0);
                        const itemTotal = itemPrice * Number(item.quantity);

                        return (
                          <li key={item.id} className="flex justify-between text-sm items-start border-b border-gray-50 last:border-0 pb-2">
                            <div className="text-gray-700">
                              <span className="font-bold text-gray-900 mr-2">{item.quantity}x</span> 
                              {item.product?.name}
                              {item.observation && <p className="text-xs text-gray-400 mt-0.5 italic">Obs: {item.observation}</p>}
                            </div>
                            <span className="text-gray-500 font-medium ml-4">
                              {itemTotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                            </span>
                          </li>
                        );
                      })}
                    </ul>

                    {/* Endereço de Entrega (Se houver) */}
                    {order.type === 'DELIVERY' && order.address && (
                      <div className="mb-4 bg-orange-50 p-3 rounded-lg border border-orange-100">
                        <div className="flex items-start gap-3">
                          <MapPin size={18} className="text-orange-600 mt-0.5" />
                          <div>
                            <p className="text-xs font-bold text-orange-800 uppercase mb-1">Entregar em:</p>
                            <p className="text-sm text-gray-700 font-medium">
                              {order.address.street}, {order.address.number}
                            </p>
                            <p className="text-xs text-gray-500">
                              {order.address.neighborhood} - {order.address.city}/{order.address.state}
                            </p>
                            {order.address.complement && <p className="text-xs text-gray-400 italic">Comp: {order.address.complement}</p>}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Resumo Financeiro */}
                    <div className="bg-gray-50 p-4 rounded-lg space-y-2">
                      <div className="flex justify-between text-sm">
                         <span className="text-gray-500">Subtotal</span>
                         <span className="font-medium text-gray-700">
                            {(orderTotal - deliveryFee).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                         </span>
                      </div>
                      
                      {order.type === 'DELIVERY' && (
                        <div className="flex justify-between text-sm">
                           <span className="text-gray-500 flex items-center gap-1"><Truck size={14}/> Taxa de Entrega</span>
                           <span className="font-medium text-red-600">
                              + {deliveryFee.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                           </span>
                        </div>
                      )}

                      <div className="border-t border-gray-200 pt-2 flex justify-between items-center mt-2">
                        <div className="flex items-center gap-2">
                          <DollarSign size={16} className="text-green-600" />
                          <span className="text-sm font-bold text-gray-700">{paymentMethod}</span>
                        </div>
                        <span className="text-lg font-bold text-gray-900">
                          {orderTotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                        </span>
                      </div>
                    </div>

                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}