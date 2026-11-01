import { formatInteger } from '../../../utils/format';

// Formatação dos indicadores do superpainel (pt-BR fixo, independente do idioma do navegador).
// Números (formatInteger, formatCompactCurrency, formatCompactNumber) ficam em utils/format.

const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MONTHS_LONG = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

const percentFormatter = new Intl.NumberFormat('pt-BR', { style: 'percent', minimumFractionDigits: 0, maximumFractionDigits: 1 });

function monthParts(month: string): { year: number; index: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const index = Number(match[2]) - 1;
  return index >= 0 && index < 12 ? { year: Number(match[1]), index } : null;
}

/** "2026-10" → "out/26" (eixos dos gráficos). */
export function monthShort(month: string): string {
  const parts = monthParts(month);
  return parts ? `${MONTHS_SHORT[parts.index]}/${String(parts.year).slice(-2)}` : month;
}

/** "2026-10" → "outubro de 2026" (tooltips, tabelas e textos). */
export function monthLong(month: string): string {
  const parts = monthParts(month);
  return parts ? `${MONTHS_LONG[parts.index]} de ${parts.year}` : month;
}

/** Fração (0 a 1) em porcentagem: 0.025 → "2,5%". null → "—". */
export function formatRate(rate: number | null | undefined): string {
  return rate === null || rate === undefined || !Number.isFinite(rate) ? '—' : percentFormatter.format(rate);
}

/** "1 loja" / "3 lojas". */
export function plural(count: number, singular: string, many: string): string {
  return `${formatInteger(count)} ${count === 1 ? singular : many}`;
}
