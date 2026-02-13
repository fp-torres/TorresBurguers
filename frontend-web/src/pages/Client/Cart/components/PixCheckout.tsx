import { QRCodeSVG } from 'qrcode.react';
import { Copy, CheckCircle2 } from 'lucide-react';
import toast from 'react-hot-toast';

interface PixCheckoutProps {
  qrCode: string;
  copyPaste: string;
}

export default function PixCheckout({ qrCode, copyPaste }: PixCheckoutProps) {
  function handleCopy() {
    navigator.clipboard.writeText(copyPaste);
    toast.success('Código PIX copiado!');
  }

  return (
    <div className="flex flex-col items-center justify-center space-y-6 py-4 animate-in fade-in zoom-in duration-300">
      <div className="bg-white p-4 rounded-xl shadow-lg border-2 border-green-500 relative">
        {/* CORREÇÃO: level="L" é essencial para códigos PIX longos não quebrarem o componente */}
        <QRCodeSVG 
          value={copyPaste} 
          size={200} 
          level="L"
          includeMargin={true}
        />
        <div className="absolute -bottom-3 -right-3 bg-green-500 text-white p-2 rounded-full">
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
    </div>
  );
}