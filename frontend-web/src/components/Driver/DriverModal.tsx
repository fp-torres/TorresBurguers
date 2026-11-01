import { useState, useEffect } from 'react';
import {
  User, MapPin, Bike, CheckCircle2, Navigation, AlertCircle, Loader2, Phone, RotateCcw,
} from 'lucide-react';
import { orderLabel, orderService, type Order, type Driver } from '../../services/orderService';
import { avatarUrl, getApiErrorMessage, getApiErrorStatus } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import { addressAreaLine, addressStreetLine, orderAddress } from '../../utils/orders';
import { maskPhone } from '../../utils/masks';
import { Modal, buttonClass } from '../ui';
import toast from 'react-hot-toast';

interface DriverModalProps {
  isOpen: boolean;
  onClose: () => void;
  targetOrder: Order | null;
  onSuccess: () => void;
}

/**
 * Despacho (Administrador e Atendente): escolhe o entregador da loja (GET /orders/drivers/list) e, com a
 * sugestão de pedidos prontos do mesmo bairro (GET /orders/:id/nearby), atribui um ou vários de uma vez.
 */
export default function DriverModal({ isOpen, onClose, targetOrder, onSuccess }: DriverModalProps) {
  if (!isOpen || !targetOrder) return null;
  // Cada abertura começa do zero, com o pedido principal já selecionado
  return <DispatchDialog key={targetOrder.id} targetOrder={targetOrder} onClose={onClose} onSuccess={onSuccess} />;
}

interface DispatchDialogProps {
  targetOrder: Order;
  onClose: () => void;
  onSuccess: () => void;
}

function DispatchDialog({ targetOrder, onClose, onSuccess }: DispatchDialogProps) {
  const { refreshUser } = useAuth();
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [driversError, setDriversError] = useState<string | null>(null);
  const [nearbyOrders, setNearbyOrders] = useState<Order[]>([]);
  const [selectedDriver, setSelectedDriver] = useState<number | null>(null);
  const [selectedOrders, setSelectedOrders] = useState<number[]>([targetOrder.id]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  // Nova tentativa de carregar os entregadores
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    // Entregadores e sugestões de rota (pedidos vizinhos do mesmo bairro) em paralelo.
    // Sem as sugestões ainda dá para despachar; sem a lista de entregadores, não.
    Promise.allSettled([orderService.getDrivers(), orderService.getNearbyOrders(targetOrder.id)])
      .then(([driversResult, nearbyResult]) => {
        if (!active) return;
        if (driversResult.status === 'fulfilled') {
          setDrivers(driversResult.value);
          setDriversError(null);
        } else {
          setDriversError(getApiErrorMessage(driversResult.reason, 'Erro ao carregar os entregadores.'));
          if (getApiErrorStatus(driversResult.reason) === 403) void refreshUser();
        }
        setNearbyOrders(nearbyResult.status === 'fulfilled' ? nearbyResult.value : []);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [targetOrder.id, attempt, refreshUser]);

  function retry() {
    setLoading(true);
    setAttempt((current) => current + 1);
  }

  // Adiciona ou remove pedidos da seleção de rota (o pedido principal fica sempre)
  function toggleOrderSelection(orderId: number) {
    if (orderId === targetOrder.id) return;
    setSelectedOrders((current) => (current.includes(orderId) ? current.filter((id) => id !== orderId) : [...current, orderId]));
  }

  async function handleConfirm() {
    if (!selectedDriver || selectedOrders.length === 0) {
      toast.error('Selecione um motoboy!');
      return;
    }

    setSubmitting(true);
    // Atribui o entregador a cada pedido selecionado; um recusado não impede os demais
    const results = await Promise.allSettled(selectedOrders.map((orderId) => orderService.assignDriver(orderId, selectedDriver)));
    setSubmitting(false);

    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    const succeeded = results.length - failures.length;

    if (succeeded > 0) {
      toast.success(`${succeeded} pedido(s) despachado(s) com sucesso! 🏍️`);
    }
    if (failures.length > 0) {
      const reason = failures[0].reason;
      const status = getApiErrorStatus(reason);
      if (status === 404) {
        // Pedido de outra loja ou que saiu do quadro: não é troca de perfil
        toast.error(`${failures.length} pedido(s) não foram encontrados nesta loja e ficaram de fora.`);
      } else {
        toast.error(getApiErrorMessage(reason, 'Erro ao atribuir entregas.'), { duration: 6000 });
        // 403: o perfil ou a situação da loja mudou; a sessão é conferida
        if (status === 403) void refreshUser();
      }
    }

    if (succeeded > 0) {
      onSuccess(); // Recarrega o quadro
      onClose();
    }
  }

  // Endereço salvo no pedido (retrato); pedidos antigos usam o endereço cadastrado
  const targetAddress = orderAddress(targetOrder);

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      dismissible={!submitting}
      title={<span className="flex items-center gap-2"><Bike className="text-orange-600" aria-hidden="true" /> Logística de Entrega</span>}
      description={<>Pedido Principal: <span className="font-mono font-bold">{orderLabel(targetOrder)}</span></>}
    >
      {loading ? (
        <div className="flex flex-col items-center justify-center py-16 text-gray-500 dark:text-gray-400" role="status">
          <Loader2 className="animate-spin mb-2 text-orange-600" size={40} aria-hidden="true" />
          <p>Calculando rota e localizando motoboys...</p>
        </div>
      ) : (
        <div className="flex flex-col md:flex-row gap-6 -m-6">

          {/* Seleção de pedidos (rota) */}
          <section aria-labelledby="dispatch-route-title" className="flex-1 p-6 bg-gray-50/50 dark:bg-slate-900/20 min-w-0">
            <h3 id="dispatch-route-title" className="text-sm font-bold text-gray-700 dark:text-gray-300 uppercase flex items-center gap-2 mb-4">
              <Navigation size={16} aria-hidden="true" /> Rota de Entrega
            </h3>

            <div className="space-y-4">
              {/* Pedido principal (sempre incluído) */}
              <div className="bg-white dark:bg-slate-800 p-4 rounded-xl border-2 border-orange-500 shadow-lg relative overflow-hidden">
                <div className="absolute top-0 right-0 bg-orange-500 text-white text-[10px] font-bold px-3 py-1 rounded-bl-lg shadow-sm">
                  PRINCIPAL
                </div>
                <div className="flex items-start gap-4">
                  <div className="bg-orange-100 dark:bg-orange-900/20 p-3 rounded-full text-orange-600 shrink-0" aria-hidden="true">
                    <MapPin size={24} />
                  </div>
                  <div className="min-w-0">
                    <p className="font-bold text-gray-800 dark:text-white text-base">
                      {targetAddress ? addressStreetLine(targetAddress) : 'Endereço não informado'}
                    </p>
                    {targetAddress && <p className="text-sm text-gray-500 dark:text-gray-400">{addressAreaLine(targetAddress)}</p>}
                    {targetAddress?.complement && <p className="text-xs text-gray-500 dark:text-gray-400">Ref: {targetAddress.complement}</p>}
                    <p className="text-xs font-bold text-gray-500 dark:text-gray-400 mt-1 flex items-center gap-1">
                      <User size={10} aria-hidden="true" /> {targetOrder.user?.name || 'Cliente'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Pedidos próximos (sugestões) */}
              {nearbyOrders.length > 0 ? (
                <div>
                  <p className="mb-3 flex items-center gap-1 bg-green-50 dark:bg-green-900/20 p-2 rounded-lg border border-green-100 dark:border-green-900/30 text-xs font-bold text-green-700 dark:text-green-400">
                    <AlertCircle size={14} aria-hidden="true" /> Sugestão: Mesmo Bairro ({targetAddress?.neighborhood})
                  </p>

                  {/* Cada vizinho é um botão de alternar (teclado e leitores de tela) */}
                  <div className="space-y-3">
                    {nearbyOrders.map((order) => {
                      const isSelected = selectedOrders.includes(order.id);
                      const nearbyAddress = orderAddress(order);
                      return (
                        <button
                          type="button"
                          key={order.id}
                          onClick={() => toggleOrderSelection(order.id)}
                          aria-pressed={isSelected}
                          className={`w-full text-left p-4 rounded-xl border-2 transition-all flex items-center gap-3 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
                            isSelected
                              ? 'bg-green-50 dark:bg-green-900/10 border-green-500 dark:border-green-500/50'
                              : 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700 hover:border-gray-300'
                          }`}
                        >
                          <span aria-hidden="true" className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors shrink-0 ${isSelected ? 'border-green-500 bg-green-500 text-white' : 'border-gray-300 dark:border-slate-600'}`}>
                            {isSelected && <CheckCircle2 size={14} />}
                          </span>
                          <span className="flex-1 min-w-0">
                            <span className="flex justify-between items-center gap-2 mb-1">
                              <span className="font-bold text-sm text-gray-800 dark:text-gray-200">{orderLabel(order)} - {order.user?.name?.split(' ')[0] || 'Cliente'}</span>
                              <span className="text-[10px] font-bold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-slate-700 px-2 py-0.5 rounded-full">Vizinho</span>
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
                <div className="text-center py-10 text-gray-500 dark:text-gray-400 text-sm bg-white dark:bg-slate-800 rounded-xl border border-dashed border-gray-200 dark:border-slate-700 p-4">
                  <Navigation className="mx-auto mb-2 opacity-50" size={32} aria-hidden="true" />
                  Nenhum outro pedido pronto do mesmo bairro para agrupar.
                </div>
              )}
            </div>
          </section>

          {/* Seleção do entregador */}
          <section aria-labelledby="dispatch-driver-title" className="w-full md:w-96 p-6 flex flex-col bg-white dark:bg-slate-900 md:border-l border-gray-100 dark:border-slate-800">
            <h3 id="dispatch-driver-title" className="text-sm font-bold text-gray-700 dark:text-gray-300 uppercase mb-4 flex items-center gap-2">
              <User size={16} aria-hidden="true" /> Selecionar Entregador
            </h3>

            <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2 max-h-72 md:max-h-[50vh] pr-1">
              {drivers.map((driver) => {
                const avatar = avatarUrl(driver.avatar);
                const selected = selectedDriver === driver.id;
                return (
                  <button
                    key={driver.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setSelectedDriver(driver.id)}
                    className={`w-full text-left p-3 rounded-xl border-2 transition-all flex items-center gap-3 hover:shadow-md active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
                      selected
                        ? 'bg-orange-50 dark:bg-orange-900/20 border-orange-500'
                        : 'bg-white dark:bg-slate-800 border-gray-100 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700'
                    }`}
                  >
                    <span className="w-12 h-12 rounded-full bg-gray-100 dark:bg-slate-700 overflow-hidden shrink-0 border border-gray-200 dark:border-slate-600" aria-hidden="true">
                      {avatar ? <img src={avatar} className="w-full h-full object-cover" alt="" /> : <User className="w-full h-full p-3 text-gray-400" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-bold text-sm text-gray-800 dark:text-white truncate">{driver.name}</span>
                      {driver.phone && (
                        <span className="text-xs text-gray-500 dark:text-gray-400 truncate flex items-center gap-1">
                          <Phone size={12} aria-hidden="true" /> {maskPhone(driver.phone)}
                        </span>
                      )}
                    </span>
                    {selected && (
                      <span className="bg-orange-500 text-white rounded-full p-1 shadow-sm" aria-hidden="true">
                        <CheckCircle2 size={16} />
                      </span>
                    )}
                  </button>
                );
              })}

              {driversError ? (
                <div role="alert" className="text-center py-8 bg-red-50 dark:bg-red-900/10 rounded-xl border border-red-100 dark:border-red-900/30 p-4 space-y-3">
                  <p className="text-red-600 dark:text-red-400 font-bold text-sm">{driversError}</p>
                  <button type="button" onClick={retry} className={buttonClass('secondary', 'sm')}>
                    <RotateCcw size={14} aria-hidden="true" /> Tentar novamente
                  </button>
                </div>
              ) : drivers.length === 0 && (
                <div className="text-center py-10 bg-red-50 dark:bg-red-900/10 rounded-xl border border-red-100 dark:border-red-900/30 p-4">
                  <p className="text-red-600 dark:text-red-400 font-bold text-sm mb-1">Nenhum Motoboy Disponível</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Cadastre ou convide um usuário com o perfil Entregador na tela Equipe.
                  </p>
                </div>
              )}
            </div>

            {/* Resumo e ação */}
            <div className="mt-6 pt-4 border-t border-gray-100 dark:border-slate-800 bg-gray-50/50 dark:bg-slate-800/50 p-4 rounded-xl">
              <div className="flex justify-between items-center mb-4 text-sm" aria-live="polite">
                <span className="text-gray-500 dark:text-gray-400 font-medium">Entregas Selecionadas:</span>
                <span className="font-bold text-gray-900 dark:text-white text-xl bg-white dark:bg-slate-700 px-3 py-1 rounded-lg shadow-sm border border-gray-100 dark:border-slate-600">
                  {selectedOrders.length}
                </span>
              </div>

              <button
                type="button"
                onClick={handleConfirm}
                disabled={!selectedDriver || submitting}
                className="w-full bg-orange-600 hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-4 rounded-xl shadow-lg shadow-orange-200 dark:shadow-none transition-all flex justify-center items-center gap-2 active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900"
              >
                {submitting ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Bike size={22} aria-hidden="true" />}
                CONFIRMAR DESPACHO
              </button>
            </div>
          </section>
        </div>
      )}
    </Modal>
  );
}
