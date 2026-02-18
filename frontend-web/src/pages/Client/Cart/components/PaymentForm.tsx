import { useState, useEffect } from 'react';
import CreditCard from '../../../../components/CreditCard';
import { maskCardNumber, maskDate, maskCPF } from '../../../../utils/masks';
import toast from 'react-hot-toast';
import { CreditCard as CardIcon, Lock } from 'lucide-react';
import api from '../../../../services/api';
import { useAuth } from '../../../../contexts/AuthContext';

declare global {
  interface Window {
    MercadoPago: any;
  }
}

interface PaymentFormProps {
  total: number;
  email: string;
  onSuccess: (paymentId: number) => void;
  setLoading: (loading: boolean) => void;
}

export default function PaymentForm({ total, email, onSuccess, setLoading }: PaymentFormProps) {
  const { user } = useAuth();
  const [mp, setMp] = useState<any>(null);
  
  const [state, setState] = useState({
    number: '',
    name: '',
    expiry: '',
    cvc: '',
    focus: '' as any,
    docNumber: '', 
  });

  const TEST_CARD_NUMBER = '5031433215406351';
  const [installments] = useState(1);

  useEffect(() => {
    if (window.MercadoPago) {
      const mpInstance = new window.MercadoPago('TEST-6aeab6dc-85c6-4d63-b0e6-8f605114628d', {
        locale: 'pt-BR'
      });
      setMp(mpInstance);
    } else {
      console.error("SDK do Mercado Pago não carregou.");
      toast.error("Erro ao carregar sistema de pagamento.");
    }
  }, []);

  const detectCardBrand = (number: string) => {
    const clean = number.replace(/\D/g, '');
    if (clean.startsWith('5031')) return 'master';
    if (clean.match(/^4/)) return 'visa';
    if (clean.match(/^5[1-5]/) || clean.match(/^2(22[1-9]|2[3-9][0-9]|[3-6][0-9]{2}|7[01][0-9]|720)/)) return 'master';
    if (clean.match(/^3[47]/)) return 'amex';
    if (clean.match(/^(4011(78|79)|431274|438935|451416|457393|457631|457632|504175|627780|636297|636368|65003[1-3]|6500(3[5-9]|4[0-9]|5[0-1])|65040[5-9]|6504[1-3][0-9]|65048[5-9]|65049[0-9]|6505[0-2][0-9]|65053[0-8]|65054[1-9]|6505[5-8][0-9]|65059[0-8]|65070[0-9]|65071[0-8]|65072[0-7]|65090[1-9]|65091[0-9]|650920|65165[2-9]|6516[6-7][0-9]|65500[0-9]|65501[0-9]|65502[1-9]|6550[3-4][0-9]|65505[0-8])/)) return 'elo';
    if (clean.match(/^606282|^3841(?:[0|4|6]{1})0/)) return 'hipercard';
    return 'credit_card';
  };

  const handleInputChange = (evt: any) => {
    const { name, value } = evt.target;
    let formattedValue = value;
    if (name === 'number') formattedValue = maskCardNumber(value);
    if (name === 'expiry') formattedValue = maskDate(value);
    if (name === 'docNumber') formattedValue = maskCPF(value);
    if (name === 'cvc') formattedValue = value.replace(/\D/g, '').slice(0, 4);

    setState((prev) => ({ ...prev, [name]: formattedValue }));
  };

  const handleInputFocus = (evt: any) => {
    setState((prev) => ({ ...prev, focus: evt.target.name }));
  };

  async function handleSubmit(e: any) {
    e.preventDefault();
    
    if (user?.role !== 'CLIENT') {
      toast.error('Administradores não podem realizar pagamentos.');
      return;
    }

    setLoading(true);

    if (!mp) {
      toast.error('Sistema de pagamento indisponível.');
      setLoading(false);
      return;
    }

    try {
      const cleanNumber = state.number.replace(/\D/g, '');
      const detectedMethod = detectCardBrand(state.number);
      
      let nameToSend = state.name;
      if (cleanNumber === TEST_CARD_NUMBER) {
        nameToSend = 'APRO'; 
      }

      if (detectedMethod === 'credit_card' && cleanNumber !== TEST_CARD_NUMBER) {
         toast.error('Cartão não suportado ou número inválido.');
         setLoading(false);
         return;
      }

      const tokenObj = await mp.createCardToken({
        cardNumber: cleanNumber,
        cardholderName: nameToSend, 
        cardExpirationMonth: state.expiry.split('/')[0],
        cardExpirationYear: '20' + state.expiry.split('/')[1],
        securityCode: state.cvc,
        identificationType: 'CPF',
        identificationNumber: state.docNumber.replace(/\D/g, ''),
      });

      if (!tokenObj || !tokenObj.id) {
        throw new Error('Dados do cartão inválidos.');
      }

      const { data } = await api.post('/payment/card', {
        token: tokenObj.id,
        amount: total,
        email: email,
        paymentMethodId: detectedMethod, 
        installments: installments,
        docType: 'CPF',
        docNumber: state.docNumber.replace(/\D/g, '')
      });

      console.log('Status Recebido:', data.status);

      // Agora que o backend garante 'approved', podemos confiar nisso
      if (data.status === 'approved' || data.status === 'in_process') {
        toast.success('Pagamento Aprovado!');
        onSuccess(data.id); 
      } else {
        toast.error(`Recusado: ${data.status_detail || 'Tente novamente'}`);
      }

    } catch (error: any) {
      console.error("Erro Pagamento:", error);
      toast.error('Erro ao processar. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  const cardIssuer = detectCardBrand(state.number);
  const displayIssuer = cardIssuer === 'master' ? 'mastercard' : cardIssuer;
  
  // Define o tamanho máximo do CVV baseado no cartão
  const cvcMaxLength = cardIssuer === 'amex' ? 4 : 3;

  return (
    <div className="space-y-6">
      <CreditCard
        number={state.number}
        name={state.name}
        expiry={state.expiry}
        cvc={state.cvc}
        focus={state.focus}
        issuer={displayIssuer === 'credit_card' ? undefined : displayIssuer}
      />
      
      <form onSubmit={handleSubmit} className="space-y-4">
         <div>
          <label className="block text-xs font-bold text-gray-500 mb-1 uppercase">Número do Cartão</label>
          <div className="relative">
            <input
              type="text"
              name="number"
              placeholder="0000 0000 0000 0000"
              value={state.number}
              onChange={handleInputChange}
              onFocus={handleInputFocus}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 pl-10 focus:ring-2 focus:ring-orange-500 outline-none transition-all font-mono"
              maxLength={19}
              required
            />
            <CardIcon className="absolute left-3 top-3.5 text-gray-400" size={18} />
          </div>
        </div>

        <div>
          <label className="block text-xs font-bold text-gray-500 mb-1 uppercase">Nome no Cartão</label>
          <input
            type="text"
            name="name"
            placeholder="COMO ESTÁ NO CARTÃO"
            value={state.name}
            onChange={(e) => setState({ ...state, name: e.target.value.toUpperCase() })}
            onFocus={handleInputFocus}
            className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 focus:ring-2 focus:ring-orange-500 outline-none transition-all"
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-bold text-gray-500 mb-1 uppercase">Validade</label>
            <input
              type="text"
              name="expiry"
              placeholder="MM/AA"
              value={state.expiry}
              onChange={handleInputChange}
              onFocus={handleInputFocus}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 focus:ring-2 focus:ring-orange-500 outline-none transition-all font-mono text-center"
              maxLength={5}
              required
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-500 mb-1 uppercase">CVV</label>
            <div className="relative">
              <input
                type="tel"
                name="cvc"
                placeholder={cvcMaxLength === 4 ? "1234" : "123"}
                value={state.cvc}
                onChange={handleInputChange}
                onFocus={handleInputFocus}
                className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 pl-10 focus:ring-2 focus:ring-orange-500 outline-none transition-all font-mono"
                maxLength={cvcMaxLength}
                required
              />
              <Lock className="absolute left-3 top-3.5 text-gray-400" size={18} />
            </div>
          </div>
        </div>

        <div>
          <label className="block text-xs font-bold text-gray-500 mb-1 uppercase">CPF do Titular</label>
          <input
            type="tel"
            name="docNumber"
            placeholder="000.000.000-00"
            value={state.docNumber}
            onChange={handleInputChange}
            onFocus={handleInputFocus}
            className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 focus:ring-2 focus:ring-orange-500 outline-none transition-all font-mono"
            maxLength={14}
            required
          />
        </div>

        <button 
          type="submit"
          className="w-full bg-green-600 text-white font-bold py-4 rounded-xl hover:bg-green-700 transition-all shadow-lg shadow-green-200 flex items-center justify-center gap-2 mt-4"
        >
          <Lock size={18} /> Pagar {total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
        </button>
      </form>
    </div>
  );
}