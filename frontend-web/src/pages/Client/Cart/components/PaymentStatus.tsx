import { CheckCircle2, XCircle, ShoppingBag, RotateCcw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface PaymentStatusProps {
  status: 'approved' | 'rejected' | 'in_process';
  paymentId?: number;
  onRetry: () => void;
}

export default function PaymentStatus({ status, paymentId, onRetry }: PaymentStatusProps) {
  const navigate = useNavigate();

  const isApproved = status === 'approved';
  
  return (
    <div className="flex flex-col items-center justify-center py-10 space-y-6 animate-in zoom-in duration-300">
      <div className={`p-6 rounded-full ${isApproved ? 'bg-green-100' : 'bg-red-100'}`}>
        {isApproved ? (
          <CheckCircle2 size={64} className="text-green-600" />
        ) : (
          <XCircle size={64} className="text-red-600" />
        )}
      </div>

      <div className="text-center space-y-2">
        <h2 className="text-2xl font-bold text-gray-800">
          {isApproved ? 'Pagamento Aprovado!' : 'Pagamento Recusado'}
        </h2>
        <p className="text-gray-500 max-w-xs mx-auto">
          {isApproved 
            ? `Seu pedido #${paymentId} já está sendo preparado pela cozinha.` 
            : 'Houve um problema com seu cartão. Tente novamente ou use o PIX.'}
        </p>
      </div>

      <div className="flex flex-col w-full gap-3 pt-4">
        {isApproved ? (
          <button 
            onClick={() => navigate('/orders')}
            className="bg-green-600 text-white font-bold py-3 rounded-xl hover:bg-green-700 transition-all shadow-lg shadow-green-200 flex items-center justify-center gap-2"
          >
            <ShoppingBag size={20} /> Acompanhar Pedido
          </button>
        ) : (
          <button 
            onClick={onRetry}
            className="bg-red-600 text-white font-bold py-3 rounded-xl hover:bg-red-700 transition-all shadow-lg shadow-red-200 flex items-center justify-center gap-2"
          >
            <RotateCcw size={20} /> Tentar Novamente
          </button>
        )}
      </div>
    </div>
  );
}