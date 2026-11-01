import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '@iconify/react';
import { AlertTriangle, CheckCircle2, ExternalLink, Info, Loader2, MailCheck, Store, UserPlus } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  CARD_CLASS, CopyField, FormField, Modal, PageHeader, StatusBadge, buttonClass, cx, fieldControlClass,
} from '../../../components/ui';
import { getApiErrorMessage, getApiErrorStatus } from '../../../services/api';
import { platformStoresService, type CreatedStore } from '../../../services/platform/storesService';
import { SUBSCRIPTION_STATUS, statusMeta } from '../../../utils/saasStatus';
import { formatDateTime } from '../../../utils/format';
import PlanSelect, { PlanFacts } from '../Plans/PlanSelect';
import { usePlanOptions } from '../Plans/usePlanOptions';
import { formatDate } from '../../../utils/dates';
import StoreProfileFields from './StoreProfileFields';
import {
  STORE_FIELD_LIMITS, emailProblem, emptyProfile, profileErrors, profilePayload, slugProblem, type StoreProfileValues,
} from './storeForm';
import { cleanSlugInput, suggestSlug } from '../../../utils/validation';

type ServerField = 'slug' | 'owner_email' | 'plan' | 'general';

/** Campo provável de um erro da API (as mensagens dos DTOs citam o campo). */
function serverFieldOf(message: string): ServerField {
  const text = message.toLowerCase();
  if (text.includes('slug') || text.includes('endereço da loja')) return 'slug';
  if (text.includes('responsável') || text.includes('owner')) return 'owner_email';
  if (text.includes('plano') || text.includes('plan_id')) return 'plan';
  return 'general';
}

/**
 * Superpainel › Novo estabelecimento (/platform/stores/new): dados comerciais, endereço da loja (slug sugerido
 * pelo nome), CPF/CNPJ, contato, endereço, plano inicial e responsável → POST /platform/stores. A resposta traz o
 * link de convite do responsável (uso único, exibido só agora) e a tela segue para o detalhe da loja.
 */
export default function PlatformStoreNew() {
  const formId = useId();
  const navigate = useNavigate();
  const planOptions = usePlanOptions();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [profile, setProfile] = useState<StoreProfileValues>(emptyProfile);
  const [planId, setPlanId] = useState<number | null>(null);
  const [showInactivePlans, setShowInactivePlans] = useState(false);
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [serverErrors, setServerErrors] = useState<Partial<Record<ServerField, string>>>({});
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<CreatedStore | null>(null);

  const plan = planOptions.plans.find((item) => item.id === planId) ?? null;
  const trimmedName = name.trim();
  const errors = {
    name: !trimmedName ? 'Informe o nome do estabelecimento.' : trimmedName.length > STORE_FIELD_LIMITS.name ? `Use no máximo ${STORE_FIELD_LIMITS.name} caracteres.` : null,
    slug: slugProblem(slug),
    plan: plan ? null : 'Escolha o plano inicial.',
    ownerEmail: emailProblem(ownerEmail, { required: true, max: STORE_FIELD_LIMITS.owner_email }),
    ownerName: ownerName.trim().length > STORE_FIELD_LIMITS.owner_name ? `Use no máximo ${STORE_FIELD_LIMITS.owner_name} caracteres.` : null,
  };
  const profileProblems = profileErrors(profile);
  const hasErrors = Object.values(errors).some(Boolean) || Object.keys(profileProblems).length > 0;
  const shown = (local: string | null, server?: string) => (showErrors ? local ?? server : server) ?? undefined;

  function clearServer(field: ServerField) {
    setServerErrors((current) => {
      if (!current[field] && !current.general) return current;
      const next = { ...current };
      delete next[field];
      delete next.general;
      return next;
    });
  }

  function handleNameChange(value: string) {
    setName(value);
    // O endereço acompanha o nome até ser editado à mão
    if (!slugTouched) {
      setSlug(suggestSlug(value));
      clearServer('slug');
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (hasErrors || !plan) {
      setShowErrors(true);
      toast.error('Confira os campos destacados.', { id: 'store-new-invalid' });
      return;
    }
    setSaving(true);
    setServerErrors({});
    try {
      const result = await platformStoresService.create({
        name: trimmedName,
        slug,
        plan_id: plan.id,
        allow_inactive_plan: plan.status !== 'ACTIVE' ? true : undefined,
        owner: { email: ownerEmail.trim().toLowerCase(), ...(ownerName.trim() ? { name: ownerName.trim() } : {}) },
        ...profilePayload(profile),
      });
      setCreated(result);
      toast.success(`${result.store.name} cadastrado.`);
    } catch (error) {
      const message = getApiErrorMessage(error, 'Não foi possível cadastrar o estabelecimento.');
      const status = getApiErrorStatus(error);
      // 409: slug em uso ou e-mail do responsável já tem conta; 400: dados inválidos (a API diz qual campo)
      if (status === 400 || status === 409) setServerErrors({ [serverFieldOf(message)]: message });
      else setServerErrors({ general: message });
      toast.error(message, { duration: 6000 });
    } finally {
      setSaving(false);
    }
  }

  function goToStore() {
    if (created) navigate(`/platform/stores/${created.store.id}`, { replace: true });
  }

  const storefrontPreview = `${window.location.origin}/loja/${slug || 'endereco-da-loja'}`;

  return (
    <div className="space-y-6 pb-20">
      <PageHeader
        title="Novo estabelecimento"
        subtitle="Cadastro de uma loja na plataforma, com o plano inicial e o convite do responsável"
        icon={<Icon icon="solar:shop-bold-duotone" width={26} />}
        back={{ to: '/platform/stores', label: 'Estabelecimentos' }}
      />

      {serverErrors.general && (
        <div role="alert" className="flex items-start gap-3 px-4 py-3 rounded-2xl text-sm bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300 border border-red-200 dark:border-red-800">
          <AlertTriangle size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
          <p>{serverErrors.general}</p>
        </div>
      )}

      <form id={formId} onSubmit={handleSubmit} noValidate className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
        <section aria-labelledby={`${formId}-store`} className={cx(CARD_CLASS, 'xl:col-span-2 p-5 sm:p-6 space-y-6')}>
          <div>
            <h2 id={`${formId}-store`} className="text-lg font-bold text-gray-800 dark:text-white flex items-center gap-2">
              <Store size={20} className="text-orange-600 dark:text-orange-400" aria-hidden="true" /> Dados do estabelecimento
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">A loja nasce ativa, fechada, com a entrega desligada e a retirada ligada: a equipe configura o resto no painel.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Nome do estabelecimento" required error={shown(errors.name)}>
              {(field) => (
                <input
                  {...field}
                  value={name}
                  onChange={(event) => handleNameChange(event.target.value)}
                  maxLength={STORE_FIELD_LIMITS.name}
                  placeholder="Lanchonete do Bairro"
                  autoComplete="off"
                  className={fieldControlClass(showErrors && !!errors.name)}
                />
              )}
            </FormField>
            <FormField
              label="Endereço da loja"
              required
              error={shown(errors.slug, serverErrors.slug)}
              hint={(
                <span className="break-all">
                  Vitrine em <span className="font-mono">{storefrontPreview}</span>. Minúsculas, números e hífens (3 a 60).
                  {!slugTouched && trimmedName && ' Sugerido pelo nome.'}
                </span>
              )}
            >
              {(field) => (
                <div className="flex items-stretch rounded-xl">
                  <span className="inline-flex items-center px-3 rounded-l-xl border border-r-0 border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900 text-sm text-gray-500 dark:text-gray-400 font-mono" aria-hidden="true">/loja/</span>
                  <input
                    {...field}
                    value={slug}
                    onChange={(event) => {
                      setSlugTouched(true);
                      setSlug(cleanSlugInput(event.target.value));
                      clearServer('slug');
                    }}
                    onBlur={() => setSlug((current) => current.replace(/^-+|-+$/g, ''))}
                    placeholder="lanchonete-do-bairro"
                    autoComplete="off"
                    spellCheck={false}
                    className={fieldControlClass((showErrors && !!errors.slug) || !!serverErrors.slug, 'rounded-l-none font-mono')}
                  />
                </div>
              )}
            </FormField>
          </div>

          <StoreProfileFields
            values={profile}
            onChange={(changes) => setProfile((current) => ({ ...current, ...changes }))}
            errors={profileProblems}
            showErrors={showErrors}
            disabled={saving}
          />
        </section>

        <div className="space-y-6">
          <section aria-labelledby={`${formId}-plan`} className={cx(CARD_CLASS, 'p-5 sm:p-6 space-y-4')}>
            <div>
              <h2 id={`${formId}-plan`} className="text-lg font-bold text-gray-800 dark:text-white">Plano inicial</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">A assinatura é criada junto com a loja.</p>
            </div>
            {planOptions.error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {planOptions.error}{' '}
                <button type="button" onClick={() => void planOptions.reload()} className="font-bold underline">Tentar novamente</button>
              </p>
            )}
            <FormField
              label="Plano"
              required
              error={shown(errors.plan, serverErrors.plan)}
              hint={planOptions.loading ? 'Carregando planos...' : undefined}
            >
              {(field) => (
                <PlanSelect
                  field={field}
                  plans={planOptions.plans}
                  value={planId}
                  onChange={(id) => {
                    setPlanId(id);
                    clearServer('plan');
                  }}
                  includeInactive={showInactivePlans}
                  invalid={(showErrors && !!errors.plan) || !!serverErrors.plan}
                  disabled={planOptions.loading || saving}
                />
              )}
            </FormField>
            <label className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
              <input
                type="checkbox"
                checked={showInactivePlans}
                onChange={(event) => setShowInactivePlans(event.target.checked)}
                className="mt-0.5 w-4 h-4 accent-orange-600 shrink-0"
              />
              <span>Mostrar planos indisponíveis (internos ou negociados)</span>
            </label>
            {plan && <PlanFacts plan={plan} />}
            {plan && (
              <p className="flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400">
                <Info size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
                <span>
                  {plan.trial_days > 0
                    ? `Começa em teste grátis por ${plan.trial_days} dia${plan.trial_days === 1 ? '' : 's'}.`
                    : plan.price > 0 ? 'Começa ativa, com a fatura do primeiro período vencendo agora.' : 'Plano gratuito: começa ativa, sem faturas.'}
                </span>
              </p>
            )}
          </section>

          <section aria-labelledby={`${formId}-owner`} className={cx(CARD_CLASS, 'p-5 sm:p-6 space-y-4')}>
            <div>
              <h2 id={`${formId}-owner`} className="text-lg font-bold text-gray-800 dark:text-white flex items-center gap-2">
                <UserPlus size={20} className="text-orange-600 dark:text-orange-400" aria-hidden="true" /> Responsável
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Recebe um convite de Administrador: ao aceitar, cria a própria senha e vira o responsável pela loja.
              </p>
            </div>
            <FormField
              label="E-mail do responsável"
              required
              error={shown(errors.ownerEmail, serverErrors.owner_email)}
              hint="Precisa ser um e-mail sem conta na plataforma (a conta nasce no aceite do convite)."
            >
              {(field) => (
                <input
                  {...field}
                  type="email"
                  value={ownerEmail}
                  onChange={(event) => {
                    setOwnerEmail(event.target.value);
                    clearServer('owner_email');
                  }}
                  maxLength={STORE_FIELD_LIMITS.owner_email}
                  placeholder="dono@lanchonete.com.br"
                  autoComplete="off"
                  className={fieldControlClass((showErrors && !!errors.ownerEmail) || !!serverErrors.owner_email)}
                />
              )}
            </FormField>
            <FormField label="Nome do responsável (opcional)" error={shown(errors.ownerName)} hint="Só para referência na auditoria: a pessoa informa o nome ao aceitar.">
              {(field) => (
                <input
                  {...field}
                  value={ownerName}
                  onChange={(event) => setOwnerName(event.target.value)}
                  maxLength={STORE_FIELD_LIMITS.owner_name}
                  placeholder="Maria Silva"
                  autoComplete="off"
                  className={fieldControlClass(showErrors && !!errors.ownerName)}
                />
              )}
            </FormField>
          </section>

        </div>

        <div className={cx(CARD_CLASS, 'xl:col-span-3 sticky bottom-0 z-10 p-3 sm:p-4 flex items-center justify-end gap-3 shadow-lg')}>
          <p className="hidden sm:block text-xs text-gray-500 dark:text-gray-400 mr-auto">Campos com * são obrigatórios. A API confere tudo de novo ao salvar.</p>
          <Link to="/platform/stores" className={buttonClass('secondary')}>Cancelar</Link>
          <button type="submit" disabled={saving} className={buttonClass('primary', 'md', 'flex-1 sm:flex-none')}>
            {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Store size={16} aria-hidden="true" />}
            Cadastrar estabelecimento
          </button>
        </div>
      </form>

      <Modal
        open={!!created}
        onClose={goToStore}
        title="Estabelecimento cadastrado"
        description={created ? `${created.store.name} · /loja/${created.store.slug}` : undefined}
        closeOnOverlayClick={false}
        footer={(
          <button type="button" onClick={goToStore} className={buttonClass('primary')}>
            <ExternalLink size={16} aria-hidden="true" /> Ir para o estabelecimento
          </button>
        )}
      >
        {created && <CreatedSummary created={created} />}
      </Modal>
    </div>
  );
}

function CreatedSummary({ created }: { created: CreatedStore }) {
  const subscription = created.subscription;
  const status = subscription ? statusMeta(SUBSCRIPTION_STATUS, subscription.status) : null;
  return (
    <div className="space-y-4">
      <p className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
        <CheckCircle2 size={18} className="shrink-0 mt-0.5 text-green-600 dark:text-green-400" aria-hidden="true" />
        <span>
          A loja foi criada ativa (fechada até a equipe abrir)
          {subscription ? <> com a assinatura do plano <span className="font-bold">{subscription.plan?.name ?? `#${subscription.plan_id}`}</span>.</> : '.'}
        </span>
      </p>
      {subscription && status && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge tone={status.tone} dot>{status.label}</StatusBadge>
          {subscription.trial_ends_at && <span className="text-gray-500 dark:text-gray-400">Teste grátis até {formatDate(subscription.trial_ends_at)}</span>}
          {!subscription.trial_ends_at && subscription.current_period_end && (
            <span className="text-gray-500 dark:text-gray-400">Período até {formatDate(subscription.current_period_end)}</span>
          )}
        </div>
      )}

      {created.warnings.length > 0 && (
        <ul role="alert" className="space-y-2">
          {created.warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-2 px-3 py-2 rounded-xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" /> <span>{warning}</span>
            </li>
          ))}
        </ul>
      )}

      {created.invitation?.url ? (
        <div className="space-y-2">
          <CopyField label="Link de convite do responsável" value={created.invitation.url} />
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Envie para <span className="font-bold">{created.invitation.email}</span>
            {created.invitation.expires_at && <> · válido até {formatDateTime(created.invitation.expires_at)}</>}.
            Se o link se perder, gere um novo convite na aba Convites (o anterior deixa de valer).
          </p>
        </div>
      ) : created.invitation?.delivered ? (
        // Entregue por e-mail (SMTP configurado): o link vai só para o responsável, nunca para o operador
        <p role="status" className="flex items-start gap-2 px-3 py-2 rounded-xl text-sm bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300 border border-green-200 dark:border-green-800">
          <MailCheck size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            {created.invitation.message ?? `Convite enviado por e-mail para ${created.invitation.email}.`}
            {created.invitation.expires_at && <> Válido até {formatDateTime(created.invitation.expires_at)}.</>}
            {' '}Se o e-mail não chegar, gere um novo convite na aba Convites (o anterior deixa de valer).
          </span>
        </p>
      ) : (
        <p className="flex items-start gap-2 px-3 py-2 rounded-xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>O convite do responsável não foi gerado. Gere um convite de Administrador (como responsável) na aba Convites do estabelecimento.</span>
        </p>
      )}
    </div>
  );
}
