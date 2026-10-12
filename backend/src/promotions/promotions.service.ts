import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import axios from 'axios';

/** Fuso usado para "hoje" (sugestão do dia e jogos do dia). */
export const BANNER_TIME_ZONE = 'America/Sao_Paulo';

export interface BannerMatchDetails {
  home: string;
  away: string;
  tournament: string;
  time: string;
}

/**
 * Banner da página inicial (web e app).
 * Sem cupom: o checkout ainda não aplica cupons nem descontos, então o banner não pode prometê-los.
 */
export interface Banner {
  type: 'football' | 'promo';
  title: string;
  message: string;
  subtitle?: string;
  theme?: string;
  details?: BannerMatchDetails;
}

interface FootballMatch {
  utcDate: string;
  status?: string;
  homeTeam: { name: string; shortName?: string };
  awayTeam: { name: string; shortName?: string };
  competition: { name: string; code?: string };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Competições do plano gratuito da football-data.org, em ordem de prioridade (Brasileirão primeiro). */
const COMPETITIONS = [
  'BSA',
  'CL',
  'WC',
  'EC',
  'PL',
  'PD',
  'SA',
  'BL1',
  'FL1',
  'PPL',
  'DED',
  'ELC',
];

/** Partidas que ainda valem o banner (agendadas ou rolando). */
const ACTIVE_MATCH_STATUSES = new Set([
  'SCHEDULED',
  'TIMED',
  'IN_PLAY',
  'PAUSED',
  'LIVE',
]);

/** Data local (AAAA-MM-DD) no fuso da loja. */
function localDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BANNER_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Dia seguinte de uma data AAAA-MM-DD. */
function nextDay(isoDate: string): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** Dia da semana (0 = domingo) de uma data AAAA-MM-DD. */
function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay();
}

// --- SUGESTÕES DA SEMANA (exibidas quando não há jogo) ---
// Texto neutro: nada de desconto, brinde, frete grátis ou cupom que o checkout não aplica.
const WEEKLY_PROMOTIONS: Record<number, Banner> = {
  0: {
    type: 'promo',
    theme: 'orange',
    title: 'Domingo em família 👨‍👩‍👧‍👦',
    message: 'Sugestão do dia: monte um pedido para dividir com todo mundo.',
  },
  1: {
    type: 'promo',
    theme: 'yellow',
    title: 'Começo de semana 🍔',
    message: 'Sugestão do dia: experimente um dos destaques do cardápio.',
  },
  2: {
    type: 'promo',
    theme: 'red',
    title: 'Terça de petiscos 🍟',
    message: 'Sugestão do dia: acompanhe o seu lanche com uma porção.',
  },
  3: {
    type: 'promo',
    theme: 'green',
    title: 'Quarta sem sair de casa 🛵',
    message:
      'Sugestão do dia: peça pelo site ou pelo app e acompanhe cada etapa.',
  },
  4: {
    type: 'promo',
    theme: 'purple',
    title: 'Quinta refrescante 🥤',
    message: 'Sugestão do dia: inclua uma bebida gelada no pedido.',
  },
  5: {
    type: 'promo',
    theme: 'blue',
    title: 'Sextou! 🎉',
    message: 'Sugestão do dia: capriche nos adicionais do seu lanche favorito.',
  },
  6: {
    type: 'promo',
    theme: 'red',
    title: 'Sabadou com a gente 🔥',
    message: 'Sugestão do dia: termine o pedido com uma sobremesa.',
  },
};

@Injectable()
export class PromotionsService {
  private readonly logger = new Logger(PromotionsService.name);
  private readonly API_URL = 'https://api.football-data.org/v4/matches';

  constructor(@Inject(CACHE_MANAGER) private readonly cacheManager: Cache) {}

  /**
   * Banner do dia: o jogo de hoje (quando FOOTBALL_DATA_TOKEN está configurado e há partida)
   * ou a sugestão do dia da semana. Nunca lança erro: qualquer falha cai na sugestão do dia.
   */
  async getBanner(): Promise<Banner> {
    const today = this.today();
    const cacheKey = `home_banner:${today}`; // chave por dia: virou o dia, muda o banner

    try {
      const cached = await this.cacheManager.get<Banner>(cacheKey);
      if (cached) return cached;

      const { banner, ttl } = await this.resolveBanner(today);
      await this.cacheManager.set(cacheKey, banner, ttl);
      return banner;
    } catch (error) {
      this.logger.warn(
        `Falha ao montar o banner (${(error as Error).message}). Exibindo a sugestão do dia.`,
      );
      return this.getDailyPromotion(today);
    }
  }

  private async resolveBanner(
    today: string,
  ): Promise<{ banner: Banner; ttl: number }> {
    const token = process.env.FOOTBALL_DATA_TOKEN?.trim();
    if (!token) {
      // Sem token: só a sugestão do dia (o banner de futebol é opcional)
      return { banner: this.getDailyPromotion(today), ttl: 12 * HOUR };
    }

    try {
      const match = await this.findTodayMatch(token, today);
      if (match) return { banner: this.footballBanner(match), ttl: HOUR };
      return { banner: this.getDailyPromotion(today), ttl: 6 * HOUR };
    } catch (error) {
      this.logger.warn(
        `API de futebol indisponível (${(error as Error).message}). Exibindo a sugestão do dia.`,
      );
      // Tenta de novo em breve
      return { banner: this.getDailyPromotion(today), ttl: 15 * MINUTE };
    }
  }

  /** Jogo de hoje (horário de Brasília) ainda não encerrado, priorizando o Brasileirão. */
  private async findTodayMatch(
    token: string,
    today: string,
  ): Promise<FootballMatch | undefined> {
    // A API filtra por data UTC: busca hoje e amanhã e filtra pelo dia local
    const response = await axios.get<{ matches?: FootballMatch[] }>(
      this.API_URL,
      {
        headers: { 'X-Auth-Token': token },
        params: {
          dateFrom: today,
          dateTo: nextDay(today),
          competitions: COMPETITIONS.join(','),
        },
        timeout: 5000, // timeout curto para não travar a página inicial
      },
    );

    const priority = (match: FootballMatch) => {
      const index = COMPETITIONS.indexOf(match.competition?.code ?? '');
      return index === -1 ? COMPETITIONS.length : index;
    };

    return (response.data.matches ?? [])
      .filter(
        (match) =>
          localDate(new Date(match.utcDate)) === today &&
          (!match.status || ACTIVE_MATCH_STATUSES.has(match.status)),
      )
      .sort(
        (a, b) =>
          priority(a) - priority(b) ||
          new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime(),
      )[0];
  }

  private footballBanner(match: FootballMatch): Banner {
    const time = new Date(match.utcDate).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: BANNER_TIME_ZONE,
    });
    const home = match.homeTeam.shortName || match.homeTeam.name;
    const away = match.awayTeam.shortName || match.awayTeam.name;

    return {
      type: 'football',
      theme: 'green',
      title: 'Hoje tem jogo! ⚽',
      message: `${home} x ${away} às ${time}`,
      subtitle: `${match.competition.name}: garanta seu pedido antes do apito inicial. 🍔`,
      details: {
        home: match.homeTeam.name,
        away: match.awayTeam.name,
        tournament: match.competition.name,
        time,
      },
    };
  }

  /** Data de hoje no fuso da loja (AAAA-MM-DD); se o fuso falhar, usa a data UTC. */
  private today(): string {
    try {
      return localDate(new Date());
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  }

  /** Sugestão fixa do dia da semana (horário de Brasília). */
  private getDailyPromotion(today: string): Banner {
    const promo = WEEKLY_PROMOTIONS[weekdayOf(today)] ?? WEEKLY_PROMOTIONS[0];
    return { ...promo };
  }
}
