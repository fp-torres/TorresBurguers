import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request } from 'express';
import {
  AuthSessionKind,
  AuthSessionTransport,
} from './entities/auth-session.entity';

/** Sessão de um token assinado nesta requisição, gravada em auth_sessions antes de a resposta sair. */
export interface IssuedSession {
  jti: string;
  userId: number;
  kind: AuthSessionKind;
  supportSessionId: number | null;
  tokenVersion: number;
  expiresAt: Date;
  /** BEARER (padrão) ou COOKIE (sessão do site: refresh no cookie, token de acesso curto). */
  transport?: AuthSessionTransport;
  /** Só COOKIE: o refresh da família (o token vai só no Set-Cookie, nunca no corpo). */
  refresh?: { selector: string; hash: string; token: string };
  /** Sessão de suporte: a sessão (auth_sessions.id) do superadmin que a abriu. */
  parentSessionId?: number | null;
  /** O token assinado (só em memória: identifica o access_token do corpo da resposta). */
  accessToken?: string;
  /** Validade do token de acesso, em segundos (só COOKIE: vai no corpo como expires_in). */
  accessTtlSeconds?: number;
}

/**
 * Transporte pedido pela requisição: null sem o cabeçalho X-Auth-Transport (como antes); 'COOKIE' quando
 * pode abrir a sessão do site em cookie; 'BEARER' quando pediu, mas não pode (cross-site, origem fora da
 * lista, AUTH_WEB_COOKIE=false). Decidido pelo SessionIssuanceInterceptor antes do handler.
 */
export type ScopeTransport = 'COOKIE' | 'BEARER' | null;

/** Requisição HTTP em andamento: os tokens assinados nela e quem pediu (IP e navegador da sessão). */
export interface SessionScope {
  readonly request: Request | null;
  readonly issued: IssuedSession[];
  transport?: ScopeTransport;
}

const storage = new AsyncLocalStorage<SessionScope>();

/**
 * Roda `fn` (o handler da rota, pelo SessionIssuanceInterceptor) com um escopo próprio: os tokens
 * assinados dentro dele são anotados e gravados antes de a resposta sair (ver SessionJwtService).
 */
export function runInSessionScope<T>(scope: SessionScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** Escopo da requisição atual (undefined fora de uma requisição HTTP, ex.: comandos e testes unitários). */
export function currentSessionScope(): SessionScope | undefined {
  return storage.getStore();
}
