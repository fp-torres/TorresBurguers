import api from './api';

export interface User {
  id: number;
  name: string;
  email: string;
  phone?: string; 
  avatar?: string;
  role: 'ADMIN' | 'CLIENT' | 'KITCHEN' | 'COURIER' | 'EMPLOYEE';
}

export interface CreateUserDTO {
  name: string;
  email: string;
  password?: string;
  phone?: string;
  role: string;
  // Campos auxiliares de validação (não enviados ao back)
  confirmEmail?: string;
  confirmPassword?: string;
}

export const userService = {
  getAll: async () => {
    const response = await api.get<User[]>('/users');
    return response.data;
  },

  // --- ATUALIZAÇÃO: Suporte a FormData na criação ---
  create: async (data: CreateUserDTO, file?: File) => {
    const formData = new FormData();

    // Adiciona campos de texto (ignorando confirmações)
    Object.keys(data).forEach(key => {
      if (key !== 'confirmEmail' && key !== 'confirmPassword' && data[key as keyof CreateUserDTO]) {
        formData.append(key, data[key as keyof CreateUserDTO] as string);
      }
    });

    // Adiciona arquivo se existir
    if (file) {
      formData.append('file', file);
    }

    const response = await api.post('/users', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  },

  update: async (id: number, data: any, file?: File) => {
    const formData = new FormData();
    
    Object.keys(data).forEach(key => {
      // Ignora confirmações no update também
      if (key !== 'confirmEmail' && key !== 'confirmPassword' && data[key] !== undefined && data[key] !== null && data[key] !== '') {
        formData.append(key, data[key]);
      }
    });

    if (file) {
      formData.append('file', file);
    }

    const response = await api.patch(`/users/${id}`, formData, {
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