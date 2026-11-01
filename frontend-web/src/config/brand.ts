/**
 * Identidade da PLATAFORMA (white-label).
 * Para renomear o sistema altere aqui; para trocar apenas o nome exibido em uma instalação,
 * defina VITE_APP_NAME no .env.
 *
 * A identidade de cada LOJA (nome, logo, cor, endereço, telefone e horários) não fica aqui:
 * vem da API (GET /stores/:slug) e é aplicada pela vitrine (StoreLayout/StorefrontContext).
 */
export const BRAND = {
  name: (import.meta.env.VITE_APP_NAME as string | undefined) || 'Comestra',
  slug: 'comestra',
  tagline: 'Cozinha, balcão e entrega no mesmo compasso.',
  domain: 'comestra.com.br',
  supportEmail: 'contato@comestra.com.br',
  /** Cor principal da plataforma (laranja): usada quando a loja não define a própria cor. */
  color: '#ea580c',
};

/** Chaves do localStorage, prefixadas pelo slug do produto. */
export const STORAGE_KEYS = {
  token: `${BRAND.slug}.token`,
  user: `${BRAND.slug}.user`,
  /**
   * Marcador da sessão em cookie { v: 1, sid, uid }: SEM segredo (o token de acesso fica só em memória e o
   * refresh num cookie HttpOnly). As abas acompanham login, saída e troca de conta por ele.
   */
  session: `${BRAND.slug}.session`,
  /**
   * Prefixo do carrinho de cada loja: "comestra.cart.<storeId>" = { v: 2, storeId, storeSlug, items }.
   * A própria chave "comestra.cart" (uma lista de itens) é o carrinho da versão de loja única, migrado
   * para a loja padrão na primeira visita a ela (utils/legacyStorage).
   */
  cart: `${BRAND.slug}.cart`,
  theme: `${BRAND.slug}.theme`,
  /** Slug da última loja visitada (/cart e /order-success antigos voltam para ela). */
  lastStore: `${BRAND.slug}.lastStore`,
  /** Sessão do superpainel guardada durante uma sessão de suporte (restaurada ao encerrá-la). */
  platformSession: `${BRAND.slug}.platformSession`,
};

/** Título da aba do navegador fora das lojas: "Nome — slogan". Na vitrine: "<loja> | Nome". */
export const APP_TITLE = `${BRAND.name} — ${BRAND.tagline.replace(/\.$/, '')}`;
