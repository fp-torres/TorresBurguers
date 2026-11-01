import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChefHat, Clock, DollarSign, ShoppingBag, TrendingUp, Wallet } from 'lucide-react';
import { CARD_CLASS, EmptyState, StatCard, StatusBadge, cx } from '../../components/ui';
import StoreToggle from '../../components/StoreToggle';
import { useAuth } from '../../contexts/AuthContext';
import { usePolling } from '../../hooks/usePolling';
import { orderNumber, orderService } from '../../services/orderService';
import { usePanelStore, type PanelStoreData } from '../../layouts/DefaultLayout/panelStore';
import { useResource } from '../../hooks/useResource';
import { orderStatusTone } from '../../layouts/DefaultLayout/orderTones';
import { shortDateKey } from '../../utils/dates';
import { formatCurrency, formatTime, formatCompactCurrency, formatInteger } from '../../utils/format';
import { orderStatusLabel } from '../../utils/orders';
import FeatureLockedCard from './FeatureLockedCard';
import ReportsSection from './ReportsSection';
import { AreaTrendChart, HorizontalBars } from './charts';
import { ChartCard, ChartDataDetails } from '../../components/charts';

// Indicadores e atividade atualizados a cada 15 s; gráficos a cada minuto (pausam com a aba oculta)
const SUMMARY_INTERVAL_MS = 15_000;
const CHARTS_INTERVAL_MS = 60_000;

/** Explicação do bloqueio quando o plano (já conhecido pelo layout) não inclui relatórios e gráficos. */
function planLockMessage(panel: PanelStoreData): string | undefined {
  const overview = panel.subscription;
  if (!overview) return undefined;
  if (!overview.limitsAvailable) return 'A loja não tem uma assinatura ativa: relatórios e gráficos ficam indisponíveis.';
  return overview.plan?.name ? `O plano ${overview.plan.name} não inclui relatórios e gráficos.` : undefined;
}

/**
 * Painel da loja › Dashboard (/dashboard; só Administrador): totais da loja (GET /orders/summary),
 * gráficos dos últimos 7 dias (GET /orders/charts), relatórios por período (GET /orders/reports) e a
 * atividade recente do quadro. Gráficos e relatórios dependem do recurso "relatórios" do plano (403 sem ele).
 */
export default function Dashboard() {
  const { refreshUser } = useAuth();
  const panel = usePanelStore();
  // Recurso do plano já conhecido pelo layout (GET /store/settings → features): sem ele, nem consulta os gráficos.
  // Enquanto não chega (null), a API decide: 403 em /orders/charts também bloqueia.
  const reportsIncluded = panel.features ? panel.features.advanced_reports : null;

  const summary = useResource((signal) => orderService.getSummary(signal), {
    errorMessage: 'Não foi possível atualizar os indicadores.',
  });
  const activity = useResource((signal) => orderService.getActive(signal), {
    errorMessage: 'Não foi possível atualizar a atividade recente.',
  });
  const charts = useResource((signal) => orderService.getCharts(signal), {
    enabled: reportsIncluded !== false,
    errorMessage: 'Não foi possível carregar os gráficos.',
  });

  const chartsLocked = reportsIncluded === false || charts.errorStatus === 403;
  // Os relatórios esperam a primeira resposta dos gráficos: num plano sem o recurso, o 403 dos gráficos já
  // mostra o aviso e o relatório não chega a ser pedido
  const showReports = !chartsLocked && (charts.data !== null || charts.error !== null);
  const reloadSummary = summary.reload;
  const reloadActivity = activity.reload;
  const reloadCharts = charts.reload;

  usePolling(() => Promise.all([reloadSummary({ silent: true }), reloadActivity({ silent: true })]), SUMMARY_INTERVAL_MS);
  usePolling(() => reloadCharts({ silent: true }), CHARTS_INTERVAL_MS, { enabled: !chartsLocked });

  // 403 nos totais (rota só do Administrador): o perfil pode ter mudado; a sessão leva à página certa
  const summaryForbidden = summary.errorStatus === 403;
  useEffect(() => {
    if (summaryForbidden) void refreshUser();
  }, [summaryForbidden, refreshUser]);

  const totals = summary.data;
  const queue = totals ? totals.pendingOrders + totals.preparingOrders : 0;
  const recentOrders = [...(activity.data ?? [])].sort((a, b) => b.id - a.id).slice(0, 5);
  const chartData = charts.data;
  const revenueChart = (chartData?.revenueChart ?? []).map((point) => ({ key: point.date, value: point.total }));
  const productsChart = (chartData?.productsChart ?? []).map((point) => ({ key: point.name, value: point.quantity }));
  const anyError = summary.error ?? activity.error;

  return (
    <div className="space-y-6 pb-20 max-w-400 mx-auto">
      {/* Cabeçalho e abrir/fechar a loja */}
      <div className={cx(CARD_CLASS, 'flex flex-col md:flex-row justify-between items-start md:items-center gap-6 p-6')}>
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-800 dark:text-white">Dashboard</h1>
          <p className="text-gray-500 dark:text-gray-400 font-medium">Indicadores da loja, gráficos e relatórios de vendas.</p>
        </div>
        <StoreToggle variant="hero" />
      </div>

      {anyError && !summaryForbidden && (
        <div role="alert" className="flex items-center gap-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 px-4 py-3 rounded-2xl text-sm">
          <AlertTriangle size={18} className="shrink-0" aria-hidden="true" />
          <span>{anyError} Os números podem estar desatualizados; uma nova tentativa é feita a cada 15 segundos.</span>
        </div>
      )}

      {/* Totais da loja (GET /orders/summary): faturamento = pedidos pagos e não cancelados */}
      <section aria-label="Indicadores da loja" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        <StatCard
          label="Faturamento Total"
          value={formatCurrency(totals?.revenue ?? 0)}
          icon={<DollarSign size={22} />}
          tone="emerald"
          hint="Pedidos pagos e não cancelados"
          loading={summary.loading && !totals}
        />
        <StatCard
          label="Pedidos Realizados"
          value={formatInteger(totals?.totalOrders ?? 0)}
          icon={<ShoppingBag size={22} />}
          tone="blue"
          hint="Todos os pedidos, sem os cancelados"
          loading={summary.loading && !totals}
        />
        <StatCard
          label="Fila de Produção"
          value={formatInteger(queue)}
          icon={<ChefHat size={22} />}
          tone="orange"
          hint={totals ? `${formatInteger(totals.pendingOrders)} novos · ${formatInteger(totals.preparingOrders)} em preparo` : 'Novos e em preparo'}
          loading={summary.loading && !totals}
        />
        <StatCard
          label="Pagamentos Pendentes"
          value={formatInteger(totals?.pendingPayments ?? 0)}
          icon={<Wallet size={22} />}
          tone="violet"
          hint="Pedidos em andamento ainda não pagos"
          loading={summary.loading && !totals}
        />
      </section>

      {chartsLocked ? (
        <FeatureLockedCard message={charts.errorStatus === 403 ? charts.error : planLockMessage(panel)} />
      ) : (
        <>
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            <ChartCard
              className="xl:col-span-2"
              title="Desempenho Financeiro"
              icon={<TrendingUp size={20} className="text-blue-600 dark:text-blue-400" />}
              description="Faturamento de cada dia (pedidos pagos e não cancelados)."
              aside={<StatusBadge tone="neutral">Últimos 7 dias</StatusBadge>}
            >
              {chartData ? (
                <>
                  <AreaTrendChart
                    data={revenueChart}
                    name="Faturamento"
                    formatValue={formatCurrency}
                    formatAxisValue={formatCompactCurrency}
                    formatLabel={shortDateKey}
                    stale={charts.refreshing}
                  />
                  <ChartDataDetails
                    caption="Faturamento dos últimos 7 dias"
                    columns={['Dia', 'Faturamento']}
                    rows={revenueChart.map((point) => [shortDateKey(point.key), formatCurrency(point.value)])}
                  />
                </>
              ) : charts.error ? (
                <EmptyState compact title="Gráfico indisponível" description={charts.error} />
              ) : (
                <div className="h-70 rounded-xl bg-gray-100 dark:bg-slate-700/50 animate-pulse" role="status"><span className="sr-only">Carregando o gráfico...</span></div>
              )}
            </ChartCard>

            <ChartCard
              title="Produtos Campeões"
              icon={<ShoppingBag size={20} className="text-blue-600 dark:text-blue-400" />}
              description="Mais vendidos nos últimos 7 dias."
            >
              {chartData ? (
                <>
                  <HorizontalBars
                    data={productsChart}
                    name="Quantidade"
                    formatValue={(value) => `${formatInteger(value)} un.`}
                    labelWidth={120}
                    emptyTitle="Nenhuma venda nos últimos 7 dias"
                    stale={charts.refreshing}
                  />
                  {productsChart.length > 0 && (
                    <ChartDataDetails
                      caption="Produtos mais vendidos nos últimos 7 dias"
                      columns={['Produto', 'Quantidade']}
                      rows={productsChart.map((point) => [point.key, formatInteger(point.value)])}
                    />
                  )}
                </>
              ) : charts.error ? (
                <EmptyState compact title="Gráfico indisponível" description={charts.error} />
              ) : (
                <div className="h-56 rounded-xl bg-gray-100 dark:bg-slate-700/50 animate-pulse" role="status"><span className="sr-only">Carregando o gráfico...</span></div>
              )}
            </ChartCard>
          </div>

          {showReports && <ReportsSection />}
        </>
      )}

      {/* Atividade recente do quadro (pedidos em andamento e das últimas 24 h) */}
      <section aria-labelledby="activity-title" className={cx(CARD_CLASS, 'p-5 sm:p-6')}>
        <div className="flex justify-between items-center gap-3 mb-4">
          <h2 id="activity-title" className="font-bold text-gray-800 dark:text-white flex items-center gap-2">
            <Clock size={20} className="text-gray-400" aria-hidden="true" /> Atividade recente
          </h2>
          <Link to="/orders" className="text-xs font-bold text-orange-600 dark:text-orange-400 hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
            Abrir o quadro de pedidos
          </Link>
        </div>

        {activity.loading && !activity.data ? (
          <div className="space-y-3" role="status">
            {[0, 1, 2].map((index) => <div key={index} className="h-14 rounded-xl bg-gray-100 dark:bg-slate-700/50 animate-pulse" />)}
            <span className="sr-only">Carregando a atividade recente...</span>
          </div>
        ) : recentOrders.length === 0 ? (
          <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-6">Sem atividade recente.</p>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
            {recentOrders.map((order) => (
              <li key={order.id} className="flex items-center justify-between gap-3 p-3 bg-gray-50 dark:bg-slate-900 rounded-xl border border-gray-100 dark:border-slate-700">
                <div className="min-w-0">
                  {/* Número do pedido NA LOJA (como no quadro); o id interno fica no title */}
                  <p className="text-sm font-bold text-gray-700 dark:text-gray-200" title={`ID interno ${order.id}`}>Pedido #{orderNumber(order)}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {formatTime(order.created_at)} • {order.items.length} {order.items.length === 1 ? 'item' : 'itens'}
                  </p>
                  <StatusBadge tone={orderStatusTone(order.status)} className="mt-1">{orderStatusLabel(order.status, order.type)}</StatusBadge>
                </div>
                <span className="text-sm font-bold text-gray-800 dark:text-white tabular-nums shrink-0">{formatCurrency(order.total_price)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
