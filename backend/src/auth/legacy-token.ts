import { Logger } from '@nestjs/common';
import { isProduction } from '../config/env';
import { jwtExpiresIn } from '../config/jwt';
import type { JwtPayload } from './auth-user';

const logger = new Logger('JWT');
const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  logger.warn(message);
}

/** Unidades aceitas no JWT_EXPIRES_IN (as mesmas da biblioteca "ms" usada pelo jsonwebtoken). */
const UNITS: ReadonlyArray<[RegExp, number]> = [
  [/^(ms|msecs?|milliseconds?)$/, 0.001],
  [/^(s|secs?|seconds?)$/, 1],
  [/^(m|mins?|minutes?)$/, 60],
  [/^(h|hrs?|hours?)$/, 60 * 60],
  [/^(d|days?)$/, 24 * 60 * 60],
  [/^(w|weeks?)$/, 7 * 24 * 60 * 60],
  [/^(y|yrs?|years?)$/, 365.25 * 24 * 60 * 60],
];

/** Validade dos tokens em segundos (JWT_EXPIRES_IN: número = segundos, ou "7d", "12h"...). */
export function jwtLifetimeSeconds(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = jwtExpiresIn(env);
  if (typeof value === 'number') return value;
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(String(value).trim());
  const unit = match
    ? UNITS.find(([pattern]) => pattern.test(match[2].toLowerCase()))
    : undefined;
  // Valor fora do formato nunca chega aqui (jwtExpiresIn cai no padrão de 7 dias)
  return match && unit ? Number(match[1]) * unit[1] : 7 * 24 * 60 * 60;
}

/** Corte dos tokens sem "jti": instante (ms) ou null (nenhum aceito) / Infinity (todos, como antes). */
export function legacyTokenCutoff(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env.JWT_LEGACY_ISSUED_BEFORE?.trim();
  if (!raw) {
    if (!isProduction(env)) return Infinity;
    warnOnce(
      'Tokens sem "jti" (emitidos antes das sessões registradas) são recusados: quem entrou antes da ' +
        'atualização precisa entrar de novo. Para aceitá-los até expirarem, defina ' +
        'JWT_LEGACY_ISSUED_BEFORE com o instante do deploy (ex.: 2026-11-01T12:00:00Z).',
    );
    return null;
  }
  if (/^(none|off|false|0)$/i.test(raw)) return null;
  const cutoff = Date.parse(raw);
  if (Number.isNaN(cutoff)) {
    warnOnce(
      `JWT_LEGACY_ISSUED_BEFORE inválido ("${raw}"): tokens sem "jti" são recusados. Use uma data ISO 8601 (ex.: 2026-11-01T12:00:00Z).`,
    );
    return null;
  }
  return cutoff;
}

/**
 * Token SEM "jti" (emitido antes das sessões registradas em auth_sessions) ainda vale?
 * Um token assim não tem sessão: não aparece em "Sessões ativas" nem cai com o logout. Por isso ele só
 * vale na janela de transição: emitido (iat) ANTES do corte JWT_LEGACY_ISSUED_BEFORE e com validade
 * (exp − iat) de no máximo JWT_EXPIRES_IN. Como iat e exp são assinados, um token forjado com o
 * JWT_SECRET vazado também não passa do corte + JWT_EXPIRES_IN: depois disso, todo token sem "jti"
 * é recusado, sem depender de outra mudança no código.
 * Sem JWT_LEGACY_ISSUED_BEFORE: em produção, nenhum é aceito (quem entrou antes da atualização entra
 * de novo); em development/test, todos continuam aceitos até expirar, como antes.
 */
export function legacyTokenAccepted(
  payload: Partial<JwtPayload>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const cutoff = legacyTokenCutoff(env);
  if (cutoff === null) return false;
  if (cutoff === Infinity) return true;
  const { iat, exp } = payload;
  if (typeof iat !== 'number' || typeof exp !== 'number') return false;
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) return false;
  // 60 s de folga para arredondamentos do relógio de quem emitiu
  return iat * 1000 < cutoff && exp - iat <= jwtLifetimeSeconds(env) + 60;
}
