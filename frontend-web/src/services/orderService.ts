import api from './api';

export interface OrderItem {
  id: number;
  quantity: number;
  product: {
    name: string;
    image: string | null;
  };
  observation?: string;
  addons: { name: string; price: string | number }[];
}

export interface Order {
  id: number;
  // Status do Backend
  status: 'PENDING' | 'PREPARING' | 'DELIVERING' | 'FINISHED' | 'CANCELED';
  // O banco manda como string ("47.90"), o frontend converte na hora de exibir
  total_price: string | number; 
  payment_method: string;
  created_at: string;
  user: {
    name: string;
    phone?: string;
  };
  address?: {
    street: string;
    number: string;
    neighborhood: string;
  };
  items: OrderItem[];
}

export const orderService = {
  // Busca todos os pedidos
  getAll: async () => {
    const response = await api.get<Order[]>('/orders');
    return response.data;
  },

  // Atualiza o status
  updateStatus: async (id: number, status: Order['status']) => {
    await api.patch(`/orders/${id}`, { status });
  }
};