import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { 
  Trash2, ArrowRight, MapPin, Store, Plus, Minus, 
  AlertCircle, CreditCard, Clock, Navigation, ShieldAlert, LogIn 
} from 'lucide-react';
import { useCart, type Addon } from '../../../contexts/CartContext';
import { useAuth } from '../../../contexts/AuthContext';
import api from '../../../services/api';
import AddressModal from '../../../components/AddressModal';
import ConfirmModal from '../../../components/ConfirmModal'; // <--- IMPORT NOVO

// Endereço Fictício da Loja
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
  const { isAuthenticated, user } = useAuth(); // Pegamos user para verificar role
  const navigate = useNavigate();
  
  const [orderType, setOrderType] = useState<'DELIVERY' | 'TAKEOUT'>('TAKEOUT');
  const [paymentType, setPaymentType] = useState<'ONLINE' | 'OFFLINE'>('OFFLINE'); 
  const [paymentMethod, setPaymentMethod] = useState('PIX'); 
  const [loading, setLoading] = useState(false);
  
  const [addresses, setAddresses] = useState<AddressData[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<number | null>(null);
  const [isAddressModalOpen, setIsAddressModalOpen] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // Estados de cálculo
  const [deliveryFee, setDeliveryFee] = useState(0);
  const [estimatedTime, setEstimatedTime] = useState('15-20 min');

  // Estado para o Modal de Login
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);

  // Verifica se é equipe (Admin, Cozinha, Motoboy)
  const isStaff = user && user.role !== 'CLIENT';

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

  async function handleFinishOrder() {
    setErrorMsg('');
    
    // Bloqueio de Equipe
    if (isStaff) {
      setErrorMsg('🚫 Membros da equipe não podem realizar pedidos.');
      return;
    }

    // Validação de Login com Modal
    if (!isAuthenticated) {
      setIsLoginModalOpen(true);
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
          addonIds: item.addons.map(a => a.id),
          meatPoint: item.meatPoint,
          removedIngredients: item.removedIngredients
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

  const totalFinal = cartTotal + deliveryFee;

  if (cartItems.length === 0) return (
    <div className="flex flex-col items-center justify-center py-20 text-center space-y-4 animate-in fade-in">
      <div className="bg-gray-100 p-6 rounded-full text-gray-400"><Store size={48} /></div>
      <h2 className="text-xl font-bold text-gray-800">Seu carrinho está vazio</h2>
      <Link to="/" className="bg-orange-600 text-white px-6 py-2 rounded-xl font-bold hover:bg-orange-700 transition-colors">Ver Cardápio</Link>
    </div>
  );

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-40">
      <h1 className="text-2xl font-bold text-gray-800">Carrinho</h1>

      {/* ALERTA DE EQUIPE (Somente Staff) */}
      {isStaff && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3 animate-pulse">
          <ShieldAlert className="text-red-600 mt-0.5" size={20} />
          <div>
            <h3 className="font-bold text-red-700">Modo Visualização (Equipe)</h3>
            <p className="text-sm text-red-600 mt-1">A finalização de pedidos está desabilitada para contas administrativas e operacionais.</p>
          </div>
        </div>
      )}

      {/* Lista de Itens */}
      <div className="space-y-4">
        {cartItems.map((item) => {
          const addonsSum = item.addons.reduce((sum, a) => sum + Number(a.price), 0);
          const unitPrice = Number(item.price) + addonsSum;
          const groupedAddonsList = groupAddons(item.addons);

          return (
            <div key={item.cartId} className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex gap-4">
              <div className="w-20 h-20 bg-gray-100 rounded-xl overflow-hidden flex-shrink-0">
                 {item.image && <img src={`http://localhost:3000/uploads/${item.image}`} className="w-full h-full object-cover" />}
              </div>
              
              <div className="flex-1 flex flex-col justify-between">
                <div>
                  <div className="flex justify-between items-start">
                    <h3 className="font-bold text-gray-800">{item.name}</h3>
                    <button onClick={() => removeFromCart(item.cartId)} className="text-gray-400 hover:text-red-500 transition-colors"><Trash2 size={16} /></button>
                  </div>

                  <div className="text-xs text-gray-500 mt-1 space-y-0.5">
                    {item.meatPoint && <p className="text-orange-600 font-medium">🔥 {item.meatPoint}</p>}
                    {item.removedIngredients.length > 0 && (
                      <p className="text-red-500">🚫 Sem: {item.removedIngredients.join(', ')}</p>
                    )}
                    {groupedAddonsList.length > 0 && (
                      <p className="text-green-600 font-medium">
                        ✨ + {groupedAddonsList.map(([name, qtd]) => `${qtd}x ${name}`).join(', ')}
                      </p>
                    )}
                    {item.observation && <p className="italic text-gray-400">"{item.observation}"</p>}
                  </div>
                </div>

                <div className="flex justify-between items-center mt-3">
                  <span className="font-bold text-gray-800">
                    {unitPrice.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                  </span>
                  
                  <div className="flex items-center gap-3 bg-gray-50 rounded-lg p-1 border border-gray-200">
                    <button onClick={() => updateQuantity(item.cartId, -1)} className="p-1 hover:bg-white rounded shadow-sm text-gray-600"><Minus size={14} /></button>
                    <span className="text-sm font-bold w-4 text-center">{item.quantity}</span>
                    <button onClick={() => updateQuantity(item.cartId, 1)} className="p-1 hover:bg-white rounded shadow-sm text-green-600"><Plus size={14} /></button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Entrega e Endereço */}
      <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 space-y-4">
        <div className="flex justify-between items-center">
           <h3 className="font-bold text-gray-800 flex items-center gap-2">
             {orderType === 'DELIVERY' ? <MapPin size={18} className="text-orange-600" /> : <Store size={18} className="text-orange-600" />}
             {orderType === 'DELIVERY' ? 'Entrega' : 'Retirada na Loja'}
           </h3>
           <span className="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-1 rounded-lg flex items-center gap-1">
             <Clock size={14} /> {estimatedTime}
           </span>
        </div>
        
        <div className="grid grid-cols-2 gap-3">
          <button onClick={() => setOrderType('TAKEOUT')} className={`p-3 rounded-xl border-2 text-sm font-bold transition-all ${orderType === 'TAKEOUT' ? 'border-orange-500 bg-orange-50 text-orange-700' : 'border-gray-100 text-gray-500'}`}>Retirada</button>
          <button onClick={() => setOrderType('DELIVERY')} className={`p-3 rounded-xl border-2 text-sm font-bold transition-all ${orderType === 'DELIVERY' ? 'border-orange-500 bg-orange-50 text-orange-700' : 'border-gray-100 text-gray-500'}`}>Delivery</button>
        </div>

        <div className="mt-4 animate-in slide-in-from-top-2">
          {orderType === 'TAKEOUT' ? (
            <div className="bg-orange-50 border border-orange-100 rounded-xl p-4 flex items-start gap-3">
              <div className="bg-white p-2 rounded-full text-orange-600 shadow-sm">
                <Store size={20} />
              </div>
              <div>
                <p className="text-sm font-bold text-gray-800">TorresBurgers - Matriz</p>
                <p className="text-sm text-gray-600 mt-1">{STORE_ADDRESS.street}, {STORE_ADDRESS.number}</p>
                <p className="text-sm text-gray-600">{STORE_ADDRESS.neighborhood} - {STORE_ADDRESS.city}/{STORE_ADDRESS.state}</p>
                
                <a 
                  href={`https://maps.google.com/?q=${STORE_ADDRESS.street},${STORE_ADDRESS.number},${STORE_ADDRESS.city}`} 
                  target="_blank" 
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-bold text-orange-600 mt-2 hover:underline"
                >
                  <Navigation size={12} /> Ver no Mapa
                </a>
              </div>
            </div>
          ) : (
            <>
              {addresses.length > 0 ? (
                <div className="space-y-3">
                  <p className="text-sm font-medium text-gray-700">Selecione o Endereço:</p>
                  {addresses.map(addr => (
                    <label key={addr.id} className={`flex items-start gap-3 p-3 rounded-xl border-2 cursor-pointer transition-all ${selectedAddressId === addr.id ? 'border-orange-500 bg-orange-50' : 'border-gray-100 hover:border-gray-200'}`}>
                      <input type="radio" name="address" checked={selectedAddressId === addr.id} onChange={() => setSelectedAddressId(addr.id)} className="mt-1 text-orange-600 focus:ring-orange-500"/>
                      <div className="text-sm flex-1">
                        <p className="font-bold text-gray-800">{addr.street}, {addr.number}</p>
                        <p className="text-gray-500">{addr.neighborhood} - {addr.city}</p>
                        {selectedAddressId === addr.id && (
                          <p className="text-xs text-blue-600 font-bold mt-1">
                            Tempo estimado: {calculateDeliveryLogistics(addr.neighborhood).time}
                          </p>
                        )}
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
            </>
          )}
        </div>
      </div>

      {/* Pagamento */}
      <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 space-y-4">
        <h3 className="font-bold text-gray-800">Pagamento</h3>
        <div className="flex p-1 bg-gray-100 rounded-xl mb-4">
           <button onClick={() => setPaymentType('ONLINE')} className={`flex-1 py-2 text-sm font-bold rounded-lg transition-all ${paymentType === 'ONLINE' ? 'bg-white shadow-sm text-orange-600' : 'text-gray-500'}`}>Pagar Agora</button>
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
                <p className="text-xs text-orange-600 mt-2 font-bold">* Ambiente de teste: Nenhum valor será cobrado.</p>
             </div>
          </div>
        ) : (
          <div className="animate-in fade-in">
             <label className="block text-sm font-medium text-gray-700 mb-2">Forma de Pagamento</label>
             <select value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)} className="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:border-orange-500">
               <option value="PIX">PIX</option>
               <option value="CREDIT_CARD">Cartão (Maquininha)</option>
               <option value="MONEY">Dinheiro</option>
             </select>
          </div>
        )}
      </div>

      {/* RODAPÉ FIXO */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-100 p-4 lg:p-6 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] z-40">
        <div className="max-w-2xl mx-auto space-y-3">
          
          {errorMsg && <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm flex items-center gap-2 animate-bounce"><AlertCircle size={18} />{errorMsg}</div>}
          
          <div className="space-y-1 pb-3 border-b border-gray-100 text-sm">
            <div className="flex justify-between text-gray-500">
              <span>Subtotal</span>
              <span>{cartTotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</span>
            </div>
            <div className="flex justify-between text-gray-500">
              <span className="flex items-center gap-1">
                {orderType === 'DELIVERY' ? <MapPin size={12}/> : <Store size={12}/>} 
                {orderType === 'DELIVERY' ? 'Taxa de Entrega' : 'Taxa de Retirada'}
              </span>
              <span className={deliveryFee > 0 ? 'text-gray-800' : 'text-green-600 font-bold'}>
                {deliveryFee > 0 ? deliveryFee.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : 'Grátis'}
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs text-gray-500 font-medium uppercase">Total a pagar</p>
              <p className="text-2xl font-bold text-gray-800">{totalFinal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</p>
            </div>
            
            <button 
              onClick={handleFinishOrder} 
              disabled={loading || Boolean(isStaff)} // Desabilita se for staff
              className={`px-8 py-3 rounded-xl font-bold transition-colors flex items-center gap-2 ${isStaff ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-green-600 text-white hover:bg-green-700 disabled:opacity-50'}`}
            >
              {isStaff ? 'Bloqueado (Staff)' : (loading ? 'Processando...' : 'Finalizar Pedido')}
              {!loading && !isStaff && <ArrowRight size={20} />}
            </button>
          </div>
        </div>
      </div>

      <AddressModal isOpen={isAddressModalOpen} onClose={() => setIsAddressModalOpen(false)} onSuccess={loadAddresses}/>
      
      {/* MODAL DE LOGIN SUBSTITUINDO O ALERT */}
      <ConfirmModal 
        isOpen={isLoginModalOpen}
        onClose={() => setIsLoginModalOpen(false)}
        onConfirm={() => navigate('/signin')}
        title="Faça Login"
        message="Para finalizar seu pedido, você precisa se identificar. Deseja fazer login agora?"
        confirmLabel="Entrar na Conta"
      />
    </div>
  );
}