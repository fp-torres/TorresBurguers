import api from './api';
import type { UserRole } from '../utils/roles';

export interface User {
  id: number;
  name: string;
  email: string;
  phone?: string | null;
  avatar?: string | null;
  role: UserRole;
}

/** Campos aceitos pelo backend em POST /users e PATCH /users/:id. */
export interface UserPayload {
  name?: string;
  email?: string;
  /** Na edição, '' (ou null) apaga o telefone; no cadastro, vazio é o mesmo que não informar. */
  phone?: string | null;
  password?: string;
  role?: UserRole;
}

/**
 * Remove campos vazios (o backend rejeita propriedades desconhecidas e "" em campos opcionais)
 * e apara nome, e-mail e telefone — a senha é enviada exatamente como digitada.
 * Exceção: na edição o telefone vazio é enviado como '' para apagá-lo (o backend grava null).
 */
function clean(payload: UserPayload, mode: 'create' | 'update'): UserPayload {
  const result: UserPayload = {};
  if (payload.name?.trim()) result.name = payload.name.trim();
  if (payload.email?.trim()) result.email = payload.email.trim();
  const phone = payload.phone?.trim() ?? (payload.phone === null ? '' : undefined);
  if (phone || (mode === 'update' && phone === '')) result.phone = phone;
  if (payload.password) result.password = payload.password;
  if (payload.role) result.role = payload.role;
  return result;
}

export const userService = {
  getAll: async () => {
    const response = await api.get<User[]>('/users');
    return response.data ?? [];
  },

  getById: async (id: number) => {
    const response = await api.get<User>(`/users/${id}`);
    return response.data;
  },

  create: async (payload: UserPayload) => {
    const response = await api.post<User>('/users', clean(payload, 'create'));
    return response.data;
  },

  update: async (id: number, payload: UserPayload) => {
    const response = await api.patch<User>(`/users/${id}`, clean(payload, 'update'));
    return response.data;
  },

  delete: async (id: number) => {
    await api.delete(`/users/${id}`);
  },
};
