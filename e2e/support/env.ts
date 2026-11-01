import path from 'node:path';

/** Identidade do produto usada nos testes (chaves de storage e domínio dos usuários padrão). */
export const BRAND = {
  slug: 'comestra',
  domain: 'comestra.com.br',
};

/**
 * Ambiente isolado de testes: banco e portas próprios, para nunca tocar nos dados de desenvolvimento.
 * Tudo pode ser sobrescrito por variáveis de ambiente.
 */
const apiPort = Number(process.env.E2E_API_PORT ?? 3001);
const webPort = Number(process.env.E2E_WEB_PORT ?? 5174);

export const E2E = {
  apiPort,
  webPort,
  apiURL: `http://localhost:${apiPort}`,
  webURL: `http://localhost:${webPort}`,
  db: {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.E2E_DB_DATABASE ?? `${BRAND.slug}_e2e`,
  },
  /** Pasta de uploads da API de teste (E2E_UPLOADS_DIR permite execuções paralelas isoladas). */
  uploadsDir: process.env.E2E_UPLOADS_DIR
    ? path.resolve(process.env.E2E_UPLOADS_DIR)
    : path.resolve(__dirname, '..', '.uploads'),
  /** Loja de demonstração criada pelo seed da API (equipe padrão) e loja das rotas antigas sem slug. */
  demoStoreSlug: process.env.E2E_DEMO_STORE_SLUG ?? 'demo',
  /** Segredo de teste do webhook da cobrança SaaS (assinatura x-signature do Mercado Pago). */
  saasWebhookSecret: process.env.E2E_SAAS_WEBHOOK_SECRET ?? 'e2e-saas-webhook-secret',
};

export const STORAGE_KEYS = {
  token: `${BRAND.slug}.token`,
  user: `${BRAND.slug}.user`,
  /**
   * Marcador da sessão do site em cookie { v: 1, sid, uid } (sem segredo): no login pela tela, o token de acesso
   * fica só na memória da aba e o refresh num cookie HttpOnly (helpers useCookieSession e expectCookieSession).
   */
  session: `${BRAND.slug}.session`,
  /**
   * Prefixo do carrinho de cada loja: "<cart>.<storeId>" = { v: 2, storeId, storeSlug, items } (ver cartKey).
   * A chave sem sufixo é o carrinho da versão de loja única (migrado para a loja padrão na primeira visita).
   */
  cart: `${BRAND.slug}.cart`,
  theme: `${BRAND.slug}.theme`,
  /** Slug da última loja visitada (/cart e /order-success antigos voltam para ela). */
  lastStore: `${BRAND.slug}.lastStore`,
};

/** Chave do carrinho de uma loja no localStorage ("comestra.cart.<storeId>"). */
export function cartKey(storeId: number): string {
  return `${STORAGE_KEYS.cart}.${storeId}`;
}
