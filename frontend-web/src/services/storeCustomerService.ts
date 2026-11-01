import api, { normalizePaginated, toQuery } from './api';
import { asRecord, isRecord, readArray, readDate, readId, readNullableText, readNumber, readText } from './panelParsers';
import type { Order } from './orderService';

// Clientes da loja no painel (Administrador e Atendente) (docs/saas/arquitetura.md §5.3): quem já comprou
// NESTA loja e o histórico de pedidos daqui. Clientes são globais: o painel nunca edita a conta. O
// Administrador pode bloquear um cliente NESTA loja (abuso, pedidos falsos): ele deixa de orçar, pedir e
// pagar aqui e continua comprando nas outras lojas.
// (A conta do próprio cliente, na vitrine, fica em customerService.)

/** Tamanho máximo do motivo do bloqueio (o mesmo da API). */
export const CUSTOMER_BLOCK_REASON_MAX_LENGTH = 300;

/** Bloqueio do cliente nesta loja (o motivo é interno: o cliente vê só uma mensagem genérica). */
export interface StoreCustomerBlock {
  reason: string;
  blocked_at: string | null;
  /** Administrador que bloqueou (null se a conta dele foi excluída). */
  blocked_by: { id: number; name: string } | null;
}

export interface StoreCustomerSummary {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  orders_count: number;
  /** Soma dos pedidos pagos e não cancelados desta loja. */
  total_spent: number;
  last_order_at: string | null;
  /** Bloqueado nesta loja. */
  blocked: boolean;
  block: StoreCustomerBlock | null;
}

export interface StoreCustomerStats {
  orders_count: number;
  total_spent: number;
  first_order_at: string | null;
  last_order_at: string | null;
}

export interface StoreCustomerDetail {
  customer: { id: number; name: string; email: string; phone: string | null };
  stats: StoreCustomerStats;
  /** Bloqueio nesta loja (null = pode comprar aqui). */
  block: StoreCustomerBlock | null;
  /** Pedidos desta loja, mais recentes primeiro (a API devolve até os 50 últimos). */
  orders: Order[];
}

export interface StoreCustomerListParams {
  page: number;
  pageSize: number;
  search?: string;
  /** true: só os bloqueados; false: só os não bloqueados; omitido: todos. */
  blocked?: boolean;
}

function toBlock(value: unknown): StoreCustomerBlock | null {
  if (!isRecord(value)) return null;
  const by = isRecord(value.blocked_by) ? value.blocked_by : null;
  return {
    reason: readText(value.reason),
    blocked_at: readDate(value.blocked_at),
    blocked_by: by ? { id: readId(by.id), name: readText(by.name) } : null,
  };
}

function toSummary(value: unknown): StoreCustomerSummary {
  const raw = asRecord(value);
  const block = toBlock(raw.block);
  return {
    id: readId(raw.id),
    name: readText(raw.name),
    email: readText(raw.email),
    phone: readNullableText(raw.phone),
    orders_count: readNumber(raw.orders_count, 0),
    total_spent: readNumber(raw.total_spent, 0),
    last_order_at: readDate(raw.last_order_at),
    blocked: raw.blocked === true || block !== null,
    block,
  };
}

function toOrder(value: unknown): Order | null {
  if (!isRecord(value) || readId(value.id) === 0) return null;
  return { ...(value as unknown as Order), items: Array.isArray(value.items) ? (value.items as Order['items']) : [] };
}

function toDetail(value: unknown): StoreCustomerDetail {
  const raw = asRecord(value);
  const customer = asRecord(raw.customer);
  const stats = asRecord(raw.stats);
  return {
    customer: {
      id: readId(customer.id),
      name: readText(customer.name),
      email: readText(customer.email),
      phone: readNullableText(customer.phone),
    },
    stats: {
      orders_count: readNumber(stats.orders_count, 0),
      total_spent: readNumber(stats.total_spent, 0),
      first_order_at: readDate(stats.first_order_at),
      last_order_at: readDate(stats.last_order_at),
    },
    block: toBlock(raw.block),
    orders: readArray(raw.orders).map(toOrder).filter((order): order is Order => order !== null),
  };
}

export const storeCustomerService = {
  /** GET /store/customers?search&blocked&page&pageSize → { items, total, page, pageSize } (mais recentes primeiro). */
  list: async (params: StoreCustomerListParams, signal?: AbortSignal) => {
    const response = await api.get<unknown>(`/store/customers${toQuery({ ...params })}`, { signal });
    const page = normalizePaginated<unknown>(response.data, params.page, params.pageSize);
    return { ...page, items: page.items.map(toSummary) };
  },

  /** GET /store/customers/:userId: contato, estatísticas, bloqueio e pedidos desta loja (404 se nunca comprou aqui). */
  detail: async (userId: number, signal?: AbortSignal) => {
    const response = await api.get<unknown>(`/store/customers/${userId}`, { signal });
    return toDetail(response.data);
  },

  /** POST /store/customers/:userId/block { reason } (Administrador). 409 se já estiver bloqueado. */
  block: async (userId: number, reason: string) => {
    const response = await api.post<unknown>(`/store/customers/${userId}/block`, { reason });
    return toBlock(response.data);
  },

  /** DELETE /store/customers/:userId/block (Administrador). 404 se não estiver bloqueado. */
  unblock: async (userId: number) => {
    await api.delete(`/store/customers/${userId}/block`);
  },
};
