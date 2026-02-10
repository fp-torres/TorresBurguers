import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { 
  Clock, Package, Truck, CheckCircle, XCircle, 
  MapPin, ShoppingBag, ChevronDown, ChevronUp 
} from 'lucide-react';
import { orderService, type Order } from '../../../services/orderService';
import { useAuth } from '../../../contexts/AuthContext';

export default function ClientOrders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedOrderId, setExpandedOrderId] = useState<number | null>(null);
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    if (isAuthenticated) {
      loadOrders();
      const interval = setInterval(loadOrders, 10000); // Atualiza a cada 10s
      return () => clearInterval(interval);
    }
  }, [isAuthenticated]);

  async function loadOrders() {
    try {
      const data = await orderService.getAll();
      // Ordena do mais recente para o mais antigo
      setOrders(data.sort((a, b) => b.id - a.id));
    } catch (error) {
      console.error("Erro ao carregar histórico", error);
    } finally {
      setLoading(false);
    }
  }

  // Mapa de Status (Backend -> Frontend Visual)
  const statusMap: Record<string, { label: string, color: string, icon: any }> = {
    'PENDING': { label: 'Aguardando Confirmação', color: 'text-yellow-600 bg-yellow-50 border-yellow-200', icon: Clock },
    'PREPARING': { label: 'Preparando seu Pedido', color: 'text-blue-600 bg-blue-50 border-blue-200', icon: Package },
    'DELIVERING': { label: 'Saiu para Entrega', color: 'text-orange-600 bg-orange-50 border-orange-200', icon: Truck },
    'DONE': { label: 'Pedido Entregue', color: 'text-green-600 bg-green-50 border-green-200', icon: CheckCircle },
    'FINISHED': { label: 'Pedido Entregue', color: 'text-green-600 bg-green-50 border-green-200', icon: CheckCircle },
    'CANCELED': { label: 'Cancelado', color: 'text-red-600 bg-red-50 border-red-200', icon: XCircle },
  };

  if (loading) return <div className="p-10 text-center text-gray-500">Carregando seus pedidos...</div>;

  if (orders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
        <div className="bg-gray-100 p-6 rounded-full text-gray-400"><ShoppingBag size={48} /></div>
        <h2 className="text-xl font-bold text-gray-800">Nenhum pedido ainda</h2>
        <p className="text-gray-500">Faça seu primeiro pedido agora mesmo!</p>
        <Link to="/" className="bg-orange-600 text-white px-6 py-2 rounded-xl font-bold hover:bg-orange-700 transition-colors">
          Ver Cardápio
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-20">
      <h1 className="text-2xl font-bold text-gray-800">Meus Pedidos</h1>

      <div className="space-y-4">
        {orders.map(order => {
          const Status = statusMap[order.status] || statusMap['PENDING'];
          const isExpanded = expandedOrderId === order.id;
          const isDelivery = order.type === 'DELIVERY';

          return (
            <div key={order.id} className="bg-white border border-gray-100 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-all">
              
              {/* Resumo do Card (Sempre Visível) */}
              <div 
                onClick={() => setExpandedOrderId(isExpanded ? null : order.id)}
                className="p-4 cursor-pointer flex justify-between items-center"
              >
                <div className="flex items-center gap-4">
                  <div className={`p-3 rounded-full border ${Status.color}`}>
                    <Status.icon size={20} />
                  </div>
                  <div>
                    <p className="font-bold text-gray-800 text-lg">Pedido #{order.id}</p>
                    <p className="text-xs text-gray-500">
                      {new Date(order.created_at).toLocaleDateString('pt-BR')} às {new Date(order.created_at).toLocaleTimeString().slice(0,5)}
                    </p>
                    <span className={`text-xs font-bold mt-1 inline-block px-2 py-0.5 rounded ${Status.color.replace('border-', '')}`}>
                      {Status.label}
                    </span>
                  </div>
                </div>
                
                <div className="text-right">
                  <p className="font-bold text-gray-800">{Number(order.total_price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</p>
                  {isExpanded ? <ChevronUp size={18} className="ml-auto text-gray-400"/> : <ChevronDown size={18} className="ml-auto text-gray-400"/>}
                </div>
              </div>

              {/* Detalhes (Expansível) */}
              {isExpanded && (
                <div className="bg-gray-50 p-4 border-t border-gray-100 space-y-4 animate-in slide-in-from-top-2">
                  
                  {/* Lista de Itens */}
                  <div className="space-y-2">
                    <p className="text-xs font-bold text-gray-500 uppercase">Itens</p>
                    {order.items.map(item => (
                      <div key={item.id} className="flex justify-between text-sm">
                        <div className="text-gray-700">
                          <span className="font-bold mr-2">{item.quantity}x</span>
                          {/* BLINDAGEM: Evita crash se produto foi deletado */}
                          {item.product?.name || <span className="italic text-gray-400">Item indisponível</span>}
                          
                          {/* Adicionais */}
                          {item.addons?.length > 0 && (
                            <div className="ml-6 text-xs text-gray-500">
                              + {item.addons.map(a => a.name).join(', ')}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Endereço ou Retirada */}
                  <div className="pt-2 border-t border-gray-200">
                    {isDelivery ? (
                      <div className="flex items-start gap-2 text-sm text-gray-600">
                        <MapPin size={16} className="mt-0.5 text-orange-600" />
                        <div>
                          <p className="font-bold text-gray-800">Entrega em:</p>
                          <p>{order.address?.street}, {order.address?.number}</p>
                          <p className="text-xs">{order.address?.neighborhood} - {order.address?.city}</p>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-sm text-blue-600 font-bold bg-blue-50 p-2 rounded-lg w-fit">
                        <Package size={16} /> Retirada na Loja
                      </div>
                    )}
                  </div>

                  {/* Pagamento */}
                  <div className="pt-2 border-t border-gray-200 flex justify-between text-sm">
                    <span className="text-gray-500">Pagamento:</span>
                    <span className="font-bold text-gray-700">
                      {order.payment_method === 'CREDIT_CARD' ? 'Cartão de Crédito' : 
                       order.payment_method === 'PIX' ? 'PIX' : 
                       order.payment_method === 'MONEY' ? 'Dinheiro' : order.payment_method}
                    </span>
                  </div>

                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}