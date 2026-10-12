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
  uploadsDir: path.resolve(__dirname, '..', '.uploads'),
};

export const STORAGE_KEYS = {
  token: `${BRAND.slug}.token`,
  user: `${BRAND.slug}.user`,
  cart: `${BRAND.slug}.cart`,
  theme: `${BRAND.slug}.theme`,
};
