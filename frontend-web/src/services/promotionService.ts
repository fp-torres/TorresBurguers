import api from './api';

/** Partida do dia exibida no banner de futebol. */
export interface BannerMatchDetails {
  home: string;
  away: string;
  tournament: string;
  time: string;
}

/**
 * Banner da página inicial (GET /promotions/banner): jogo do dia ou sugestão do dia.
 * Sem cupom: o checkout não aplica cupons, então a vitrine nunca mostra códigos de desconto.
 */
export interface HomeBanner {
  type: 'football' | 'promo';
  title: string;
  message: string;
  subtitle?: string;
  theme?: string;
  details?: BannerMatchDetails;
}

export const promotionService = {
  getBanner: async () => {
    const response = await api.get<HomeBanner>('/promotions/banner');
    return response.data;
  },
};
