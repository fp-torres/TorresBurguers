import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, Info, Loader2, Mail, Store, Wand2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import BrandLogo from '../../../components/BrandLogo';
import PasswordChecklist from '../components/PasswordChecklist';
import { CARD_CLASS, EmptyState, ErrorState, FormField, buttonClass, cx, fieldControlClass } from '../../../components/ui';
import { publicStoreService, type PublicPlan } from '../../../services/publicStoreService';
import { isAuthResponse } from '../../../services/authService';
import { getApiErrorMessage, getApiErrorStatus } from '../../../services/api';
import { useAuth } from '../../../contexts/AuthContext';
import { BRAND } from '../../../config/brand';
import { maskPhone } from '../../../utils/masks';
import { formatCurrency } from '../../../utils/format';
import {
  STORE_SLUG_MAX_LENGTH, cleanSlugInput, isReservedStoreSlug, isValidEmail, isValidStoreSlug, suggestSlug,
} from '../../../utils/validation';
import { PASSWORD_RULES_MESSAGE, PASSWORD_TOO_LONG_MESSAGE, isPasswordTooLong, isStrongPassword } from '../../../utils/password';

const STORE_NAME_MAX_LENGTH = 120;
const OWNER_NAME_MAX_LENGTH = 50;

/** Recursos conhecidos dos planos (lista fechada da API). */
const FEATURE_LABELS: Record<string, string> = {
  online_payments: 'Pagamentos online (PIX e cartão)',
  advanced_reports: 'Relatórios e gráficos',
  custom_branding: 'Identidade visual própria (logo e cor)',
};

function slugError(slug: string): string | null {
  if (!slug) return 'Informe o endereço da loja.';
  if (slug.length < 3) return 'Use pelo menos 3 caracteres.';
  if (!isValidStoreSlug(slug)) return 'Use letras minúsculas, números e hífens (sem hífen no começo ou no fim).';
  if (isReservedStoreSlug(slug)) return 'Este endereço é reservado pela plataforma. Escolha outro.';
  return null;
}

function formatLimit(value: number | null, singular: string, plural: string, unlimited: string): string {
  if (value === null) return unlimited;
  return `${value.toLocaleString('pt-BR')} ${value === 1 ? singular : plural}`;
}

function intervalLabel(interval: string): string {
  return interval === 'YEARLY' ? 'ano' : 'mês';
}

type PlansState =
  | { status: 'loading' }
  | { status: 'ready'; plans: PublicPlan[] }
  | { status: 'error'; message: string };

/**
 * Cadastro de estabelecimento (/cadastrar-loja): planos públicos (GET /plans) e autoatendimento
 * (POST /stores/signup { store: { name, slug }, owner: { name, email, password, phone? }, accept_terms: true }).
 * A API devolve a sessão do novo Administrador (applyAuthResponse) e ele segue para as configurações da loja.
 * Com o autoatendimento desligado, a API responde 404: a página mostra o contato da plataforma.
 */
export default function StoreSignup() {
  const navigate = useNavigate();
  const { user, applyAuthResponse } = useAuth();
  const termsId = useId();

  const [plansAttempt, setPlansAttempt] = useState(0);
  const [plansState, setPlansState] = useState<PlansState>({ status: 'loading' });

  const [storeName, setStoreName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [ownerName, setOwnerName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    publicStoreService.listPlans(controller.signal)
      .then((plans) => setPlansState({ status: 'ready', plans }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPlansState({ status: 'error', message: getApiErrorMessage(error, 'Não foi possível carregar os planos.') });
      });
    return () => controller.abort();
  }, [plansAttempt]);

  // Endereço sugerido a partir do nome até a pessoa editar o campo
  const effectiveSlug = slugTouched ? slug : suggestSlug(storeName);
  const suggestion = suggestSlug(storeName);

  const errors = {
    storeName: !storeName.trim() ? 'Informe o nome do estabelecimento.' : null,
    slug: slugError(effectiveSlug),
    ownerName: !ownerName.trim() ? 'Informe o seu nome.' : null,
    email: !isValidEmail(email) ? 'Informe um e-mail válido.' : null,
    phone: phone && phone.replace(/\D/g, '').length < 10 ? 'Telefone incompleto.' : null,
    password: isPasswordTooLong(password) ? PASSWORD_TOO_LONG_MESSAGE : !isStrongPassword(password) ? PASSWORD_RULES_MESSAGE : null,
    confirmation: password !== confirmation ? 'A confirmação não confere com a senha.' : null,
    terms: !acceptTerms ? 'É preciso aceitar os termos para continuar.' : null,
  };
  const firstError = Object.values(errors).find(Boolean) ?? null;
  // Erros aparecem depois da primeira tentativa (o endereço é conferido enquanto se digita)
  const show = (message: string | null) => (submitted ? message ?? undefined : undefined);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (firstError) {
      toast.error(firstError);
      return;
    }

    const name = storeName.trim();
    setSaving(true);
    try {
      const data = await publicStoreService.signup({
        store: { name, slug: effectiveSlug },
        owner: { name: ownerName.trim(), email: email.trim(), password, ...(phone ? { phone } : {}) },
        accept_terms: true,
      });
      if (isAuthResponse(data)) {
        applyAuthResponse(data);
        toast.success(`${name} foi criado! Complete as configurações da loja.`, { duration: 6000 });
        navigate('/settings', { replace: true });
      } else {
        toast.success(`${name} foi criado! Entre no painel com o seu e-mail e a senha escolhida.`, { duration: 6000 });
        navigate('/login', { replace: true });
      }
    } catch (error) {
      if (getApiErrorStatus(error) === 404) {
        setUnavailable(true);
        return;
      }
      // Ex.: endereço ou e-mail já em uso (409), regras de senha (400), limite de tentativas (429)
      toast.error(getApiErrorMessage(error, 'Não foi possível cadastrar o estabelecimento.'), { duration: 6000 });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950 flex flex-col transition-colors duration-300">
      <header className="bg-white dark:bg-slate-900 border-b border-gray-100 dark:border-slate-800">
        <div className="max-w-6xl mx-auto h-16 px-4 lg:px-8 flex items-center justify-between gap-3">
          <Link to="/" className="flex items-center rounded-xl hover:opacity-90 transition-opacity" aria-label="Página inicial">
            <BrandLogo size={36} nameClassName="hidden min-[350px]:inline" />
          </Link>
          <p className="text-sm text-gray-600 dark:text-gray-400 text-right">
            <span className="hidden sm:inline">Já tem uma conta? </span>
            <Link to="/login" className="font-bold text-orange-700 dark:text-orange-400 hover:underline whitespace-nowrap">Entrar no painel</Link>
          </p>
        </div>
      </header>

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 lg:px-8 py-8 space-y-8">
        <div className="space-y-2">
          <Link to="/" className="inline-flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 hover:text-orange-700 dark:hover:text-orange-400 transition-colors">
            <ArrowLeft size={16} aria-hidden="true" /> Ver estabelecimentos
          </Link>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-gray-900 dark:text-white">Cadastre seu estabelecimento</h1>
          <p className="text-gray-500 dark:text-gray-400 max-w-2xl">
            Cardápio digital, pedidos para entrega e retirada e pagamentos online com {BRAND.name}. Crie a loja e o seu acesso de administrador agora.
          </p>
        </div>

        <div className="grid gap-8 lg:grid-cols-5 lg:items-start">
          {/* --- PLANOS --- */}
          <section aria-labelledby="plans-title" className="lg:col-span-3 space-y-4 order-2 lg:order-1">
            <div>
              <h2 id="plans-title" className="text-lg font-bold text-gray-800 dark:text-gray-100">Planos</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Seu estabelecimento começa no plano definido pela plataforma para novos cadastros. Dúvidas sobre planos:{' '}
                <a href={`mailto:${BRAND.supportEmail}`} className="font-bold text-orange-700 dark:text-orange-400 hover:underline break-all">{BRAND.supportEmail}</a>.
              </p>
            </div>

            {plansState.status === 'loading' ? (
              <ul className="grid gap-4 sm:grid-cols-2" aria-busy="true">
                {[1, 2].map((index) => <li key={index} className="h-64 rounded-2xl bg-gray-200 dark:bg-slate-800 animate-pulse" aria-hidden="true" />)}
                <li className="sr-only" role="status">Carregando planos...</li>
              </ul>
            ) : plansState.status === 'error' ? (
              <div className={CARD_CLASS}>
                <ErrorState
                  compact
                  title="Não foi possível carregar os planos"
                  message={plansState.message}
                  onRetry={() => {
                    setPlansState({ status: 'loading' });
                    setPlansAttempt((value) => value + 1);
                  }}
                />
              </div>
            ) : plansState.plans.length === 0 ? (
              <div className={CARD_CLASS}>
                <EmptyState compact title="Nenhum plano público no momento" description={`Fale com a equipe ${BRAND.name} para conhecer as condições.`} />
              </div>
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2">
                {plansState.plans.map((plan) => <li key={plan.id}><PlanCard plan={plan} /></li>)}
              </ul>
            )}
          </section>

          {/* --- FORMULÁRIO --- */}
          <section aria-labelledby="signup-title" className={cx(CARD_CLASS, 'lg:col-span-2 p-5 sm:p-6 order-1 lg:order-2 lg:sticky lg:top-6')}>
            {unavailable ? (
              <EmptyState
                compact
                icon={<Store size={28} />}
                title="Cadastro de estabelecimentos indisponível no momento"
                description={(
                  <>
                    O cadastro pelo site não está aberto agora. Fale com a equipe {BRAND.name} para colocar seu estabelecimento na plataforma:{' '}
                    <a href={`mailto:${BRAND.supportEmail}`} className="font-bold text-orange-700 dark:text-orange-400 hover:underline break-all">{BRAND.supportEmail}</a>
                  </>
                )}
                action={(
                  <a href={`mailto:${BRAND.supportEmail}?subject=${encodeURIComponent('Cadastro de estabelecimento')}`} className={buttonClass('primary')}>
                    <Mail size={16} aria-hidden="true" /> Falar com a equipe
                  </a>
                )}
              />
            ) : (
              <form onSubmit={handleSubmit} noValidate className="space-y-5">
                <h2 id="signup-title" className="text-lg font-bold text-gray-800 dark:text-gray-100">Dados do cadastro</h2>

                {user && (
                  <p className="text-xs text-blue-800 dark:text-blue-200 bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 rounded-xl p-3 flex items-start gap-2">
                    <Info size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
                    Você está conectado como {user.email}. Ao concluir, você entra com a nova conta de administrador do estabelecimento.
                  </p>
                )}

                <fieldset className="space-y-4" disabled={saving}>
                  <legend className="text-xs font-bold uppercase tracking-widest text-gray-500 dark:text-gray-400 mb-2">Estabelecimento</legend>
                  <FormField label="Nome do estabelecimento" required error={show(errors.storeName)}>
                    {(field) => (
                      <input
                        {...field}
                        value={storeName}
                        onChange={(event) => setStoreName(event.target.value)}
                        maxLength={STORE_NAME_MAX_LENGTH}
                        autoComplete="organization"
                        placeholder="Ex.: Pizzaria do Bairro"
                        className={fieldControlClass(!!show(errors.storeName))}
                      />
                    )}
                  </FormField>

                  <FormField
                    label="Endereço da loja no site"
                    required
                    error={effectiveSlug || submitted ? errors.slug ?? undefined : undefined}
                    hint={(
                      <span className="break-all">
                        Seus clientes vão acessar: <b className="text-gray-700 dark:text-gray-200">{window.location.origin}/loja/{effectiveSlug || 'sua-loja'}</b>
                      </span>
                    )}
                  >
                    {(field) => (
                      <div className="space-y-2">
                        <div className="flex items-stretch">
                          <span className="inline-flex items-center px-3 rounded-l-xl border border-r-0 border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900 text-sm text-gray-500 dark:text-gray-400 font-mono" aria-hidden="true">/loja/</span>
                          <input
                            {...field}
                            value={effectiveSlug}
                            onChange={(event) => {
                              setSlugTouched(true);
                              setSlug(cleanSlugInput(event.target.value, { collapseHyphens: true }));
                            }}
                            maxLength={STORE_SLUG_MAX_LENGTH}
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="pizzaria-do-bairro"
                            className={fieldControlClass(!!(effectiveSlug || submitted) && !!errors.slug, 'rounded-l-none font-mono')}
                          />
                        </div>
                        {slugTouched && suggestion && suggestion !== slug && (
                          <button
                            type="button"
                            onClick={() => {
                              setSlug(suggestion);
                              setSlugTouched(false);
                            }}
                            className="inline-flex items-center gap-1.5 text-xs font-bold text-orange-700 dark:text-orange-400 hover:underline"
                          >
                            <Wand2 size={14} aria-hidden="true" /> Usar a sugestão: {suggestion}
                          </button>
                        )}
                      </div>
                    )}
                  </FormField>
                </fieldset>

                <fieldset className="space-y-4" disabled={saving}>
                  <legend className="text-xs font-bold uppercase tracking-widest text-gray-500 dark:text-gray-400 mb-2">Responsável (administrador)</legend>
                  <FormField label="Seu nome" required error={show(errors.ownerName)}>
                    {(field) => (
                      <input {...field} value={ownerName} onChange={(event) => setOwnerName(event.target.value)} maxLength={OWNER_NAME_MAX_LENGTH} autoComplete="name" className={fieldControlClass(!!show(errors.ownerName))} />
                    )}
                  </FormField>
                  <FormField label="E-mail" required error={show(errors.email)} hint="Será o seu login no painel da loja.">
                    {(field) => (
                      <input {...field} type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" placeholder="voce@empresa.com.br" className={fieldControlClass(!!show(errors.email))} />
                    )}
                  </FormField>
                  <FormField label="Telefone" error={show(errors.phone)} hint="Opcional.">
                    {(field) => (
                      <input {...field} type="tel" inputMode="tel" value={phone} onChange={(event) => setPhone(maskPhone(event.target.value))} autoComplete="tel" placeholder="(21) 99999-9999" maxLength={15} className={fieldControlClass(!!show(errors.phone))} />
                    )}
                  </FormField>
                  <FormField label="Senha" required error={show(errors.password)} hint={<PasswordChecklist password={password} />}>
                    {(field) => (
                      <input {...field} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" className={fieldControlClass(!!show(errors.password))} />
                    )}
                  </FormField>
                  <FormField label="Confirmar senha" required error={show(errors.confirmation)}>
                    {(field) => (
                      <input {...field} type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" className={fieldControlClass(!!show(errors.confirmation))} />
                    )}
                  </FormField>
                </fieldset>

                <div className="space-y-1">
                  <label htmlFor={termsId} className="flex items-start gap-3 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                    <input
                      id={termsId}
                      type="checkbox"
                      checked={acceptTerms}
                      onChange={(event) => setAcceptTerms(event.target.checked)}
                      disabled={saving}
                      aria-invalid={submitted && !acceptTerms ? true : undefined}
                      aria-describedby={submitted && !acceptTerms ? `${termsId}-error` : undefined}
                      className="mt-0.5 w-4 h-4 accent-orange-600"
                    />
                    <span>
                      Declaro que as informações são verdadeiras e aceito os termos de uso e a política de privacidade da {BRAND.name}.
                    </span>
                  </label>
                  {submitted && !acceptTerms && (
                    <p id={`${termsId}-error`} className="text-xs font-semibold text-red-600 dark:text-red-400 pl-7">{errors.terms}</p>
                  )}
                </div>

                <button type="submit" disabled={saving} className={buttonClass('primary', 'lg', 'w-full')}>
                  {saving ? <><Loader2 size={18} className="animate-spin" aria-hidden="true" /> Criando estabelecimento...</> : 'Criar estabelecimento'}
                </button>
              </form>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

/** Cartão de um plano: preço e periodicidade, teste grátis, limites (nulo = ilimitado) e recursos. */
function PlanCard({ plan }: { plan: PublicPlan }) {
  const free = plan.price <= 0;
  const featureKeys = [...new Set([...Object.keys(FEATURE_LABELS), ...Object.keys(plan.features)])];
  const yearly = plan.billing_interval === 'YEARLY';

  return (
    <article className={cx(CARD_CLASS, 'h-full p-5 flex flex-col gap-4')} aria-labelledby={`plan-${plan.id}`}>
      <div className="space-y-1">
        <h3 id={`plan-${plan.id}`} className="text-lg font-extrabold text-gray-900 dark:text-white">{plan.name}</h3>
        {plan.description && <p className="text-sm text-gray-500 dark:text-gray-400">{plan.description}</p>}
      </div>

      <div>
        <p className="text-3xl font-extrabold text-gray-900 dark:text-white">
          {free ? 'Grátis' : formatCurrency(plan.price)}
          {!free && <span className="text-sm font-bold text-gray-500 dark:text-gray-400">/{intervalLabel(plan.billing_interval)}</span>}
        </p>
        {!free && yearly && plan.monthly_price !== null && (
          <p className="text-xs text-gray-500 dark:text-gray-400">Equivale a {formatCurrency(plan.monthly_price)} por mês</p>
        )}
        {plan.trial_days > 0 && (
          <p className="mt-2 inline-flex text-xs font-bold px-2.5 py-1 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800">
            {plan.trial_days} {plan.trial_days === 1 ? 'dia' : 'dias'} de teste grátis
          </p>
        )}
      </div>

      <dl className="text-sm space-y-1.5">
        <div className="flex justify-between gap-3">
          <dt className="text-gray-500 dark:text-gray-400">Equipe</dt>
          <dd className="font-bold text-gray-800 dark:text-gray-100 text-right">{formatLimit(plan.max_staff_users, 'usuário', 'usuários', 'Ilimitada')}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-gray-500 dark:text-gray-400">Produtos</dt>
          <dd className="font-bold text-gray-800 dark:text-gray-100 text-right">{formatLimit(plan.max_products, 'produto', 'produtos', 'Ilimitados')}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-gray-500 dark:text-gray-400">Pedidos por mês</dt>
          <dd className="font-bold text-gray-800 dark:text-gray-100 text-right">{formatLimit(plan.max_monthly_orders, 'pedido', 'pedidos', 'Ilimitados')}</dd>
        </div>
      </dl>

      <ul className="text-sm space-y-1.5 mt-auto" aria-label={`Recursos do plano ${plan.name}`}>
        {featureKeys.map((key) => {
          const enabled = plan.features[key] === true;
          const label = FEATURE_LABELS[key] ?? key;
          return (
            <li key={key} className={cx('flex items-start gap-2', enabled ? 'text-gray-700 dark:text-gray-200' : 'text-gray-400 dark:text-gray-500')}>
              {enabled
                ? <Check size={16} className="shrink-0 mt-0.5 text-green-600 dark:text-green-400" aria-hidden="true" />
                : <X size={16} className="shrink-0 mt-0.5" aria-hidden="true" />}
              <span>{label}<span className="sr-only">{enabled ? ' (incluído)' : ' (não incluído)'}</span></span>
            </li>
          );
        })}
      </ul>
    </article>
  );
}
