import api, { sessionEmissionConfig } from './api';
import type { AuthResponse } from './authService';
import type { UserRole } from '../utils/roles';

/**
 * Conta como a API devolve (lista de campos permitidos). Na equipe e na lixeira, só a equipe da
 * PRÓPRIA loja do Administrador (docs/saas/arquitetura.md §5.2).
 */
export interface User {
  id: number;
  name: string;
  email: string;
  phone?: string | null;
  avatar?: string | null;
  role: UserRole;
  store_id?: number | null;
  /** Lixeira: quando a conta foi removida. */
  deleted_at?: string | null;
  created_at?: string;
}

/**
 * Resposta do PATCH /users/:id. Ao trocar o PRÓPRIO e-mail ou a senha, a API encerra as outras sessões e
 * devolve um token novo (access_token) para esta continuar valendo.
 */
export type UpdatedUser = User & { access_token?: string; session_transport?: 'cookie' | 'bearer'; expires_in?: number };

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

/**
 * Sessão nova devolvida ao alterar a própria conta (e-mail ou senha): { access_token, user } para o
 * applyAuthResponse do AuthContext; null quando a resposta não trouxe token (sessão continua a mesma).
 */
export function sessionFromUpdate(data: UpdatedUser | null | undefined): AuthResponse | null {
  if (!data || typeof data.access_token !== 'string' || data.access_token === '') return null;
  const { access_token: accessToken, session_transport: transport, expires_in: expiresIn, ...user } = data;
  return {
    access_token: accessToken,
    user,
    // Sessão em cookie: o token de acesso curto e a validade dele (ver AuthContext.applyAuthResponse)
    ...(transport === 'cookie' || transport === 'bearer' ? { session_transport: transport } : {}),
    ...(typeof expiresIn === 'number' ? { expires_in: expiresIn } : {}),
  };
}

const MULTIPART = { headers: { 'Content-Type': 'multipart/form-data' } };

export const userService = {
  /** Equipe ativa da própria loja (Administrador). */
  getAll: async (signal?: AbortSignal) => {
    const response = await api.get<User[]>('/users', { signal });
    return Array.isArray(response.data) ? response.data : [];
  },

  // Cadastro com foto opcional (multipart). Administrador: equipe da própria loja (403 = limite do plano).
  create: async (data: CreateUserDTO, file?: File) => {
    const response = await api.post<User>('/users', toFormData(data, file), MULTIPART);
    return response.data;
  },

  update: async (id: number, data: UpdateUserPayload, file?: File) => {
    // Na própria conta, em sessão em cookie, uma sessão nova (troca de e-mail ou senha) também vem em cookie
    const emission = sessionEmissionConfig();
    const response = await api.patch<UpdatedUser>(`/users/${id}`, toUpdateFormData(data, file), {
      ...emission,
      headers: { ...MULTIPART.headers, ...emission.headers },
    });
    return response.data;
  },

  /** Move para a lixeira (Administrador: equipe da própria loja). */
  delete: async (id: number) => {
    await api.delete(`/users/${id}`);
  },

  /** Exclui a própria conta (cliente, em Meus Dados). */
  deleteAccount: async (id: number) => {
    await api.delete(`/users/${id}`);
  },

  // --- LIXEIRA DA EQUIPE ---

  getTrash: async (signal?: AbortSignal) => {
    const response = await api.get<User[]>('/users/trash', { signal });
    return Array.isArray(response.data) ? response.data : [];
  },

  /** Devolve o acesso (403 se a equipe do plano já estiver completa). */
  restore: async (id: number) => {
    const response = await api.patch<User>(`/users/${id}/restore`);
    return response.data;
  },

  /** Exclusão definitiva de quem está na lixeira (409 se a conta aparece em pedidos). */
  deletePermanent: async (id: number) => {
    await api.delete(`/users/${id}/permanent`);
  },
};
