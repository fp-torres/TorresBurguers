import { Logger } from '@nestjs/common';
import type { JwtSignOptions } from '@nestjs/jwt';
import { BRAND } from './brand';
import { isDevOrTest } from './env';

export type JwtExpiresIn = NonNullable<JwtSignOptions['expiresIn']>;

export const DEFAULT_JWT_EXPIRES_IN: JwtExpiresIn = '7d';

/** Tamanho mínimo do JWT_SECRET fora de development/test. */
export const MIN_JWT_SECRET_LENGTH = 32;

// Mesmo formato aceito pelo jsonwebtoken (biblioteca "ms"): 90s, 15m, 12h, 7d, 2 weeks...
const TIMESPAN =
  /^\d+(\.\d+)?\s*(ms|msecs?|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|y|yrs?|years?)$/i;

const GENERATE_SECRET_HINT =
  "Gere um com: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\". " +
  'Em uma máquina de desenvolvimento, use NODE_ENV=development.';

const logger = new Logger('JWT');
let fallbackWarned = false;

/**
 * Fonte ÚNICA do segredo dos tokens: usada para assinar (JwtModule) e para verificar (JwtStrategy).
 * - Produção (inclusive NODE_ENV vazio ou desconhecido): exige JWT_SECRET com pelo menos
 *   32 caracteres. Sem ele, a API não sobe.
 * - development/test: usa JWT_SECRET quando definido; sem ele, um segredo fixo de desenvolvimento
 *   (com aviso no log).
 */
export function jwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.JWT_SECRET;
  const length = secret?.trim().length ?? 0;

  if (!isDevOrTest(env)) {
    if (!secret || length === 0) {
      throw new Error(
        `JWT_SECRET não definido. Em produção (NODE_ENV vazio ou desconhecido também conta) a API só sobe com um segredo de pelo menos ${MIN_JWT_SECRET_LENGTH} caracteres aleatórios. ${GENERATE_SECRET_HINT}`,
      );
    }
    if (length < MIN_JWT_SECRET_LENGTH) {
      throw new Error(
        `JWT_SECRET fraco (${length} caracteres). Em produção use pelo menos ${MIN_JWT_SECRET_LENGTH} caracteres aleatórios. ${GENERATE_SECRET_HINT}`,
      );
    }
    return secret;
  }

  if (secret && length > 0) return secret;

  if (!fallbackWarned) {
    fallbackWarned = true;
    logger.warn(
      'JWT_SECRET não definido: usando um segredo fixo de desenvolvimento. Nunca rode assim em produção.',
    );
  }
  return `${BRAND.slug}-dev-jwt-secret`;
}

/**
 * Validade dos tokens (JWT_EXPIRES_IN). Ex.: 7d, 12h, 30m ou só números (segundos). Padrão: 7d.
 * Valor inválido gera aviso e cai no padrão, em vez de quebrar o login.
 */
export function jwtExpiresIn(
  env: NodeJS.ProcessEnv = process.env,
): JwtExpiresIn {
  const raw = env.JWT_EXPIRES_IN?.trim();
  if (!raw) return DEFAULT_JWT_EXPIRES_IN;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (TIMESPAN.test(raw)) return raw as JwtExpiresIn;

  logger.warn(
    `JWT_EXPIRES_IN inválido ("${raw}"); usando ${DEFAULT_JWT_EXPIRES_IN}.`,
  );
  return DEFAULT_JWT_EXPIRES_IN;
}
