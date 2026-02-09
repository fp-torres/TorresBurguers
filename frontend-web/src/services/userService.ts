import api from './api';

export interface User {
  id: number;
  name: string;
  email: string;
  role: 'ADMIN' | 'CLIENT'; // Adicione 'DELIVERY' se tiver no futuro
}

export const userService = {
  getAll: async () => {
    const response = await api.get<User[]>('/users');
    return response.data;
  },

  // Importante: No seu backend a criação de usuário pode ser via /auth/register ou /users
  // Vou assumir /users por padrão de REST, se der erro ajustamos.
  create: async (data: { name: string; email: string; password: string; role: string }) => {
    await api.post('/users', data);
  },

  delete: async (id: number) => {
    await api.delete(`/users/${id}`);
  }
};