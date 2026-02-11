import { useEffect, useState } from 'react';
import { Clock, CheckCircle, Truck, Package, XCircle, MapPin, User, AlertCircle, ChefHat, Bike } from 'lucide-react';
import { orderService, type Order } from '../../services/orderService';
import ConfirmModal from '../../components/ConfirmModal';
import toast from 'react-hot-toast';

export default function Orders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Estado para Modal de Cancelamento
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [orderToCancel, setOrderToCancel] = useState<number | null>(null);

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
      console.error("Erro", error);
    } finally {
      setLoading(false);
    }
  }

  async function updateStatus(id: number, newStatus: string) {
    try {
      setOrders(prev => prev.map(o => o.id === id ? { ...o, status: newStatus as any } : o));
      await orderService.updateStatus(id, newStatus);
      
      const msgMap: any = { 
        'PREPARING': 'Pedido enviado para cozinha!', 
        'DELIVERING': 'Pedido saiu para entrega!', 
        'DONE': 'Pedido finalizado com sucesso!',
        'CANCELED': 'Pedido cancelado.'
      };
      toast.success(msgMap[newStatus] || 'Status atualizado');
      
      loadOrders();
    } catch (error) {
      toast.error('Erro ao atualizar status.');
      loadOrders(); 
    }
  }

  function handleRequestCancel(id: number) {
    setOrderToCancel(id);
    setCancelModalOpen(true);
  }

  async function executeCancel() {
    if (orderToCancel) {
      await updateStatus(orderToCancel, 'CANCELED');
    }
  }

  const OrderCard = ({ order }: { order: Order }) => {
    const isDelivery = order.type === 'DELIVERY';
    
    return (
      <div className="bg-white border border-gray-100 rounded-xl p-4 shadow-sm hover:shadow-md transition-all flex flex-col gap-3 min-w-[280px]">
        {/* Header do Card */}
        <div className="flex justify-between items-start">
          <div>
            <h3 className="font-bold text-gray-800 text-lg">#{order.id}</h3>
            <p className="text-xs text-gray-500 font-medium">{new Date(order.created_at).toLocaleTimeString().slice(0, 5)}</p>
          </div>
          <span className={`px-2 py-1 rounded text-xs font-bold ${
            order.status === 'PENDING' ? 'bg-yellow-100 text-yellow-700' :
            order.status === 'PREPARING' ? 'bg-blue-100 text-blue-700' :
            order.status === 'DELIVERING' ? 'bg-orange-100 text-orange-700' : 
            order.status === 'DONE' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
          }`}>
            {order.status === 'PENDING' ? 'Pendente' :
             order.status === 'PREPARING' ? 'Preparando' :
             order.status === 'DELIVERING' ? 'Em Rota' : 
             order.status === 'DONE' ? 'Concluído' : 'Cancelado'}
          </span>
        </div>

        {/* Cliente */}
        <div className="text-sm border-b border-gray-50 pb-3">
          <div className="flex items-center gap-2 font-bold text-gray-700">
            <User size={14} /> {order.user?.name || 'Cliente'}
          </div>
          {isDelivery && order.address ? (
             <div className="flex items-start gap-2 text-xs text-gray-500 mt-1">
               <MapPin size={12} className="mt-0.5 shrink-0"/> 
               <span className="line-clamp-1">{order.address.street}, {order.address.number}</span>
             </div>
          ) : (
             <div className="text-xs text-blue-600 mt-1 font-bold bg-blue-50 px-2 py-0.5 rounded w-fit">Retirada no Balcão</div>
          )}
        </div>

        {/* Itens */}
        <div className="space-y-1 text-sm text-gray-600 flex-1">
          {order.items.map(item => (
            <div key={item.id} className="flex justify-between">
              <span className="truncate pr-2"><span className="font-bold">{item.quantity}x</span> {item.product?.name}</span>
            </div>
          ))}
        </div>

        {/* Botões de Ação */}
        <div className="grid grid-cols-1 gap-2 pt-3 border-t border-gray-100">
          {order.status === 'PENDING' && (
            <button onClick={() => updateStatus(order.id, 'PREPARING')} className="bg-blue-600 text-white py-2 rounded-lg text-sm font-bold flex justify-center items-center gap-2 hover:bg-blue-700 shadow-blue-100 shadow-lg">
              <ChefHat size={16}/> Iniciar Preparo
            </button>
          )}
          {order.status === 'PREPARING' && (
            <button onClick={() => updateStatus(order.id, isDelivery ? 'DELIVERING' : 'DONE')} className="bg-orange-600 text-white py-2 rounded-lg text-sm font-bold flex justify-center items-center gap-2 hover:bg-orange-700 shadow-orange-100 shadow-lg">
              {isDelivery ? <><Bike size={16}/> Entregar</> : <><CheckCircle size={16}/> Pronto</>}
            </button>
          )}
          {order.status === 'DELIVERING' && (
            <button onClick={() => updateStatus(order.id, 'DONE')} className="bg-green-600 text-white py-2 rounded-lg text-sm font-bold flex justify-center items-center gap-2 hover:bg-green-700 shadow-green-100 shadow-lg">
              <CheckCircle size={16}/> Finalizar
            </button>
          )}
          
          {order.status !== 'DONE' && order.status !== 'CANCELED' && (
             <button 
               onClick={() => handleRequestCancel(order.id)} 
               className="text-red-500 text-xs hover:underline text-center mt-1 font-bold"
             >
               Cancelar Pedido
             </button>
          )}
        </div>
      </div>
    );
  };

  // Filtros
  const pendingOrders = orders.filter(o => o.status === 'PENDING');
  const preparingOrders = orders.filter(o => o.status === 'PREPARING');
  const deliveringOrders = orders.filter(o => o.status === 'DELIVERING');
  const doneOrders = orders.filter(o => o.status === 'DONE').slice(0, 10); // Mostra os 10 últimos
  const canceledOrders = orders.filter(o => o.status === 'CANCELED').slice(0, 5);

  return (
    <div className="space-y-6 pb-20 h-full flex flex-col">
      <div className="flex justify-between items-center bg-white p-6 rounded-2xl shadow-sm border border-gray-100 shrink-0">
        <h1 className="text-xl sm:text-2xl font-bold text-gray-800">Gerenciador de Pedidos</h1>
        <button onClick={loadOrders} className="p-2 hover:bg-gray-100 rounded-full transition-colors"><Clock size={20}/></button>
      </div>

      {/* Container de Colunas (Scroll Horizontal no Mobile) */}
      <div className="flex-1 overflow-x-auto pb-4 -mx-4 px-4 lg:mx-0 lg:px-0">
        <div className="flex gap-6 min-w-max lg:min-w-0 h-full">
          
          {/* 1. NOVOS */}
          <div className="w-[300px] flex flex-col gap-4">
            <div className="bg-yellow-50 text-yellow-800 p-3 rounded-xl font-bold flex justify-between items-center border border-yellow-100 sticky top-0 z-10 shadow-sm">
               <span className="flex items-center gap-2"><AlertCircle size={18}/> Novos</span>
               <span className="bg-white px-2 py-0.5 rounded-md text-xs shadow-sm">{pendingOrders.length}</span>
            </div>
            <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar">
              {pendingOrders.map(o => <OrderCard key={o.id} order={o}/>)}
              {pendingOrders.length === 0 && <p className="text-center text-sm text-gray-400 py-10 italic">Nenhum pedido novo</p>}
            </div>
          </div>

          {/* 2. EM PREPARO */}
          <div className="w-[300px] flex flex-col gap-4">
            <div className="bg-blue-50 text-blue-800 p-3 rounded-xl font-bold flex justify-between items-center border border-blue-100 sticky top-0 z-10 shadow-sm">
               <span className="flex items-center gap-2"><ChefHat size={18}/> Cozinha</span>
               <span className="bg-white px-2 py-0.5 rounded-md text-xs shadow-sm">{preparingOrders.length}</span>
            </div>
            <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar">
              {preparingOrders.map(o => <OrderCard key={o.id} order={o}/>)}
            </div>
          </div>

          {/* 3. EM ENTREGA (NOVA COLUNA) */}
          <div className="w-[300px] flex flex-col gap-4">
            <div className="bg-orange-50 text-orange-800 p-3 rounded-xl font-bold flex justify-between items-center border border-orange-100 sticky top-0 z-10 shadow-sm">
               <span className="flex items-center gap-2"><Bike size={18}/> Em Entrega</span>
               <span className="bg-white px-2 py-0.5 rounded-md text-xs shadow-sm">{deliveringOrders.length}</span>
            </div>
            <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar">
              {deliveringOrders.map(o => <OrderCard key={o.id} order={o}/>)}
            </div>
          </div>

          {/* 4. CONCLUÍDOS */}
          <div className="w-[300px] flex flex-col gap-4">
            <div className="bg-green-50 text-green-800 p-3 rounded-xl font-bold flex justify-between items-center border border-green-100 sticky top-0 z-10 shadow-sm">
               <span className="flex items-center gap-2"><CheckCircle size={18}/> Concluídos</span>
               <span className="bg-white px-2 py-0.5 rounded-md text-xs shadow-sm">{doneOrders.length}</span>
            </div>
            <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar">
              {doneOrders.map(o => <OrderCard key={o.id} order={o}/>)}
            </div>
          </div>

          {/* 5. CANCELADOS (NOVA COLUNA) */}
          <div className="w-[300px] flex flex-col gap-4 opacity-75">
            <div className="bg-gray-100 text-gray-600 p-3 rounded-xl font-bold flex justify-between items-center border border-gray-200 sticky top-0 z-10 shadow-sm">
               <span className="flex items-center gap-2"><XCircle size={18}/> Cancelados</span>
               <span className="bg-white px-2 py-0.5 rounded-md text-xs shadow-sm">{canceledOrders.length}</span>
            </div>
            <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar">
              {canceledOrders.map(o => <OrderCard key={o.id} order={o}/>)}
            </div>
          </div>

        </div>
      </div>

      <ConfirmModal 
        isOpen={cancelModalOpen}
        onClose={() => setCancelModalOpen(false)}
        onConfirm={executeCancel}
        title="Cancelar Pedido?"
        message="Deseja realmente cancelar este pedido? O cliente será notificado."
        confirmLabel="Sim, Cancelar"
        isDestructive
      />
    </div>
  );
}