import api from './api';

export interface Addon {
  id: number;
  name: string;
  price: number | string;
  description?: string;
  category?: string; // Novo campo
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
  // ... (MÉTODOS DE PRODUTOS IGUAIS) ...
  getAll: async () => {
    const response = await api.get<Product[]>('/products');
    return response.data;
  },

  create: async (data: FormData) => {
    const response = await api.post('/products', data, { headers: { 'Content-Type': 'multipart/form-data' } });
    return response.data;
  },

  update: async (id: number, data: FormData) => {
    const response = await api.patch(`/products/${id}`, data, { headers: { 'Content-Type': 'multipart/form-data' } });
    return response.data;
  },

  deletePermanent: async (id: number) => {
    await api.delete(`/products/${id}/permanent`);
  },

  // --- MÉTODOS DE ADICIONAIS ---
  
  getAllAddons: async () => {
    const response = await api.get<Addon[]>('/addons'); 
    return response.data;
  },

  createAddon: async (data: { name: string, price: number, category: string }) => {
    const response = await api.post('/addons', data);
    return response.data;
  },

  updateAddon: async (id: number, data: { name?: string, price?: number, category?: string }) => {
    const response = await api.patch(`/addons/${id}`, data);
    return response.data;
  },

  deleteAddon: async (id: number) => {
    await api.delete(`/addons/${id}`);
  }
};