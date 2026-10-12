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

export interface CreateUserDTO {
  name: string;
  email: string;
  password?: string;
  phone?: string;
  role: UserRole;
  // Campos auxiliares de validação (não enviados ao back)
  confirmEmail?: string;
  confirmPassword?: string;
}

/**
 * Campos aceitos no PATCH /users/:id (só os que mudaram). "role" só é aceito de um Administrador
 * (e nunca para a própria conta). phone '' ou null apaga o telefone.
 */
export interface UpdateUserPayload {
  name?: string;
  email?: string;
  phone?: string | null;
  password?: string;
  avatar?: string;
  role?: UserRole;
}

// Campos só da tela (confirmações) nunca vão para a API: o backend recusa campos desconhecidos.
const CLIENT_ONLY_FIELDS = new Set(['confirmEmail', 'confirmPassword']);

/** Monta o multipart com os campos preenchidos e a foto (campo "file"). */
function toFormData(data: object, file?: File): FormData {
  const formData = new FormData();
  Object.entries(data).forEach(([key, value]) => {
    if (CLIENT_ONLY_FIELDS.has(key) || value === undefined || value === null || value === '') return;
    formData.append(key, String(value));
  });
  if (file) formData.append('file', file);
  return formData;
}

/** PATCH: além dos campos preenchidos, telefone vazio vai como campo vazio, que apaga o telefone na API. */
function toUpdateFormData(data: UpdateUserPayload, file?: File): FormData {
  const formData = toFormData(data, file);
  if (data.phone === '' || data.phone === null) formData.append('phone', '');
  return formData;
}

export const userService = {
  getAll: async () => {
    const response = await api.get<User[]>('/users');
    return response.data;
  },

  // Cadastro com foto opcional (multipart)
  create: async (data: CreateUserDTO, file?: File) => {
    const response = await api.post<User>('/users', toFormData(data, file), {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  },

  update: async (id: number, data: UpdateUserPayload, file?: File) => {
    const response = await api.patch<User>(`/users/${id}`, toUpdateFormData(data, file), {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  },

  delete: async (id: number) => {
    await api.delete(`/users/${id}`);
  },

  deleteAccount: async (id: number) => {
    await api.delete(`/users/${id}`);
  }
};
