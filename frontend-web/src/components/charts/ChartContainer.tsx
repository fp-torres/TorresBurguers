import type { ReactNode } from 'react';
import { ResponsiveContainer } from 'recharts';
import { cx } from '../ui/styles';

export interface ChartContainerProps {
  /** Altura do gráfico em px (inclui a faixa dos eixos). */
  height: number;
  /** Dados antigos durante uma nova consulta: esmaece sem trocar o layout. */
  stale?: boolean;
  className?: string;
  /** Um gráfico do recharts (AreaChart, BarChart...). */
  children: ReactNode;
}

/**
 * Área de um gráfico do recharts: largura do contêiner (acompanha o redimensionamento) e altura fixa.
 * A altura numérica no ResponsiveContainer evita o aviso "width(-1) and height(-1) of chart should be greater
 * than 0" da primeira renderização (antes da medida, o recharts não desenha nada) e o min-w-0 deixa o gráfico
 * encolher dentro de grids e flex.
 */
export default function ChartContainer({ height, stale = false, className, children }: ChartContainerProps) {
  return (
    <div className={cx('w-full min-w-0 transition-opacity', stale && 'opacity-60', className)} style={{ height }}>
      <ResponsiveContainer width="100%" height={height} minWidth={0}>
        {children}
      </ResponsiveContainer>
    </div>
  );
}
