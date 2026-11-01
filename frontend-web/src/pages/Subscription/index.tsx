import { useId, useState, type ReactNode } from 'react';
import { Icon } from '@iconify/react';
import {
  AlertTriangle, CalendarClock, Check, CreditCard, ExternalLink, Headset, Info, Loader2, Receipt, RotateCcw, ShieldAlert, X, XCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  CARD_CLASS, DataTable, EmptyState, ErrorState, PageHeader, StatusBadge, buttonClass, cx, fieldControlClass, type DataTableColumn,
} from '../../components/ui';
import ConfirmModal from '../../components/ConfirmModal';
import PageLoader from '../../components/PageLoader';
import { useAuth } from '../../contexts/AuthContext';
import { BRAND } from '../../config/brand';
import { getApiErrorMessage, getApiErrorStatus } from '../../services/api';
import {
  PLAN_LIMIT_LABELS, formatMegabytes, storeSubscriptionService,
  type PlanStorage, type PlanUsageItem, type StoreInvoice, type StoreSubscriptionOverview,
} from '../../services/storeSubscriptionService';
import { PLAN_FEATURE_KEYS, PLAN_FEATURE_LABELS, isBlockedAvailability } from '../../services/storeAccess';
import { storeSettingsService } from '../../services/storeSettingsService';
import { usePanelStore } from '../../layouts/DefaultLayout/panelStore';
import { useNow } from '../../hooks/useNow';
import { useResource } from '../../hooks/useResource';
import { formatDate, toDate } from '../../utils/dates';
import { INVOICE_STATUS, SUBSCRIPTION_STATUS, statusMeta } from '../../utils/saasStatus';
import { formatCurrency, formatTime } from '../../utils/format';

const REASON_MAX_LENGTH = 300;

const PROVIDER_LABELS: Record<string, string> = {
  MANUAL: 'Cobrança registrada pela plataforma',
  MERCADO_PAGO: 'Cobrança automática (Mercado Pago)',
};

const INVOICE_METHOD_LABELS: Record<string, string> = {
  PIX: 'PIX',
  CREDIT_CARD: 'Cartão de crédito',
  DEBIT_CARD: 'Cartão de débito',
  BOLETO: 'Boleto',
  TICKET: 'Boleto',
  ACCOUNT_MONEY: 'Saldo Mercado Pago',
};

function invoiceMethodLabel(method: string | null): string {
  if (!method) return '—';
  return INVOICE_METHOD_LABELS[method.trim().toUpperCase()] ?? method;
}

function hasUnpaidInvoice(overview: StoreSubscriptionOverview): boolean {
  return overview.invoices.some((invoice) => invoice.status === 'OPEN' || invoice.status === 'FAILED');
}

/** Início da mensagem do 409 da API quando outro checkout da mesma loja ainda está gerando o link. */
const CHECKOUT_IN_PROGRESS_PREFIX = 'O link de pagamento desta assinatura já está sendo gerado';

/** Plano pago com assinatura vigente (só ele tem o que pagar; plano gratuito → 400 no checkout). */
function isPaidSubscription(overview: StoreSubscriptionOverview): boolean {
  const { subscription, plan } = overview;
  return !!subscription && !!plan && plan.price > 0 && subscription.status !== 'CANCELED';
}

/** Há cobrança a regularizar: pagamento em atraso, assinatura suspensa ou fatura em aberto/recusada. */
function isPaymentDue(overview: StoreSubscriptionOverview): boolean {
  const status = overview.subscription?.status;
  return isPaidSubscription(overview) && (status === 'PAST_DUE' || status === 'SUSPENDED' || hasUnpaidInvoice(overview));
}

/** Rótulo da ação de pagamento (checkout online) conforme a situação (null = sem pagamento a fazer). */
function checkoutLabel(overview: StoreSubscriptionOverview): string | null {
  if (!isPaidSubscription(overview)) return null;
  if (isPaymentDue(overview)) return 'Pagar e regularizar';
  if (overview.subscription?.status === 'TRIALING') return 'Assinar agora';
  if (overview.subscription?.billing_provider !== 'MERCADO_PAGO') return 'Ativar cobrança automática';
  return null;
}

/**
 * Painel da loja › Plano e assinatura (/subscription; só Administrador): GET /store/subscription (plano,
 * situação, datas, limites × uso, faturas e access) e as ações de pagar/regularizar (checkout), cancelar no
 * fim do período e desistir do cancelamento.
 */
export default function Subscription() {
  const { user } = useAuth();
  const panel = usePanelStore();
  const readOnly = !!user?.support_session;
  const reasonId = useId();

  const resource = useResource((signal) => storeSubscriptionService.get(signal), {
    errorMessage: 'Não foi possível carregar a assinatura.',
  });
  const overview = resource.data;

  const [checkingOut, setCheckingOut] = useState(false);
  const [checkoutNotice, setCheckoutNotice] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [canceling, setCanceling] = useState(false);
  const [resuming, setResuming] = useState(false);
  // 403 IMMEDIATE_CANCEL_OWNER_ONLY: mensagem da API (o botão some até a página recarregar)
  const [ownerOnlyNotice, setOwnerOnlyNotice] = useState<string | null>(null);

  // Sem período a vencer (plano sem período ou período já encerrado): o cancelamento é imediato e só o responsável
  // pela loja (stores.owner_user_id) pode fazê-lo. O responsável vem de GET /store/settings, consultado só nesse
  // caso (a API continua decidindo: 403).
  const now = useNow();
  const loadedSubscription = overview?.subscription ?? null;
  const periodEnd = toDate(loadedSubscription?.current_period_end ?? null);
  const immediateCancel = !!loadedSubscription && !(periodEnd && periodEnd.getTime() > now)
    && ['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(loadedSubscription.status) && !loadedSubscription.cancel_at_period_end;
  const ownerResource = useResource(async (signal) => (await storeSettingsService.get(signal)).owner_user_id, {
    key: 'store-owner',
    enabled: immediateCancel && !readOnly,
    errorMessage: '',
  });
  const storeOwnerId = ownerResource.data ?? null;
  const ownerOnlyBlocked = immediateCancel && (
    !!ownerOnlyNotice || (storeOwnerId !== null && user?.id !== undefined && storeOwnerId !== user.id)
  );

  const refreshPanel = panel.refresh;
  const applyPanelSubscription = panel.applySubscription;
  const setOverview = resource.setData;

  /** Aplica a visão devolvida por /cancel e /resume e atualiza a situação da loja no layout. */
  function applyOverview(next: StoreSubscriptionOverview) {
    setOverview(next);
    applyPanelSubscription(next);
    void refreshPanel();
  }

  async function handleCheckout() {
    setCheckingOut(true);
    setCheckoutNotice(null);
    try {
      const url = await storeSubscriptionService.checkout();
      if (!url) {
        toast.error('A cobrança não devolveu um link de pagamento. Tente de novo ou fale com o suporte.');
        return;
      }
      toast.success('Abrindo o pagamento...');
      window.location.assign(url);
    } catch (error) {
      const message = getApiErrorMessage(error, 'Não foi possível abrir o pagamento da assinatura.');
      const status = getApiErrorStatus(error);
      if (status === 409 && message.startsWith(CHECKOUT_IN_PROGRESS_PREFIX)) {
        // Outro pedido de pagamento da loja ainda gera o link: é só esperar (não é falta de cobrança online)
        toast(message, { id: 'checkout-in-progress', duration: 6000 });
      } else if (status === 409) {
        // A cobrança online da plataforma ainda não está configurada
        setCheckoutNotice(message);
      } else {
        // 429 (limite de links por loja) e demais erros: a mensagem da API
        toast.error(message, { duration: 6000 });
      }
    } finally {
      setCheckingOut(false);
    }
  }

  async function handleCancel() {
    setCanceling(true);
    try {
      const next = await storeSubscriptionService.cancel(cancelReason.trim() || undefined);
      // Com período em andamento o cancelamento é agendado; plano sem período é cancelado na hora
      toast.success(next.subscription?.status === 'CANCELED'
        ? 'Assinatura cancelada.'
        : 'Cancelamento agendado para o fim do período.');
      setCancelOpen(false);
      setCancelReason('');
      applyOverview(next);
    } catch (error) {
      const message = getApiErrorMessage(error, 'Não foi possível cancelar a assinatura.');
      toast.error(message, { duration: 6000 });
      // 403: plano sem período (cancelamento imediato) só pode ser cancelado pelo responsável pela loja
      if (getApiErrorStatus(error) === 403) {
        setCancelOpen(false);
        setOwnerOnlyNotice(message);
      }
      void resource.reload({ silent: true });
    } finally {
      setCanceling(false);
    }
  }

  async function handleResume() {
    setResuming(true);
    try {
      const next = await storeSubscriptionService.resume();
      toast.success('Cancelamento desfeito: a assinatura continua.');
      applyOverview(next);
    } catch (error) {
      // 409: período já terminou ou não há cancelamento agendado (a API explica)
      toast.error(getApiErrorMessage(error, 'Não foi possível desfazer o cancelamento.'), { duration: 6000 });
      void resource.reload({ silent: true });
    } finally {
      setResuming(false);
    }
  }

  const header = (
    <PageHeader
      title="Plano e assinatura"
      subtitle="Plano contratado, limites de uso e faturas do estabelecimento"
      icon={<Icon icon="solar:card-bold-duotone" width={26} />}
    />
  );

  if (!overview) {
    return (
      <div className="space-y-6 pb-20">
        {header}
        {resource.error ? (
          <div className={CARD_CLASS}>
            <ErrorState message={resource.error} onRetry={() => void resource.reload()} retrying={resource.loading} />
          </div>
        ) : (
          <PageLoader />
        )}
      </div>
    );
  }

  const { plan, subscription, access } = overview;
  const status = subscription ? statusMeta(SUBSCRIPTION_STATUS, subscription.status) : null;
  // Suspensa pela administração da plataforma: pagar não reativa (o checkout responde 409); só o suporte resolve
  const suspendedByPlatform = subscription?.status === 'SUSPENDED' && subscription.suspended_by === 'PLATFORM';
  const payLabel = suspendedByPlatform ? null : checkoutLabel(overview);
  // Sem cobrança online na plataforma (billing.online_checkout_available = false), o checkout responderia 409:
  // em vez do botão, havendo algo a pagar, explica que o pagamento é registrado pelo suporte
  const showPayButton = !!payLabel && overview.billing.onlineCheckoutAvailable;
  const manualPayment = !suspendedByPlatform && !overview.billing.onlineCheckoutAvailable && isPaymentDue(overview);
  const canceled = subscription?.status === 'CANCELED';
  const cancelAllowedByStatus = !!subscription && ['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(subscription.status) && !subscription.cancel_at_period_end;
  // Plano sem período e quem está logado não é o responsável pela loja: a API recusaria (403)
  const canCancel = cancelAllowedByStatus && !ownerOnlyBlocked;
  const cancelScheduled = !!subscription && subscription.cancel_at_period_end && subscription.status !== 'CANCELED';
  // Agendado pela administração da plataforma: só o suporte desfaz (POST /resume responde 409)
  const cancelScheduledByPlatform = cancelScheduled && subscription.cancel_scheduled_by === 'PLATFORM';
  const canResume = cancelScheduled && !cancelScheduledByPlatform;
  const ownerOnlyMessage = cancelAllowedByStatus && ownerOnlyBlocked
    ? ownerOnlyNotice ?? 'Sem período pago a terminar, o cancelamento é imediato e não pode ser desfeito: só o responsável pela loja pode fazê-lo.'
    : null;
  const pendingCheckoutUrl = !suspendedByPlatform && subscription?.checkout_url &&/^https?:\/\//i.test(subscription.checkout_url) ? subscription.checkout_url : null;
  const busy = checkingOut || canceling || resuming;

  return (
    <div className="space-y-6 pb-20">
      {header}

      {resource.error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-2xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
          <AlertTriangle size={18} className="shrink-0" aria-hidden="true" />
          <span className="flex-1 min-w-48">{resource.error} Os dados abaixo podem estar desatualizados.</span>
          <button type="button" onClick={() => void resource.reload()} className="font-bold hover:underline">Tentar novamente</button>
        </div>
      )}

      {access?.message && (
        <div
          role={isBlockedAvailability(access.availability) ? 'alert' : 'status'}
          className={cx(
            'flex items-start gap-3 px-4 py-3 rounded-2xl text-sm border',
            isBlockedAvailability(access.availability)
              ? 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 border-red-200 dark:border-red-800'
              : 'bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800',
          )}
        >
          <ShieldAlert size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
          <p><span className="font-bold">Situação da loja: </span>{access.message}</p>
        </div>
      )}

      {checkoutNotice && (
        <div role="alert" className="flex items-start gap-3 px-4 py-3 rounded-2xl text-sm bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200 border border-blue-200 dark:border-blue-800">
          <Headset size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
          <p className="flex-1">
            <span className="font-bold">Pagamento online indisponível. </span>{checkoutNotice}{' '}
            Para regularizar, fale com o suporte: <a href={`mailto:${BRAND.supportEmail}`} className="font-bold underline">{BRAND.supportEmail}</a>.
          </p>
          <button type="button" onClick={() => setCheckoutNotice(null)} aria-label="Fechar aviso" className="p-1 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/40">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}

      {!subscription ? (
        <div className={CARD_CLASS}>
          <EmptyState
            icon={<CreditCard size={36} />}
            title="Nenhuma assinatura ativa"
            description="A loja não tem um plano vigente, então não pode vender. Fale com o suporte da plataforma para escolher um plano."
            action={<a href={`mailto:${BRAND.supportEmail}`} className={buttonClass('primary')}><Headset size={16} aria-hidden="true" /> Falar com o suporte</a>}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {/* Plano e ações */}
          <section aria-labelledby="plan-title" className={cx(CARD_CLASS, 'xl:col-span-2 p-5 sm:p-6 flex flex-col gap-5')}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">Plano atual</p>
                <h2 id="plan-title" className="text-2xl font-bold text-gray-800 dark:text-white">{plan?.name ?? 'Plano'}</h2>
                {plan?.description && <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{plan.description}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                {status && <StatusBadge tone={status.tone} dot>{status.label}</StatusBadge>}
                {subscription.cancel_at_period_end && subscription.status !== 'CANCELED' && (
                  <StatusBadge tone="warning" icon={<CalendarClock size={12} />}>Cancelamento agendado</StatusBadge>
                )}
              </div>
            </div>

            {plan && (
              <div>
                <p className="text-3xl font-bold text-gray-800 dark:text-white">
                  {plan.price > 0 ? formatCurrency(plan.price) : 'Gratuito'}
                  {plan.price > 0 && (
                    <span className="text-base font-semibold text-gray-500 dark:text-gray-400"> / {plan.billing_interval === 'YEARLY' ? 'ano' : 'mês'}</span>
                  )}
                </p>
                {plan.price > 0 && plan.billing_interval === 'YEARLY' && (
                  <p className="text-sm text-gray-500 dark:text-gray-400">Equivale a {formatCurrency(plan.monthly_price)} por mês.</p>
                )}
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{PROVIDER_LABELS[subscription.billing_provider] ?? subscription.billing_provider}</p>
              </div>
            )}

            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">Recursos do plano</p>
              <ul className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {PLAN_FEATURE_KEYS.map((key) => {
                  const included = overview.features[key];
                  return (
                    <li
                      key={key}
                      className={cx(
                        'flex items-start gap-2 p-3 rounded-xl text-sm border',
                        included
                          ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-800 dark:text-green-300'
                          : 'bg-gray-50 dark:bg-slate-900/40 border-gray-200 dark:border-slate-700 text-gray-500 dark:text-gray-400',
                      )}
                    >
                      {included ? <Check size={16} className="shrink-0 mt-0.5" aria-hidden="true" /> : <XCircle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />}
                      <span>
                        {PLAN_FEATURE_LABELS[key]}
                        <span className="sr-only">{included ? ': incluído' : ': não incluído'}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>

            {!readOnly && (showPayButton || manualPayment || suspendedByPlatform || pendingCheckoutUrl || canCancel || canResume || canceled || cancelScheduledByPlatform || !!ownerOnlyMessage) && (
              <div className="flex flex-col gap-3 pt-4 border-t border-gray-100 dark:border-slate-700">
                {cancelScheduledByPlatform && (
                  <p role="status" className="flex items-start gap-2 px-3 py-2.5 rounded-xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200 border border-amber-200 dark:border-amber-800">
                    <Headset size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
                    <span>
                      <span className="font-bold">Cancelamento agendado pela administração da plataforma — fale com o suporte. </span>
                      Para manter a assinatura, escreva para <a href={`mailto:${BRAND.supportEmail}`} className="font-bold underline">{BRAND.supportEmail}</a>.
                    </span>
                  </p>
                )}
                {ownerOnlyMessage && (
                  <p role="status" className="flex items-start gap-2 px-3 py-2.5 rounded-xl text-sm bg-gray-50 dark:bg-slate-900/40 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-slate-700">
                    <Info size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
                    <span>{ownerOnlyMessage}</span>
                  </p>
                )}
                {suspendedByPlatform && (
                  <p className="flex items-start gap-2 px-3 py-2.5 rounded-xl text-sm bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 border border-red-200 dark:border-red-800">
                    <Headset size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
                    <span>
                      <span className="font-bold">Assinatura suspensa pela administração da plataforma. </span>
                      Fale com o suporte: <a href={`mailto:${BRAND.supportEmail}`} className="font-bold underline">{BRAND.supportEmail}</a>.
                    </span>
                  </p>
                )}
                {manualPayment && (
                  <p className="flex items-start gap-2 px-3 py-2.5 rounded-xl text-sm bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200 border border-blue-200 dark:border-blue-800">
                    <Headset size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
                    <span>
                      <span className="font-bold">Há uma cobrança a regularizar. </span>
                      O pagamento da assinatura é registrado pela plataforma (pagamento online indisponível): fale com o suporte para pagar.
                    </span>
                  </p>
                )}
                {canceled && (
                  <p className="flex items-start gap-2 px-3 py-2.5 rounded-xl text-sm bg-gray-50 dark:bg-slate-900/40 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-slate-700">
                    <Info size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
                    <span>A assinatura foi cancelada. Para voltar a vender, fale com o suporte da plataforma e contrate um plano.</span>
                  </p>
                )}
                <div className="flex flex-col sm:flex-row flex-wrap gap-2">
                  {showPayButton && (
                    <button type="button" onClick={handleCheckout} disabled={busy} className={buttonClass('primary')}>
                      {checkingOut ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <CreditCard size={16} aria-hidden="true" />}
                      {payLabel}
                    </button>
                  )}
                  {pendingCheckoutUrl && (
                    <a href={pendingCheckoutUrl} className={buttonClass('secondary')}>
                      <ExternalLink size={16} aria-hidden="true" /> Continuar o pagamento pendente
                    </a>
                  )}
                  {(manualPayment || canceled || cancelScheduledByPlatform) && (
                    <a href={`mailto:${BRAND.supportEmail}`} className={buttonClass(manualPayment ? 'primary' : 'secondary')}>
                      <Headset size={16} aria-hidden="true" /> Falar com o suporte
                    </a>
                  )}
                  {canResume && (
                    <button type="button" onClick={handleResume} disabled={busy} className={buttonClass('primary')}>
                      {resuming ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={16} aria-hidden="true" />}
                      Desistir do cancelamento
                    </button>
                  )}
                  {canCancel && (
                    <button type="button" onClick={() => setCancelOpen(true)} disabled={busy} className={buttonClass('ghost', 'md', 'text-red-600 dark:text-red-400 sm:ml-auto')}>
                      {immediateCancel ? 'Cancelar assinatura' : 'Cancelar no fim do período'}
                    </button>
                  )}
                </div>
              </div>
            )}
            {readOnly && (
              <p className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                <Headset size={14} aria-hidden="true" /> Sessão de suporte: ações da assinatura indisponíveis (somente leitura).
              </p>
            )}
          </section>

          {/* Datas */}
          <section aria-labelledby="dates-title" className={cx(CARD_CLASS, 'p-5 sm:p-6')}>
            <h2 id="dates-title" className="text-lg font-bold text-gray-800 dark:text-white flex items-center gap-2 mb-4">
              <CalendarClock size={20} className="text-orange-600 dark:text-orange-400" aria-hidden="true" /> Datas
            </h2>
            <dl className="space-y-3 text-sm">
              <DateRow label="Início do período" value={subscription.current_period_start} />
              <DateRow
                label={subscription.cancel_at_period_end ? 'Termina em (cancelamento agendado)' : 'Fim do período / próxima cobrança'}
                value={subscription.current_period_end}
                highlight={subscription.cancel_at_period_end}
              />
              {subscription.trial_ends_at && <DateRow label="Teste grátis até" value={subscription.trial_ends_at} />}
              {subscription.past_due_since && <DateRow label="Pagamento em atraso desde" value={subscription.past_due_since} highlight />}
              {subscription.grace_period_ends_at && <DateRow label="Tolerância até" value={subscription.grace_period_ends_at} highlight />}
              {subscription.suspended_at && <DateRow label="Suspensa em" value={subscription.suspended_at} highlight />}
              {subscription.canceled_at && <DateRow label="Cancelada em" value={subscription.canceled_at} />}
            </dl>
          </section>
        </div>
      )}

      {/* Limites × uso */}
      <section aria-labelledby="usage-title" className={cx(CARD_CLASS, 'p-5 sm:p-6')}>
        <h2 id="usage-title" className="text-lg font-bold text-gray-800 dark:text-white mb-1">Limites e uso</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
          {overview.limitsAvailable
            ? overview.storage
              ? 'Equipe ativa, produtos fora da lixeira, pedidos do mês (calendário da loja) e armazenamento das imagens. Ao atingir um limite, novos cadastros, pedidos ou imagens são recusados.'
              : 'Equipe ativa, produtos fora da lixeira e pedidos do mês (calendário da loja). Ao atingir um limite, novos cadastros ou pedidos são recusados.'
            : 'Sem assinatura vigente não há limites de plano: abaixo, só o uso atual. Os limites voltam a valer quando um plano for contratado.'}
        </p>
        <div className={cx('grid grid-cols-1 gap-5', overview.storage ? 'sm:grid-cols-2 xl:grid-cols-4' : 'md:grid-cols-3')}>
          {overview.usage.map((item) => <UsageMeter key={item.key} item={item} limitsAvailable={overview.limitsAvailable} />)}
          {overview.storage && <StorageMeter storage={overview.storage} limitsAvailable={overview.limitsAvailable} />}
        </div>
      </section>

      {/* Faturas */}
      <section aria-labelledby="invoices-title" className="space-y-3">
        <h2 id="invoices-title" className="text-lg font-bold text-gray-800 dark:text-white flex items-center gap-2">
          <Receipt size={20} className="text-orange-600 dark:text-orange-400" aria-hidden="true" /> Faturas
        </h2>
        <DataTable
          stackOnMobile
          caption="Faturas da assinatura"
          columns={INVOICE_COLUMNS}
          rows={overview.invoices}
          rowKey={(invoice) => invoice.id}
          loading={resource.loading}
          emptyIcon={<Receipt size={28} />}
          emptyTitle="Nenhuma fatura ainda"
          emptyDescription="As cobranças da assinatura aparecem aqui (planos gratuitos e o período de teste não geram faturas)."
        />
      </section>

      <ConfirmModal
        isOpen={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={handleCancel}
        closeOnConfirm={false}
        loading={canceling}
        title="Cancelar a assinatura?"
        message={!immediateCancel && subscription?.current_period_end
          ? `A assinatura continua valendo até ${formatDate(subscription.current_period_end)}. Depois disso a loja deixa de vender (o painel continua disponível para consulta). Você pode desistir do cancelamento até lá.`
          : 'Sem período pago a terminar, o cancelamento é na hora e não pode ser desfeito: a loja deixa de vender imediatamente. O painel continua disponível para consulta.'}
        confirmLabel="Cancelar assinatura"
        cancelLabel="Manter assinatura"
        isDestructive
      >
        <div className="space-y-1.5">
          <label htmlFor={reasonId} className="block text-xs font-bold uppercase tracking-wide text-gray-700 dark:text-gray-300">
            Motivo (opcional)
          </label>
          <textarea
            id={reasonId}
            rows={3}
            value={cancelReason}
            onChange={(event) => setCancelReason(event.target.value)}
            maxLength={REASON_MAX_LENGTH}
            placeholder="Conte o que levou ao cancelamento (ajuda a melhorar o serviço)."
            className={fieldControlClass(false, 'resize-y')}
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 text-right">{cancelReason.length}/{REASON_MAX_LENGTH}</p>
        </div>
      </ConfirmModal>
    </div>
  );
}

function DateRow({ label, value, highlight = false }: { label: string; value: string | null; highlight?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className={cx('font-bold tabular-nums text-right', highlight && value ? 'text-amber-700 dark:text-amber-300' : 'text-gray-800 dark:text-gray-100')}>
        {formatDate(value)}
      </dd>
    </div>
  );
}

const INVOICE_COLUMNS: DataTableColumn<StoreInvoice>[] = [
  {
    key: 'period',
    header: 'Período',
    className: 'whitespace-nowrap',
    cell: (invoice) => `${formatDate(invoice.period_start)} – ${formatDate(invoice.period_end)}`,
  },
  {
    key: 'due',
    header: 'Vencimento',
    className: 'whitespace-nowrap',
    cell: (invoice) => formatDate(invoice.due_at),
  },
  {
    key: 'amount',
    header: 'Valor',
    align: 'right',
    className: 'tabular-nums whitespace-nowrap font-bold',
    cell: (invoice) => formatCurrency(invoice.amount),
  },
  {
    key: 'status',
    header: 'Situação',
    cell: (invoice) => {
      const meta = statusMeta(INVOICE_STATUS, invoice.status);
      return (
        <div className="flex flex-col gap-1">
          <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
          {invoice.failure_reason && <span className="text-xs text-red-600 dark:text-red-400">{invoice.failure_reason}</span>}
        </div>
      );
    },
  },
  {
    key: 'paid',
    header: 'Pagamento',
    className: 'hidden md:table-cell whitespace-nowrap',
    headerClassName: 'hidden md:table-cell',
    cell: (invoice) => (invoice.paid_at
      ? <span>{formatDate(invoice.paid_at)} · {invoiceMethodLabel(invoice.payment_method)}</span>
      : <span className="text-gray-400">—</span>),
  },
];

/**
 * Uso de um limite do plano (barra com o mesmo tom no trilho; perto do limite e no limite mudam de cor com texto).
 * limitsAvailable false: sem assinatura vigente, mostra só o uso (limite nulo aqui não é "ilimitado").
 */
function UsageMeter({ item, limitsAvailable }: { item: PlanUsageItem; limitsAvailable: boolean }) {
  const label = PLAN_LIMIT_LABELS[item.key];
  const used = item.used;
  const limit = limitsAvailable ? item.limit : null;

  let state: { text: string; bar: string; track: string; badge: ReactNode | null };
  if (!limitsAvailable) {
    state = { text: 'Sem plano vigente', bar: '', track: '', badge: <StatusBadge tone="neutral">Sem plano vigente</StatusBadge> };
  } else if (limit === null) {
    state = { text: 'Ilimitado', bar: '', track: '', badge: <StatusBadge tone="success">Ilimitado</StatusBadge> };
  } else if (used !== null && used >= limit) {
    state = { text: `${used} de ${limit}`, bar: 'bg-red-500', track: 'bg-red-100 dark:bg-red-900/30', badge: <StatusBadge tone="danger" icon={<AlertTriangle size={12} />}>Limite atingido</StatusBadge> };
  } else if (used !== null && limit > 0 && used / limit >= 0.8) {
    state = { text: `${used} de ${limit}`, bar: 'bg-amber-500', track: 'bg-amber-100 dark:bg-amber-900/30', badge: <StatusBadge tone="warning">Perto do limite</StatusBadge> };
  } else {
    state = { text: used === null ? `Limite de ${limit}` : `${used} de ${limit}`, bar: 'bg-orange-500', track: 'bg-orange-100 dark:bg-orange-900/30', badge: null };
  }

  const percent = limit && used !== null ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  return (
    <div className="p-4 rounded-xl border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/40 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-bold text-gray-700 dark:text-gray-200">{label}</p>
        {state.badge}
      </div>
      <p className="text-2xl font-bold text-gray-800 dark:text-white">
        {limit === null ? (used ?? '—') : state.text}
        {limit === null && <span className="text-sm font-semibold text-gray-500 dark:text-gray-400"> em uso</span>}
      </p>
      {limit !== null && (
        <div
          role="progressbar"
          aria-label={`${label}: ${used ?? 'uso não informado'} de ${limit}`}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={used ?? undefined}
          className={cx('h-2.5 rounded-full overflow-hidden', state.track)}
        >
          <div className={cx('h-full rounded-full transition-all', state.bar)} style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}


/**
 * Armazenamento das imagens da loja (produtos, adicionais e logo; fotos de perfil não contam) × limite do plano.
 * Mesmo visual do UsageMeter; acima do limite, novas imagens são recusadas (as que já existem continuam).
 */
function StorageMeter({ storage, limitsAvailable }: { storage: PlanStorage; limitsAvailable: boolean }) {
  const label = 'Armazenamento';
  const used = storage.used_mb;
  const limit = limitsAvailable ? storage.limit_mb : null;
  const usedText = used === null ? '—' : formatMegabytes(used);
  const limitText = limit === null ? '' : formatMegabytes(limit);
  const atLimit = limit !== null && used !== null && used >= limit;
  const near = !atLimit && limit !== null && used !== null && limit > 0 && used / limit >= 0.8;
  const percent = limit && used !== null ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  let badge: ReactNode = null;
  if (!limitsAvailable) badge = <StatusBadge tone="neutral">Sem plano vigente</StatusBadge>;
  else if (limit === null) badge = <StatusBadge tone="success">Ilimitado</StatusBadge>;
  else if (atLimit) badge = <StatusBadge tone="danger" icon={<AlertTriangle size={12} />}>Limite atingido</StatusBadge>;
  else if (near) badge = <StatusBadge tone="warning">Perto do limite</StatusBadge>;

  const bar = atLimit ? 'bg-red-500' : near ? 'bg-amber-500' : 'bg-orange-500';
  const track = atLimit ? 'bg-red-100 dark:bg-red-900/30' : near ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-orange-100 dark:bg-orange-900/30';
  const measured = toDate(storage.measured_at);
  const details = [
    storage.files !== null ? `${storage.files} ${storage.files === 1 ? 'arquivo' : 'arquivos'}` : null,
    measured ? `medido às ${formatTime(measured)}` : null,
    used === null ? 'uso indisponível no momento' : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="p-4 rounded-xl border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/40 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-bold text-gray-700 dark:text-gray-200">{label}</p>
        {badge}
      </div>
      <p className="text-2xl font-bold text-gray-800 dark:text-white">
        {usedText}
        <span className="text-sm font-semibold text-gray-500 dark:text-gray-400">{limit === null ? ' em uso' : ` de ${limitText}`}</span>
      </p>
      {limit !== null && (
        <div
          role="progressbar"
          aria-label={`${label}: ${usedText} de ${limitText}`}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={used ?? undefined}
          className={cx('h-2.5 rounded-full overflow-hidden', track)}
        >
          <div className={cx('h-full rounded-full transition-all', bar)} style={{ width: `${percent}%` }} />
        </div>
      )}
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Imagens de produtos, adicionais e o logo (fotos de perfil não contam){details ? `. ${details}` : ''}.
      </p>
    </div>
  );
}
