import { useEffect, useState } from 'react';
import { 
  Clock, CheckCircle, Truck, Package, XCircle, 
  MapPin, User, ChevronRight, Phone, AlertCircle 
} from 'lucide-react';
import { orderService, type Order } from '../../services/orderService';

export default function Orders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadOrders();
    const interval = setInterval(loadOrders, 10000); 
    return () => clearInterval(interval);
  }, []);

  async function loadOrders() {
    try {
      const data = await orderService.getAll();
      setOrders(data.sort((a, b) => b.id - a.id));
    } catch (error) {
      console.error("Erro ao carregar pedidos", error);
    } finally {
      setLoading(false);
    }
  }

  async function updateStatus(id: number, newStatus: string) {
    try {
      setOrders(prev => prev.map(o => o.id === id ? { ...o, status: newStatus as any } : o));
      await orderService.updateStatus(id, newStatus);
      loadOrders();
    } catch (error) {
      alert('Erro ao atualizar status.');
      loadOrders(); 
    }
  }

  const OrderCard = ({ order }: { order: Order }) => {
    const isDelivery = order.type === 'DELIVERY';
    
    return (
      <div className="bg-white border border-gray-100 rounded-xl p-4 shadow-sm hover:shadow-md transition-all">
        {/* Cabeçalho */}
        <div className="flex justify-between items-start mb-3">
          <div>
            <h3 className="font-bold text-gray-800 text-lg">#{order.id}</h3>
            <p className="text-xs text-gray-500 font-medium">{new Date(order.created_at).toLocaleTimeString().slice(0, 5)}</p>
          </div>
          <span className={`px-2 py-1 rounded text-xs font-bold ${
            order.status === 'PENDING' ? 'bg-yellow-100 text-yellow-700' :
            order.status === 'PREPARING' ? 'bg-blue-100 text-blue-700' :
            order.status === 'DELIVERING' ? 'bg-orange-100 text-orange-700' :
            'bg-green-100 text-green-700'
          }`}>
            {order.status === 'PENDING' ? 'Pendente' :
             order.status === 'PREPARING' ? 'Preparando' :
             order.status === 'DELIVERING' ? 'Em Rota' : 'Concluído'}
          </span>
        </div>

        {/* Cliente - CORREÇÃO DE CRASH AQUI */}
        <div className="mb-3">
          <div className="flex items-center gap-2 text-sm font-bold text-gray-700">
            <User size={14} /> {order.user?.name || 'Cliente Desconhecido'}
          </div>
          {isDelivery && order.address ? (
            <div className="flex items-start gap-2 text-xs text-gray-500 mt-1">
              <MapPin size={12} className="mt-0.5 shrink-0" />
              <p>{order.address.street}, {order.address.number} - {order.address.neighborhood}</p>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded mt-1 w-fit">
              <Package size={12} /> Retirada no Balcão
            </div>
          )}
        </div>

        {/* Itens - CORREÇÃO DE CRASH AQUI TAMBÉM */}
        <div className="space-y-1 mb-4 border-t border-gray-50 pt-2">
          {order.items.map(item => (
            <div key={item.id} className="text-sm text-gray-600">
              <span className="font-bold text-gray-900">{item.quantity}x</span> 
              {/* Usa optional chaining (?.) para evitar erro se product for null */}
              {' '}{item.product?.name || 'Item Removido'}
              
              {item.observation && <span className="block text-xs text-red-400 italic ml-5">Obs: {item.observation}</span>}
              {item.addons?.map((addon, idx) => (
                <span key={idx} className="block text-xs text-green-600 ml-5">+ {addon.name}</span>
              ))}
            </div>
          ))}
        </div>

        {/* Total */}
        <div className="flex justify-between items-center text-sm font-bold text-gray-800 border-t border-gray-100 pt-3 mb-4">
          <span>Total:</span>
          <span>{Number(order.total_price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</span>
        </div>

        {/* Ações (Botões) */}
        <div className="grid grid-cols-1 gap-2">
          {order.status === 'PENDING' && (
            <button 
              onClick={() => updateStatus(order.id, 'PREPARING')}
              className="bg-blue-600 text-white py-2 rounded-lg text-sm font-bold hover:bg-blue-700 transition-colors flex justify-center items-center gap-2"
            >
              <Package size={16} /> Iniciar Preparo
            </button>
          )}

          {order.status === 'PREPARING' && (
            <button 
              onClick={() => updateStatus(order.id, isDelivery ? 'DELIVERING' : 'DONE')}
              className="bg-orange-600 text-white py-2 rounded-lg text-sm font-bold hover:bg-orange-700 transition-colors flex justify-center items-center gap-2"
            >
              {isDelivery ? <><Truck size={16} /> Saiu para Entrega</> : <><CheckCircle size={16} /> Pronto para Retirada</>}
            </button>
          )}

          {order.status === 'DELIVERING' && (
            <button 
              onClick={() => updateStatus(order.id, 'DONE')}
              className="bg-green-600 text-white py-2 rounded-lg text-sm font-bold hover:bg-green-700 transition-colors flex justify-center items-center gap-2"
            >
              <CheckCircle size={16} /> Concluir Entrega
            </button>
          )}
          
          {order.status !== 'DONE' && order.status !== 'CANCELED' && (
             <button 
               onClick={() => { if(confirm('Cancelar pedido?')) updateStatus(order.id, 'CANCELED') }}
               className="text-red-500 text-xs hover:text-red-700 hover:underline text-center mt-1"
             >
               Cancelar Pedido
             </button>
          )}
        </div>
      </div>
    );
  };

  const pendingOrders = orders.filter(o => o.status === 'PENDING');
  const activeOrders = orders.filter(o => o.status === 'PREPARING' || o.status === 'DELIVERING');
  const doneOrders = orders.filter(o => o.status === 'DONE').slice(0, 5);

  return (
    <div className="space-y-6 pb-20">
      <div className="flex justify-between items-center bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Gerenciador de Pedidos</h1>
          <p className="text-gray-500">Acompanhe o fluxo da cozinha em tempo real</p>
        </div>
        <button onClick={loadOrders} className="p-2 hover:bg-gray-100 rounded-full text-gray-500"><Clock size={20}/></button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 overflow-x-auto pb-4">
        {/* Coluna 1: Pendentes */}
        <div className="space-y-4 min-w-[300px]">
          <div className="flex items-center justify-between text-orange-800 bg-orange-50 p-3 rounded-lg border border-orange-100">
            <h2 className="font-bold flex items-center gap-2"><AlertCircle size={18}/> Novos</h2>
            <span className="bg-white px-2 py-0.5 rounded-md text-xs font-bold shadow-sm">{pendingOrders.length}</span>
          </div>
          {pendingOrders.map(order => <OrderCard key={order.id} order={order} />)}
          {pendingOrders.length === 0 && <p className="text-center text-sm text-gray-400 py-8">Nenhum pedido novo</p>}
        </div>

        {/* Coluna 2: Em Andamento */}
        <div className="space-y-4 min-w-[300px]">
          <div className="flex items-center justify-between text-blue-800 bg-blue-50 p-3 rounded-lg border border-blue-100">
            <h2 className="font-bold flex items-center gap-2"><Clock size={18}/> Na Cozinha / Entrega</h2>
            <span className="bg-white px-2 py-0.5 rounded-md text-xs font-bold shadow-sm">{activeOrders.length}</span>
          </div>
          {activeOrders.map(order => <OrderCard key={order.id} order={order} />)}
          {activeOrders.length === 0 && <p className="text-center text-sm text-gray-400 py-8">Cozinha livre</p>}
        </div>

        {/* Coluna 3: Concluídos */}
        <div className="space-y-4 min-w-[300px]">
          <div className="flex items-center justify-between text-green-800 bg-green-50 p-3 rounded-lg border border-green-100">
            <h2 className="font-bold flex items-center gap-2"><CheckCircle size={18}/> Concluídos (Recentes)</h2>
            <span className="bg-white px-2 py-0.5 rounded-md text-xs font-bold shadow-sm">{doneOrders.length}</span>
          </div>
          {doneOrders.map(order => (
            <div key={order.id} className="bg-gray-50 border border-gray-100 rounded-xl p-4 opacity-75">
              <div className="flex justify-between">
                <span className="font-bold text-gray-600">#{order.id}</span>
                <span className="text-xs text-green-600 font-bold bg-green-100 px-2 py-0.5 rounded">Entregue</span>
              </div>
              {/* CORREÇÃO AQUI TAMBÉM */}
              <p className="text-sm text-gray-500 mt-1">{order.user?.name || 'Cliente'}</p>
              <p className="text-sm font-bold text-gray-700 mt-2">{Number(order.total_price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}