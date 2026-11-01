import type { Request, Response } from '@playwright/test';
import { E2E } from './env';

/**
 * Rotas da API usadas pela vitrine. A vitrine de cada loja (/loja/<slug>) chama as rotas POR LOJA
 * (/stores/<slug>/...), e o app mobile e integrações antigas continuam nas rotas sem slug (loja padrão).
 * Interceptações (page.route) e esperas (waitForResponse, rastreio de requisições) usam estes matchers
 * para aceitar as duas formas da mesma rota.
 *
 *   storeApiPaths('/orders/quote')  → ['/orders/quote', '/stores/demo/orders/quote']
 *   storeApiPaths('/store/status')  → ['/store/status', '/stores/demo/status']
 *   storeApiPaths('/payment/pix')   → ['/payment/pix', '/stores/demo/payment/pix']
 */

/** Caminho (sem query) de uma URL da API de teste, ou null se a URL for de outro servidor. */
export function apiPathname(url: string | URL): string | null {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  return parsed.origin === new URL(E2E.apiURL).origin ? parsed.pathname : null;
}

/** As duas formas da rota: a antiga (sem slug) e a da loja (/stores/<slug>/...). */
export function storeApiPaths(legacyPath: string, slug: string = E2E.demoStoreSlug): string[] {
  const path = `/${legacyPath.replace(/^\/+/, '')}`.replace(/\/+$/, '') || '/';
  const scoped = path === '/store/status' ? '/status' : path;
  return [path, `/stores/${slug}${scoped}`];
}

/**
 * Matcher de URL para page.route: casa a rota antiga ou a rota da loja (sem query).
 * Ex.: page.route(storeApi('/orders/quote'), handler).
 */
export function storeApi(legacyPath: string, slug: string = E2E.demoStoreSlug): (url: URL) => boolean {
  const paths = storeApiPaths(legacyPath, slug);
  return (url: URL) => {
    const pathname = apiPathname(url);
    return pathname !== null && paths.includes(pathname);
  };
}

/** A requisição é a chamada `method` à rota (antiga ou da loja)? */
export function isStoreApiRequest(
  req: Request,
  method: string,
  legacyPath: string,
  slug: string = E2E.demoStoreSlug,
): boolean {
  return req.method() === method.toUpperCase() && storeApi(legacyPath, slug)(new URL(req.url()));
}

/** A resposta é da chamada `method` à rota (antiga ou da loja)? Para page.waitForResponse. */
export function isStoreApiResponse(
  res: Response,
  method: string,
  legacyPath: string,
  slug: string = E2E.demoStoreSlug,
): boolean {
  return isStoreApiRequest(res.request(), method, legacyPath, slug);
}

/**
 * Caminho da API sem o prefixo da loja (/stores/<slug>/orders → /orders; /stores/<slug>/status → /store/status),
 * para comparar chamadas registradas sem depender da forma usada pela página.
 */
export function legacyApiPath(pathname: string, slug: string = E2E.demoStoreSlug): string {
  const prefix = `/stores/${slug}`;
  if (pathname === `${prefix}/status`) return '/store/status';
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return pathname;
}
