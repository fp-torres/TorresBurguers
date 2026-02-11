import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { 
  Clock, Package, Truck, CheckCircle, XCircle, 
  MapPin, ShoppingBag, ChevronDown, ChevronUp, LayoutDashboard, ShieldAlert 
} from 'lucide-react';
import { orderService, type Order } from '../../../services/orderService';
import { useAuth } from '../../../contexts/AuthContext';
import ConfirmModal from '../../../components/ConfirmModal'; // Import do Modal
import toast from 'react-hot-toast'; // Import do Toast
import api from '../../../services/api'; // Import da API para chamar o cancelamento

export default function ClientOrders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedOrderId, setExpandedOrderId] = useState<number | null>(null);
  
  // Estados para o Modal de Cancelamento
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [orderToCancel, setOrderToCancel] = useState<number | null>(null);

  const { isAuthenticated, user } = useAuth();

  // --- BLOQUEIO VISUAL PARA EQUIPE ---
  if (user?.role === 'ADMIN' || user?.role === 'EMPLOYEE') {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center space-y-6 animate-in fade-in">
        <div className="bg-red-50 p-6 rounded-full text-red-500 border border-red-100">
          <ShieldAlert size={48} />
        </div>
        <div className="max-w-md px-4">
          <h2 className="text-xl font-bold text-gray-800">Modo Equipe</h2>
          <p className="text-gray-500 mt-2">
            Você é da equipe! Para gerenciar os pedidos da loja, utilize o Painel Administrativo.
          </p>
        </div>
        <Link 
          to="/dashboard" 
          className="bg-gray-800 text-white px-6 py-3 rounded-xl font-bold hover:bg-gray-900 transition-colors flex items-center gap-2"
        >
          <LayoutDashboard size={18} />
          Ir para o Painel
        </Link>
      </div>
    );
  }

  useEffect(() => {
    if (isAuthenticated) {
      loadOrders();
      const interval = setInterval(loadOrders, 10000); 
      return () => clearInterval(interval);
    }
  }, [isAuthenticated]);

  async function loadOrders() {
    try {
      const data = await orderService.getMyOrders();
      setOrders(data.sort((a, b) => b.id - a.id));
    } catch (error) {
      console.error("Erro ao carregar histórico", error);
    } finally {
      setLoading(false);
    }
  }

  // --- LÓGICA DE CANCELAMENTO ---
  function handleRequestCancel(e: React.MouseEvent, id: number) {
    e.stopPropagation(); // Evita abrir/fechar o card ao clicar no botão
    setOrderToCancel(id);
    setCancelModalOpen(true);
  }

  async function executeCancel() {
    if (!orderToCancel) return;
    try {
      // Chama a rota específica do cliente que criamos no backend
      await api.patch(`/orders/${orderToCancel}/cancel`);
      
      toast.success('Pedido cancelado com sucesso.');
      loadOrders(); // Atualiza a lista
    } catch (error) {
      toast.error('Não foi possível cancelar o pedido.');
    }
  }

  const statusMap: Record<string, { label: string, color: string, icon: any }> = {
    'PENDING': { label: 'Aguardando Confirmação', color: 'text-yellow-600 bg-yellow-50 border-yellow-200', icon: Clock },
    'PREPARING': { label: 'Preparando', color: 'text-blue-600 bg-blue-50 border-blue-200', icon: Package },
    'DELIVERING': { label: 'Em Rota', color: 'text-orange-600 bg-orange-50 border-orange-200', icon: Truck },
    'DONE': { label: 'Entregue', color: 'text-green-600 bg-green-50 border-green-200', icon: CheckCircle },
    'FINISHED': { label: 'Entregue', color: 'text-green-600 bg-green-50 border-green-200', icon: CheckCircle },
    'CANCELED': { label: 'Cancelado', color: 'text-red-600 bg-red-50 border-red-200', icon: XCircle },
  };

  if (loading) return <div className="p-10 text-center text-gray-500">Carregando seus pedidos...</div>;

  if (orders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center space-y-4 animate-in fade-in">
        <div className="bg-gray-100 p-6 rounded-full text-gray-400"><ShoppingBag size={48} /></div>
        <h2 className="text-xl font-bold text-gray-800">Nenhum pedido ainda</h2>
        <Link to="/" className="bg-orange-600 text-white px-6 py-2 rounded-xl font-bold hover:bg-orange-700 transition-colors">
          Fazer Pedido
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
          
          return (
            <div key={order.id} className="bg-white border border-gray-100 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-all">
              
              {/* CARD HEADER (Clicável) */}
              <div 
                onClick={() => setExpandedOrderId(isExpanded ? null : order.id)} 
                className="p-4 cursor-pointer flex justify-between items-center"
              >
                <div className="flex items-center gap-4">
                  <div className={`p-3 rounded-full border ${Status.color}`}><Status.icon size={20} /></div>
                  <div>
                    <p className="font-bold text-gray-800 text-lg">Pedido #{order.id}</p>
                    <span className={`text-xs font-bold mt-1 inline-block px-2 py-0.5 rounded ${Status.color.replace('border-', '')}`}>
                      {Status.label}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-bold text-gray-800">{Number(order.total_price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</p>
                  {isExpanded ? <ChevronUp size={18} className="text-gray-400 ml-auto"/> : <ChevronDown size={18} className="text-gray-400 ml-auto"/>}
                </div>
              </div>

              {/* DETALHES (Expansível) */}
              {isExpanded && (
                <div className="bg-gray-50 p-4 border-t border-gray-100 space-y-4 animate-in slide-in-from-top-2">
                  
                  {/* Lista de Itens */}
                  <div className="space-y-2">
                    {order.items.map(item => (
                       <div key={item.id} className="text-sm text-gray-700 flex justify-between">
                         <div>
                           <span className="font-bold mr-2">{item.quantity}x</span> 
                           {item.product?.name || 'Item Removido'}
                           {item.addons?.length > 0 && (
                             <span className="text-xs text-gray-500 ml-2">
                               (+ {item.addons.map(a => a.name).join(', ')})
                             </span>
                           )}
                         </div>
                       </div>
                    ))}
                  </div>

                  {/* Infos Adicionais */}
                  <div className="pt-3 border-t border-gray-200 text-sm flex justify-between items-center">
                     <div>
                        <span className="text-gray-500 block text-xs">Pagamento</span>
                        <span className="font-bold text-gray-700">
                          {order.payment_method === 'CREDIT_CARD' ? 'Cartão' : order.payment_method}
                        </span>
                     </div>
                     
                     {/* BOTÃO CANCELAR (Só aparece se PENDING) */}
                     {order.status === 'PENDING' && (
                       <button 
                         onClick={(e) => handleRequestCancel(e, order.id)}
                         className="text-red-500 text-xs font-bold hover:text-red-700 hover:bg-red-50 px-3 py-1.5 rounded-lg transition-colors border border-red-100"
                       >
                         Cancelar Pedido
                       </button>
                     )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Modal de Confirmação */}
      <ConfirmModal 
        isOpen={cancelModalOpen}
        onClose={() => setCancelModalOpen(false)}
        onConfirm={executeCancel}
        title="Cancelar Pedido?"
        message="Tem certeza que deseja cancelar? O pedido será removido da fila de produção."
        confirmLabel="Sim, Cancelar"
        isDestructive
      />
    </div>
  );
}