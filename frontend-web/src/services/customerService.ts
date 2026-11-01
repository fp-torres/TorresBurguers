import api from './api';
import type { Order } from './orderService';
import type { StoreRef } from '../types/saas';

// Conta do cliente (global: compra em qualquer loja): cadastro, perfil e "Meus pedidos".
// Contratos: docs/saas/arquitetura.md §5.1, §5.2 e §5.5. Serviço próprio da vitrine (o painel usa os seus).

/** Pedido em "Meus pedidos": de qualquer loja, com a loja { id, slug, name, logo }. */
export type CustomerOrder = Order & { store: StoreRef | null };

/** Dados do cadastro público de cliente (POST /users; a API sempre cria um Cliente). */
export interface ClientSignupPayload {
  name: string;
  email: string;
  password: string;
  phone?: string;
}

/** Campos do PATCH /users/:id (só os que mudaram; phone '' apaga o telefone). */
export interface ProfileUpdatePayload {
  name?: string;
  phone?: string;
  password?: string;
  avatar?: string;
}

/**
 * Resposta do PATCH /users/:id da própria conta: a sessão (SessionUser) atualizada. Trocar a senha (ou o
 * e-mail) encerra todas as sessões da conta e a resposta traz um access_token novo para continuar nesta.
 */
export interface UpdatedProfile {
  name?: string;
  email?: string;
  phone?: string | null;
  avatar?: string | null;
  access_token?: string;
}

function toStoreRef(value: unknown): StoreRef | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = Number(raw.id);
  if (!Number.isInteger(id) || id <= 0 || typeof raw.slug !== 'string' || !raw.slug || typeof raw.name !== 'string') return null;
  return { id, slug: raw.slug, name: raw.name, logo: typeof raw.logo === 'string' && raw.logo ? raw.logo : null };
}

function toProfileFormData(data: ProfileUpdatePayload, file?: File): FormData {
  const formData = new FormData();
  Object.entries(data).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    // Telefone vazio vai como campo vazio: a API apaga o telefone
    if (value === '' && key !== 'phone') return;
    formData.append(key, String(value));
  });
  if (file) formData.append('file', file);
  return formData;
}

export const customerService = {
  /** GET /orders/my-orders: pedidos do cliente em todas as lojas (mais recentes primeiro). */
  getMyOrders: async (signal?: AbortSignal): Promise<CustomerOrder[]> => {
    const response = await api.get<unknown>('/orders/my-orders', { signal });
    if (!Array.isArray(response.data)) throw new Error('Resposta de pedidos inválida.');
    return (response.data as Array<Order & { store?: unknown }>)
      .filter((order) => !!order && typeof order === 'object' && typeof order.id === 'number')
      .map((order) => ({ ...order, items: Array.isArray(order.items) ? order.items : [], store: toStoreRef(order.store) }));
  },

  /**
   * PATCH /orders/:id/cancel: cancelamento pelo cliente enquanto o pedido aguarda confirmação.
   * Pedido pago online é estornado pela API (payment_status REFUNDED ou REFUND_PENDING).
   */
  cancelOrder: async (id: number) => {
    const response = await api.patch<Order>(`/orders/${id}/cancel`);
    return response.data;
  },

  /** POST /users (anônimo): cadastro de cliente. Devolve o usuário criado (sem sessão). */
  signup: async (payload: ClientSignupPayload) => {
    const response = await api.post<unknown>('/users', payload);
    return response.data;
  },

  /** PATCH /users/:id (multipart, foto no campo "file"). Com senha nova, a resposta traz o access_token novo. */
  updateProfile: async (id: number, data: ProfileUpdatePayload, file?: File) => {
    const response = await api.patch<UpdatedProfile>(`/users/${id}`, toProfileFormData(data, file), {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },

  /** DELETE /users/:id: exclui a própria conta. */
  deleteAccount: async (id: number) => {
    await api.delete(`/users/${id}`);
  },
};
