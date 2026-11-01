import api from './api';

/** Partida do dia exibida no banner de futebol. */
export interface BannerMatchDetails {
  home: string;
  away: string;
  tournament: string;
  time: string;
}

/**
 * Banner da vitrine: jogo do dia ou sugestão do dia.
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

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Banner lido sem confiar no formato (null se faltar título ou mensagem). */
function toHomeBanner(data: unknown): HomeBanner | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  const title = optionalText(raw.title);
  const message = optionalText(raw.message);
  if (!title || !message) return null;

  const detailsRaw = raw.details && typeof raw.details === 'object' ? (raw.details as Record<string, unknown>) : null;
  const home = optionalText(detailsRaw?.home);
  const away = optionalText(detailsRaw?.away);
  return {
    type: raw.type === 'football' ? 'football' : 'promo',
    title,
    message,
    subtitle: optionalText(raw.subtitle),
    theme: optionalText(raw.theme),
    details: home && away
      ? { home, away, tournament: optionalText(detailsRaw?.tournament) ?? '', time: optionalText(detailsRaw?.time) ?? '' }
      : undefined,
  };
}

export const promotionService = {
  /** GET /stores/:slug/promotions/banner: banner da loja ("hoje" no fuso da loja). */
  getStoreBanner: async (slug: string, signal?: AbortSignal) => {
    const response = await api.get<unknown>(`/stores/${encodeURIComponent(slug)}/promotions/banner`, { signal });
    return toHomeBanner(response.data);
  },
};
