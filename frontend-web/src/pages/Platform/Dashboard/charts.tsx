import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import { BAR_TRACK_CLASS, ChartContainer, SERIES_BG_CLASS, type SeriesTone, usePlatformChartTheme } from '../../../components/charts';
import { cx } from '../../../components/ui';
import { monthLong, monthShort } from './insightsFormat';

// Peças dos gráficos do Dashboard e do Financeiro do superpainel (recharts + HTML).
// Uma série por gráfico (sem eixo duplo): duas medidas de escalas diferentes viram dois gráficos.

interface SectionHeadingProps {
  /** id do h2 (para o aria-labelledby da seção). */
  id: string;
  title: string;
  description?: ReactNode;
  /** À direita (ex.: legenda da entidade). */
  aside?: ReactNode;
}

/** Título (h2) de um bloco de indicadores, com descrição e legenda opcional. */
export function SectionHeading({ id, title, description, aside }: SectionHeadingProps) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <div className="min-w-0">
        <h2 id={id} className="text-lg font-bold text-gray-800 dark:text-white">{title}</h2>
        {description && <p className="text-sm text-gray-500 dark:text-gray-400">{description}</p>}
      </div>
      {aside}
    </div>
  );
}

/** Quadradinho na cor da entidade (decorativo: o texto ao lado sempre diz o que é). */
export function SeriesSwatch({ tone, className }: { tone: SeriesTone; className?: string }) {
  return <span aria-hidden="true" className={cx('inline-block w-3 h-3 rounded-[3px] shrink-0', SERIES_BG_CLASS[tone], className)} />;
}

/** Marcador da entidade (cor + nome): a cor nunca aparece sozinha. */
export function SeriesKey({ tone, children, className }: { tone: SeriesTone; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2 text-xs font-semibold text-gray-600 dark:text-gray-300', className)}>
      <SeriesSwatch tone={tone} />
      {children}
    </span>
  );
}

export interface MonthValue {
  /** Mês "AAAA-MM". */
  month: string;
  value: number;
}

interface MonthTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: ReadonlyArray<{ value?: unknown }>;
  name: string;
  tone: SeriesTone;
  formatValue: (value: number) => string;
  detail?: (month: string) => string | null;
}

/** Tooltip: o valor é o destaque; o mês e a série vêm depois (marcador curto na cor da série). */
function MonthTooltip({ active, label, payload, name, tone, formatValue, detail }: MonthTooltipProps) {
  if (!active || !payload?.length) return null;
  const month = String(label ?? '');
  const value = Number(payload[0]?.value ?? 0);
  const extra = detail?.(month);
  return (
    <div className="px-3 py-2 rounded-xl shadow-lg border text-xs bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-700">
      <p className="font-bold text-sm text-gray-900 dark:text-white tabular-nums">{formatValue(Number.isFinite(value) ? value : 0)}</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-gray-600 dark:text-gray-300">
        <span aria-hidden="true" className={cx('inline-block w-3 h-0.5 rounded-full', SERIES_BG_CLASS[tone])} />
        {name} · {monthLong(month)}
      </p>
      {extra && <p className="mt-0.5 text-gray-500 dark:text-gray-400">{extra}</p>}
    </div>
  );
}

interface MonthlyColumnChartProps {
  data: MonthValue[];
  /** Nome da série no tooltip (ex.: "Receita da Comestra"). */
  name: string;
  tone: SeriesTone;
  formatValue: (value: number) => string;
  /** Rótulo compacto do eixo de valores. */
  formatAxis: (value: number) => string;
  /** Quantidades inteiras (o eixo não mostra frações). */
  integer?: boolean;
  /** Linha extra do tooltip (ex.: "12 faturas pagas"). */
  detail?: (month: string) => string | null;
  height?: number;
  /** Dados antigos durante uma nova consulta: esmaece sem trocar o layout. */
  stale?: boolean;
}

/**
 * Evolução mês a mês de UMA medida: colunas finas (até 24px) com cantos de 4px no topo, grade recessiva e
 * tooltip por coluna. A altura inclui a faixa do eixo (nada é cortado).
 */
export function MonthlyColumnChart({
  data, name, tone, formatValue, formatAxis, integer = false, detail, height = 260, stale = false,
}: MonthlyColumnChartProps) {
  const theme = usePlatformChartTheme();
  const color = theme.series[tone];
  return (
    <ChartContainer height={height} stale={stale}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="22%">
        <CartesianGrid vertical={false} stroke={theme.grid} />
        <XAxis
          dataKey="month"
          tickLine={false}
          axisLine={{ stroke: theme.grid }}
          tick={{ fill: theme.axis, fontSize: 12 }}
          tickFormatter={(value) => monthShort(String(value))}
          // Rótulos em intervalos iguais (a partir do primeiro mês) quando não cabem todos
          interval="equidistantPreserveStart"
          minTickGap={8}
          dy={6}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tick={{ fill: theme.axis, fontSize: 12 }}
          tickFormatter={(value) => formatAxis(Number(value))}
          allowDecimals={!integer}
          width={72}
        />
        <Tooltip
          cursor={{ fill: theme.cursor }}
          content={(props) => (
            <MonthTooltip
              active={props.active}
              label={props.label}
              payload={props.payload}
              name={name}
              tone={tone}
              formatValue={formatValue}
              detail={detail}
            />
          )}
        />
        <Bar dataKey="value" name={name} fill={color} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
      </BarChart>
    </ChartContainer>
  );
}

export interface RankedBarItem {
  key: string | number;
  label: string;
  /** Link do nome (ex.: detalhe da loja). */
  to?: string;
  value: number;
  /** Valor já formatado, exibido ao lado do nome. */
  valueLabel: string;
  /** Texto de apoio abaixo da barra (ex.: "321 pedidos pagos"). */
  detail?: ReactNode;
}

interface RankedBarsProps {
  items: RankedBarItem[];
  tone: SeriesTone;
  /** Numera os itens (ranking). */
  ranked?: boolean;
  /** Nome acessível da lista. */
  label: string;
  className?: string;
}

/**
 * Comparação de magnitude entre categorias em HTML: nome (com link), valor sempre visível e uma barra fina
 * proporcional ao maior valor. Lista acessível: a barra é decorativa (o número está no texto).
 */
export function RankedBars({ items, tone, ranked = false, label, className }: RankedBarsProps) {
  const max = Math.max(0, ...items.map((item) => item.value));
  const ListTag = ranked ? 'ol' : 'ul';
  return (
    <ListTag aria-label={label} className={cx('space-y-3.5', className)}>
      {items.map((item, index) => {
        const width = max > 0 && item.value > 0 ? Math.max(1.5, (item.value / max) * 100) : 0;
        return (
          <li key={item.key} className="min-w-0">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-gray-700 dark:text-gray-200">
                {ranked && <span className="mr-1.5 tabular-nums font-bold text-gray-400 dark:text-gray-500">{index + 1}.</span>}
                {item.to ? (
                  <Link
                    to={item.to}
                    className="font-semibold hover:text-orange-600 dark:hover:text-orange-400 hover:underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                  >
                    {item.label}
                  </Link>
                ) : (
                  <span className="font-semibold">{item.label}</span>
                )}
              </span>
              <span className="shrink-0 font-bold tabular-nums text-gray-900 dark:text-white">{item.valueLabel}</span>
            </div>
            <div aria-hidden="true" className={cx('mt-1.5 h-2 rounded-sm overflow-hidden', BAR_TRACK_CLASS)}>
              <div className={cx('h-full rounded-r-sm', SERIES_BG_CLASS[tone])} style={{ width: `${width}%` }} />
            </div>
            {item.detail && <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{item.detail}</div>}
          </li>
        );
      })}
    </ListTag>
  );
}
