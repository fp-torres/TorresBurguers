// Endereços do cliente (GET/POST /addresses): são da conta e valem em qualquer loja.
// A API confere o CEP e guarda o bairro, a cidade e a UF do CEP (canonical_*): a taxa de entrega usa esses
// valores quando o CEP confirma o bairro; senão, vale o que o cliente digitou (neighborhood_source = MANUAL).

/** De onde vem o bairro usado na entrega: confirmado pelo CEP ou informado manualmente (null = não conferido). */
export type NeighborhoodSource = 'CEP' | 'MANUAL';

export interface CustomerAddress {
  id: number;
  nickname?: string | null;
  zipCode?: string;
  street: string;
  number: string;
  complement?: string | null;
  neighborhood: string;
  city: string;
  state?: string;
  canonical_neighborhood?: string | null;
  canonical_city?: string | null;
  canonical_state?: string | null;
  neighborhood_source?: NeighborhoodSource | null;
}

/** Mesmo nome, sem diferenciar maiúsculas e acentos (a regra das zonas de entrega). */
export function sameAreaName(a: string, b: string): boolean {
  const normalize = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  return normalize(a) === normalize(b);
}

/**
 * Aviso quando o bairro do CEP é diferente do digitado: a entrega é calculada para o do CEP e o cliente
 * precisa saber. null quando bate (ou o CEP não confirmou o bairro).
 */
export function cepNeighborhoodNote(address: Pick<CustomerAddress, 'neighborhood' | 'city' | 'canonical_neighborhood' | 'canonical_city' | 'neighborhood_source'>): string | null {
  const canonical = address.neighborhood_source === 'CEP' ? address.canonical_neighborhood?.trim() : '';
  if (!canonical || sameAreaName(canonical, address.neighborhood)) return null;
  const city = address.canonical_city?.trim();
  const area = city && !sameAreaName(city, address.city) ? `${canonical} (${city})` : canonical;
  return `Pelo CEP, o bairro é ${area}: a entrega é calculada para ele.`;
}
