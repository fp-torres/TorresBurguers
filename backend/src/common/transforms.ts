/**
 * Conversores usados nos @Transform dos DTOs.
 *
 * Formulários multipart (FormData) enviam tudo como texto: "true", "29.90", "1,2",
 * campos repetidos viram array e um campo único vira string. Estes helpers normalizam
 * esses valores para os tipos esperados ANTES da validação. Valores que não dá para
 * converter são devolvidos como vieram (ou NaN), para o class-validator responder 400.
 *
 * Convenções do FormData: append(campo, undefined) envia "undefined" (tratado como ausente)
 * e append(campo, null) envia "null" (tratado como null, ou seja, limpar o campo).
 */

const TRUE_VALUES = ['true', '1', 'on', 'yes', 'sim'];
const FALSE_VALUES = ['false', '0', 'off', 'no', 'nao', 'não'];

/** Remove espaços das pontas de textos; outros tipos passam intactos. */
export function trimString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  return text === 'undefined' ? undefined : text;
}

/** Como trimString, mas texto vazio (ou "null") vira null: útil para limpar campos opcionais. */
export function emptyToNull(value: unknown): unknown {
  const text = trimString(value);
  return text === '' || text === 'null' ? null : text;
}

/** Remove acentos, espaços das pontas e deixa minúsculo ("Hambúrgueres " → "hamburgueres"). */
export function toSlug(value: unknown): unknown {
  const text = trimString(value);
  if (typeof text !== 'string') return text;
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Converte texto em número aceitando os formatos comuns no Brasil:
 * "29.9", "29,90", "R$ 29,90", "1.234,56" e "1,234.56". Inválido → NaN.
 */
export function parseDecimal(raw: string): number {
  let text = raw.trim().replace(/^R\$/i, '').replace(/\s+/g, '');
  if (!text) return NaN;

  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    // O separador que aparece por último é o decimal
    text =
      lastComma > lastDot
        ? text.replace(/\./g, '').replace(',', '.')
        : text.replace(/,/g, '');
  } else if (lastComma !== -1) {
    text = text.replace(',', '.');
  } else if (text.indexOf('.') !== lastDot) {
    text = text.replace(/\./g, ''); // vários pontos: separador de milhar ("1.234.567")
  }

  return /^-?(\d+(\.\d+)?|\.\d+)$/.test(text) ? Number(text) : NaN;
}

/** Número a partir de number ou texto. Vazio/"null" → null; "undefined" → ausente. */
export function toNumber(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (text === 'undefined') return undefined;
  if (text === '' || text === 'null') return null;
  return parseDecimal(text);
}

/** Arredonda em centavos sem o erro de ponto flutuante de Math.round(10.005 * 100). */
function roundCents(value: number): number {
  const text = String(value);
  if (text.includes('e')) return Math.round(value * 100) / 100;
  return Number(`${Math.round(Number(`${text}e2`))}e-2`);
}

/** Valor monetário: como toNumber, arredondado em 2 casas (o banco guarda numeric(10,2)). */
export function toMoney(value: unknown): unknown {
  const parsed = toNumber(value);
  return typeof parsed === 'number' && Number.isFinite(parsed)
    ? roundCents(parsed)
    : parsed;
}

/** Booleano a partir de true/false, "true"/"false", "1"/"0", "on"/"off", "sim"/"não". */
export function toBoolean(value: unknown): unknown {
  if (typeof value === 'number') {
    return value === 1 ? true : value === 0 ? false : value;
  }
  if (typeof value !== 'string') return value;
  const text = value.trim().toLowerCase();
  if (text === '' || text === 'undefined') return undefined;
  if (TRUE_VALUES.includes(text)) return true;
  if (FALSE_VALUES.includes(text)) return false;
  return value;
}

/** Quebra um texto de lista: JSON ('["a","b"]' / "[1,2]") ou separado por vírgula ("a, b"). */
function splitText(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === '[]') return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.flatMap((item: unknown) =>
          typeof item === 'string' ? item.split(',') : [item],
        );
      }
    } catch {
      // Não é JSON: segue como lista separada por vírgula
    }
  }
  return trimmed.split(',');
}

/**
 * Normaliza listas vindas de JSON ou FormData: array (campo repetido), texto JSON,
 * lista separada por vírgula ou valor único. null/"" → [] (lista vazia).
 * Devolve undefined para "campo ausente" e o valor original quando o tipo não é suportado.
 */
function toList(value: unknown): unknown[] | undefined | null {
  if (value === undefined || value === 'undefined') return undefined;
  if (value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown) =>
      typeof item === 'string' ? splitText(item) : [item],
    );
  }
  if (typeof value === 'string') return splitText(value);
  if (typeof value === 'number') return [value];
  return null; // tipo inesperado: deixa a validação reprovar
}

/** Lista de textos sem espaços nas pontas e sem itens vazios. */
export function toStringArray(value: unknown): unknown {
  const list = toList(value);
  if (list === undefined) return undefined;
  if (list === null) return value;
  return list
    .map((item) => (typeof item === 'string' ? item.trim() : item))
    .filter((item) => item !== '');
}

/**
 * Lista de ids numéricos ("12", "1,2", "[1,2]", ["1","2"], 12...).
 * Itens não numéricos viram NaN para o @IsInt({ each: true }) reprovar. Não remove repetidos.
 */
export function toIntArray(value: unknown): unknown {
  const list = toList(value);
  if (list === undefined) return undefined;
  if (list === null) return value;
  return list
    .map((item) => (typeof item === 'string' ? item.trim() : item))
    .filter((item) => item !== '')
    .map((item) =>
      typeof item === 'number'
        ? item
        : typeof item === 'string'
          ? Number(item)
          : NaN,
    );
}

/**
 * Referência de imagem salva no banco: nome de arquivo de /uploads ou URL http(s).
 * "/uploads/foto.webp" → "foto.webp"; vazio/"null" → null (remove a imagem).
 */
export function toImageRef(value: unknown): unknown {
  const text = emptyToNull(value);
  return typeof text === 'string' ? text.replace(/^\/?uploads\//, '') : text;
}

/** Nome de arquivo simples (sem pastas) ou URL http(s). */
export const IMAGE_REF_PATTERN = /^(https?:\/\/\S+|[\w-][\w.-]*)$/;

/** Cópia do objeto sem as chaves cujo valor é undefined (campos não enviados no PATCH). */
export function omitUndefined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
