import { useState, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, CheckCircle2, Timer, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';

interface PixCheckoutProps {
  qrCode: string;
  copyPaste: string;
  onExpired: () => void; // Callback para quando o tempo acabar ou usuário cancelar
}

export default function PixCheckout({ qrCode, copyPaste, onExpired }: PixCheckoutProps) {
  const [timeLeft, setTimeLeft] = useState(600); // 10 minutos em segundos

  useEffect(() => {
    if (timeLeft <= 0) {
      onExpired();
      toast.error('O código PIX expirou.');
      return;
    }

    const intervalId = setInterval(() => {
      setTimeLeft((prev) => prev - 1);
    }, 1000);

    return () => clearInterval(intervalId);
  }, [timeLeft, onExpired]);

  function handleCopy() {
    navigator.clipboard.writeText(copyPaste);
    toast.success('Código PIX copiado!');
  }

  // Formata MM:SS
  const minutes = Math.floor(timeLeft / 60);
  const seconds = timeLeft % 60;
  const timeString = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  return (
    <div className="flex flex-col items-center justify-center space-y-6 py-4 animate-in fade-in zoom-in duration-300">
      
      {/* Timer Display */}
      <div className="bg-orange-50 text-orange-700 px-4 py-2 rounded-full font-bold flex items-center gap-2">
        <Timer size={18} />
        Expira em: {timeString}
      </div>

      <div className="bg-white p-4 rounded-xl shadow-lg border-2 border-green-500 relative">
        <QRCodeSVG 
          value={copyPaste} 
          size={200} 
          level="L"
          includeMargin={true}
        />
        <div className="absolute -bottom-3 -right-3 bg-green-500 text-white p-2 rounded-full animate-bounce">
          <CheckCircle2 size={24} />
        </div>
      </div>

      <div className="text-center space-y-2">
        <h3 className="font-bold text-gray-800 text-lg">Escaneie o QR Code</h3>
        <p className="text-gray-500 text-sm max-w-xs mx-auto">
          Abra o app do seu banco, escolha pagar com Pix e aponte a câmera.
        </p>
      </div>

      <div className="w-full">
        <div className="relative">
          <input 
            readOnly 
            value={copyPaste} 
            className="w-full bg-gray-50 border border-gray-200 text-gray-500 text-xs p-3 rounded-lg pr-12 font-mono"
          />
          <button 
            onClick={handleCopy}
            className="absolute right-1 top-1 bottom-1 bg-white hover:bg-gray-100 text-green-600 px-3 rounded-md border border-gray-100 transition-colors"
          >
            <Copy size={16} />
          </button>
        </div>
        <p className="text-center text-xs text-green-600 font-bold mt-2">
          Clique para copiar o código "Copia e Cola"
        </p>
      </div>

      {/* Botão de Cancelar */}
      <button 
        onClick={onExpired}
        className="text-red-500 text-sm font-bold flex items-center gap-1 hover:bg-red-50 px-3 py-2 rounded-lg transition-colors"
      >
        <XCircle size={16} /> Cancelar Pagamento
      </button>
    </div>
  );
}