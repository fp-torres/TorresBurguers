import api from './api';

export interface Addon {
  id: number;
  name: string;
  price: number | string;
  description?: string | null;
  category?: string; // Agrupamento livre (geral, hamburgueres, bebidas...)
  available?: boolean;
}

export interface Product {
  id: number;
  name: string;
  description: string;
  price: number | string;
  /** Preço promocional: quando definido e menor que o preço, é o valor cobrado. */
  promotion_price?: number | string | null;
  image: string | null;
  category: string;
  available: boolean;
  ingredients?: string[] | null;
  allowed_addons?: Addon[];
  deleted_at?: string | null;
}

export const productService = {
  getAll: async () => {
    const response = await api.get<Product[]>('/products');
    return response.data;
  },

  // Cadastro e edição: multipart (imagem no campo "file")
  create: async (data: FormData) => {
    const response = await api.post<Product>('/products', data, { headers: { 'Content-Type': 'multipart/form-data' } });
    return response.data;
  },

  update: async (id: number, data: FormData) => {
    const response = await api.patch<Product>(`/products/${id}`, data, { headers: { 'Content-Type': 'multipart/form-data' } });
    return response.data;
  },

  // --- LIXEIRA ---

  getTrash: async () => {
    const response = await api.get<Product[]>('/products/trash');
    return response.data;
  },

  /** Move para a lixeira (soft delete). */
  remove: async (id: number) => {
    await api.delete(`/products/${id}`);
  },

  /** Volta para o cardápio mantendo a disponibilidade que o produto tinha. */
  restore: async (id: number) => {
    const response = await api.patch<Product>(`/products/${id}/restore`);
    return response.data;
  },

  /** Exclusão definitiva (a API responde 409 se o produto aparece em pedidos). */
  deletePermanent: async (id: number) => {
    await api.delete(`/products/${id}/permanent`);
  },

  // --- MÉTODOS DE ADICIONAIS ---

  getAllAddons: async () => {
    const response = await api.get<Addon[]>('/addons');
    return response.data;
  },

  createAddon: async (data: { name: string, price: number, category: string }) => {
    const response = await api.post<Addon>('/addons', data);
    return response.data;
  },

  updateAddon: async (id: number, data: { name?: string, price?: number, category?: string }) => {
    const response = await api.patch<Addon>(`/addons/${id}`, data);
    return response.data;
  },

  deleteAddon: async (id: number) => {
    await api.delete(`/addons/${id}`);
  }
};
