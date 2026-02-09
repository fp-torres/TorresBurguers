import api from './api';

export interface Product {
  id: number;
  name: string;
  description: string;
  price: string;
  image: string | null;
  category: string;
  available: boolean;
}

export const productService = {
  // Buscar todos
  getAll: async () => {
    const response = await api.get<Product[]>('/products');
    return response.data;
  },

  // Deletar um produto
  delete: async (id: number) => {
    await api.delete(`/products/${id}`);
  }
};