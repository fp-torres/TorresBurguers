import { currencyToNumber } from '../../../../utils/masks';
import { toMoneyInput } from '../../../../utils/catalog';
import { formatCurrency } from '../../../../utils/format';
import { DEFAULT_ROUTE_FACTOR, type DistanceBand, type DistanceSettings, type OrderValueRules } from '../../../../services/storeSettingsService';
import { MAX_MONEY, ZONE_LIMITS } from '../../validation';

// Entrega por distância no painel (Configurações › Entrega): rascunho da tela ↔ formato da API e validação.
// Mesmas regras da API (backend/src/orders/delivery-distance.ts), com mensagens para o dono da loja.

export const MAX_DISTANCE_BANDS = 20;
export const MAX_DELIVERY_KM = 100;
export const MIN_ROUTE_FACTOR = 1;
export const MAX_ROUTE_FACTOR = 3;

/** Faixa como digitada ("2,5" km; "R$ 5,00"). */
export interface BandDraft {
  /** Identificador estável na tela. */
  key: number;
  upToKm: string;
  fee: string;
  time: string;
  /** Pedido mínimo e frete grátis próprios da faixa ("" = os da loja). */
  minOrder: string;
  freeAbove: string;
}

export interface DistanceDraft {
  bands: BandDraft[];
  /** Cobrar por km adicional além da última faixa, até o raio máximo. */
  extraEnabled: boolean;
  maxKm: string;
  extraFee: string;
  /** Fator sobre a linha reta ("1,3"). */
  routeFactor: string;
  /** Distância real pelas ruas (só quando a plataforma oferece). */
  road: boolean;
}

let bandKeySequence = 0;
function nextBandKey(): number {
  bandKeySequence += 1;
  return bandKeySequence;
}

export function emptyBand(upToKm = ''): BandDraft {
  return { key: nextBandKey(), upToKm, fee: '', time: '', minOrder: '', freeAbove: '' };
}

/** Número digitado com vírgula ou ponto ("2,5" → 2.5); vazio ou inválido → NaN. */
export function parseDecimal(text: string): number {
  const clean = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(clean)) return Number.NaN;
  return Number(clean);
}

/** 2.5 → "2,5" (para os campos de km, fator e coordenadas). */
export function decimalText(value: number | null | undefined, maxDigits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return value.toLocaleString('pt-BR', { maximumFractionDigits: maxDigits, useGrouping: false });
}

/** Sugestão ao ligar o modo pela primeira vez: os km (como no exemplo da ajuda); taxa e prazo em branco. */
export function newDistanceDraft(): DistanceDraft {
  return {
    bands: [emptyBand('2'), emptyBand('5'), emptyBand('8')],
    extraEnabled: false,
    maxKm: '',
    extraFee: '',
    routeFactor: decimalText(DEFAULT_ROUTE_FACTOR),
    road: false,
  };
}

export function distanceDraftFrom(settings: DistanceSettings | undefined): DistanceDraft | null {
  if (!settings) return null;
  return {
    bands: settings.bands.map((band) => ({
      key: nextBandKey(),
      upToKm: decimalText(band.up_to_km),
      fee: toMoneyInput(band.fee),
      time: band.time,
      minOrder: toMoneyInput(band.min_order),
      freeAbove: toMoneyInput(band.free_delivery_above),
    })),
    extraEnabled: settings.max_km !== undefined && settings.extra_km_fee !== undefined,
    maxKm: decimalText(settings.max_km),
    extraFee: toMoneyInput(settings.extra_km_fee),
    routeFactor: decimalText(settings.route_factor),
    road: settings.road_distance === true,
  };
}

const moneyOrUndefined = (text: string) => (text.trim() === '' ? undefined : currencyToNumber(text));
const round2 = (value: number) => Math.round(value * 100) / 100;

function bandRules(band: BandDraft): OrderValueRules {
  const minOrder = moneyOrUndefined(band.minOrder);
  const freeAbove = moneyOrUndefined(band.freeAbove);
  return {
    ...(minOrder !== undefined ? { min_order: minOrder } : {}),
    ...(freeAbove !== undefined ? { free_delivery_above: freeAbove } : {}),
  };
}

/** Formato da API, na mesma ordem de chaves que a tela lê da resposta (para comparar com o salvo). */
export function toDistanceConfig(draft: DistanceDraft): DistanceSettings {
  const factor = parseDecimal(draft.routeFactor);
  const maxKm = parseDecimal(draft.maxKm);
  return {
    bands: draft.bands.map(
      (band): DistanceBand => ({
        up_to_km: round2(parseDecimal(band.upToKm)),
        fee: currencyToNumber(band.fee),
        time: band.time.trim(),
        ...bandRules(band),
      }),
    ),
    ...(draft.extraEnabled ? { max_km: round2(maxKm), extra_km_fee: currencyToNumber(draft.extraFee) } : {}),
    route_factor: Number.isFinite(factor) ? round2(factor) : DEFAULT_ROUTE_FACTOR,
    ...(draft.road ? { road_distance: true as const } : {}),
  };
}

/** Primeiro problema das faixas (mensagem para a tela) ou null. */
export function distanceError(draft: DistanceDraft): string | null {
  if (draft.bands.length === 0) return 'Cadastre pelo menos uma faixa de distância.';
  if (draft.bands.length > MAX_DISTANCE_BANDS) return `Cadastre no máximo ${MAX_DISTANCE_BANDS} faixas de distância.`;
  let previous = 0;
  for (const [index, band] of draft.bands.entries()) {
    const position = index + 1;
    const km = parseDecimal(band.upToKm);
    if (!(km > 0) || km > MAX_DELIVERY_KM) return `Informe até quantos km vai a faixa ${position} (de 0,1 a ${MAX_DELIVERY_KM} km).`;
    if (index > 0 && km <= previous) {
      return `As faixas precisam ir em ordem crescente: a faixa ${position} (até ${decimalText(km)} km) precisa ir além da faixa ${index} (até ${decimalText(previous)} km).`;
    }
    previous = km;
    if (currencyToNumber(band.fee) > MAX_MONEY) return `Taxa inválida na faixa ${position}.`;
    if (!band.time.trim()) return `Informe o prazo da faixa ${position} (ex.: 30-40 min).`;
    if (band.time.trim().length > ZONE_LIMITS.timeLength) return `O prazo da faixa ${position} pode ter no máximo ${ZONE_LIMITS.timeLength} caracteres.`;
    const rules = bandRules(band);
    if ((rules.min_order ?? 0) > MAX_MONEY || (rules.free_delivery_above ?? 0) > MAX_MONEY) {
      return `O pedido mínimo e o frete grátis da faixa ${position} podem ser de no máximo ${formatCurrency(MAX_MONEY)}.`;
    }
  }
  if (draft.extraEnabled) {
    const maxKm = parseDecimal(draft.maxKm);
    if (!(maxKm > previous) || maxKm > MAX_DELIVERY_KM) {
      return `O raio máximo precisa ser maior que a última faixa (${decimalText(previous)} km) e de no máximo ${MAX_DELIVERY_KM} km.`;
    }
    const fee = currencyToNumber(draft.extraFee);
    if (!(fee > 0) || fee > MAX_MONEY) return 'Informe o valor cobrado por km adicional (maior que zero).';
  }
  const factor = parseDecimal(draft.routeFactor);
  if (!(factor >= MIN_ROUTE_FACTOR && factor <= MAX_ROUTE_FACTOR)) {
    return `O fator de rota precisa ser um número de ${decimalText(MIN_ROUTE_FACTOR)} a ${decimalText(MAX_ROUTE_FACTOR)} (padrão ${decimalText(DEFAULT_ROUTE_FACTOR)}).`;
  }
  return null;
}

/** Raio máximo de entrega do rascunho (km) ou null quando ainda inválido. */
export function draftMaxKm(draft: DistanceDraft): number | null {
  const last = parseDecimal(draft.bands[draft.bands.length - 1]?.upToKm ?? '');
  const max = draft.extraEnabled ? parseDecimal(draft.maxKm) : last;
  return Number.isFinite(max) && max > 0 ? max : null;
}

/** Avisos (não bloqueiam): frete grátis da faixa menor que o pedido mínimo que vale nela. */
export function distanceWarnings(draft: DistanceDraft, store: OrderValueRules): string[] {
  const warnings: string[] = [];
  draft.bands.forEach((band, index) => {
    const own = bandRules(band);
    if (own.min_order === undefined && own.free_delivery_above === undefined) return;
    const minOrder = own.min_order ?? store.min_order;
    const freeAbove = own.free_delivery_above ?? store.free_delivery_above;
    if (minOrder !== undefined && minOrder > 0 && freeAbove !== undefined && freeAbove < minOrder) {
      warnings.push(`Faixa ${index + 1}: o frete grátis (${formatCurrency(freeAbove)}) é menor que o pedido mínimo (${formatCurrency(minOrder)}), então todo pedido aceito já terá frete grátis.`);
    }
  });
  return warnings;
}

// ---------------------------------------------------------------------------
// Local da loja (latitude e longitude)
// ---------------------------------------------------------------------------

export interface LocationDraft {
  latitude: string;
  longitude: string;
}

export function locationDraftFrom(latitude: number | null, longitude: number | null): LocationDraft {
  return { latitude: decimalText(latitude, 6), longitude: decimalText(longitude, 6) };
}

/** Coordenadas do rascunho: { latitude, longitude } válidas, ambas null (vazias) ou "invalid". */
export function parseLocation(draft: LocationDraft): { latitude: number; longitude: number } | { latitude: null; longitude: null } | 'invalid' {
  const latText = draft.latitude.trim();
  const lngText = draft.longitude.trim();
  if (!latText && !lngText) return { latitude: null, longitude: null };
  const latitude = parseDecimal(latText);
  const longitude = parseDecimal(lngText);
  if (!(Math.abs(latitude) <= 90) || !(Math.abs(longitude) <= 180) || (latitude === 0 && longitude === 0)) return 'invalid';
  return { latitude: Math.round(latitude * 1e6) / 1e6, longitude: Math.round(longitude * 1e6) / 1e6 };
}

export const LOCATION_INVALID_MESSAGE = 'Latitude e longitude inválidas: use números como -22,9035 e -43,2096 (ou localize pelo endereço).';
export const LOCATION_REQUIRED_MESSAGE = 'Para cobrar por distância, informe o local da loja: localize pelo endereço ou marque no mapa.';

/** Link "ver no mapa" (OpenStreetMap, nova aba). */
export function mapLink(latitude: number, longitude: number): string {
  return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=17/${latitude}/${longitude}`;
}
