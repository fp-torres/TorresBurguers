import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Trash2, ArrowRight, MapPin, Store, Plus, AlertCircle, CreditCard, Clock } from 'lucide-react';
import { useCart } from '../../../contexts/CartContext';
import { useAuth } from '../../../contexts/AuthContext';
import api from '../../../services/api';
import AddressModal from '../../../components/AddressModal';

export default function ClientCart() {
  const { cartItems, removeFromCart, clearCart, cartTotal } = useCart();
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();
  
  const [orderType, setOrderType] = useState<'DELIVERY' | 'TAKEOUT'>('TAKEOUT');
  const [paymentType, setPaymentType] = useState<'ONLINE' | 'OFFLINE'>('OFFLINE'); 
  const [paymentMethod, setPaymentMethod] = useState('PIX'); 
  const [loading, setLoading] = useState(false);
  
  const [addresses, setAddresses] = useState<any[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<number | null>(null);
  const [isAddressModalOpen, setIsAddressModalOpen] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // Simulação de Tempo Estimado
  const [estimatedTime, setEstimatedTime] = useState('15-20 min');

  useEffect(() => {
    if (isAuthenticated) loadAddresses();
  }, [isAuthenticated]);

  useEffect(() => {
    // Recalcula tempo quando muda tipo ou endereço
    if (orderType === 'TAKEOUT') {
      setEstimatedTime('15-20 min (Retirada)');
    } else if (selectedAddressId) {
      setEstimatedTime('40-50 min (Delivery)');
    } else {
      setEstimatedTime('--');
    }
  }, [orderType, selectedAddressId]);

  async function loadAddresses() {
    try {
      const response = await api.get('/addresses'); 
      setAddresses(response.data);
      if (response.data.length > 0) setSelectedAddressId(response.data[0].id);
    } catch (error) { console.log("Erro endereço"); }
  }

  async function handleFinishOrder() {
    setErrorMsg('');
    if (!isAuthenticated) {
      if(confirm('Faça login para finalizar.')) navigate('/signin');
      return;
    }
    if (orderType === 'DELIVERY' && !selectedAddressId) {
      setErrorMsg('⚠️ Selecione um endereço para entrega.');
      return;
    }

    setLoading(true);
    try {
      if (paymentType === 'ONLINE') await new Promise(resolve => setTimeout(resolve, 1500)); 

      const payload = {
        items: cartItems.map(item => ({
          productId: Number(item.id),
          quantity: Number(item.quantity),
          observation: item.observation || "",
          addonIds: [] 
        })),
        paymentMethod: paymentType === 'ONLINE' ? 'CREDIT_CARD' : paymentMethod,
        type: orderType,
        ...(orderType === 'DELIVERY' ? { addressId: selectedAddressId } : {}) 
      };

      await api.post('/orders', payload);
      clearCart();
      navigate('/order-success'); 
    } catch (error: any) {
      const msg = error.response?.data?.message || 'Erro ao processar pedido.';
      setErrorMsg(`❌ ${msg}`);
    } finally {
      setLoading(false);
    }
  }

  if (cartItems.length === 0) return (
    <div className="flex flex-col items-center justify-center py-20 text-center space-y-4 animate-in fade-in">
      <div className="bg-gray-100 p-6 rounded-full text-gray-400"><Store size={48} /></div>
      <h2 className="text-xl font-bold text-gray-800">Seu carrinho está vazio</h2>
      <Link to="/" className="bg-orange-600 text-white px-6 py-2 rounded-xl font-bold hover:bg-orange-700 transition-colors">Ver Cardápio</Link>
    </div>
  );

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-32">
      <h1 className="text-2xl font-bold text-gray-800">Finalizar Pedido</h1>

      {/* Itens */}
      <div className="space-y-4">
        {cartItems.map((item) => (
          <div key={item.cartId} className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex gap-4">
            <div className="w-20 h-20 bg-gray-100 rounded-xl overflow-hidden flex-shrink-0">
               {item.image && <img src={`http://localhost:3000/uploads/${item.image}`} className="w-full h-full object-cover" />}
            </div>
            <div className="flex-1 flex flex-col justify-between">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-bold text-gray-800">{item.name}</h3>
                  {item.observation && <p className="text-xs text-gray-500 italic">Obs: {item.observation}</p>}
                </div>
                <button onClick={() => removeFromCart(item.cartId)} className="text-red-400 hover:text-red-600 p-1"><Trash2 size={18} /></button>
              </div>
              <div className="flex justify-between items-center mt-2">
                <span className="font-bold text-green-700">{Number(item.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</span>
                <span className="text-xs font-bold text-gray-600 bg-gray-100 px-2 py-1 rounded-lg">{item.quantity}x</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Entrega e Tempo Estimado */}
      <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 space-y-4">
        <div className="flex justify-between items-center">
           <h3 className="font-bold text-gray-800 flex items-center gap-2"><MapPin size={18} className="text-orange-600" /> Entrega</h3>
           <span className="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-1 rounded-lg flex items-center gap-1">
             <Clock size={14} /> {estimatedTime}
           </span>
        </div>
        
        <div className="grid grid-cols-2 gap-3">
          <button onClick={() => setOrderType('TAKEOUT')} className={`p-3 rounded-xl border-2 text-sm font-bold transition-all ${orderType === 'TAKEOUT' ? 'border-orange-500 bg-orange-50 text-orange-700' : 'border-gray-100 text-gray-500'}`}>Retirada</button>
          <button onClick={() => setOrderType('DELIVERY')} className={`p-3 rounded-xl border-2 text-sm font-bold transition-all ${orderType === 'DELIVERY' ? 'border-orange-500 bg-orange-50 text-orange-700' : 'border-gray-100 text-gray-500'}`}>Delivery</button>
        </div>

        {orderType === 'DELIVERY' && (
          <div className="mt-4 animate-in slide-in-from-top-2">
            {addresses.length > 0 ? (
              <div className="space-y-3">
                <p className="text-sm font-medium text-gray-700">Endereço:</p>
                {addresses.map(addr => (
                  <label key={addr.id} className={`flex items-start gap-3 p-3 rounded-xl border-2 cursor-pointer transition-all ${selectedAddressId === addr.id ? 'border-orange-500 bg-orange-50' : 'border-gray-100 hover:border-gray-200'}`}>
                    <input type="radio" name="address" checked={selectedAddressId === addr.id} onChange={() => setSelectedAddressId(addr.id)} className="mt-1 text-orange-600 focus:ring-orange-500"/>
                    <div className="text-sm">
                      <p className="font-bold text-gray-800">{addr.street}, {addr.number}</p>
                      <p className="text-gray-500">{addr.neighborhood} - {addr.city}</p>
                    </div>
                  </label>
                ))}
                <button onClick={() => setIsAddressModalOpen(true)} className="w-full py-2 text-sm text-orange-600 font-bold hover:bg-orange-50 rounded-lg border border-dashed border-orange-300">+ Novo Endereço</button>
              </div>
            ) : (
              <div className="text-center p-4 bg-gray-50 rounded-xl border border-dashed border-gray-300">
                <button onClick={() => setIsAddressModalOpen(true)} className="bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 mx-auto hover:bg-gray-900 transition-colors"><Plus size={16} /> Cadastrar Endereço</button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pagamento */}
      <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 space-y-4">
        <h3 className="font-bold text-gray-800">Pagamento</h3>
        
        <div className="flex p-1 bg-gray-100 rounded-xl mb-4">
           <button onClick={() => setPaymentType('ONLINE')} className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${paymentType === 'ONLINE' ? 'bg-white shadow-sm text-orange-600' : 'text-gray-500'}`}>Pagar Agora (Online)</button>
           <button onClick={() => setPaymentType('OFFLINE')} className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${paymentType === 'OFFLINE' ? 'bg-white shadow-sm text-orange-600' : 'text-gray-500'}`}>Pagar na Entrega</button>
        </div>

        {paymentType === 'ONLINE' ? (
          <div className="animate-in fade-in space-y-3">
             <div className="p-4 border border-orange-200 bg-orange-50 rounded-xl">
                <div className="flex items-center gap-3 mb-3">
                   <CreditCard className="text-orange-600"/>
                   <span className="font-bold text-gray-800">Cartão de Crédito</span>
                </div>
                <input placeholder="Número do Cartão" className="w-full mb-2 p-2 rounded border border-gray-300 text-sm" disabled />
                <div className="flex gap-2">
                   <input placeholder="MM/AA" className="w-1/2 p-2 rounded border border-gray-300 text-sm" disabled />
                   <input placeholder="CVV" className="w-1/2 p-2 rounded border border-gray-300 text-sm" disabled />
                </div>
                <p className="text-xs text-orange-600 mt-2 font-bold">* Ambiente de teste: Nenhum valor será cobrado.</p>
             </div>
          </div>
        ) : (
          <div className="animate-in fade-in">
             <label className="block text-sm font-medium text-gray-700 mb-2">Como você vai pagar?</label>
             <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)} className="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:border-orange-500">
               <option value="PIX">PIX (Chave na entrega)</option>
               <option value="CREDIT_CARD">Maquininha de Cartão</option>
               <option value="MONEY">Dinheiro (Levar troco)</option>
             </select>
          </div>
        )}
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-100 p-4 lg:p-6 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] z-40">
        <div className="max-w-2xl mx-auto space-y-3">
          {errorMsg && <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm flex items-center gap-2 animate-bounce"><AlertCircle size={18} />{errorMsg}</div>}
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs text-gray-500 font-medium uppercase">Total a pagar</p>
              <p className="text-2xl font-bold text-gray-800">{cartTotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</p>
            </div>
            <button onClick={handleFinishOrder} disabled={loading} className="bg-green-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-green-700 transition-colors flex items-center gap-2 disabled:opacity-50">
              {loading ? 'Processando...' : 'Finalizar Pedido'}
              {!loading && <ArrowRight size={20} />}
            </button>
          </div>
        </div>
      </div>

      <AddressModal isOpen={isAddressModalOpen} onClose={() => setIsAddressModalOpen(false)} onSuccess={loadAddresses}/>
    </div>
  );
}