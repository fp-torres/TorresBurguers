import { useId, useState, type FormEvent } from 'react';
import { CalendarRange, CreditCard, ListChecks, Loader2, ShoppingBag, TrendingUp } from 'lucide-react';
import { CARD_CLASS, ErrorState, FilterTabs, buttonClass, cx, fieldControlClass, type FilterTabOption } from '../../components/ui';
import { orderService, type OrdersReport } from '../../services/orderService';
import { usePanelStore } from '../../layouts/DefaultLayout/panelStore';
import { useResource } from '../../hooks/useResource';
import { addDaysToKey, daysInRange, formatDateKey, isDateKey, shortDateKey, todayKeyInZone } from '../../utils/dates';
import { useNow } from '../../hooks/useNow';
import { paymentMethodLabel } from '../../utils/orders';
import { formatCurrency, formatCompactCurrency, formatInteger } from '../../utils/format';
import FeatureLockedCard from './FeatureLockedCard';
import { AreaTrendChart, HorizontalBars } from './charts';
import { ChartCard, ChartDataDetails } from '../../components/charts';

/** Máximo aceito pela API (GET /orders/reports). */
const MAX_REPORT_DAYS = 366;

type Preset = '7' | '30' | '90' | 'month' | 'custom';

const PRESETS: FilterTabOption<Preset>[] = [
  { value: '7', label: '7 dias' },
  { value: '30', label: '30 dias' },
  { value: '90', label: '90 dias' },
  { value: 'month', label: 'Este mês' },
  { value: 'custom', label: 'Personalizado' },
];

/** Nomes dos status no relatório (o "pronto" vale para balcão e entrega). */
const REPORT_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Novos',
  PREPARING: 'Em preparo',
  READY_FOR_PICKUP: 'Prontos',
  DELIVERING: 'Em entrega',
  DONE: 'Concluídos',
  CANCELED: 'Cancelados',
};

interface Range {
  from: string;
  to: string;
}

function presetRange(preset: Exclude<Preset, 'custom'>, today: string): Range {
  if (preset === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
  return { from: addDaysToKey(today, -(Number(preset) - 1)), to: today };
}

function rangeError(range: Range): string | null {
  if (!isDateKey(range.from) || !isDateKey(range.to)) return 'Informe as duas datas.';
  const days = daysInRange(range.from, range.to);
  if (days === null || days < 1) return 'A data inicial não pode ser depois da data final.';
  if (days > MAX_REPORT_DAYS) return `O período pode ter no máximo ${MAX_REPORT_DAYS} dias.`;
  return null;
}

/**
 * Relatórios de vendas do período (GET /orders/reports?from&to, no calendário da loja): faturamento por
 * dia, situação dos pedidos, formas de pagamento, ticket médio e produtos mais vendidos.
 */
export default function ReportsSection() {
  const { timeZone } = usePanelStore();
  const now = useNow(60_000);
  const today = todayKeyInZone(now, timeZone);
  const fromId = useId();
  const toId = useId();
  const errorId = useId();

  const [preset, setPreset] = useState<Preset>('30');
  // null = período padrão da API (últimos 30 dias até hoje no fuso da loja)
  const [range, setRange] = useState<Range | null>(null);
  const [customDraft, setCustomDraft] = useState<Range>({ from: '', to: '' });
  const [customError, setCustomError] = useState<string | null>(null);

  const report = useResource((signal) => orderService.getReports(range ?? {}, signal), {
    key: range ? `${range.from}_${range.to}` : 'padrao',
    errorMessage: 'Não foi possível carregar o relatório.',
  });

  function choosePreset(next: Preset) {
    setPreset(next);
    setCustomError(null);
    if (next === 'custom') {
      const period = report.data?.period;
      setCustomDraft(period?.from && period.to ? { from: period.from, to: period.to } : presetRange('30', today));
      return;
    }
    setRange(next === '30' ? null : presetRange(next, today));
  }

  function applyCustom(event: FormEvent) {
    event.preventDefault();
    const error = rangeError(customDraft);
    setCustomError(error);
    if (!error) setRange({ ...customDraft });
  }

  if (report.errorStatus === 403 && !report.data) {
    return <FeatureLockedCard message={report.error} />;
  }

  const data = report.data;
  const period = data?.period;

  return (
    <section aria-labelledby="reports-title" className="space-y-4">
      <div className={cx(CARD_CLASS, 'p-5 sm:p-6 space-y-4')}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="reports-title" className="text-lg font-bold text-gray-800 dark:text-white flex items-center gap-2">
              <CalendarRange size={20} className="text-orange-600 dark:text-orange-400" aria-hidden="true" /> Relatórios de vendas
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400" aria-live="polite">
              {period?.from && period.to
                ? <>De {formatDateKey(period.from)} a {formatDateKey(period.to)} ({period.days} {period.days === 1 ? 'dia' : 'dias'}){period.timeZone ? `, no fuso ${period.timeZone}` : ''}.</>
                : 'Faturamento conta só pedidos pagos e não cancelados.'}
            </p>
          </div>
          {report.loading && data && (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400" role="status">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Atualizando...
            </span>
          )}
        </div>

        <FilterTabs options={PRESETS} value={preset} onChange={choosePreset} label="Período do relatório" className="p-0" />

        {preset === 'custom' && (
          <form onSubmit={applyCustom} noValidate className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="space-y-1.5">
              <label htmlFor={fromId} className="block text-xs font-bold uppercase tracking-wide text-gray-700 dark:text-gray-300">De</label>
              <input
                id={fromId}
                type="date"
                value={customDraft.from}
                max={today}
                onChange={(event) => {
                  const from = event.target.value;
                  setCustomDraft((current) => ({ ...current, from }));
                }}
                aria-invalid={customError ? true : undefined}
                aria-describedby={customError ? errorId : undefined}
                className={fieldControlClass(!!customError, 'sm:w-44')}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={toId} className="block text-xs font-bold uppercase tracking-wide text-gray-700 dark:text-gray-300">Até</label>
              <input
                id={toId}
                type="date"
                value={customDraft.to}
                onChange={(event) => {
                  const to = event.target.value;
                  setCustomDraft((current) => ({ ...current, to }));
                }}
                aria-invalid={customError ? true : undefined}
                aria-describedby={customError ? errorId : undefined}
                className={fieldControlClass(!!customError, 'sm:w-44')}
              />
            </div>
            <button type="submit" className={buttonClass('primary')}>Aplicar</button>
            {customError && <p id={errorId} role="alert" className="text-xs font-semibold text-red-600 dark:text-red-400 sm:self-center">{customError}</p>}
          </form>
        )}
      </div>

      {!data ? (
        report.error ? (
          <div className={CARD_CLASS}>
            <ErrorState message={report.error} onRetry={() => void report.reload()} retrying={report.loading} />
          </div>
        ) : (
          <div className={cx(CARD_CLASS, 'p-10 flex justify-center')} role="status">
            <Loader2 className="animate-spin text-orange-600" size={28} aria-hidden="true" />
            <span className="sr-only">Carregando o relatório...</span>
          </div>
        )
      ) : (
        <ReportBody data={data} stale={report.stale} error={report.error} onRetry={() => void report.reload()} />
      )}
    </section>
  );
}

interface ReportBodyProps {
  data: OrdersReport;
  stale: boolean;
  error: string | null;
  onRetry: () => void;
}

function ReportBody({ data, stale, error, onRetry }: ReportBodyProps) {
  const { summary } = data;
  const hasOrders = summary.orders > 0;

  const tiles = [
    { label: 'Faturamento', value: formatCurrency(summary.revenue), hint: 'Pagos e não cancelados' },
    { label: 'Ticket médio', value: formatCurrency(summary.averageTicket), hint: 'Faturamento ÷ pedidos pagos' },
    { label: 'Pedidos no período', value: formatInteger(summary.orders), hint: `${formatInteger(summary.paidOrders)} pagos` },
    { label: 'Cancelados', value: formatInteger(summary.canceledOrders), hint: hasOrders ? `${Math.round((summary.canceledOrders / summary.orders) * 100)}% dos pedidos` : 'Nenhum pedido' },
  ];

  const revenueByDay = data.revenueByDay.map((day) => ({ key: day.date, value: day.revenue }));
  const byStatus = data.ordersByStatus.map((item) => ({ key: item.status, value: item.count }));
  const byPayment = data.paymentMethods.map((item) => ({ key: item.method, value: item.revenue }));
  const topProducts = data.topProducts.map((item) => ({ key: item.name, value: item.quantity }));

  return (
    <div className={cx('space-y-4 transition-opacity', stale && 'opacity-70')}>
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-2xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
          <span className="flex-1 min-w-48">{error} Os números abaixo são do período anterior.</span>
          <button type="button" onClick={onRetry} className="font-bold hover:underline">Tentar novamente</button>
        </div>
      )}

      <dl className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {tiles.map((tile) => (
          <div key={tile.label} className={cx(CARD_CLASS, 'p-4 sm:p-5')}>
            <dt className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">{tile.label}</dt>
            <dd className="mt-1 text-xl sm:text-2xl font-bold text-gray-800 dark:text-white wrap-break-word">{tile.value}</dd>
            <dd className="mt-1 text-xs text-gray-500 dark:text-gray-400">{tile.hint}</dd>
          </div>
        ))}
      </dl>

      <ChartCard
        title="Faturamento por dia"
        icon={<TrendingUp size={20} className="text-blue-600 dark:text-blue-400" />}
        description="Soma dos pedidos pagos e não cancelados de cada dia (dias sem vendas aparecem zerados)."
      >
        <AreaTrendChart
          data={revenueByDay}
          name="Faturamento"
          formatValue={formatCurrency}
          formatAxisValue={formatCompactCurrency}
          formatLabel={shortDateKey}
          stale={stale}
        />
        <ChartDataDetails
          caption="Faturamento por dia"
          columns={['Dia', 'Pedidos', 'Pagos', 'Faturamento']}
          rows={data.revenueByDay.map((day) => [formatDateKey(day.date), formatInteger(day.orders), formatInteger(day.paidOrders), formatCurrency(day.revenue)])}
        />
      </ChartCard>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <ChartCard
          title="Pedidos por situação"
          icon={<ListChecks size={20} className="text-blue-600 dark:text-blue-400" />}
          description="Todos os pedidos feitos no período."
        >
          <HorizontalBars
            data={hasOrders ? byStatus : []}
            name="Pedidos"
            formatValue={formatInteger}
            formatLabel={(status) => REPORT_STATUS_LABELS[status] ?? status}
            emptyTitle="Nenhum pedido no período"
            stale={stale}
          />
          {hasOrders && (
            <ChartDataDetails
              caption="Pedidos por situação"
              columns={['Situação', 'Pedidos']}
              rows={data.ordersByStatus.map((item) => [REPORT_STATUS_LABELS[item.status] ?? item.status, formatInteger(item.count)])}
            />
          )}
        </ChartCard>

        <ChartCard
          title="Formas de pagamento"
          icon={<CreditCard size={20} className="text-blue-600 dark:text-blue-400" />}
          description="Faturamento por forma de pagamento (pedidos não cancelados)."
        >
          <HorizontalBars
            data={byPayment}
            name="Faturamento"
            formatValue={formatCurrency}
            formatLabel={paymentMethodLabel}
            labelWidth={140}
            emptyTitle="Nenhuma venda no período"
            stale={stale}
          />
          {byPayment.length > 0 && (
            <ChartDataDetails
              caption="Formas de pagamento"
              columns={['Forma de pagamento', 'Pedidos', 'Pagos', 'Faturamento']}
              rows={data.paymentMethods.map((item) => [paymentMethodLabel(item.method), formatInteger(item.orders), formatInteger(item.paidOrders), formatCurrency(item.revenue)])}
            />
          )}
        </ChartCard>
      </div>

      <ChartCard
        title="Produtos mais vendidos"
        icon={<ShoppingBag size={20} className="text-blue-600 dark:text-blue-400" />}
        description="Quantidade vendida no período (até 10 produtos; pedidos não cancelados)."
      >
        <HorizontalBars
          data={topProducts}
          name="Quantidade"
          formatValue={(value) => `${formatInteger(value)} un.`}
          labelWidth={180}
          emptyTitle="Nenhum produto vendido no período"
          stale={stale}
        />
        {topProducts.length > 0 && (
          <ChartDataDetails
            caption="Produtos mais vendidos"
            columns={['Produto', 'Quantidade']}
            rows={data.topProducts.map((item) => [item.name, formatInteger(item.quantity)])}
          />
        )}
      </ChartCard>
    </div>
  );
}
