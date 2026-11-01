import { STORE_PROFILE_FIELDS, type PlatformStoreDetail, type StoreProfilePayload } from '../../../services/platform/storesService';
import { maskCEP, maskPhone } from '../../../utils/masks';
import {
  documentError, isReservedStoreSlug, isUf, isValidEmail, isValidStoreSlug, maskDocument, normalizeDocument, phoneDigits, phoneError,
  zipDigits, zipError,
} from '../../../utils/validation';

// Cadastro de um estabelecimento no superpainel (criação e edição): as mesmas regras dos DTOs da API
// (CreatePlatformStoreDto, UpdatePlatformStoreDto e UpdateStoreSettingsDto). A tela avisa antes de enviar e a
// API continua validando tudo. Documento, telefone, CEP, e-mail, UF, slug e domínio: utils/validation.

export const STORE_FIELD_LIMITS = {
  name: 120,
  legal_name: 160,
  email: 160,
  address_street: 160,
  address_number: 20,
  address_complement: 80,
  address_neighborhood: 80,
  address_city: 80,
  owner_name: 50,
  owner_email: 160,
} as const;

// --- ENDEREÇO DA LOJA (slug) ---

export const SLUG_FORMAT_MESSAGE = 'Use de 3 a 60 caracteres com letras minúsculas, números e hífens, começando e terminando com letra ou número (ex.: lanchonete-do-bairro).';
export const SLUG_RESERVED_MESSAGE = 'Este endereço é reservado pela plataforma. Escolha outro.';

export function slugProblem(slug: string): string | null {
  if (!slug) return 'Informe o endereço da loja.';
  if (!isValidStoreSlug(slug)) return SLUG_FORMAT_MESSAGE;
  if (isReservedStoreSlug(slug)) return SLUG_RESERVED_MESSAGE;
  return null;
}

export function emailProblem(value: string, { required = false, max = STORE_FIELD_LIMITS.email }: { required?: boolean; max?: number } = {}): string | null {
  const email = value.trim();
  if (!email) return required ? 'Informe o e-mail.' : null;
  if (email.length > max) return `Use no máximo ${max} caracteres.`;
  return isValidEmail(email) ? null : 'Informe um e-mail válido.';
}

// --- FORMULÁRIO DO CADASTRO ---

export type StoreProfileValues = Record<keyof StoreProfilePayload, string>;
export type StoreProfileErrors = Partial<Record<keyof StoreProfilePayload, string>>;

export function emptyProfile(): StoreProfileValues {
  return Object.fromEntries(STORE_PROFILE_FIELDS.map((field) => [field, ''])) as StoreProfileValues;
}

/** Valores do formulário a partir da loja (com máscaras de exibição). */
export function profileFromStore(store: PlatformStoreDetail): StoreProfileValues {
  return {
    legal_name: store.legal_name ?? '',
    document: store.document ? maskDocument(store.document) : '',
    email: store.email ?? '',
    phone: store.phone ? maskPhone(store.phone) : '',
    address_zip_code: store.address_zip_code ? maskCEP(store.address_zip_code) : '',
    address_street: store.address_street ?? '',
    address_number: store.address_number ?? '',
    address_complement: store.address_complement ?? '',
    address_neighborhood: store.address_neighborhood ?? '',
    address_city: store.address_city ?? '',
    address_state: store.address_state ?? '',
  };
}

function tooLong(value: string, max: number): string | null {
  return value.trim().length > max ? `Use no máximo ${max} caracteres.` : null;
}

export function profileErrors(values: StoreProfileValues): StoreProfileErrors {
  const errors: StoreProfileErrors = {
    legal_name: tooLong(values.legal_name, STORE_FIELD_LIMITS.legal_name) ?? undefined,
    document: documentError(values.document, 'Informe o CPF (11 dígitos) ou o CNPJ (14 caracteres).') ?? undefined,
    email: emailProblem(values.email) ?? undefined,
    phone: phoneError(values.phone, 'Informe o DDD e o número (10 ou 11 dígitos).') ?? undefined,
    address_zip_code: zipError(values.address_zip_code, 'Informe os 8 dígitos do CEP (ex.: 20040-003).') ?? undefined,
    address_street: tooLong(values.address_street, STORE_FIELD_LIMITS.address_street) ?? undefined,
    address_number: tooLong(values.address_number, STORE_FIELD_LIMITS.address_number) ?? undefined,
    address_complement: tooLong(values.address_complement, STORE_FIELD_LIMITS.address_complement) ?? undefined,
    address_neighborhood: tooLong(values.address_neighborhood, STORE_FIELD_LIMITS.address_neighborhood) ?? undefined,
    address_city: tooLong(values.address_city, STORE_FIELD_LIMITS.address_city) ?? undefined,
    address_state: values.address_state && !isUf(values.address_state) ? 'UF inválida.' : undefined,
  };
  return Object.fromEntries(Object.entries(errors).filter(([, error]) => error)) as StoreProfileErrors;
}

/** Corpo do cadastro: vazio vira null (limpa o campo na API). */
export function profilePayload(values: StoreProfileValues): StoreProfilePayload {
  const text = (value: string) => value.trim() || null;
  return {
    legal_name: text(values.legal_name),
    document: normalizeDocument(values.document) || null,
    email: values.email.trim().toLowerCase() || null,
    phone: phoneDigits(values.phone) || null,
    address_zip_code: zipDigits(values.address_zip_code) || null,
    address_street: text(values.address_street),
    address_number: text(values.address_number),
    address_complement: text(values.address_complement),
    address_neighborhood: text(values.address_neighborhood),
    address_city: text(values.address_city),
    address_state: values.address_state || null,
  };
}

/** Só os campos do cadastro que mudaram em relação à loja (corpo do PATCH). */
export function profileChanges(store: PlatformStoreDetail, payload: StoreProfilePayload): Partial<StoreProfilePayload> {
  const changes: Partial<StoreProfilePayload> = {};
  for (const field of STORE_PROFILE_FIELDS) {
    if ((payload[field] ?? null) !== (store[field] ?? null)) changes[field] = payload[field];
  }
  return changes;
}

/** Campos do cadastro sem nenhum valor (endereço opcional não informado). */
export function isAddressEmpty(values: StoreProfileValues): boolean {
  return ['address_zip_code', 'address_street', 'address_number', 'address_complement', 'address_neighborhood', 'address_city', 'address_state']
    .every((field) => !values[field as keyof StoreProfileValues].trim());
}
