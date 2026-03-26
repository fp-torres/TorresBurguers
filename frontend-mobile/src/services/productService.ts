import api from './api';

export interface Product {
  id: number;
  name: string;
  description: string;
  price: number | string;
  image: string | null;
  category: string;
  available: boolean;
}

export const productService = {
  getAll: async () => {
    const response = await api.get<Product[]>('/products');
    return response.data;
  },
  
  // No mobile, receberemos o URI da imagem escolhida na galeria (se houver)
  update: async (id: number, data: any, imageUri?: string) => {
    const formData = new FormData();
    
    Object.keys(data).forEach(key => {
      formData.append(key, data[key]);
    });

    if (imageUri) {
      const filename = imageUri.split('/').pop() || 'image.jpg';
      const match = /\.(\w+)$/.exec(filename);
      const type = match ? `image/${match[1]}` : `image`;
      
      formData.append('file', { uri: imageUri, name: filename, type } as any);
    }

    const response = await api.patch(`/products/${id}`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  }
};