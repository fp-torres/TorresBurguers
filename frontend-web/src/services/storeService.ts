import api from './api';

/** Status da loja (GET /store/status, público). */
export interface StoreStatus {
  id?: number;
  is_open: boolean;
  /** Mensagem opcional exibida na vitrine com a loja aberta. */
  opening_message?: string | null;
  /** Mensagem opcional exibida na vitrine com a loja fechada (ex.: "Voltamos amanhã às 18h"). */
  closing_message?: string | null;
}

export type StoreStatusUpdate = Partial<Pick<StoreStatus, 'is_open' | 'opening_message' | 'closing_message'>>;

export const storeService = {
  getStatus: async () => {
    const response = await api.get<StoreStatus>('/store/status');
    return response.data;
  },

  /** Abre/fecha a loja ou altera as mensagens (Administrador ou Atendente). */
  updateStatus: async (data: StoreStatusUpdate) => {
    const response = await api.patch<StoreStatus>('/store/status', data);
    return response.data;
  },
};
