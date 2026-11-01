import { useState } from 'react';
import { BarChart3, Ban, CheckCircle2, Receipt, ShoppingBag, Wallet } from 'lucide-react';
import {
  CARD_CLASS, EmptyState, ErrorState, FilterTabs, FormField, StatCard, cx, fieldControlClass, type FilterTabOption,
} from '../../../components/ui';
import PageLoader from '../../../components/PageLoader';
import { platformStoresService, type PlatformStoreDetail } from '../../../services/platform/storesService';
import { formatCurrency, formatInteger } from '../../../utils/format';
import { orderStatusLabel, paymentMethodLabel } from '../../../utils/orders';
import { useResource } from '../../../hooks/useResource';
import { useNow } from '../../../hooks/useNow';
import { DailyGmvChart, DailyOrdersChart } from './MetricsCharts';
import { ChartCard, ChartDataDetails } from '../../../components/charts';
import { addDaysToKey, daysInRange, formatDateKey, isDateKey, monthStartKey, todayKeyInZone, weekdayOfKey } from '../../../utils/dates';

type Preset = '7' | '30' | '90' | 'month' | 'custom';

const PRESETS: FilterTabOption<Preset>[] = [
  { value: '7', label: '7 dias' },
  { value: '30', label: '30 dias' },
  { value: '90', label: '90 dias' },
  { value: 'month', label: 'Este mês' },
  { value: 'custom', label: 'Personalizado' },
];

/** Período máximo do relatório na API. */
const MAX_DAYS = 366;

/**
 * Métricas da loja (GET /platform/stores/:id/metrics?from&to): pedidos e GMV por dia no calendário da loja, por
 * situação e por forma de pagamento. GMV = vendas pagas da loja (nunca receita da plataforma).
 */
export default function MetricsTab({ store }: { store: PlatformStoreDetail }) {
  const now = useNow(5 * 60_000);
  const today = todayKeyInZone(now, store.time_zone);
  const [preset, setPreset] = useState<Preset>('30');
  const [customFrom, setCustomFrom] = useState(() => addDaysToKey(today, -29));
  const [customTo, setCustomTo] = useState(today);

  let range: { from: string; to: string } | null;
  let rangeError: string | null = null;
  if (preset === 'custom') {
    const days = isDateKey(customFrom) && isDateKey(customTo) ? daysInRange(customFrom, customTo) : null;
    if (days === null) rangeError = 'Informe as duas datas.';
    else if (days < 1) rangeError = 'A data inicial não pode ser depois da final.';
    else if (days > MAX_DAYS) rangeError = `O período pode ter no máximo ${MAX_DAYS} dias.`;
    range = rangeError ? null : { from: customFrom, to: customTo };
  } else if (preset === 'month') {
    range = { from: monthStartKey(today), to: today };
  } else {
    range = { from: addDaysToKey(today, -(Number(preset) - 1)), to: today };
  }

  const report = useResource(
    (signal) => platformStoresService.metrics(store.id, range ?? {}, signal),
    { key: range ? `${range.from}:${range.to}` : 'invalid', enabled: range !== null, errorMessage: 'Não foi possível carregar as métricas.' },
  );
  const data = report.data;

  return (
    <div className="space-y-6">
      <h2 className="sr-only">Métricas de vendas</h2>
      <div className={cx(CARD_CLASS, 'p-4 sm:p-5 space-y-3')}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <FilterTabs label="Período das métricas" options={PRESETS} value={preset} onChange={setPreset} className="-mx-2" />
          {data && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {formatDateKey(data.period.from)} a {formatDateKey(data.period.to)} · {data.period.days} dia{data.period.days === 1 ? '' : 's'} · fuso {data.period.time_zone || store.time_zone}
            </p>
          )}
        </div>
        {preset === 'custom' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:max-w-xl gap-3">
            <FormField label="De" error={rangeError ?? undefined}>
              {(field) => <input {...field} type="date" value={customFrom} max={customTo || undefined} onChange={(event) => setCustomFrom(event.target.value)} className={fieldControlClass(!!rangeError)} />}
            </FormField>
            <FormField label="Até">
              {(field) => <input {...field} type="date" value={customTo} min={customFrom || undefined} onChange={(event) => setCustomTo(event.target.value)} className={fieldControlClass(!!rangeError)} />}
            </FormField>
          </div>
        )}
      </div>

      {!data ? (
        report.error ? (
          <div className={CARD_CLASS}>
            <ErrorState message={report.error} onRetry={() => void report.reload()} retrying={report.loading} compact />
          </div>
        ) : range ? <PageLoader /> : null
      ) : (
        <div className={cx('space-y-6 transition-opacity', report.loading && 'opacity-60')} aria-busy={report.loading || undefined}>
          {report.error && (
            <p role="alert" className="px-4 py-3 rounded-2xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
              {report.error} Os dados abaixo são do período anterior.
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
            <StatCard label="Pedidos no período" value={formatInteger(data.summary.orders)} icon={<ShoppingBag size={22} />} tone="blue" hint="Todos os feitos no período" />
            <StatCard label="Pedidos pagos" value={formatInteger(data.summary.paid_orders)} icon={<CheckCircle2 size={22} />} tone="emerald" hint="Pagos e não cancelados" />
            <StatCard label="Cancelados" value={formatInteger(data.summary.canceled_orders)} icon={<Ban size={22} />} tone="red" hint="Feitos no período e cancelados" />
            <StatCard label="GMV da loja" value={formatCurrency(data.summary.gmv)} icon={<Wallet size={22} />} tone="violet" hint="Vendas da loja, não receita da plataforma" />
            <StatCard label="Ticket médio" value={formatCurrency(data.summary.average_ticket)} icon={<Receipt size={22} />} tone="orange" hint="GMV ÷ pedidos pagos" />
          </div>

          {data.summary.orders === 0 ? (
            <div className={CARD_CLASS}>
              <EmptyState
                icon={<BarChart3 size={32} />}
                title="Nenhum pedido neste período"
                description="Escolha outro período para ver a evolução diária, as situações e as formas de pagamento."
              />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 2xl:grid-cols-2 gap-6">
                <ChartCard title="Pedidos por dia" description="Pedidos não cancelados, por dia do calendário da loja.">
                  <DailyOrdersChart data={data.daily} stale={report.loading} />
                </ChartCard>
                <ChartCard title="GMV por dia" description="Pedidos pagos e não cancelados (R$), por dia do calendário da loja.">
                  <DailyGmvChart data={data.daily} stale={report.loading} />
                </ChartCard>
              </div>
              <div className={cx(CARD_CLASS, 'px-5 pb-4 pt-1')}>
                <ChartDataDetails
                  caption={`Pedidos e GMV por dia de ${store.name}`}
                  summary="Ver dados por dia em tabela"
                  columns={['Dia', 'Pedidos', 'Pagos', 'GMV']}
                  rows={data.daily.map((day) => [
                    `${weekdayOfKey(day.date)} ${formatDateKey(day.date)}`,
                    formatInteger(day.orders),
                    formatInteger(day.paid_orders),
                    formatCurrency(day.gmv),
                  ])}
                />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <ChartCard title="Pedidos por situação" description="Todos os pedidos feitos no período.">
                  <table className="w-full text-sm">
                    <caption className="sr-only">Pedidos por situação</caption>
                    <thead className="text-xs text-gray-500 dark:text-gray-400">
                      <tr>
                        <th scope="col" className="text-left font-semibold pb-2">Situação</th>
                        <th scope="col" className="text-right font-semibold pb-2">Pedidos</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-slate-700 text-gray-700 dark:text-gray-200">
                      {data.by_status.map((item) => (
                        <tr key={item.status}>
                          <th scope="row" className="text-left font-normal py-2">{orderStatusLabel(item.status)}</th>
                          <td className="text-right tabular-nums font-semibold py-2">{formatInteger(item.count)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ChartCard>
                <ChartCard title="Por forma de pagamento" description="Pedidos não cancelados; GMV só dos pagos.">
                  {data.by_payment_method.length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400">Nenhum pedido não cancelado no período.</p>
                  ) : (
                    <div className="overflow-x-auto custom-scrollbar">
                      <table className="w-full text-sm">
                        <caption className="sr-only">Pedidos e GMV por forma de pagamento</caption>
                        <thead className="text-xs text-gray-500 dark:text-gray-400">
                          <tr>
                            <th scope="col" className="text-left font-semibold pb-2">Forma</th>
                            <th scope="col" className="text-right font-semibold pb-2">Pedidos</th>
                            <th scope="col" className="text-right font-semibold pb-2">Pagos</th>
                            <th scope="col" className="text-right font-semibold pb-2">GMV</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-slate-700 text-gray-700 dark:text-gray-200">
                          {data.by_payment_method.map((item) => (
                            <tr key={item.method}>
                              <th scope="row" className="text-left font-normal py-2">{paymentMethodLabel(item.method)}</th>
                              <td className="text-right tabular-nums py-2">{formatInteger(item.orders)}</td>
                              <td className="text-right tabular-nums py-2">{formatInteger(item.paid_orders)}</td>
                              <td className="text-right tabular-nums font-semibold py-2 whitespace-nowrap">{formatCurrency(item.gmv)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </ChartCard>
              </div>
            </>
          )}

          {data.methodology && <p className="text-xs text-gray-500 dark:text-gray-400">{data.methodology}</p>}
        </div>
      )}
    </div>
  );
}
