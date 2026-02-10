import api from './api';

// --- NOVA INTERFACE PARA ADICIONAIS ---
export interface Addon {
  id: number;
  name: string;
  price: number | string;
}

// --- INTERFACE DE PRODUTO ATUALIZADA ---
export interface Product {
  id: number;
  name: string;
  description: string;
  price: number | string; // Aceita string ou number para evitar erro
  image: string | null;
  category: string;
  available: boolean;
  
  // Novos campos opcionais (pois produtos antigos podem não ter)
  ingredients?: string[];
  allowed_addons?: Addon[];
}

export const productService = {
  // Buscar todos os produtos
  getAll: async () => {
    const response = await api.get<Product[]>('/products');
    return response.data;
  },

  // Deletar produto
  delete: async (id: number) => {
    await api.delete(`/products/${id}`);
  },

  // Criar produto (Upload de imagem incluso)
  create: async (data: FormData) => {
    const response = await api.post('/products', data, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  }
};