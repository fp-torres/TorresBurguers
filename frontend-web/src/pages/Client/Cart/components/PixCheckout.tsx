import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, Info, Loader2, Timer, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { copyText } from '../../../../utils/clipboard';
import { formatCurrency } from '../../../../utils/format';

interface PixCheckoutProps {
  /** Código "copia e cola" (também vira o QR Code). */
  copyPaste: string;
  amount: number;
  /** Instante (ms) em que o código expira (enviado pelo servidor). */
  expiresAt: number;
  /** Nome da loja que recebe o pagamento. */
  storeName: string;
  /** PIX de teste do sandbox: aprovado automaticamente em alguns segundos. */
  simulation?: boolean;
  /** O cancelamento foi pedido e está sendo confirmado pelo servidor. */
  cancelling?: boolean;
  onCancel: () => void;
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** QR Code e "copia e cola" do PIX em andamento; o pedido é registrado pelo servidor quando o pagamento for confirmado. */
export default function PixCheckout({ copyPaste, amount, expiresAt, storeName, simulation, cancelling = false, onCancel }: PixCheckoutProps) {
  const [now, setNow] = useState(() => Date.now());
  const codeId = useId();

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  async function handleCopy() {
    if (await copyText(copyPaste)) toast.success('Código PIX copiado!');
    else toast.error('Não foi possível copiar. Selecione o código e copie manualmente.');
  }

  const expired = expiresAt <= now;

  return (
    <div className="flex flex-col items-center justify-center space-y-6 py-4 animate-in fade-in zoom-in duration-300">
      <div
        className={`px-4 py-2 rounded-full font-bold flex items-center gap-2 ${expired ? 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-gray-300' : 'bg-brand/10 text-brand-ink dark:text-brand-ink-dark'}`}
      >
        <Timer size={18} aria-hidden="true" />
        {expired ? 'Código vencido. Conferindo o pagamento...' : `Expira em: ${formatRemaining(expiresAt - now)}`}
      </div>

      {/* QR Code sempre em fundo branco para a leitura pela câmera */}
      <div className="bg-white p-4 rounded-xl shadow-lg border-2 border-green-500">
        <QRCodeSVG value={copyPaste} size={200} level="M" marginSize={2} title={`QR Code do PIX de ${formatCurrency(amount)} para ${storeName}`} />
      </div>

      <div className="text-center space-y-2">
        <p className="text-2xl font-bold text-gray-800 dark:text-white">{formatCurrency(amount)}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">Pagamento para <b className="text-gray-700 dark:text-gray-200">{storeName}</b></p>
        <h3 className="font-bold text-gray-800 dark:text-white text-lg">Escaneie o QR Code</h3>
        <p className="text-gray-500 dark:text-gray-400 text-sm max-w-xs mx-auto">
          Abra o app do seu banco, escolha pagar com Pix e aponte a câmera — ou copie o código abaixo.
        </p>
        {simulation && (
          <p className="text-xs text-blue-600 dark:text-blue-400 max-w-xs mx-auto">
            Ambiente de testes: este PIX é aprovado automaticamente em alguns segundos.
          </p>
        )}
      </div>

      <div className="w-full">
        <label htmlFor={codeId} className="sr-only">Código PIX copia e cola</label>
        <div className="relative">
          <input
            id={codeId}
            readOnly
            value={copyPaste}
            onFocus={(event) => event.target.select()}
            className="w-full bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-gray-300 text-xs p-3 rounded-lg pr-12 font-mono"
          />
          <button
            type="button"
            onClick={handleCopy}
            aria-label="Copiar código PIX"
            className="absolute right-1 top-1 bottom-1 bg-white dark:bg-slate-700 hover:bg-gray-100 dark:hover:bg-slate-600 text-green-600 dark:text-green-400 px-3 rounded-md border border-gray-100 dark:border-slate-600 transition-colors"
          >
            <Copy size={16} aria-hidden="true" />
          </button>
        </div>
        <p className="text-center text-xs text-green-600 dark:text-green-400 font-bold mt-2">
          Clique no ícone para copiar o código "Copia e Cola"
        </p>
      </div>

      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400" role="status">
        <Loader2 size={16} className="animate-spin" aria-hidden="true" />
        Aguardando a confirmação do pagamento...
      </div>

      <div className="w-full bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 rounded-xl p-3 text-xs text-blue-800 dark:text-blue-200 flex items-start gap-2">
        <Info size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
        <p>
          Pode sair desta página com segurança: assim que o pagamento for confirmado, o pedido é registrado e aparece em{' '}
          <Link to="/my-orders" className="font-bold underline">Meus Pedidos</Link>. Não pague o mesmo código duas vezes.
        </p>
      </div>

      <button
        type="button"
        onClick={onCancel}
        disabled={cancelling}
        className="text-red-500 dark:text-red-400 text-sm font-bold flex items-center gap-1 hover:bg-red-50 dark:hover:bg-red-900/20 px-3 py-2 rounded-lg transition-colors disabled:opacity-60"
      >
        {cancelling ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <XCircle size={16} aria-hidden="true" />} Cancelar pagamento
      </button>
    </div>
  );
}
