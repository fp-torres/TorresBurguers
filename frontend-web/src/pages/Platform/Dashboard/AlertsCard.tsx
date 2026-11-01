import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertOctagon, AlertTriangle, ArrowRight, BellRing, Info, ShieldCheck } from 'lucide-react';
import { CARD_CLASS, EmptyState, FilterTabs, StatusBadge, buttonClass, cx, type FilterTabOption } from '../../../components/ui';
import { ALERT_SEVERITIES, type AlertSeverity, type PlatformAlert } from '../../../services/platform/dashboardService';
import { ALERT_SEVERITY_META, alertTypeLabel } from './alertMeta';

type SeverityFilter = 'all' | AlertSeverity;

/** Alertas visíveis antes de "Mostrar todos". */
const COLLAPSED_COUNT = 8;

const SEVERITY_ICON: Record<AlertSeverity, ReactNode> = {
  critical: <AlertOctagon size={14} />,
  warning: <AlertTriangle size={14} />,
  info: <Info size={14} />,
};

const SEVERITY_RING: Record<AlertSeverity, string> = {
  critical: 'border-red-200 dark:border-red-900/70 bg-red-50/60 dark:bg-red-900/10',
  warning: 'border-amber-200 dark:border-amber-900/70 bg-amber-50/60 dark:bg-amber-900/10',
  info: 'border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800',
};

interface AlertsCardProps {
  alerts: PlatformAlert[];
  /** Dados de antes de uma atualização em andamento. */
  stale?: boolean;
  className?: string;
}

/**
 * Alertas da plataforma (GET /platform/dashboard → alerts), na ordem da API (gravidade, tipo e loja):
 * inadimplência terminando, suspensões, estornos pendentes, faturas recusadas, lojas sem administrador,
 * testes terminando e pagamento online sem credencial. Cada alerta leva ao estabelecimento.
 */
export default function AlertsCard({ alerts, stale = false, className }: AlertsCardProps) {
  const titleId = useId();
  const [filter, setFilter] = useState<SeverityFilter>('all');
  const [expanded, setExpanded] = useState(false);

  const counts = Object.fromEntries(
    ALERT_SEVERITIES.map((severity) => [severity, alerts.filter((alert) => alert.severity === severity).length]),
  ) as Record<AlertSeverity, number>;
  const filtered = filter === 'all' ? alerts : alerts.filter((alert) => alert.severity === filter);
  const visible = expanded ? filtered : filtered.slice(0, COLLAPSED_COUNT);
  const hidden = filtered.length - visible.length;

  const tabs: FilterTabOption<SeverityFilter>[] = [
    { value: 'all', label: 'Todos', count: alerts.length },
    ...ALERT_SEVERITIES.map((severity) => ({
      value: severity,
      label: ALERT_SEVERITY_META[severity].plural,
      count: counts[severity],
      icon: SEVERITY_ICON[severity],
    })),
  ];

  return (
    <section aria-labelledby={titleId} className={cx(CARD_CLASS, 'p-5 sm:p-6 min-w-0', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={titleId} className="text-lg font-bold text-gray-800 dark:text-white flex items-center gap-2">
            <BellRing size={20} className="text-orange-600 dark:text-orange-400" aria-hidden="true" />
            Alertas
            {alerts.length > 0 && <span className="text-sm font-semibold text-gray-500 dark:text-gray-400 tabular-nums">({alerts.length})</span>}
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Situações que pedem ação, das mais graves às informativas. Cada alerta leva ao estabelecimento.
          </p>
        </div>
      </div>

      {alerts.length === 0 ? (
        <EmptyState
          compact
          icon={<ShieldCheck size={28} />}
          title="Nenhum alerta no momento"
          description="Inadimplência perto da suspensão, assinaturas suspensas, estornos pendentes, faturas recusadas, lojas sem administrador, testes terminando e pagamento online sem credencial aparecem aqui."
        />
      ) : (
        <div className={cx('mt-3 transition-opacity', stale && 'opacity-60')}>
          <FilterTabs
            options={tabs}
            value={filter}
            onChange={(next) => {
              setFilter(next);
              setExpanded(false);
            }}
            label="Filtrar alertas por gravidade"
            className="-mx-2"
          />

          {filtered.length === 0 ? (
            <p className="px-1 py-6 text-sm text-center text-gray-500 dark:text-gray-400">Nenhum alerta com essa gravidade.</p>
          ) : (
            <ul className="mt-3 space-y-2.5" aria-label="Alertas da plataforma">
              {visible.map((alert, index) => {
                const meta = ALERT_SEVERITY_META[alert.severity];
                return (
                  <li
                    key={`${alert.type}-${alert.store?.id ?? 'global'}-${index}`}
                    className={cx('flex flex-col sm:flex-row sm:items-start gap-3 p-3.5 rounded-xl border', SEVERITY_RING[alert.severity])}
                  >
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge tone={meta.tone} icon={SEVERITY_ICON[alert.severity]}>{meta.label}</StatusBadge>
                        <p className="text-sm font-bold text-gray-800 dark:text-white">{alertTypeLabel(alert.type)}</p>
                      </div>
                      {alert.store && (
                        <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">{alert.store.name}</p>
                      )}
                      <p className="text-sm text-gray-600 dark:text-gray-300">{alert.message}</p>
                    </div>
                    {alert.store && (
                      <Link
                        to={`/platform/stores/${alert.store.id}`}
                        className={buttonClass('secondary', 'sm', 'shrink-0 self-start')}
                        aria-label={`Abrir o estabelecimento ${alert.store.name}`}
                      >
                        Abrir loja <ArrowRight size={14} aria-hidden="true" />
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {(hidden > 0 || (expanded && filtered.length > COLLAPSED_COUNT)) && (
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                onClick={() => setExpanded((current) => !current)}
                aria-expanded={expanded}
                className={buttonClass('ghost', 'sm')}
              >
                {expanded ? 'Mostrar menos' : `Mostrar todos os ${filtered.length} alertas`}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
