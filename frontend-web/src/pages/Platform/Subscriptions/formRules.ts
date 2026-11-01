// Validações dos formulários da cobrança no superpainel (as mesmas regras dos DTOs da API: a tela avisa antes
// de enviar e a API continua validando tudo).

export interface ReasonRules {
  required?: boolean;
  minLength?: number;
  maxLength?: number;
}

/** Problema do texto do motivo/observação (null = válido). */
export function reasonProblem(value: string, { required = false, minLength = 0, maxLength = 300 }: ReasonRules = {}): string | null {
  const text = value.trim();
  if (!text) return required ? 'Informe o motivo.' : null;
  if (text.length < minLength) return `Descreva com pelo menos ${minLength} caracteres.`;
  if (text.length > maxLength) return `Use no máximo ${maxLength} caracteres.`;
  return null;
}

/**
 * Valor em reais digitado ("99,90", "1.234,56", "99.9", "R$ 10") → número com 2 casas; vazio → null;
 * inválido → NaN. Mesma leitura do toMoney da API.
 */
export function parseMoneyInput(value: string): number | null {
  let text = value.trim().replace(/^R\$/i, '').replace(/\s+/g, '');
  if (!text) return null;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    text = lastComma > lastDot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else if (lastComma !== -1) {
    text = text.replace(',', '.');
  } else if (text.indexOf('.') !== lastDot) {
    text = text.replace(/\./g, '');
  }
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(text)) return Number.NaN;
  return Math.round(Number(text) * 100) / 100;
}

/** Número em reais para o campo de texto: 99.9 → "99,90". */
export function moneyToInput(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return value.toFixed(2).replace('.', ',');
}

/**
 * "AAAA-MM-DD" de um input type=date → instante ISO no horário local: início do dia ('start', padrão) ou
 * fim do dia ('end', ex.: vencimento). null se vazio/inválido.
 */
export function dateInputToIso(value: string, edge: 'start' | 'end' = 'start'): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const date = edge === 'start' ? new Date(year, month, day) : new Date(year, month, day, 23, 59, 59, 999);
  return Number.isNaN(date.getTime()) || date.getDate() !== day ? null : date.toISOString();
}

/** "AAAA-MM-DDTHH:mm" de um input type=datetime-local → instante ISO (null se vazio/inválido). */
export function dateTimeInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Instante → valor de um input type=datetime-local no fuso do navegador ("2026-10-11T15:00"). */
export function toDateTimeInput(time: number): string {
  const date = new Date(time);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
