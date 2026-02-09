import api from './api';

// CORREÇÃO: Adicionamos os novos cargos na tipagem
export interface User {
  id: number;
  name: string;
  email: string;
  phone?: string; 
  role: 'ADMIN' | 'CLIENT' | 'KITCHEN' | 'COURIER';
}

// DTO para o formulário
export interface CreateUserDTO {
  name: string;
  email: string;
  password?: string;
  phone?: string;
  role: string; // Pode ser string genérica aqui para facilitar o select
}

export const userService = {
  getAll: async () => {
    const response = await api.get<User[]>('/users');
    return response.data;
  },

  create: async (data: CreateUserDTO) => {
    const response = await api.post('/users', data);
    return response.data;
  },

  update: async (id: number, data: Partial<CreateUserDTO>) => {
    const response = await api.patch(`/users/${id}`, data);
    return response.data;
  },

  delete: async (id: number) => {
    await api.delete(`/users/${id}`);
  }
};