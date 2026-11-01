/**
 * Localização da entrega pelo CEP (funções puras, sem banco nem Nest; cobertas por address-location.spec.ts).
 *
 * O bairro, a cidade e a UF CANÔNICOS do endereço vêm da busca do CEP e ficam guardados ao lado do que o
 * cliente digitou (que continua sendo o texto exibido e entregue ao entregador). A zona de entrega usa o
 * canônico; sem ele (CEP inexistente, CEP geral da cidade sem bairro ou serviço de CEP fora do ar), vale o
 * bairro digitado e o endereço fica marcado como "bairro informado manualmente".
 */
import type { CepLookupOutcome } from './cep-lookup.service';
import { UFS } from './dto/create-address.dto';

/** De onde vem o bairro usado na zona: confirmado pelo CEP ou informado manualmente pelo cliente. */
export type NeighborhoodSource = 'CEP' | 'MANUAL';

/**
 * Resultado da conferência do CEP:
 * - FOUND: o CEP tem bairro (canônico = bairro, cidade e UF do CEP);
 * - NO_NEIGHBORHOOD: CEP geral da cidade, sem bairro (cidade e UF do CEP; bairro digitado);
 * - NOT_FOUND: CEP inexistente (vale o digitado);
 * - UNAVAILABLE: serviços de CEP fora do ar (vale o digitado; nova tentativa no orçamento depois de
 *   ADDRESS_LOCATION_RETRY_MS).
 */
export type CepStatus =
  | 'FOUND'
  | 'NO_NEIGHBORHOOD'
  | 'NOT_FOUND'
  | 'UNAVAILABLE';

export const NEIGHBORHOOD_SOURCES: readonly NeighborhoodSource[] = [
  'CEP',
  'MANUAL',
];
export const CEP_STATUSES: readonly CepStatus[] = [
  'FOUND',
  'NO_NEIGHBORHOOD',
  'NOT_FOUND',
  'UNAVAILABLE',
];

/** Serviço de CEP fora do ar no cadastro: o orçamento tenta de novo depois deste tempo. */
export const ADDRESS_LOCATION_RETRY_MS = 60 * 60 * 1000;

/** Mesmo tamanho das colunas canonical_neighborhood e canonical_city. */
const MAX_NAME_LENGTH = 100;

export interface AddressLocationFields {
  canonical_neighborhood: string | null;
  canonical_city: string | null;
  canonical_state: string | null;
  neighborhood_source: NeighborhoodSource;
  cep_status: CepStatus;
  cep_checked_at: Date;
}

/** Endereço com o que importa para a zona (entidade Address ou um objeto equivalente). */
export interface LocatableAddress {
  zipCode: string;
  neighborhood: string;
  city: string;
  canonical_neighborhood?: string | null;
  canonical_city?: string | null;
  neighborhood_source?: NeighborhoodSource | null;
  cep_status?: CepStatus | null;
  cep_checked_at?: Date | null;
}

/** Local usado no cálculo da zona de entrega (ver deliveryZoneFor em orders/order-rules.ts). */
export interface AddressDeliveryLocation {
  neighborhood: string;
  city: string;
  zipCode: string;
}

const name = (value: string): string | null => {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, MAX_NAME_LENGTH) : null;
};

const uf = (value: string): string | null => {
  const code = value.trim().toUpperCase();
  return UFS.includes(code) ? code : null;
};

/** Campos canônicos a gravar a partir do resultado da busca do CEP. */
export function locationFromLookup(
  outcome: CepLookupOutcome,
  checkedAt: Date,
): AddressLocationFields {
  if (outcome.status === 'found') {
    const neighborhood = name(outcome.address.bairro);
    return {
      canonical_neighborhood: neighborhood,
      canonical_city: name(outcome.address.localidade),
      canonical_state: uf(outcome.address.uf),
      neighborhood_source: neighborhood ? 'CEP' : 'MANUAL',
      cep_status: neighborhood ? 'FOUND' : 'NO_NEIGHBORHOOD',
      cep_checked_at: checkedAt,
    };
  }
  return {
    canonical_neighborhood: null,
    canonical_city: null,
    canonical_state: null,
    neighborhood_source: 'MANUAL',
    cep_status: outcome.status === 'not_found' ? 'NOT_FOUND' : 'UNAVAILABLE',
    cep_checked_at: checkedAt,
  };
}

/**
 * Bairro e cidade da zona de entrega: os do CEP quando conferidos (o bairro digitado errado não muda a zona);
 * senão, os digitados. O CEP vai junto para as zonas por faixa de CEP.
 */
export function deliveryLocationOf(
  address: LocatableAddress,
): AddressDeliveryLocation {
  return {
    neighborhood: address.canonical_neighborhood || address.neighborhood,
    city: address.canonical_city || address.city,
    zipCode: address.zipCode,
  };
}

/**
 * O orçamento confere o CEP de novo quando o endereço nunca foi conferido (cadastrado antes da conferência)
 * ou quando o serviço de CEP estava fora do ar há mais de ADDRESS_LOCATION_RETRY_MS.
 */
export function needsLocationRefresh(
  address: LocatableAddress,
  now: Date,
): boolean {
  if (!address.cep_status) return true;
  if (address.cep_status !== 'UNAVAILABLE') return false;
  const checked = address.cep_checked_at
    ? new Date(address.cep_checked_at).getTime()
    : 0;
  return (
    !Number.isFinite(checked) ||
    now.getTime() - checked >= ADDRESS_LOCATION_RETRY_MS
  );
}
