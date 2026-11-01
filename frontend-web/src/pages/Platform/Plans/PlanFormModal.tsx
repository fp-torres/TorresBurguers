import { useId, useState, type FormEvent } from 'react';
import { Info, Loader2, Save } from 'lucide-react';
import toast from 'react-hot-toast';
import { FormField, Modal, buttonClass, cx, fieldControlClass } from '../../../components/ui';
import ConfirmModal from '../../../components/ConfirmModal';
import { getApiErrorMessage } from '../../../services/api';
import { PLAN_RULES, platformPlansService, type PlanPayload } from '../../../services/platform/plansService';
import type { PlatformPlan } from '../../../services/platform/billingParsers';
import { PLAN_FEATURE_KEYS, PLAN_FEATURE_LABELS } from '../../../services/storeAccess';
import { formatCurrency } from '../../../utils/format';
import { parseMoneyInput } from '../Subscriptions/formRules';
import {
  PLAN_FORM_LIMIT_KEYS, PLAN_FORM_LIMIT_LABELS, buildPlanPayload, emptyPlanForm, impactfulChanges, planChanges, planToForm,
  type PlanFormErrors, type PlanFormValues,
} from './planForm';

interface PlanFormModalProps {
  open: boolean;
  /** Plano em edição (null = novo plano). */
  plan: PlatformPlan | null;
  onClose: () => void;
  onSaved: (plan: PlatformPlan) => void;
}

/** Criar (POST /platform/plans) ou editar (PATCH /platform/plans/:id, só o que mudou) um plano. */
export default function PlanFormModal({ open, plan, onClose, onSaved }: PlanFormModalProps) {
  if (!open) return null;
  return <PlanForm key={plan?.id ?? 'new'} plan={plan} onClose={onClose} onSaved={onSaved} />;
}

const CHECKBOX_CLASS = 'mt-0.5 w-4 h-4 accent-orange-600 shrink-0';

function PlanForm({ plan, onClose, onSaved }: Omit<PlanFormModalProps, 'open'>) {
  const formId = useId();
  const [values, setValues] = useState<PlanFormValues>(() => (plan ? planToForm(plan) : emptyPlanForm()));
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<{ changes: Partial<PlanPayload>; notes: string[] } | null>(null);

  const { errors } = buildPlanPayload(values);
  const visibleErrors: PlanFormErrors = showErrors ? errors : {};
  const price = parseMoneyInput(values.price);

  function update<K extends keyof PlanFormValues>(key: K, value: PlanFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function save(body: PlanPayload | Partial<PlanPayload>) {
    setSaving(true);
    try {
      const saved = plan
        ? await platformPlansService.update(plan.id, body)
        : await platformPlansService.create(body as PlanPayload);
      toast.success(plan ? `Plano ${saved.name} atualizado.` : `Plano ${saved.name} criado.`);
      onSaved(saved);
      onClose();
    } catch (error) {
      // 409: código já usado por outro plano; 400: a API explica o campo
      toast.error(getApiErrorMessage(error, 'Não foi possível salvar o plano.'), { duration: 6000 });
      setPending(null);
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const result = buildPlanPayload(values);
    if (!result.payload) {
      setShowErrors(true);
      return;
    }
    if (!plan) {
      void save(result.payload);
      return;
    }
    const changes = planChanges(plan, result.payload);
    if (Object.keys(changes).length === 0) {
      toast('Nada mudou no plano.', { icon: 'ℹ️' });
      onClose();
      return;
    }
    // Mudança que afeta quem já assina: confirmação com o impacto antes de salvar
    const notes = impactfulChanges(changes);
    if (notes.length > 0 && ((plan.active_subscriptions ?? 0) > 0 || changes.status === 'INACTIVE')) {
      setPending({ changes, notes });
      return;
    }
    void save(changes);
  }

  return (
    <>
      <Modal
        open
        onClose={onClose}
        size="lg"
        title={plan ? `Editar plano ${plan.name}` : 'Novo plano'}
        description={plan
          ? `${plan.active_subscriptions ?? 0} assinatura(s) ativa(s) neste plano. Planos não são excluídos: para tirar de venda, deixe-o indisponível.`
          : 'Preço, periodicidade, teste grátis, limites e recursos. Nenhum preço é fixo no código: tudo vem daqui.'}
        dismissible={!saving}
        footer={(
          <>
            <button type="button" onClick={onClose} disabled={saving} className={buttonClass('secondary')}>Cancelar</button>
            <button type="submit" form={formId} disabled={saving} className={buttonClass('primary')}>
              {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
              {plan ? 'Salvar alterações' : 'Criar plano'}
            </button>
          </>
        )}
      >
        <form id={formId} onSubmit={handleSubmit} noValidate className="space-y-6">
          <fieldset className="space-y-4">
            <legend className="text-sm font-bold text-gray-800 dark:text-white mb-1">Identificação</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField label="Nome" required error={visibleErrors.name}>
                {(field) => (
                  <input
                    {...field}
                    value={values.name}
                    onChange={(event) => update('name', event.target.value)}
                    maxLength={PLAN_RULES.nameMaxLength}
                    placeholder="Ex.: Essencial"
                    className={fieldControlClass(!!visibleErrors.name)}
                  />
                )}
              </FormField>
              <FormField label="Código" required error={visibleErrors.code} hint="Identificador estável: minúsculas, números e hífens.">
                {(field) => (
                  <input
                    {...field}
                    value={values.code}
                    onChange={(event) => update('code', event.target.value.toLowerCase())}
                    maxLength={PLAN_RULES.codeMaxLength}
                    placeholder="essencial"
                    autoComplete="off"
                    spellCheck={false}
                    className={fieldControlClass(!!visibleErrors.code, 'font-mono')}
                  />
                )}
              </FormField>
            </div>
            <FormField
              label="Descrição (opcional)"
              error={visibleErrors.description}
              hint={`${values.description.length}/${PLAN_RULES.descriptionMaxLength} · aparece na página pública de planos.`}
            >
              {(field) => (
                <textarea
                  {...field}
                  rows={2}
                  value={values.description}
                  onChange={(event) => update('description', event.target.value)}
                  maxLength={PLAN_RULES.descriptionMaxLength}
                  placeholder="Para quem está começando: cardápio, pedidos e entregas."
                  className={fieldControlClass(!!visibleErrors.description, 'resize-y')}
                />
              )}
            </FormField>
          </fieldset>

          <fieldset className="space-y-4">
            <legend className="text-sm font-bold text-gray-800 dark:text-white mb-1">Cobrança</legend>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <FormField
                label="Preço (R$)"
                required
                error={visibleErrors.price}
                hint={price === 0 ? 'Plano gratuito: não gera faturas.' : price && price > 0 && values.billing_interval === 'YEARLY' ? `Equivale a ${formatCurrency(price / 12)}/mês.` : '0 = gratuito.'}
              >
                {(field) => (
                  <input
                    {...field}
                    inputMode="decimal"
                    value={values.price}
                    onChange={(event) => update('price', event.target.value)}
                    placeholder="99,90"
                    autoComplete="off"
                    className={fieldControlClass(!!visibleErrors.price)}
                  />
                )}
              </FormField>
              <FormField label="Periodicidade">
                {(field) => (
                  <select
                    {...field}
                    value={values.billing_interval}
                    onChange={(event) => update('billing_interval', event.target.value === 'YEARLY' ? 'YEARLY' : 'MONTHLY')}
                    className={fieldControlClass()}
                  >
                    <option value="MONTHLY">Mensal</option>
                    <option value="YEARLY">Anual</option>
                  </select>
                )}
              </FormField>
              <FormField label="Teste grátis (dias)" error={visibleErrors.trial_days} hint={`0 a ${PLAN_RULES.maxTrialDays}. Vale para novas assinaturas.`}>
                {(field) => (
                  <input
                    {...field}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={PLAN_RULES.maxTrialDays}
                    value={values.trial_days}
                    onChange={(event) => update('trial_days', event.target.value)}
                    className={fieldControlClass(!!visibleErrors.trial_days)}
                  />
                )}
              </FormField>
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-bold text-gray-800 dark:text-white mb-1">Limites</legend>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Equipe ativa, produtos fora da lixeira, pedidos por mês (calendário da loja) e armazenamento das imagens da loja em MB
              (produtos, adicionais e logo; fotos de perfil não contam). Acima do armazenamento, a loja não envia novas imagens.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {PLAN_FORM_LIMIT_KEYS.map((key) => {
                const input = values.limits[key];
                return (
                  <div key={key} className="space-y-2">
                    <FormField label={PLAN_FORM_LIMIT_LABELS[key]} error={visibleErrors[key]}>
                      {(field) => (
                        <input
                          {...field}
                          type="number"
                          inputMode="numeric"
                          min={1}
                          value={input.unlimited ? '' : input.value}
                          placeholder={input.unlimited ? 'Ilimitado' : key === 'storage_mb' ? 'Ex.: 500' : 'Ex.: 10'}
                          onChange={(event) => update('limits', { ...values.limits, [key]: { unlimited: false, value: event.target.value } })}
                          className={fieldControlClass(!!visibleErrors[key])}
                        />
                      )}
                    </FormField>
                    <label className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
                      <input
                        type="checkbox"
                        checked={input.unlimited}
                        onChange={(event) => update('limits', { ...values.limits, [key]: { unlimited: event.target.checked, value: input.value } })}
                        className={CHECKBOX_CLASS}
                      />
                      Ilimitado
                    </label>
                  </div>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-bold text-gray-800 dark:text-white mb-1">Recursos</legend>
            {PLAN_FEATURE_KEYS.map((key) => (
              <label key={key} className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
                <input
                  type="checkbox"
                  checked={values.features[key]}
                  onChange={(event) => update('features', { ...values.features, [key]: event.target.checked })}
                  className={CHECKBOX_CLASS}
                />
                {PLAN_FEATURE_LABELS[key]}
              </label>
            ))}
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-bold text-gray-800 dark:text-white mb-1">Disponibilidade e exibição</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField label="Disponibilidade" hint="Indisponível: sai de venda; quem já assina continua no plano.">
                {(field) => (
                  <select
                    {...field}
                    value={values.status}
                    onChange={(event) => update('status', event.target.value === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE')}
                    className={fieldControlClass()}
                  >
                    <option value="ACTIVE">Disponível para novas contratações</option>
                    <option value="INACTIVE">Indisponível (interno ou descontinuado)</option>
                  </select>
                )}
              </FormField>
              <FormField label="Ordem de exibição" error={visibleErrors.sort_order} hint="Menor aparece primeiro.">
                {(field) => (
                  <input
                    {...field}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={PLAN_RULES.maxSortOrder}
                    value={values.sort_order}
                    onChange={(event) => update('sort_order', event.target.value)}
                    className={fieldControlClass(!!visibleErrors.sort_order)}
                  />
                )}
              </FormField>
            </div>
            <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200">
              <input type="checkbox" checked={values.is_public} onChange={(event) => update('is_public', event.target.checked)} className={CHECKBOX_CLASS} />
              <span>
                Público
                <span className="block text-xs text-gray-500 dark:text-gray-400">Aparece na página pública de planos e no cadastro de lojas (quando disponível).</span>
              </span>
            </label>
          </fieldset>

          {plan && (
            <p className={cx('flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400')}>
              <Info size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
              <span>Assinaturas existentes continuam no plano: preço novo vale a partir da próxima fatura; limites e recursos, na hora.</span>
            </p>
          )}
        </form>
      </Modal>

      <ConfirmModal
        isOpen={!!pending}
        onClose={() => setPending(null)}
        onConfirm={() => pending && void save(pending.changes)}
        closeOnConfirm={false}
        loading={saving}
        title="Alterar um plano em uso?"
        message={`${plan?.active_subscriptions ?? 0} assinatura(s) ativa(s) usam ${plan?.name ?? 'este plano'}.`}
        confirmLabel="Salvar alterações"
        isDestructive={pending?.changes.status === 'INACTIVE'}
      >
        <ul className="list-disc pl-5 space-y-1 text-sm text-gray-600 dark:text-gray-300">
          {pending?.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      </ConfirmModal>
    </>
  );
}
