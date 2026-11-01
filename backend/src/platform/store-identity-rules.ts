/**
 * Regras puras da identidade pública de um estabelecimento (sem banco): o endereço da loja na URL
 * (slug) e o domínio próprio. Cobertas por store-identity-rules.spec.ts.
 *
 * O formato do slug é o MESMO usado pelo roteamento (isValidStoreSlug, do TenantService): um slug
 * aceito aqui sempre é encontrado em /stores/:storeSlug.
 */
import { isValidStoreSlug } from '../tenancy/tenant.service';

export const STORE_SLUG_MIN_LENGTH = 3;
export const STORE_SLUG_MAX_LENGTH = 60;

/**
 * Endereços que nunca podem ser de uma loja: colidem com rotas da API (/stores/default,
 * /stores/signup...), com páginas do site (/cadastrar-loja, /convite...) ou com nomes da plataforma.
 */
export const RESERVED_STORE_SLUGS: readonly string[] = [
  'admin',
  'api',
  'platform',
  'plataforma',
  'www',
  'app',
  'loja',
  'lojas',
  'login',
  'signin',
  'signup',
  'static',
  'assets',
  'uploads',
  'health',
  'stores',
  'store',
  'default',
  'cadastrar-loja',
  'convite',
  'redefinir-senha',
  'esqueci-senha',
  'my-orders',
  'profile',
  'cart',
  'dashboard',
  'orders',
  'products',
  'users',
  'trash',
  'settings',
  'customers',
  'subscription',
  'public',
  'billing',
  'plans',
];

const RESERVED = new Set(RESERVED_STORE_SLUGS);

export const SLUG_FORMAT_MESSAGE =
  'Endereço da loja (slug) inválido: use de 3 a 60 caracteres com letras minúsculas, números e hífens, começando e terminando com letra ou número (ex.: lanchonete-do-bairro).';
export const SLUG_RESERVED_MESSAGE =
  'Este endereço (slug) é reservado pela plataforma. Escolha outro.';
export const SLUG_TAKEN_MESSAGE =
  'Este endereço (slug) já está em uso por outro estabelecimento. Escolha outro.';

export function isReservedStoreSlug(slug: string): boolean {
  return RESERVED.has(slug);
}

/** Problema no slug (null = válido e livre da lista de reservados). */
export function storeSlugError(value: unknown): string | null {
  if (!isValidStoreSlug(value)) return SLUG_FORMAT_MESSAGE;
  if (isReservedStoreSlug(value)) return SLUG_RESERVED_MESSAGE;
  return null;
}

/** @Transform do slug: sem espaços nas pontas e em minúsculas (o resto do formato é validado). */
export function normalizeSlugInput(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

// ---------------------------------------------------------------------------
// Domínio próprio (stores.custom_domain): registrado, mas ainda não roteado
// ---------------------------------------------------------------------------

export const CUSTOM_DOMAIN_MAX_LENGTH = 253;

export const CUSTOM_DOMAIN_FORMAT_MESSAGE =
  'Domínio inválido: informe só o endereço, sem http://, barras ou porta (ex.: pedidos.minhaloja.com.br).';
export const CUSTOM_DOMAIN_TAKEN_MESSAGE =
  'Este domínio já está cadastrado em outro estabelecimento.';
export const CUSTOM_DOMAIN_NOT_ROUTED_NOTICE =
  'O domínio próprio fica registrado, mas ainda não é roteado automaticamente (DNS, certificado e roteamento por domínio são uma evolução futura). A loja continua acessível pelo endereço /loja/<slug>.';

/** Rótulo do domínio: 1 a 63 caracteres, letras, números e hífens, sem hífen nas pontas. */
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
/** Domínio de topo: só letras (com, br, store...) ou a forma punycode (xn--...). */
const TOP_LEVEL_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** @Transform do domínio: sem espaços, minúsculo e sem o ponto final; vazio/"null" → null (remove). */
export function normalizeCustomDomain(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  const text = value.trim().toLowerCase().replace(/\.$/, '');
  return text === '' || text === 'null' ? null : text;
}

/** Problema no domínio já normalizado (null = válido). Recusa IP, porta, protocolo e caminho. */
export function customDomainError(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > CUSTOM_DOMAIN_MAX_LENGTH) {
    return CUSTOM_DOMAIN_FORMAT_MESSAGE;
  }
  const labels = value.split('.');
  if (labels.length < 2) return CUSTOM_DOMAIN_FORMAT_MESSAGE;
  if (!labels.every((label) => HOST_LABEL.test(label))) {
    return CUSTOM_DOMAIN_FORMAT_MESSAGE;
  }
  return TOP_LEVEL_LABEL.test(labels[labels.length - 1])
    ? null
    : CUSTOM_DOMAIN_FORMAT_MESSAGE;
}
