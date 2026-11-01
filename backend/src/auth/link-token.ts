import type { Request } from 'express';
import { ipRateLimitKey } from '../common/rate-limit/ip-key';
import { requestMeta } from '../common/request-meta';

/**
 * Códigos dos links de uso único (convite, redefinição de senha): randomToken() gera 32 bytes em
 * base64url (43 caracteres). Qualquer outra coisa nem chega ao banco (responde 404 direto).
 */
const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export function isLinkToken(value: unknown): value is string {
  return typeof value === 'string' && LINK_TOKEN_PATTERN.test(value);
}

/**
 * Chave dos limites de tentativas por IP (sem IP conhecido, todas caem no mesmo balde). IPv6 conta
 * pela rede /64 e o IPv4 escrito como IPv6 (::ffff:a.b.c.d) como o próprio IPv4 (ipRateLimitKey).
 * A auditoria e as sessões continuam gravando o endereço completo (requestMeta).
 */
export function clientIpKey(request?: Request | null): string {
  const ip = requestMeta(request).ip;
  return ip ? ipRateLimitKey(ip) : 'desconhecido';
}
