import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icon } from '@iconify/react';
import { CreditCard, Info, Receipt } from 'lucide-react';
import { PageHeader, Tabs, type TabItem } from '../../../components/ui';
import { usePaginatedQuery } from '../../../hooks/usePaginatedQuery';
import { platformSubscriptionsService } from '../../../services/platform/subscriptionsService';
import type { PlatformInvoiceItem, PlatformSubscriptionItem } from '../../../services/platform/billingParsers';
import { usePlanOptions } from '../Plans/usePlanOptions';
import SubscriptionsList, { type SubscriptionFilters } from './SubscriptionsList';
import InvoicesList, { type InvoiceFilters } from './InvoicesList';
import SubscriptionDetailModal from './SubscriptionDetailModal';
import { useNow } from '../../../hooks/useNow';

type SubscriptionsTab = 'subscriptions' | 'invoices';

const TABS: TabItem<SubscriptionsTab>[] = [
  { value: 'subscriptions', label: 'Assinaturas', icon: <CreditCard size={16} /> },
  { value: 'invoices', label: 'Faturas', icon: <Receipt size={16} /> },
];

function parseId(value: string | null): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Superpainel › Assinaturas (/platform/subscriptions): assinaturas de todas as lojas (GET /platform/subscriptions)
 * com filtro por situação, plano e loja; faturas SaaS (GET /platform/invoices); detalhe em diálogo
 * (GET /platform/subscriptions/:id) com eventos, faturas e as ações de cobrança. ?tab=invoices abre as faturas e
 * ?subscription=<id> abre o detalhe de uma assinatura.
 */
export default function PlatformSubscriptions() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: SubscriptionsTab = searchParams.get('tab') === 'invoices' ? 'invoices' : 'subscriptions';
  const openId = parseId(searchParams.get('subscription'));
  const [openStoreName, setOpenStoreName] = useState<string | null>(null);
  const now = useNow();
  const planOptions = usePlanOptions();

  const subscriptions = usePaginatedQuery<PlatformSubscriptionItem, SubscriptionFilters>({
    fetcher: ({ page, pageSize, search, filters, signal }) => platformSubscriptionsService.list({
      page,
      pageSize,
      search,
      status: filters.status === 'ALL' ? undefined : filters.status,
      plan_id: filters.plan_id ?? undefined,
    }, signal),
    initialFilters: { status: 'ALL', plan_id: null },
    errorMessage: 'Não foi possível carregar as assinaturas.',
  });

  const invoices = usePaginatedQuery<PlatformInvoiceItem, InvoiceFilters>({
    fetcher: ({ page, pageSize, search, filters, signal }) => platformSubscriptionsService.listInvoices({
      page,
      pageSize,
      search,
      status: filters.status === 'ALL' ? undefined : filters.status,
    }, signal),
    initialFilters: { status: 'ALL' },
    enabled: tab === 'invoices',
    errorMessage: 'Não foi possível carregar as faturas.',
  });

  function setTab(next: SubscriptionsTab) {
    setSearchParams((previous) => {
      const params = new URLSearchParams(previous);
      if (next === 'subscriptions') params.delete('tab');
      else params.set('tab', next);
      return params;
    }, { replace: true });
  }

  function openSubscription(id: number, storeName: string | null) {
    setOpenStoreName(storeName);
    setSearchParams((previous) => {
      const params = new URLSearchParams(previous);
      params.set('subscription', String(id));
      return params;
    });
  }

  function closeSubscription() {
    setSearchParams((previous) => {
      const params = new URLSearchParams(previous);
      params.delete('subscription');
      return params;
    }, { replace: true });
  }

  /** Ação no detalhe ou numa fatura: as listas acompanham sem piscar. */
  function reloadLists() {
    void subscriptions.reload({ silent: true });
    if (tab === 'invoices') void invoices.reload({ silent: true });
  }

  return (
    <div className="space-y-6 pb-20">
      <PageHeader
        title="Assinaturas"
        subtitle="Situação das assinaturas, faturas e cobranças dos estabelecimentos"
        icon={<Icon icon="solar:card-recive-bold-duotone" width={26} />}
      >
        <p className="flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400">
          <Info size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            Faturas pagas são a receita da plataforma (assinaturas SaaS). O volume vendido pelas lojas aos clientes (GMV) não entra
            aqui e nunca é somado a essa receita. Toda ação é registrada na auditoria.
          </span>
        </p>
      </PageHeader>

      <Tabs tabs={TABS} value={tab} onChange={setTab} label="Assinaturas e faturas">
        {tab === 'subscriptions' ? (
          <SubscriptionsList
            query={subscriptions}
            plans={planOptions.plans}
            onOpen={(item) => openSubscription(item.id, item.store?.name ?? null)}
          />
        ) : (
          <InvoicesList
            query={invoices}
            now={now}
            onOpenSubscription={(invoice) => openSubscription(invoice.subscription_id, invoice.store?.name ?? null)}
            onChanged={reloadLists}
          />
        )}
      </Tabs>

      <SubscriptionDetailModal
        subscriptionId={openId}
        storeName={openId !== null ? openStoreName : null}
        onClose={closeSubscription}
        onChanged={reloadLists}
      />
    </div>
  );
}
