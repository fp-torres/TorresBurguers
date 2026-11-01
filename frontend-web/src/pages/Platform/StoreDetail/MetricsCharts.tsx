import type { ReactNode } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis,
} from 'recharts';
import { ChartContainer, useChartTheme } from '../../../components/charts';
import { formatCurrency, formatCompactCurrency, formatInteger } from '../../../utils/format';
import { formatDateKey, shortDateKey, weekdayOfKey } from '../../../utils/dates';

export interface DailyPoint {
  date: string;
  orders: number;
  paid_orders: number;
  gmv: number;
}

interface TooltipBodyProps {
  active?: boolean;
  label?: string | number;
  payload?: ReadonlyArray<{ payload?: unknown }>;
  render: (point: DailyPoint) => ReactNode;
}

/** Caixa do tooltip: o valor em destaque, o dia como contexto (textos nas cores de texto, nunca a da série). */
function TooltipBody({ active, label, payload, render }: TooltipBodyProps) {
  const point = payload?.[0]?.payload as DailyPoint | undefined;
  if (!active || !point) return null;
  const key = String(label ?? point.date);
  return (
    <div className="px-3 py-2 rounded-xl shadow-lg border text-xs bg-white dark:bg-slate-900 border-gray-200 dark:border-slate-700 space-y-0.5">
      {render(point)}
      <p className="text-gray-500 dark:text-gray-400">{weekdayOfKey(key)} {formatDateKey(key)}</p>
    </div>
  );
}

const CHART_HEIGHT = 260;

/** Pedidos (não cancelados) por dia: colunas finas (até 24px) com canto de 4px no topo. */
export function DailyOrdersChart({ data, stale = false }: { data: DailyPoint[]; stale?: boolean }) {
  const theme = useChartTheme();
  return (
    <ChartContainer height={CHART_HEIGHT} stale={stale}>
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={theme.grid} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={{ stroke: theme.grid }}
          tick={{ fill: theme.axis, fontSize: 12 }}
          tickFormatter={(value) => shortDateKey(String(value))}
          minTickGap={16}
          dy={6}
        />
        <YAxis
          allowDecimals={false}
          tickLine={false}
          axisLine={false}
          tick={{ fill: theme.axis, fontSize: 12 }}
          tickFormatter={(value) => formatInteger(value)}
          width={44}
        />
        <Tooltip
          cursor={{ fill: theme.cursor }}
          content={(props) => (
            <TooltipBody
              active={props.active}
              label={props.label}
              payload={props.payload}
              render={(point) => (
                <>
                  <p className="text-sm font-bold text-gray-900 dark:text-white tabular-nums">
                    {formatInteger(point.orders)} pedido{point.orders === 1 ? '' : 's'}
                  </p>
                  <p className="text-gray-600 dark:text-gray-300">{formatInteger(point.paid_orders)} pago{point.paid_orders === 1 ? '' : 's'}</p>
                </>
              )}
            />
          )}
        />
        <Bar dataKey="orders" name="Pedidos" fill={theme.series} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
      </BarChart>
    </ChartContainer>
  );
}

/** GMV (pedidos pagos e não cancelados) por dia: linha de 2px com área a ~10%. */
export function DailyGmvChart({ data, stale = false }: { data: DailyPoint[]; stale?: boolean }) {
  const theme = useChartTheme();
  return (
    <ChartContainer height={CHART_HEIGHT} stale={stale}>
      <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} stroke={theme.grid} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={{ stroke: theme.grid }}
          tick={{ fill: theme.axis, fontSize: 12 }}
          tickFormatter={(value) => shortDateKey(String(value))}
          minTickGap={16}
          dy={6}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tick={{ fill: theme.axis, fontSize: 12 }}
          tickFormatter={(value) => formatCompactCurrency(value)}
          width={76}
        />
        <Tooltip
          cursor={{ stroke: theme.axis, strokeWidth: 1 }}
          content={(props) => (
            <TooltipBody
              active={props.active}
              label={props.label}
              payload={props.payload}
              render={(point) => (
                <p className="text-sm font-bold text-gray-900 dark:text-white tabular-nums">{formatCurrency(point.gmv)}</p>
              )}
            />
          )}
        />
        <Area
          type="monotone"
          dataKey="gmv"
          name="GMV"
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
