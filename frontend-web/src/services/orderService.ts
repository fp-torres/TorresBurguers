import api from './api';

export interface Addon {
  id: number;
  name: string;
  price: string | number;
}

export interface OrderItem {
  id: number;
  quantity: number;
  product: {
    id: number;
    name: string;
    price: string;
    image: string | null;
  };
  observation?: string;
  addons: Addon[]; 
  meat_point?: string | null;
  removed_ingredients?: string[] | null; 
}

// Interface do Motoboy (Alinhada com o User entity do backend)
export interface Driver {
  id: number;
  name: string;
  phone: string;
  avatar?: string;
}

export interface Order {
  id: number;
  status: 'PENDING' | 'PREPARING' | 'READY_FOR_PICKUP' | 'DELIVERING' | 'DONE' | 'CANCELED';
  total_price: string | number; 
  delivery_fee?: string | number;
  payment_method: string;
  change_for?: string | null; 
  created_at: string;
  estimated_delivery_time?: string;
  type: 'DELIVERY' | 'TAKEOUT';
  
  user: {
    id: number;
    name: string;
    phone?: string;
  };

  driver?: Driver; // Motoboy atribuído

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
  // Listagem Geral
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

  cancel: async (id: number) => {
    await api.patch(`/orders/${id}/cancel`);
  },

  getDashboard: async () => {
    const response = await api.get('/orders/summary');
    return response.data;
  },

  getCharts: async () => {
    const response = await api.get('/orders/charts');
    return response.data;
  },

  // --- FUNÇÕES DE LOGÍSTICA ---

  // 1. Buscar lista de motoboys
  getDrivers: async () => {
    const response = await api.get<Driver[]>('/orders/drivers/list');
    return response.data;
  },

  // 2. Atribuir um motoboy a um pedido
  assignDriver: async (orderId: number, driverId: number) => {
    const response = await api.patch(`/orders/${orderId}/assign`, { driverId });
    return response.data;
  },

  // 3. Buscar pedidos próximos (sugestão de rota)
  getNearbyOrders: async (orderId: number) => {
    const response = await api.get<Order[]>(`/orders/${orderId}/nearby`);
    return response.data;
  }
};