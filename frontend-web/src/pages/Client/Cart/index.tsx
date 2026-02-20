import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { 
  Trash2, ArrowRight, MapPin, Store, Plus, Minus, 
  AlertCircle, Clock, Navigation, ShieldAlert, Banknote 
} from 'lucide-react';
import toast from 'react-hot-toast'; 

import { useCart, type Addon } from '../../../contexts/CartContext';
import { useAuth } from '../../../contexts/AuthContext';
import api from '../../../services/api';
import AddressModal from '../../../components/AddressModal';
import ConfirmModal from '../../../components/ConfirmModal';
import { maskMoney, currencyToNumber } from '../../../utils/masks'; 

import PaymentForm from './components/PaymentForm';
import PixCheckout from './components/PixCheckout';

const STORE_ADDRESS = {
  street: "Av. Rio Branco",
  number: "156",
  complement: "Loja B",
  neighborhood: "Centro",
  city: "Rio de Janeiro",
  state: "RJ",
  zipCode: "20040-003"
};

interface AddressData {
  id: number;
  street: string;
  number: string;
  neighborhood: string;
  city: string;
}

export default function ClientCart() {
  const { cartItems, removeFromCart, updateQuantity, clearCart, cartTotal } = useCart();
  const { isAuthenticated, user } = useAuth();
  const navigate = useNavigate();
  
  const [orderType, setOrderType] = useState<'DELIVERY' | 'TAKEOUT'>('TAKEOUT');
  const [paymentType, setPaymentType] = useState<'ONLINE' | 'OFFLINE'>('ONLINE'); 
  const [paymentMethod, setPaymentMethod] = useState<'CREDIT_CARD' | 'PIX' | 'MONEY'>('CREDIT_CARD'); 
  
  const [changeFor, setChangeFor] = useState('');

  const [loading, setLoading] = useState(false);
  const [addresses, setAddresses] = useState<AddressData[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<number | null>(null);
  const [isAddressModalOpen, setIsAddressModalOpen] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const [deliveryFee, setDeliveryFee] = useState(0);
  const [estimatedTime, setEstimatedTime] = useState('15-20 min');

  const [paymentStep, setPaymentStep] = useState<'FORM' | 'PIX_WAIT' | 'SUCCESS' | 'ERROR'>('FORM');
  const [pixData, setPixData] = useState<{ qrCode: string, copyPaste: string, id: number } | null>(null);
  
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);

  const isStaff = !!(user && user.role !== 'CLIENT');

  useEffect(() => {
    if (isAuthenticated) loadAddresses();
  }, [isAuthenticated]);

  useEffect(() => {
    if (orderType === 'TAKEOUT') {
      setEstimatedTime('15-20 min'); 
      setDeliveryFee(0);
    } else if (selectedAddressId) {
      const address = addresses.find(a => a.id === selectedAddressId);
      if (address) {
        const { fee, time } = calculateDeliveryLogistics(address.neighborhood);
        setDeliveryFee(fee);
        setEstimatedTime(time);
      }
    } else {
      setEstimatedTime('--');
      setDeliveryFee(0);
    }
  }, [orderType, selectedAddressId, addresses]);

  useEffect(() => {
    let interval: any; 
    if (paymentStep === 'PIX_WAIT' && pixData?.id) {
      interval = setInterval(async () => {
        try {
          const { data } = await api.get(`/payment/status/${pixData.id}`);
          if (data.status === 'approved') {
            handleFinishOrder(pixData.id, 'PIX'); 
            clearInterval(interval);
          }
        } catch (error) { console.log('Aguardando pagamento Pix...'); }
      }, 5000);
    }
    return () => clearInterval(interval);
  }, [paymentStep, pixData]);

  async function loadAddresses() {
    try {
      const response = await api.get('/addresses'); 
      setAddresses(response.data);
      if (response.data.length > 0) setSelectedAddressId(response.data[0].id);
    } catch (error) { console.log("Erro endereço"); }
  }

  function calculateDeliveryLogistics(neighborhood: string) {
    const bairro = neighborhood.toLowerCase();
    if (bairro.includes('centro') || bairro.includes('lapa') || bairro.includes('santa teresa')) return { fee: 5.00, time: '25-35 min' };
    if (bairro.includes('flamengo') || bairro.includes('botafogo') || bairro.includes('laranjeiras')) return { fee: 7.00, time: '35-45 min' };
    if (bairro.includes('copacabana') || bairro.includes('ipanema') || bairro.includes('leblon')) return { fee: 10.00, time: '50-60 min' };
    if (bairro.includes('tijuca') || bairro.includes('maracanã')) return { fee: 12.00, time: '50-60 min' };
    if (bairro.includes('barra') || bairro.includes('recreio')) return { fee: 20.00, time: '60-80 min' };
    return { fee: 15.00, time: '45-55 min' }; 
  }

  function groupAddons(addons: Addon[]) {
    const groups: Record<string, number> = {};
    addons.forEach(addon => { groups[addon.name] = (groups[addon.name] || 0) + 1; });
    return Object.entries(groups);
  }

  async function handleStartPix() {
    if (!validateOrder()) return;
    setLoading(true);
    try {
      const emailTeste = `cliente_teste_${Math.floor(Math.random() * 1000)}@test.com`;
      const { data } = await api.post('/payment/pix', {
        amount: totalFinal,
        email: emailTeste, 
        docNumber: '12345678909' 
      });
      setPixData({ qrCode: data.qr_code_base64, copyPaste: data.qr_code, id: data.id });
      setPaymentStep('PIX_WAIT');
    } catch (error) { toast.error('Erro ao gerar PIX. Tente novamente.'); } finally { setLoading(false); }
  }

  function handleCancelPix() {
    setPixData(null);
    setPaymentStep('FORM');
    toast.error('Pagamento Pix cancelado.');
  }

  async function handleFinishOrder(paymentId?: number, methodOverride?: string) {
    setErrorMsg('');
    if (!validateOrder()) return;

    setLoading(true);
    try {
      const payload = {
        items: cartItems.map(item => ({
          productId: Number(item.id), quantity: Number(item.quantity), observation: item.observation || "",
          addonIds: item.addons.map(a => a.id), meatPoint: item.meatPoint, removedIngredients: item.removedIngredients
        })),
        paymentMethod: paymentType === 'ONLINE' ? (methodOverride || 'CREDIT_CARD') : paymentMethod,
        type: orderType,
        ...(orderType === 'DELIVERY' ? { addressId: selectedAddressId } : {}),
        paymentId: paymentId,
        changeFor: (paymentType === 'OFFLINE' && paymentMethod === 'MONEY') ? changeFor : null
      };

      await api.post('/orders', payload);
      clearCart();
      toast.success('Pedido Realizado com Sucesso!');
      navigate('/order-success');
    } catch (error: any) {
      const msg = error.response?.data?.message || 'Erro ao processar pedido.';
      setErrorMsg(`❌ ${msg}`);
      toast.error(msg);
      if (paymentType === 'ONLINE') setPaymentStep('ERROR');
    } finally { setLoading(false); }
  }

  function validateOrder() {
    if (isStaff) { toast.error('Membros da equipe não podem realizar pedidos.'); return false; }
    if (!isAuthenticated) { setIsLoginModalOpen(true); return false; }
    if (orderType === 'DELIVERY' && !selectedAddressId) { 
      setErrorMsg('⚠️ Selecione um endereço para entrega.'); toast.error('Selecione um endereço.'); return false; 
    }
    if (paymentType === 'OFFLINE' && paymentMethod === 'MONEY') {
      const changeValue = currencyToNumber(changeFor);
      if (!changeValue || changeValue < totalFinal) {
        setErrorMsg('⚠️ O valor para troco deve ser maior que o total do pedido.'); toast.error('Valor do troco inválido.'); return false;
      }
    }
    return true;
  }

  const totalFinal = cartTotal + deliveryFee;

  if (cartItems.length === 0) return (
    <div className="flex flex-col items-center justify-center py-20 text-center space-y-4 animate-in fade-in">
      <div className="bg-gray-100 dark:bg-slate-800 p-6 rounded-full text-gray-400 dark:text-gray-500"><Store size={48} /></div>
      <h2 className="text-xl font-bold text-gray-800 dark:text-white">Seu carrinho está vazio</h2>
      <Link to="/" className="bg-orange-600 text-white px-6 py-2 rounded-xl font-bold hover:bg-orange-700 transition-colors">Ver Cardápio</Link>
    </div>
  );

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-40">
      
      {isStaff && (
        <div className="bg-red-100 dark:bg-red-900/30 border-l-4 border-red-500 text-red-700 dark:text-red-400 p-4 rounded shadow-sm flex items-start gap-3">
          <ShieldAlert size={24} className="shrink-0" />
          <div>
            <p className="font-bold">Modo Administrativo</p>
            <p className="text-sm">Você está logado como membro da equipe. A realização de pedidos está bloqueada.</p>
          </div>
        </div>
      )}

      <h1 className="text-2xl font-bold text-gray-800 dark:text-white">Carrinho</h1>

      <div className="space-y-4">
        {cartItems.map((item) => {
          const addonsSum = item.addons.reduce((sum, a) => sum + Number(a.price), 0);
          const unitPrice = Number(item.price) + addonsSum;
          const groupedAddonsList = groupAddons(item.addons);

          return (
            <div key={item.cartId} className="bg-white dark:bg-slate-900 p-4 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 flex gap-4 transition-colors">
              <div className="w-20 h-20 bg-gray-100 dark:bg-slate-800 rounded-xl overflow-hidden flex-shrink-0">
                 {item.image && <img src={`http://localhost:3000/uploads/${item.image}`} className="w-full h-full object-cover" />}
              </div>
              <div className="flex-1 flex flex-col justify-between">
                <div>
                  <div className="flex justify-between items-start">
                    <h3 className="font-bold text-gray-800 dark:text-white">{item.name}</h3>
                    <button onClick={() => removeFromCart(item.cartId)} className="text-gray-400 hover:text-red-500 transition-colors"><Trash2 size={16} /></button>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 space-y-0.5">
                    {item.meatPoint && <p className="text-orange-600 dark:text-orange-400 font-medium">🔥 {item.meatPoint}</p>}
                    {groupedAddonsList.length > 0 && (
                      <p className="text-green-600 dark:text-green-400 font-medium">
                        ✨ + {groupedAddonsList.map(([name, qtd]) => `${qtd}x ${name}`).join(', ')}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex justify-between items-center mt-3">
                  <span className="font-bold text-gray-800 dark:text-white">
                    {unitPrice.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                  </span>
                  <div className="flex items-center gap-3 bg-gray-50 dark:bg-slate-800 rounded-lg p-1 border border-gray-200 dark:border-slate-700">
                    <button onClick={() => updateQuantity(item.cartId, -1)} className="p-1 hover:bg-white dark:hover:bg-slate-700 rounded shadow-sm text-gray-600 dark:text-gray-300"><Minus size={14} /></button>
                    <span className="text-sm font-bold w-4 text-center dark:text-white">{item.quantity}</span>
                    <button onClick={() => updateQuantity(item.cartId, 1)} className="p-1 hover:bg-white dark:hover:bg-slate-700 rounded shadow-sm text-green-600 dark:text-green-400"><Plus size={14} /></button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 space-y-4 transition-colors">
        <div className="flex justify-between items-center">
           <h3 className="font-bold text-gray-800 dark:text-white flex items-center gap-2">
             {orderType === 'DELIVERY' ? <MapPin size={18} className="text-orange-600" /> : <Store size={18} className="text-orange-600" />}
             {orderType === 'DELIVERY' ? 'Entrega' : 'Retirada na Loja'}
           </h3>
           <span className="text-xs font-bold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 px-2 py-1 rounded-lg flex items-center gap-1">
             <Clock size={14} /> {estimatedTime}
           </span>
        </div>
        
        <div className="grid grid-cols-2 gap-3">
          <button onClick={() => setOrderType('TAKEOUT')} className={`p-3 rounded-xl border-2 text-sm font-bold transition-all ${orderType === 'TAKEOUT' ? 'border-orange-500 bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400' : 'border-gray-100 dark:border-slate-700 text-gray-500 dark:text-gray-400'}`}>Retirada</button>
          <button onClick={() => setOrderType('DELIVERY')} className={`p-3 rounded-xl border-2 text-sm font-bold transition-all ${orderType === 'DELIVERY' ? 'border-orange-500 bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400' : 'border-gray-100 dark:border-slate-700 text-gray-500 dark:text-gray-400'}`}>Delivery</button>
        </div>

        <div className="mt-4">
          {orderType === 'TAKEOUT' ? (
            <div className="bg-orange-50 dark:bg-slate-800 border border-orange-100 dark:border-slate-700 rounded-xl p-4 flex items-start gap-3">
              <div className="bg-white dark:bg-slate-700 p-2 rounded-full text-orange-600 shadow-sm"><Store size={20} /></div>
              <div>
                <p className="text-sm font-bold text-gray-800 dark:text-white">TorresBurgers - Matriz</p>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{STORE_ADDRESS.street}, {STORE_ADDRESS.number}</p>
                <a className="inline-flex items-center gap-1 text-xs font-bold text-orange-600 dark:text-orange-400 mt-2 hover:underline"><Navigation size={12} /> Ver no Mapa</a>
              </div>
            </div>
          ) : (
            <>
              {addresses.length > 0 ? (
                <div className="space-y-3">
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Selecione o Endereço:</p>
                  {addresses.map(addr => (
                    <label key={addr.id} className={`flex items-start gap-3 p-3 rounded-xl border-2 cursor-pointer transition-all ${selectedAddressId === addr.id ? 'border-orange-500 bg-orange-50 dark:bg-orange-900/10' : 'border-gray-100 dark:border-slate-700 hover:border-gray-200 dark:hover:border-slate-600'}`}>
                      <input type="radio" name="address" checked={selectedAddressId === addr.id} onChange={() => setSelectedAddressId(addr.id)} className="mt-1 text-orange-600 focus:ring-orange-500"/>
                      <div className="text-sm flex-1">
                        <p className="font-bold text-gray-800 dark:text-white">{addr.street}, {addr.number}</p>
                        <p className="text-gray-500 dark:text-gray-400">{addr.neighborhood} - {addr.city}</p>
                      </div>
                    </label>
                  ))}
                  <button onClick={() => setIsAddressModalOpen(true)} className="w-full py-2 text-sm text-orange-600 dark:text-orange-400 font-bold hover:bg-orange-50 dark:hover:bg-slate-800 rounded-lg border border-dashed border-orange-300 dark:border-slate-600">+ Novo Endereço</button>
                </div>
              ) : (
                <div className="text-center p-4 bg-gray-50 dark:bg-slate-800 rounded-xl border border-dashed border-gray-300 dark:border-slate-700">
                  <button onClick={() => setIsAddressModalOpen(true)} className="bg-gray-800 dark:bg-slate-700 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 mx-auto hover:bg-gray-900 transition-colors"><Plus size={16} /> Cadastrar Endereço</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="bg-white dark:bg-slate-900 p-5 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-800 space-y-4 transition-colors">
        <h3 className="font-bold text-gray-800 dark:text-white">Pagamento</h3>
        
        <div className={`flex p-1 bg-gray-100 dark:bg-slate-800 rounded-xl mb-4 ${isStaff ? 'opacity-50 pointer-events-none' : ''}`}>
           <button onClick={() => setPaymentType('ONLINE')} className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${paymentType === 'ONLINE' ? 'bg-white dark:bg-slate-700 shadow-sm text-orange-600 dark:text-orange-400' : 'text-gray-500 dark:text-gray-400'}`}>Pagar Agora (Online)</button>
           <button onClick={() => setPaymentType('OFFLINE')} className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${paymentType === 'OFFLINE' ? 'bg-white dark:bg-slate-700 shadow-sm text-orange-600 dark:text-orange-400' : 'text-gray-500 dark:text-gray-400'}`}>Pagar na Entrega</button>
        </div>

        {paymentType === 'ONLINE' ? (
          <div className="animate-in fade-in space-y-6">
             <div className="flex gap-4 border-b border-gray-100 dark:border-slate-800 pb-2">
                <button 
                  onClick={() => { setPaymentMethod('CREDIT_CARD'); setPaymentStep('FORM'); }}
                  disabled={isStaff}
                  className={`pb-2 text-sm font-bold transition-all border-b-2 ${paymentMethod === 'CREDIT_CARD' ? 'border-orange-500 text-orange-600 dark:text-orange-400' : 'border-transparent text-gray-400 dark:text-gray-500'}`}
                >
                  Cartão de Crédito
                </button>
                <button 
                  onClick={() => { setPaymentMethod('PIX'); setPaymentStep('FORM'); }}
                  disabled={isStaff}
                  className={`pb-2 text-sm font-bold transition-all border-b-2 ${paymentMethod === 'PIX' ? 'border-orange-500 text-orange-600 dark:text-orange-400' : 'border-transparent text-gray-400 dark:text-gray-500'}`}
                >
                  PIX
                </button>
             </div>

             {paymentMethod === 'CREDIT_CARD' ? (
               <PaymentForm 
                 total={totalFinal} 
                 email={user?.email || 'cliente@email.com'}
                 setLoading={setLoading}
                 onSuccess={(pid) => handleFinishOrder(pid, 'CREDIT_CARD')}
               />
             ) : (
               paymentStep === 'PIX_WAIT' && pixData ? (
                 <PixCheckout qrCode={pixData.qrCode} copyPaste={pixData.copyPaste} onExpired={handleCancelPix} />
               ) : (
                 <div className="text-center py-6">
                   <p className="text-gray-500 dark:text-gray-400 mb-4">Gere um código PIX para pagar com segurança.</p>
                   <button onClick={handleStartPix} disabled={loading || isStaff} className="bg-green-600 text-white font-bold px-6 py-3 rounded-xl hover:bg-green-700 transition-all flex items-center gap-2 mx-auto disabled:opacity-50">
                     {loading ? 'Gerando...' : 'Gerar QR Code PIX'}
                   </button>
                 </div>
               )
             )}
          </div>
        ) : (
          <div className="animate-in fade-in space-y-4">
             <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Forma de Pagamento</label>
                <select 
                  value={paymentMethod} 
                  onChange={e => setPaymentMethod(e.target.value as any)} 
                  disabled={isStaff}
                  className="w-full p-3 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl outline-none focus:border-orange-500 dark:text-white disabled:opacity-50"
                >
                  <option value="CREDIT_CARD">Cartão (Maquininha)</option>
                  <option value="MONEY">Dinheiro</option>
                </select>
             </div>

             {paymentMethod === 'MONEY' && (
               <div className="bg-orange-50 dark:bg-slate-800 p-4 rounded-xl border border-orange-100 dark:border-slate-700 animate-in slide-in-from-top-2">
                 <label className="block text-sm font-bold text-gray-700 dark:text-white mb-2 flex items-center gap-2">
                   <Banknote size={18} className="text-green-600 dark:text-green-400"/> 
                   Troco para quanto?
                 </label>
                 <input 
                   type="text"
                   value={changeFor}
                   onChange={(e) => setChangeFor(maskMoney(e.target.value))}
                   disabled={isStaff}
                   placeholder="R$ 0,00"
                   className="w-full p-3 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-600 rounded-lg font-bold text-lg text-gray-800 dark:text-white focus:ring-2 focus:ring-orange-500 outline-none"
                 />
                 <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                   O total do pedido é <b>{totalFinal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</b>.
                 </p>
               </div>
             )}
          </div>
        )}
      </div>

      {(paymentType === 'OFFLINE' || (paymentType === 'ONLINE' && paymentMethod === 'PIX' && paymentStep === 'FORM')) && (
        <div className="fixed bottom-0 left-0 right-0 bg-white dark:bg-slate-900 border-t border-gray-100 dark:border-slate-800 p-4 lg:p-6 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] dark:shadow-none z-40 transition-colors">
          <div className="max-w-2xl mx-auto space-y-3">
            {errorMsg && <div className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 p-3 rounded-lg text-sm flex items-center gap-2 animate-bounce"><AlertCircle size={18} />{errorMsg}</div>}
            
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400 font-medium uppercase">Total a pagar</p>
                <p className="text-2xl font-bold text-gray-800 dark:text-white">{totalFinal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</p>
              </div>
              
              {paymentType === 'OFFLINE' && (
                <button 
                  onClick={() => handleFinishOrder()} 
                  disabled={loading || isStaff} 
                  className={`px-8 py-3 rounded-xl font-bold transition-colors flex items-center gap-2 ${isStaff ? 'bg-gray-300 dark:bg-slate-700 text-gray-500 dark:text-gray-400 cursor-not-allowed' : 'bg-green-600 text-white hover:bg-green-700 disabled:opacity-50'}`}
                >
                  {isStaff ? 'Bloqueado (Staff)' : (loading ? 'Processando...' : 'Finalizar Pedido')}
                  {!loading && !isStaff && <ArrowRight size={20} />}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <AddressModal isOpen={isAddressModalOpen} onClose={() => setIsAddressModalOpen(false)} onSuccess={loadAddresses}/>
      <ConfirmModal isOpen={isLoginModalOpen} onClose={() => setIsLoginModalOpen(false)} onConfirm={() => navigate('/signin')} title="Faça Login" message="Para finalizar seu pedido, você precisa se identificar." confirmLabel="Entrar"/>
    </div>
  );
}