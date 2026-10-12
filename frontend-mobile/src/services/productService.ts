import api from './api';

export interface Addon {
  id: number;
  name: string;
  price: number | string;
  available?: boolean;
}

export interface Product {
  id: number;
  name: string;
  description: string;
  price: number | string;
  promotion_price?: number | string | null;
  image: string | null;
  category: string;
  available: boolean;
  allowed_addons?: Addon[];
}

/** Campos do formulário de produto do app (mesmos nomes usados pelo painel web). */
export interface ProductFormData {
  name: string;
  description: string;
  price: string;
  category: string;
}

const multipart = { headers: { 'Content-Type': 'multipart/form-data' } };

function toFormData(data: Partial<ProductFormData> & { available?: boolean }) {
  const formData = new FormData();
  Object.entries(data).forEach(([key, value]) => {
    if (value !== undefined && value !== null) formData.append(key, String(value));
  });
  return formData;
}

export const productService = {
  getAll: async () => {
    const response = await api.get<Product[] | null>('/products');
    return response.data ?? [];
  },

  getTrash: async () => {
    const response = await api.get<Product[] | null>('/products/trash');
    return response.data ?? [];
  },

  create: async (data: ProductFormData) => {
    const response = await api.post<Product>('/products', toFormData({ ...data, available: true }), multipart);
    return response.data;
  },

  update: async (id: number, data: Partial<ProductFormData> & { available?: boolean }) => {
    const response = await api.patch<Product>(`/products/${id}`, toFormData(data), multipart);
    return response.data;
  },

  remove: (id: number) => api.delete(`/products/${id}`),
  restore: (id: number) => api.patch(`/products/${id}/restore`),
  removePermanently: (id: number) => api.delete(`/products/${id}/permanent`),
};
