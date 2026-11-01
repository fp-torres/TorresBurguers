// Peças comuns dos gráficos (painel da loja e superpainel): cartão, área do recharts, tabela dos dados e cores.
// Uso: import { ChartCard, ChartContainer, ChartDataDetails, useChartTheme } from '../../components/charts';

export { default as ChartCard } from './ChartCard';
export type { ChartCardProps } from './ChartCard';

export { default as ChartContainer } from './ChartContainer';
export type { ChartContainerProps } from './ChartContainer';

export { default as ChartDataDetails } from './ChartDataDetails';
export type { ChartDataDetailsProps } from './ChartDataDetails';

export {
  BAR_TRACK_CLASS, SERIES_BG_CLASS, SERIES_LABEL, useChartTheme, usePlatformChartTheme,
} from './chartTheme';
export type { ChartTheme, PlatformChartTheme, SeriesTone } from './chartTheme';
