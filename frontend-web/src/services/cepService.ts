import api from './api';
import { asRecord, readText } from './panelParsers';

/** Endereço de um CEP (GET /addresses/cep/:cep); campos que o serviço de CEP não informa vêm vazios. */
export interface CepAddress {
  street: string;
  neighborhood: string;
  city: string;
  /** UF em maiúsculas (ex.: "RJ"). */
  state: string;
}

/**
 * GET /addresses/cep/:cep (8 dígitos): proxy ViaCEP/BrasilAPI do backend, no formato do ViaCEP.
 * 400 = CEP inválido · 404 = CEP inexistente · 502 = serviços de CEP fora do ar (a API explica).
 * Usado pelas configurações da loja e pelo cadastro de estabelecimento no superpainel.
 */
export async function lookupCep(digits: string, signal?: AbortSignal): Promise<CepAddress> {
  const response = await api.get<unknown>(`/addresses/cep/${encodeURIComponent(digits)}`, { signal });
  const raw = asRecord(response.data);
  return {
    street: readText(raw.logradouro).trim(),
    neighborhood: readText(raw.bairro).trim(),
    city: readText(raw.localidade).trim(),
    state: readText(raw.uf).trim().toUpperCase(),
  };
}
