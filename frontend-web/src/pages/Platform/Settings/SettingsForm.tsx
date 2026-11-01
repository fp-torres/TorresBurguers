import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ExternalLink, Headset, Loader2, Receipt, RotateCcw, Save, Store, UserPlus } from 'lucide-react';
import toast from 'react-hot-toast';
import { CARD_CLASS, FormField, StatusBadge, Switch, buttonClass, cx, fieldControlClass } from '../../../components/ui';
import ConfirmModal from '../../../components/ConfirmModal';
import { getApiErrorMessage } from '../../../services/api';
import type { PlanOption } from '../../../services/platform/insightsLookups';
import { platformSettingsService, type PlatformSettings } from '../../../services/platform/settingsService';
import { formatCurrency, formatDateTime } from '../../../utils/format';
import { STORE_ACCOUNT_STATUS, statusMeta } from '../../../utils/saasStatus';
import EntityPicker from '../Audit/EntityPicker';
import { searchStoreOptions } from '../Audit/pickerOptions';
import { changesFrom, draftFrom, isSignupPlan, summarizeChanges, validateDraft, type SettingsDraft } from './settingsDraft';

const BILLING_INTERVAL_LABELS: Record<string, string> = { MONTHLY: '/mês', YEARLY: '/ano' };

interface SettingsFormProps {
  settings: PlatformSettings;
  plans: PlanOption[] | null;
  plansLoading: boolean;
  plansError: string | null;
  onRetryPlans: () => void;
  /** Configurações salvas (resposta do PATCH) e os avisos da API. */
  onSaved: (settings: PlatformSettings, warnings: string[]) => void;
}

function SettingsCard({ title, description, icon, children }: { title: string; description: ReactNode; icon: ReactNode; children: ReactNode }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={cx(CARD_CLASS, 'overflow-visible')}>
      <div className="flex items-start gap-3 px-5 sm:px-6 py-4 border-b border-gray-100 dark:border-slate-700">
        <div className="shrink-0 p-2 rounded-xl bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400" aria-hidden="true">{icon}</div>
        <div className="min-w-0">
          <h2 id={titleId} className="text-lg font-bold text-gray-800 dark:text-white">{title}</h2>
          <div className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{description}</div>
        </div>
      </div>
      <div className="p-5 sm:p-6 space-y-5">{children}</div>
    </section>
  );
}

function planLabel(plan: PlanOption): string {
  const price = plan.price > 0 ? `${formatCurrency(plan.price)}${BILLING_INTERVAL_LABELS[plan.billing_interval] ?? ''}` : 'gratuito';
  const problems = [plan.status !== 'ACTIVE' ? 'indisponível' : null, !plan.is_public ? 'não público' : null].filter(Boolean);
  return `${plan.name} (${price})${problems.length ? ` — ${problems.join(', ')}` : ''}`;
}

/**
 * Formulário das configurações globais (PATCH /platform/settings com só o que mudou): loja padrão,
 * tolerância da inadimplência, duração das sessões de suporte e autoatendimento de lojas.
 * Salvar mostra o resumo das mudanças e pede confirmação (afeta todas as lojas e o app mobile).
 * Quem usa remonta o formulário (key) depois de salvar.
 */
export default function SettingsForm({ settings, plans, plansLoading, plansError, onRetryPlans, onSaved }: SettingsFormProps) {
  const [draft, setDraft] = useState<SettingsDraft>(() => draftFrom(settings));
  const [submitted, setSubmitted] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const errors = validateDraft(draft, settings, plans);
  const changes = changesFrom(draft, settings);
  const dirty = Object.keys(changes).length > 0;
  const summary = summarizeChanges(changes, settings, draft, plans);
  // Erros aparecem depois de tentar salvar ou quando o campo já foi alterado
  const graceError = submitted || draft.graceDays !== String(settings.grace_period_days) ? errors.graceDays : undefined;
  const minutesError = submitted || draft.supportMinutes !== String(settings.support_session_minutes) ? errors.supportMinutes : undefined;
  const planError = submitted || draft.signupEnabled !== settings.store_self_signup_enabled || draft.signupPlanId !== settings.self_signup_plan_id
    ? errors.signupPlanId
    : undefined;

  // Alterações não salvas: o navegador pergunta antes de fechar ou recarregar a página
  useEffect(() => {
    if (!dirty) return;
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dirty]);

  function update<K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length > 0) {
      toast.error('Confira os campos destacados antes de salvar.');
      return;
    }
    if (dirty) setConfirmOpen(true);
  }

  async function save() {
    setSaving(true);
    try {
      const result = await platformSettingsService.update(changes);
      toast.success('Configurações da plataforma salvas.');
      setConfirmOpen(false);
      onSaved(result.settings, result.warnings);
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Não foi possível salvar as configurações.'), { duration: 7000 });
    } finally {
      setSaving(false);
    }
  }

  const effective = settings.effective_default_store;
  const savedDefault = settings.default_store;
  const savedDefaultStatus = savedDefault ? statusMeta(STORE_ACCOUNT_STATUS, savedDefault.account_status) : null;
  const removingDefault = draft.defaultStore === null && settings.default_store_id !== null;

  const selectedPlan = plans?.find((plan) => plan.id === draft.signupPlanId) ?? null;
  const planOptions: PlanOption[] = plans ?? [];
  // O plano salvo continua na lista mesmo que a consulta de planos tenha falhado
  const savedPlanMissing = !!settings.self_signup_plan && !planOptions.some((plan) => plan.id === settings.self_signup_plan?.id);

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      <SettingsCard
        title="Loja padrão"
        icon={<Store size={20} />}
        description="Atende as rotas antigas sem o endereço da loja: app mobile e integrações da versão de loja única (cardápio, status, pedidos e pagamentos)."
      >
        <div className="flex flex-wrap items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
          <span className="font-semibold">Em uso agora:</span>
          {effective ? (
            <>
              <Link
                to={`/platform/stores/${effective.id}`}
                className="font-bold text-orange-700 dark:text-orange-400 hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
              >
                {effective.name}
              </Link>
              <span className="text-xs text-gray-500 dark:text-gray-400">/{effective.slug}</span>
              <StatusBadge tone="info">{settings.default_store_env_override ? 'Definida pelo ambiente' : 'Definida aqui'}</StatusBadge>
            </>
          ) : (
            <StatusBadge tone="warning" icon={<AlertTriangle size={12} />}>Nenhuma: as rotas antigas respondem 404</StatusBadge>
          )}
        </div>

        {settings.default_store_env_override && (
          <p className="flex items-start gap-2 px-3 py-2 rounded-xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              O ambiente da API define <code className="font-mono">DEFAULT_STORE_SLUG={settings.default_store_env_override}</code>, que tem prioridade:
              a escolha abaixo só passa a valer quando essa variável for removida.
            </span>
          </p>
        )}

        {savedDefault && savedDefault.account_status === 'INACTIVE' && (
          <p className="flex items-start gap-2 px-3 py-2 rounded-xl text-sm bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 border border-red-200 dark:border-red-800">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
            <span>A loja padrão configurada ({savedDefault.name}) está desativada: escolha outra ou restaure a loja.</span>
          </p>
        )}

        <FormField
          label="Loja padrão configurada"
          hint={savedDefault && savedDefaultStatus
            ? `Salva: ${savedDefault.name} (${savedDefaultStatus.label.toLowerCase()}). Lojas desativadas não podem ser escolhidas.`
            : 'Nenhuma salva. Lojas desativadas não podem ser escolhidas.'}
        >
          {(field) => (
            <EntityPicker
              {...field}
              value={draft.defaultStore}
              onChange={(option) => update('defaultStore', option)}
              search={(term, signal) => searchStoreOptions(term, signal, true)}
              placeholder="Buscar loja por nome ou endereço"
              listLabel="Lojas encontradas"
              noResultsText="Nenhuma loja encontrada."
              clearLabel="Ficar sem loja padrão"
              disabled={saving}
            />
          )}
        </FormField>

        {removingDefault && (
          <p role="status" className="flex items-start gap-2 px-3 py-2 rounded-xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
            <span>Sem loja padrão, o app mobile e as integrações antigas deixam de funcionar (as rotas sem o endereço da loja respondem 404).</span>
          </p>
        )}
      </SettingsCard>

      <SettingsCard
        title="Cobrança e suporte"
        icon={<Receipt size={20} />}
        description="Regras que valem para todas as lojas."
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <FormField
            label="Tolerância da inadimplência (dias)"
            required
            error={graceError}
            hint={`Dias entre a assinatura entrar em atraso e a suspensão automática; nesse tempo a loja continua vendendo, com aviso. De ${settings.limits.grace_period_days.min} a ${settings.limits.grace_period_days.max}.`}
          >
            {(field) => (
              <input
                {...field}
                type="number"
                inputMode="numeric"
                min={settings.limits.grace_period_days.min}
                max={settings.limits.grace_period_days.max}
                step={1}
                value={draft.graceDays}
                onChange={(event) => update('graceDays', event.target.value)}
                disabled={saving}
                className={fieldControlClass(!!graceError)}
              />
            )}
          </FormField>
          <FormField
            label="Duração da sessão de suporte (minutos)"
            required
            error={minutesError}
            hint={`Tempo do acesso assistido (somente leitura) ao painel de uma loja; vale para as próximas sessões. De ${settings.limits.support_session_minutes.min} a ${settings.limits.support_session_minutes.max}.`}
          >
            {(field) => (
              <input
                {...field}
                type="number"
                inputMode="numeric"
                min={settings.limits.support_session_minutes.min}
                max={settings.limits.support_session_minutes.max}
                step={1}
                value={draft.supportMinutes}
                onChange={(event) => update('supportMinutes', event.target.value)}
                disabled={saving}
                className={fieldControlClass(!!minutesError)}
              />
            )}
          </FormField>
        </div>
        <p className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <Headset size={14} className="shrink-0" aria-hidden="true" />
          Sessões de suporte já abertas mantêm o prazo com que foram criadas.
        </p>
      </SettingsCard>

      <SettingsCard
        title="Autoatendimento de lojas"
        icon={<UserPlus size={20} />}
        description="Estabelecimentos se cadastram sozinhos pela página pública e já começam no plano escolhido."
      >
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold text-gray-700 dark:text-gray-200">Situação salva:</span>
          {settings.self_signup_available ? (
            <StatusBadge tone="success" dot>Aceitando cadastros</StatusBadge>
          ) : settings.store_self_signup_enabled ? (
            <StatusBadge tone="warning" dot>Ligado, mas o plano escolhido não está disponível</StatusBadge>
          ) : (
            <StatusBadge tone="neutral" dot>Desligado</StatusBadge>
          )}
          <a
            href="/cadastrar-loja"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-bold text-gray-500 dark:text-gray-400 hover:text-orange-600 dark:hover:text-orange-400 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          >
            Ver a página pública <ExternalLink size={12} aria-hidden="true" /><span className="sr-only">(abre em outra aba)</span>
          </a>
        </div>

        <Switch
          checked={draft.signupEnabled}
          onChange={(checked) => update('signupEnabled', checked)}
          disabled={saving}
          label="Permitir o cadastro de estabelecimentos pela página pública"
          description="Desligado, a página /cadastrar-loja não aceita novos cadastros (as lojas são criadas só pelo superpainel)."
        />

        <FormField
          label="Plano das lojas do autoatendimento"
          required={draft.signupEnabled}
          error={planError}
          hint={plansError
            ? undefined
            : 'Só planos disponíveis para contratação e públicos podem receber lojas do autoatendimento.'}
        >
          {(field) => (
            <select
              {...field}
              value={draft.signupPlanId === null ? '' : String(draft.signupPlanId)}
              onChange={(event) => update('signupPlanId', event.target.value === '' ? null : Number(event.target.value))}
              disabled={saving || (plansLoading && !plans)}
              className={fieldControlClass(!!planError)}
            >
              <option value="" disabled={draft.signupEnabled}>{plansLoading && !plans ? 'Carregando planos...' : 'Nenhum plano'}</option>
              {planOptions.map((plan) => (
                <option key={plan.id} value={plan.id} disabled={!isSignupPlan(plan) && plan.id !== draft.signupPlanId}>
                  {planLabel(plan)}
                </option>
              ))}
              {savedPlanMissing && settings.self_signup_plan && (
                <option value={settings.self_signup_plan.id}>{settings.self_signup_plan.name}</option>
              )}
            </select>
          )}
        </FormField>
        {plansError && (
          <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-red-600 dark:text-red-400">
            <AlertTriangle size={14} className="shrink-0" aria-hidden="true" /> {plansError}
            <button type="button" onClick={onRetryPlans} className="font-bold underline">Tentar novamente</button>
          </p>
        )}
        {draft.signupEnabled && selectedPlan && isSignupPlan(selectedPlan) && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Novas lojas começam no plano <span className="font-bold text-gray-700 dark:text-gray-200">{selectedPlan.name}</span>
            {selectedPlan.price > 0 ? ' (com o teste grátis do plano, se houver).' : '.'}
          </p>
        )}
      </SettingsCard>

      {/* Barra de salvar: fica visível enquanto houver alterações */}
      <div
        className={cx(
          CARD_CLASS,
          'p-3 sm:p-4 sm:px-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3',
          dirty && 'sticky bottom-4 z-10 shadow-lg ring-1 ring-orange-200 dark:ring-orange-900/60',
        )}
      >
        <p aria-live="polite" className="text-xs text-gray-500 dark:text-gray-400">
          {dirty ? (
            <span className="inline-flex items-center gap-1.5 font-semibold text-orange-700 dark:text-orange-400">
              <span className="w-2 h-2 rounded-full bg-orange-500" aria-hidden="true" />
              {summary.length === 1 ? '1 alteração não salva.' : `${summary.length} alterações não salvas.`}
            </span>
          ) : settings.updated_at ? (
            <>Última alteração{settings.updated_by ? ` por ${settings.updated_by.name || settings.updated_by.email}` : ''} em {formatDateTime(settings.updated_at)}.</>
          ) : (
            'Valores padrão da plataforma (nunca alterados).'
          )}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setDraft(draftFrom(settings));
              setSubmitted(false);
            }}
            disabled={!dirty || saving}
            className={buttonClass('secondary', 'md', 'flex-1 sm:flex-none')}
          >
            <RotateCcw size={16} aria-hidden="true" /> Descartar
          </button>
          <button type="submit" disabled={!dirty || saving} className={buttonClass('primary', 'md', 'flex-[2] sm:flex-none')}>
            {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
            {saving ? 'Salvando...' : 'Salvar alterações'}
          </button>
        </div>
      </div>

      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => {
          if (!saving) setConfirmOpen(false);
        }}
        onConfirm={() => void save()}
        closeOnConfirm={false}
        loading={saving}
        title="Salvar as configurações da plataforma?"
        confirmLabel="Salvar alterações"
        isDestructive={removingDefault}
        message="Estas regras valem na hora para todas as lojas (e a loja padrão, para o app mobile). A alteração fica registrada na auditoria."
      >
        <ul className="space-y-2 text-sm">
          {summary.map((item) => (
            <li key={item.field} className="p-2.5 rounded-xl bg-gray-50 dark:bg-slate-800 border border-gray-100 dark:border-slate-700">
              <p className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">{item.field}</p>
              <p className="text-gray-700 dark:text-gray-200">
                <span className="line-through decoration-gray-400 text-gray-500 dark:text-gray-400">{item.from}</span>
                {' → '}
                <span className="font-bold">{item.to}</span>
              </p>
            </li>
          ))}
        </ul>
      </ConfirmModal>
    </form>
  );
}
