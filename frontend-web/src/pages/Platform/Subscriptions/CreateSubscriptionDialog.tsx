import { useId, useState, type FormEvent } from 'react';
import { CreditCard, Info, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { FormField, Modal, buttonClass } from '../../../components/ui';
import { getApiErrorMessage } from '../../../services/api';
import { BILLING_REASON_MAX_LENGTH, platformSubscriptionsService } from '../../../services/platform/subscriptionsService';
import type { PlatformSubscriptionDetail } from '../../../services/platform/billingParsers';
import { formatCurrency } from '../../../utils/format';
import PlanSelect, { PlanFacts } from '../Plans/PlanSelect';
import { usePlanOptions } from '../Plans/usePlanOptions';
import ReasonField from './ReasonField';
import { reasonProblem } from './formRules';

interface CreateSubscriptionDialogProps {
  open: boolean;
  storeId: number;
  storeName: string;
  onClose: () => void;
  onCreated: (detail: PlatformSubscriptionDetail) => void;
}

/**
 * POST /platform/stores/:id/subscription: contrata um plano para uma loja sem assinatura vigente (409 se já houver).
 * Teste grátis → Em teste; plano gratuito → Ativa sem vencimento; plano pago → Ativa com fatura do primeiro período.
 */
export default function CreateSubscriptionDialog({ open, storeId, storeName, onClose, onCreated }: CreateSubscriptionDialogProps) {
  if (!open) return null;
  return <CreateSubscriptionForm storeId={storeId} storeName={storeName} onClose={onClose} onCreated={onCreated} />;
}

function CreateSubscriptionForm({ storeId, storeName, onClose, onCreated }: Omit<CreateSubscriptionDialogProps, 'open'>) {
  const formId = useId();
  const planOptions = usePlanOptions();
  const [planId, setPlanId] = useState<number | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [reason, setReason] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);

  const plan = planOptions.plans.find((item) => item.id === planId) ?? null;
  const planError = plan ? null : 'Escolha o plano.';
  const reasonError = reasonProblem(reason, { maxLength: BILLING_REASON_MAX_LENGTH });

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!plan || reasonError) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      const detail = await platformSubscriptionsService.createForStore(storeId, {
        plan_id: plan.id,
        allow_inactive_plan: plan.status !== 'ACTIVE' ? true : undefined,
        reason: reason.trim() || undefined,
      });
      toast.success(`Assinatura do plano ${plan.name} criada.`);
      onCreated(detail);
      onClose();
    } catch (error) {
      // 409: a loja já tem assinatura vigente; 400: plano indisponível
      toast.error(getApiErrorMessage(error, 'Não foi possível criar a assinatura.'), { duration: 6000 });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Contratar plano"
      description={storeName}
      dismissible={!saving}
      footer={(
        <>
          <button type="button" onClick={onClose} disabled={saving} className={buttonClass('secondary')}>Cancelar</button>
          <button type="submit" form={formId} disabled={saving || planOptions.loading} className={buttonClass('primary')}>
            {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <CreditCard size={16} aria-hidden="true" />}
            {plan ? `Contratar ${plan.name}` : 'Contratar plano'}
          </button>
        </>
      )}
    >
      <form id={formId} onSubmit={handleSubmit} noValidate className="space-y-5">
        {planOptions.error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{planOptions.error}</p>}
        <FormField label="Plano" required error={showErrors ? planError ?? undefined : undefined} hint={planOptions.loading ? 'Carregando planos...' : undefined}>
          {(field) => (
            <PlanSelect
              field={field}
              plans={planOptions.plans}
              value={planId}
              onChange={setPlanId}
              includeInactive={showInactive}
              invalid={showErrors && !!planError}
              disabled={planOptions.loading}
            />
          )}
        </FormField>
        <label className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
          <input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} className="mt-0.5 w-4 h-4 accent-orange-600" />
          <span>Mostrar planos indisponíveis para novas contratações (internos ou negociados)</span>
        </label>
        {plan && (
          <>
            <PlanFacts plan={plan} title="Plano escolhido" />
            <p className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
              <Info size={16} className="shrink-0 mt-0.5 text-blue-600 dark:text-blue-400" aria-hidden="true" />
              <span>
                {plan.trial_days > 0
                  ? `A assinatura começa em teste grátis por ${plan.trial_days} dia${plan.trial_days === 1 ? '' : 's'}; no fim do teste a rotina de cobrança ativa (plano gratuito) ou gera a primeira fatura.`
                  : plan.price > 0
                    ? `A assinatura começa Ativa, com o primeiro período e uma fatura de ${formatCurrency(plan.price)} vencendo agora.`
                    : 'Plano gratuito: a assinatura começa Ativa, sem vencimento e sem faturas.'}
              </span>
            </p>
          </>
        )}
        <ReasonField
          label="Motivo (opcional)"
          value={reason}
          onChange={setReason}
          maxLength={BILLING_REASON_MAX_LENGTH}
          hint="Fica no histórico da assinatura e na auditoria."
          showError={showErrors}
          rows={2}
        />
      </form>
    </Modal>
  );
}
