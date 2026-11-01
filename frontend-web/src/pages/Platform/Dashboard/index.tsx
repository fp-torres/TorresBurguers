import { useId } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@iconify/react';
import {
  AlertTriangle, BadgePercent, CalendarRange, Layers, Loader2, Receipt, RefreshCw, ShoppingBag, Store, TrendingDown, TrendingUp, Wallet,
} from 'lucide-react';
import { CARD_CLASS, EmptyState, ErrorState, PageHeader, StatCard, buttonClass, cx } from '../../../components/ui';
import { useAuth } from '../../../contexts/AuthContext';
import { usePolling } from '../../../hooks/usePolling';
import { useResource } from '../../../hooks/useResource';
import {
  CURRENT_SUBSCRIPTION_STATUSES, platformDashboardService, type ChurnMonth, type PlatformDashboard,
} from '../../../services/platform/dashboardService';
import { SUBSCRIPTION_STATUS } from '../../../utils/saasStatus';
import { formatCurrency, formatDateTime, formatCompactCurrency, formatCompactNumber, formatInteger } from '../../../utils/format';
import AlertsCard from './AlertsCard';
import MethodologyButton from './MethodologyButton';
import { MonthlyColumnChart, RankedBars, SectionHeading, SeriesKey, SeriesSwatch } from './charts';
import { ChartCard, ChartDataDetails, SERIES_LABEL } from '../../../components/charts';
import { formatRate, monthLong, monthShort, plural } from './insightsFormat';

/** Atualização automática dos indicadores (pausa com a aba oculta). */
const REFRESH_INTERVAL_MS = 60_000;

const BILLING_INTERVAL_LABELS: Record<string, string> = { MONTHLY: 'mensal', YEARLY: 'anual' };

/** Último mês fechado do churn (o mês atual é parcial); sem meses fechados, o mais recente. */
function latestChurnMonth(months: ChurnMonth[]): ChurnMonth | null {
  const complete = months.filter((month) => !month.partial);
  return complete[complete.length - 1] ?? months[months.length - 1] ?? null;
}

/**
 * Superpainel › Dashboard (/platform): GET /platform/dashboard com atualização automática. Indicadores da
 * Comestra (lojas, assinaturas, MRR, ARR como projeção, churn e receita SaaS) separados do movimento das
 * lojas (pedidos e GMV), alertas com link para a loja e a evolução dos últimos 12 meses. Metodologia de cada
 * número: a que a API devolve (docs/saas/arquitetura.md §6). Sem dados, o vazio é explicado — nunca estimado.
 */
export default function PlatformDashboard() {
  const { user } = useAuth();
  const firstName = user?.name.split(' ')[0] || 'operador';

  const resource = useResource((signal) => platformDashboardService.get(signal), {
    errorMessage: 'Não foi possível carregar os indicadores da plataforma.',
  });
  usePolling(() => resource.reload({ silent: true }), REFRESH_INTERVAL_MS);
  const data = resource.data;

  const header = (
    <PageHeader
      title="Dashboard da plataforma"
      subtitle={`Olá, ${firstName}. Visão geral dos estabelecimentos, assinaturas e receita.`}
      icon={<Icon icon="solar:widget-5-bold-duotone" width={26} />}
      actions={(
        // Só a atualização pedida desabilita o botão; a automática (silenciosa) apenas gira o ícone
        <button type="button" onClick={() => void resource.reload()} disabled={resource.loading} className={buttonClass('secondary')}>
          {resource.loading || resource.refreshing
            ? <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            : <RefreshCw size={16} aria-hidden="true" />}
          {resource.loading ? 'Atualizando...' : 'Atualizar'}
        </button>
      )}
    >
      {data && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Dados de {formatDateTime(data.generated_at)}
          {data.time_zone && <> · meses no fuso {data.time_zone}</>}
          {' '}· atualização automática a cada minuto.
        </p>
      )}
    </PageHeader>
  );

  if (!data) {
    return (
      <div className="space-y-6 pb-20">
        {header}
        {resource.error ? (
          <div className={CARD_CLASS}>
            <ErrorState message={resource.error} onRetry={() => void resource.reload()} retrying={resource.loading} />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4" aria-busy="true">
            {['Lojas', 'Assinaturas vigentes', 'MRR', 'ARR (projeção)', 'Churn mensal', 'Receita da Comestra', 'Pedidos processados', 'Volume das lojas (GMV)'].map((label) => (
              <StatCard key={label} label={label} value="" loading />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-8 pb-20">
      {header}

      {resource.error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-2xl text-sm bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
          <AlertTriangle size={18} className="shrink-0" aria-hidden="true" />
          <span className="flex-1 min-w-48">{resource.error} Os indicadores abaixo podem estar desatualizados.</span>
          <button type="button" onClick={() => void resource.reload()} className="font-bold hover:underline">Tentar novamente</button>
        </div>
      )}

      <DashboardContent data={data} stale={resource.loading} />
    </div>
  );
}

function DashboardContent({ data, stale }: { data: PlatformDashboard; stale: boolean }) {
  const platformId = useId();
  const storesId = useId();
  const trendsId = useId();

  const { stores, subscriptions, mrr, arr, churn, orders, gmv, platform_revenue: revenue } = data;
  const churnMonth = latestChurnMonth(churn.months);

  const revenueSeries = revenue.by_month.map((row) => ({ month: row.month, value: row.amount }));
  const gmvSeries = gmv.by_month.map((row) => ({ month: row.month, value: row.amount }));
  const ordersSeries = orders.by_month.map((row) => ({ month: row.month, value: row.count }));
  const newStoresSeries = stores.new_by_month.map((row) => ({ month: row.month, value: row.count }));
  const invoicesByMonth = new Map(revenue.by_month.map((row) => [row.month, row.invoices]));
  const paidOrdersByMonth = new Map(gmv.by_month.map((row) => [row.month, row.paid_orders]));
  const allZero = (series: { value: number }[]) => series.every((point) => point.value === 0);

  const subscriptionSummary = [
    `${formatInteger(subscriptions.by_status.TRIALING)} em teste`,
    `${formatInteger(subscriptions.by_status.ACTIVE)} ativas`,
    `${formatInteger(subscriptions.by_status.PAST_DUE)} inadimplentes`,
    `${formatInteger(subscriptions.by_status.SUSPENDED)} suspensas`,
  ].join(' · ');

  const churnHint = !churnMonth
    ? 'Sem histórico de assinaturas para calcular.'
    : churnMonth.rate === null
      ? `${monthLong(churnMonth.month)}: ${churnMonth.note ?? 'sem assinaturas pagantes no início do mês, a taxa não se aplica.'}`
      : `${formatInteger(churnMonth.canceled)} de ${plural(churnMonth.paying_at_start, 'pagante', 'pagantes')} cancelaram em ${monthLong(churnMonth.month)}${churnMonth.partial ? ' (mês em andamento)' : ''}.`;

  const churnTable = churn.months.length > 0 && (
    <table className="w-full text-xs">
      <caption className="sr-only">Churn mensal de lojas nos últimos meses</caption>
      <thead className="text-gray-500 dark:text-gray-400">
        <tr className="border-b border-gray-100 dark:border-slate-700">
          <th scope="col" className="py-2 pr-3 text-left font-semibold">Mês</th>
          <th scope="col" className="py-2 px-3 text-right font-semibold">Pagantes no início</th>
          <th scope="col" className="py-2 px-3 text-right font-semibold">Canceladas</th>
          <th scope="col" className="py-2 pl-3 text-right font-semibold">Churn</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100 dark:divide-slate-700 text-gray-700 dark:text-gray-200">
        {[...churn.months].reverse().map((month) => (
          <tr key={month.month}>
            <th scope="row" className="py-2 pr-3 text-left font-normal whitespace-nowrap">
              {monthLong(month.month)}
              {month.partial && <span className="ml-1 text-gray-500 dark:text-gray-400">(parcial)</span>}
            </th>
            <td className="py-2 px-3 text-right tabular-nums">{formatInteger(month.paying_at_start)}</td>
            <td className="py-2 px-3 text-right tabular-nums">{formatInteger(month.canceled)}</td>
            <td className="py-2 pl-3 text-right tabular-nums font-bold" title={month.note ?? undefined}>
              {formatRate(month.rate)}
              {month.rate === null && <span className="sr-only"> ({month.note ?? 'não se aplica'})</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const plansTotal = data.plans.reduce((sum, item) => sum + item.subscriptions, 0);

  return (
    <>
      {/* Comestra: base de lojas, assinaturas e receita SaaS */}
      <section aria-labelledby={platformId} className="space-y-4">
        <SectionHeading
          id={platformId}
          title="Comestra: lojas, assinaturas e receita"
          description="Base de estabelecimentos e a receita da plataforma com as assinaturas SaaS."
          aside={<SeriesKey tone="platform">{SERIES_LABEL.platform}</SeriesKey>}
        />
        <div className={cx('grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 transition-opacity', stale && 'opacity-60')}>
          <StatCard
            label="Lojas"
            value={formatInteger(stores.total)}
            icon={<Store size={22} />}
            tone="slate"
            hint={`${formatInteger(stores.by_status.ACTIVE)} ativas · ${formatInteger(stores.by_status.SUSPENDED)} suspensas · ${formatInteger(stores.by_status.INACTIVE)} desativadas`}
          />
          <StatCard
            label="Assinaturas vigentes"
            value={formatInteger(subscriptions.current)}
            icon={<Layers size={22} />}
            tone="violet"
            hint={<>{subscriptionSummary}. {plural(subscriptions.by_status.CANCELED, 'cancelada', 'canceladas')} no histórico.</>}
          />
          <StatCard
            label="MRR"
            value={formatCurrency(mrr.value)}
            icon={<Wallet size={22} />}
            tone="blue"
            hint={(
              <>
                {mrr.has_paid_subscriptions
                  ? `Receita recorrente mensal de ${plural(mrr.paying_subscriptions, 'assinatura pagante', 'assinaturas pagantes')}.`
                  : mrr.note ?? 'Nenhuma assinatura de plano pago ativa ou em atraso.'}{' '}
                <MethodologyButton metric="MRR" methodology={mrr.methodology} note={mrr.has_paid_subscriptions ? null : mrr.note} />
              </>
            )}
          />
          <StatCard
            label="ARR (projeção)"
            value={formatCurrency(arr.value)}
            icon={<TrendingUp size={22} />}
            tone="blue"
            hint={(
              <>
                {arr.label}: projeção, não é receita realizada.{' '}
                <MethodologyButton metric="ARR (projeção)" methodology={arr.methodology} />
              </>
            )}
          />
          <StatCard
            label={churnMonth ? `Churn mensal (${monthShort(churnMonth.month)})` : 'Churn mensal'}
            value={churnMonth ? formatRate(churnMonth.rate) : '—'}
            icon={<TrendingDown size={22} />}
            tone="amber"
            hint={(
              <>
                {churnHint}{' '}
                <MethodologyButton metric="Churn mensal de lojas" methodology={churn.methodology}>{churnTable}</MethodologyButton>
              </>
            )}
          />
          <StatCard
            label="Receita da Comestra"
            value={formatCurrency(revenue.total)}
            icon={<Receipt size={22} />}
            tone="emerald"
            hint={(
              <>
                {revenue.note ?? `${plural(revenue.paid_invoices, 'fatura de assinatura paga', 'faturas de assinatura pagas')}, desde o início.`}{' '}
                <MethodologyButton metric="Receita da Comestra" methodology={revenue.methodology} />
              </>
            )}
          />
        </div>
      </section>

      {/* Movimento das lojas: nunca somado à receita da Comestra */}
      <section aria-labelledby={storesId} className="space-y-4">
        <SectionHeading
          id={storesId}
          title="Movimento das lojas"
          description="Dinheiro dos consumidores para as lojas: não é receita da Comestra e nunca é somado a ela."
          aside={<SeriesKey tone="stores">{SERIES_LABEL.stores}</SeriesKey>}
        />
        <div className={cx('grid grid-cols-1 sm:grid-cols-2 gap-4 transition-opacity', stale && 'opacity-60')}>
          <StatCard
            label="Pedidos processados"
            value={formatInteger(orders.total)}
            icon={<ShoppingBag size={22} />}
            tone="orange"
            hint={(
              <>
                Pedidos de todas as lojas, exceto os cancelados, desde o início.{' '}
                <MethodologyButton metric="Pedidos processados" methodology={orders.methodology} />
              </>
            )}
          />
          <StatCard
            label="Volume das lojas (GMV)"
            value={formatCurrency(gmv.total)}
            icon={<BadgePercent size={22} />}
            tone="orange"
            hint={(
              <>
                {gmv.note ?? `${plural(gmv.paid_orders, 'pedido pago', 'pedidos pagos')} e não cancelados, desde o início.`}{' '}
                <MethodologyButton metric="Volume das lojas (GMV)" methodology={gmv.methodology} />
              </>
            )}
          />
        </div>
      </section>

      <AlertsCard alerts={data.alerts} stale={stale} />

      {/* Evolução nos últimos 12 meses */}
      <section aria-labelledby={trendsId} className="space-y-4">
        <SectionHeading
          id={trendsId}
          title="Evolução nos últimos 12 meses"
          description="Meses do calendário da plataforma; o mês atual ainda está em andamento."
          aside={revenueSeries.length > 0 ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400">
              <CalendarRange size={14} aria-hidden="true" />
              {monthLong(revenueSeries[0].month)} a {monthLong(revenueSeries[revenueSeries.length - 1].month)}
            </span>
          ) : undefined}
        />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ChartCard
            title="Receita da Comestra por mês"
            description="Faturas de assinatura pagas, pela data do pagamento."
            icon={<SeriesSwatch tone="platform" />}
            aside={<MethodologyButton metric="Receita da Comestra" methodology={revenue.methodology} variant="link" />}
          >
            {allZero(revenueSeries) ? (
              <EmptyState
                compact
                icon={<Receipt size={28} />}
                title="Nenhuma receita no período"
                description={revenue.note ?? 'Nenhuma fatura de assinatura foi paga nos últimos 12 meses.'}
              />
            ) : (
              <>
                <MonthlyColumnChart
                  data={revenueSeries}
                  name="Receita da Comestra"
                  tone="platform"
                  formatValue={formatCurrency}
                  formatAxis={formatCompactCurrency}
                  detail={(month) => plural(invoicesByMonth.get(month) ?? 0, 'fatura paga', 'faturas pagas')}
                  stale={stale}
                />
                <ChartDataDetails
                  caption="Receita da Comestra por mês"
                  columns={['Mês', 'Receita', 'Faturas pagas']}
                  rows={revenue.by_month.map((row) => [monthLong(row.month), formatCurrency(row.amount), formatInteger(row.invoices)])}
                />
              </>
            )}
          </ChartCard>

          <ChartCard
            title="Volume das lojas (GMV) por mês"
            description="Pedidos pagos e não cancelados de todas as lojas. Não é receita da Comestra."
            icon={<SeriesSwatch tone="stores" />}
            aside={<MethodologyButton metric="Volume das lojas (GMV)" methodology={gmv.methodology} variant="link" />}
          >
            {allZero(gmvSeries) ? (
              <EmptyState
                compact
                icon={<BadgePercent size={28} />}
                title="Nenhum pedido pago no período"
                description={gmv.note ?? 'Nenhum pedido pago nos últimos 12 meses: o volume das lojas é zero.'}
              />
            ) : (
              <>
                <MonthlyColumnChart
                  data={gmvSeries}
                  name="GMV das lojas"
                  tone="stores"
                  formatValue={formatCurrency}
                  formatAxis={formatCompactCurrency}
                  detail={(month) => plural(paidOrdersByMonth.get(month) ?? 0, 'pedido pago', 'pedidos pagos')}
                  stale={stale}
                />
                <ChartDataDetails
                  caption="Volume das lojas (GMV) por mês"
                  columns={['Mês', 'GMV', 'Pedidos pagos']}
                  rows={gmv.by_month.map((row) => [monthLong(row.month), formatCurrency(row.amount), formatInteger(row.paid_orders)])}
                />
              </>
            )}
          </ChartCard>

          <ChartCard
            title="Pedidos processados por mês"
            description="Pedidos de todas as lojas, exceto os cancelados, pela data de criação."
            icon={<SeriesSwatch tone="stores" />}
            aside={<MethodologyButton metric="Pedidos processados" methodology={orders.methodology} variant="link" />}
          >
            {allZero(ordersSeries) ? (
              <EmptyState
                compact
                icon={<ShoppingBag size={28} />}
                title="Nenhum pedido no período"
                description="Nenhuma loja recebeu pedidos (não cancelados) nos últimos 12 meses."
              />
            ) : (
              <>
                <MonthlyColumnChart
                  data={ordersSeries}
                  name="Pedidos"
                  tone="stores"
                  integer
                  formatValue={(value) => plural(value, 'pedido', 'pedidos')}
                  formatAxis={formatCompactNumber}
                  stale={stale}
                />
                <ChartDataDetails
                  caption="Pedidos processados por mês"
                  columns={['Mês', 'Pedidos']}
                  rows={orders.by_month.map((row) => [monthLong(row.month), formatInteger(row.count)])}
                />
              </>
            )}
          </ChartCard>

          <ChartCard
            title="Novas lojas por mês"
            description="Estabelecimentos cadastrados (superpainel ou autoatendimento), pela data de criação."
            icon={<SeriesSwatch tone="platform" />}
            aside={<Link to="/platform/stores" className="text-xs font-bold text-gray-500 dark:text-gray-400 hover:text-orange-600 dark:hover:text-orange-400 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">Ver lojas</Link>}
          >
            {allZero(newStoresSeries) ? (
              <EmptyState
                compact
                icon={<Store size={28} />}
                title="Nenhuma loja nova no período"
                description="Nenhum estabelecimento foi cadastrado nos últimos 12 meses."
              />
            ) : (
              <>
                <MonthlyColumnChart
                  data={newStoresSeries}
                  name="Novas lojas"
                  tone="platform"
                  integer
                  formatValue={(value) => plural(value, 'loja nova', 'lojas novas')}
                  formatAxis={formatCompactNumber}
                  stale={stale}
                />
                <ChartDataDetails
                  caption="Novas lojas por mês"
                  columns={['Mês', 'Novas lojas']}
                  rows={stores.new_by_month.map((row) => [monthLong(row.month), formatInteger(row.count)])}
                />
              </>
            )}
          </ChartCard>

          <ChartCard
            title="Distribuição por plano"
            description="Assinaturas vigentes (não canceladas) em cada plano, com o MRR de cada um."
            icon={<SeriesSwatch tone="platform" />}
            aside={<Link to="/platform/plans" className="text-xs font-bold text-gray-500 dark:text-gray-400 hover:text-orange-600 dark:hover:text-orange-400 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">Ver planos</Link>}
          >
            {data.plans.length === 0 || plansTotal === 0 ? (
              <EmptyState
                compact
                icon={<Layers size={28} />}
                title="Nenhuma assinatura vigente"
                description="Quando os estabelecimentos tiverem assinaturas (em teste, ativas, em atraso ou suspensas), a divisão por plano aparece aqui."
              />
            ) : (
              <div className={cx('transition-opacity', stale && 'opacity-60')}>
                <RankedBars
                  label="Assinaturas vigentes por plano"
                  tone="platform"
                  items={data.plans.map((item) => ({
                    key: item.plan.id,
                    label: item.plan.name,
                    value: item.subscriptions,
                    valueLabel: `${formatInteger(item.subscriptions)}${item.share !== null ? ` · ${formatRate(item.share)}` : ''}`,
                    detail: (
                      <>
                        {item.plan.price > 0
                          ? `${formatCurrency(item.plan.price)} ${BILLING_INTERVAL_LABELS[item.plan.billing_interval] ?? ''}`.trim()
                          : 'Gratuito'}
                        {' · '}{plural(item.paying_subscriptions, 'pagante', 'pagantes')}
                        {' · MRR '}{formatCurrency(item.mrr)}
                      </>
                    ),
                  }))}
                />
                <ChartDataDetails
                  caption="Assinaturas vigentes por plano e situação"
                  columns={['Plano', ...CURRENT_SUBSCRIPTION_STATUSES.map((status) => SUBSCRIPTION_STATUS[status].label), 'Total', 'MRR']}
                  rows={data.plans.map((item) => [
                    item.plan.name,
                    ...CURRENT_SUBSCRIPTION_STATUSES.map((status) => formatInteger(item.by_status[status])),
                    formatInteger(item.subscriptions),
                    formatCurrency(item.mrr),
                  ])}
                />
              </div>
            )}
          </ChartCard>

          <ChartCard
            title="Churn mensal de lojas"
            description="Assinaturas pagantes canceladas no mês ÷ pagantes no início do mês."
            icon={<TrendingDown size={18} className="text-amber-600 dark:text-amber-400" />}
            aside={<MethodologyButton metric="Churn mensal de lojas" methodology={churn.methodology} variant="link" />}
          >
            {churn.months.length === 0 ? (
              <EmptyState compact icon={<TrendingDown size={28} />} title="Sem dados de churn" description="A API não devolveu meses para o cálculo." />
            ) : (
              <div className={cx('transition-opacity', stale && 'opacity-60')}>
                {churnTable}
                {churn.months.every((month) => month.rate === null) && (
                  <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                    Nenhum mês teve assinaturas pagantes no início: a taxa não se aplica (não é zero nem estimada).
                  </p>
                )}
              </div>
            )}
          </ChartCard>
        </div>
      </section>
    </>
  );
}
