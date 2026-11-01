import { AlertTriangle } from 'lucide-react';
import { StatusBadge, cx } from '../../../components/ui';
import {
  PLAN_LIMIT_KEYS, type PlanLimitKey, type PlanLimits, type PlanStorage, type PlanUsage,
} from '../../../services/platform/billingParsers';
import { formatMegabytes } from '../../../services/storeSubscriptionService';
import { PLAN_LIMIT_LABELS, STORAGE_LIMIT_LABEL } from './billingDisplay';
import { formatInteger, formatTime } from '../../../utils/format';
import { toDate } from '../../../utils/dates';

interface UsageMetersProps {
  usage: PlanUsage;
  /** Limites do plano vigente (null = sem assinatura vigente: mostra só o uso). */
  limits: PlanLimits | null;
  /**
   * Armazenamento das imagens da loja (campo storage da API). Ausente (undefined/null) = o medidor não aparece,
   * como nas telas que ainda não recebem o campo.
   */
  storage?: PlanStorage | null;
  /** Selo quando não há limites (padrão: "Sem plano vigente"; ex.: "Não se aplica" numa assinatura cancelada). */
  noLimitsLabel?: string;
  className?: string;
}


/**
 * Uso × limites do plano (equipe ativa, produtos fora da lixeira, pedidos do mês no calendário da loja e, quando
 * informado, o armazenamento das imagens). A barra usa o mesmo tom no trilho; perto do limite (>= 80%) e no
 * limite muda de cor, sempre com texto.
 */
export default function UsageMeters({ usage, limits, storage, noLimitsLabel = 'Sem plano vigente', className }: UsageMetersProps) {
  return (
    // Com o armazenamento são 4 medidores: 2 por linha (os painéis do superpainel são estreitos)
    <div className={cx('grid grid-cols-1 gap-4', storage ? 'sm:grid-cols-2' : 'md:grid-cols-3', className)}>
      {PLAN_LIMIT_KEYS.map((key) => (
        <Meter
          key={key}
          label={PLAN_LIMIT_LABELS[key]}
          used={usage[key]}
          limit={limits ? limits[key] : undefined}
          format={(value) => formatInteger(value)}
          noLimitsLabel={noLimitsLabel}
          limitKey={key}
        />
      ))}
      {storage && (
        <Meter
          label={STORAGE_LIMIT_LABEL}
          used={storage.used_mb}
          limit={limits ? storage.limit_mb : undefined}
          format={formatMegabytes}
          noLimitsLabel={noLimitsLabel}
          note={storageNote(storage)}
        />
      )}
    </div>
  );
}

/** "12 arquivos · medido às 14:05" (as imagens de produtos, adicionais e o logo; fotos de perfil não contam). */
function storageNote(storage: PlanStorage): string {
  const parts: string[] = [];
  if (storage.files !== null) parts.push(`${formatInteger(storage.files)} ${storage.files === 1 ? 'arquivo' : 'arquivos'}`);
  const measured = toDate(storage.measured_at);
  if (measured) parts.push(`medido às ${formatTime(measured)}`);
  if (storage.used_mb === null) parts.push('uso indisponível no momento');
  return parts.join(' · ');
}

/** limit: número = limite; null = ilimitado; undefined = sem limites a aplicar (noLimitsLabel). */
function Meter({ label, used, limit, format, noLimitsLabel, note, limitKey }: {
  label: string;
  used: number | null;
  limit: number | null | undefined;
  format: (value: number) => string;
  noLimitsLabel: string;
  /** Linha pequena abaixo do valor (ex.: arquivos e horário da medição). */
  note?: string;
  limitKey?: PlanLimitKey;
}) {
  const usedText = used === null ? '—' : format(used);
  const noteLine = note ? <p className="text-xs text-gray-500 dark:text-gray-400">{note}</p> : null;

  if (limit === undefined || limit === null) {
    return (
      <div data-limit={limitKey ?? 'storage_mb'} className="p-4 rounded-xl border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/40 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <p className="text-sm font-bold text-gray-700 dark:text-gray-200">{label}</p>
          {limit === null
            ? <StatusBadge tone="success">Ilimitado</StatusBadge>
            : <StatusBadge tone="neutral">{noLimitsLabel}</StatusBadge>}
        </div>
        <p className="text-2xl font-bold text-gray-800 dark:text-white">
          {usedText} <span className="text-sm font-semibold text-gray-500 dark:text-gray-400">em uso</span>
        </p>
        {noteLine}
      </div>
    );
  }

  const atLimit = used !== null && used >= limit;
  const near = !atLimit && used !== null && limit > 0 && used / limit >= 0.8;
  const percent = used !== null && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const bar = atLimit ? 'bg-red-500' : near ? 'bg-amber-500' : 'bg-orange-500';
  const track = atLimit ? 'bg-red-100 dark:bg-red-900/30' : near ? 'bg-amber-100 dark:bg-amber-900/30' : 'bg-orange-100 dark:bg-orange-900/30';
  const limitText = format(limit);

  return (
    <div data-limit={limitKey ?? 'storage_mb'} className="p-4 rounded-xl border border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/40 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <p className="text-sm font-bold text-gray-700 dark:text-gray-200">{label}</p>
        {atLimit && <StatusBadge tone="danger" icon={<AlertTriangle size={12} />}>{used > limit ? 'Acima do limite' : 'Limite atingido'}</StatusBadge>}
        {near && <StatusBadge tone="warning">Perto do limite</StatusBadge>}
      </div>
      <p className="text-2xl font-bold text-gray-800 dark:text-white">
        {usedText} <span className="text-sm font-semibold text-gray-500 dark:text-gray-400">de {limitText}</span>
      </p>
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
      {noteLine}
    </div>
  );
}
