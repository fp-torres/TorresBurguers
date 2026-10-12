import { useState, useEffect, useCallback } from 'react';
import {
  X, User, MapPin, Bike, CheckCircle2,
  Navigation, AlertCircle, Loader2, Map as MapIcon
} from 'lucide-react';
import { orderService, type Order, type Driver } from '../../services/orderService';
import { assetUrl, getApiErrorMessage } from '../../services/api';
import { addressAreaLine, addressStreetLine, orderAddress } from '../../utils/orders';
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
  const [selectedOrders, setSelectedOrders] = useState<number[]>([]); 
  
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const loadData = useCallback(async (orderId: number) => {
    // Motoboys disponíveis e sugestões de rota (pedidos vizinhos do mesmo bairro) em paralelo.
    // Sem as sugestões ainda dá para despachar; sem a lista de motoboys, não.
    const [driversResult, nearbyResult] = await Promise.allSettled([
      orderService.getDrivers(),
      orderService.getNearbyOrders(orderId),
    ]);

    if (driversResult.status === 'fulfilled') {
      setDrivers(driversResult.value || []);
    } else {
      toast.error(getApiErrorMessage(driversResult.reason, 'Erro ao carregar dados de logística'));
    }
    setNearbyOrders(nearbyResult.status === 'fulfilled' ? nearbyResult.value || [] : []);
    setLoading(false);
  }, []);

  // Cada abertura começa do zero, com o pedido principal já selecionado
  const [openedFor, setOpenedFor] = useState<number | null>(null);
  const targetId = isOpen && targetOrder ? targetOrder.id : null;
  if (targetId !== openedFor) {
    setOpenedFor(targetId);
    if (targetId !== null) {
      setLoading(true);
      setDrivers([]);
      setNearbyOrders([]);
      setSelectedOrders([targetId]);
      setSelectedDriver(null);
    }
  }

  useEffect(() => {
    if (targetId !== null) loadData(targetId);
  }, [targetId, loadData]);

  // Adiciona ou remove pedidos da seleção de rota
  function toggleOrderSelection(orderId: number) {
    // Impede desmarcar o pedido principal (regra de negócio)
    if (targetOrder && orderId === targetOrder.id) return;

    if (selectedOrders.includes(orderId)) {
      setSelectedOrders(prev => prev.filter(id => id !== orderId));
    } else {
      setSelectedOrders(prev => [...prev, orderId]);
    }
  }

  async function handleConfirm() {
    if (!selectedDriver || selectedOrders.length === 0) {
        toast.error("Selecione um motoboy!");
        return;
    }

    setSubmitting(true);
    try {
      // Atribui o motoboy para TODOS os pedidos selecionados
      const promises = selectedOrders.map(orderId => 
        orderService.assignDriver(orderId, selectedDriver)
      );

      await Promise.all(promises);

      toast.success(`${selectedOrders.length} pedido(s) despachado(s) com sucesso! 🏍️`);
      onSuccess(); // Recarrega a tela pai (Orders)
      onClose();
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Erro ao atribuir entregas.'));
    } finally {
      setSubmitting(false);
    }
  }

  if (!isOpen || !targetOrder) return null;

  // Endereço salvo no pedido (retrato); pedidos antigos usam o endereço cadastrado
  const targetAddress = orderAddress(targetOrder);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div role="dialog" aria-modal="true" aria-labelledby="driver-modal-title" className="bg-white dark:bg-slate-900 w-full max-w-5xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 dark:border-slate-800 flex justify-between items-center bg-gray-50 dark:bg-slate-900/50">
          <div>
            <h2 id="driver-modal-title" className="text-xl font-bold text-gray-800 dark:text-white flex items-center gap-2">
              <Bike className="text-orange-600" /> Logística de Entrega
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-1">
               Pedido Principal: <span className="font-mono font-bold bg-gray-200 dark:bg-slate-700 px-1.5 rounded">#{targetOrder.id}</span>
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Fechar" autoFocus className="p-2 hover:bg-gray-200 dark:hover:bg-slate-800 rounded-full transition-colors">
            <X size={24} className="text-gray-500 dark:text-gray-400" />
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center py-20 text-gray-400">
            <Loader2 className="animate-spin mb-2 text-orange-600" size={40} />
            <p className="animate-pulse">Calculando rota e localizando motoboys...</p>
          </div>
        ) : (
          <div className="flex-1 overflow-hidden flex flex-col md:flex-row">
            
            {/* COLUNA ESQUERDA: Seleção de Pedidos (Rota) */}
            <div className="flex-1 p-6 overflow-y-auto border-r border-gray-100 dark:border-slate-800 bg-gray-50/50 dark:bg-slate-900/20 custom-scrollbar relative">
              <div className="flex justify-between items-center mb-4">
                  <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 uppercase flex items-center gap-2">
                    <Navigation size={16}/> Rota de Entrega
                  </h3>
                  {/* Badge de Mapa (Visual Only por enquanto) */}
                  <span className="text-[10px] bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-bold flex items-center gap-1">
                    <MapIcon size={10}/> Modo Lista
                  </span>
              </div>

              <div className="space-y-4">
                {/* 1. Pedido Principal (Sempre Fixo) */}
                <div className="bg-white dark:bg-slate-800 p-4 rounded-xl border-2 border-orange-500 shadow-lg relative overflow-hidden group">
                  <div className="absolute top-0 right-0 bg-orange-500 text-white text-[10px] font-bold px-3 py-1 rounded-bl-lg shadow-sm">
                    PRINCIPAL
                  </div>
                  <div className="flex items-start gap-4">
                    <div className="bg-orange-100 dark:bg-orange-900/20 p-3 rounded-full text-orange-600 flex-shrink-0">
                      <MapPin size={24} />
                    </div>
                    <div>
                      <p className="font-bold text-gray-800 dark:text-white text-base">
                        {targetAddress ? addressStreetLine(targetAddress) : 'Endereço não informado'}
                      </p>
                      {targetAddress && (
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          {addressAreaLine(targetAddress)}
                        </p>
                      )}
                      {targetAddress?.complement && (
                        <p className="text-xs text-gray-500 dark:text-gray-400">Ref: {targetAddress.complement}</p>
                      )}
                      <p className="text-xs font-bold text-gray-400 mt-1 flex items-center gap-1">
                        <User size={10}/> {targetOrder.user?.name || 'Cliente'}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Linha conectora visual */}
                {nearbyOrders.length > 0 && (
                   <div className="h-6 w-0.5 bg-gray-300 dark:bg-slate-700 mx-auto -my-2 border-l border-dashed border-gray-400"></div>
                )}

                {/* 2. Pedidos Próximos (Sugestões) */}
                {nearbyOrders.length > 0 ? (
                  <div className="animate-in slide-in-from-bottom-2 duration-300">
                    <div className="flex items-center justify-between mb-3 bg-green-50 dark:bg-green-900/20 p-2 rounded-lg border border-green-100 dark:border-green-900/30">
                      <span className="text-xs font-bold text-green-700 dark:text-green-400 flex items-center gap-1">
                        <AlertCircle size={14}/> Sugestão: Mesmo Bairro ({targetAddress?.neighborhood})
                      </span>
                    </div>

                    {/* Cada vizinho é um botão de alternar (teclado e leitores de tela) */}
                    <div className="space-y-3">
                      {nearbyOrders.map(order => {
                        const isSelected = selectedOrders.includes(order.id);
                        const nearbyAddress = orderAddress(order);
                        return (
                          <button
                            type="button"
                            key={order.id}
                            onClick={() => toggleOrderSelection(order.id)}
                            aria-pressed={isSelected}
                            className={`w-full text-left p-4 rounded-xl border-2 cursor-pointer transition-all flex items-center gap-3 relative hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500
                              ${isSelected
                                ? 'bg-green-50 dark:bg-green-900/10 border-green-500 dark:border-green-500/50'
                                : 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700 hover:border-gray-300'}
                            `}
                          >
                            <span className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors flex-shrink-0 ${isSelected ? 'border-green-500 bg-green-500 text-white' : 'border-gray-300 dark:border-slate-600'}`}>
                              {isSelected && <CheckCircle2 size={14} />}
                            </span>

                            <span className="flex-1 min-w-0">
                              <span className="flex justify-between items-center mb-1">
                                <span className="font-bold text-sm text-gray-800 dark:text-gray-200">#{order.id} - {order.user?.name?.split(' ')[0] || 'Cliente'}</span>
                                <span className="text-[10px] font-mono font-bold text-gray-500 bg-gray-100 dark:bg-slate-700 px-2 py-0.5 rounded-full">Vizinho</span>
                              </span>
                              <span className="block text-xs text-gray-600 dark:text-gray-400 truncate">
                                {nearbyAddress ? addressStreetLine(nearbyAddress) : 'Endereço não informado'}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-12 text-gray-400 text-sm italic bg-white dark:bg-slate-800 rounded-xl border border-dashed border-gray-200 dark:border-slate-700 p-4">
                    <Navigation className="mx-auto mb-2 opacity-50" size={32}/>
                    Nenhum outro pedido próximo para agrupar.
                  </div>
                )}
              </div>
            </div>

            {/* COLUNA DIREITA: Seleção de Motoboy */}
            <div className="w-full md:w-96 p-6 flex flex-col bg-white dark:bg-slate-900 shadow-xl z-10">
              <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 uppercase mb-4 flex items-center gap-2">
                <User size={16}/> Selecionar Entregador
              </h3>

              <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2 max-h-[300px] md:max-h-none pr-1">
                {drivers.map(driver => (
                  <button
                    key={driver.id}
                    onClick={() => setSelectedDriver(driver.id)}
                    className={`w-full text-left p-3 rounded-xl border-2 transition-all flex items-center gap-3 hover:shadow-md active:scale-[0.98]
                      ${selectedDriver === driver.id 
                        ? 'bg-orange-50 dark:bg-orange-900/20 border-orange-500 ring-1 ring-orange-500 z-10' 
                        : 'bg-white dark:bg-slate-800 border-gray-100 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700'}
                    `}
                  >
                    <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-slate-700 overflow-hidden flex-shrink-0 border border-gray-200 dark:border-slate-600">
                      {driver.avatar ? (
                         <img src={assetUrl(driver.avatar)} className="w-full h-full object-cover" alt={driver.name}/>
                      ) : (
                         <User className="w-full h-full p-3 text-gray-400"/>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-sm text-gray-800 dark:text-white truncate">{driver.name}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate flex items-center gap-1">
                        📱 {driver.phone}
                      </p>
                    </div>
                    {selectedDriver === driver.id && (
                        <div className="bg-orange-500 text-white rounded-full p-1 shadow-sm">
                            <CheckCircle2 size={16} />
                        </div>
                    )}
                  </button>
                ))}

                {drivers.length === 0 && (
                  <div className="text-center py-10 bg-red-50 dark:bg-red-900/10 rounded-xl border border-red-100 dark:border-red-900/30 p-4">
                    <p className="text-red-600 dark:text-red-400 font-bold text-sm mb-1">Nenhum Motoboy Disponível</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                        Cadastre um usuário com o perfil Entregador na tela Equipe.
                    </p>
                  </div>
                )}
              </div>

              {/* Resumo e Botão de Ação */}
              <div className="mt-6 pt-4 border-t border-gray-100 dark:border-slate-800 bg-gray-50/50 dark:bg-slate-800/50 p-4 rounded-xl">
                <div className="flex justify-between items-center mb-4 text-sm">
                  <span className="text-gray-500 dark:text-gray-400 font-medium">Entregas Selecionadas:</span>
                  <span className="font-bold text-gray-900 dark:text-white text-xl bg-white dark:bg-slate-700 px-3 py-1 rounded-lg shadow-sm border border-gray-100 dark:border-slate-600">
                    {selectedOrders.length}
                  </span>
                </div>
                
                <button
                  onClick={handleConfirm}
                  disabled={!selectedDriver || submitting}
                  className="w-full bg-orange-600 hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-4 rounded-xl shadow-lg shadow-orange-200 dark:shadow-none transition-all flex justify-center items-center gap-2 transform active:scale-[0.98]"
                >
                  {submitting ? <Loader2 className="animate-spin" /> : <Bike size={22} />}
                  CONFIRMAR DESPACHO
                </button>
              </div>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}