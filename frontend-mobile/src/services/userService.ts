import api from './api';

export interface User {
  id: number;
  name: string;
  email: string;
  phone?: string; 
  avatar?: string;
  role: 'ADMIN' | 'CLIENT' | 'KITCHEN' | 'COURIER' | 'EMPLOYEE';
}

export const userService = {
  getAll: async () => {
    const response = await api.get<User[]>('/users');
    return response.data;
  },

  delete: async (id: number) => {
    await api.delete(`/users/${id}`);
  }
};