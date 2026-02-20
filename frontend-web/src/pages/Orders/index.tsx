import { useEffect, useState } from 'react';
import { 
  Clock, CheckCircle, XCircle, 
  MapPin, User, AlertCircle, ChefHat, Bike, Bell, ExternalLink, Navigation, Banknote, Package 
} from 'lucide-react';
import { orderService, type Order, type OrderItem } from '../../services/orderService';
import ConfirmModal from '../../components/ConfirmModal';
import toast from 'react-hot-toast';
import { currencyToNumber } from '../../utils/masks'; 

export default function Orders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [orderToCancel, setOrderToCancel] = useState<number | null>(null);

  const userStored = localStorage.getItem('torresburgers.user');
  let userRole = 'ADMIN';
  try {
    if (userStored) userRole = JSON.parse(userStored).role;
  } catch {}

  useEffect(() => {
    loadOrders();
    const interval = setInterval(loadOrders, 5000); 
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
        'PREPARING': 'Cozinha notificada! 🔥', 
        'READY_FOR_PICKUP': 'Pedido Liberado! ✅',
        'DELIVERING': 'Boa entrega! 🏍️', 
        'DONE': 'Pedido finalizado! 🎉',
        'CANCELED': 'Cancelado.'
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
      setCancelModalOpen(false);
      setOrderToCancel(null);
    }
  }

  // --- SUB-COMPONENTE: CARD DO PEDIDO (DARK MODE) ---
  const OrderCard = ({ order }: { order: Order }) => {
    const isDelivery = order.type === 'DELIVERY';
    
    const totalOrder = Number(order.total_price);
    let changeForValue = 0;
    
    if (order.change_for) {
       changeForValue = currencyToNumber(order.change_for);
    }
    
    const changeToReturn = changeForValue > 0 ? (changeForValue - totalOrder) : 0;

    const mapsLink = order.address 
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${order.address.street}, ${order.address.number} - ${order.address.neighborhood}, ${order.address.city}`)}`
      : '#';

    const renderActions = () => {
      if (order.status === 'PENDING' && (userRole === 'ADMIN' || userRole === 'KITCHEN')) {
        return (
          <button onClick={() => updateStatus(order.id, 'PREPARING')} className="w-full bg-blue-600 text-white py-2.5 rounded-xl text-sm font-bold flex justify-center items-center gap-2 hover:bg-blue-700 shadow-sm transition-colors">
            <ChefHat size={18}/> Aceitar e Preparar
          </button>
        );
      }
      if (order.status === 'PREPARING' && (userRole === 'ADMIN' || userRole === 'KITCHEN')) {
        return (
          <button onClick={() => updateStatus(order.id, 'READY_FOR_PICKUP')} className="w-full bg-orange-600 text-white py-2.5 rounded-xl text-sm font-bold flex justify-center items-center gap-2 hover:bg-orange-700 shadow-sm transition-colors">
            {isDelivery ? <><Bell size={18}/> Chamar Motoboy</> : <><CheckCircle size={18}/> Pronto (Balcão)</>}
          </button>
        );
      }
      if (order.status === 'READY_FOR_PICKUP') {
        if (isDelivery && (userRole === 'ADMIN' || userRole === 'COURIER')) {
          return (
            <button onClick={() => updateStatus(order.id, 'DELIVERING')} className="w-full bg-indigo-600 text-white py-2.5 rounded-xl text-sm font-bold flex justify-center items-center gap-2 hover:bg-indigo-700 shadow-sm transition-colors animate-pulse">
              <Bike size={18}/> Pegar para Entrega
            </button>
          );
        }
        if (!isDelivery && (userRole === 'ADMIN' || userRole === 'KITCHEN')) {
          return (
            <button onClick={() => updateStatus(order.id, 'DONE')} className="w-full bg-teal-600 text-white py-2.5 rounded-xl text-sm font-bold flex justify-center items-center gap-2 hover:bg-teal-700 shadow-sm transition-colors">
              <CheckCircle size={18}/> Entregue ao Cliente
            </button>
          );
        }
      }
      if (order.status === 'DELIVERING' && (userRole === 'ADMIN' || userRole === 'COURIER')) {
        return (
          <button onClick={() => updateStatus(order.id, 'DONE')} className="w-full bg-green-600 text-white py-2.5 rounded-xl text-sm font-bold flex justify-center items-center gap-2 hover:bg-green-700 shadow-sm transition-colors">
            <CheckCircle size={18}/> Confirmar Entrega
          </button>
        );
      }
      return null;
    };

    return (
      <div className="bg-white dark:bg-slate-800 border border-gray-100 dark:border-slate-700 rounded-2xl p-4 shadow-sm hover:shadow-md transition-all flex flex-col gap-3 min-w-[300px]">
        
        {/* Header */}
        <div className="flex justify-between items-start border-b border-gray-50 dark:border-slate-700 pb-3">
          <div>
            <h3 className="font-bold text-gray-800 dark:text-white text-lg flex items-center gap-2">
              #{order.id} 
              <span className="text-xs font-normal text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-slate-700 px-2 py-0.5 rounded-full border border-gray-100 dark:border-slate-600">
                {new Date(order.created_at).toLocaleTimeString().slice(0, 5)}
              </span>
            </h3>
            <div className="flex items-center gap-1 text-sm font-bold text-gray-600 dark:text-gray-300 mt-1">
              <User size={14} /> {order.user?.name || 'Cliente'}
            </div>
          </div>
          <span className={`px-2 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wide border ${
            order.status === 'PENDING' ? 'bg-yellow-50 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 border-yellow-100 dark:border-yellow-800' :
            order.status === 'PREPARING' ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border-blue-100 dark:border-blue-800' :
            order.status === 'READY_FOR_PICKUP' ? 'bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 border-purple-100 dark:border-purple-800' :
            order.status === 'DELIVERING' ? 'bg-orange-50 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400 border-orange-100 dark:border-orange-800' :
            order.status === 'DONE' ? 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 border-green-100 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 border-red-100 dark:border-red-800'
          }`}>
            {order.status === 'READY_FOR_PICKUP' ? (isDelivery ? 'Aguardando' : 'Balcão') : order.status}
          </span>
        </div>

        {/* Pagamento e Troco */}
        <div className="flex justify-between items-center bg-gray-50 dark:bg-slate-700 p-2 rounded-lg">
           <span className="text-xs font-bold text-gray-500 dark:text-gray-300 uppercase">
             {order.payment_method === 'CREDIT_CARD' ? 'Cartão' : order.payment_method === 'MONEY' ? 'Dinheiro' : order.payment_method}
           </span>
           <span className="font-bold text-gray-900 dark:text-white">
             {Number(order.total_price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
           </span>
        </div>

        {order.payment_method === 'MONEY' && changeForValue > 0 && (userRole === 'ADMIN' || userRole === 'COURIER') && (
          <div className="bg-green-100 dark:bg-green-900/20 border border-green-200 dark:border-green-800 p-3 rounded-xl animate-pulse">
            <div className="flex items-center gap-2 text-green-800 dark:text-green-300 font-bold text-sm mb-1">
              <Banknote size={18}/> ATENÇÃO: TROCO
            </div>
            <div className="text-xs text-green-700 dark:text-green-400 space-y-1">
              <p>Cliente paga com: <b>{changeForValue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</b></p>
              <p className="text-sm border-t border-green-200 dark:border-green-800 pt-1 mt-1">
                Devolver: <b className="text-lg">{changeToReturn.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</b>
              </p>
            </div>
          </div>
        )}

        {/* Endereço */}
        {isDelivery && order.address ? (
           <div className="bg-gray-50 dark:bg-slate-700 p-3 rounded-xl border border-dashed border-gray-200 dark:border-slate-600">
             <div className="flex items-start gap-2">
               <MapPin size={16} className="text-orange-600 dark:text-orange-400 mt-0.5 shrink-0"/>
               <div className="text-xs text-gray-600 dark:text-gray-300">
                 <p className="font-bold text-gray-800 dark:text-white">{order.address.street}, {order.address.number}</p>
                 <p>{order.address.neighborhood} - {order.address.city}</p>
                 {order.address.complement && <p className="text-blue-600 dark:text-blue-400 mt-1 font-medium bg-blue-50 dark:bg-blue-900/20 inline-block px-1 rounded">Ref: {order.address.complement}</p>}
               </div>
             </div>
             
             {(userRole === 'COURIER' || userRole === 'ADMIN') && (
               <a 
                 href={mapsLink} 
                 target="_blank" 
                 rel="noopener noreferrer"
                 className="mt-2 flex items-center justify-center gap-2 w-full bg-white dark:bg-slate-600 border border-gray-200 dark:border-slate-500 py-2 rounded-lg text-xs font-bold text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-slate-500 transition-colors"
               >
                 <Navigation size={14}/> Abrir no Maps <ExternalLink size={10}/>
               </a>
             )}
           </div>
        ) : (
           <div className="bg-teal-50 dark:bg-teal-900/20 p-2 rounded-lg text-xs text-teal-700 dark:text-teal-300 font-bold text-center border border-teal-100 dark:border-teal-800">
             <Package size={14} className="inline mr-1"/> Retirada no Balcão
           </div>
        )}

        {/* Itens */}
        <div className="space-y-2 py-2">
          {order.items.map((item: OrderItem) => (
            <div key={item.id} className="text-sm border-b border-gray-50 dark:border-slate-700 last:border-0 pb-2 last:pb-0">
              <div className="flex justify-between items-start">
                <span className="text-gray-800 dark:text-white">
                  <span className="font-bold bg-gray-100 dark:bg-slate-700 px-1.5 py-0.5 rounded text-gray-900 dark:text-white mr-2">{item.quantity}x</span> 
                  {item.product?.name}
                </span>
              </div>
              <div className="pl-8 text-xs space-y-0.5 mt-1">
                {item.meat_point && <p className="text-orange-600 dark:text-orange-400 font-bold">🔥 Ponto: {item.meat_point}</p>}
                {item.removed_ingredients && item.removed_ingredients.length > 0 && (
                  <p className="text-red-500 dark:text-red-400 font-bold bg-red-50 dark:bg-red-900/20 inline-block px-1 rounded">
                    🚫 Sem: {Array.isArray(item.removed_ingredients) ? item.removed_ingredients.join(', ') : item.removed_ingredients}
                  </p>
                )}
                {item.addons && item.addons.length > 0 && (
                  <p className="text-green-600 dark:text-green-400 font-bold">
                    ✨ + {item.addons.map(a => a.name).join(', ')}
                  </p>
                )}
                {item.observation && (
                  <p className="text-gray-500 dark:text-gray-400 italic bg-yellow-50 dark:bg-yellow-900/10 p-1 rounded border border-yellow-100 dark:border-yellow-900/30 mt-1">
                    "Obs: {item.observation}"
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Footer Actions */}
        <div className="pt-2 mt-auto">
          {renderActions()}
          {order.status !== 'DONE' && order.status !== 'CANCELED' && userRole === 'ADMIN' && (
             <button onClick={() => handleRequestCancel(order.id)} className="w-full text-center text-red-400 hover:text-red-600 dark:hover:text-red-300 text-xs hover:underline mt-2">
               Cancelar Pedido
             </button>
          )}
        </div>
      </div>
    );
  };

  const pendingOrders = orders.filter(o => o.status === 'PENDING');
  const preparingOrders = orders.filter(o => o.status === 'PREPARING');
  const readyDeliveryOrders = orders.filter(o => o.status === 'READY_FOR_PICKUP' && o.type === 'DELIVERY');
  const readyTakeoutOrders = orders.filter(o => o.status === 'READY_FOR_PICKUP' && o.type === 'TAKEOUT'); 
  const deliveringOrders = orders.filter(o => o.status === 'DELIVERING');
  const doneOrders = orders.filter(o => o.status === 'DONE').slice(0, 10);
  const canceledOrders = orders.filter(o => o.status === 'CANCELED').slice(0, 5);

  const showNew = ['ADMIN', 'KITCHEN'].includes(userRole);
  const showKitchen = ['ADMIN', 'KITCHEN'].includes(userRole);
  const showReadyDelivery = ['ADMIN', 'COURIER', 'KITCHEN'].includes(userRole);
  const showReadyTakeout = ['ADMIN', 'KITCHEN'].includes(userRole); 
  const showDelivery = ['ADMIN', 'COURIER'].includes(userRole);
  const showDone = ['ADMIN'].includes(userRole);
  const showCanceled = ['ADMIN'].includes(userRole);

  if (loading) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-500">
        <Clock className="animate-spin mb-2" size={32} />
        <p>Carregando pedidos...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-20 h-full flex flex-col">
      <div className="flex justify-between items-center bg-white dark:bg-slate-800 p-6 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-700 shrink-0 transition-colors">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-800 dark:text-white">
            {userRole === 'KITCHEN' ? 'Monitor da Cozinha 🍳' : 
             userRole === 'COURIER' ? 'Painel de Entregas 🏍️' : 
             'Gestão de Pedidos'}
          </h1>
          <p className="text-xs text-gray-400 dark:text-gray-500 hidden sm:block">Logado como: {userRole}</p>
        </div>
        <button onClick={loadOrders} className="p-2 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-full transition-colors text-gray-600 dark:text-gray-300" title="Atualizar"><Clock size={20}/></button>
      </div>

      <div className="flex-1 overflow-x-auto pb-4 -mx-4 px-4 lg:mx-0 lg:px-0">
        <div className="flex gap-6 min-w-max lg:min-w-0 h-full">
          
          {showNew && (
            <div className="w-[320px] flex flex-col gap-4">
              <div className="bg-yellow-50 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-400 p-3 rounded-xl font-bold flex justify-between items-center border border-yellow-100 dark:border-yellow-800 sticky top-0 z-10 shadow-sm transition-colors">
                 <span className="flex items-center gap-2"><AlertCircle size={18}/> Novos</span>
                 <span className="bg-white dark:bg-slate-800 px-2 py-0.5 rounded-md text-xs shadow-sm">{pendingOrders.length}</span>
              </div>
              <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar h-full">
                {pendingOrders.map(o => <OrderCard key={o.id} order={o}/>)}
                {pendingOrders.length === 0 && <div className="text-center text-gray-400 dark:text-gray-600 py-10 italic text-sm">Sem novos pedidos</div>}
              </div>
            </div>
          )}

          {showKitchen && (
            <div className="w-[320px] flex flex-col gap-4">
              <div className="bg-blue-50 dark:bg-blue-900/30 text-blue-800 dark:text-blue-400 p-3 rounded-xl font-bold flex justify-between items-center border border-blue-100 dark:border-blue-800 sticky top-0 z-10 shadow-sm transition-colors">
                 <span className="flex items-center gap-2"><ChefHat size={18}/> Preparando</span>
                 <span className="bg-white dark:bg-slate-800 px-2 py-0.5 rounded-md text-xs shadow-sm">{preparingOrders.length}</span>
              </div>
              <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar h-full">
                {preparingOrders.map(o => <OrderCard key={o.id} order={o}/>)}
                {preparingOrders.length === 0 && <div className="text-center text-gray-400 dark:text-gray-600 py-10 italic text-sm">Cozinha livre</div>}
              </div>
            </div>
          )}

          {showReadyDelivery && (
            <div className="w-[320px] flex flex-col gap-4">
              <div className="bg-purple-50 dark:bg-purple-900/30 text-purple-800 dark:text-purple-400 p-3 rounded-xl font-bold flex justify-between items-center border border-purple-100 dark:border-purple-800 sticky top-0 z-10 shadow-sm transition-colors">
                 <span className="flex items-center gap-2"><Bell size={18}/> Chamar Motoboy</span>
                 <span className="bg-white dark:bg-slate-800 px-2 py-0.5 rounded-md text-xs shadow-sm">{readyDeliveryOrders.length}</span>
              </div>
              <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar h-full">
                {readyDeliveryOrders.map(o => <OrderCard key={o.id} order={o}/>)}
                {readyDeliveryOrders.length === 0 && <div className="text-center text-gray-400 dark:text-gray-600 py-10 italic text-sm">Nenhum delivery pronto</div>}
              </div>
            </div>
          )}

          {showReadyTakeout && (
            <div className="w-[320px] flex flex-col gap-4">
              <div className="bg-teal-50 dark:bg-teal-900/30 text-teal-800 dark:text-teal-400 p-3 rounded-xl font-bold flex justify-between items-center border border-teal-100 dark:border-teal-800 sticky top-0 z-10 shadow-sm transition-colors">
                 <span className="flex items-center gap-2"><Package size={18}/> Retirar no Balcão</span>
                 <span className="bg-white dark:bg-slate-800 px-2 py-0.5 rounded-md text-xs shadow-sm">{readyTakeoutOrders.length}</span>
              </div>
              <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar h-full">
                {readyTakeoutOrders.map(o => <OrderCard key={o.id} order={o}/>)}
                {readyTakeoutOrders.length === 0 && <div className="text-center text-gray-400 dark:text-gray-600 py-10 italic text-sm">Nenhum balcão pronto</div>}
              </div>
            </div>
          )}

          {showDelivery && (
            <div className="w-[320px] flex flex-col gap-4">
              <div className="bg-orange-50 dark:bg-orange-900/30 text-orange-800 dark:text-orange-400 p-3 rounded-xl font-bold flex justify-between items-center border border-orange-100 dark:border-orange-800 sticky top-0 z-10 shadow-sm transition-colors">
                 <span className="flex items-center gap-2"><Bike size={18}/> Em Entrega</span>
                 <span className="bg-white dark:bg-slate-800 px-2 py-0.5 rounded-md text-xs shadow-sm">{deliveringOrders.length}</span>
              </div>
              <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar h-full">
                {deliveringOrders.map(o => <OrderCard key={o.id} order={o}/>)}
                {deliveringOrders.length === 0 && <div className="text-center text-gray-400 dark:text-gray-600 py-10 italic text-sm">Nenhuma entrega em andamento</div>}
              </div>
            </div>
          )}

          {showDone && (
            <div className="w-[320px] flex flex-col gap-4">
              <div className="bg-green-50 dark:bg-green-900/30 text-green-800 dark:text-green-400 p-3 rounded-xl font-bold flex justify-between items-center border border-green-100 dark:border-green-800 sticky top-0 z-10 shadow-sm transition-colors">
                 <span className="flex items-center gap-2"><CheckCircle size={18}/> Concluídos</span>
                 <span className="bg-white dark:bg-slate-800 px-2 py-0.5 rounded-md text-xs shadow-sm">{doneOrders.length}</span>
              </div>
              <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar h-full">
                {doneOrders.map(o => <OrderCard key={o.id} order={o}/>)}
              </div>
            </div>
          )}

          {showCanceled && (
            <div className="w-[320px] flex flex-col gap-4 opacity-75">
              <div className="bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-gray-400 p-3 rounded-xl font-bold flex justify-between items-center border border-gray-200 dark:border-slate-700 sticky top-0 z-10 shadow-sm transition-colors">
                 <span className="flex items-center gap-2"><XCircle size={18}/> Cancelados</span>
                 <span className="bg-white dark:bg-slate-900 px-2 py-0.5 rounded-md text-xs shadow-sm">{canceledOrders.length}</span>
              </div>
              <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar h-full">
                {canceledOrders.map(o => <OrderCard key={o.id} order={o}/>)}
              </div>
            </div>
          )}

        </div>
      </div>

      <ConfirmModal 
        isOpen={cancelModalOpen}
        onClose={() => setCancelModalOpen(false)}
        onConfirm={executeCancel}
        title="Cancelar Pedido?"
        message="Deseja realmente cancelar este pedido? O cliente será notificado."
        confirmLabel="Sim, Cancelar Pedido"
        isDestructive
      />
    </div>
  );
}