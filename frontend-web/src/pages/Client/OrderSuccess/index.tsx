import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { CheckCircle, Package, ShoppingBag, Utensils } from 'lucide-react';
import { useStorefront } from '../../../contexts/StorefrontContext';
import { orderNumber as numberOfOrder, orderService } from '../../../services/orderService';
import { storePath } from '../../../utils/lastStore';

/** Inteiro positivo do state da navegação (número ou texto); qualquer outra coisa vira null. */
function readPositiveInt(raw: unknown): number | null {
  const id = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Pedido enviado pelo checkout no state da navegação ({ orderId, orderNumber? }). */
function readOrder(state: unknown): { id: number | null; number: number | null } {
  const raw = state as { orderId?: unknown; orderNumber?: unknown } | null;
  return { id: readPositiveInt(raw?.orderId), number: readPositiveInt(raw?.orderNumber) };
}

/**
 * Número do pedido NA LOJA ("Pedido #N"). Pago na entrega, o checkout já manda o número; nos pagamentos
 * online só vem o id do pedido, e o número é buscado (GET /stores/:slug/orders/:id). O id interno nunca é
 * mostrado ao cliente; sem o número, a linha aparece sem ele.
 */
function useOrderNumber(orderId: number | null, known: number | null, slug: string): number | null {
  const [fetched, setFetched] = useState<{ id: number; number: number } | null>(null);
  useEffect(() => {
    if (orderId === null || known !== null) return undefined;
    const controller = new AbortController();
    orderService
      .getMyOrder(orderId, slug, controller.signal)
      .then((order) => {
        if (typeof order?.number === 'number') setFetched({ id: orderId, number: numberOfOrder(order) });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [orderId, known, slug]);
  if (known !== null) return known;
  return fetched !== null && fetched.id === orderId ? fetched.number : null;
}

/**
 * Confirmação do pedido (/loja/:slug/order-success). Só afirma "pedido confirmado" quando o checkout
 * acabou de criar um pedido (state { orderId }); aberta direto (favorito, recarregar, link antigo), vira
 * uma página neutra com os atalhos para acompanhar os pedidos e voltar ao cardápio.
 */
export default function OrderSuccess() {
  const { state } = useLocation();
  const { slug, store } = useStorefront();
  const order = readOrder(state);
  const orderId = order.id;
  const orderNumber = useOrderNumber(orderId, order.number, slug);
  const menuTo = storePath(slug);

  if (orderId === null) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center p-6 animate-in fade-in duration-300">
        <div className="bg-gray-100 dark:bg-slate-800 p-6 rounded-full text-gray-500 dark:text-gray-400 mb-6" aria-hidden="true">
          <Package size={56} />
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white mb-2">Acompanhe seus pedidos</h1>
        <p className="text-gray-500 dark:text-gray-400 max-w-md mb-8">
          Não há um pedido recém-finalizado nesta página. Veja a situação dos seus pedidos em Meus Pedidos
          ou continue escolhendo no cardápio de {store.name}.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 w-full max-w-sm">
          <Link to="/my-orders" className="flex-1 flex items-center justify-center gap-2 bg-brand hover:bg-brand-hover text-brand-contrast px-6 py-3 rounded-xl font-bold transition-colors">
            <ShoppingBag size={20} aria-hidden="true" /> Meus Pedidos
          </Link>
          <Link to={menuTo} className="flex-1 flex items-center justify-center gap-2 bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-gray-200 px-6 py-3 rounded-xl font-bold hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors">
            <Utensils size={20} aria-hidden="true" /> Ver cardápio
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center text-center p-6 animate-in zoom-in duration-500">
      <div className="bg-green-100 dark:bg-green-900/30 p-6 rounded-full text-green-600 dark:text-green-400 mb-6 transition-colors" aria-hidden="true">
        <CheckCircle size={64} />
      </div>

      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2 transition-colors">Pedido Confirmado! 🎉</h1>
      <p className="text-sm font-bold text-brand-ink dark:text-brand-ink-dark mb-2" aria-live="polite">
        {orderNumber !== null ? `Pedido #${orderNumber} · ${store.name}` : store.name}
      </p>
      <p className="text-gray-500 dark:text-gray-400 max-w-md mb-8 transition-colors">
        Seu pedido foi enviado para {store.name}. Acompanhe cada etapa, do preparo à entrega, em Meus Pedidos.
      </p>

      <div className="flex flex-col sm:flex-row gap-3 w-full max-w-sm">
        <Link
          to="/my-orders"
          className="flex-1 flex items-center justify-center gap-2 bg-brand hover:bg-brand-hover text-brand-contrast px-6 py-3 rounded-xl font-bold transition-colors shadow-lg shadow-black/10"
        >
          <ShoppingBag size={20} aria-hidden="true" />
          Meus Pedidos
        </Link>
        <Link
          to={menuTo}
          className="flex-1 flex items-center justify-center gap-2 bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-gray-200 px-6 py-3 rounded-xl font-bold hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
        >
          <Utensils size={20} aria-hidden="true" />
          Voltar ao cardápio
        </Link>
      </div>
    </div>
  );
}
