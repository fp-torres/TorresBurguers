import { Check, Minus } from 'lucide-react';
import { StatusBadge, cx, fieldControlClass, type FormFieldControlProps } from '../../../components/ui';
import type { PlatformPlan } from '../../../services/platform/billingParsers';
import { PLAN_FEATURE_KEYS, PLAN_FEATURE_LABELS } from '../../../services/storeAccess';
import { formatCurrency } from '../../../utils/format';
import {
  PLAN_LIMIT_LABELS, STORAGE_LIMIT_LABEL, limitLabel, planPriceLabel, storageLimitLabel,
} from '../Subscriptions/billingDisplay';

interface PlanSelectProps {
  plans: PlatformPlan[];
  value: number | null;
  onChange: (planId: number | null) => void;
  /** Props de acessibilidade do FormField. */
  field: FormFieldControlProps;
  /** Plano que fica fora da lista (ex.: o atual, ao mudar de plano). */
  excludeId?: number | null;
  /** Lista também os planos indisponíveis para novas contratações (internos ou negociados). */
  includeInactive?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  placeholder?: string;
}

function optionLabel(plan: PlatformPlan): string {
  const trial = plan.trial_days > 0 ? ` · ${plan.trial_days} dia${plan.trial_days === 1 ? '' : 's'} grátis` : '';
  return `${plan.name} (${plan.code}) — ${planPriceLabel(plan.price, plan.billing_interval)}${trial}`;
}

/** Seletor de plano: disponíveis primeiro; os indisponíveis (internos/negociados) só quando pedidos. */
export default function PlanSelect({
  plans, value, onChange, field, excludeId = null, includeInactive = false, invalid = false, disabled = false, placeholder = 'Selecione um plano',
}: PlanSelectProps) {
  const available = plans.filter((plan) => plan.id !== excludeId && plan.status === 'ACTIVE');
  const unavailable = plans.filter((plan) => plan.id !== excludeId && plan.status !== 'ACTIVE');
  const selectedHidden = value !== null && !includeInactive && unavailable.some((plan) => plan.id === value);

  return (
    <select
      {...field}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}
      disabled={disabled}
      className={fieldControlClass(invalid)}
    >
      <option value="">{placeholder}</option>
      <optgroup label="Disponíveis para contratação">
        {available.map((plan) => <option key={plan.id} value={plan.id}>{optionLabel(plan)}</option>)}
      </optgroup>
      {(includeInactive || selectedHidden) && unavailable.length > 0 && (
        <optgroup label="Indisponíveis (internos ou negociados)">
          {unavailable.map((plan) => <option key={plan.id} value={plan.id}>{optionLabel(plan)}</option>)}
        </optgroup>
      )}
    </select>
  );
}

/** Resumo de um plano: preço, teste grátis, limites e recursos. */
export function PlanFacts({ plan, title, className }: { plan: PlatformPlan; title?: string; className?: string }) {
  return (
    <div className={cx('p-4 rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/40 space-y-3 text-sm', className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {title && <p className="text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400">{title}</p>}
          <p className="font-bold text-gray-800 dark:text-white wrap-break-word">{plan.name} <span className="font-mono text-xs text-gray-500 dark:text-gray-400">{plan.code}</span></p>
        </div>
        {plan.status !== 'ACTIVE' && <StatusBadge tone="neutral">Indisponível</StatusBadge>}
      </div>
      <p className="text-gray-700 dark:text-gray-200">
        <span className="font-bold">{planPriceLabel(plan.price, plan.billing_interval)}</span>
        {plan.price > 0 && plan.billing_interval === 'YEARLY' && <span className="text-gray-500 dark:text-gray-400"> · equivale a {formatCurrency(plan.monthly_price)} por mês</span>}
        {plan.trial_days > 0 && <span className="text-gray-500 dark:text-gray-400"> · {plan.trial_days} dia{plan.trial_days === 1 ? '' : 's'} de teste grátis</span>}
      </p>
      <dl className="rounded-lg bg-white dark:bg-slate-800 border border-gray-100 dark:border-slate-700 px-3 py-1 divide-y divide-gray-100 dark:divide-slate-700">
        {([['staff_users', plan.max_staff_users], ['products', plan.max_products], ['monthly_orders', plan.max_monthly_orders]] as const).map(([key, limit]) => (
          <div key={key} className="flex items-baseline justify-between gap-3 py-1.5">
            <dt className="text-gray-500 dark:text-gray-400">{PLAN_LIMIT_LABELS[key]}</dt>
            <dd className="font-bold text-gray-800 dark:text-white tabular-nums">{limitLabel(limit)}</dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-3 py-1.5">
          <dt className="text-gray-500 dark:text-gray-400">{STORAGE_LIMIT_LABEL}</dt>
          <dd className="font-bold text-gray-800 dark:text-white tabular-nums">{storageLimitLabel(plan.max_storage_mb)}</dd>
        </div>
      </dl>
      <ul className="flex flex-col gap-1">
        {PLAN_FEATURE_KEYS.map((key) => (
          <li key={key} className={cx('flex items-center gap-2', plan.features[key] ? 'text-gray-700 dark:text-gray-200' : 'text-gray-400 dark:text-gray-500')}>
            {plan.features[key]
              ? <Check size={14} className="shrink-0 text-green-600 dark:text-green-400" aria-hidden="true" />
              : <Minus size={14} className="shrink-0" aria-hidden="true" />}
            <span>{PLAN_FEATURE_LABELS[key]}<span className="sr-only">{plan.features[key] ? ': incluído' : ': não incluído'}</span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}
