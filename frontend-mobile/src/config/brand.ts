/**
 * Identidade do produto (white-label).
 * Para renomear o sistema altere aqui; para trocar apenas o nome exibido em uma instalação,
 * defina EXPO_PUBLIC_APP_NAME no .env.
 */
export const BRAND = {
  name: process.env.EXPO_PUBLIC_APP_NAME || 'Comestra',
  slug: 'comestra',
  tagline: 'Cozinha, balcão e entrega no mesmo compasso.',
  domain: 'comestra.com.br',
  supportEmail: 'contato@comestra.com.br',
};

/** Chaves do AsyncStorage, prefixadas pelo slug do produto. */
export const STORAGE_KEYS = {
  token: `@${BRAND.slug}:token`,
  user: `@${BRAND.slug}:user`,
  themeMode: `@${BRAND.slug}:themeMode`,
  /** Carrinho: continua no aparelho depois do logout e é esvaziado ao concluir um pedido. */
  cart: `@${BRAND.slug}:cart`,
};

/**
 * Dados da loja exibidos no rodapé. Valores de demonstração (os mesmos do painel web):
 * ajuste para cada instalação no .env. Abrir/fechar a loja não depende destes textos,
 * vem de GET /store/status.
 */
export const STORE_INFO = {
  addressLine: process.env.EXPO_PUBLIC_STORE_ADDRESS_LINE || 'Av. Rio Branco, 156 - Loja B, Centro',
  cityLine: process.env.EXPO_PUBLIC_STORE_CITY_LINE || 'Rio de Janeiro - RJ, 20040-003',
  /** Redes sociais (URLs completas). Só aparecem no rodapé as que estiverem definidas. */
  social: {
    instagram: process.env.EXPO_PUBLIC_INSTAGRAM_URL || '',
    facebook: process.env.EXPO_PUBLIC_FACEBOOK_URL || '',
    twitter: process.env.EXPO_PUBLIC_X_URL || '',
  },
};
