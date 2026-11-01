import { timingSafeEqual } from 'node:crypto';
import { randomToken, sha256Hex } from '../common/crypto/secret-box';

/**
 * Refresh da sessão do site (cookie HttpOnly): "v1.<seletor>.<validador>".
 * - seletor: 16 bytes aleatórios (base64url, 22 caracteres), constante durante a vida da sessão e
 *   secreto; acha a linha de auth_sessions pelo índice único;
 * - validador: 32 bytes aleatórios (base64url, 43 caracteres), trocado a cada renovação. O banco
 *   guarda só o SHA-256 dele (refresh_hash e, por alguns segundos, refresh_prev_hash).
 */
export const REFRESH_TOKEN_VERSION = 'v1';
const SELECTOR_BYTES = 16;
const VALIDATOR_BYTES = 32;
const REFRESH_TOKEN_PATTERN = /^v1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface RefreshToken {
  selector: string;
  validator: string;
  /** SHA-256 (hex) do validador: o que vai para o banco. */
  hash: string;
  /** Valor do cookie. Nunca vai para corpo de resposta, log ou auditoria. */
  token: string;
}

/** Refresh novo. Com `selector` (renovação), mantém o seletor da sessão e troca só o validador. */
export function createRefreshToken(selector?: string): RefreshToken {
  const ownSelector = selector ?? randomToken(SELECTOR_BYTES);
  const validator = randomToken(VALIDATOR_BYTES);
  return {
    selector: ownSelector,
    validator,
    hash: refreshHash(validator),
    token: `${REFRESH_TOKEN_VERSION}.${ownSelector}.${validator}`,
  };
}

/** Seletor e validador de um valor de cookie no formato exato; qualquer outra coisa → null (sem consultar o banco). */
export function parseRefreshToken(
  value: unknown,
): { selector: string; validator: string } | null {
  if (typeof value !== 'string') return null;
  const match = REFRESH_TOKEN_PATTERN.exec(value);
  return match ? { selector: match[1], validator: match[2] } : null;
}

export function refreshHash(validator: string): string {
  return sha256Hex(validator);
}

/** Dois hashes SHA-256 em hex são iguais? Comparação em tempo constante; null/formato inválido → false. */
export function compareHash(
  presented: string | null | undefined,
  stored: string | null | undefined,
): boolean {
  if (!presented || !stored) return false;
  const left = presented.trim().toLowerCase();
  const right = stored.trim().toLowerCase();
  if (!HASH_PATTERN.test(left) || !HASH_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
