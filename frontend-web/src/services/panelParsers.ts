// Leitura defensiva das respostas das rotas novas do painel da loja: campos ausentes ou de outro
// tipo viram valores seguros, para que uma mudança no formato da API não quebre a tela inteira.

export type RawRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** O objeto recebido ou {} (nunca null). */
export function asRecord(value: unknown): RawRecord {
  return isRecord(value) ? value : {};
}

export function readText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Texto não vazio ou null. */
export function readNullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Número (ou texto numérico, como os decimais do Postgres) ou o valor padrão. */
export function readNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/** Número ou null (null, vazio ou inválido). Usado nos limites dos planos: null = ilimitado. */
export function readNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Id positivo ou 0. */
export function readId(value: unknown): number {
  const parsed = readNumber(value, 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/** Data ISO (texto) ou null. */
export function readDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

export function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Lista de textos (itens que não são texto são descartados). */
export function readTextList(value: unknown): string[] {
  return readArray(value).filter((item): item is string => typeof item === 'string');
}

/** Valor de uma lista fechada; fora dela, o valor padrão. */
export function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((item) => item === value) ?? fallback;
}
