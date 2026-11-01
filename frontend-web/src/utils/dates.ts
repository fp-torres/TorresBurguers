// Datas em pt-BR (independentes do idioma do navegador), usadas pelo painel da loja, pelo superpainel e pela conta.
// O instante atual que se atualiza sozinho fica em hooks/useNow.ts.

export type DateInput = string | number | Date | null | undefined;

const dateFormatter = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dayMonthFormatter = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
const dateKeyFormatter = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
const weekdayKeyFormatter = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', timeZone: 'UTC' });

const DAY_MS = 86_400_000;
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Date válida a partir de texto ISO, milissegundos ou Date (null se vazio ou inválido). */
export function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Instante em milissegundos (null se vazio ou inválido). */
export function timeOf(value: DateInput): number | null {
  return toDate(value)?.getTime() ?? null;
}

/** Data (sem hora) no fuso do navegador: "11/10/2026". Vazio ou inválido → "—". */
export function formatDate(value: DateInput): string {
  const date = toDate(value);
  return date ? dateFormatter.format(date) : '—';
}

/** Dias inteiros até a data (arredondado para cima; 0 = hoje ou já passou). */
export function daysUntil(value: DateInput, now: number): number | null {
  const date = toDate(value);
  if (!date) return null;
  return Math.max(0, Math.ceil((date.getTime() - now) / DAY_MS));
}

// --- DIAS DO CALENDÁRIO DA LOJA ("AAAA-MM-DD", sem fuso: como os relatórios da API) ---

/** "2026-10-11" → instante UTC da meia-noite (null se inválido). */
function keyToUtc(key: string): number | null {
  const match = DATE_KEY.exec(key);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, day);
  const check = new Date(time);
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day ? time : null;
}

function utcToKey(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** Texto no formato "AAAA-MM-DD" com uma data que existe no calendário. */
export function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && keyToUtc(value) !== null;
}

/** "2026-10-11" → "11/10/2026". */
export function formatDateKey(key: string): string {
  const time = keyToUtc(key);
  return time === null ? key : dateKeyFormatter.format(time);
}

/** "2026-10-11" → "11/10" (eixos dos gráficos). */
export function shortDateKey(key: string): string {
  const time = keyToUtc(key);
  return time === null ? key : dayMonthFormatter.format(time);
}

/** "2026-10-11" → "sáb." */
export function weekdayOfKey(key: string): string {
  const time = keyToUtc(key);
  return time === null ? '' : weekdayKeyFormatter.format(time);
}

/** Soma dias a uma data "AAAA-MM-DD". */
export function addDaysToKey(key: string, days: number): string {
  const time = keyToUtc(key);
  return time === null ? key : utcToKey(time + days * DAY_MS);
}

/** Quantidade de dias de `from` até `to`, contando os dois (null se alguma data for inválida). */
export function daysInRange(from: string, to: string): number | null {
  const start = keyToUtc(from);
  const end = keyToUtc(to);
  if (start === null || end === null) return null;
  return Math.round((end - start) / DAY_MS) + 1;
}

/** Primeiro dia do mês de uma data "AAAA-MM-DD". */
export function monthStartKey(key: string): string {
  return DATE_KEY.test(key) ? `${key.slice(0, 8)}01` : key;
}

/** Dia de hoje no fuso do navegador, como "AAAA-MM-DD". */
export function todayKey(now: number): string {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Dia de hoje no fuso informado (ex.: o da loja), como "AAAA-MM-DD"; fuso inválido → fuso do navegador. */
export function todayKeyInZone(now: number, timeZone: string | null | undefined): string {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
      const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
      const key = `${part('year')}-${part('month')}-${part('day')}`;
      if (isDateKey(key)) return key;
    } catch {
      // Fuso desconhecido pelo navegador: usa o local
    }
  }
  return todayKey(now);
}
