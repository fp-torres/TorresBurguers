import { daysInRange, isDateKey } from '../../../utils/dates';

// Período do Financeiro (GET /platform/finance?from&to): datas "AAAA-MM-DD" do calendário da plataforma.
// Sem datas, a API usa os últimos 12 meses do calendário (do dia 1º de 11 meses atrás até hoje).

/** Maior período aceito pela API: 1096 dias (3 anos) — backend/src/platform/metrics.ts → FINANCE_MAX_DAYS. */
export const FINANCE_MAX_DAYS = 1096;

export type PeriodPreset = 'default' | '6m' | '3m' | 'month' | 'last-month' | 'ytd' | 'custom';

export interface PeriodRange {
  /** '' = padrão da API. */
  from: string;
  to: string;
}

export const PERIOD_PRESETS: { value: PeriodPreset; label: string }[] = [
  { value: 'default', label: 'Últimos 12 meses' },
  { value: '6m', label: 'Últimos 6 meses' },
  { value: '3m', label: 'Últimos 3 meses' },
  { value: 'month', label: 'Este mês' },
  { value: 'last-month', label: 'Mês passado' },
  { value: 'ytd', label: 'Este ano' },
  { value: 'custom', label: 'Personalizado' },
];

/** Soma meses a um "AAAA-MM". */
function addMonths(month: string, count: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const index = year * 12 + (monthNumber - 1) + count;
  const nextYear = Math.floor(index / 12);
  return `${nextYear}-${String(index - nextYear * 12 + 1).padStart(2, '0')}`;
}

/** Último dia de um mês "AAAA-MM" como "AAAA-MM-DD". */
function lastDayOfMonth(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const day = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, '0')}`;
}

/** Datas de um atalho a partir de hoje ("AAAA-MM-DD" no fuso da plataforma); null para "Personalizado". */
export function presetRange(preset: PeriodPreset, today: string): PeriodRange | null {
  const month = today.slice(0, 7);
  switch (preset) {
    case 'default':
      return { from: '', to: '' };
    case '6m':
      return { from: `${addMonths(month, -5)}-01`, to: today };
    case '3m':
      return { from: `${addMonths(month, -2)}-01`, to: today };
    case 'month':
      return { from: `${month}-01`, to: today };
    case 'last-month': {
      const previous = addMonths(month, -1);
      return { from: `${previous}-01`, to: lastDayOfMonth(previous) };
    }
    case 'ytd':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    default:
      return null;
  }
}

/** Atalho que corresponde ao período (ex.: vindo do endereço da página); nenhum → "Personalizado". */
export function matchPreset(range: PeriodRange, today: string): PeriodPreset {
  if (!range.from && !range.to) return 'default';
  const match = PERIOD_PRESETS.find(({ value }) => {
    if (value === 'default' || value === 'custom') return false;
    const candidate = presetRange(value, today);
    return candidate?.from === range.from && candidate?.to === range.to;
  });
  return match?.value ?? 'custom';
}

/** Problema do período personalizado (null = válido), com as mesmas regras da API. */
export function periodError(range: PeriodRange): string | null {
  if (!range.from || !range.to) return 'Informe a data inicial e a final.';
  if (!isDateKey(range.from) || !isDateKey(range.to)) return 'Use datas válidas (dia/mês/ano).';
  if (range.from > range.to) return 'A data inicial não pode ser depois da data final.';
  const days = daysInRange(range.from, range.to);
  if (days !== null && days > FINANCE_MAX_DAYS) return `O período pode ter no máximo ${FINANCE_MAX_DAYS} dias (3 anos).`;
  return null;
}

/** Período do endereço da página (?de&ate); datas inválidas são ignoradas (vale o padrão da API). */
export function rangeFromParams(params: URLSearchParams): PeriodRange {
  const from = params.get('de') ?? '';
  const to = params.get('ate') ?? '';
  return {
    from: isDateKey(from) ? from : '',
    to: isDateKey(to) ? to : '',
  };
}
