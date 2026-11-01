import { BRAND } from '../config/brand';
import type { OpeningHoursEntry, StoreAddress } from './publicStoreService';

// Apresentação dos dados públicos da loja na vitrine: horários, endereço, telefone e a cor da marca.
// Funções puras (sem React), usadas pelo cabeçalho, rodapé, cardápio e checkout.

// ---------------------------------------------------------------------------
// Dias e horários (no fuso da loja)
// ---------------------------------------------------------------------------

export const WEEKDAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
export const WEEKDAY_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

/** Ordem de exibição da semana: segunda a domingo. */
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Dia da semana (0 = domingo) agora, no fuso da loja — o mesmo "hoje" que a API usa. */
export function weekdayInTimeZone(timeZone: string, date: Date = new Date()): number {
  try {
    const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }).format(date);
    if (Object.hasOwn(WEEKDAY_INDEX, day)) return WEEKDAY_INDEX[day];
  } catch {
    // Fuso desconhecido pelo navegador: usa o relógio local
  }
  return date.getDay();
}

/** "18:00 às 23:00"; fechando de madrugada: "18:00 às 02:00 (madrugada)". */
export function formatHoursRange(entry: Pick<OpeningHoursEntry, 'open' | 'close'>): string {
  const overnight = entry.close < entry.open;
  return `${entry.open} às ${entry.close}${overnight ? ' (madrugada)' : ''}`;
}

/** Faixas de horário de um dia, já formatadas (vazio = fechado). */
function rangesOf(entries: OpeningHoursEntry[], day: number): string[] {
  return entries.filter((entry) => entry.day === day).map(formatHoursRange);
}

export interface OpeningHoursLine {
  /** Dias do grupo: "Segunda a Sexta", "Sábado e Domingo" ou "Terça". */
  days: string;
  /** Horários do grupo ("18:00 às 23:00 · 11:30 às 14:30") ou "Fechado". */
  hours: string;
  closed: boolean;
  /** Dias (0 = domingo) cobertos pela linha. */
  dayIndexes: number[];
}

/**
 * Horários agrupados para exibição (segunda a domingo), juntando dias seguidos com os mesmos horários.
 * Ex.: [{ days: 'Terça a Sexta', hours: '18:00 às 23:00' }, { days: 'Segunda', hours: 'Fechado' }].
 * Sem horários cadastrados → lista vazia.
 */
export function groupOpeningHours(entries: OpeningHoursEntry[]): OpeningHoursLine[] {
  if (entries.length === 0) return [];
  const lines: OpeningHoursLine[] = [];

  for (const day of DISPLAY_ORDER) {
    const ranges = rangesOf(entries, day);
    const hours = ranges.length > 0 ? ranges.join(' · ') : 'Fechado';
    const previous = lines[lines.length - 1];
    if (previous && previous.hours === hours) {
      previous.dayIndexes.push(day);
    } else {
      lines.push({ days: '', hours, closed: ranges.length === 0, dayIndexes: [day] });
    }
  }

  for (const line of lines) {
    const first = WEEKDAY_NAMES[line.dayIndexes[0]];
    const last = WEEKDAY_NAMES[line.dayIndexes[line.dayIndexes.length - 1]];
    if (line.dayIndexes.length === 1) line.days = first;
    else if (line.dayIndexes.length === 2) line.days = `${first} e ${last}`;
    else line.days = `${first} a ${last}`;
  }
  return lines;
}

/**
 * Resumo de hoje no fuso da loja para o cabeçalho: "Hoje: 18:00 às 23:00", "Fechado hoje"
 * ou null quando a loja não cadastrou horários.
 */
export function todayHoursSummary(entries: OpeningHoursEntry[], timeZone: string, date: Date = new Date()): string | null {
  if (entries.length === 0) return null;
  const ranges = rangesOf(entries, weekdayInTimeZone(timeZone, date));
  return ranges.length > 0 ? `Hoje: ${ranges.join(' · ')}` : 'Fechado hoje';
}

// ---------------------------------------------------------------------------
// Endereço e contato
// ---------------------------------------------------------------------------

/** CEP com máscara: "20040003" → "20040-003". */
export function formatZipCode(zip: string | null | undefined): string | null {
  const digits = (zip ?? '').replace(/\D/g, '');
  if (digits.length !== 8) return zip?.trim() || null;
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

export interface AddressLines {
  /** "Av. Rio Branco, 156 - Loja B" */
  street: string | null;
  /** "Centro, Rio de Janeiro - RJ" */
  area: string | null;
  /** "CEP 20040-003" */
  zip: string | null;
}

/** Linhas do endereço da loja; null quando nada foi cadastrado. */
export function storeAddressLines(address: StoreAddress): AddressLines | null {
  const streetBase = [address.street, address.number].filter(Boolean).join(', ');
  const street = streetBase ? [streetBase, address.complement].filter(Boolean).join(' - ') : null;
  const city = [address.city, address.state].filter(Boolean).join(' - ');
  const area = [address.neighborhood, city].filter(Boolean).join(', ') || null;
  const zipCode = formatZipCode(address.zip_code);
  const zip = zipCode ? `CEP ${zipCode}` : null;
  if (!street && !area && !zip) return null;
  return { street, area, zip };
}

/** Busca do endereço da loja no Google Maps (null sem rua ou cidade). */
export function storeMapUrl(address: StoreAddress): string | null {
  const parts = [
    [address.street, address.number].filter(Boolean).join(', '),
    address.neighborhood,
    [address.city, address.state].filter(Boolean).join(' - '),
  ].filter(Boolean);
  if (!address.street && !address.city) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts.join(', '))}`;
}

/** Telefone para exibir: "(21) 99999-9999"; formatos desconhecidos aparecem como vieram. */
export function formatStorePhone(phone: string | null | undefined): string | null {
  const value = phone?.trim();
  if (!value) return null;
  const digits = value.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return value;
}

/** Link tel: (null se não houver dígitos suficientes). */
export function phoneHref(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 8 ? `tel:${digits.length === 10 || digits.length === 11 ? `+55${digits}` : digits}` : null;
}

// ---------------------------------------------------------------------------
// Cor da marca da loja (tokens CSS --store-brand-*, ver src/index.css)
// ---------------------------------------------------------------------------

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Cor #RRGGBB válida (em minúsculas) ou null. */
export function normalizeHexColor(value: unknown): string | null {
  return typeof value === 'string' && HEX_COLOR.test(value.trim()) ? value.trim().toLowerCase() : null;
}

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

/** Mistura duas cores (t = 0 → a; t = 1 → b). */
function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map((index) => a[index] + (b[index] - a[index]) * t) as Rgb;
}

/** Luminância relativa (WCAG). */
function luminance([r, g, b]: Rgb): number {
  const linear = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** Contraste WCAG entre duas cores (1 a 21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const DARK_TEXT = '#111827';
/** Fundo mais claro do tema escuro em que o texto da marca aparece (slate-800). */
const DARK_SURFACE = '#1e293b';

/** Aproxima a cor de `towards` até atingir o contraste mínimo com `background`. */
function adjustForContrast(base: Rgb, towards: Rgb, background: string, minimum: number): string {
  for (let step = 0; step <= 20; step++) {
    const candidate = rgbToHex(mix(base, towards, step / 20));
    if (contrastRatio(candidate, background) >= minimum) return candidate;
  }
  return rgbToHex(towards);
}

/**
 * Variáveis CSS da cor da loja (aplicadas no <html> pela vitrine). Cor ausente ou inválida → null
 * (valem os valores padrão do laranja da plataforma definidos em src/index.css).
 * - --store-brand: fundo de botões e selos; --store-brand-hover: o mesmo, mais escuro;
 * - --store-brand-contrast: texto sobre a cor (branco ou quase preto, o que for legível);
 * - --store-brand-ink / --store-brand-ink-dark: texto na cor da loja sobre fundo claro / escuro (contraste AA).
 */
export function brandCssVariables(color: unknown): Record<string, string> | null {
  const hex = normalizeHexColor(color);
  if (!hex) return null;
  const rgb = hexToRgb(hex);
  return {
    '--store-brand': hex,
    '--store-brand-hover': rgbToHex(mix(rgb, BLACK, 0.15)),
    // Branco como no laranja da plataforma, salvo em cores claras (amarelo, verde-limão...)
    '--store-brand-contrast': contrastRatio(hex, '#ffffff') >= 3 ? '#ffffff' : DARK_TEXT,
    '--store-brand-ink': adjustForContrast(rgb, BLACK, '#ffffff', 4.5),
    '--store-brand-ink-dark': adjustForContrast(rgb, WHITE, DARK_SURFACE, 4.5),
  };
}

/** Cor da barra do navegador no celular (<meta name="theme-color">): a da loja ou a da plataforma. */
export function themeColorFor(color: unknown): string {
  return normalizeHexColor(color) ?? BRAND.color;
}
