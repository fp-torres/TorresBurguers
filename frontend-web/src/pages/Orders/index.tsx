import { useEffect, useState } from 'react';
import { 
  Clock, CheckCircle, Truck, Package, XCircle, 
  MapPin, User, AlertCircle, ChefHat, Bike, Bell, ExternalLink, Navigation 
} from 'lucide-react';
import { orderService, type Order } from '../../services/orderService';
import ConfirmModal from '../../components/ConfirmModal';
import toast from 'react-hot-toast';

export default function Orders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Estado para Modal de Cancelamento
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [orderToCancel, setOrderToCancel] = useState<number | null>(null);

  // Identificar o Papel do Usuário (Role)
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
      // Atualização Otimista
      setOrders(prev => prev.map(o => o.id === id ? { ...o, status: newStatus as any } : o));
      await orderService.updateStatus(id, newStatus);
      
      const msgMap: any = { 
        'PREPARING': 'Cozinha notificada! 🔥', 
        'READY_FOR_PICKUP': 'Chamando Motoboy! 🔔',
        'DELIVERING': 'Boa entrega! 🏍️', 
        'DONE': 'Pedido finalizado! 🎉',
        'CANCELED': 'Cancelado.'
      };
      toast.success(msgMap[newStatus] || 'Status atualizado');
      loadOrders(); // Recarrega para garantir sincronia
    } catch (error) {
      toast.error('Erro ao atualizar status.');
      loadOrders(); // Reverte se der erro
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

  // --- SUB-COMPONENTE: CARD DO PEDIDO ---
  const OrderCard = ({ order }: { order: Order }) => {
    const isDelivery = order.type === 'DELIVERY';
    
    // Gera Link do Google Maps
    const mapsLink = order.address 
      ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${order.address.street}, ${order.address.number} - ${order.address.neighborhood}, ${order.address.city} - ${order.address.state}`)}`
      : '#';

    // Ações por Role e Status
    const renderActions = () => {
      // 1. PENDENTE (Admin e Cozinha veem)
      if (order.status === 'PENDING' && (userRole === 'ADMIN' || userRole === 'KITCHEN')) {
        return (
          <button onClick={() => updateStatus(order.id, 'PREPARING')} className="w-full bg-blue-600 text-white py-2.5 rounded-xl text-sm font-bold flex justify-center items-center gap-2 hover:bg-blue-700 shadow-sm transition-colors">
            <ChefHat size={18}/> Aceitar e Preparar
          </button>
        );
      }
      // 2. PREPARANDO (Admin e Cozinha veem)
      if (order.status === 'PREPARING' && (userRole === 'ADMIN' || userRole === 'KITCHEN')) {
        return (
          <button onClick={() => updateStatus(order.id, 'READY_FOR_PICKUP')} className="w-full bg-orange-600 text-white py-2.5 rounded-xl text-sm font-bold flex justify-center items-center gap-2 hover:bg-orange-700 shadow-sm transition-colors">
            {isDelivery ? <><Bell size={18}/> Chamar Motoboy</> : <><CheckCircle size={18}/> Pronto (Balcão)</>}
          </button>
        );
      }
      // 3. AGUARDANDO RETIRADA (Admin e Motoboy veem)
      if (order.status === 'READY_FOR_PICKUP' && (userRole === 'ADMIN' || userRole === 'COURIER')) {
        return (
          <button onClick={() => updateStatus(order.id, 'DELIVERING')} className="w-full bg-indigo-600 text-white py-2.5 rounded-xl text-sm font-bold flex justify-center items-center gap-2 hover:bg-indigo-700 shadow-sm transition-colors animate-pulse">
            <Bike size={18}/> Pegar para Entrega
          </button>
        );
      }
      // 4. EM ENTREGA (Admin e Motoboy veem)
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
      <div className="bg-white border border-gray-100 rounded-2xl p-4 shadow-sm hover:shadow-md transition-all flex flex-col gap-3 min-w-[300px]">
        
        {/* Header do Card */}
        <div className="flex justify-between items-start border-b border-gray-50 pb-3">
          <div>
            <h3 className="font-bold text-gray-800 text-lg flex items-center gap-2">
              #{order.id} 
              <span className="text-xs font-normal text-gray-400 bg-gray-50 px-2 py-0.5 rounded-full border border-gray-100">
                {new Date(order.created_at).toLocaleTimeString().slice(0, 5)}
              </span>
            </h3>
            <div className="flex items-center gap-1 text-sm font-bold text-gray-600 mt-1">
              <User size={14} /> {order.user?.name || 'Cliente'}
            </div>
          </div>
          <span className={`px-2 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wide border ${
            order.status === 'PENDING' ? 'bg-yellow-50 text-yellow-700 border-yellow-100' :
            order.status === 'PREPARING' ? 'bg-blue-50 text-blue-700 border-blue-100' :
            order.status === 'READY_FOR_PICKUP' ? 'bg-purple-50 text-purple-700 border-purple-100' :
            order.status === 'DELIVERING' ? 'bg-orange-50 text-orange-700 border-orange-100' :
            order.status === 'DONE' ? 'bg-green-50 text-green-700 border-green-100' : 'bg-red-50 text-red-700 border-red-100'
          }`}>
            {order.status === 'READY_FOR_PICKUP' ? 'Aguardando Retirada' : order.status}
          </span>
        </div>

        {/* Endereço (Foco no Motoboy) */}
        {isDelivery && order.address ? (
           <div className="bg-gray-50 p-3 rounded-xl border border-dashed border-gray-200">
             <div className="flex items-start gap-2">
               <MapPin size={16} className="text-orange-600 mt-0.5 shrink-0"/>
               <div className="text-xs text-gray-600">
                 <p className="font-bold text-gray-800">{order.address.street}, {order.address.number}</p>
                 <p>{order.address.neighborhood} - {order.address.city}</p>
                 {order.address.complement && <p className="text-blue-600 mt-1 font-medium bg-blue-50 inline-block px-1 rounded">Ref: {order.address.complement}</p>}
               </div>
             </div>
             
             {/* Link do Maps (Só aparece para Motoboy e Admin) */}
             {(userRole === 'COURIER' || userRole === 'ADMIN') && (
               <a 
                 href={mapsLink} 
                 target="_blank" 
                 rel="noopener noreferrer"
                 className="mt-2 flex items-center justify-center gap-2 w-full bg-white border border-gray-200 py-2 rounded-lg text-xs font-bold text-blue-600 hover:bg-blue-50 transition-colors"
               >
                 <Navigation size={14}/> Abrir no Maps <ExternalLink size={10}/>
               </a>
             )}
           </div>
        ) : (
           <div className="bg-blue-50 p-2 rounded-lg text-xs text-blue-700 font-bold text-center border border-blue-100">
             Retirada no Balcão
           </div>
        )}

        {/* Lista de Itens (Foco na Cozinha) */}
        <div className="space-y-2 py-2">
          {order.items.map(item => (
            <div key={item.id} className="text-sm border-b border-gray-50 last:border-0 pb-2 last:pb-0">
              <div className="flex justify-between items-start">
                <span className="text-gray-800">
                  <span className="font-bold bg-gray-100 px-1.5 py-0.5 rounded text-gray-900 mr-2">{item.quantity}x</span> 
                  {item.product?.name}
                </span>
              </div>
              
              {/* Detalhes para Cozinha */}
              <div className="pl-8 text-xs space-y-0.5 mt-1">
                {/* Ponto da Carne */}
                {item.meat_point && <p className="text-orange-600 font-bold">🔥 Ponto: {item.meat_point}</p>}
                
                {/* Ingredientes Removidos (Em Vermelho) */}
                {item.removed_ingredients && item.removed_ingredients.length > 0 && (
                  <p className="text-red-500 font-bold bg-red-50 inline-block px-1 rounded">
                    🚫 Sem: {Array.isArray(item.removed_ingredients) ? item.removed_ingredients.join(', ') : item.removed_ingredients}
                  </p>
                )}

                {/* Adicionais */}
                {item.addons && item.addons.length > 0 && (
                  <p className="text-green-600 font-bold">
                    ✨ + {item.addons.map(a => a.name).join(', ')}
                  </p>
                )}

                {/* Observação Livre */}
                {item.observation && (
                  <p className="text-gray-500 italic bg-yellow-50 p-1 rounded border border-yellow-100 mt-1">
                    "Obs: {item.observation}"
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Footer com Ações */}
        <div className="pt-2 mt-auto">
          {renderActions()}
          
          {/* Cancelar (Admin e Cozinha se Pendente) */}
          {order.status !== 'DONE' && order.status !== 'CANCELED' && userRole === 'ADMIN' && (
             <button onClick={() => handleRequestCancel(order.id)} className="w-full text-center text-red-400 text-xs hover:text-red-600 hover:underline mt-2">
               Cancelar Pedido
             </button>
          )}
        </div>
      </div>
    );
  };

  // --- FILTRAGEM E COLUNAS (LÓGICA KANBAN) ---
  const pendingOrders = orders.filter(o => o.status === 'PENDING');
  const preparingOrders = orders.filter(o => o.status === 'PREPARING');
  const readyOrders = orders.filter(o => o.status === 'READY_FOR_PICKUP'); 
  const deliveringOrders = orders.filter(o => o.status === 'DELIVERING');
  const doneOrders = orders.filter(o => o.status === 'DONE').slice(0, 10); // Mostra só os últimos 10 concluídos
  const canceledOrders = orders.filter(o => o.status === 'CANCELED').slice(0, 5); // Mostra só os últimos 5 cancelados

  // Definição de visibilidade das colunas por Role
  const showNew = ['ADMIN', 'KITCHEN'].includes(userRole);
  const showKitchen = ['ADMIN', 'KITCHEN'].includes(userRole);
  const showReady = ['ADMIN', 'COURIER', 'KITCHEN'].includes(userRole); // Cozinha vê para saber que finalizou
  const showDelivery = ['ADMIN', 'COURIER'].includes(userRole);
  const showDone = ['ADMIN'].includes(userRole);
  const showCanceled = ['ADMIN'].includes(userRole);

  return (
    <div className="space-y-6 pb-20 h-full flex flex-col">
      <div className="flex justify-between items-center bg-white p-6 rounded-2xl shadow-sm border border-gray-100 shrink-0">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-800">
            {userRole === 'KITCHEN' ? 'Monitor da Cozinha 🍳' : 
             userRole === 'COURIER' ? 'Painel de Entregas 🏍️' : 
             'Gestão de Pedidos'}
          </h1>
          <p className="text-xs text-gray-400 hidden sm:block">Logado como: {userRole}</p>
        </div>
        <button onClick={loadOrders} className="p-2 hover:bg-gray-100 rounded-full transition-colors" title="Atualizar"><Clock size={20}/></button>
      </div>

      <div className="flex-1 overflow-x-auto pb-4 -mx-4 px-4 lg:mx-0 lg:px-0">
        <div className="flex gap-6 min-w-max lg:min-w-0 h-full">
          
          {/* COLUNA 1: NOVOS (Pendente) */}
          {showNew && (
            <div className="w-[320px] flex flex-col gap-4">
              <div className="bg-yellow-50 text-yellow-800 p-3 rounded-xl font-bold flex justify-between items-center border border-yellow-100 sticky top-0 z-10 shadow-sm">
                 <span className="flex items-center gap-2"><AlertCircle size={18}/> Novos</span>
                 <span className="bg-white px-2 py-0.5 rounded-md text-xs shadow-sm">{pendingOrders.length}</span>
              </div>
              <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar h-full">
                {pendingOrders.map(o => <OrderCard key={o.id} order={o}/>)}
                {pendingOrders.length === 0 && <div className="text-center text-gray-400 py-10 italic text-sm">Sem novos pedidos</div>}
              </div>
            </div>
          )}

          {/* COLUNA 2: COZINHA (Preparando) */}
          {showKitchen && (
            <div className="w-[320px] flex flex-col gap-4">
              <div className="bg-blue-50 text-blue-800 p-3 rounded-xl font-bold flex justify-between items-center border border-blue-100 sticky top-0 z-10 shadow-sm">
                 <span className="flex items-center gap-2"><ChefHat size={18}/> Preparando</span>
                 <span className="bg-white px-2 py-0.5 rounded-md text-xs shadow-sm">{preparingOrders.length}</span>
              </div>
              <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar h-full">
                {preparingOrders.map(o => <OrderCard key={o.id} order={o}/>)}
                {preparingOrders.length === 0 && <div className="text-center text-gray-400 py-10 italic text-sm">Cozinha livre</div>}
              </div>
            </div>
          )}

          {/* COLUNA 3: AGUARDANDO RETIRADA */}
          {showReady && (
            <div className="w-[320px] flex flex-col gap-4">
              <div className="bg-purple-50 text-purple-800 p-3 rounded-xl font-bold flex justify-between items-center border border-purple-100 sticky top-0 z-10 shadow-sm">
                 <span className="flex items-center gap-2"><Bell size={18}/> Aguardando Retirada</span>
                 <span className="bg-white px-2 py-0.5 rounded-md text-xs shadow-sm">{readyOrders.length}</span>
              </div>
              <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar h-full">
                {readyOrders.map(o => <OrderCard key={o.id} order={o}/>)}
                {readyOrders.length === 0 && <div className="text-center text-gray-400 py-10 italic text-sm">Nenhum pedido pronto</div>}
              </div>
            </div>
          )}

          {/* COLUNA 4: EM ENTREGA */}
          {showDelivery && (
            <div className="w-[320px] flex flex-col gap-4">
              <div className="bg-orange-50 text-orange-800 p-3 rounded-xl font-bold flex justify-between items-center border border-orange-100 sticky top-0 z-10 shadow-sm">
                 <span className="flex items-center gap-2"><Bike size={18}/> Em Entrega</span>
                 <span className="bg-white px-2 py-0.5 rounded-md text-xs shadow-sm">{deliveringOrders.length}</span>
              </div>
              <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar h-full">
                {deliveringOrders.map(o => <OrderCard key={o.id} order={o}/>)}
                {deliveringOrders.length === 0 && <div className="text-center text-gray-400 py-10 italic text-sm">Nenhuma entrega em andamento</div>}
              </div>
            </div>
          )}

          {/* COLUNA 5: CONCLUÍDOS */}
          {showDone && (
            <div className="w-[320px] flex flex-col gap-4">
              <div className="bg-green-50 text-green-800 p-3 rounded-xl font-bold flex justify-between items-center border border-green-100 sticky top-0 z-10 shadow-sm">
                 <span className="flex items-center gap-2"><CheckCircle size={18}/> Concluídos</span>
                 <span className="bg-white px-2 py-0.5 rounded-md text-xs shadow-sm">{doneOrders.length}</span>
              </div>
              <div className="flex flex-col gap-4 overflow-y-auto pr-1 pb-2 custom-scrollbar h-full">
                {doneOrders.map(o => <OrderCard key={o.id} order={o}/>)}
              </div>
            </div>
          )}

          {/* COLUNA 6: CANCELADOS */}
          {showCanceled && (
            <div className="w-[320px] flex flex-col gap-4 opacity-75">
              <div className="bg-gray-100 text-gray-600 p-3 rounded-xl font-bold flex justify-between items-center border border-gray-200 sticky top-0 z-10 shadow-sm">
                 <span className="flex items-center gap-2"><XCircle size={18}/> Cancelados</span>
                 <span className="bg-white px-2 py-0.5 rounded-md text-xs shadow-sm">{canceledOrders.length}</span>
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
        message="Deseja realmente cancelar este pedido? O cliente será notificado e o valor não será cobrado."
        confirmLabel="Sim, Cancelar Pedido"
        isDestructive
      />
    </div>
  );
}