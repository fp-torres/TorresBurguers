/** Formatações compartilhadas entre as telas (moeda, datas e valores digitados). */

export function formatPrice(value: number | string | null | undefined): string {
  const amount = Number(value);
  return (Number.isFinite(amount) ? amount : 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function toDate(value?: string | Date | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Ex.: "11/10/2026 19:42". */
export function formatDateTime(value?: string | Date | null): string {
  const date = toDate(value);
  if (!date) return '';
  return date.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Ex.: "19:42". */
export function formatTime(value?: string | Date | null): string {
  const date = toDate(value);
  if (!date) return '--:--';
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Fuso horário da loja: define o "hoje" dos indicadores, como na API (STORE_TIME_ZONE).
 * EXPO_PUBLIC_STORE_TIME_ZONE no .env; padrão America/Sao_Paulo.
 */
export const STORE_TIME_ZONE = process.env.EXPO_PUBLIC_STORE_TIME_ZONE?.trim() || 'America/Sao_Paulo';

/** Horário de Brasília (UTC-3, sem horário de verão desde 2019): reserva se o fuso não puder ser usado. */
const FALLBACK_OFFSET_MS = -3 * 60 * 60 * 1000;

let storeDayFormat: Intl.DateTimeFormat | null | undefined;

/** Dia (ano-mês-dia) da data no fuso da loja. */
function storeDayKey(date: Date): string {
  if (storeDayFormat === undefined) {
    try {
      storeDayFormat = new Intl.DateTimeFormat('en-CA', {
        timeZone: STORE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
      });
    } catch {
      storeDayFormat = null; // Fuso inválido ou Intl sem suporte a fusos
    }
  }
  if (storeDayFormat) return storeDayFormat.format(date);
  return new Date(date.getTime() + FALLBACK_OFFSET_MS).toISOString().slice(0, 10);
}

/** Verdadeiro quando a data cai no mesmo dia da referência no fuso da loja (não no do aparelho). */
export function isSameStoreDay(value: string | Date | null | undefined, reference = new Date()): boolean {
  const date = toDate(value);
  return !!date && storeDayKey(date) === storeDayKey(reference);
}

/**
 * Converte valores digitados ou gravados em texto ("50", "50,00", "R$ 1.234,56", "12.90")
 * para número. Textos sem dígitos (ex.: "Sem troco") viram 0.
 */
export function parseMoney(value: string | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (!value) return 0;
  const cleaned = String(value).replace(/[^\d,.-]/g, '');
  if (!/\d/.test(cleaned)) return 0;
  const normalized = cleaned.includes(',')
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : 0;
}

/** Primeiro nome para saudações ("Maria Silva" → "Maria"). */
export function firstName(name?: string | null): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}
