import { Logger } from '@nestjs/common';
import { DEFAULT_APP_WEB_URL } from '../notifications/links';
import { envFlag, isDevOrTest, isProduction } from './env';
import { jwtExpiresIn } from './jwt';

/**
 * Sessão do site em cookie (modo "cookie" do login web): token de acesso curto, só em memória no
 * navegador, e o refresh opaco num cookie HttpOnly. Só vale para quem pede (cabeçalho
 * X-Auth-Transport: cookie, enviado só pelo site); o app mobile e as integrações seguem com o token
 * de JWT_EXPIRES_IN no corpo, como antes. Ver auth/web-session.service.ts.
 */

const logger = new Logger('SessaoWeb');
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(message);
}

/** Validade do token de acesso das sessões em cookie (JWT_ACCESS_EXPIRES_IN): padrão 15 min. */
export const DEFAULT_ACCESS_TTL_SECONDS = 15 * 60;
const MIN_ACCESS_TTL_SECONDS = 60;
const MAX_ACCESS_TTL_SECONDS = 60 * 60;

/** Validade absoluta da sessão em cookie (AUTH_SESSION_MAX_AGE): de 5 min a 90 dias. */
const MIN_SESSION_MAX_AGE_SECONDS = 5 * 60;
const MAX_SESSION_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;
const FALLBACK_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/** Tolerância do refresh anterior (AUTH_REFRESH_GRACE_SECONDS): padrão 30 s, de 0 a 120. */
export const DEFAULT_REFRESH_GRACE_SECONDS = 30;
const MAX_REFRESH_GRACE_SECONDS = 120;

const UNIT_SECONDS: Record<string, number> = {
  ms: 0.001,
  msec: 0.001,
  msecs: 0.001,
  millisecond: 0.001,
  milliseconds: 0.001,
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
  w: 604800,
  week: 604800,
  weeks: 604800,
  y: 31557600,
  yr: 31557600,
  yrs: 31557600,
  year: 31557600,
  years: 31557600,
};

/**
 * Duração em segundos no formato do JWT_EXPIRES_IN (90s, 15m, 12h, 7d, 2 weeks...) ou só números
 * (segundos). Inválida → null.
 */
export function durationSeconds(
  raw: string | number | null | undefined,
): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
  }
  const text = raw?.trim().toLowerCase();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) > 0 ? Number(text) : null;
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/.exec(text);
  if (!match) return null;
  const unit = UNIT_SECONDS[match[2]];
  if (unit === undefined) return null;
  const seconds = Math.floor(Number(match[1]) * unit);
  return seconds > 0 ? seconds : null;
}

/** JWT_ACCESS_EXPIRES_IN em segundos (de 1 a 60 min). Inválido ou fora da faixa → 15 min, com aviso. */
export function accessTokenTtlSeconds(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.JWT_ACCESS_EXPIRES_IN?.trim();
  if (!raw) return DEFAULT_ACCESS_TTL_SECONDS;
  const seconds = durationSeconds(raw);
  if (
    seconds !== null &&
    seconds >= MIN_ACCESS_TTL_SECONDS &&
    seconds <= MAX_ACCESS_TTL_SECONDS
  ) {
    return seconds;
  }
  warnOnce(
    `JWT_ACCESS_EXPIRES_IN=${raw}`,
    `JWT_ACCESS_EXPIRES_IN inválido ("${raw}"; use de 1m a 60m): usando 15m.`,
  );
  return DEFAULT_ACCESS_TTL_SECONDS;
}

/**
 * Validade absoluta da sessão em cookie, em segundos (AUTH_SESSION_MAX_AGE). Padrão: a de
 * JWT_EXPIRES_IN (7 dias), a mesma das sessões de hoje. A renovação nunca estende esse prazo.
 */
export function sessionMaxAgeSeconds(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const fallback =
    durationSeconds(jwtExpiresIn(env)) ?? FALLBACK_SESSION_MAX_AGE_SECONDS;
  const raw = env.AUTH_SESSION_MAX_AGE?.trim();
  if (!raw) return clampMaxAge(fallback);
  const seconds = durationSeconds(raw);
  if (
    seconds !== null &&
    seconds >= MIN_SESSION_MAX_AGE_SECONDS &&
    seconds <= MAX_SESSION_MAX_AGE_SECONDS
  ) {
    return seconds;
  }
  warnOnce(
    `AUTH_SESSION_MAX_AGE=${raw}`,
    `AUTH_SESSION_MAX_AGE inválido ("${raw}"; use de 5m a 90d): usando a validade de JWT_EXPIRES_IN.`,
  );
  return clampMaxAge(fallback);
}

function clampMaxAge(seconds: number): number {
  return Math.min(
    Math.max(seconds, MIN_SESSION_MAX_AGE_SECONDS),
    MAX_SESSION_MAX_AGE_SECONDS,
  );
}

/** AUTH_REFRESH_GRACE_SECONDS (0 a 120; padrão 30): por quanto tempo o refresh anterior ainda vale. */
export function refreshGraceSeconds(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.AUTH_REFRESH_GRACE_SECONDS?.trim();
  if (!raw) return DEFAULT_REFRESH_GRACE_SECONDS;
  if (/^\d+$/.test(raw) && Number(raw) <= MAX_REFRESH_GRACE_SECONDS) {
    return Number(raw);
  }
  warnOnce(
    `AUTH_REFRESH_GRACE_SECONDS=${raw}`,
    `AUTH_REFRESH_GRACE_SECONDS inválido ("${raw}"; use de 0 a 120): usando ${DEFAULT_REFRESH_GRACE_SECONDS}.`,
  );
  return DEFAULT_REFRESH_GRACE_SECONDS;
}

export type CookieSameSite = 'strict' | 'lax';

/** AUTH_COOKIE_SAMESITE: strict (padrão) ou lax. Outro valor → strict, com aviso. */
export function cookieSameSite(
  env: NodeJS.ProcessEnv = process.env,
): CookieSameSite {
  const raw = env.AUTH_COOKIE_SAMESITE?.trim().toLowerCase();
  if (!raw || raw === 'strict') return 'strict';
  if (raw === 'lax') return 'lax';
  warnOnce(
    `AUTH_COOKIE_SAMESITE=${raw}`,
    `AUTH_COOKIE_SAMESITE inválido ("${raw}"; use strict ou lax): usando strict.`,
  );
  return 'strict';
}

/** Origem (esquema + host + porta) de uma URL http(s), ou null. */
export function originOf(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Origens de credencial: as únicas que recebem Access-Control-Allow-Credentials e que podem abrir,
 * renovar e encerrar a sessão em cookie. AUTH_COOKIE_ORIGINS (lista separada por vírgula) ou, sem
 * ela, o CORS_ORIGINS explícito mais a origem de APP_WEB_URL (em development/test sem APP_WEB_URL,
 * a do Vite: http://localhost:5173). Nunca "qualquer origem": "*" e valores inválidos são ignorados.
 */
export function credentialOrigins(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const explicit = (env.AUTH_COOKIE_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const candidates: string[] = [];
  if (explicit.length > 0) {
    candidates.push(...explicit);
  } else {
    // Mesma leitura do corsOrigins (app-setup.ts): vazio ou com "*" não é uma lista explícita
    const cors = (env.CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    if (!cors.includes('*')) candidates.push(...cors);
    const web =
      env.APP_WEB_URL?.trim() || (isDevOrTest(env) ? DEFAULT_APP_WEB_URL : '');
    if (web) candidates.push(web);
  }
  const origins = new Set<string>();
  for (const candidate of candidates) {
    if (candidate === '*') continue;
    const origin = originOf(candidate);
    if (origin) origins.add(origin);
    else {
      warnOnce(
        `AUTH_COOKIE_ORIGINS:${candidate}`,
        `Origem de credencial inválida ignorada: "${candidate}".`,
      );
    }
  }
  return [...origins];
}

/**
 * Emitir sessões em cookie? AUTH_WEB_COOKIE (padrão true). Em produção sem nenhuma origem de
 * credencial explícita, fica desligado (aviso na subida). Desligado, os logins do site voltam ao
 * modo bearer de antes; as sessões em cookie já abertas continuam renovando até vencer.
 */
export function webCookieEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!envFlag('AUTH_WEB_COOKIE', true, env)) return false;
  return !isProduction(env) || credentialOrigins(env).length > 0;
}

/** Avisos de configuração da sessão do site (subida da API). */
export function authSessionWarnings(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const warnings: string[] = [];
  if (
    isProduction(env) &&
    envFlag('AUTH_WEB_COOKIE', true, env) &&
    credentialOrigins(env).length === 0
  ) {
    warnings.push(
      'Sessão do site em cookie desligada: em produção ela exige origens explícitas (CORS_ORIGINS com o domínio do site, APP_WEB_URL ou AUTH_COOKIE_ORIGINS). O site segue no modo bearer.',
    );
  }
  if (isProduction(env) && cookieSameSite(env) === 'lax') {
    warnings.push(
      'AUTH_COOKIE_SAMESITE=lax: o cookie da sessão do site passa a acompanhar navegações vindas de outros sites. Prefira strict.',
    );
  }
  return warnings;
}
