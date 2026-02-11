import api from './api';

export interface Addon {
  id: number;
  name: string;
  price: number | string;
  description?: string;
}

export interface Product {
  id: number;
  name: string;
  description: string;
  price: number | string;
  image: string | null;
  category: string;
  available: boolean;
  ingredients?: string[];
  allowed_addons?: Addon[];
}

export const productService = {
  // Busca todos os produtos do cardápio
  getAll: async () => {
    const response = await api.get<Product[]>('/products');
    return response.data;
  },

  getAllAddons: async () => {
    const response = await api.get<Addon[]>('/addons'); 
    return response.data;
  },

  delete: async (id: number) => {
    await api.delete(`/products/${id}`);
  },

  deletePermanent: async (id: number) => {
    await api.delete(`/products/${id}/permanent`);
  },

  create: async (data: FormData) => {
    const response = await api.post('/products', data, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  },

  update: async (id: number, data: FormData) => {
    const response = await api.patch(`/products/${id}`, data, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  }
};