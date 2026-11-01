import { useId, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon } from '@iconify/react';
import {
  AlertTriangle, BadgePercent, CalendarClock, FileWarning, Loader2, Receipt, RefreshCw, ShoppingBag, Trophy, TrendingUp, Wallet,
} from 'lucide-react';
import { CARD_CLASS, EmptyState, ErrorState, PageHeader, StatCard, StatusBadge, buttonClass, cx } from '../../../components/ui';
import PageLoader from '../../../components/PageLoader';
import { useResource } from '../../../hooks/useResource';
import { formatDate, formatDateKey, todayKeyInZone } from '../../../utils/dates';
import { useNow } from '../../../hooks/useNow';
import { platformFinanceService, type DelinquentStore, type PlatformFinance } from '../../../services/platform/financeService';
import { INVOICE_STATUS, statusMeta } from '../../../utils/saasStatus';
import { formatCurrency, formatDateTime, formatCompactCurrency, formatInteger } from '../../../utils/format';
import MethodologyButton from '../Dashboard/MethodologyButton';
import {
  MonthlyColumnChart, RankedBars, SectionHeading, SeriesKey, SeriesSwatch,
} from '../Dashboard/charts';
import { ChartCard, ChartDataDetails, SERIES_LABEL } from '../../../components/charts';
import { monthLong, plural } from '../Dashboard/insightsFormat';
import PeriodFilter from './PeriodFilter';
import { rangeFromParams, type PeriodRange } from './period';

const DAY_MS = 86_400_000;

/**
 * Superpainel › Financeiro (/platform/finance): GET /platform/finance?from&to (padrão: últimos 12 meses).
 * Dois blocos que nunca se somam: a RECEITA DA COMESTRA (faturas da assinatura pagas, faturas por situação,
 * MRR/ARR e inadimplência) e o VOLUME DAS LOJAS (GMV por mês e as 10 lojas que mais venderam).
 * O período fica no endereço (?de=AAAA-MM-DD&ate=AAAA-MM-DD) para ser compartilhado.
 */
export default function PlatformFinance() {
  const [searchParams, setSearchParams] = useSearchParams();
  const range = rangeFromParams(searchParams);
  const now = useNow(60_000);

  const resource = useResource((signal) => platformFinanceService.get(range, signal), {
    key: `${range.from}|${range.to}`,
    errorMessage: 'Não foi possível carregar o financeiro da plataforma.',
  });
  const data = resource.data;
  const busy = resource.loading || resource.refreshing;
  const today = todayKeyInZone(now, data?.time_zone);

  function applyRange(next: PeriodRange) {
    setSearchParams((params) => {
      const updated = new URLSearchParams(params);
      if (next.from) updated.set('de', next.from);
      else updated.delete('de');
      if (next.to) updated.set('ate', next.to);
      else updated.delete('ate');
      return updated;
    }, { replace: true });
  }

  const effective = data && data.period.from && data.period.to ? { from: data.period.from, to: data.period.to } : null;

  const header = (
    <PageHeader
      title="Financeiro"
      subtitle="Receita da Comestra e inadimplência, separadas do volume vendido pelas lojas"
      icon={<Icon icon="solar:wallet-money-bold-duotone" width={26} />}
      actions={(
        <button type="button" onClick={() => void resource.reload()} disabled={busy} className={buttonClass('secondary')}>
          {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
          {busy ? 'Atualizando...' : 'Atualizar'}
        </button>
      )}
    >
      <PeriodFilter
        key={`${range.from}|${range.to}`}
        range={range}
        effective={effective}
        today={today}
        onApply={applyRange}
        disabled={resource.loading}
      />
      {data && data.period.from && (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400" aria-live="polite">
          Período: <span className="font-bold text-gray-700 dark:text-gray-200">{formatDateKey(data.period.from)} a {formatDateKey(data.period.to)}</span>
          {' '}({plural(data.period.days, 'dia', 'dias')})
          {data.time_zone && <> · calendário no fuso {data.time_zone}</>}
          {' '}· dados de {formatDateTime(data.generated_at)}.
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
            <ErrorState
              message={resource.error}
              onRetry={() => void resource.reload()}
              retrying={resource.loading}
              action={range.from || range.to ? (
                <button type="button" onClick={() => applyRange({ from: '', to: '' })} className={buttonClass('secondary')}>
                  Voltar aos últimos 12 meses
                </button>
              ) : undefined}
            />
          </div>
        ) : (
          <PageLoader />
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
          <span className="flex-1 min-w-48">{resource.error} Os números abaixo são da última consulta que deu certo (veja o período acima).</span>
          <button type="button" onClick={() => void resource.reload()} className="font-bold hover:underline">Tentar novamente</button>
        </div>
      )}

      <FinanceContent data={data} stale={resource.stale} now={now} />
    </div>
  );
}

function FinanceContent({ data, stale, now }: { data: PlatformFinance; stale: boolean; now: number }) {
  const platformId = useId();
  const storesId = useId();
  const { platform_revenue: revenue, invoices_by_status: invoices, mrr, arr, gmv, delinquency } = data;

  const revenueSeries = revenue.by_month.map((row) => ({ month: row.month, value: row.amount }));
  const gmvSeries = gmv.by_month.map((row) => ({ month: row.month, value: row.amount }));
  const invoicesByMonth = new Map(revenue.by_month.map((row) => [row.month, row.invoices]));
  const paidOrdersByMonth = new Map(gmv.by_month.map((row) => [row.month, row.paid_orders]));
  const allZero = (series: { value: number }[]) => series.every((point) => point.value === 0);
  const invoiceCount = invoices.items.reduce((sum, item) => sum + item.count, 0);

  /** Há quantos dias venceu a fatura mais antiga em aberto. */
  function overdueSince(row: DelinquentStore): ReactNode {
    if (!row.oldest_due_at) return <span className="text-gray-400">—</span>;
    const days = Math.max(0, Math.floor((now - new Date(row.oldest_due_at).getTime()) / DAY_MS));
    return (
      <>
        {formatDate(row.oldest_due_at)}
        <span className="block text-xs text-gray-500 dark:text-gray-400">{days === 0 ? 'hoje' : `há ${plural(days, 'dia', 'dias')}`}</span>
      </>
    );
  }

  return (
    <>
      {/* Receita da Comestra (assinaturas SaaS) */}
      <section aria-labelledby={platformId} className="space-y-4">
        <SectionHeading
          id={platformId}
          title="Receita da Comestra"
          description="Assinaturas SaaS: o que as lojas pagam à plataforma."
          aside={<SeriesKey tone="platform">{SERIES_LABEL.platform}</SeriesKey>}
        />

        <div className={cx('grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 transition-opacity', stale && 'opacity-60')}>
          <StatCard
            label="Receita no período"
            value={formatCurrency(revenue.total)}
            icon={<Receipt size={22} />}
            tone="emerald"
            hint={(
              <>
                {revenue.note ?? `${plural(revenue.paid_invoices, 'fatura paga', 'faturas pagas')} no período, pela data do pagamento.`}{' '}
                <MethodologyButton metric="Receita da Comestra" methodology={revenue.methodology} />
              </>
            )}
          />
          <StatCard
            label="MRR atual"
            value={formatCurrency(mrr.value)}
            icon={<Wallet size={22} />}
            tone="blue"
            hint={(
              <>
                {mrr.has_paid_subscriptions
                  ? `Hoje, ${plural(mrr.paying_subscriptions, 'assinatura pagante', 'assinaturas pagantes')} (não depende do período).`
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
            label="Inadimplência atual"
            value={formatCurrency(delinquency.amount)}
            icon={<FileWarning size={22} />}
            tone={delinquency.invoices > 0 ? 'red' : 'slate'}
            hint={(
              <>
                {delinquency.note
                  ?? `${plural(delinquency.invoices, 'fatura vencida', 'faturas vencidas')} em ${plural(delinquency.stores, 'loja', 'lojas')} (hoje, não depende do período).`}{' '}
                <MethodologyButton metric="Inadimplência" methodology={delinquency.methodology} />
              </>
            )}
          />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          <ChartCard
            className="xl:col-span-2"
            title="Receita da Comestra por mês"
            description="Faturas da assinatura pagas no período, pela data do pagamento."
            icon={<SeriesSwatch tone="platform" />}
            aside={<MethodologyButton metric="Receita da Comestra" methodology={revenue.methodology} variant="link" />}
          >
            {allZero(revenueSeries) ? (
              <EmptyState
                compact
                icon={<Receipt size={28} />}
                title="Nenhuma receita no período"
                description={revenue.note ?? 'Nenhuma fatura de assinatura foi paga no período escolhido.'}
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
                  caption="Receita da Comestra por mês no período"
                  columns={['Mês', 'Receita', 'Faturas pagas']}
                  rows={revenue.by_month.map((row) => [monthLong(row.month), formatCurrency(row.amount), formatInteger(row.invoices)])}
                />
              </>
            )}
          </ChartCard>

          <ChartCard
            title="Faturas por situação"
            description="Faturas da assinatura com vencimento no período."
            icon={<CalendarClock size={18} className="text-gray-500 dark:text-gray-400" />}
            aside={<MethodologyButton metric="Faturas por situação" methodology={invoices.methodology} variant="link" />}
          >
            {invoiceCount === 0 ? (
              <EmptyState
                compact
                icon={<Receipt size={28} />}
                title="Nenhuma fatura no período"
                description="Nenhuma fatura de assinatura vence no período escolhido."
              />
            ) : (
              <table className={cx('w-full text-sm transition-opacity', stale && 'opacity-60')}>
                <caption className="sr-only">Faturas da assinatura por situação, com vencimento no período</caption>
                <thead className="text-xs text-gray-500 dark:text-gray-400">
                  <tr className="border-b border-gray-100 dark:border-slate-700">
                    <th scope="col" className="py-2 pr-2 text-left font-semibold">Situação</th>
                    <th scope="col" className="py-2 px-2 text-right font-semibold">Faturas</th>
                    <th scope="col" className="py-2 pl-2 text-right font-semibold">Valor</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-slate-700 text-gray-700 dark:text-gray-200">
                  {invoices.items.map((item) => {
                    const meta = statusMeta(INVOICE_STATUS, item.status);
                    return (
                      <tr key={item.status}>
                        <th scope="row" className="py-2.5 pr-2 text-left font-normal">
                          <StatusBadge tone={meta.tone} dot>{meta.label}</StatusBadge>
                        </th>
                        <td className="py-2.5 px-2 text-right tabular-nums">{formatInteger(item.count)}</td>
                        <td className="py-2.5 pl-2 text-right tabular-nums font-bold whitespace-nowrap">{formatCurrency(item.amount)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </ChartCard>
        </div>

        <ChartCard
          title="Inadimplência por loja"
          description={`Faturas em aberto ou recusadas já vencidas, hoje (independe do período).${delinquency.stores > delinquency.top_stores.length ? ` Mostrando as ${delinquency.top_stores.length} lojas com maior valor de ${delinquency.stores}.` : ''}`}
          icon={<FileWarning size={18} className="text-red-600 dark:text-red-400" />}
          aside={<MethodologyButton metric="Inadimplência" methodology={delinquency.methodology} variant="link" />}
        >
          {delinquency.top_stores.length === 0 ? (
            <EmptyState
              compact
              icon={<FileWarning size={28} />}
              title="Sem inadimplência"
              description={delinquency.note ?? 'Nenhuma fatura vencida em aberto.'}
            />
          ) : (
            <div
              role="region"
              aria-label="Lojas com faturas da assinatura vencidas"
              tabIndex={0}
              className={cx(
                'overflow-x-auto custom-scrollbar rounded-lg transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500',
                stale && 'opacity-60',
              )}
            >
              <table className="w-full text-sm">
                <caption className="sr-only">Lojas com faturas da assinatura vencidas, da maior para a menor dívida</caption>
                <thead className="text-xs text-gray-500 dark:text-gray-400">
                  <tr className="border-b border-gray-100 dark:border-slate-700">
                    <th scope="col" className="py-2 pr-3 text-left font-semibold">Loja</th>
                    <th scope="col" className="py-2 px-3 text-right font-semibold whitespace-nowrap">Valor vencido</th>
                    <th scope="col" className="py-2 px-3 text-right font-semibold">Faturas</th>
                    <th scope="col" className="py-2 pl-3 text-left font-semibold whitespace-nowrap">Vencida desde</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-slate-700 text-gray-700 dark:text-gray-200">
                  {delinquency.top_stores.map((row) => (
                    <tr key={row.store.id}>
                      <th scope="row" className="py-2.5 pr-3 text-left font-normal">
                        <Link
                          to={`/platform/stores/${row.store.id}`}
                          className="font-bold text-gray-800 dark:text-white hover:text-orange-600 dark:hover:text-orange-400 hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                        >
                          {row.store.name}
                        </Link>
                      </th>
                      <td className="py-2.5 px-3 text-right tabular-nums font-bold whitespace-nowrap">{formatCurrency(row.amount)}</td>
                      <td className="py-2.5 px-3 text-right tabular-nums">{formatInteger(row.invoices)}</td>
                      <td className="py-2.5 pl-3 whitespace-nowrap">{overdueSince(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ChartCard>
      </section>

      {/* Volume das lojas (GMV): nunca somado à receita da Comestra */}
      <section aria-labelledby={storesId} className="space-y-4">
        <SectionHeading
          id={storesId}
          title="Volume das lojas (GMV)"
          description="Pedidos pagos pelos consumidores às lojas: não é receita da Comestra e nunca é somado a ela."
          aside={<SeriesKey tone="stores">{SERIES_LABEL.stores}</SeriesKey>}
        />

        <div className={cx('grid grid-cols-1 sm:grid-cols-2 gap-4 transition-opacity', stale && 'opacity-60')}>
          <StatCard
            label="GMV no período"
            value={formatCurrency(gmv.total)}
            icon={<BadgePercent size={22} />}
            tone="orange"
            hint={(
              <>
                {gmv.note ?? 'Soma dos pedidos pagos e não cancelados de todas as lojas no período.'}{' '}
                <MethodologyButton metric="Volume das lojas (GMV)" methodology={gmv.methodology} />
              </>
            )}
          />
          <StatCard
            label="Pedidos pagos no período"
            value={formatInteger(gmv.paid_orders)}
            icon={<ShoppingBag size={22} />}
            tone="orange"
            hint="Pedidos pagos e não cancelados de todas as lojas, pela data do pedido."
          />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          <ChartCard
            className="xl:col-span-2"
            title="GMV das lojas por mês"
            description="Pedidos pagos e não cancelados, pela data do pedido."
            icon={<SeriesSwatch tone="stores" />}
            aside={<MethodologyButton metric="Volume das lojas (GMV)" methodology={gmv.methodology} variant="link" />}
          >
            {allZero(gmvSeries) ? (
              <EmptyState
                compact
                icon={<BadgePercent size={28} />}
                title="Nenhum pedido pago no período"
                description={gmv.note ?? 'Nenhum pedido pago no período: o volume das lojas é zero.'}
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
                  caption="GMV das lojas por mês no período"
                  columns={['Mês', 'GMV', 'Pedidos pagos']}
                  rows={gmv.by_month.map((row) => [monthLong(row.month), formatCurrency(row.amount), formatInteger(row.paid_orders)])}
                />
              </>
            )}
          </ChartCard>

          <ChartCard
            title="Lojas que mais venderam"
            description="As 10 maiores em GMV no período."
            icon={<Trophy size={18} className="text-amber-600 dark:text-amber-400" />}
          >
            {data.top_stores_by_gmv.length === 0 ? (
              <EmptyState
                compact
                icon={<Trophy size={28} />}
                title="Nenhuma venda no período"
                description={gmv.note ?? 'Nenhuma loja teve pedidos pagos no período escolhido.'}
              />
            ) : (
              <RankedBars
                ranked
                label="Lojas com maior GMV no período"
                tone="stores"
                className={cx('transition-opacity', stale && 'opacity-60')}
                items={data.top_stores_by_gmv.map((row) => ({
                  key: row.store.id,
                  label: row.store.name,
                  to: `/platform/stores/${row.store.id}`,
                  value: row.gmv,
                  valueLabel: formatCurrency(row.gmv),
                  detail: plural(row.paid_orders, 'pedido pago', 'pedidos pagos'),
                }))}
              />
            )}
          </ChartCard>
        </div>
      </section>
    </>
  );
}
