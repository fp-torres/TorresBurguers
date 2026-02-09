import { useEffect, useState } from 'react';
import { RefreshCcw, Clock, Truck, CheckCircle, ChefHat, MapPin, Receipt } from 'lucide-react';
// Agora este import vai funcionar:
import { orderService, type Order } from '../../services/orderService';

export default function Orders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  // Carrega pedidos ao abrir e a cada 30s
  useEffect(() => {
    loadOrders();
    const interval = setInterval(loadOrders, 30000);
    return () => clearInterval(interval);
  }, []);

  async function loadOrders() {
    setLoading(true);
    try {
      const data = await orderService.getAll();
      setOrders(data);
    } catch (error) {
      console.error("Erro ao buscar pedidos", error);
    } finally {
      setLoading(false);
    }
  }

  async function handleStatusChange(id: number, newStatus: Order['status']) {
    try {
      // Atualização Otimista
      setOrders(prev => prev.map(order => 
        order.id === id ? { ...order, status: newStatus } : order
      ));

      await orderService.updateStatus(id, newStatus);
      loadOrders(); 
    } catch (error) {
      alert('Erro ao atualizar status.');
      loadOrders();
    }
  }

  // --- Card do Pedido ---
  const OrderCard = ({ order }: { order: Order }) => (
    <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 hover:shadow-md transition-all mb-3 flex flex-col gap-3 animate-in fade-in duration-300">
      
      <div className="flex justify-between items-start">
        <span className="bg-gray-100 text-gray-600 px-2 py-1 rounded-md text-xs font-bold">
          #{order.id}
        </span>
        <div className="text-right">
          <span className="text-xs text-gray-400 font-medium block">
            {new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </div>

      <div>
        <p className="font-bold text-gray-800 text-sm">{order.user?.name || 'Cliente'}</p>
        <div className="flex items-center gap-1 text-xs text-gray-500 mt-1">
          {order.address ? (
            <>
              <MapPin size={12} className="text-orange-500" />
              <span className="truncate max-w-[180px]">
                {order.address.street}, {order.address.number}
              </span>
            </>
          ) : (
            <>
              <Receipt size={12} className="text-blue-500" />
              <span>Retirada no Balcão</span>
            </>
          )}
        </div>
      </div>

      <div className="border-t border-dashed border-gray-100 pt-2 space-y-2">
        {order.items.map((item) => (
          <div key={item.id} className="text-xs text-gray-600">
            <div className="flex justify-between font-medium">
              <span>{item.quantity}x {item.product.name}</span>
            </div>
            {item.addons?.length > 0 && (
              <p className="text-[10px] text-gray-400 pl-4">
                + {item.addons.map(a => a.name).join(', ')}
              </p>
            )}
            {item.observation && (
              <p className="text-[10px] text-orange-600 pl-4 italic">
                "Obs: {item.observation}"
              </p>
            )}
          </div>
        ))}
      </div>

      <div className="flex justify-between items-center pt-2 mt-1 border-t border-gray-100">
        <span className="font-bold text-gray-800 text-sm">
          {Number(order.total_price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
        </span>
        
        {order.status === 'PENDING' && (
          <button onClick={() => handleStatusChange(order.id, 'PREPARING')} className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-blue-700 transition-colors">Aceitar</button>
        )}
        {order.status === 'PREPARING' && (
          <button onClick={() => handleStatusChange(order.id, 'DELIVERING')} className="bg-orange-500 text-white px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-orange-600 transition-colors">Despachar</button>
        )}
        {order.status === 'DELIVERING' && (
          <button onClick={() => handleStatusChange(order.id, 'FINISHED')} className="bg-green-600 text-white px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-green-700 transition-colors">Concluir</button>
        )}
        {order.status === 'FINISHED' && (
          <span className="text-xs font-bold text-green-600 flex items-center gap-1"><CheckCircle size={14} /> Entregue</span>
        )}
      </div>
    </div>
  );

  return (
    <div className="h-full flex flex-col space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Gerenciador de Pedidos</h1>
          <p className="text-gray-500">Acompanhe o fluxo da cozinha em tempo real</p>
        </div>
        <button onClick={loadOrders} className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
          <RefreshCcw size={20} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="flex-1 overflow-x-auto pb-4">
        <div className="flex gap-6 min-w-[1100px] h-full">
          
          {/* Colunas */}
          {[
            { id: 'PENDING', label: 'Pendentes', icon: <Clock size={20} />, color: 'blue' },
            { id: 'PREPARING', label: 'Na Cozinha', icon: <ChefHat size={20} />, color: 'orange' },
            { id: 'DELIVERING', label: 'Saiu p/ Entrega', icon: <Truck size={20} />, color: 'indigo' },
            { id: 'FINISHED', label: 'Concluídos', icon: <CheckCircle size={20} />, color: 'green' }
          ].map(col => (
            <div key={col.id} className={`flex-1 bg-gray-50 rounded-xl p-4 flex flex-col border border-gray-100 ${col.id === 'FINISHED' ? 'opacity-80' : ''}`}>
              <div className={`flex items-center gap-2 mb-4 text-${col.color}-700 font-bold border-b border-${col.color}-200 pb-3`}>
                {col.icon}
                <h2>{col.label}</h2>
                <span className={`bg-${col.color}-100 text-${col.color}-800 px-2 py-0.5 rounded-full text-xs ml-auto border border-${col.color}-200`}>
                  {orders.filter(o => o.status === col.id).length}
                </span>
              </div>
              <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                {orders.filter(o => o.status === col.id).map(order => (
                  <OrderCard key={order.id} order={order} />
                ))}
              </div>
            </div>
          ))}

        </div>
      </div>
    </div>
  );
}