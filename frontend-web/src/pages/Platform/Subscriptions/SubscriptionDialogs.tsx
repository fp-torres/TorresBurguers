import { useId, useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowRight, Info, Loader2, Receipt, Repeat } from 'lucide-react';
import toast from 'react-hot-toast';
import { FormField, Modal, buttonClass, cx, fieldControlClass } from '../../../components/ui';
import ConfirmModal from '../../../components/ConfirmModal';
import { getApiErrorMessage, getApiErrorStatus } from '../../../services/api';
import {
  BILLING_REASON_MAX_LENGTH, MAX_INVOICE_AMOUNT, overdueInvoicesOf, platformSubscriptionsService,
} from '../../../services/platform/subscriptionsService';
import {
  PLAN_LIMIT_KEYS, type PlatformInvoice, type PlatformPlan, type PlatformSubscriptionDetail,
} from '../../../services/platform/billingParsers';
import { formatMegabytes } from '../../../services/storeSubscriptionService';
import { formatCurrency } from '../../../utils/format';
import PlanSelect, { PlanFacts } from '../Plans/PlanSelect';
import ReasonField from './ReasonField';
import {
  PLAN_LIMIT_LABELS, STORAGE_LIMIT_LABEL, isInvoiceOverdue, planPriceLabel,
} from './billingDisplay';
import { formatDate, timeOf } from '../../../utils/dates';
import { dateInputToIso, moneyToInput, parseMoneyInput, reasonProblem } from './formRules';

interface DialogProps {
  open: boolean;
  subscription: PlatformSubscriptionDetail;
  onClose: () => void;
  /** Ação concluída: o detalhe atualizado devolvido pela API. */
  onDone: (detail: PlatformSubscriptionDetail) => void;
}

function storeName(subscription: PlatformSubscriptionDetail): string {
  return subscription.store?.name ?? `Estabelecimento #${subscription.store_id}`;
}

const BYTES_PER_MB = 1024 * 1024;

/** Armazenamento acima do limite do plano novo (a API compara os bytes medidos com max_storage_mb). */
function storageViolation(subscription: PlatformSubscriptionDetail, limitMb: number | null): string[] {
  const storage = subscription.storage;
  if (limitMb === null || !storage || storage.used_mb === null) return [];
  const over = storage.used_bytes !== null ? storage.used_bytes > limitMb * BYTES_PER_MB : storage.used_mb > limitMb;
  return over ? [`${STORAGE_LIMIT_LABEL}: ${formatMegabytes(storage.used_mb)} em uso (limite ${formatMegabytes(limitMb)})`] : [];
}

// ---------------------------------------------------------------------------
// Mudar plano
// ---------------------------------------------------------------------------

interface ChangePlanDialogProps extends DialogProps {
  plans: PlatformPlan[];
  plansLoading: boolean;
}

/**
 * POST /platform/subscriptions/:id/change-plan: vale na hora, sem proporcionalidade. Mostra o antes/depois e as
 * consequências antes de confirmar; downgrade que não cabe no uso atual é recusado pela API (409).
 */
export function ChangePlanDialog({ open, subscription, plans, plansLoading, onClose, onDone }: ChangePlanDialogProps) {
  if (!open) return null;
  return <ChangePlanForm subscription={subscription} plans={plans} plansLoading={plansLoading} onClose={onClose} onDone={onDone} />;
}

function ChangePlanForm({ subscription, plans, plansLoading, onClose, onDone }: Omit<ChangePlanDialogProps, 'open'>) {
  const formId = useId();
  const [planId, setPlanId] = useState<number | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [reason, setReason] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);

  const current = subscription.plan;
  const target = plans.find((plan) => plan.id === planId) ?? null;
  const reasonError = reasonProblem(reason, { maxLength: BILLING_REASON_MAX_LENGTH });
  const planError = target ? null : 'Escolha o novo plano.';

  // Uso atual que não cabe no plano escolhido (a API confere de novo e recusa com 409)
  const violations = target
    ? [
      ...PLAN_LIMIT_KEYS.flatMap((key) => {
        const limit = key === 'staff_users' ? target.max_staff_users : key === 'products' ? target.max_products : target.max_monthly_orders;
        const used = subscription.usage[key];
        return limit !== null && used !== null && used > limit ? [`${PLAN_LIMIT_LABELS[key]}: ${used} em uso (limite ${limit})`] : [];
      }),
      ...storageViolation(subscription, target.max_storage_mb),
    ]
    : [];
  const startsPeriod = !!target && subscription.status !== 'TRIALING' && target.price > 0 && subscription.current_period_end === null;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (planError || reasonError || !target) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      const detail = await platformSubscriptionsService.changePlan(subscription.id, {
        plan_id: target.id,
        allow_inactive_plan: target.status !== 'ACTIVE' ? true : undefined,
        reason: reason.trim() || undefined,
      });
      toast.success(`Plano alterado para ${target.name}.`);
      onDone(detail);
      onClose();
    } catch (error) {
      // 409: uso não cabe no plano (a mensagem lista o que excede) ou assinatura cancelada; 400: mesmo plano/indisponível
      toast.error(getApiErrorMessage(error, 'Não foi possível mudar o plano.'), { duration: 8000 });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Mudar plano"
      description={storeName(subscription)}
      dismissible={!saving}
      footer={(
        <>
          <button type="button" onClick={onClose} disabled={saving} className={buttonClass('secondary')}>Cancelar</button>
          <button type="submit" form={formId} disabled={saving || plansLoading} className={buttonClass('primary')}>
            {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Repeat size={16} aria-hidden="true" />}
            {target ? `Mudar para ${target.name}` : 'Mudar plano'}
          </button>
        </>
      )}
    >
      <form id={formId} onSubmit={handleSubmit} noValidate className="space-y-5">
        <FormField
          label="Novo plano"
          required
          error={showErrors ? planError ?? undefined : undefined}
          hint={plansLoading ? 'Carregando planos...' : undefined}
        >
          {(field) => (
            <PlanSelect
              field={field}
              plans={plans}
              value={planId}
              onChange={setPlanId}
              excludeId={subscription.plan_id}
              includeInactive={showInactive}
              invalid={showErrors && !!planError}
              disabled={plansLoading}
            />
          )}
        </FormField>
        <label className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(event) => setShowInactive(event.target.checked)}
            className="mt-0.5 w-4 h-4 accent-orange-600"
          />
          <span>Mostrar planos indisponíveis para novas contratações (internos ou negociados)</span>
        </label>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] items-stretch gap-3">
          {current ? <PlanFacts plan={current} title="Plano atual" /> : <p className="text-sm text-gray-500 dark:text-gray-400">Plano atual não informado.</p>}
          <div className="hidden md:flex items-center text-gray-400" aria-hidden="true"><ArrowRight size={20} /></div>
          {target
            ? <PlanFacts plan={target} title="Novo plano" />
            : (
              <div className="p-4 rounded-xl border border-dashed border-gray-300 dark:border-slate-600 text-sm text-gray-500 dark:text-gray-400 flex items-center justify-center text-center">
                Escolha o novo plano para comparar.
              </div>
            )}
        </div>

        {target && (
          <ul className="space-y-2 text-sm">
            <li className="flex items-start gap-2 text-gray-600 dark:text-gray-300">
              <Info size={16} className="shrink-0 mt-0.5 text-blue-600 dark:text-blue-400" aria-hidden="true" />
              <span>A mudança vale na hora, sem proporcionalidade: o período atual continua e o preço novo entra na próxima fatura.</span>
            </li>
            {subscription.status === 'TRIALING' && (
              <li className="flex items-start gap-2 text-gray-600 dark:text-gray-300">
                <Info size={16} className="shrink-0 mt-0.5 text-blue-600 dark:text-blue-400" aria-hidden="true" />
                <span>Em teste grátis: o teste continua até {formatDate(subscription.trial_ends_at)} e o novo plano vale no fim dele.</span>
              </li>
            )}
            {startsPeriod && (
              <li className="flex items-start gap-2 text-gray-600 dark:text-gray-300">
                <Receipt size={16} className="shrink-0 mt-0.5 text-blue-600 dark:text-blue-400" aria-hidden="true" />
                <span>A assinatura não tem período pago (plano gratuito): começa um período agora, com uma fatura de {formatCurrency(target.price)} vencendo hoje.</span>
              </li>
            )}
            {target.status !== 'ACTIVE' && (
              <li className="flex items-start gap-2 text-amber-800 dark:text-amber-300">
                <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
                <span>Plano indisponível para novas contratações: a mudança será feita como plano interno ou negociado.</span>
              </li>
            )}
            {violations.length > 0 && (
              <li role="alert" className="flex items-start gap-2 px-3 py-2 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300">
                <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
                <span>
                  O uso atual não cabe no novo plano ({violations.join('; ')}). A API recusa o downgrade até a loja reduzir o uso.
                </span>
              </li>
            )}
          </ul>
        )}

        <ReasonField
          label="Motivo (opcional)"
          value={reason}
          onChange={setReason}
          maxLength={BILLING_REASON_MAX_LENGTH}
          placeholder="Ex.: upgrade pedido pelo responsável no chamado 1234."
          hint="Fica no histórico da assinatura e na auditoria."
          showError={showErrors}
        />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Cancelar
// ---------------------------------------------------------------------------

/** POST /platform/subscriptions/:id/cancel: no fim do período (a loja usa até lá) ou agora. */
export function CancelSubscriptionDialog({ open, subscription, onClose, onDone, canScheduleAtPeriodEnd }: DialogProps & { canScheduleAtPeriodEnd: boolean }) {
  if (!open) return null;
  return <CancelForm subscription={subscription} onClose={onClose} onDone={onDone} canScheduleAtPeriodEnd={canScheduleAtPeriodEnd} />;
}

function CancelForm({ subscription, onClose, onDone, canScheduleAtPeriodEnd }: Omit<DialogProps, 'open'> & { canScheduleAtPeriodEnd: boolean }) {
  const groupId = useId();
  const [atPeriodEnd, setAtPeriodEnd] = useState(canScheduleAtPeriodEnd);
  const [reason, setReason] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  // Cancelamento imediato anula faturas futuras: a API exige o motivo (fica no histórico e na auditoria)
  const immediate = !atPeriodEnd;
  const reasonError = reasonProblem(reason, { required: immediate, maxLength: BILLING_REASON_MAX_LENGTH });
  const periodEnd = formatDate(subscription.current_period_end);

  async function handleConfirm() {
    if (reasonError) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      const detail = await platformSubscriptionsService.cancel(subscription.id, {
        at_period_end: atPeriodEnd,
        reason: reason.trim() || undefined,
      });
      toast.success(detail.status === 'CANCELED'
        ? 'Assinatura cancelada.'
        : `Cancelamento agendado para ${formatDate(detail.current_period_end)}.`);
      onDone(detail);
      onClose();
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Não foi possível cancelar a assinatura.'), { duration: 6000 });
    } finally {
      setSaving(false);
    }
  }

  const message = atPeriodEnd
    ? `A assinatura de ${storeName(subscription)} continua valendo até ${periodEnd}. Depois disso vira Cancelada e a loja deixa de vender (o painel continua disponível para consulta).`
    : `A assinatura de ${storeName(subscription)} é cancelada agora: a loja deixa de vender imediatamente e faturas em aberto de períodos futuros são anuladas. Cancelada é final: uma nova contratação cria outra assinatura.`;

  return (
    <ConfirmModal
      isOpen
      onClose={onClose}
      onConfirm={handleConfirm}
      closeOnConfirm={false}
      loading={saving}
      title="Cancelar a assinatura?"
      message={message}
      confirmLabel={atPeriodEnd ? 'Agendar cancelamento' : 'Cancelar agora'}
      cancelLabel="Manter assinatura"
      isDestructive
    >
      <fieldset className="space-y-2">
        <legend id={groupId} className="text-xs font-bold uppercase tracking-wide text-gray-700 dark:text-gray-300 mb-1">Quando</legend>
        <label className={cx('flex items-start gap-2 p-3 rounded-xl border text-sm', canScheduleAtPeriodEnd ? 'border-gray-200 dark:border-slate-700' : 'border-gray-100 dark:border-slate-800 opacity-60')}>
          <input
            type="radio"
            name={groupId}
            checked={atPeriodEnd}
            disabled={!canScheduleAtPeriodEnd}
            onChange={() => setAtPeriodEnd(true)}
            className="mt-0.5 accent-orange-600"
          />
          <span>
            <span className="font-bold text-gray-800 dark:text-white">No fim do período pago</span>
            <span className="block text-xs text-gray-500 dark:text-gray-400">
              {canScheduleAtPeriodEnd
                ? `Em ${periodEnd}; a loja usa até lá.`
                : subscription.cancel_at_period_end
                  ? `Já agendado para ${periodEnd}.`
                  : 'Indisponível: a assinatura não tem período pago a vencer.'}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 p-3 rounded-xl border border-gray-200 dark:border-slate-700 text-sm">
          <input type="radio" name={groupId} checked={!atPeriodEnd} onChange={() => setAtPeriodEnd(false)} className="mt-0.5 accent-orange-600" />
          <span>
            <span className="font-bold text-gray-800 dark:text-white">Agora</span>
            <span className="block text-xs text-gray-500 dark:text-gray-400">A loja deixa de vender imediatamente.</span>
          </span>
        </label>
      </fieldset>
      <ReasonField
        label={immediate ? 'Motivo' : 'Motivo (opcional)'}
        required={immediate}
        value={reason}
        onChange={setReason}
        maxLength={BILLING_REASON_MAX_LENGTH}
        hint={immediate
          ? 'Obrigatório no cancelamento imediato. Fica no histórico da assinatura e na auditoria.'
          : 'Fica no histórico da assinatura e na auditoria.'}
        showError={showErrors}
        rows={2}
      />
    </ConfirmModal>
  );
}

// ---------------------------------------------------------------------------
// Desfazer o cancelamento agendado
// ---------------------------------------------------------------------------

interface ResumeDialogProps extends DialogProps {
  /** A API recusou com 409 (nada agendado, assinatura cancelada ou período encerrado): a tela relê a assinatura. */
  onStale: () => void;
}

/**
 * POST /platform/subscriptions/:id/resume: desfaz o cancelamento agendado enquanto o período pago não terminou;
 * a assinatura volta a renovar no fim do período. Com 409 a mensagem da API é exibida e o detalhe é relido.
 */
export function ResumeSubscriptionDialog({ open, subscription, onClose, onDone, onStale }: ResumeDialogProps) {
  if (!open) return null;
  return <ResumeForm subscription={subscription} onClose={onClose} onDone={onDone} onStale={onStale} />;
}

function ResumeForm({ subscription, onClose, onDone, onStale }: Omit<ResumeDialogProps, 'open'>) {
  const [saving, setSaving] = useState(false);
  const periodEnd = subscription.current_period_end ? formatDate(subscription.current_period_end) : null;
  const paidPlan = (subscription.plan?.price ?? 0) > 0;
  // O agendamento interrompe a cobrança automática no provedor; desfazer não a religa sozinho
  const providerStopped = subscription.billing_provider === 'MERCADO_PAGO' && subscription.provider_status === 'cancelled';

  async function handleConfirm() {
    setSaving(true);
    try {
      const detail = await platformSubscriptionsService.resume(subscription.id);
      toast.success('Cancelamento desfeito: a assinatura continua.');
      onDone(detail);
      onClose();
    } catch (error) {
      // 409: não há cancelamento agendado, a assinatura foi cancelada ou o período terminou (a API explica)
      toast.error(getApiErrorMessage(error, 'Não foi possível desfazer o cancelamento.'), { duration: 8000 });
      if (getApiErrorStatus(error) === 409) {
        onStale();
        onClose();
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <ConfirmModal
      isOpen
      onClose={onClose}
      onConfirm={handleConfirm}
      closeOnConfirm={false}
      loading={saving}
      title="Desfazer o cancelamento?"
      message={`A assinatura de ${storeName(subscription)} não será mais cancelada${periodEnd ? ` em ${periodEnd}` : ' no fim do período'}: ela segue as regras normais de renovação${paidPlan ? ' (o plano é pago: a renovação gera a fatura do próximo período)' : ''}. A situação atual dela não muda.`}
      confirmLabel="Desfazer cancelamento"
      cancelLabel="Manter o agendamento"
    >
      {providerStopped && (
        <p className="flex items-start gap-2 px-3 py-2 rounded-xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            A cobrança automática no Mercado Pago foi interrompida quando o cancelamento foi agendado. Depois de desfazer, a loja
            precisa autorizá-la de novo no painel dela (Plano e assinatura).
          </span>
        </p>
      )}
    </ConfirmModal>
  );
}

// ---------------------------------------------------------------------------
// Suspender
// ---------------------------------------------------------------------------

/** POST /platform/subscriptions/:id/suspend (motivo obrigatório): a loja deixa de vender. */
export function SuspendSubscriptionDialog({ open, subscription, onClose, onDone }: DialogProps) {
  if (!open) return null;
  return <SuspendForm subscription={subscription} onClose={onClose} onDone={onDone} />;
}

function SuspendForm({ subscription, onClose, onDone }: Omit<DialogProps, 'open'>) {
  const [reason, setReason] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const reasonError = reasonProblem(reason, { required: true, maxLength: BILLING_REASON_MAX_LENGTH });

  async function handleConfirm() {
    if (reasonError) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      const detail = await platformSubscriptionsService.suspend(subscription.id, reason.trim());
      toast.success('Assinatura suspensa.');
      onDone(detail);
      onClose();
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Não foi possível suspender a assinatura.'), { duration: 6000 });
    } finally {
      setSaving(false);
    }
  }

  return (
    <ConfirmModal
      isOpen
      onClose={onClose}
      onConfirm={handleConfirm}
      closeOnConfirm={false}
      loading={saving}
      title="Suspender a assinatura?"
      message={`${storeName(subscription)} deixa de aceitar pedidos novos; a equipe continua consultando o painel e concluindo os pedidos em andamento. A assinatura suspensa não renova. Para voltar, reative a assinatura ou registre o pagamento das faturas.`}
      confirmLabel="Suspender assinatura"
      isDestructive
    >
      <ReasonField
        label="Motivo"
        required
        value={reason}
        onChange={setReason}
        maxLength={BILLING_REASON_MAX_LENGTH}
        placeholder="Ex.: inadimplência negociada sem acordo."
        hint="Fica no histórico da assinatura e na auditoria."
        showError={showErrors}
      />
    </ConfirmModal>
  );
}

// ---------------------------------------------------------------------------
// Reativar
// ---------------------------------------------------------------------------

interface ReactivateDialogProps extends DialogProps {
  now: number;
}

/**
 * POST /platform/subscriptions/:id/reactivate (SUSPENDED/PAST_DUE → ACTIVE). Com fatura vencida em aberto, a API
 * só reativa forçando (motivo obrigatório): as faturas continuam devidas, com novo vencimento agora.
 */
export function ReactivateSubscriptionDialog({ open, subscription, onClose, onDone, now }: ReactivateDialogProps) {
  if (!open) return null;
  return <ReactivateForm subscription={subscription} onClose={onClose} onDone={onDone} now={now} />;
}

function ReactivateForm({ subscription, onClose, onDone, now }: Omit<ReactivateDialogProps, 'open'>) {
  const overdue = subscription.invoices.filter((invoice) => isInvoiceOverdue(invoice, now));
  const [force, setForce] = useState(false);
  const [reason, setReason] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [apiOverdue, setApiOverdue] = useState<string | null>(null);
  const reasonError = reasonProblem(reason, { required: force, maxLength: BILLING_REASON_MAX_LENGTH });
  const periodEnded = subscription.status === 'SUSPENDED' && (timeOf(subscription.current_period_end) ?? Infinity) <= now;

  async function handleConfirm() {
    if (reasonError) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      const detail = await platformSubscriptionsService.reactivate(subscription.id, {
        force: force || undefined,
        reason: reason.trim() || undefined,
      });
      toast.success(force ? 'Assinatura reativada (faturas vencidas com novo vencimento).' : 'Assinatura reativada.');
      onDone(detail);
      onClose();
    } catch (error) {
      const ids = overdueInvoicesOf(error);
      if (ids) {
        // A API encontrou faturas vencidas: oferece forçar, com motivo
        setApiOverdue(`${getApiErrorMessage(error, 'Há faturas vencidas em aberto.')} Faturas: ${ids.map((id) => `#${id}`).join(', ')}.`);
        setForce(true);
        setShowErrors(true);
      } else {
        toast.error(getApiErrorMessage(error, 'Não foi possível reativar a assinatura.'), { duration: 6000 });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <ConfirmModal
      isOpen
      onClose={onClose}
      onConfirm={handleConfirm}
      closeOnConfirm={false}
      loading={saving}
      title="Reativar a assinatura?"
      message={`A assinatura de ${storeName(subscription)} volta a Ativa e a loja volta a vender.${periodEnded ? ' Como o período já terminou, começa um período novo (com fatura, se o plano for pago).' : ''}`}
      confirmLabel={force ? 'Forçar reativação' : 'Reativar assinatura'}
    >
      {(overdue.length > 0 || apiOverdue) && (
        <p role="alert" className="flex items-start gap-2 px-3 py-2 rounded-xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            {apiOverdue ?? `Há ${overdue.length} fatura${overdue.length === 1 ? '' : 's'} vencida${overdue.length === 1 ? '' : 's'} em aberto (${overdue.map((invoice) => `#${invoice.id}`).join(', ')}). Sem forçar, a API recusa: registre o pagamento ou force com um motivo.`}
          </span>
        </p>
      )}
      <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
        <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} className="mt-0.5 w-4 h-4 accent-orange-600" />
        <span>
          <span className="font-bold">Forçar mesmo com faturas vencidas</span>
          <span className="block text-xs text-gray-500 dark:text-gray-400">As faturas continuam devidas, com novo vencimento agora (a tolerância volta a contar).</span>
        </span>
      </label>
      <ReasonField
        label={force ? 'Motivo' : 'Motivo (opcional)'}
        required={force}
        value={reason}
        onChange={setReason}
        maxLength={BILLING_REASON_MAX_LENGTH}
        hint="Fica no histórico da assinatura e na auditoria."
        showError={showErrors}
        rows={2}
      />
    </ConfirmModal>
  );
}

// ---------------------------------------------------------------------------
// Fatura avulsa
// ---------------------------------------------------------------------------

interface CreateInvoiceDialogProps {
  open: boolean;
  subscription: PlatformSubscriptionDetail;
  onClose: () => void;
  onCreated: (invoice: PlatformInvoice) => void;
}

/** POST /platform/subscriptions/:id/invoices: valor, período e vencimento opcionais (padrões da API). */
export function CreateInvoiceDialog({ open, subscription, onClose, onCreated }: CreateInvoiceDialogProps) {
  if (!open) return null;
  return <CreateInvoiceForm subscription={subscription} onClose={onClose} onCreated={onCreated} />;
}

function CreateInvoiceForm({ subscription, onClose, onCreated }: Omit<CreateInvoiceDialogProps, 'open'>) {
  const formId = useId();
  const planPrice = subscription.plan?.price ?? 0;
  const [amount, setAmount] = useState('');
  const [customPeriod, setCustomPeriod] = useState(false);
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);

  const parsedAmount = parseMoneyInput(amount);
  const amountError = parsedAmount === null
    ? (planPrice > 0 ? null : 'O plano é gratuito: informe o valor da fatura.')
    : Number.isNaN(parsedAmount) ? 'Informe um valor válido (ex.: 99,90).'
      : parsedAmount < 0.01 ? 'O valor deve ser maior que zero.'
        : parsedAmount > MAX_INVOICE_AMOUNT ? 'Valor acima do limite permitido.' : null;
  const startIso = customPeriod ? dateInputToIso(periodStart) : null;
  const endIso = customPeriod ? dateInputToIso(periodEnd) : null;
  const periodError = !customPeriod ? null
    : !startIso || !endIso ? 'Informe o início e o fim do período.'
      : new Date(endIso).getTime() <= new Date(startIso).getTime() ? 'O fim do período deve ser depois do início.' : null;
  const notesError = reasonProblem(notes, { maxLength: BILLING_REASON_MAX_LENGTH });

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (amountError || periodError || notesError) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      // Vencimento informado vale até o fim do dia (horário local)
      const due = dueDate ? dateInputToIso(dueDate, 'end') : null;
      const invoice = await platformSubscriptionsService.createInvoice(subscription.id, {
        amount: parsedAmount ?? undefined,
        period_start: startIso ?? undefined,
        period_end: endIso ?? undefined,
        due_at: due ?? undefined,
        notes: notes.trim() || undefined,
      });
      toast.success(`Fatura #${invoice.id} gerada: ${formatCurrency(invoice.amount)}, vencimento ${formatDate(invoice.due_at)}.`);
      onCreated(invoice);
      onClose();
    } catch (error) {
      // 409: já existe fatura para o período ou assinatura cancelada; 400: plano gratuito sem valor/período inválido
      toast.error(getApiErrorMessage(error, 'Não foi possível gerar a fatura.'), { duration: 6000 });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Gerar fatura avulsa"
      description={`${storeName(subscription)} · ${subscription.plan ? `${subscription.plan.name} (${planPriceLabel(planPrice, subscription.plan.billing_interval)})` : 'plano não informado'}`}
      dismissible={!saving}
      footer={(
        <>
          <button type="button" onClick={onClose} disabled={saving} className={buttonClass('secondary')}>Cancelar</button>
          <button type="submit" form={formId} disabled={saving} className={buttonClass('primary')}>
            {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Receipt size={16} aria-hidden="true" />}
            Gerar fatura
          </button>
        </>
      )}
    >
      <form id={formId} onSubmit={handleSubmit} noValidate className="space-y-4">
        <p className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
          <Info size={16} className="shrink-0 mt-0.5 text-blue-600 dark:text-blue-400" aria-hidden="true" />
          <span>
            Campos vazios usam o padrão da API: valor = preço do plano; período = o atual (se ainda não tiver fatura) ou o seguinte
            (no teste grátis, o primeiro depois do teste); vencimento = início do período (ou agora, se já começou).
            Uma fatura válida por período.
          </span>
        </p>
        <FormField
          label="Valor (R$)"
          required={!(planPrice > 0)}
          error={showErrors ? amountError ?? undefined : undefined}
          hint={planPrice > 0 ? `Vazio = ${formatCurrency(planPrice)} (preço do plano).` : undefined}
        >
          {(field) => (
            <input
              {...field}
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder={planPrice > 0 ? moneyToInput(planPrice) : '0,00'}
              autoComplete="off"
              className={fieldControlClass(showErrors && !!amountError)}
            />
          )}
        </FormField>

        <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
          <input type="checkbox" checked={customPeriod} onChange={(event) => setCustomPeriod(event.target.checked)} className="mt-0.5 w-4 h-4 accent-orange-600" />
          <span>Informar o período manualmente</span>
        </label>
        {customPeriod && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Início do período" required error={showErrors ? periodError ?? undefined : undefined}>
              {(field) => (
                <input {...field} type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} className={fieldControlClass(showErrors && !!periodError)} />
              )}
            </FormField>
            <FormField label="Fim do período" required hint="O período termina no início deste dia.">
              {(field) => (
                <input {...field} type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} className={fieldControlClass(showErrors && !!periodError)} />
              )}
            </FormField>
          </div>
        )}

        <FormField label="Vencimento (opcional)" hint="Vale até o fim do dia escolhido.">
          {(field) => (
            <input {...field} type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} className={fieldControlClass()} />
          )}
        </FormField>

        <ReasonField
          label="Observações (opcional)"
          value={notes}
          onChange={setNotes}
          maxLength={BILLING_REASON_MAX_LENGTH}
          hint="Internas: não aparecem para a loja."
          showError={showErrors}
          rows={2}
        />
      </form>
    </Modal>
  );
}
