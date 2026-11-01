import type { Request } from 'express';

/** IP e navegador de quem fez a requisição (para auditoria e limite de tentativas). */
export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Atrás de proxy/túnel (ngrok, Nginx, balanceador), defina TRUST_PROXY para o Express usar o IP real
 * do X-Forwarded-For (ver config/app-setup.ts). Sem isso, req.ip é o IP da conexão.
 */
export function requestMeta(request?: Request | null): RequestMeta {
  if (!request) return { ip: null, userAgent: null };
  const ip = (request.ip || request.socket?.remoteAddress || '').slice(0, 64);
  const agent = request.headers?.['user-agent'];
  return {
    ip: ip || null,
    userAgent: typeof agent === 'string' ? agent.slice(0, 300) : null,
  };
}
