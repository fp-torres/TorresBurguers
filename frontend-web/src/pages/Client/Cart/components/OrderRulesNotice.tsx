import { Link } from 'react-router-dom';
import { AlertCircle, Bike, CheckCircle2, Info } from 'lucide-react';
import type { StoreOrderRules } from '../../../../services/publicStoreService';
import { formatCurrency } from '../../../../utils/format';
import { quoteBelowMinimum, type OrderType, type Quote } from '../checkout';

interface OrderRulesNoticeProps {
  orderType: OrderType;
  /** Orçamento do tipo escolhido (null: entrega ainda sem endereço, ou calculando). */
  quote: Quote | null;
  /** Regras anunciadas pela loja (para a entrega ainda sem endereço). */
  rules: StoreOrderRules;
  deliveryEnabled: boolean;
  /** Cardápio da loja (para adicionar mais itens). */
  menuPath: string;
}

/**
 * Pedido mínimo e frete grátis no resumo do carrinho: quanto falta para o mínimo (o pagamento fica bloqueado até
 * lá), quanto falta para o frete grátis (com a barra de progresso) ou o aviso de frete grátis conquistado. Os
 * valores vêm do orçamento do servidor; sem endereço de entrega, só o que a loja anuncia.
 */
export default function OrderRulesNotice({ orderType, quote, rules, deliveryEnabled, menuPath }: OrderRulesNoticeProps) {
  const below = quoteBelowMinimum(quote);
  const delivery = orderType === 'DELIVERY';
  const missingForFree = delivery ? quote?.missing_for_free_delivery : null;
  const threshold = quote?.free_delivery_threshold;
  const freeApplied = delivery && quote?.free_delivery_applied === true;
  const savedFee = quote?.delivery_fee_original ?? 0;

  // Entrega sem endereço: a taxa (e a região) ainda não é conhecida — só o que a loja anuncia
  const announced: string[] = [];
  if (delivery && !quote && deliveryEnabled) {
    if (rules.min_order !== null) announced.push(`Pedido mínimo para entrega: ${formatCurrency(rules.min_order)}.`);
    if (rules.free_delivery_above !== null) {
      announced.push(rules.free_delivery_above > 0 ? `Frete grátis a partir de ${formatCurrency(rules.free_delivery_above)} em produtos.` : 'Frete grátis.');
    }
    if (announced.length && rules.varies_by_zone) announced.push('Os valores podem variar conforme o bairro.');
  }

  if (!below && missingForFree == null && !freeApplied && !announced.length) return null;

  return (
    <div className="space-y-3 pt-1">
      {below && (
        <div role="status" className="p-3 rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200 text-sm space-y-1">
          <p className="font-bold flex items-start gap-2">
            <AlertCircle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
            Pedido mínimo {orderType === 'TAKEOUT' ? 'para retirada' : 'para entrega'}: {formatCurrency(below.minOrder)}
          </p>
          <p>
            Faltam <b>{formatCurrency(below.missing)}</b> em produtos para finalizar o pedido.{' '}
            <Link to={menuPath} className="font-bold underline underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded">
              Adicionar mais itens
            </Link>
          </p>
        </div>
      )}

      {missingForFree != null && missingForFree > 0 && typeof threshold === 'number' && threshold > 0 && (
        <div className="space-y-1.5" role="status">
          <p className="text-sm font-semibold text-gray-700 dark:text-gray-200 flex items-center gap-2">
            <Bike size={16} className="shrink-0 text-brand-ink dark:text-brand-ink-dark" aria-hidden="true" />
            Faltam {formatCurrency(missingForFree)} para o frete grátis
          </p>
          <div className="h-2 rounded-full bg-gray-100 dark:bg-slate-800 overflow-hidden" aria-hidden="true">
            <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${Math.min(100, Math.max(4, ((threshold - missingForFree) / threshold) * 100))}%` }} />
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">Frete grátis a partir de {formatCurrency(threshold)} em produtos.</p>
        </div>
      )}

      {freeApplied && (
        <p role="status" className="text-sm font-semibold text-green-700 dark:text-green-400 flex items-start gap-2">
          <CheckCircle2 size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
          {savedFee > 0 ? `Frete grátis! Você economizou ${formatCurrency(savedFee)} na entrega.` : 'Frete grátis!'}
        </p>
      )}

      {announced.length > 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400 flex items-start gap-2">
          <Info size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
          {announced.join(' ')}
        </p>
      )}
    </div>
  );
}
