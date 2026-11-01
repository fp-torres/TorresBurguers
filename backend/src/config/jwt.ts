import { Logger } from '@nestjs/common';
import type { JwtSignOptions } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { BRAND } from './brand';
import { isDevOrTest, runtimeEnv } from './env';

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
 * Segredo fixo SÓ dos testes automatizados (NODE_ENV=test): instâncias descartáveis, com as senhas
 * públicas do seed. Nunca é usado em development: lá o segredo é aleatório por instalação.
 */
const TEST_JWT_SECRET = `${BRAND.slug}-dev-jwt-secret`;

/** Segredo de development já carregado nesta execução, por arquivo. */
const devSecrets = new Map<string, string>();

/**
 * Fonte ÚNICA do segredo dos tokens: usada para assinar (JwtModule) e para verificar (JwtStrategy).
 * - Produção (inclusive NODE_ENV vazio ou desconhecido): exige JWT_SECRET com pelo menos
 *   32 caracteres. Sem ele, a API não sobe.
 * - development/test: usa JWT_SECRET quando definido.
 * - development sem JWT_SECRET: um segredo aleatório por instalação, criado na primeira subida e
 *   guardado em backend/.temp/dev-jwt-secret (fora do Git; JWT_DEV_SECRET_FILE troca o caminho).
 *   Ele NÃO pode ser derivado de nada público: a API de desenvolvimento escuta na rede local
 *   (HOST=0.0.0.0, para o app no celular) e às vezes é exposta por túnel; com um segredo conhecido,
 *   qualquer um forjaria o token de qualquer conta, inclusive do superadmin, sem a senha.
 * - test sem JWT_SECRET: um segredo fixo (instâncias descartáveis dos testes automatizados).
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

  if (runtimeEnv(env) === 'development') return developmentSecret(env);

  if (!fallbackWarned) {
    fallbackWarned = true;
    logger.warn(
      'JWT_SECRET não definido: usando o segredo fixo dos testes automatizados (NODE_ENV=test). Nunca rode assim em produção.',
    );
  }
  return TEST_JWT_SECRET;
}

/** Arquivo do segredo de development (JWT_DEV_SECRET_FILE ou backend/.temp/dev-jwt-secret). */
export function devJwtSecretFile(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(
    env.JWT_DEV_SECRET_FILE?.trim() ||
      join(process.cwd(), '.temp', 'dev-jwt-secret'),
  );
}

function developmentSecret(env: NodeJS.ProcessEnv): string {
  const file = devJwtSecretFile(env);
  const cached = devSecrets.get(file);
  if (cached) return cached;

  let secret = readDevSecret(file);
  if (secret) {
    logger.warn(
      `JWT_SECRET não definido: usando o segredo de desenvolvimento desta máquina (${file}). Nunca rode assim em produção.`,
    );
  } else {
    secret = createDevSecret(file);
  }
  devSecrets.set(file, secret);
  return secret;
}

function readDevSecret(file: string): string | null {
  try {
    const saved = readFileSync(file, 'utf8').trim();
    return saved.length >= MIN_JWT_SECRET_LENGTH ? saved : null;
  } catch {
    return null;
  }
}

function createDevSecret(file: string): string {
  const secret = randomBytes(48).toString('hex');
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, secret, { mode: 0o600 });
    logger.warn(
      `JWT_SECRET não definido: criado um segredo aleatório de desenvolvimento em ${file} (fora do Git). Nunca rode assim em produção.`,
    );
  } catch (error) {
    logger.warn(
      `JWT_SECRET não definido e não foi possível guardar o segredo de desenvolvimento em ${file} (${(error as Error).message}): usando um segredo aleatório só desta execução (as sessões caem quando a API reinicia). Defina JWT_SECRET no .env.`,
    );
  }
  return secret;
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
