// Regras das configurações da loja, iguais às do backend (store-rules.ts e UpdateStoreSettingsDto):
// a tela avisa antes de enviar, e a API continua validando tudo. Documento, telefone, CEP, e-mail e UF
// ficam em utils/validation (comuns a outras telas).

import { isValidEmail } from '../../utils/validation';

/** Tamanhos máximos dos campos de texto (mesmos do DTO). */
export const FIELD_LIMITS = {
  name: 120,
  legal_name: 160,
  email: 160,
  description: 300,
  address_street: 160,
  address_number: 20,
  address_complement: 80,
  address_neighborhood: 80,
  address_city: 80,
  message: 200,
  takeout_estimate: 20,
} as const;

export function tooLong(field: string, max: number): string {
  return `${field} pode ter no máximo ${max} caracteres.`;
}

/** Texto aparado ou null (campos opcionais: vazio limpa o valor gravado). */
export function optionalText(value: string): string | null {
  const text = value.trim();
  return text === '' ? null : text;
}

// ---------------------------------------------------------------------------
// Contato
// ---------------------------------------------------------------------------

export function emailError(value: string): string | null {
  const email = value.trim();
  if (!email) return null;
  if (email.length > FIELD_LIMITS.email) return `O e-mail da loja pode ter no máximo ${FIELD_LIMITS.email} caracteres.`;
  return isValidEmail(email) ? null : 'E-mail da loja inválido.';
}

// ---------------------------------------------------------------------------
// Identidade visual
// ---------------------------------------------------------------------------

export const HEX_COLOR_PATTERN = /^#[0-9A-F]{6}$/i;

export function colorError(value: string): string | null {
  const color = value.trim();
  if (!color) return null;
  return HEX_COLOR_PATTERN.test(color) ? null : 'Cor inválida. Use o formato #RRGGBB (ex.: #E11D48).';
}

// ---------------------------------------------------------------------------
// Fuso horário
// ---------------------------------------------------------------------------

const IANA_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/** Nome canônico do fuso ("america/sao_paulo" → "America/Sao_Paulo") ou null se o navegador não o reconhece. */
export function canonicalTimeZone(value: string): string | null {
  const zone = value.trim();
  if (!zone || zone.length > 64 || !IANA_TIME_ZONE.test(zone)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Zonas de entrega
// ---------------------------------------------------------------------------

export const ZONE_LIMITS = {
  zones: 50,
  neighborhoods: 200,
  cities: 20,
  zipRanges: 50,
  nameLength: 80,
  timeLength: 20,
  /** "22010-000 a 22099-999" */
  zipRangeLength: 25,
} as const;

/** Maior valor em dinheiro aceito pela API. */
export const MAX_MONEY = 99_999_999.99;

export interface ZoneInput {
  neighborhoods: string[];
  cities: string[];
  /** Faixas de CEP como digitadas (ex.: "22010-000 a 22099-999" ou um CEP só). */
  zipRanges: string[];
  fee: number;
  time: string;
}

/**
 * Faixa de CEP digitada: "22010-000 a 22099-999", "22010000-22099999" ou um CEP só (início = fim).
 * Inválida (outra quantidade de dígitos ou início depois do fim) → null.
 */
export function parseZipRange(text: string): { from: string; to: string } | null {
  const digits = text.replace(/\D/g, '');
  if (digits.length === 8) return { from: digits, to: digits };
  if (digits.length !== 16) return null;
  const from = digits.slice(0, 8);
  const to = digits.slice(8);
  return from <= to ? { from, to } : null;
}

const maskZip = (digits: string) => `${digits.slice(0, 5)}-${digits.slice(5)}`;

/** Texto exibido de uma faixa de CEP ("22010-000 a 22099-999"; um CEP só: "22010-000"). */
export function zipRangeLabel(range: { from: string; to: string }): string {
  return range.from === range.to ? maskZip(range.from) : `${maskZip(range.from)} a ${maskZip(range.to)}`;
}

/**
 * Mesmas regras de parseStoreDeliveryZones (mensagens equivalentes). null = válido.
 * fallback null = sem taxa para fora das zonas (só vale quando a loja recusa esses endereços).
 */
export function zonesError(
  fallback: { fee: number; time: string } | null,
  zones: ZoneInput[],
  outsideZones: 'fallback' | 'refuse' = 'fallback',
): string | null {
  if (outsideZones === 'fallback') {
    if (!fallback || !fallback.time.trim()) return 'Informe o prazo para bairros fora das zonas (ex.: 50-60 min).';
    if (fallback.time.trim().length > ZONE_LIMITS.timeLength) return `O prazo dos bairros fora das zonas pode ter no máximo ${ZONE_LIMITS.timeLength} caracteres.`;
    if (!(fallback.fee >= 0) || fallback.fee > MAX_MONEY) return 'Taxa inválida para os bairros fora das zonas.';
  } else if (zones.length === 0) {
    return 'Para recusar os endereços fora das zonas, cadastre pelo menos uma zona.';
  }
  if (zones.length > ZONE_LIMITS.zones) return `Cadastre no máximo ${ZONE_LIMITS.zones} zonas.`;

  for (const [index, zone] of zones.entries()) {
    const position = index + 1;
    if (zone.neighborhoods.length === 0 && zone.zipRanges.length === 0) {
      return `A zona ${position} precisa de pelo menos um bairro ou uma faixa de CEP.`;
    }
    const badRange = zone.zipRanges.find((range) => !parseZipRange(range));
    if (badRange) return `Faixa de CEP inválida na zona ${position}: "${badRange}". Use o formato 22010-000 a 22099-999 (ou um CEP só).`;
    if (zone.zipRanges.length > ZONE_LIMITS.zipRanges) return `A zona ${position} pode ter no máximo ${ZONE_LIMITS.zipRanges} faixas de CEP.`;
    if (zone.neighborhoods.length > ZONE_LIMITS.neighborhoods) return `A zona ${position} pode ter no máximo ${ZONE_LIMITS.neighborhoods} bairros.`;
    if (zone.cities.length > ZONE_LIMITS.cities) return `A zona ${position} pode ter no máximo ${ZONE_LIMITS.cities} cidades.`;
    if ([...zone.neighborhoods, ...zone.cities].some((name) => name.length > ZONE_LIMITS.nameLength)) {
      return `Os nomes de bairros e cidades da zona ${position} podem ter no máximo ${ZONE_LIMITS.nameLength} caracteres.`;
    }
    if (!zone.time.trim()) return `Informe o prazo da zona ${position} (ex.: 30-40 min).`;
    if (zone.time.trim().length > ZONE_LIMITS.timeLength) return `O prazo da zona ${position} pode ter no máximo ${ZONE_LIMITS.timeLength} caracteres.`;
    if (!(zone.fee >= 0) || zone.fee > MAX_MONEY) return `Taxa inválida na zona ${position}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Horários de funcionamento
// ---------------------------------------------------------------------------

/** Até 3 turnos por dia (21 no total). */
export const MAX_SHIFTS_PER_DAY = 3;
export const MAX_OPENING_HOURS_ENTRIES = 21;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTime(value: string): boolean {
  return HH_MM.test(value);
}

// ---------------------------------------------------------------------------
// Mercado Pago
// ---------------------------------------------------------------------------

/** Chave pública ou Access Token: APP_USR-... (produção) ou TEST-... (teste), sem espaços. */
export const MP_CREDENTIAL_PATTERN = /^(APP_USR|TEST)-[A-Za-z0-9_-]{8,}$/;

export type CredentialEnvironment = 'PRODUCTION' | 'TEST';

export function credentialEnvironment(value: string | null | undefined): CredentialEnvironment | null {
  const match = MP_CREDENTIAL_PATTERN.exec((value ?? '').trim());
  if (!match) return null;
  return match[1] === 'TEST' ? 'TEST' : 'PRODUCTION';
}
