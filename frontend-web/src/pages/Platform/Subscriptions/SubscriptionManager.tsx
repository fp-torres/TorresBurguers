import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Ban, CalendarClock, CheckCircle2, CircleSlash, ExternalLink, History, Info, PauseCircle, PlayCircle, Receipt,
  Repeat, ShieldAlert, Undo2, XCircle,
} from 'lucide-react';
import {
  CARD_CLASS, DataTable, ErrorState, StatusBadge, buttonClass, cx, type DataTableColumn,
} from '../../../components/ui';
import PageLoader from '../../../components/PageLoader';
import { platformSubscriptionsService } from '../../../services/platform/subscriptionsService';
import type { PlatformInvoice, PlatformSubscriptionDetail, SubscriptionEvent } from '../../../services/platform/billingParsers';
import { isBlockedAvailability } from '../../../services/storeAccess';
import { INVOICE_STATUS, STORE_ACCOUNT_STATUS, SUBSCRIPTION_STATUS, statusMeta } from '../../../utils/saasStatus';
import { formatCurrency, formatDateTime } from '../../../utils/format';
import AuditLink from '../Audit/AuditLink';
import { auditUrl } from '../Audit/urlFilters';
import { usePlanOptions } from '../Plans/usePlanOptions';
import {
  CancelSubscriptionDialog, ChangePlanDialog, CreateInvoiceDialog, ReactivateSubscriptionDialog, ResumeSubscriptionDialog,
  SuspendSubscriptionDialog,
} from './SubscriptionDialogs';
import { InvoiceReasonDialog, MarkInvoicePaidDialog, type InvoiceTarget } from './InvoiceDialogs';
import UsageMeters from './UsageMeters';
import {
  AVAILABILITY_META, eventLabel, invoiceMethodLabel, isInvoiceOverdue, isInvoiceUnpaid, planPriceLabel, providerLabel, subscriptionActions,
} from './billingDisplay';
import { formatDate } from '../../../utils/dates';
import { useResource } from '../../../hooks/useResource';
import { useNow } from '../../../hooks/useNow';

interface SubscriptionManagerProps {
  subscriptionId: number;
  /** Mostra o link para o estabelecimento (tela de Assinaturas). */
  showStoreLink?: boolean;
  /** Nível dos títulos das seções (2 dentro da página; 3 dentro de um diálogo/aba com título próprio). */
  headingLevel?: 2 | 3;
  /**
   * Mostra a situação atual da loja (calculada pela API com a assinatura vigente dela, mesmo quando esta é antiga
   * ou cancelada). false quando a página já mostra o mesmo aviso (ex.: detalhe do estabelecimento).
   */
  showAccess?: boolean;
  /** Chamado depois de qualquer mudança na assinatura ou nas faturas, com o detalhe atualizado. */
  onChanged?: (detail: PlatformSubscriptionDetail) => void;
}

type SubscriptionDialog = 'change-plan' | 'cancel' | 'resume' | 'suspend' | 'reactivate' | 'invoice' | null;

const EVENTS_PREVIEW = 15;

/** Origem do evento gravada em metadata.trigger (mudanças de situação). */
const TRIGGER_LABELS: Record<string, string> = {
  'platform.suspend': 'suspensão pelo superpainel',
  'platform.reactivate': 'reativação pelo superpainel',
  'platform.reactivate_forced': 'reativação forçada pelo superpainel',
  'platform.void': 'anulação pelo superpainel',
  'platform.invoice': 'fatura avulsa do superpainel',
  'invoice.paid': 'pagamento de fatura',
  'invoice.void': 'fatura anulada',
  'cancel.now': 'cancelamento imediato',
  'cancel.no_period': 'cancelamento (sem período a vencer)',
  'lifecycle.trial_end': 'fim do teste grátis (rotina)',
  'lifecycle.period_end': 'fim do período (rotina)',
  'lifecycle.invoice_overdue': 'fatura vencida (rotina)',
  'lifecycle.no_overdue_invoice': 'sem fatura vencida (rotina)',
  'lifecycle.grace_ended': 'fim da tolerância (rotina)',
  reactivation: 'reativação',
  'subscription.create': 'contratação',
  'subscription.change_plan': 'mudança de plano',
};

/**
 * Assinatura de uma loja no superpainel (GET /platform/subscriptions/:id): plano, situação, datas, uso × limites,
 * faturas e histórico, com as ações mudar plano, cancelar, desfazer o cancelamento agendado, reativar, suspender,
 * gerar fatura e registrar pagamento/falha/anulação, e os links para a auditoria da assinatura e de cada fatura.
 * Usado na tela de Assinaturas e na aba Assinatura do estabelecimento.
 */
export default function SubscriptionManager({ subscriptionId, showStoreLink = false, headingLevel = 3, showAccess = true, onChanged }: SubscriptionManagerProps) {
  const resource = useResource((signal) => platformSubscriptionsService.get(subscriptionId, signal), {
    key: String(subscriptionId),
    errorMessage: 'Não foi possível carregar a assinatura.',
  });
  const planOptions = usePlanOptions();
  const now = useNow();
  const [dialog, setDialog] = useState<SubscriptionDialog>(null);
  const [paidTarget, setPaidTarget] = useState<InvoiceTarget | null>(null);
  const [reasonTarget, setReasonTarget] = useState<{ target: InvoiceTarget; action: 'fail' | 'void' } | null>(null);
  const [showAllEvents, setShowAllEvents] = useState(false);

  const detail = resource.data;
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const { setData, reload } = resource;

  function applyDetail(next: PlatformSubscriptionDetail) {
    setData(next);
    onChanged?.(next);
  }

  /**
   * Relê o detalhe e avisa quem usa o componente: depois de uma ação numa fatura (que devolve só a fatura; a
   * situação da assinatura pode ter mudado) ou de uma recusa 409 (a assinatura mudou por fora).
   */
  async function refreshDetail() {
    try {
      applyDetail(await platformSubscriptionsService.get(subscriptionId));
    } catch {
      // A ação já foi feita; a nova leitura falhou: o aviso "dados desatualizados" oferece tentar de novo
      void reload({ silent: true });
    }
  }

  if (!detail) {
    return resource.error ? (
      <div className={CARD_CLASS}>
        <ErrorState
          message={resource.errorStatus === 404 ? 'Assinatura não encontrada.' : resource.error}
          onRetry={resource.errorStatus === 404 ? undefined : () => void resource.reload()}
          retrying={resource.loading}
          compact
        />
      </div>
    ) : <PageLoader />;
  }

  const status = statusMeta(SUBSCRIPTION_STATUS, detail.status);
  const actions = subscriptionActions(detail, now);
  const plan = detail.plan;
  const canceled = detail.status === 'CANCELED';
  // A API calcula a situação pela assinatura vigente da loja (mesmo quando esta é antiga ou cancelada) e devolve
  // limits = null para assinatura cancelada (os limites dela não valem mais)
  const access = detail.access;
  const storeName = detail.store?.name ?? `Estabelecimento #${detail.store_id}`;
  const anyAction = actions.changePlan || actions.cancel || actions.reactivate || actions.suspend || actions.createInvoice;
  const events = showAllEvents ? detail.events : detail.events.slice(0, EVENTS_PREVIEW);
  const scheduledCancel = detail.cancel_at_period_end && !canceled;

  const invoiceColumns: DataTableColumn<PlatformInvoice>[] = [
    {
      key: 'invoice',
      header: 'Fatura',
      className: 'whitespace-nowrap',
      cell: (invoice) => (
        <div>
          <p className="font-bold text-gray-800 dark:text-white">#{invoice.id}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">{formatDate(invoice.period_start)} – {formatDate(invoice.period_end)}</p>
        </div>
      ),
    },
    {
      key: 'due',
      header: 'Vencimento',
      className: 'whitespace-nowrap',
      cell: (invoice) => (
        <div className="flex flex-col gap-1">
          <span>{formatDate(invoice.due_at)}</span>
          {isInvoiceOverdue(invoice, now) && <StatusBadge tone="danger" icon={<AlertTriangle size={12} />}>Vencida</StatusBadge>}
        </div>
      ),
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
          <div className="flex flex-col gap-1 max-w-56">
            <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
            {invoice.failure_reason && invoice.status === 'FAILED' && (
              <span className="text-xs text-red-700 dark:text-red-400">{invoice.failure_reason}{invoice.attempts > 1 ? ` (${invoice.attempts} tentativas)` : ''}</span>
            )}
          </div>
        );
      },
    },
    {
      key: 'payment',
      header: 'Pagamento',
      className: 'hidden md:table-cell',
      headerClassName: 'hidden md:table-cell',
      cell: (invoice) => (
        <div className="text-xs space-y-0.5 max-w-64">
          {invoice.paid_at
            ? <p className="text-gray-700 dark:text-gray-200">{formatDateTime(invoice.paid_at)} · {invoiceMethodLabel(invoice.payment_method)}</p>
            : <p className="text-gray-400">—</p>}
          {invoice.provider_payment_id && <p className="font-mono text-gray-500 dark:text-gray-400 break-all">{invoice.provider_payment_id}</p>}
          {invoice.notes && <p className="text-gray-500 dark:text-gray-400 wrap-break-word">Obs.: {invoice.notes}</p>}
        </div>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Ações</span>,
      align: 'right',
      cell: (invoice) => (
        <div className="flex flex-wrap justify-end gap-1.5">
          {isInvoiceUnpaid(invoice) && (
            <>
              <button
                type="button"
                onClick={() => setPaidTarget({ invoice, storeName })}
                aria-label={`Registrar o pagamento da fatura #${invoice.id}`} title="Registrar pagamento"
                className={buttonClass('secondary', 'sm')}
              >
                <CheckCircle2 size={14} aria-hidden="true" /> <span className="hidden 2xl:inline">Pagamento</span>
              </button>
              <button
                type="button"
                onClick={() => setReasonTarget({ target: { invoice, storeName }, action: 'fail' })}
                aria-label={`Marcar o pagamento da fatura #${invoice.id} como recusado`} title="Pagamento recusado"
                className={buttonClass('ghost', 'sm')}
              >
                <XCircle size={14} aria-hidden="true" /> <span className="hidden 2xl:inline">Recusado</span>
              </button>
              <button
                type="button"
                onClick={() => setReasonTarget({ target: { invoice, storeName }, action: 'void' })}
                aria-label={`Anular a fatura #${invoice.id}`} title="Anular fatura"
                className={buttonClass('ghost', 'sm', 'text-red-600 dark:text-red-400')}
              >
                <CircleSlash size={14} aria-hidden="true" /> <span className="hidden 2xl:inline">Anular</span>
              </button>
            </>
          )}
          <AuditLink
            to={auditUrl({ target_type: 'subscription_invoice', target_id: invoice.id })}
            label={`Ver auditoria da fatura #${invoice.id}`}
            variant="ghost"
          >
            <span className="hidden 2xl:inline">Auditoria</span>
          </AuditLink>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {resource.error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-2xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
          <AlertTriangle size={16} className="shrink-0" aria-hidden="true" />
          <span className="flex-1 min-w-48">{resource.error} Os dados abaixo podem estar desatualizados.</span>
          <button type="button" onClick={() => void resource.reload()} className="font-bold hover:underline">Tentar novamente</button>
        </div>
      )}

      {/* Plano, situação e ações */}
      <section aria-label="Plano e situação da assinatura" className={cx(CARD_CLASS, 'p-5 sm:p-6 space-y-5')}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">Assinatura #{detail.id}</p>
            <Heading className="text-xl font-bold text-gray-800 dark:text-white wrap-break-word">
              {plan?.name ?? `Plano #${detail.plan_id}`}
              {plan?.code && <span className="ml-2 font-mono text-xs font-semibold text-gray-500 dark:text-gray-400">{plan.code}</span>}
            </Heading>
            <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
              <span className="font-bold">{plan ? planPriceLabel(plan.price, plan.billing_interval) : '—'}</span>
              {plan && plan.price > 0 && plan.billing_interval === 'YEARLY' && <> · equivale a {formatCurrency(plan.monthly_price)} por mês</>}
              {plan?.status === 'INACTIVE' && <> · plano indisponível para novas contratações</>}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Cobrança: {providerLabel(detail.billing_provider)}
              {detail.provider_status && <> · situação no provedor: <span className="font-mono">{detail.provider_status}</span></>}
            </p>
          </div>
          <div className="flex flex-col items-start sm:items-end gap-2">
            <div className="flex flex-wrap gap-2">
              <StatusBadge tone={status.tone} dot>{status.label}</StatusBadge>
              {scheduledCancel && (
                <StatusBadge tone="warning" icon={<CalendarClock size={12} />}>Cancela em {formatDate(detail.current_period_end)}</StatusBadge>
              )}
            </div>
            <AuditLink to={auditUrl({ target_type: 'subscription', target_id: detail.id })} label={`Ver auditoria da assinatura #${detail.id}`} variant="ghost">
              Ver auditoria
            </AuditLink>
          </div>
        </div>

        {showStoreLink && detail.store && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-gray-500 dark:text-gray-400">Estabelecimento:</span>
            <Link
              to={`/platform/stores/${detail.store.id}`}
              className="inline-flex items-center gap-1 font-bold text-orange-700 dark:text-orange-400 hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              {detail.store.name} <ExternalLink size={14} aria-hidden="true" />
            </Link>
            <span className="font-mono text-xs text-gray-500 dark:text-gray-400">/{detail.store.slug}</span>
            {detail.store.account_status !== 'ACTIVE' && (() => {
              const meta = statusMeta(STORE_ACCOUNT_STATUS, detail.store.account_status);
              return <StatusBadge tone={meta.tone}>Loja {meta.label.toLowerCase()}</StatusBadge>;
            })()}
          </div>
        )}

        {showAccess && access && (
          <div
            role={isBlockedAvailability(access.availability) ? 'alert' : 'status'}
            className={cx(
              'flex items-start gap-3 px-4 py-3 rounded-xl text-sm border',
              access.message === null
                ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300 border-green-200 dark:border-green-800'
                : isBlockedAvailability(access.availability)
                  ? 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 border-red-200 dark:border-red-800'
                  : 'bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-800',
            )}
          >
            {access.message === null
              ? <CheckCircle2 size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
              : <ShieldAlert size={18} className="shrink-0 mt-0.5" aria-hidden="true" />}
            <p>
              <span className="font-bold">Situação atual da loja: {AVAILABILITY_META[access.availability]?.label ?? access.availability}. </span>
              {access.message ?? 'Vendendo normalmente.'}
              {canceled && (
                <span className="block mt-1 text-xs opacity-90">Calculada pela assinatura vigente da loja, não por esta (cancelada).</span>
              )}
            </p>
          </div>
        )}

        {scheduledCancel && (actions.resume ? (
          <div
            role="status"
            className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3 rounded-xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800"
          >
            <p className="flex items-start gap-2 flex-1 min-w-0">
              <CalendarClock size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
              <span>
                <span className="font-bold">
                  Cancelamento agendado{detail.current_period_end ? ` para ${formatDate(detail.current_period_end)}` : ''}
                  {detail.cancel_scheduled_by === 'PLATFORM' ? ' pela plataforma' : detail.cancel_scheduled_by === 'STORE' ? ' pela loja' : ''}.
                </span>{' '}
                A assinatura vale até lá e depois vira Cancelada. Dá para desfazer enquanto o período não terminar.
              </span>
            </p>
            <button type="button" onClick={() => setDialog('resume')} className={buttonClass('secondary', 'sm', 'shrink-0')}>
              <Undo2 size={14} aria-hidden="true" /> Desfazer cancelamento
            </button>
          </div>
        ) : (
          <p className="flex items-start gap-2 px-4 py-3 rounded-xl text-sm bg-gray-50 dark:bg-slate-900/40 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-slate-700">
            <Info size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              O período terminou em {formatDate(detail.current_period_end)}: o cancelamento agendado é concluído pela rotina automática
              e não pode mais ser desfeito.
            </span>
          </p>
        ))}

        {canceled && (
          <p className="flex items-start gap-2 px-4 py-3 rounded-xl text-sm bg-gray-50 dark:bg-slate-900/40 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-slate-700">
            <Info size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              Assinatura cancelada em {formatDate(detail.canceled_at)}. Cancelada é final: uma nova contratação cria outra assinatura. As faturas
              em aberto ainda podem ser registradas ou anuladas.
              {showStoreLink && detail.store && (
                <>
                  {' '}
                  <Link
                    to={`/platform/stores/${detail.store.id}?tab=subscription`}
                    className="font-bold text-orange-700 dark:text-orange-400 hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                  >
                    Ver a assinatura atual da loja
                  </Link>
                </>
              )}
            </span>
          </p>
        )}

        {anyAction && (
          <div className="flex flex-col sm:flex-row flex-wrap gap-2 pt-4 border-t border-gray-100 dark:border-slate-700">
            {actions.changePlan && (
              <button type="button" onClick={() => setDialog('change-plan')} className={buttonClass('primary')}>
                <Repeat size={16} aria-hidden="true" /> Mudar plano
              </button>
            )}
            {actions.reactivate && (
              <button type="button" onClick={() => setDialog('reactivate')} className={buttonClass('primary')}>
                <PlayCircle size={16} aria-hidden="true" /> Reativar
              </button>
            )}
            {actions.createInvoice && (
              <button type="button" onClick={() => setDialog('invoice')} className={buttonClass('secondary')}>
                <Receipt size={16} aria-hidden="true" /> Gerar fatura
              </button>
            )}
            {actions.suspend && (
              <button type="button" onClick={() => setDialog('suspend')} className={buttonClass('secondary')}>
                <PauseCircle size={16} aria-hidden="true" /> Suspender
              </button>
            )}
            {actions.cancel && (
              <button type="button" onClick={() => setDialog('cancel')} className={buttonClass('ghost', 'md', 'text-red-600 dark:text-red-400 sm:ml-auto')}>
                <Ban size={16} aria-hidden="true" /> Cancelar assinatura
              </button>
            )}
          </div>
        )}
        {detail.status === 'TRIALING' && (
          <p className="text-xs text-gray-500 dark:text-gray-400">Em teste grátis não há suspensão: ao fim do teste a rotina ativa (plano gratuito) ou gera a fatura e marca a assinatura como inadimplente.</p>
        )}
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Datas */}
        <section aria-label="Datas da assinatura" className={cx(CARD_CLASS, 'p-5 sm:p-6')}>
          <Heading className="text-base font-bold text-gray-800 dark:text-white flex items-center gap-2 mb-4">
            <CalendarClock size={18} className="text-orange-600 dark:text-orange-400" aria-hidden="true" /> Datas
          </Heading>
          <dl className="space-y-2.5 text-sm">
            <DateRow label="Criada em" value={detail.created_at} />
            {detail.trial_ends_at && <DateRow label="Teste grátis até" value={detail.trial_ends_at} />}
            <DateRow label="Início do período" value={detail.current_period_start} />
            <DateRow
              label={detail.cancel_at_period_end ? 'Termina em (cancelamento agendado)' : 'Fim do período / renovação'}
              value={detail.current_period_end}
              empty="Sem vencimento"
              highlight={detail.cancel_at_period_end}
            />
            {detail.past_due_since && <DateRow label="Em atraso desde" value={detail.past_due_since} highlight />}
            {detail.grace_period_ends_at && <DateRow label="Tolerância até" value={detail.grace_period_ends_at} highlight />}
            {detail.suspended_at && (
              <DateRow
                label={detail.suspended_by === 'PLATFORM'
                  ? 'Suspensa pela plataforma em (só a reativação desfaz)'
                  : detail.suspended_by === 'BILLING'
                    ? 'Suspensa por inadimplência em'
                    : 'Suspensa em'}
                value={detail.suspended_at}
                highlight
              />
            )}
            {detail.canceled_at && <DateRow label="Cancelada em" value={detail.canceled_at} />}
          </dl>
        </section>

        {/* Uso × limites */}
        <section aria-label="Uso e limites do plano" className={cx(CARD_CLASS, 'p-5 sm:p-6 xl:col-span-2')}>
          <Heading className="text-base font-bold text-gray-800 dark:text-white mb-1">Uso × limites do plano</Heading>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            Uso atual da loja: equipe ativa, produtos fora da lixeira, pedidos do mês no calendário da loja e armazenamento das imagens (produtos, adicionais e logo; fotos de perfil não contam).{' '}
            {canceled ? 'Assinatura cancelada: os limites dela não valem mais (veja a assinatura vigente da loja).' : `Limites de ${plan?.name ?? 'plano não informado'}.`}
          </p>
          <UsageMeters usage={detail.usage} limits={detail.limits} storage={detail.storage} noLimitsLabel={canceled ? 'Não se aplica' : undefined} />
        </section>
      </div>

      {/* Faturas */}
      <section aria-label="Faturas da assinatura" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <Heading className="text-base font-bold text-gray-800 dark:text-white flex items-center gap-2">
              <Receipt size={18} className="text-orange-600 dark:text-orange-400" aria-hidden="true" /> Faturas
            </Heading>
            <p className="text-xs text-gray-500 dark:text-gray-400">Receita da plataforma (assinatura SaaS), separada das vendas da loja. Mais recentes primeiro (até 100).</p>
          </div>
        </div>
        <DataTable
          stackOnMobile
          caption={`Faturas da assinatura #${detail.id}`}
          columns={invoiceColumns}
          rows={detail.invoices}
          rowKey={(invoice) => invoice.id}
          scrollClassName="max-h-[28rem]"
          rowClassName={(invoice) => (isInvoiceOverdue(invoice, now) ? 'bg-red-50/40 dark:bg-red-900/10' : undefined)}
          emptyIcon={<Receipt size={28} />}
          emptyTitle="Nenhuma fatura"
          emptyDescription="Planos gratuitos e o período de teste não geram faturas. Gere uma fatura avulsa se precisar cobrar algo."
        />
      </section>

      {/* Histórico */}
      <section aria-label="Histórico da assinatura" className={cx(CARD_CLASS, 'p-5 sm:p-6')}>
        <Heading className="text-base font-bold text-gray-800 dark:text-white flex items-center gap-2 mb-4">
          <History size={18} className="text-orange-600 dark:text-orange-400" aria-hidden="true" /> Histórico
        </Heading>
        {detail.events.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Nenhum evento registrado.</p>
        ) : (
          <>
            <ol className="relative space-y-4 border-l border-gray-200 dark:border-slate-700 ml-2">
              {events.map((event) => (
                <EventItem key={event.id} event={event} planName={(id) => planOptions.byId.get(id)?.name ?? `Plano #${id}`} />
              ))}
            </ol>
            {detail.events.length > EVENTS_PREVIEW && (
              <button type="button" onClick={() => setShowAllEvents((current) => !current)} className={buttonClass('ghost', 'sm', 'mt-4')}>
                {showAllEvents ? 'Mostrar menos' : `Mostrar todos os ${detail.events.length} eventos`}
              </button>
            )}
          </>
        )}
      </section>

      <ChangePlanDialog
        open={dialog === 'change-plan'}
        subscription={detail}
        plans={planOptions.plans}
        plansLoading={planOptions.loading}
        onClose={() => setDialog(null)}
        onDone={applyDetail}
      />
      <CancelSubscriptionDialog
        open={dialog === 'cancel'}
        subscription={detail}
        canScheduleAtPeriodEnd={actions.cancelAtPeriodEnd}
        onClose={() => setDialog(null)}
        onDone={applyDetail}
      />
      <ResumeSubscriptionDialog
        open={dialog === 'resume'}
        subscription={detail}
        onClose={() => setDialog(null)}
        onDone={applyDetail}
        onStale={() => void refreshDetail()}
      />
      <SuspendSubscriptionDialog open={dialog === 'suspend'} subscription={detail} onClose={() => setDialog(null)} onDone={applyDetail} />
      <ReactivateSubscriptionDialog open={dialog === 'reactivate'} subscription={detail} now={now} onClose={() => setDialog(null)} onDone={applyDetail} />
      <CreateInvoiceDialog
        open={dialog === 'invoice'}
        subscription={detail}
        onClose={() => setDialog(null)}
        onCreated={() => void refreshDetail()}
      />
      <MarkInvoicePaidDialog target={paidTarget} now={now} onClose={() => setPaidTarget(null)} onDone={() => void refreshDetail()} />
      <InvoiceReasonDialog
        target={reasonTarget?.target ?? null}
        action={reasonTarget?.action ?? 'fail'}
        onClose={() => setReasonTarget(null)}
        onDone={() => void refreshDetail()}
      />
    </div>
  );
}

function DateRow({ label, value, empty = '—', highlight = false }: { label: string; value: string | null; empty?: string; highlight?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className={cx('font-bold tabular-nums text-right', highlight && value ? 'text-amber-700 dark:text-amber-300' : 'text-gray-800 dark:text-gray-100')}>
        {value ? formatDate(value) : empty}
      </dd>
    </div>
  );
}

function statusLabel(value: string | null): string {
  return statusMeta(SUBSCRIPTION_STATUS, value).label;
}

function EventItem({ event, planName }: { event: SubscriptionEvent; planName: (id: number) => string }) {
  const metadata = event.metadata ?? {};
  const details: ReactNode[] = [];
  if (event.from_status || event.to_status) {
    details.push(
      <span key="status">{event.from_status ? `${statusLabel(event.from_status)} → ` : ''}{statusLabel(event.to_status)}</span>,
    );
  }
  if (event.from_plan_id || event.to_plan_id) {
    details.push(
      <span key="plan">{event.from_plan_id ? `${planName(event.from_plan_id)} → ` : 'Plano: '}{event.to_plan_id ? planName(event.to_plan_id) : '—'}</span>,
    );
  }
  const invoiceId = Number(metadata.invoice_id);
  if (Number.isInteger(invoiceId) && invoiceId > 0) details.push(<span key="invoice">Fatura #{invoiceId}</span>);
  const amount = Number(metadata.amount);
  if (metadata.amount !== undefined && metadata.amount !== null && Number.isFinite(amount)) details.push(<span key="amount">{formatCurrency(amount)}</span>);
  const trigger = typeof metadata.trigger === 'string' ? metadata.trigger : null;
  if (trigger) details.push(<span key="trigger">Origem: {TRIGGER_LABELS[trigger] ?? trigger}</span>);

  const actor = event.actor
    ? `${event.actor.name ?? 'Usuário'}${event.actor.email ? ` (${event.actor.email})` : ''}`
    : event.actor_user_id ? `Usuário #${event.actor_user_id}` : 'Sistema (rotina automática ou provedor de cobrança)';

  return (
    <li className="ml-4">
      <span className="absolute -left-1.25 mt-1.5 w-2.5 h-2.5 rounded-full bg-orange-500 ring-2 ring-white dark:ring-slate-800" aria-hidden="true" />
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p className="font-bold text-sm text-gray-800 dark:text-white">{eventLabel(event.type)}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">{formatDateTime(event.created_at)}</p>
      </div>
      {details.length > 0 && (
        <p className="text-sm text-gray-600 dark:text-gray-300 flex flex-wrap gap-x-3 gap-y-0.5">{details}</p>
      )}
      {event.reason && <p className="text-sm text-gray-600 dark:text-gray-300 wrap-break-word">Motivo: “{event.reason}”</p>}
      <p className="text-xs text-gray-500 dark:text-gray-400">Por {actor}</p>
    </li>
  );
}
