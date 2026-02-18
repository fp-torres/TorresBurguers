import api from './api';

export interface User {
  id: number;
  name: string;
  email: string;
  phone?: string; 
  avatar?: string;
  role: 'ADMIN' | 'CLIENT' | 'KITCHEN' | 'COURIER';
}

export const userService = {
  // ... outros métodos (getAll, create, etc)

  // ATUALIZAÇÃO: Suporte a FormData para Upload de Imagem
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

  deleteAccount: async (id: number) => {
    await api.delete(`/users/${id}`);
  }
};