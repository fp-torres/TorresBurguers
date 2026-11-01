import { useState } from 'react';
import { CreditCard, History } from 'lucide-react';
import { CARD_CLASS, EmptyState, buttonClass } from '../../../components/ui';
import type { PlatformStoreDetail } from '../../../services/platform/storesService';
import CreateSubscriptionDialog from '../Subscriptions/CreateSubscriptionDialog';
import SubscriptionManager from '../Subscriptions/SubscriptionManager';
import { formatDate } from '../../../utils/dates';

interface SubscriptionTabProps {
  store: PlatformStoreDetail;
  /** Assinatura ou faturas mudaram: o detalhe da loja (situação, limites, recursos) é relido. */
  onChanged: () => void;
}

/**
 * Assinatura da loja: a vigente (ou a última cancelada, como histórico) com as ações de cobrança
 * (rotas de /platform/subscriptions e /platform/invoices); sem assinatura vigente, contratar um plano
 * (POST /platform/stores/:id/subscription).
 */
export default function SubscriptionTab({ store, onChanged }: SubscriptionTabProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const subscription = store.subscription;
  const current = subscription && subscription.status !== 'CANCELED' ? subscription : null;

  return (
    <div className="space-y-6">
      <h2 className="sr-only">Assinatura</h2>
      {!current && (
        <div className={CARD_CLASS}>
          <EmptyState
            icon={<CreditCard size={36} />}
            title={subscription ? 'Sem assinatura vigente' : 'Nenhuma assinatura'}
            description={subscription
              ? `A última assinatura foi cancelada${subscription.canceled_at ? ` em ${formatDate(subscription.canceled_at)}` : ''}. A loja não vende até contratar um plano.`
              : 'Esta loja nunca teve assinatura: ela não vende até contratar um plano.'}
            action={(
              <button type="button" onClick={() => setCreateOpen(true)} className={buttonClass('primary')}>
                <CreditCard size={16} aria-hidden="true" /> Contratar plano
              </button>
            )}
          />
        </div>
      )}

      {subscription && (
        <section aria-label={current ? 'Assinatura vigente' : 'Última assinatura (cancelada)'} className="space-y-3">
          {!current && (
            <p className="flex items-center gap-2 text-sm font-bold text-gray-700 dark:text-gray-200">
              <History size={16} aria-hidden="true" /> Última assinatura (cancelada) — histórico e faturas
            </p>
          )}
          <SubscriptionManager key={subscription.id} subscriptionId={subscription.id} headingLevel={3} showAccess={false} onChanged={onChanged} />
        </section>
      )}

      <CreateSubscriptionDialog
        open={createOpen}
        storeId={store.id}
        storeName={store.name}
        onClose={() => setCreateOpen(false)}
        onCreated={onChanged}
      />
    </div>
  );
}
