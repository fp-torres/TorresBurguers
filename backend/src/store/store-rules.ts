/**
 * Regras puras das configurações da loja (sem banco, sem Nest): documento (CPF/CNPJ), fuso,
 * horários de funcionamento, zonas de entrega, credenciais do Mercado Pago e recursos do plano.
 * Cobertas por store-rules.spec.ts.
 */
import { FEATURE_LABELS } from '../billing/plan-limits.service';
import type { PlanFeatures } from '../billing/entities/plan.entity';
import {
  SubscriptionStatus,
  type Subscription,
} from '../billing/entities/subscription.entity';
import {
  parseDeliveryZones,
  parseOutsideZones,
  type StoreDeliveryZonesConfig,
} from '../orders/order-rules';
import { isProduction } from '../config/env';
import { resolvePaymentMode } from '../payment/payment-rules';
import type { OpeningHoursEntry } from './entities/store.entity';

// ---------------------------------------------------------------------------
// Documento: CPF (11 dígitos) ou CNPJ (14 caracteres, numérico ou alfanumérico)
// ---------------------------------------------------------------------------

/** Remove a pontuação digitada ("11.222.333/0001-81" → "11222333000181"); letras ficam maiúsculas. */
export function normalizeDocument(value: string): string {
  return value.replace(/[\s./-]/g, '').toUpperCase();
}

/** Dígito verificador no módulo 11 (resto < 2 → 0), comum ao CPF e ao CNPJ. */
function mod11Digit(values: number[], weights: number[]): number {
  const sum = values.reduce(
    (total, value, index) => total + value * weights[index],
    0,
  );
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

export function isValidCpf(value: string): boolean {
  if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false;
  const digits = [...value].map(Number);
  const first = mod11Digit(digits.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = mod11Digit(
    digits.slice(0, 10),
    [11, 10, 9, 8, 7, 6, 5, 4, 3, 2],
  );
  return first === digits[9] && second === digits[10];
}

const CNPJ_WEIGHTS = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

/**
 * CNPJ numérico ou alfanumérico (emitido pela Receita desde julho de 2026): as 12 primeiras posições
 * aceitam letras e números, os 2 dígitos verificadores são numéricos e cada caractere vale
 * (código ASCII − 48) no cálculo — para CNPJs só com números o resultado é o de sempre.
 */
export function isValidCnpj(value: string): boolean {
  if (!/^[0-9A-Z]{12}\d{2}$/.test(value) || /^(\d)\1{13}$/.test(value)) {
    return false;
  }
  const values = [...value].map((char) => char.charCodeAt(0) - 48);
  const first = mod11Digit(values.slice(0, 12), CNPJ_WEIGHTS.slice(1));
  const second = mod11Digit(values.slice(0, 13), CNPJ_WEIGHTS);
  return first === values[12] && second === values[13];
}

/** Mensagem do problema no documento já normalizado (null = válido). */
export function documentError(value: string): string | null {
  if (value.length === 11 && /^\d+$/.test(value)) {
    return isValidCpf(value) ? null : 'CPF inválido: confira os números.';
  }
  if (value.length === 14) {
    return isValidCnpj(value) ? null : 'CNPJ inválido: confira os números.';
  }
  return 'Documento inválido. Informe o CPF (11 dígitos) ou o CNPJ (14 caracteres).';
}

// ---------------------------------------------------------------------------
// Fuso horário
// ---------------------------------------------------------------------------

/** Nome IANA ("America/Sao_Paulo", "UTC"): recusa deslocamentos ("+03:00"), que o banco lê com outro sinal. */
const IANA_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/** Nome canônico do fuso (ex.: "america/sao_paulo" → "America/Sao_Paulo") ou null se inválido. */
export function canonicalTimeZone(value: string): string | null {
  const zone = value.trim();
  if (!zone || zone.length > 64 || !IANA_TIME_ZONE.test(zone)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Horários de funcionamento (informativos, exibidos na vitrine)
// ---------------------------------------------------------------------------

/** Até 3 turnos por dia. */
export const MAX_OPENING_HOURS_ENTRIES = 21;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Lê a lista [{ day, open, close }] (day 0 = domingo; close menor que open = vira a madrugada).
 * Devolve a lista ordenada por dia e horário; lista vazia ou null → null (sem horários).
 * Valor inválido → Error com a explicação.
 */
export function parseOpeningHours(raw: unknown): OpeningHoursEntry[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) {
    throw new Error('envie uma lista de { "day", "open", "close" }.');
  }
  if (raw.length > MAX_OPENING_HOURS_ENTRIES) {
    throw new Error(`informe no máximo ${MAX_OPENING_HOURS_ENTRIES} horários.`);
  }

  const seen = new Set<string>();
  const entries = raw.map((item: unknown, index): OpeningHoursEntry => {
    const position = index + 1;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(
        `o horário ${position} precisa de "day", "open" e "close".`,
      );
    }
    const { day, open, close } = item as Record<string, unknown>;
    if (
      typeof day !== 'number' ||
      !Number.isInteger(day) ||
      day < 0 ||
      day > 6
    ) {
      throw new Error(
        `"day" do horário ${position} precisa ser de 0 (domingo) a 6 (sábado).`,
      );
    }
    const opens = typeof open === 'string' ? open.trim() : '';
    const closes = typeof close === 'string' ? close.trim() : '';
    if (!HH_MM.test(opens) || !HH_MM.test(closes)) {
      throw new Error(
        `"open" e "close" do horário ${position} precisam estar no formato HH:MM (ex.: 18:00).`,
      );
    }
    if (opens === closes) {
      throw new Error(
        `o horário ${position} abre e fecha no mesmo horário (${opens}).`,
      );
    }
    const key = `${day}-${opens}-${closes}`;
    if (seen.has(key)) {
      throw new Error(
        `o horário ${position} repete outro horário do mesmo dia.`,
      );
    }
    seen.add(key);
    return { day, open: opens, close: closes };
  });

  entries.sort((a, b) => a.day - b.day || a.open.localeCompare(b.open));
  return entries.length ? entries : null;
}

// ---------------------------------------------------------------------------
// Zonas de entrega da loja
// ---------------------------------------------------------------------------

export const MAX_DELIVERY_ZONES = 50;
export const MAX_ZONE_NEIGHBORHOODS = 200;
export const MAX_ZONE_CITIES = 20;
export const MAX_ZONE_ZIP_RANGES = 50;
/** Mesmo tamanho do bairro/cidade gravado nos endereços da loja. */
export const MAX_ZONE_NAME_LENGTH = 80;
/** Prazo exibido (ex.: "40-50 min"). */
export const MAX_ZONE_TIME_LENGTH = 20;

/**
 * Zonas de entrega próprias da loja: { "zones": [...], "fallback": { "fee", "time" }, "outside_zones" },
 * validadas pelas mesmas regras do cálculo do frete (parseDeliveryZones). Cada zona tem bairros (com
 * cidades opcionais) e/ou faixas de CEP ("zip_ranges"). "outside_zones": "fallback" (padrão: endereço fora
 * das zonas paga o "fallback") ou "refuse" (a loja recusa a entrega fora das zonas). O "fallback" é
 * obrigatório, exceto com "refuse": o padrão da plataforma vale só para a loja padrão. Devolve a configuração
 * normalizada (aplicar de novo dá o mesmo resultado); null limpa. Inválido → Error com a explicação.
 */
export function parseStoreDeliveryZones(
  raw: unknown,
  options: { allowNoZones?: boolean } = {},
): StoreDeliveryZonesConfig | null {
  if (raw === null || raw === undefined) return null;

  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error('o texto enviado não é um JSON válido.');
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(
      'envie um objeto { "fallback": { "fee", "time" }, "zones": [...] }.',
    );
  }
  const { zones, fallback, outside_zones } = data as {
    zones?: unknown;
    fallback?: unknown;
    outside_zones?: unknown;
  };
  const policy = parseOutsideZones(outside_zones);
  const hasFallback = fallback !== undefined && fallback !== null;
  if (!hasFallback && policy !== 'refuse') {
    throw new Error(
      'informe em "fallback" a taxa e o prazo para bairros fora das zonas (ou recuse esses endereços com "outside_zones": "refuse").',
    );
  }
  if (Array.isArray(zones) && zones.length > MAX_DELIVERY_ZONES) {
    throw new Error(`cadastre no máximo ${MAX_DELIVERY_ZONES} zonas.`);
  }

  const config = parseDeliveryZones(data);
  // No modo por distância (allowNoZones) as faixas de km fazem o papel das zonas: a lista pode ficar vazia
  if (
    policy === 'refuse' &&
    config.zones.length === 0 &&
    !options.allowNoZones
  ) {
    throw new Error(
      'para recusar os endereços fora das zonas ("outside_zones": "refuse"), cadastre pelo menos uma zona.',
    );
  }

  const timeTooLong = (time: string) => time.length > MAX_ZONE_TIME_LENGTH;
  if (hasFallback && timeTooLong(config.fallback.time)) {
    throw new Error(
      `o prazo do "fallback" pode ter no máximo ${MAX_ZONE_TIME_LENGTH} caracteres.`,
    );
  }
  config.zones.forEach((zone, index) => {
    const position = index + 1;
    if (zone.neighborhoods.length > MAX_ZONE_NEIGHBORHOODS) {
      throw new Error(
        `a zona ${position} pode ter no máximo ${MAX_ZONE_NEIGHBORHOODS} bairros.`,
      );
    }
    if ((zone.cities?.length ?? 0) > MAX_ZONE_CITIES) {
      throw new Error(
        `a zona ${position} pode ter no máximo ${MAX_ZONE_CITIES} cidades.`,
      );
    }
    if ((zone.zip_ranges?.length ?? 0) > MAX_ZONE_ZIP_RANGES) {
      throw new Error(
        `a zona ${position} pode ter no máximo ${MAX_ZONE_ZIP_RANGES} faixas de CEP.`,
      );
    }
    const names = [...zone.neighborhoods, ...(zone.cities ?? [])];
    if (names.some((name) => name.length > MAX_ZONE_NAME_LENGTH)) {
      throw new Error(
        `os nomes de bairros e cidades da zona ${position} podem ter no máximo ${MAX_ZONE_NAME_LENGTH} caracteres.`,
      );
    }
    if (timeTooLong(zone.time)) {
      throw new Error(
        `o prazo da zona ${position} pode ter no máximo ${MAX_ZONE_TIME_LENGTH} caracteres.`,
      );
    }
  });
  return {
    zones: config.zones,
    ...(hasFallback ? { fallback: config.fallback } : {}),
    ...(policy ? { outside_zones: policy } : {}),
  };
}

// ---------------------------------------------------------------------------
// Credenciais do Mercado Pago da loja
// ---------------------------------------------------------------------------

export type MercadoPagoCredentialEnvironment = 'PRODUCTION' | 'TEST';

/** Chave pública ou Access Token: APP_USR-... (produção) ou TEST-... (teste), sem espaços. */
export const MERCADO_PAGO_CREDENTIAL_PATTERN =
  /^(APP_USR|TEST)-[A-Za-z0-9_-]{8,}$/;

/** Credencial de produção (APP_USR-...) ou de teste (TEST-...). Outro formato → null. */
export function mercadoPagoCredentialEnvironment(
  value: string,
): MercadoPagoCredentialEnvironment | null {
  const match = MERCADO_PAGO_CREDENTIAL_PATTERN.exec(value);
  if (!match) return null;
  return match[1] === 'TEST' ? 'TEST' : 'PRODUCTION';
}

/** Access Token da conta Mercado Pago da plataforma (MP_ACCESS_TOKEN): vale só para a loja padrão. */
export function platformAccessTokenConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !!env.MP_ACCESS_TOKEN?.trim();
}

/** Chave pública que acompanha o MP_ACCESS_TOKEN da plataforma (MP_PUBLIC_KEY). */
export function platformPublicKey(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return env.MP_PUBLIC_KEY?.trim() || null;
}

/** Ambiente de uma credencial já gravada/configurada: TEST-... é de teste; qualquer outra, de produção. */
export function credentialEnvironmentOf(
  value: string | null | undefined,
): MercadoPagoCredentialEnvironment | null {
  const text = value?.trim();
  if (!text) return null;
  return text.startsWith('TEST-') ? 'TEST' : 'PRODUCTION';
}

/**
 * A vitrine oferece PIX/cartão? Mesma regra da cobrança (PaymentService): recurso do plano e um
 * gateway utilizável — a credencial da própria loja ou, SÓ na loja padrão sem credencial própria, o
 * MP_ACCESS_TOKEN do ambiente; em produção, credencial de teste (TEST-) é recusada. Sem gateway,
 * só o sandbox de development/test (aprovações simuladas) libera.
 */
export function onlinePaymentsEnabled(input: {
  planAllows: boolean;
  /** Ambiente da credencial própria da loja (null = loja sem credencial). */
  storeCredential: MercadoPagoCredentialEnvironment | null;
  isDefaultStore: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = input.env ?? process.env;
  if (!input.planAllows) return false;
  const usable = (kind: MercadoPagoCredentialEnvironment | null) =>
    kind !== null && !(kind === 'TEST' && isProduction(env));
  const hasGateway =
    input.storeCredential !== null
      ? usable(input.storeCredential)
      : input.isDefaultStore &&
        usable(credentialEnvironmentOf(env.MP_ACCESS_TOKEN));
  return hasGateway || resolvePaymentMode(env).sandbox;
}

// ---------------------------------------------------------------------------
// Recursos do plano
// ---------------------------------------------------------------------------

export type StoreFeatures = Record<keyof PlanFeatures, boolean>;

/**
 * Recursos liberados pela assinatura vigente (cancelada não libera nada, como no PlanLimitsService).
 * Sempre devolve todas as chaves conhecidas, em booleano.
 */
export function featuresOf(
  subscription: Pick<Subscription, 'status' | 'plan'> | null | undefined,
): StoreFeatures {
  const features =
    subscription && subscription.status !== SubscriptionStatus.CANCELED
      ? subscription.plan?.features
      : undefined;
  return Object.fromEntries(
    Object.keys(FEATURE_LABELS).map((key) => [
      key,
      features?.[key as keyof PlanFeatures] === true,
    ]),
  ) as StoreFeatures;
}
