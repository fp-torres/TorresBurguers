import api, { normalizePaginated, toQuery } from '../api';
import { asRecord, readEnum, readId, readNumber, readText } from '../panelParsers';
import type { StoreAccountStatus } from '../../types/saas';
import { STORE_ACCOUNT_STATUSES } from './insightsParsers';

// Consultas de apoio dos filtros e seletores do superpainel (auditoria, usuários e configurações):
// lojas (GET /platform/stores e /platform/stores/:id) e planos (GET /platform/plans). Só os campos usados
// nos seletores são lidos; as telas completas dessas áreas têm os próprios serviços.

export interface StoreOption {
  id: number;
  slug: string;
  name: string;
  account_status: StoreAccountStatus;
}

export interface PlanOption {
  id: number;
  code: string;
  name: string;
  price: number;
  /** MONTHLY ou YEARLY. */
  billing_interval: string;
  /** ACTIVE (disponível para contratação) ou INACTIVE. */
  status: string;
  is_public: boolean;
}

/** Quantos resultados os seletores mostram por busca. */
export const LOOKUP_PAGE_SIZE = 8;

function parseStoreOption(value: unknown): StoreOption | null {
  const raw = asRecord(value);
  const id = readId(raw.id);
  if (!id) return null;
  return {
    id,
    slug: readText(raw.slug),
    name: readText(raw.name) || `Loja #${id}`,
    account_status: readEnum(raw.account_status, STORE_ACCOUNT_STATUSES, 'ACTIVE'),
  };
}

function parsePlanOption(value: unknown): PlanOption | null {
  const raw = asRecord(value);
  const id = readId(raw.id);
  if (!id) return null;
  return {
    id,
    code: readText(raw.code),
    name: readText(raw.name) || readText(raw.code) || `Plano #${id}`,
    price: readNumber(raw.price, 0),
    billing_interval: readText(raw.billing_interval, 'MONTHLY'),
    status: readText(raw.status),
    is_public: raw.is_public === true,
  };
}

export const platformLookups = {
  /** GET /platform/stores?search&sort=name&pageSize: lojas por nome, endereço (slug), razão social, e-mail ou documento. */
  async searchStores(search: string, signal?: AbortSignal): Promise<StoreOption[]> {
    const query = toQuery({ search: search.slice(0, 100), sort: 'name', page: 1, pageSize: LOOKUP_PAGE_SIZE });
    const { data } = await api.get<unknown>(`/platform/stores${query}`, { signal });
    return normalizePaginated<unknown>(data).items.map(parseStoreOption).filter((store): store is StoreOption => store !== null);
  },

  /** GET /platform/stores/:id (nome da loja de um filtro vindo do endereço da página). */
  async getStore(id: number, signal?: AbortSignal): Promise<StoreOption | null> {
    const { data } = await api.get<unknown>(`/platform/stores/${encodeURIComponent(String(id))}`, { signal });
    return parseStoreOption(data);
  },

  /** GET /platform/plans?pageSize=100: todos os planos (ativos e inativos, públicos ou não), na ordem de exibição. */
  async listPlans(signal?: AbortSignal): Promise<PlanOption[]> {
    const { data } = await api.get<unknown>(`/platform/plans${toQuery({ page: 1, pageSize: 100 })}`, { signal });
    return normalizePaginated<unknown>(data).items.map(parsePlanOption).filter((plan): plan is PlanOption => plan !== null);
  },
};
