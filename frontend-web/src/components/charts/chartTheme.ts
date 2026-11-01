import { useTheme } from '../../contexts/ThemeContext';

/**
 * Cores dos gráficos (painel da loja e superpainel), num lugar só. Par validado com o validate_palette (faixa de
 * luminosidade, croma, separação para daltonismo e contraste >= 3:1) no cartão branco (#ffffff) e no slate-800
 * (#1e293b), com passos próprios para o tema escuro. Eixos e grade ficam recessivos (linhas finas e sólidas);
 * os textos usam as cores de texto, nunca a da série.
 *
 * - Gráficos de UMA série (Dashboard da loja, métricas de um estabelecimento): slot 1 (azul) — useChartTheme.
 * - Superpainel: a cor segue a ENTIDADE, nunca o gráfico — usePlatformChartTheme:
 *   "platform" (azul, slot 1): dinheiro e crescimento da plataforma — receita SaaS, novas lojas, planos;
 *   "stores" (laranja, slot 2): movimento das lojas — pedidos e volume (GMV), que nunca é receita da plataforma.
 */
export type SeriesTone = 'platform' | 'stores';

type Mode = 'light' | 'dark';

interface ChartSurface {
  grid: string;
  axis: string;
  surface: string;
  /** Realce da categoria sob o ponteiro (barras). */
  cursor: string;
}

export interface ChartTheme extends ChartSurface {
  series: string;
}

export interface PlatformChartTheme extends ChartSurface {
  series: Record<SeriesTone, string>;
}

const SERIES: Record<Mode, Record<SeriesTone, string>> = {
  light: { platform: '#2a78d6', stores: '#eb6834' },
  dark: { platform: '#3987e5', stores: '#d95926' },
};

const AXES: Record<Mode, Omit<ChartSurface, 'cursor'>> = {
  light: { grid: '#e5e7eb', axis: '#6b7280', surface: '#ffffff' },
  dark: { grid: '#334155', axis: '#94a3b8', surface: '#1e293b' },
};

const SINGLE_SERIES: Record<Mode, ChartTheme> = {
  light: { ...AXES.light, series: SERIES.light.platform, cursor: 'rgba(42, 120, 214, 0.08)' },
  dark: { ...AXES.dark, series: SERIES.dark.platform, cursor: 'rgba(57, 135, 229, 0.14)' },
};

const BY_ENTITY: Record<Mode, PlatformChartTheme> = {
  light: { ...AXES.light, series: SERIES.light, cursor: 'rgba(107, 114, 128, 0.10)' },
  dark: { ...AXES.dark, series: SERIES.dark, cursor: 'rgba(148, 163, 184, 0.14)' },
};

/** Cores de um gráfico de uma série só, no tema atual. */
export function useChartTheme(): ChartTheme {
  const { currentMode } = useTheme();
  return SINGLE_SERIES[currentMode];
}

/** Cores dos gráficos do superpainel (uma cor por entidade), no tema atual. */
export function usePlatformChartTheme(): PlatformChartTheme {
  const { currentMode } = useTheme();
  return BY_ENTITY[currentMode];
}

/** As mesmas cores como classes (barras em HTML, marcadores de legenda): o Tailwind troca no tema escuro. */
export const SERIES_BG_CLASS: Record<SeriesTone, string> = {
  platform: 'bg-[#2a78d6] dark:bg-[#3987e5]',
  stores: 'bg-[#eb6834] dark:bg-[#d95926]',
};

/** Trilho das barras em HTML (um passo acima da superfície do cartão). */
export const BAR_TRACK_CLASS = 'bg-gray-100 dark:bg-slate-700/60';

/** Nome de cada entidade nas legendas. */
export const SERIES_LABEL: Record<SeriesTone, string> = {
  platform: 'Receita e base da Comestra',
  stores: 'Movimento das lojas',
};
