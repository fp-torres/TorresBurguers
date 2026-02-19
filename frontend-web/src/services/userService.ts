import api from './api';

export interface User {
  id: number;
  name: string;
  email: string;
  phone?: string; 
  avatar?: string;
  role: 'ADMIN' | 'CLIENT' | 'KITCHEN' | 'COURIER' | 'EMPLOYEE';
}

// Interface necessária para a tela de Admin (Criação/Edição)
export interface CreateUserDTO {
  name: string;
  email: string;
  password?: string;
  phone?: string;
  role: string;
}

export const userService = {
  // Buscar todos os usuários
  getAll: async () => {
    const response = await api.get<User[]>('/users');
    return response.data;
  },

  // Criar novo usuário (Admin)
  create: async (data: CreateUserDTO) => {
    const response = await api.post('/users', data);
    return response.data;
  },

  // Atualizar usuário (Suporte a FormData para Upload de Imagem)
  update: async (id: number, data: any, file?: File) => {
    const formData = new FormData();
    
    // Adiciona apenas campos que possuem valor
    Object.keys(data).forEach(key => {
      if (data[key] !== undefined && data[key] !== null && data[key] !== '') {
        formData.append(key, data[key]);
      }
    });

    // Adiciona o arquivo binário (limitado a 5MB no front e back)
    if (file) {
      formData.append('file', file);
    }

    const response = await api.patch(`/users/${id}`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  },

  // Exclusão pelo Admin (Lixeira)
  delete: async (id: number) => {
    await api.delete(`/users/${id}`);
  },

  // Auto-exclusão pelo Cliente
  deleteAccount: async (id: number) => {
    await api.delete(`/users/${id}`);
  }
};