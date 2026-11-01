// Validações de formulário compartilhadas (vitrine, painel da loja, superpainel e cadastro de loja).
// Mesmas regras da API: a tela avisa antes de enviar e a API continua validando tudo.
// Regras próprias de uma tela (limites de campos, zonas de entrega, mensagens específicas) ficam na tela.

// ---------------------------------------------------------------------------
// UF
// ---------------------------------------------------------------------------

/** Siglas aceitas nos endereços. */
export const UFS = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const;

export type Uf = (typeof UFS)[number];

export function isUf(value: string): value is Uf {
  return (UFS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

/** Formato de e-mail (domínio com pelo menos um ponto e sem rótulos vazios, como a validação da API). */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** E-mail no formato aceito (espaços nas pontas são ignorados). */
export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

// ---------------------------------------------------------------------------
// Documento: CPF (11 dígitos) ou CNPJ (14 caracteres, inclusive o alfanumérico)
// ---------------------------------------------------------------------------

/** Sem pontuação, letras maiúsculas ("11.222.333/0001-81" → "11222333000181"). */
export function normalizeDocument(value: string): string {
  return value.replace(/[^0-9a-z]/gi, '').toUpperCase();
}

function withSeparators(raw: string, separators: Record<number, string>): string {
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    out += (separators[index] ?? '') + raw[index];
  }
  return out;
}

/** Máscara progressiva: CPF (000.000.000-00) enquanto couber; depois CNPJ (00.000.000/0000-00). */
export function maskDocument(value: string): string {
  const raw = normalizeDocument(value).slice(0, 14);
  if (raw.length <= 11 && /^\d*$/.test(raw)) return withSeparators(raw, { 3: '.', 6: '.', 9: '-' });
  return withSeparators(raw, { 2: '.', 5: '.', 8: '/', 12: '-' });
}

/** Dígito verificador no módulo 11 (resto < 2 → 0), comum ao CPF e ao CNPJ. */
function mod11Digit(values: number[], weights: number[]): number {
  const sum = values.reduce((total, value, index) => total + value * weights[index], 0);
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

/** CPF só com os 11 dígitos (sem pontuação) e dígitos verificadores corretos. */
export function isValidCpf(value: string): boolean {
  if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false;
  const digits = [...value].map(Number);
  const first = mod11Digit(digits.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = mod11Digit(digits.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return first === digits[9] && second === digits[10];
}

const CNPJ_WEIGHTS = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

/** CNPJ numérico ou alfanumérico, normalizado (cada caractere vale o código ASCII − 48 no cálculo). */
export function isValidCnpj(value: string): boolean {
  if (!/^[0-9A-Z]{12}\d{2}$/.test(value) || /^(\d)\1{13}$/.test(value)) return false;
  const values = [...value].map((char) => char.charCodeAt(0) - 48);
  const first = mod11Digit(values.slice(0, 12), CNPJ_WEIGHTS.slice(1));
  const second = mod11Digit(values.slice(0, 13), CNPJ_WEIGHTS);
  return first === values[12] && second === values[13];
}

export const DOCUMENT_LENGTH_MESSAGE = 'Documento inválido. Informe o CPF (11 dígitos) ou o CNPJ (14 caracteres).';

/**
 * Problema no documento digitado (null = válido ou vazio).
 * `lengthMessage`: texto quando não tem o tamanho de um CPF nem de um CNPJ.
 */
export function documentError(value: string, lengthMessage: string = DOCUMENT_LENGTH_MESSAGE): string | null {
  const document = normalizeDocument(value);
  if (!document) return null;
  if (document.length === 11 && /^\d+$/.test(document)) {
    return isValidCpf(document) ? null : 'CPF inválido: confira os números.';
  }
  if (document.length === 14) {
    return isValidCnpj(document) ? null : 'CNPJ inválido: confira os números.';
  }
  return lengthMessage;
}

// ---------------------------------------------------------------------------
// Telefone e CEP
// ---------------------------------------------------------------------------

/** Só os dígitos do telefone; com o código do país (55) na frente, ele sai (mesma regra da API). */
export function phoneDigits(value: string): string {
  const digits = value.replace(/\D/g, '');
  return /^55\d{10,11}$/.test(digits) ? digits.slice(2) : digits;
}

export const PHONE_MESSAGE = 'Telefone inválido. Informe o DDD e o número (10 ou 11 dígitos).';

/** Problema no telefone (null = válido ou vazio): DDD + número, 10 ou 11 dígitos. */
export function phoneError(value: string, message: string = PHONE_MESSAGE): string | null {
  const digits = phoneDigits(value);
  if (!digits) return null;
  return /^\d{10,11}$/.test(digits) ? null : message;
}

export function zipDigits(value: string): string {
  return value.replace(/\D/g, '');
}

export const ZIP_MESSAGE = 'CEP inválido. Informe os 8 dígitos (ex.: 20040-003).';

/** Problema no CEP (null = válido ou vazio): 8 dígitos. */
export function zipError(value: string, message: string = ZIP_MESSAGE): string | null {
  const digits = zipDigits(value);
  if (!digits) return null;
  return digits.length === 8 ? null : message;
}

// ---------------------------------------------------------------------------
// Endereço da loja (slug) — mesma regra da API (tenancy/tenant.service.ts e platform/store-identity-rules.ts)
// ---------------------------------------------------------------------------

/** 3 a 60 caracteres: letras minúsculas, números e hífens, sem hífen nas pontas (ex.: "loja-principal"). */
export const STORE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;
export const STORE_SLUG_MIN_LENGTH = 3;
export const STORE_SLUG_MAX_LENGTH = 60;

/**
 * Endereços que nenhuma loja pode usar (mesma lista da API): colidem com rotas da API (/stores/default,
 * /stores/signup...), com páginas do site ou com nomes da plataforma.
 */
export const RESERVED_STORE_SLUGS: readonly string[] = [
  'admin', 'api', 'platform', 'plataforma', 'www', 'app', 'loja', 'lojas', 'login', 'signin', 'signup', 'static',
  'assets', 'uploads', 'health', 'stores', 'store', 'default', 'cadastrar-loja', 'convite', 'redefinir-senha',
  'esqueci-senha', 'my-orders', 'profile', 'cart', 'dashboard', 'orders', 'products', 'users', 'trash', 'settings',
  'customers', 'subscription', 'public', 'billing', 'plans',
];

const RESERVED_SET = new Set(RESERVED_STORE_SLUGS);

/** Slug no formato aceito nas URLs da vitrine. */
export function isValidStoreSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && STORE_SLUG_PATTERN.test(slug);
}

export function isReservedStoreSlug(slug: string): boolean {
  return RESERVED_SET.has(slug);
}

function withoutAccents(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '');
}

/** Endereço sugerido a partir do nome: "Pizzaria São João!" → "pizzaria-sao-joao". */
export function suggestSlug(name: string): string {
  return withoutAccents(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, STORE_SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
}

/**
 * Durante a digitação: só minúsculas (sem acentos), números e hífens; espaços viram hífen.
 * `collapseHyphens` junta hífens repetidos (cadastro de loja novo; na edição, um slug antigo com "--" fica como está).
 */
export function cleanSlugInput(value: string, { collapseHyphens = false }: { collapseHyphens?: boolean } = {}): string {
  const clean = withoutAccents(value).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  return (collapseHyphens ? clean.replace(/-{2,}/g, '-') : clean).slice(0, STORE_SLUG_MAX_LENGTH);
}

// ---------------------------------------------------------------------------
// Domínio próprio da loja
// ---------------------------------------------------------------------------

/** Domínio próprio: só o endereço (sem http://, barras ou porta). */
export const CUSTOM_DOMAIN_MAX_LENGTH = 253;

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TOP_LEVEL_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

/** Problema do domínio (null = válido ou vazio). Recusa protocolo, porta, caminho e IP. */
export function domainError(value: string): string | null {
  const domain = normalizeDomain(value);
  if (!domain) return null;
  const message = 'Informe só o endereço, sem http://, barras ou porta (ex.: pedidos.minhaloja.com.br).';
  if (domain.length > CUSTOM_DOMAIN_MAX_LENGTH) return message;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((label) => HOST_LABEL.test(label))) return message;
  return TOP_LEVEL_LABEL.test(labels[labels.length - 1]) ? null : message;
}
