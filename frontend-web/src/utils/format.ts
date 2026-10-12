// --- FORMATADORES FIXOS EM pt-BR ---
// Não dependem do idioma do navegador (um navegador em inglês mostraria "1:05 PM").

const currencyFormatter = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const timeFormatter = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dateTimeFormatter = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

type DateInput = string | number | Date | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Valor em reais: 25.9 → "R$ 25,90". Valores inválidos viram R$ 0,00. */
export function formatCurrency(value: number | string | null | undefined): string {
  const amount = Number(value);
  return currencyFormatter.format(Number.isFinite(amount) ? amount : 0);
}

/** Hora e minuto: "13:05". */
export function formatTime(value: DateInput): string {
  const date = toDate(value);
  return date ? timeFormatter.format(date) : '--:--';
}

/** Data e hora: "11/10/2026, 13:05". */
export function formatDateTime(value: DateInput): string {
  const date = toDate(value);
  return date ? dateTimeFormatter.format(date) : '-';
}

/**
 * Converte um valor em dinheiro salvo como texto em número:
 * "R$ 1.234,56", "50,5", "50.00" e "50" (mesma regra do backend). Inválido → 0.
 * Para o texto de um campo com máscara use currencyToNumber (utils/masks).
 */
export function parseMoney(value: number | string | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (!value) return 0;

  let text = value.replace(/R\$/i, '').replace(/\s+/g, '');
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');

  if (lastComma !== -1 && lastDot !== -1) {
    // O separador que aparece por último é o decimal
    text = lastComma > lastDot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else if (lastComma !== -1) {
    text = text.replace(',', '.');
  } else if (text.indexOf('.') !== lastDot) {
    text = text.replace(/\./g, ''); // vários pontos: separador de milhar
  }

  const amount = Number(text);
  return Number.isFinite(amount) ? amount : 0;
}
