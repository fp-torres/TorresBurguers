import type { ReactNode } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, LabelList, Tooltip, XAxis, YAxis,
} from 'recharts';
import { ChartContainer, useChartTheme } from '../../components/charts';
import { EmptyState } from '../../components/ui';

/** Ponto de um gráfico de uma série só. */
export interface ChartPoint {
  /** Valor do eixo de categorias (dia "AAAA-MM-DD", nome do produto...). */
  key: string;
  value: number;
}

interface TooltipBodyProps {
  active?: boolean;
  label?: string | number;
  payload?: ReadonlyArray<{ value?: unknown }>;
  name: string;
  formatValue: (value: number) => string;
  formatLabel: (key: string) => string;
}

/** Caixa do tooltip (textos com as cores de texto; a cor da série só no marcador). */
function TooltipBody({ active, label, payload, name, formatValue, formatLabel }: TooltipBodyProps) {
  if (!active || !payload?.length) return null;
  const value = Number(payload[0]?.value ?? 0);
  return (
    <div className="px-3 py-2 rounded-xl shadow-lg border text-xs bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-700">
      <p className="font-bold text-gray-800 dark:text-white mb-0.5">{formatLabel(String(label ?? ''))}</p>
      <p className="text-gray-600 dark:text-gray-300">
        {name}: <span className="font-bold text-gray-900 dark:text-white tabular-nums">{formatValue(Number.isFinite(value) ? value : 0)}</span>
      </p>
    </div>
  );
}

interface AreaTrendChartProps {
  data: ChartPoint[];
  /** Nome da série no tooltip (ex.: "Faturamento"). */
  name: string;
  formatValue: (value: number) => string;
  /** Rótulo do eixo de valores (compacto). */
  formatAxisValue: (value: number) => string;
  /** Rótulo da categoria (ex.: dia "11/10"). */
  formatLabel: (key: string) => string;
  height?: number;
  /** Dados antigos durante uma nova consulta: esmaece sem trocar o layout. */
  stale?: boolean;
}

/** Evolução ao longo dos dias: linha de 2px com área a ~10% e tooltip com cursor vertical. */
export function AreaTrendChart({ data, name, formatValue, formatAxisValue, formatLabel, height = 280, stale = false }: AreaTrendChartProps) {
  const theme = useChartTheme();
  return (
    <ChartContainer height={height} stale={stale}>
      <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} stroke={theme.grid} />
        <XAxis
          dataKey="key"
          tickLine={false}
          axisLine={{ stroke: theme.grid }}
          tick={{ fill: theme.axis, fontSize: 12 }}
          tickFormatter={(value) => formatLabel(String(value))}
          minTickGap={18}
          dy={6}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tick={{ fill: theme.axis, fontSize: 12 }}
          tickFormatter={(value) => formatAxisValue(Number(value))}
          width={76}
        />
        <Tooltip
          cursor={{ stroke: theme.axis, strokeWidth: 1 }}
          content={(props) => (
            <TooltipBody active={props.active} label={props.label} payload={props.payload} name={name} formatValue={formatValue} formatLabel={formatLabel} />
          )}
        />
        <Area
          type="monotone"
          dataKey="value"
          name={name}
          stroke={theme.series}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          fill={theme.series}
          fillOpacity={0.1}
          dot={false}
          activeDot={{ r: 5, fill: theme.series, stroke: theme.surface, strokeWidth: 2 }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}

interface HorizontalBarsProps {
  data: ChartPoint[];
  name: string;
  formatValue: (value: number) => string;
  /** Rótulo da categoria (ex.: nome do status). */
  formatLabel?: (key: string) => string;
  /** Largura reservada aos nomes das categorias (px). */
  labelWidth?: number;
  emptyTitle: string;
  emptyDescription?: ReactNode;
  stale?: boolean;
}

const ROW_HEIGHT = 34;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Comparação de magnitude entre categorias: barras finas (<= 20px), cantos de 4px na ponta e o valor na ponta. */
export function HorizontalBars({
  data,
  name,
  formatValue,
  formatLabel = (key) => key,
  labelWidth = 128,
  emptyTitle,
  emptyDescription,
  stale = false,
}: HorizontalBarsProps) {
  const theme = useChartTheme();
  if (data.length === 0) {
    return <EmptyState compact title={emptyTitle} description={emptyDescription} />;
  }
  // Altura cresce com o número de barras (a área do eixo nunca é cortada)
  const height = data.length * ROW_HEIGHT + 24;
  const maxChars = Math.max(8, Math.floor(labelWidth / 7));

  return (
    <ChartContainer height={height} stale={stale}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 56, bottom: 4, left: 0 }} barCategoryGap={8}>
        <CartesianGrid horizontal={false} stroke={theme.grid} />
        <XAxis type="number" hide domain={[0, 'dataMax']} />
        <YAxis
          type="category"
          dataKey="key"
          width={labelWidth}
          tickLine={false}
          axisLine={{ stroke: theme.grid }}
          tick={{ fill: theme.axis, fontSize: 12 }}
          tickFormatter={(value) => truncate(formatLabel(String(value)), maxChars)}
          interval={0}
        />
        <Tooltip
          cursor={{ fill: theme.cursor }}
          content={(props) => (
            <TooltipBody active={props.active} label={props.label} payload={props.payload} name={name} formatValue={formatValue} formatLabel={formatLabel} />
          )}
        />
        <Bar dataKey="value" name={name} fill={theme.series} radius={[0, 4, 4, 0]} maxBarSize={20} isAnimationActive={false}>
          <LabelList
            dataKey="value"
            position="right"
            offset={8}
            fill={theme.axis}
            fontSize={12}
            formatter={(value) => formatValue(Number(value))}
          />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
