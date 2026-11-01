/**
 * Validação da assinatura das notificações do Mercado Pago (cabeçalho x-signature), sem Nest e sem
 * banco. Coberta por mercado-pago-signature.spec.ts.
 *
 * O Mercado Pago envia "x-signature: ts=<timestamp>,v1=<hmac>" e "x-request-id". O v1 é o
 * HMAC-SHA256 (hex), com o segredo da aplicação, do manifesto
 *   id:<data.id>;request-id:<x-request-id>;ts:<ts>;
 * em que data.id vem da URL da notificação (alfanumérico → minúsculas). Parte ausente na
 * notificação sai do manifesto (regra do Mercado Pago).
 */
import { createHmac } from 'crypto';
import { safeEqual } from '../common/crypto/secret-box';

/** Diferença máxima entre o ts da assinatura e o relógio do servidor (reenvio antigo = recusado). */
export const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

export interface MercadoPagoSignatureInput {
  /** Cabeçalho x-signature ("ts=...,v1=..."). */
  signature: unknown;
  /** Cabeçalho x-request-id. */
  requestId: unknown;
  /** data.id da notificação (query string ?data.id=). */
  dataId: unknown;
  secret: string;
  /** Agora, em ms (testes). */
  now?: number;
  toleranceMs?: number;
}

export type MercadoPagoSignatureResult =
  | { valid: true; timestampMs: number }
  | {
      valid: false;
      reason: 'missing' | 'malformed' | 'expired' | 'mismatch';
    };

function firstValue(value: unknown): string | null {
  const item: unknown = Array.isArray(value) ? value[0] : value;
  return typeof item === 'string' && item.trim() ? item.trim() : null;
}

/** "ts=1704908010,v1=abc..." → { ts, v1 } (null se faltar uma das partes). */
export function parseSignatureHeader(
  value: unknown,
): { ts: string; v1: string } | null {
  const text = firstValue(value);
  if (!text) return null;
  let ts: string | undefined;
  let v1: string | undefined;
  for (const part of text.split(',')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    const item = part.slice(index + 1).trim();
    if (key === 'ts') ts = item;
    else if (key === 'v1') v1 = item;
  }
  return ts && v1 ? { ts, v1 } : null;
}

/**
 * data.id como entra no manifesto: só letras, números, "-" e "_" (até 80); alfanumérico puro vai em
 * minúsculas. Qualquer outra coisa → null (notificação recusada).
 */
export function normalizeDataId(value: unknown): string | null {
  const raw: unknown = typeof value === 'number' ? String(value) : value;
  const text = firstValue(raw);
  if (!text || !/^[A-Za-z0-9_-]{1,80}$/.test(text)) return null;
  return /^[A-Za-z0-9]+$/.test(text) ? text.toLowerCase() : text;
}

export function signatureManifest(
  dataId: string,
  requestId: string | null,
  ts: string,
): string {
  return `id:${dataId};${requestId ? `request-id:${requestId};` : ''}ts:${ts};`;
}

export function signMercadoPagoManifest(
  manifest: string,
  secret: string,
): string {
  return createHmac('sha256', secret).update(manifest, 'utf8').digest('hex');
}

/**
 * Confere o x-signature: HMAC do manifesto com o segredo (comparação em tempo constante) e o ts
 * dentro da tolerância. ts em segundos ou milissegundos.
 */
export function verifyMercadoPagoSignature(
  input: MercadoPagoSignatureInput,
): MercadoPagoSignatureResult {
  const header = parseSignatureHeader(input.signature);
  const dataId = normalizeDataId(input.dataId);
  if (!input.secret || !header || !dataId) {
    return { valid: false, reason: 'missing' };
  }
  if (!/^\d{1,16}$/.test(header.ts) || !/^[0-9a-f]{64}$/i.test(header.v1)) {
    return { valid: false, reason: 'malformed' };
  }

  const expected = signMercadoPagoManifest(
    signatureManifest(dataId, firstValue(input.requestId), header.ts),
    input.secret,
  );
  if (!safeEqual(expected, header.v1.toLowerCase())) {
    return { valid: false, reason: 'mismatch' };
  }

  const ts = Number(header.ts);
  const timestampMs = ts < 1e12 ? ts * 1000 : ts;
  const now = input.now ?? Date.now();
  if (
    Math.abs(now - timestampMs) > (input.toleranceMs ?? SIGNATURE_TOLERANCE_MS)
  ) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, timestampMs };
}
