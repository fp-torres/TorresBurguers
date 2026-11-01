import { ForbiddenException } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import {
  cookieSameSite,
  credentialOrigins,
  webCookieEnabled,
} from '../config/auth-session';
import { BRAND } from '../config/brand';
import { isProduction } from '../config/env';

/**
 * Cookie do refresh da sessão do site e as regras de quem pode usá-lo.
 *
 * Superfície de CSRF: o cookie só é lido em /auth/web/refresh, /auth/web/logout e, numa emissão de
 * sessão, para encerrar a sessão que ele substitui. Todas as outras rotas seguem só com Bearer. Para
 * usar o cookie a requisição precisa:
 * 1. trazer o cabeçalho X-Auth-Transport: cookie (cabeçalho próprio: o navegador faz o preflight, que só
 *    passa com credenciais para as origens de credencial);
 * 2. vir de uma origem de credencial, quando o Origin vem;
 * 3. não ser cross-site, quando o Sec-Fetch-Site vem;
 * e o cookie é SameSite=Strict (padrão). A resposta não pode ser lida por outra origem, então um
 * token double-submit é dispensável.
 */

/** Cabeçalho que pede a sessão em cookie (o site envia; o app mobile nunca). */
export const AUTH_TRANSPORT_HEADER = 'x-auth-transport';
export const COOKIE_TRANSPORT = 'cookie';

/** Nome do cookie: __Host-<slug>_rt (Secure, HTTPS); em http de desenvolvimento, <slug>_rt sem Secure. */
export const SECURE_REFRESH_COOKIE = `__Host-${BRAND.slug}_rt`;
export const DEV_REFRESH_COOKIE = `${BRAND.slug}_rt`;

export const COOKIE_ORIGIN_FORBIDDEN_MESSAGE =
  'Origem não autorizada para a sessão deste navegador.';

/** Secure (e prefixo __Host-) em produção e em qualquer requisição HTTPS; sem Secure só em http fora de produção. */
export function refreshCookieSecure(
  request: Pick<Request, 'secure'> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isProduction(env) || request?.secure === true;
}

export function refreshCookieName(
  request: Pick<Request, 'secure'> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return refreshCookieSecure(request, env)
    ? SECURE_REFRESH_COOKIE
    : DEV_REFRESH_COOKIE;
}

/** Atributos do cookie (sem Domain: host-only; Path=/ para valer também atrás do prefixo /api do proxy). */
export function refreshCookieOptions(
  request: Pick<Request, 'secure'> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CookieOptions {
  return {
    httpOnly: true,
    secure: refreshCookieSecure(request, env),
    sameSite: cookieSameSite(env),
    path: '/',
  };
}

/** Cookie presente na requisição: o valor, ou "invalid" quando o nome vem repetido (cookie plantado). */
export type RefreshCookieRead =
  | { present: false }
  | { present: true; value: string | null };

/**
 * Lê o cookie do refresh do cabeçalho Cookie, sem dependência nova. Nome repetido (ex.: um cookie
 * plantado com outro Path) conta como inválido: value null.
 */
export function readRefreshCookie(
  request: Pick<Request, 'headers' | 'secure'> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): RefreshCookieRead {
  const header = request?.headers?.cookie;
  if (typeof header !== 'string' || header === '') return { present: false };
  const name = refreshCookieName(request, env);
  const values: string[] = [];
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    try {
      values.push(decodeURIComponent(value));
    } catch {
      values.push('');
    }
  }
  if (values.length === 0) return { present: false };
  return { present: true, value: values.length === 1 ? values[0] : null };
}

/** Grava o refresh. Max-Age = tempo até o fim da sessão (a renovação não estende esse prazo). */
export function setRefreshCookie(
  response: Pick<Response, 'cookie'>,
  request: Pick<Request, 'secure'> | null | undefined,
  token: string,
  expiresAt: Date,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const maxAge = Math.max(expiresAt.getTime() - Date.now(), 1000);
  response.cookie(refreshCookieName(request, env), token, {
    ...refreshCookieOptions(request, env),
    maxAge,
  });
}

/** Apaga o refresh (mesmos atributos, senão o navegador recusa a remoção do cookie __Host-). */
export function clearRefreshCookie(
  response: Pick<Response, 'clearCookie'>,
  request: Pick<Request, 'secure'> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  response.clearCookie(
    refreshCookieName(request, env),
    refreshCookieOptions(request, env),
  );
}

function headerValue(
  request: Pick<Request, 'headers'>,
  name: string,
): string | undefined {
  const value = request.headers?.[name];
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === 'string' ? text.trim() : undefined;
}

/** A requisição pediu a sessão em cookie (X-Auth-Transport: cookie)? */
export function requestedCookieTransport(
  request: Pick<Request, 'headers'> | null | undefined,
): boolean {
  if (!request) return false;
  return (
    headerValue(request, AUTH_TRANSPORT_HEADER)?.toLowerCase() ===
    COOKIE_TRANSPORT
  );
}

export type CookieRequestCheck = 'ok' | 'missing_header' | 'origin' | 'site';

/** Regras do cookie (ver o topo do arquivo), sem lançar erro. */
export function cookieRequestCheck(
  request: Pick<Request, 'headers'> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CookieRequestCheck {
  if (!request || !requestedCookieTransport(request)) return 'missing_header';
  const origin = headerValue(request, 'origin');
  if (origin !== undefined && !credentialOrigins(env).includes(origin)) {
    return 'origin';
  }
  const site = headerValue(request, 'sec-fetch-site')?.toLowerCase();
  if (site === 'cross-site') return 'site';
  return 'ok';
}

/** /auth/web/*: sem o cabeçalho, de origem fora da lista ou cross-site → 403. */
export function assertCookieRequest(
  request: Pick<Request, 'headers'>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (cookieRequestCheck(request, env) !== 'ok') {
    throw new ForbiddenException(COOKIE_ORIGIN_FORBIDDEN_MESSAGE);
  }
}

/**
 * Transporte de uma emissão de sessão: null sem o cabeçalho (como hoje); 'COOKIE' com o cabeçalho, a
 * origem e o site válidos e AUTH_WEB_COOKIE ligado; 'BEARER' quando pediu mas não pode (cross-site,
 * origem fora da lista, modo desligado). Nunca recusa a emissão.
 */
export function emissionTransport(
  request: Pick<Request, 'headers'> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): 'COOKIE' | 'BEARER' | null {
  if (!request || !requestedCookieTransport(request)) return null;
  if (!webCookieEnabled(env)) return 'BEARER';
  return cookieRequestCheck(request, env) === 'ok' ? 'COOKIE' : 'BEARER';
}
