import { useState, useEffect } from 'react';
import { 
  X, User, MapPin, Bike, CheckCircle2, 
  Navigation, AlertCircle, Loader2 
} from 'lucide-react';
import { orderService, type Order, type Driver } from '../../services/orderService';
import toast from 'react-hot-toast';

interface DriverModalProps {
  isOpen: boolean;
  onClose: () => void;
  targetOrder: Order | null;
  onSuccess: () => void;
}

export default function DriverModal({ isOpen, onClose, targetOrder, onSuccess }: DriverModalProps) {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [nearbyOrders, setNearbyOrders] = useState<Order[]>([]);
  
  // Estados de Seleção
  const [selectedDriver, setSelectedDriver] = useState<number | null>(null);
  const [selectedOrders, setSelectedOrders] = useState<number[]>([]); // Lista de IDs para agrupar
  
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen && targetOrder) {
      loadData();
      // Sempre começa selecionando o pedido principal
      setSelectedOrders([targetOrder.id]);
      setSelectedDriver(null);
    }
  }, [isOpen, targetOrder]);

  async function loadData() {
    setLoading(true);
    try {
      // 1. Busca Motoboys
      const driversData = await orderService.getDrivers();
      setDrivers(driversData);

      // 2. Busca Sugestões de Rota (Pedidos Vizinhos)
      if (targetOrder) {
        const nearbyData = await orderService.getNearbyOrders(targetOrder.id);
        setNearbyOrders(nearbyData);
      }
    } catch (error) {
      console.error(error);
      toast.error('Erro ao carregar dados de logística');
    } finally {
      setLoading(false);
    }
  }

  function toggleOrderSelection(orderId: number) {
    if (selectedOrders.includes(orderId)) {
      setSelectedOrders(prev => prev.filter(id => id !== orderId));
    } else {
      setSelectedOrders(prev => [...prev, orderId]);
    }
  }

  async function handleConfirm() {
    if (!selectedDriver || selectedOrders.length === 0) return;

    setSubmitting(true);
    try {
      // Atribui o motoboy para TODOS os pedidos selecionados (Loop de requisições)
      // O ideal seria uma rota de "bulk assign" no backend, mas faremos loop por enquanto
      const promises = selectedOrders.map(orderId => 
        orderService.assignDriver(orderId, selectedDriver)
      );

      await Promise.all(promises);

      // Também já atualiza o status para "DELIVERING" (Em Entrega) para facilitar
      const statusPromises = selectedOrders.map(orderId =>
        orderService.updateStatus(orderId, 'DELIVERING')
      );
      await Promise.all(statusPromises);

      toast.success(`${selectedOrders.length} pedido(s) enviado(s) para o motoboy! 🏍️`);
      onSuccess(); // Recarrega a tela pai
      onClose();
    } catch (error) {
      toast.error('Erro ao atribuir entregas.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!isOpen || !targetOrder) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 w-full max-w-4xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 dark:border-slate-800 flex justify-between items-center bg-gray-50 dark:bg-slate-900/50">
          <div>
            <h2 className="text-xl font-bold text-gray-800 dark:text-white flex items-center gap-2">
              <Bike className="text-orange-600" /> Despachar Entrega
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Pedido Principal: <span className="font-mono font-bold">#{targetOrder.id}</span>
            </p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-200 dark:hover:bg-slate-800 rounded-full transition-colors">
            <X size={24} className="text-gray-500 dark:text-gray-400" />
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center py-20 text-gray-400">
            <Loader2 className="animate-spin mb-2" size={32} />
            <p>Calculando rotas e buscando motoboys...</p>
          </div>
        ) : (
          <div className="flex-1 overflow-hidden flex flex-col md:flex-row">
            
            {/* ESQUERDA: Seleção de Pedidos (Rota) */}
            <div className="flex-1 p-6 overflow-y-auto border-r border-gray-100 dark:border-slate-800 bg-gray-50/50 dark:bg-slate-900/20 custom-scrollbar">
              <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 uppercase mb-4 flex items-center gap-2">
                <Navigation size={16}/> Montar Rota de Entrega
              </h3>

              <div className="space-y-3">
                {/* Pedido Principal (Sempre visível) */}
                <div className="bg-white dark:bg-slate-800 p-4 rounded-xl border-2 border-orange-500 shadow-sm relative overflow-hidden">
                  <div className="absolute top-0 right-0 bg-orange-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-bl-lg">
                    PRINCIPAL
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="bg-orange-100 dark:bg-orange-900/20 p-2 rounded-lg text-orange-600">
                      <MapPin size={20} />
                    </div>
                    <div>
                      <p className="font-bold text-gray-800 dark:text-white text-sm">
                        {targetOrder.address?.street}, {targetOrder.address?.number}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {targetOrder.address?.neighborhood} - {targetOrder.user.name}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Pedidos Próximos (Sugestões) */}
                {nearbyOrders.length > 0 && (
                  <div className="mt-6">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-bold text-green-600 dark:text-green-400 flex items-center gap-1 bg-green-50 dark:bg-green-900/20 px-2 py-1 rounded-lg">
                        <AlertCircle size={12}/> Sugestão Inteligente: Mesmo Bairro
                      </span>
                    </div>

                    {nearbyOrders.map(order => {
                      const isSelected = selectedOrders.includes(order.id);
                      return (
                        <div 
                          key={order.id}
                          onClick={() => toggleOrderSelection(order.id)}
                          className={`p-3 rounded-xl border cursor-pointer transition-all mb-2 flex items-center gap-3 relative
                            ${isSelected 
                              ? 'bg-green-50 dark:bg-green-900/10 border-green-500 dark:border-green-500/50 shadow-sm' 
                              : 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700 hover:border-gray-300'}
                          `}
                        >
                          <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'border-green-500 bg-green-500 text-white' : 'border-gray-300 dark:border-slate-600'}`}>
                            {isSelected && <CheckCircle2 size={12} />}
                          </div>
                          
                          <div className="flex-1">
                            <div className="flex justify-between">
                              <span className="font-bold text-sm text-gray-800 dark:text-gray-200">#{order.id} - {order.user.name.split(' ')[0]}</span>
                              <span className="text-xs font-mono text-gray-400">~2km</span>
                            </div>
                            <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-1">
                              {order.address?.street}, {order.address?.number}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {nearbyOrders.length === 0 && (
                  <div className="text-center py-8 text-gray-400 text-xs italic bg-white dark:bg-slate-800 rounded-xl border border-dashed border-gray-200 dark:border-slate-700">
                    Nenhum outro pedido próximo encontrado para agrupar.
                  </div>
                )}
              </div>
            </div>

            {/* DIREITA: Seleção de Motoboy */}
            <div className="w-full md:w-80 p-6 flex flex-col bg-white dark:bg-slate-900">
              <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 uppercase mb-4 flex items-center gap-2">
                <User size={16}/> Selecionar Motoboy
              </h3>

              <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2">
                {drivers.map(driver => (
                  <button
                    key={driver.id}
                    onClick={() => setSelectedDriver(driver.id)}
                    className={`w-full text-left p-3 rounded-xl border transition-all flex items-center gap-3
                      ${selectedDriver === driver.id 
                        ? 'bg-orange-50 dark:bg-orange-900/20 border-orange-500 ring-1 ring-orange-500' 
                        : 'bg-white dark:bg-slate-800 border-gray-100 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700'}
                    `}
                  >
                    <div className="w-10 h-10 rounded-full bg-gray-200 dark:bg-slate-700 overflow-hidden flex-shrink-0">
                      {driver.avatar ? (
                         <img src={driver.avatar.startsWith('http') ? driver.avatar : `http://localhost:3000${driver.avatar}`} className="w-full h-full object-cover"/>
                      ) : (
                         <User className="w-full h-full p-2 text-gray-400"/>
                      )}
                    </div>
                    <div>
                      <p className="font-bold text-sm text-gray-800 dark:text-white">{driver.name}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{driver.phone}</p>
                    </div>
                    {selectedDriver === driver.id && <CheckCircle2 size={18} className="text-orange-600 ml-auto" />}
                  </button>
                ))}

                {drivers.length === 0 && (
                  <div className="text-center py-10 text-gray-400 text-sm">
                    Nenhum motoboy cadastrado ou disponível.
                  </div>
                )}
              </div>

              {/* Resumo e Ação */}
              <div className="mt-6 pt-4 border-t border-gray-100 dark:border-slate-800">
                <div className="flex justify-between items-center mb-4 text-sm">
                  <span className="text-gray-500 dark:text-gray-400">Pedidos na Rota:</span>
                  <span className="font-bold text-gray-900 dark:text-white text-lg">{selectedOrders.length}</span>
                </div>
                
                <button
                  onClick={handleConfirm}
                  disabled={!selectedDriver || submitting}
                  className="w-full bg-orange-600 hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-3.5 rounded-xl shadow-lg shadow-orange-200 dark:shadow-none transition-all flex justify-center items-center gap-2"
                >
                  {submitting ? <Loader2 className="animate-spin" /> : <Bike size={20} />}
                  Confirmar Envio
                </button>
              </div>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}