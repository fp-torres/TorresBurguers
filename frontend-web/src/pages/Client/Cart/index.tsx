import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Trash2, ArrowRight, MapPin, Store } from 'lucide-react';
import { useCart } from '../../../contexts/CartContext';
import { useAuth } from '../../../contexts/AuthContext'; // <--- Importe
import api from '../../../services/api';

export default function ClientCart() {
  const { cartItems, removeFromCart, clearCart, cartTotal } = useCart();
  const { isAuthenticated } = useAuth(); // <--- Use o estado global
  const navigate = useNavigate();
  
  const [orderType, setOrderType] = useState<'DELIVERY' | 'TAKEOUT'>('TAKEOUT');
  const [paymentMethod, setPaymentMethod] = useState('PIX');
  const [loading, setLoading] = useState(false);

  async function handleFinishOrder() {
    // 1. Verifica login via Contexto (Mais seguro)
    if (!isAuthenticated) {
      if(confirm('Você precisa estar logado para finalizar o pedido. Deseja entrar agora?')) {
        navigate('/signin');
      }
      return;
    }
    
    if (cartItems.length === 0) return;

    setLoading(true);
    try {
      const payload = {
        items: cartItems.map(item => ({
          productId: Number(item.id),
          quantity: Number(item.quantity),
          observation: item.observation || "",
          addonIds: [] 
        })),
        paymentMethod,
        type: orderType,
        // Só envia addressId se for Delivery
        ...(orderType === 'DELIVERY' ? { addressId: 1 } : {}) 
      };

      console.log("Enviando Pedido:", payload);
      await api.post('/orders', payload);
      alert('Pedido enviado com sucesso! 🍔');
      clearCart();
      navigate('/'); 
    } catch (error: any) {
      console.error("Erro ao enviar pedido:", error.response?.data);
      const errorMsg = error.response?.data?.message || 'Erro ao processar pedido.';
      
      if (typeof errorMsg === 'string' && errorMsg.includes('address')) {
         alert('Atenção: Seu usuário ainda não tem endereço cadastrado. Por favor, escolha "Retirada no Balcão" para testar.');
      } else {
         alert(`Não foi possível enviar: ${Array.isArray(errorMsg) ? errorMsg[0] : errorMsg}`);
      }
    } finally {
      setLoading(false);
    }
  }

  // --- Renderização: Carrinho Vazio ---
  if (cartItems.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
        <div className="bg-gray-100 p-6 rounded-full text-gray-400">
          <Store size={48} />
        </div>
        <h2 className="text-xl font-bold text-gray-800">Seu carrinho está vazio</h2>
        <p className="text-gray-500">Que tal adicionar um burger suculento?</p>
        <Link to="/" className="bg-orange-600 text-white px-6 py-2 rounded-xl font-bold hover:bg-orange-700 transition-colors">
          Ver Cardápio
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-24">
      <h1 className="text-2xl font-bold text-gray-800">Seu Pedido</h1>

      {/* Lista de Itens */}
      <div className="space-y-4">
        {cartItems.map((item) => (
          <div key={item.cartId} className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 flex gap-4 animate-in slide-in-from-bottom-2">
            <div className="w-20 h-20 bg-gray-100 rounded-xl overflow-hidden flex-shrink-0">
               {item.image && <img src={`http://localhost:3000/uploads/${item.image}`} className="w-full h-full object-cover" />}
            </div>

            <div className="flex-1 flex flex-col justify-between">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-bold text-gray-800">{item.name}</h3>
                  {item.observation && <p className="text-xs text-gray-500 italic">Obs: {item.observation}</p>}
                </div>
                <button onClick={() => removeFromCart(item.cartId)} className="text-red-400 hover:text-red-600 p-1">
                  <Trash2 size={18} />
                </button>
              </div>

              <div className="flex justify-between items-center mt-2">
                <span className="font-bold text-green-700">
                  {Number(item.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                </span>
                
                <div className="flex items-center gap-3 bg-gray-50 rounded-lg px-2 py-1 border border-gray-200">
                  <span className="text-xs font-bold text-gray-600">{item.quantity}x</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Opções de Entrega */}
      <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 space-y-4">
        <h3 className="font-bold text-gray-800 flex items-center gap-2">
          <MapPin size={18} className="text-orange-600" /> 
          Tipo de Entrega
        </h3>
        
        <div className="grid grid-cols-2 gap-3">
          <button 
            onClick={() => setOrderType('TAKEOUT')}
            className={`p-3 rounded-xl border-2 text-sm font-bold transition-all ${orderType === 'TAKEOUT' ? 'border-orange-500 bg-orange-50 text-orange-700' : 'border-gray-100 text-gray-500'}`}
          >
            Retirada no Balcão
          </button>
          <button 
            onClick={() => setOrderType('DELIVERY')}
            className={`p-3 rounded-xl border-2 text-sm font-bold transition-all ${orderType === 'DELIVERY' ? 'border-orange-500 bg-orange-50 text-orange-700' : 'border-gray-100 text-gray-500'}`}
          >
            Delivery (Entrega)
          </button>
        </div>
        
        {orderType === 'DELIVERY' && (
          <p className="text-xs text-orange-600 bg-orange-50 p-2 rounded-lg border border-orange-100">
            ⚠️ Nota: No momento, enviando para o endereço padrão (ID 1).
          </p>
        )}
      </div>

      {/* Pagamento */}
      <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 space-y-4">
        <h3 className="font-bold text-gray-800">Pagamento</h3>
        <select 
          value={paymentMethod}
          onChange={e => setPaymentMethod(e.target.value)}
          className="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:border-orange-500 font-medium text-gray-700"
        >
          <option value="PIX">Pagamento via PIX</option>
          <option value="CREDIT_CARD">Cartão de Crédito</option>
          <option value="MONEY">Dinheiro</option>
        </select>
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-100 p-4 lg:p-6 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">
        <div className="max-w-2xl mx-auto flex items-center justify-between gap-4">
          <div>
            <p className="text-xs text-gray-500 font-medium uppercase">Total a pagar</p>
            <p className="text-2xl font-bold text-gray-800">
              {cartTotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
            </p>
          </div>
          
          <button 
            onClick={handleFinishOrder}
            disabled={loading}
            className="bg-green-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-green-700 transition-colors flex items-center gap-2 disabled:opacity-50"
          >
            {loading ? 'Enviando...' : 'Finalizar Pedido'}
            {!loading && <ArrowRight size={20} />}
          </button>
        </div>
      </div>
    </div>
  );
}