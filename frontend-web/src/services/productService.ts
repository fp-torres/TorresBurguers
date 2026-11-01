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
  /** Cardápio da loja (inclui indisponíveis; no painel, a loja vem do token da equipe). */
  getAll: async (signal?: AbortSignal) => {
    const response = await api.get<Product[]>('/products', { signal });
    return Array.isArray(response.data) ? response.data : [];
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

  getTrash: async (signal?: AbortSignal) => {
    const response = await api.get<Product[]>('/products/trash', { signal });
    return Array.isArray(response.data) ? response.data : [];
  },

  /** Move para a lixeira (soft delete). */
  remove: async (id: number) => {
    await api.delete(`/products/${id}`);
  },

  /** Volta para o cardápio mantendo a disponibilidade que o produto tinha (403 = limite de produtos do plano). */
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

  /** Exclusão lógica: o adicional sai do cardápio e dos produtos; pedidos antigos mantêm o retrato. */
  deleteAddon: async (id: number) => {
    await api.delete(`/addons/${id}`);
  }
};
