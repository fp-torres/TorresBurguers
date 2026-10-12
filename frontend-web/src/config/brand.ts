/**
 * Identidade do produto (white-label).
 * Para renomear o sistema altere aqui; para trocar apenas o nome exibido em uma instalação,
 * defina VITE_APP_NAME no .env.
 */
export const BRAND = {
  name: (import.meta.env.VITE_APP_NAME as string | undefined) || 'Comestra',
  slug: 'comestra',
  tagline: 'Cozinha, balcão e entrega no mesmo compasso.',
  domain: 'comestra.com.br',
  supportEmail: 'contato@comestra.com.br',
};

/** Chaves do localStorage, prefixadas pelo slug do produto. */
export const STORAGE_KEYS = {
  token: `${BRAND.slug}.token`,
  user: `${BRAND.slug}.user`,
  cart: `${BRAND.slug}.cart`,
  theme: `${BRAND.slug}.theme`,
};

/** Título da aba do navegador: "Nome — slogan". */
export const APP_TITLE = `${BRAND.name} — ${BRAND.tagline.replace(/\.$/, '')}`;

/**
 * Dados da loja exibidos na vitrine (cabeçalho, rodapé e retirada no balcão).
 * Valores de demonstração: ajuste para cada instalação.
 * Abrir/fechar a loja não depende destes textos: vem de GET /store/status.
 */
export const STORE_INFO = {
  addressLine: 'Av. Rio Branco, 156 - Loja B, Centro',
  cityLine: 'Rio de Janeiro - RJ, 20040-003',
  phone: '(21) 99999-9999',
  openingDays: 'Terça a Domingo',
  openingHours: '12:00 às 04:00 (madrugada)',
  openingHoursShort: 'Ter a Dom: 12h às 04h',
};
