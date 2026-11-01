import { useId, useState, type FormEvent } from 'react';
import { CheckCircle2, Info, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { FormField, Modal, buttonClass, fieldControlClass } from '../../../components/ui';
import ConfirmModal from '../../../components/ConfirmModal';
import { getApiErrorMessage, getApiErrorStatus } from '../../../services/api';
import {
  BILLING_REASON_MAX_LENGTH, PAYMENT_METHOD_MAX_LENGTH, PROVIDER_PAYMENT_ID_MAX_LENGTH, PROVIDER_PAYMENT_ID_PATTERN,
  platformSubscriptionsService,
} from '../../../services/platform/subscriptionsService';
import type { PlatformInvoice } from '../../../services/platform/billingParsers';
import { formatCurrency } from '../../../utils/format';
import ReasonField from './ReasonField';
import { MANUAL_PAYMENT_METHODS } from './billingDisplay';
import { formatDate } from '../../../utils/dates';
import { dateTimeInputToIso, reasonProblem, toDateTimeInput } from './formRules';
import { useNow } from '../../../hooks/useNow';

/** Fatura alvo de uma ação, com o nome da loja para os textos (quando conhecido). */
export interface InvoiceTarget {
  invoice: PlatformInvoice;
  storeName?: string | null;
}

function invoiceTitle({ invoice, storeName }: InvoiceTarget): string {
  const period = `${formatDate(invoice.period_start)} – ${formatDate(invoice.period_end)}`;
  return `Fatura #${invoice.id}${storeName ? ` de ${storeName}` : ''} · ${formatCurrency(invoice.amount)} · ${period}`;
}

// ---------------------------------------------------------------------------
// Registrar pagamento
// ---------------------------------------------------------------------------

interface MarkPaidDialogProps {
  target: InvoiceTarget | null;
  /** Instante atual (sugestão da data do pagamento). */
  now: number;
  onClose: () => void;
  onDone: (invoice: PlatformInvoice) => void;
}

/**
 * POST /platform/invoices/:id/mark-paid (idempotente). Quita a fatura; sem outra fatura vencida, a assinatura em
 * atraso ou suspensa volta a Ativa. O mesmo identificador de pagamento nunca quita duas faturas (409). A data do
 * pagamento vai até agora (o campo tem max e a tela recusa o futuro); se a API ainda recusar (400), a mensagem
 * dela aparece no campo.
 */
export function MarkInvoicePaidDialog({ target, now, onClose, onDone }: MarkPaidDialogProps) {
  if (!target) return null;
  return <MarkPaidForm key={target.invoice.id} target={target} now={now} onClose={onClose} onDone={onDone} />;
}

const OTHER_METHOD = '__other__';

/** O campo tem precisão de minutos: o minuto atual sempre vale, mesmo com o relógio da tela um pouco atrasado. */
const PAID_AT_INPUT_TOLERANCE_MS = 60_000;

function MarkPaidForm({ target, now, onClose, onDone }: Omit<MarkPaidDialogProps, 'target'> & { target: InvoiceTarget }) {
  const formId = useId();
  // Relógio próprio do diálogo (mais frequente): o máximo do campo acompanha "agora"
  const clock = useNow(15_000);
  const latest = Math.max(now, clock);
  const [paidAt, setPaidAt] = useState(() => toDateTimeInput(now));
  const [method, setMethod] = useState('PIX');
  const [otherMethod, setOtherMethod] = useState('');
  const [paymentId, setPaymentId] = useState('');
  const [notes, setNotes] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  // Recusa da API sobre a data (400: no futuro ou inválida), exibida no próprio campo até a data mudar
  const [apiPaidAtError, setApiPaidAtError] = useState<string | null>(null);

  const paidAtIso = dateTimeInputToIso(paidAt);
  const paidAtTime = paidAtIso ? new Date(paidAtIso).getTime() : null;
  const paidAtError = paidAt && !paidAtIso ? 'Informe uma data e hora válidas.'
    : paidAtTime !== null && paidAtTime > latest + PAID_AT_INPUT_TOLERANCE_MS ? 'A data do pagamento não pode estar no futuro.'
      : null;
  const methodText = method === OTHER_METHOD ? otherMethod.trim() : method;
  const methodError = method === OTHER_METHOD && !methodText ? 'Informe a forma de pagamento.'
    : methodText.length > PAYMENT_METHOD_MAX_LENGTH ? `Use no máximo ${PAYMENT_METHOD_MAX_LENGTH} caracteres.` : null;
  const paymentIdText = paymentId.trim();
  const paymentIdError = !paymentIdText ? null
    : paymentIdText.length > PROVIDER_PAYMENT_ID_MAX_LENGTH ? `Use no máximo ${PROVIDER_PAYMENT_ID_MAX_LENGTH} caracteres.`
      : PROVIDER_PAYMENT_ID_PATTERN.test(paymentIdText) ? null : 'Use letras, números, ponto, hífen, barra, dois-pontos ou sublinhado.';
  const notesError = reasonProblem(notes, { maxLength: BILLING_REASON_MAX_LENGTH });

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (paidAtError || methodError || paymentIdError || notesError) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      const invoice = await platformSubscriptionsService.markInvoicePaid(target.invoice.id, {
        paid_at: paidAtIso ?? undefined,
        payment_method: methodText || undefined,
        provider_payment_id: paymentIdText || undefined,
        notes: notes.trim() || undefined,
      });
      toast.success(`Pagamento da fatura #${invoice.id} registrado.`);
      onDone(invoice);
      onClose();
    } catch (error) {
      // 400: data no futuro (a API aceita poucos minutos de diferença de relógio) ou inválida — a mensagem da API vai
      // também para o campo; 409: fatura anulada, paga com outro pagamento ou identificador já usado em outra fatura
      const message = getApiErrorMessage(error, 'Não foi possível registrar o pagamento.');
      if (getApiErrorStatus(error) === 400 && /paid_at|data do pagamento/i.test(message)) {
        setApiPaidAtError(message);
        setShowErrors(true);
      }
      toast.error(message, { duration: 6000 });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Registrar pagamento"
      description={invoiceTitle(target)}
      dismissible={!saving}
      footer={(
        <>
          <button type="button" onClick={onClose} disabled={saving} className={buttonClass('secondary')}>Cancelar</button>
          <button type="submit" form={formId} disabled={saving} className={buttonClass('primary')}>
            {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
            Registrar pagamento
          </button>
        </>
      )}
    >
      <form id={formId} onSubmit={handleSubmit} noValidate className="space-y-4">
        <p className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
          <Info size={16} className="shrink-0 mt-0.5 text-blue-600 dark:text-blue-400" aria-hidden="true" />
          <span>
            Registre só pagamentos já recebidos: a fatura fica Paga (receita da plataforma). Sem outra fatura vencida, uma assinatura
            em atraso ou suspensa volta a Ativa. Fatura paga não pode ser anulada depois.
          </span>
        </p>
        <FormField
          label="Data do pagamento"
          error={showErrors ? paidAtError ?? apiPaidAtError ?? undefined : undefined}
          hint="Vazio = agora. Não pode estar no futuro."
        >
          {(field) => (
            <input
              {...field}
              type="datetime-local"
              value={paidAt}
              max={toDateTimeInput(latest)}
              onChange={(event) => {
                setPaidAt(event.target.value);
                setApiPaidAtError(null);
              }}
              className={fieldControlClass(showErrors && !!(paidAtError ?? apiPaidAtError))}
            />
          )}
        </FormField>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField label="Forma de pagamento" error={showErrors && method !== OTHER_METHOD ? methodError ?? undefined : undefined}>
            {(field) => (
              <select {...field} value={method} onChange={(event) => setMethod(event.target.value)} className={fieldControlClass()}>
                {MANUAL_PAYMENT_METHODS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                <option value={OTHER_METHOD}>Outra...</option>
              </select>
            )}
          </FormField>
          {method === OTHER_METHOD && (
            <FormField label="Qual?" required error={showErrors ? methodError ?? undefined : undefined}>
              {(field) => (
                <input
                  {...field}
                  value={otherMethod}
                  onChange={(event) => setOtherMethod(event.target.value)}
                  maxLength={PAYMENT_METHOD_MAX_LENGTH}
                  placeholder="Ex.: Depósito"
                  className={fieldControlClass(showErrors && !!methodError)}
                />
              )}
            </FormField>
          )}
        </div>
        <FormField
          label="Identificador do pagamento (opcional)"
          error={showErrors ? paymentIdError ?? undefined : undefined}
          hint="Comprovante ou id da transação (ex.: E2E do PIX). Único: o mesmo pagamento nunca quita duas faturas."
        >
          {(field) => (
            <input
              {...field}
              value={paymentId}
              onChange={(event) => setPaymentId(event.target.value)}
              maxLength={PROVIDER_PAYMENT_ID_MAX_LENGTH}
              autoComplete="off"
              spellCheck={false}
              className={fieldControlClass(showErrors && !!paymentIdError, 'font-mono')}
            />
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

// ---------------------------------------------------------------------------
// Pagamento recusado / anular
// ---------------------------------------------------------------------------

export type InvoiceReasonAction = 'fail' | 'void';

interface InvoiceReasonDialogProps {
  target: InvoiceTarget | null;
  action: InvoiceReasonAction;
  onClose: () => void;
  onDone: (invoice: PlatformInvoice) => void;
}

/**
 * POST /platform/invoices/:id/mark-failed (a fatura continua devida, +1 tentativa) ou /void (deixa de ser cobrada;
 * fatura paga não pode ser anulada). Motivo obrigatório (impacto financeiro: vai para o histórico e a auditoria).
 */
export function InvoiceReasonDialog({ target, action, onClose, onDone }: InvoiceReasonDialogProps) {
  if (!target) return null;
  return <InvoiceReasonForm key={`${action}-${target.invoice.id}`} target={target} action={action} onClose={onClose} onDone={onDone} />;
}

function InvoiceReasonForm({ target, action, onClose, onDone }: Omit<InvoiceReasonDialogProps, 'target'> & { target: InvoiceTarget }) {
  const [reason, setReason] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const reasonError = reasonProblem(reason, { required: true, maxLength: BILLING_REASON_MAX_LENGTH });
  const isVoid = action === 'void';

  async function handleConfirm() {
    if (reasonError) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      const invoice = isVoid
        ? await platformSubscriptionsService.voidInvoice(target.invoice.id, reason.trim())
        : await platformSubscriptionsService.markInvoiceFailed(target.invoice.id, reason.trim());
      toast.success(isVoid ? `Fatura #${invoice.id} anulada.` : `Pagamento da fatura #${invoice.id} marcado como recusado.`);
      onDone(invoice);
      onClose();
    } catch (error) {
      // 409: fatura já paga ou anulada (a API explica)
      toast.error(getApiErrorMessage(error, isVoid ? 'Não foi possível anular a fatura.' : 'Não foi possível registrar a falha.'), { duration: 6000 });
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
      title={isVoid ? 'Anular a fatura?' : 'Marcar pagamento como recusado?'}
      message={isVoid
        ? `${invoiceTitle(target)}. A fatura deixa de ser cobrada (Anulada) e isso não pode ser desfeito. Se era a única vencida de uma assinatura em atraso, ela volta a Ativa.`
        : `${invoiceTitle(target)}. A fatura continua devida (Falhou) e conta mais uma tentativa de cobrança.`}
      confirmLabel={isVoid ? 'Anular fatura' : 'Marcar como recusado'}
      isDestructive={isVoid}
    >
      <ReasonField
        label="Motivo"
        required
        value={reason}
        onChange={setReason}
        maxLength={BILLING_REASON_MAX_LENGTH}
        placeholder={isVoid ? 'Ex.: cobrança lançada em duplicidade.' : 'Ex.: PIX não identificado.'}
        hint="Fica no histórico da assinatura e na auditoria."
        showError={showErrors}
        rows={2}
      />
    </ConfirmModal>
  );
}
