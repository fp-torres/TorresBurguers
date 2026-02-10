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
  // Buscar todos os produtos
  getAll: async () => {
    const response = await api.get<Product[]>('/products');
    return response.data;
  },

  // --- NOVO: Buscar todos os adicionais cadastrados no sistema ---
  getAllAddons: async () => {
    // Supondo que você tenha uma rota /addons ou /products/addons
    // Se não tiver rota específica de addons, crie no backend ou use filters
    // Por enquanto, vou assumir que existe um endpoint simples para listar adicionais
    const response = await api.get<Addon[]>('/addons'); 
    return response.data;
  },

  delete: async (id: number) => {
    await api.delete(`/products/${id}`);
  },

  create: async (data: FormData) => {
    const response = await api.post('/products', data, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  }
};