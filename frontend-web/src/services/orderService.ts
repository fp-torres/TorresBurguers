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
  
  // --- CAMPOS DETALHADOS (snake_case do Backend) ---
  meat_point?: string;
  removed_ingredients?: string[]; 
}

export interface Order {
  id: number;
  status: 'PENDING' | 'PREPARING' | 'READY_FOR_PICKUP' | 'DELIVERING' | 'DONE' | 'FINISHED' | 'CANCELED';
  total_price: string | number; 
  delivery_fee?: string | number;
  payment_method: string;
  created_at: string;
  estimated_delivery_time?: string;
  type: 'DELIVERY' | 'TAKEOUT';
  user: {
    name: string;
    phone?: string;
  };
  address?: {
    street: string;
    number: string;
    neighborhood: string;
    city: string;   
    state?: string; 
    complement?: string;
  };
  items: OrderItem[];
}

export const orderService = {
  getAll: async () => {
    const response = await api.get<Order[]>('/orders');
    return response.data;
  },

  getMyOrders: async () => {
    const response = await api.get<Order[]>('/orders/my-orders');
    return response.data;
  },

  updateStatus: async (id: number, status: string) => {
    await api.patch(`/orders/${id}`, { status });
  },

  getDashboard: async () => {
    const response = await api.get('/orders/summary');
    return response.data;
  },

  getCharts: async () => {
    const response = await api.get('/orders/charts');
    return response.data;
  }
};